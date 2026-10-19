import assert from "node:assert/strict";

import type { AutomationRule } from "../lib/domain/automation-rules.js";
import { cleanAutomationRule, cleanAutomationRuleConfig, cleanAutomationRuleState } from "../lib/domain/automation-rules.js";
import { cleanOperationalOverridesState } from "../lib/domain/operational-overrides.js";
import { createAutomationStoreService } from "../lib/services/automation-store-service.js";
import type { AutomationDocumentStore, AutomationEventStore } from "../lib/services/automation-store-service.js";
import { createDemandGuardService } from "../lib/services/demand-guard-service.js";
import { createAutomationRuleEvaluator } from "../lib/services/automation-rule-evaluator.js";

const at = new Date("2026-10-19T12:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function guardRule(id: string, options: { enabled?: boolean; awaitingRestore?: boolean } = {}): AutomationRule {
  const rule = cleanAutomationRule({
    id,
    name: `Guard ${id}`,
    enabled: options.enabled ?? true,
    conditions: { breakerAmps: 40, reserveAmps: 5, breakerVoltage: 100, restoreDelaySeconds: 3_600 },
  });
  rule.state = { ...rule.state, awaitingRestore: options.awaitingRestore ?? true, restoreSince: "2026-10-19T11:00:00.000Z", unrelated: "kept" };
  return rule;
}

function harness(initialRules: AutomationRule[], overrides = cleanOperationalOverridesState(), failStateWrites = false) {
  let configs = initialRules.map(cleanAutomationRuleConfig);
  let states = Object.fromEntries(initialRules.map((rule) => [rule.id, cleanAutomationRuleState(rule)]));
  let currentOverrides = overrides;
  let stateWrites = 0;
  const documentStore = {
    readDocument: (key: "automationRules" | "automationRuleState", _fallback: unknown[] | Record<string, unknown>) =>
      key === "automationRules" ? configs : states,
    writeDocument: (key: "automationRules" | "automationRuleState", value: unknown[] | Record<string, unknown>) => {
      if (key === "automationRules") configs = value as typeof configs;
      else {
        if (failStateWrites) throw new Error("state persistence failed");
        stateWrites += 1;
        states = value as typeof states;
      }
      return value;
    },
  } as unknown as AutomationDocumentStore;
  const eventStore: AutomationEventStore = { isReady: () => false, recordEvent: () => undefined };
  const store = createAutomationStoreService(documentStore, eventStore);
  const actions: Array<{ action: string; payload: Record<string, unknown>; source: string }> = [];
  const notifications: Array<Record<string, unknown>> = [];
  let execute: () => Promise<unknown> = async () => ({ verified: true });
  const service = createDemandGuardService({
    exclusive: store.exclusive,
    readAutomationRules: store.read,
    writeAutomationRuleStates: store.writeStates,
    readOperationalOverridesState: async () => currentOverrides,
    executeAction: async (action, payload, options) => {
      actions.push({ action, payload, source: options.source });
      return execute();
    },
    notify: (event) => { notifications.push(event); },
    requestError: (status, message) => Object.assign(new Error(message), { statusCode: status }),
  });
  return {
    service,
    store,
    actions,
    notifications,
    setExecute: (next: () => Promise<unknown>) => { execute = next; },
    setOverrides: (next: typeof overrides) => { currentOverrides = next; },
    stateWrites: () => stateWrites,
  };
}

{
  const initial = guardRule("pending");
  const fixture = harness([initial]);
  const command = deferred<unknown>();
  const commandStarted = deferred<void>();
  fixture.setExecute(() => {
    commandStarted.resolve();
    return command.promise;
  });
  const restoring = fixture.service.restore(at);
  await commandStarted.promise;
  assert.equal(fixture.actions.length, 1);
  assert.equal((await fixture.store.read())[0].state.awaitingRestore, true, "ownership stays persisted until verified Auto completes");
  command.resolve({ verified: true, mode: "auto" });
  const [restored] = await restoring;
  assert.equal(restored.state.awaitingRestore, false);
  assert.equal(restored.state.restoreSince, null);
  assert.equal(restored.state.unrelated, "kept");
  assert.equal(restored.enabled, true);
  assert.equal(restored.stateUpdatedAt, at.toISOString());
  assert.equal(restored.lastResult?.manual, true);
  assert.equal(restored.log.at(-1)?.kind, "restore");
  assert.equal(restored.log.at(-1)?.message, "Charging Demand Guard restored manually; setting operation mode to Auto without waiting for the restore threshold or delay");
  assert.deepEqual(fixture.actions, [{ action: "set-mode", payload: { mode: "auto" }, source: "charging-demand-guard" }]);
  assert.equal(fixture.stateWrites(), 1);
  assert.equal(fixture.notifications[0]?.dedupeKey, "charging-demand-guard:restored");
  assert.equal(fixture.notifications[0]?.title, "Charging Demand Guard restored manually");
  assert.equal(fixture.notifications[0]?.message, "Operation mode was returned to Auto manually. Demand Guard settings are unchanged and protection may intervene again.");
}

{
  const fixture = harness([guardRule("enabled"), guardRule("disabled", { enabled: false })]);
  const result = await fixture.service.restore(at);
  assert.equal(result.every((rule) => rule.state.awaitingRestore === false), true);
  assert.equal(result.find((rule) => rule.id === "disabled")?.enabled, false);
  assert.equal(fixture.actions.length, 1, "multiple pending owners must restore with one device command");
}

{
  const fixture = harness([guardRule("not-pending", { awaitingRestore: false })]);
  await assert.rejects(fixture.service.restore(at), (error: unknown) =>
    error instanceof Error && error.message === "Charging Demand Guard is not awaiting restore" && (error as Error & { statusCode?: number }).statusCode === 409);
  assert.equal(fixture.actions.length, 0);
}

{
  const blockedOverrides = cleanOperationalOverridesState({
    backupPreparation: { active: true, allowDemandGuard: false },
  });
  const fixture = harness([guardRule("pending")], blockedOverrides);
  await assert.rejects(fixture.service.restore(at), (error: unknown) =>
    error instanceof Error && error.message === "Backup Preparation has Demand Guard intervention disabled" && (error as Error & { statusCode?: number }).statusCode === 409);
  assert.equal(fixture.actions.length, 0);
  assert.equal((await fixture.store.read())[0].state.awaitingRestore, true);
}

{
  const allowedOverrides = cleanOperationalOverridesState({
    backupPreparation: { active: true, allowDemandGuard: true },
  });
  const fixture = harness([guardRule("pending")], allowedOverrides);
  await fixture.service.restore(at);
  assert.deepEqual(fixture.actions, [{ action: "set-mode", payload: { mode: "auto" }, source: "charging-demand-guard" }]);
}

{
  const fixture = harness([guardRule("pending")]);
  fixture.setExecute(async () => { throw new Error("readback mismatch"); });
  await assert.rejects(fixture.service.restore(at), /readback mismatch/);
  assert.equal((await fixture.store.read())[0].state.awaitingRestore, true);
  assert.equal(fixture.stateWrites(), 0);
  assert.equal(fixture.notifications.length, 0);
}

{
  const fixture = harness([guardRule("pending")], cleanOperationalOverridesState(), true);
  await assert.rejects(fixture.service.restore(at), /state persistence failed/);
  assert.equal((await fixture.store.read())[0].state.awaitingRestore, true);
  assert.equal(fixture.notifications.length, 0, "persistence failure must not report a successful restore");
}

{
  const fixture = harness([guardRule("pending")]);
  const evaluationGate = deferred<void>();
  const evaluationStarted = deferred<void>();
  const evaluation = fixture.store.exclusive(async () => {
    const rules = await fixture.store.read();
    evaluationStarted.resolve();
    await evaluationGate.promise;
    rules[0].state = { ...rules[0].state, evaluationFinished: true };
    await fixture.store.writeStates(rules);
  });
  await evaluationStarted.promise;
  const restoring = fixture.service.restore(at);
  evaluationGate.resolve();
  await evaluation;
  const restored = await restoring;
  assert.equal(restored[0].state.evaluationFinished, true, "restore must re-read after queued evaluation mutations finish");
  assert.equal(restored[0].state.awaitingRestore, false);
}

{
  const fixture = harness([guardRule("pending")]);
  await assert.rejects(fixture.store.exclusive(async () => { throw new Error("queued failure"); }), /queued failure/);
  const result = await fixture.store.exclusive(async () => "subsequent operation");
  assert.equal(result, "subsequent operation", "a failed operation must not poison subsequent queued workflows");
}

{
  const fixture = harness([guardRule("pending")]);
  fixture.setExecute(async () => ({ verified: true }));
  await fixture.service.restore(at);
  const restored = await fixture.store.read();
  assert.equal(restored[0].enabled, true, "manual restoration leaves guard configuration enabled for a future overload");
  assert.equal(restored[0].state.awaitingRestore, false);
  const interventions: Array<{ action: string; payload: unknown }> = [];
  const evaluate = createAutomationRuleEvaluator({
    execute: async (action, payload) => { interventions.push({ action, payload }); return { verified: true }; },
    recordGuardTrigger: async () => undefined,
    notify: () => undefined,
  });
  await evaluate(restored[0], {
    meter: { grid_import_power: { value: 3_500 } },
    energy: { battery: { operation_mode: { value: "charging" }, instant_power: { value: 100 } } },
  }, new Date(at.getTime() + 1_000));
  await fixture.store.writeStates(restored);
  assert.deepEqual(interventions, [{ action: "set-mode", payload: { mode: "standby" } }]);
  assert.equal((await fixture.store.read())[0].state.awaitingRestore, true, "a later overload reactivates the restored guard");
}
