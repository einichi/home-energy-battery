import assert from "node:assert/strict";
import test from "node:test";
import type { HistorySample } from "../lib/contracts/history.js";
import { activeAwayFuelCellEvidence, inferAwayFuelCell } from "../lib/domain/away-fuel-cell.js";
import { cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { cleanConfig } from "../lib/domain/configuration.js";
import { buildFuelCellGenerationModel } from "../lib/domain/demand-forecast.js";
import { buildAdaptiveChargingPlan } from "../lib/domain/adaptive-planning.js";
import { localDayKey } from "../lib/domain/time.js";
import { observeAwayFuelCell } from "../lib/services/away-fuel-cell-service.js";
import { prepareAdaptiveEvaluation } from "../lib/services/adaptive-evaluation-lifecycle.js";
import { createAdaptiveStateService } from "../lib/services/adaptive-state-service.js";

const hour = 3_600_000;
const halfHour = hour / 2;
const start = new Date(2026, 9, 12, 22, 7).getTime();
const iso = (at: number) => new Date(at).toISOString();
const period = { id: "trip", from: iso(start), until: iso(start + 7 * 24 * hour), source: "manual" as const,
  createdAt: iso(start), updatedAt: iso(start), status: "active" as const };
const config = cleanConfig({ fuelCellEnabled: true, fuelCellPrimaryHost: "192.0.2.40", fuelCellProxyHosts: ["192.0.2.41"],
  fuelCell: { includeInAdaptiveCharging: true } });
function rollup(at: number, watts = 0, seconds = 1_800): HistorySample & { timestamp: string } {
  return { timestamp: iso(at + halfHour - 1), rollupStart: iso(at), rollupEnd: iso(at + halfHour),
    intervalAveragePowerW: { fuelCellPowerW: watts }, powerCoverageSeconds: { fuelCellPowerW: seconds } };
}
const quiet = (at = start, count = 48) => Array.from({ length: count }, (_, index) => rollup(at + index * halfHour));

test("a full covered cycle supports off, with no invented coverage or duplicate counting", () => {
  const data = quiet();
  const evidence = inferAwayFuelCell(period, config.fuelCellPrimaryHost, [...data, ...data], new Date(start + 24 * hour));
  assert.equal(evidence.regime, "off-supported");
  assert.equal(evidence.coveragePercent, 100);
  assert.equal(evidence.intervals.length, 1, "adjacent evidence is compacted for durable storage");
  assert.equal(evidence.headroomAllowanceRetained, true);
  const partial = inferAwayFuelCell(period, config.fuelCellPrimaryHost, quiet(start, 3), new Date(start + 1.5 * hour));
  assert.equal(partial.regime, "provisional-off", "midnight must not complete the first observation cycle");
});

test("missing, stale, sparse and conflicting telemetry cannot confirm off", () => {
  for (const data of [[], quiet().slice(0, 30), quiet().map((sample) => ({ ...sample, powerCoverageSeconds: { fuelCellPowerW: 100 } })),
    quiet().map((sample) => ({ ...sample, fuelCellGenerationState: "generating" }))]) {
    const evidence = inferAwayFuelCell(period, config.fuelCellPrimaryHost, data, new Date(start + 24 * hour));
    assert.equal(evidence.regime, "uncertain");
  }
  const stale = inferAwayFuelCell(period, config.fuelCellPrimaryHost, quiet(), new Date(start + 25 * hour));
  assert.equal(stale.reason, "stale-readings");
  const gap = quiet().filter((_, index) => index < 20 || index > 22);
  const evidence = inferAwayFuelCell(period, config.fuelCellPrimaryHost, gap, new Date(start + 24 * hour));
  assert.ok(evidence.coveragePercent > 90);
  assert.equal(evidence.regime, "uncertain", "a long gap must fail even with high daily coverage");
});

test("generation withdraws off immediately; sustained generation selects normal; a later quiet cycle revises it", () => {
  const off = inferAwayFuelCell(period, config.fuelCellPrimaryHost, quiet(), new Date(start + 24 * hour));
  const instant = { timestamp: iso(start + 24 * hour + 60_000), fuelCellPowerW: 700 };
  const detected = inferAwayFuelCell(period, config.fuelCellPrimaryHost, [instant], new Date(start + 24 * hour + 60_000), off);
  assert.equal(detected.reason, "generation-detected");
  assert.equal(detected.regime, "uncertain");
  const normal = inferAwayFuelCell(period, config.fuelCellPrimaryHost, [rollup(start + 24 * hour, 700)], new Date(start + 24.5 * hour), detected);
  assert.equal(normal.regime, "normal-model");
  const later = inferAwayFuelCell(period, config.fuelCellPrimaryHost, quiet(start + 25 * hour), new Date(start + 49 * hour), normal);
  assert.equal(later.regime, "off-supported");
});

test("carryover generation, pre-departure samples, future samples and noise are handled separately", () => {
  const data = [rollup(start - halfHour, 700), ...quiet()];
  const off = inferAwayFuelCell(period, config.fuelCellPrimaryHost, data, new Date(start + 24 * hour));
  assert.equal(off.regime, "off-supported", "generation ending at departure is not post-departure evidence");
  const carryover = inferAwayFuelCell(period, config.fuelCellPrimaryHost,
    [rollup(start, 700), ...quiet(start + halfHour, 47)], new Date(start + 24 * hour));
  assert.equal(carryover.regime, "normal-model");
  const settled = inferAwayFuelCell(period, config.fuelCellPrimaryHost,
    quiet(start + halfHour), new Date(start + 24.5 * hour), carryover);
  assert.equal(settled.regime, "off-supported");
  const future = inferAwayFuelCell(period, config.fuelCellPrimaryHost,
    [...quiet(start, 2), rollup(start + hour, 700)], new Date(start + hour));
  assert.equal(future.regime, "provisional-off");
  const noise = quiet().map((sample) => ({ ...sample, intervalAveragePowerW: { fuelCellPowerW: 2 } }));
  assert.equal(inferAwayFuelCell(period, config.fuelCellPrimaryHost, noise, new Date(start + 24 * hour)).regime, "off-supported");
});

test("raw readings require actual short intervals; a singleton cannot fill a day", () => {
  const raw = Array.from({ length: 61 }, (_, index) => ({ timestamp: iso(start + index * 30_000), fuelCellPowerW: 700 }));
  assert.equal(inferAwayFuelCell(period, config.fuelCellPrimaryHost, raw, new Date(start + halfHour)).regime, "normal-model");
  const singleton = inferAwayFuelCell(period, config.fuelCellPrimaryHost,
    [{ timestamp: iso(start + 24 * hour), fuelCellPowerW: 0, expectedIntervalSeconds: 86_400 }], new Date(start + 24 * hour));
  assert.equal(singleton.coveragePercent, 0);
  assert.equal(singleton.regime, "uncertain");
});

test("rollup freshness uses the actual reading time and rejects daily or foreign-device evidence", () => {
  const now = new Date(start + 24 * hour);
  const staleRollup = { ...rollup(start + 23.5 * hour), timestamp: iso(start + 22 * hour) };
  assert.equal(inferAwayFuelCell(period, config.fuelCellPrimaryHost, [staleRollup], now).reason, "stale-readings");
  const daily = { ...rollup(start), rollupEnd: now.toISOString(), timestamp: now.toISOString(), powerCoverageSeconds: { fuelCellPowerW: 86_400 } };
  assert.equal(inferAwayFuelCell(period, config.fuelCellPrimaryHost, [daily], now).coveragePercent, 0);
  const foreign = quiet().map((sample) => ({ ...sample, fuelCellSourceHosts: { "192.0.2.99": 50 } }));
  assert.equal(inferAwayFuelCell(period, config.fuelCellPrimaryHost, foreign, now).regime, "uncertain");
  const proxy = quiet().map((sample) => ({ ...sample, fuelCellSourceHost: "192.0.2.41" }));
  assert.equal(activeAwayFuelCellEvidence(config, [period], proxy, now)?.regime, "off-supported");
});

test("durable evidence survives restart, long trips and extension, and resets on replacement or start change", async () => {
  const now = new Date(start + 24 * hour);
  let document: Record<string, unknown> = {};
  const service = createAdaptiveStateService({
    documents: { readDocument: () => document, writeDocument: (_key, value) => { document = JSON.parse(JSON.stringify(value)); } },
    history: { isReady: () => false, recordEvent: () => {} }, synchronizeDeadline: () => {}, now: () => now,
  });
  const state = await service.read();
  state.awayFuelCell = inferAwayFuelCell(period, config.fuelCellPrimaryHost, quiet(), now);
  await service.write(state);
  const restored = cleanAdaptiveChargingState(document);
  const extended = { ...period, until: iso(start + 120 * 24 * hour) };
  const resumed = activeAwayFuelCellEvidence(config, [extended], [], now, restored.awayFuelCell)!;
  assert.equal(resumed.regime, "off-supported");
  assert.equal(resumed.until, extended.until);
  const replacement = activeAwayFuelCellEvidence({ ...config, fuelCellPrimaryHost: "192.0.2.99" }, [extended], quiet(), now, resumed)!;
  assert.equal(replacement.regime, "uncertain");
  assert.equal(replacement.coveragePercent, 0);
  assert.equal(replacement.observationFrom, now.toISOString());
  const changed = activeAwayFuelCellEvidence(config, [{ ...extended, from: iso(start + 23 * hour) }], quiet(), now, resumed)!;
  assert.equal(changed.regime, "provisional-off");
  assert.equal(activeAwayFuelCellEvidence({ ...config, fuelCellEnabled: false }, [extended], quiet(), now, resumed), null);
  assert.equal(activeAwayFuelCellEvidence(config, [period], [], new Date(Date.parse(period.until)), resumed), null);
  const day100 = start + 100 * 24 * hour;
  const longTrip = activeAwayFuelCellEvidence(config, [extended], quiet(day100 - 24 * hour), new Date(day100), resumed)!;
  assert.equal(longTrip.regime, "off-supported", "a long trip can use durable identity and recent observations without its first day in history");
});

function historicalGeneration(now: Date) {
  return Array.from({ length: 12 }, (_, index) => {
    const day = new Date(now);
    day.setDate(day.getDate() - 7 * (index + 1));
    day.setHours(0, 0, 0, 0);
    return Array.from({ length: 48 }, (_, bucket) => ({ timestamp: iso(day.getTime() + bucket * halfHour), fuelCellPowerW: 700 }));
  }).flat();
}

test("historical occupancy is matched by interval rather than noon on departure days", () => {
  const now = new Date(start); now.setHours(7, 0, 0, 0);
  const data = historicalGeneration(now);
  const historicalPeriods = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now); date.setDate(date.getDate() - 7 * (index + 1)); date.setHours(12);
    return { from: date.toISOString(), until: iso(date.getTime() + 6 * hour) };
  });
  const model = buildFuelCellGenerationModel({}, data, now, { awayPeriods: historicalPeriods });
  assert.equal(model.ready, true);
  assert.equal(model.comparableDays, 10, "the two oldest weeks are outside the seasonal match window");
  assert.equal(model.forecastAt(now).medianW, 700);
});

test("provisional/supported off changes expectation, retains supported headroom, and respects exact return", () => {
  const now = new Date(start + 24 * hour);
  const target = new Date(now.getTime() + hour);
  const data = [...historicalGeneration(now), ...quiet()];
  const model = buildFuelCellGenerationModel(config, data, now, { awayPeriods: [period] });
  assert.equal(model.influence, "active");
  const forecast = model.forecastAt(target);
  assert.equal(forecast.awayRegime, "off-supported");
  assert.equal(forecast.medianW, 0);
  assert.equal(forecast.p20W, 0);
  assert.equal(forecast.p80W, 700);
  assert.ok(forecast.sampleCount >= 4);
  assert.equal(model.forecastAt(new Date(Date.parse(period.until))).awayRegime, null);
  const beforeReturn = new Date(Date.parse(period.until) - 5 * 60_000);
  assert.equal(model.forecastAt(beforeReturn).medianW, 0, "fuel-cell policy continues inside the demand return buffer");
  const observe = buildFuelCellGenerationModel({ ...config, fuelCell: { includeInAdaptiveCharging: false } }, data, now, { awayPeriods: [period] });
  assert.equal(observe.influence, "observe");
  assert.equal(observe.forecastAt(target).medianW, 0);
  const disabled = buildFuelCellGenerationModel({ ...config, fuelCellEnabled: false }, data, now, { awayPeriods: [period] });
  assert.equal(disabled.influence, "observe");
  assert.deepEqual(disabled.awayForecasts, []);
});

test("normal and uncertain regimes use the ordinary generation model; scheduled trips do not use future evidence", () => {
  const now = new Date(start + halfHour);
  const data = [...historicalGeneration(now), rollup(start, 700)];
  const model = buildFuelCellGenerationModel(config, data, now, { awayPeriods: [period] });
  assert.equal(model.forecastAt(new Date(start + hour)).awayRegime, "normal-model");
  assert.equal(model.forecastAt(new Date(start + hour)).medianW, 700);
  const scheduled = buildFuelCellGenerationModel(config, [...data, ...quiet(start + 24 * hour)], new Date(start - hour), { awayPeriods: [period] });
  assert.equal(scheduled.forecastAt(new Date(start + hour)).awayRegime, "provisional-off");
  assert.equal(scheduled.forecastAt(new Date(start + hour)).medianW, 0);
  const uncertain = buildFuelCellGenerationModel(config, historicalGeneration(now), now, { awayPeriods: [period] });
  assert.equal(uncertain.forecastAt(new Date(start + hour)).medianW, 700);
});

test("observation queues one refresh per transition and works while operational control is blocked", async () => {
  const now = new Date(start + 24 * hour);
  const state = cleanAdaptiveChargingState();
  const status = { read_at: now.toISOString(), energy: { battery: {}, fuel_cells: [{ source_role: "primary", host: config.fuelCellPrimaryHost, instant_power: { value: 0 } }] } };
  const readHistory = async () => quiet();
  await observeAwayFuelCell(state, config, status, [period], now, readHistory);
  assert.equal(state.awayFuelCell?.regime, "off-supported");
  const request = state.pendingPlanRequestId;
  const logCount = state.log.length;
  await observeAwayFuelCell(state, config, status, [period], now, readHistory);
  assert.equal(state.pendingPlanRequestId, request);
  assert.equal(state.log.length, logCount);
  let observed = false;
  const blocked = await prepareAdaptiveEvaluation(state, status, now, {
    history: { awayPeriods: () => [period] }, readOperationalOverrides: async () => ({ backupPreparation: { active: true } }),
    writeState: async (value) => value,
    observeAwayFuelCell: async () => { observed = true; },
  });
  assert.equal(observed, true);
  assert.equal(blocked.stopped, true);
  const generating = { ...status, read_at: iso(start + 24 * hour + 60_000), energy: { battery: {}, fuel_cells: [{ source_role: "primary", host: config.fuelCellPrimaryHost, instant_power: { value: 700 } }] } };
  await observeAwayFuelCell(state, config, generating, [period], new Date(start + 24 * hour + 60_000), readHistory);
  assert.equal(state.awayFuelCell?.reason, "generation-detected");
  assert.notEqual(state.pendingPlanRequestId, request);
  await observeAwayFuelCell(state, config, status, [], now, readHistory);
  assert.equal(state.awayFuelCell, null);
});

test("planning splits exact Away boundaries while retaining Away demand and the headroom scenario", () => {
  const now = new Date(start - 10 * 60_000);
  const planningConfig = cleanConfig({ ...config, solarEnabled: true, smartCosmoEnabled: true, rateMode: "multi",
    standardRateYenPerKwh: 30, rateBands: [{ start: "00:00", end: "06:00", yenPerKwh: 10, label: "Cheap" }],
    batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 3_000 },
    adaptiveCharging: { enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 5, targetSocPercent: 80, forecastMarginPercent: 20 },
    settingCache: { discharge_limit: { lastKnown: { decoded: { percent: 20 } }, lastReadAt: now.toISOString() } },
  });
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const forecast = { fetchedAt: now.toISOString(), timezone: "Asia/Tokyo", utcOffsetSeconds: 32_400, latitude: 35, longitude: 139,
    hours: Array.from({ length: 72 }, (_, index) => ({ timestamp: iso(dayStart.getTime() + index * hour), tiltedIrradianceWm2: 0 })),
    days: Array.from({ length: 3 }, (_, offset) => {
      const date = new Date(dayStart); date.setDate(date.getDate() + offset);
      const sunset = new Date(date); sunset.setHours(18);
      return { date: localDayKey(date), sunrise: null, sunset: sunset.toISOString() };
    }),
  };
  const demandDays = Array.from({ length: 21 }, (_, index) => {
    const date = new Date(dayStart); date.setDate(date.getDate() - index - 1);
    return { key: localDayKey(date), date, values: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 1_000])),
      coverageByBucket: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 1_800])), coverage: 1, daytimeCoverage: 1 };
  });
  const trip = { ...period, until: iso(start + 2 * hour + 6 * 60_000) };
  const samples = [...historicalGeneration(now), { timestamp: now.toISOString(), stateOfChargePercent: 50 }];
  const plan = buildAdaptiveChargingPlan({ config: planningConfig, state: { forecast }, samples,
    historicalDemandDays: demandDays, awayPeriods: [trip], now });
  assert.equal(plan.available, true, String(plan.reason));
  assert.ok(plan.timeline.some((slot) => slot.start === trip.from));
  assert.ok(plan.timeline.some((slot) => slot.end === trip.until));
  const during = plan.timeline.filter((slot) => Date.parse(slot.start) >= start && Date.parse(slot.end) <= Date.parse(trip.until));
  assert.ok(during.length);
  assert.ok(during.every((slot) => slot.fuelCellMedianW === 0 && slot.fuelCellP20W === 0 && Math.abs(slot.fuelCellP80W - 700) < 1e-8));
  assert.ok(during.some((slot) => slot.away));
  assert.ok(plan.timeline.some((slot) => Date.parse(slot.start) >= Date.parse(trip.until) && slot.fuelCellMedianW === 700));
  const baseline = buildAdaptiveChargingPlan({ config: { ...planningConfig, fuelCellPrimaryHost: "", fuelCellHosts: [] },
    state: { forecast }, samples, historicalDemandDays: demandDays, awayPeriods: [trip], now });
  assert.equal(baseline.available, true);
  assert.ok("requiredGridChargeKwh" in plan && "predictedFuelCellKwh" in plan);
  assert.ok("requiredGridChargeKwh" in baseline && "predictedFuelCellKwh" in baseline);
  assert.ok(Number(plan.requiredGridChargeKwh) >= Number(baseline.requiredGridChargeKwh));
  assert.ok(Number(plan.predictedFuelCellKwh) < Number(baseline.predictedFuelCellKwh));
});
