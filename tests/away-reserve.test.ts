import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { cleanConfig } from "../lib/domain/configuration.js";
import { cleanAwayReserveState, continuousAwayWindow } from "../lib/domain/away-reserve.js";
import { createAwayReserveService } from "../lib/services/away-reserve-service.js";
import { createAutomationOrchestrator } from "../lib/services/automation-orchestrator.js";
import { cleanOperationalOverridesState } from "../lib/domain/operational-overrides.js";
import { cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { applyPredictedBatteryFlow, buildAdaptiveChargingTimelineView } from "../lib/domain/adaptive-timeline.js";
import type { AwayPeriod } from "../lib/contracts/away-period.js";

const start = Date.parse("2026-10-25T10:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
function period(from = start, until = start + 86_400_000, id = "trip"): AwayPeriod {
  return { id, from: iso(from), until: iso(until), source: "manual", createdAt: iso(from), updatedAt: iso(from) };
}
function fixture(t: TestContext, enabled = true) {
  let clock = start;
  let document: Record<string, unknown> = {};
  let periods = [period()];
  let backup = false;
  let offline = false;
  let failBeforeWrite = false;
  let failAfterWrite = false;
  let ignoreWrite = false;
  const config = cleanConfig({ batteryHost: "192.0.2.10", awayReserveEnabled: enabled,
    adaptiveCharging: { enabled: false }, settingCache: { discharge_limit: { lastKnown: { decoded: { percent: 40 } }, lastReadAt: iso(start) } } });
  const values = new Map([[config.batteryHost, 20]]);
  const commands: Array<{ host: string; percent: number; source: string }> = [];
  const verified: number[] = [];
  const dependencies = {
    documents: { readDocument: () => document, writeDocument: (_key: string, value: Record<string, unknown>) => { document = structuredClone(value); } },
    readConfig: async () => config,
    setEnabled: async (value: boolean) => { config.awayReserveEnabled = value; },
    periods: () => periods,
    backupActive: async () => backup,
    readReserve: async (host: string) => {
      if (offline) throw new Error("Battery offline");
      return { decoded: { percent: values.get(host) ?? null } };
    },
    executeAction: async (_action: string, payload: Record<string, unknown>, options: { source: string }) => {
      assert.notEqual(document.previousPercent, null, "save original reserve before device write");
      commands.push({ host: String(payload.host), percent: Number(payload.percent), source: options.source });
      if (failBeforeWrite) throw new Error("Write rejected");
      if (!ignoreWrite) values.set(String(payload.host), Number(payload.percent));
      if (failAfterWrite) throw new Error("Acknowledgement lost");
      return { verified: true };
    },
    reserveVerified: async (percent: number) => {
      verified.push(percent);
      config.settingCache.discharge_limit = { lastKnown: { decoded: { percent } }, lastReadAt: iso(clock) };
    },
    allowDocumentationHosts: true,
    now: () => new Date(clock),
  };
  let service = createAwayReserveService(dependencies);
  t.after(() => service.stop());
  return {
    get service() { return service; }, config, values, commands, verified,
    state: () => cleanAwayReserveState(document),
    clock: (value: number) => { clock = value; }, periods: (value: AwayPeriod[]) => { periods = value; },
    backup: (value: boolean) => { backup = value; }, offline: (value: boolean) => { offline = value; },
    failBeforeWrite: (value: boolean) => { failBeforeWrite = value; }, failAfterWrite: (value: boolean) => { failAfterWrite = value; },
    ignoreWrite: (value: boolean) => { ignoreWrite = value; },
    document: (value: Record<string, unknown>) => { document = value; },
    restart: () => { service.stop(); service = createAwayReserveService(dependencies); },
  };
}

test("disabled by default; no battery reads or writes are required", async (t) => {
  assert.equal(cleanConfig().awayReserveEnabled, false);
  const f = fixture(t, false); f.offline(true);
  const view = await f.service.reconcile();
  assert.equal(view.phase, "idle"); assert.equal(view.lastError, null); assert.equal(f.commands.length, 0);
});

test("saves the actual reserve, verifies zero once, restores at exact return and updates planning inputs", async (t) => {
  const f = fixture(t);
  await f.service.reconcile();
  assert.equal(f.state().previousPercent, 20, "ignore the stale configured value of 40");
  assert.equal(f.state().phase, "active");
  assert.equal(f.values.get(f.config.batteryHost), 0);
  await f.service.reconcile();
  assert.equal(f.commands.length, 1);
  f.clock(start + 86_400_000);
  await f.service.reconcile(true);
  assert.equal(f.state().phase, "idle");
  assert.deepEqual(f.commands.map((entry) => entry.percent), [0, 20]);
  assert.equal(f.commands[1]!.source, "away-reserve-restore");
  assert.deepEqual(f.verified, [0, 20]);
});

test("Away now can end early and disabling the preference restores even without Adaptive Charging", async (t) => {
  const f = fixture(t); await f.service.reconcile();
  f.periods([period(start, start + 1_000)]); f.clock(start + 1_000);
  await f.service.reconcile(true);
  assert.equal(f.values.get(f.config.batteryHost), 20);
  f.periods([period(start + 2_000, start + 5_000, "next")]); f.clock(start + 2_000);
  await f.service.reconcile(true);
  await f.service.setEnabled(false);
  assert.equal(f.values.get(f.config.batteryHost), 20);
  assert.equal(f.config.awayReserveEnabled, false);
});

test("extensions and touching periods retain the original snapshot without intermediate restoration", async (t) => {
  const f = fixture(t); f.periods([period(start, start + 1_000), period(start + 1_000, start + 3_000, "next")]);
  await f.service.reconcile(); f.clock(start + 1_000); await f.service.reconcile();
  assert.equal(f.state().windowFrom, iso(start)); assert.equal(f.state().windowUntil, iso(start + 3_000));
  f.periods([period(start, start + 1_000), period(start + 1_000, start + 5_000, "next")]);
  await f.service.reconcile(true);
  assert.deepEqual(f.commands.map((entry) => entry.percent), [0]);
  f.clock(start + 5_000); await f.service.reconcile(true);
  assert.deepEqual(f.commands.map((entry) => entry.percent), [0, 20]);
});

test("a reserve already at zero is preserved without redundant writes", async (t) => {
  const f = fixture(t); f.values.set(f.config.batteryHost, 0);
  await f.service.reconcile(); f.clock(start + 86_400_000); await f.service.reconcile(true);
  assert.equal(f.commands.length, 0); assert.equal(f.values.get(f.config.batteryHost), 0);
});

test("restart after a write with lost acknowledgement never captures temporary zero as the baseline", async (t) => {
  const f = fixture(t); f.failAfterWrite(true); await f.service.reconcile();
  assert.equal(f.values.get(f.config.batteryHost), 0); assert.equal(f.state().previousPercent, 20);
  assert.equal(f.state().phase, "applying"); assert.match(f.state().lastError!, /Acknowledgement lost/);
  f.failAfterWrite(false); f.restart(); await f.service.reconcile(true);
  assert.equal(f.state().phase, "active"); assert.equal(f.state().previousPercent, 20);
  f.clock(start + 86_400_000); await f.service.reconcile(true);
  assert.equal(f.values.get(f.config.batteryHost), 20);
});

test("failed restoration persists and retries with backoff, including after restart at home", async (t) => {
  const f = fixture(t); await f.service.reconcile(); f.clock(start + 86_400_000); f.failBeforeWrite(true);
  await f.service.reconcile(true);
  assert.equal(f.state().phase, "restoring"); assert.equal(f.state().previousPercent, 20);
  assert.ok(f.state().retryAt); const count = f.commands.length;
  await f.service.reconcile(); assert.equal(f.commands.length, count);
  f.failBeforeWrite(false); f.restart(); f.clock(start + 86_430_000); await f.service.reconcile();
  assert.equal(f.state().phase, "idle"); assert.equal(f.values.get(f.config.batteryHost), 20);
});

test("unreadable and unverified values never count as successful application", async (t) => {
  const f = fixture(t); f.values.clear();
  await f.service.reconcile(); assert.equal(f.commands.length, 0); assert.ok(f.state().lastError);
  f.values.set(f.config.batteryHost, 20); f.ignoreWrite(true); await f.service.reconcile(true);
  assert.equal(f.state().phase, "applying"); assert.match(f.state().lastError!, /verification failed/);
  f.ignoreWrite(false); await f.service.reconcile(true); assert.equal(f.state().phase, "active");
});

test("manual reserve changes win for the entire continuous trip, including an explicit choice of zero", async (t) => {
  for (const percent of [0, 30]) {
    const f = fixture(t); await f.service.reconcile();
    await f.service.withCommand("discharge-limit", { percent }, "manual", async () => {
      assert.equal(f.state().phase, "manual-pending"); f.values.set(f.config.batteryHost, percent);
    });
    await f.service.reconcile(true); assert.equal(f.state().phase, "manual");
    f.periods([period(start, start + 2 * 86_400_000)]); await f.service.reconcile(true);
    assert.equal(f.values.get(f.config.batteryHost), percent);
    f.clock(start + 2 * 86_400_000); await f.service.reconcile(true);
    assert.equal(f.values.get(f.config.batteryHost), percent);
    assert.deepEqual(f.commands.map((entry) => entry.percent), [0]);
  }
});

test("a failed manual command does not discard the original restoration obligation", async (t) => {
  const f = fixture(t); await f.service.reconcile();
  await assert.rejects(f.service.withCommand("discharge-limit", { percent: 30 }, "manual", async () => { throw new Error("Rejected"); }));
  assert.equal(f.state().phase, "active"); f.clock(start + 86_400_000); await f.service.reconcile(true);
  assert.equal(f.values.get(f.config.batteryHost), 20);
});

test("external device changes and interrupted manual writes are respected", async (t) => {
  const f = fixture(t); await f.service.reconcile(); f.values.set(f.config.batteryHost, 40);
  await f.service.reconcile(true); assert.equal(f.state().phase, "manual");
  f.clock(start + 86_400_000); await f.service.reconcile(true); assert.equal(f.values.get(f.config.batteryHost), 40);
  const g = fixture(t); await g.service.reconcile();
  g.document({ ...g.state(), phase: "manual-pending", manualRequestedPercent: 0 }); g.restart();
  await g.service.reconcile(true); assert.equal(g.state().phase, "manual");
  g.clock(start + 86_400_000); await g.service.reconcile(true); assert.equal(g.values.get(g.config.batteryHost), 0);
});

test("manual write and restoration are serialized through verification", async (t) => {
  const f = fixture(t); await f.service.reconcile();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const manual = f.service.withCommand("discharge-limit", { percent: 30 }, "manual", async () => {
    entered(); await waiting; f.values.set(f.config.batteryHost, 30);
  });
  await started; f.clock(start + 86_400_000); const restoring = f.service.reconcile(true);
  release(); await Promise.all([manual, restoring]);
  assert.equal(f.values.get(f.config.batteryHost), 30); assert.deepEqual(f.commands.map((entry) => entry.percent), [0]);
});

test("Backup Preparation restores the original floor and pauses zero until it ends", async (t) => {
  const f = fixture(t); await f.service.reconcile(); f.backup(true); await f.service.reconcile(true);
  assert.equal(f.state().phase, "suspended"); assert.equal(f.values.get(f.config.batteryHost), 20);
  await f.service.reconcile(); assert.equal(f.values.get(f.config.batteryHost), 20);
  f.backup(false); await f.service.reconcile(true); assert.equal(f.values.get(f.config.batteryHost), 0);
  f.clock(start + 86_400_000); await f.service.reconcile(true); assert.equal(f.values.get(f.config.batteryHost), 20);
});

test("disabling while suspended clears the suspension without changing the restored floor", async (t) => {
  const f = fixture(t); await f.service.reconcile(); f.backup(true); await f.service.reconcile(true);
  await f.service.setEnabled(false); assert.equal(f.state().phase, "idle");
  f.backup(false); await f.service.reconcile(true); assert.equal(f.values.get(f.config.batteryHost), 20);
});

test("an exact end timer restores reserve even without a regular automation tick", async (t) => {
  let document: Record<string, unknown> = {};
  let value = 20;
  const at = Date.now();
  const config = cleanConfig({ awayReserveEnabled: true });
  const service = createAwayReserveService({
    documents: { readDocument: () => document, writeDocument: (_key, state) => { document = state; } },
    readConfig: async () => config, setEnabled: async () => {},
    periods: () => [period(at - 1_000, at + 100)], backupActive: async () => false,
    allowDocumentationHosts: true,
    readReserve: async () => ({ decoded: { percent: value } }),
    executeAction: async (_action, payload) => { value = Number(payload.percent); }, reserveVerified: async () => {},
  });
  t.after(() => service.stop());
  await service.reconcile(); assert.equal(value, 0);
  const deadline = Date.now() + 2_000;
  while (value === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(value, 20); assert.equal((await service.view()).phase, "idle");
});

test("saved reserve values remain bound to their battery when equipment changes", async (t) => {
  const f = fixture(t); const oldHost = f.config.batteryHost; await f.service.reconcile();
  f.config.batteryHost = "192.0.2.99"; f.values.set(f.config.batteryHost, 40);
  await f.service.reconcile(true);
  assert.equal(f.values.get(oldHost), 20); assert.equal(f.state().previousPercent, 40);
  f.clock(start + 86_400_000); await f.service.reconcile(true);
  assert.equal(f.values.get(f.config.batteryHost), 40);
  assert.ok(!f.commands.some((entry) => entry.host === f.config.batteryHost && entry.percent === 20));
});

test("a manual choice on a replacement battery preserves recovery for the original battery", async (t) => {
  const f = fixture(t); const oldHost = f.config.batteryHost; await f.service.reconcile();
  f.config.batteryHost = "192.0.2.99"; f.values.set(f.config.batteryHost, 40);
  await f.service.withCommand("discharge-limit", { percent: 30 }, "manual", async () => { f.values.set(f.config.batteryHost, 30); });
  await f.service.reconcile(true);
  assert.equal(f.values.get(oldHost), 20); assert.equal(f.values.get(f.config.batteryHost), 30);
  assert.equal(f.state().phase, "manual");
  await f.service.reconcile(); assert.equal(f.values.get(f.config.batteryHost), 30);
});

test("incomplete saved recovery information is visible and does not get overwritten", async (t) => {
  const f = fixture(t); f.document({ phase: "active", host: f.config.batteryHost, previousPercent: null });
  await f.service.reconcile(true); assert.equal(f.commands.length, 0); assert.match(f.state().lastError!, /incomplete/);
});

test("reserve reconciliation runs before the orchestrator exits with all automation disabled", async () => {
  let reconciled = 0;
  const orchestrator = createAutomationOrchestrator({
    intervalMs: 30_000, forecastRefreshMs: 1000,
    reconcileAwayReserve: async () => { reconciled += 1; }, readConfig: async () => cleanConfig(),
    readAutomationRules: async () => [], writeAutomationRuleStates: async () => {},
    readOperationalOverridesState: async () => cleanOperationalOverridesState(),
    readAdaptiveChargingState: async () => cleanAdaptiveChargingState(),
    refreshAdaptiveChargingForecast: async () => { throw new Error("No forecast should be required"); },
    getStatusSnapshot: async () => { throw new Error("No full status should be required"); }, deviceTimings: () => [],
    evaluateAutomationRule: async () => ({ changed: false }), executeAction: async () => {},
    evaluateAdaptiveCharging: async () => { throw new Error("Disabled"); },
    notifications: { observeCondition: () => {}, enqueue: () => {} }, warn: () => {},
  });
  await orchestrator.run(); assert.equal(reconciled, 1);
});

test("continuous-window calculation excludes gaps and uses exact end boundaries", () => {
  assert.deepEqual(continuousAwayWindow([period(start, start + 1000), period(start + 1000, start + 2000)], new Date(start + 1000)),
    { from: iso(start), until: iso(start + 2000) });
  assert.equal(continuousAwayWindow([period(start, start + 1000)], new Date(start + 1000)), null);
});

test("restoring a reserve above current SOC does not invent stored energy in the planner", () => {
  assert.equal(applyPredictedBatteryFlow(0.5, -1, 2, 10), 0.5);
  assert.equal(applyPredictedBatteryFlow(0.5, 0.3, 2, 10), 0.8);
  const timeline = buildAdaptiveChargingTimelineView({
    initialStoredKwh: 0.5, floorKwh: 2, capacityKwh: 10, config: cleanConfig(),
    timeline: [{ startMs: start, endMs: start + 1_800_000, netKwh: -1, chargeCapacityKwh: 0, band: null }],
  });
  assert.equal(timeline[0]!.predictedStartSocPercent, 5);
  assert.equal(timeline[0]!.predictedEndSocPercent, 5);
});
