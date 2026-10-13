import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cachedForecastIsUsable } from "../lib/domain/adaptive-availability.js";
import { buildAdaptiveChargingPlan } from "../lib/domain/adaptive-planning.js";
import { applyAdaptiveChargingTimelineSlot, buildAdaptiveChargingTimelineView } from "../lib/domain/adaptive-timeline.js";
import { CURRENT_BACKTEST_MODEL, evaluateBacktestCase, simulateModelOnlyExecution } from "../lib/domain/backtesting.js";
import { planChronologicalDiscountedCharging } from "../lib/domain/chronological-charging.js";
import { cleanConfig } from "../lib/domain/configuration.js";
import { buildFuelCellGenerationModel, predictBranchDemand } from "../lib/domain/demand-forecast.js";
import { solarCalibrationFactor } from "../lib/domain/solar-forecast.js";
import { localDayKey } from "../lib/domain/time.js";
import { createForecastRepository } from "../lib/persistence/forecast-repository.js";
import { createHistorySchema } from "../lib/persistence/history-database.js";
import { createAdaptiveForecastService } from "../lib/services/adaptive-forecast-service.js";
import { createAdaptiveStateService } from "../lib/services/adaptive-state-service.js";
import { createAutomationOrchestrator } from "../lib/services/automation-orchestrator.js";
import { cleanAutomationRule } from "../lib/domain/automation-rules.js";
import { cleanOperationalOverridesState } from "../lib/domain/operational-overrides.js";
import type { HistorySample } from "../lib/contracts/history.js";

const now = new Date(2026, 9, 13, 1);
const config = cleanConfig({
  solarEnabled: true, smartCosmoEnabled: true, rateMode: "multi", standardRateYenPerKwh: 30,
  rateBands: [{ start: "00:00", end: "06:00", yenPerKwh: 10, label: "Cheap" }],
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 3_000 },
  adaptiveCharging: { enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 5, targetSocPercent: 80, forecastMarginPercent: 20 },
  settingCache: { discharge_limit: { lastKnown: { decoded: { percent: 20 } }, lastReadAt: now.toISOString() } },
});

let stored: Record<string, unknown> = {};
const stateService = createAdaptiveStateService({
  documents: { readDocument: () => stored, writeDocument: (_key, value) => { stored = structuredClone(value); } },
  history: { isReady: () => false, recordEvent: () => true }, synchronizeDeadline: () => {}, now: () => now,
});
const oldEvaluation = await stateService.read();
const awayUpdate = await stateService.read();
awayUpdate.pendingPlanReason = "first Away update";
awayUpdate.pendingPlanRequestId = "first";
await stateService.write(awayUpdate);
const planningRead = await stateService.read();
const laterAwayUpdate = await stateService.read();
laterAwayUpdate.pendingPlanReason = "second Away update";
laterAwayUpdate.pendingPlanRequestId = "second";
await stateService.write(laterAwayUpdate);
planningRead.pendingPlanReason = null;
planningRead.pendingPlanRequestId = null;
await stateService.write(planningRead);
assert.equal((await stateService.read()).pendingPlanRequestId, "second", "finishing an older replan must not consume a newer Away request");
const pauseRead = await stateService.read();
pauseRead.pausedUntil = new Date(now.getTime() + 3_600_000).toISOString();
await stateService.write(pauseRead);
oldEvaluation.owner = "adaptiveCharging";
await stateService.write(oldEvaluation);
assert.equal((await stateService.read()).owner, null, "an old evaluation must not resurrect ownership after a manual pause");

let complete: (() => void) | undefined;
const waiting = new Promise<void>((resolve) => { complete = resolve; });
const order: string[] = [];
const first = stateService.exclusive(async () => { order.push("evaluation"); await waiting; order.push("evaluation finished"); });
const second = stateService.exclusive(async () => { order.push("manual pause"); });
await Promise.resolve();
assert.deepEqual(order, ["evaluation"]);
complete!();
await Promise.all([first, second]);
assert.deepEqual(order, ["evaluation", "evaluation finished", "manual pause"]);

let resolveForecast: ((value: Response) => void) | undefined;
const response = new Promise<Response>((resolve) => { resolveForecast = resolve; });
let entered: (() => void) | undefined;
const fetching = new Promise<void>((resolve) => { entered = resolve; });
const forecastService = createAdaptiveForecastService({
  history: {
    recordForecast: () => true, recordWeather: () => 0, isReady: () => false,
    settleSolarForecastOutcomes: () => 0, historicalWeather: () => [],
    solarForecastAccuracy: () => ({ learned: false, sampleCount: 0, measuredFactor: null, factor: 1, meanAbsolutePercentageError: null, outcomes: [] }),
    recordSolarForecastIssues: () => 0,
  },
  externalIoDisabled: false, timezone: "Asia/Tokyo", readState: stateService.read, writeState: stateService.write,
  readHistory: async () => [], logError: () => {},
});
const refreshing = forecastService.refresh(config, { now, fetchImpl: (async () => { entered!(); return response; }) as typeof fetch });
await fetching;
const duringFetch = await stateService.read();
duringFetch.pausedUntil = new Date(now.getTime() + 7_200_000).toISOString();
await stateService.write(duringFetch);
resolveForecast!(new Response(JSON.stringify({ timezone: "Asia/Tokyo", hourly: { time: [] }, daily: { time: [] } })));
await refreshing;
assert.equal((await stateService.read()).pausedUntil, duringFetch.pausedUntil);
const failure = (async () => { throw new Error("network configuration unavailable"); }) as typeof fetch;
await forecastService.refresh(config, { now, fetchImpl: failure });
await forecastService.refresh(config, { now, fetchImpl: failure });
const failed = await stateService.read();
assert.equal(failed.lastForecastError?.retryCount, 2, "retry count survives persistence");
assert.equal(cachedForecastIsUsable(failed, now), true, "provider error text is not an incompatibility classifier");
assert.equal(cachedForecastIsUsable({ ...failed, lastForecastError: { kind: "incompatible" } }, now), false);
assert.equal(cachedForecastIsUsable(failed, new Date(now.getTime() + 7 * 3_600_000)), false);

const band = { label: "Cheap", yenPerKwh: 10 };
const timeline = Array.from({ length: 4 }, (_, index) => ({
  startMs: now.getTime() + index * 1_800_000, endMs: now.getTime() + (index + 1) * 1_800_000,
  netKwh: -0.5, highSolarNetKwh: -0.5, demandW: 1_000, solarKwh: 0,
  chargeCapacityKwh: 2, band, rateWindowStartMs: now.getTime(), rateWindowEndMs: now.getTime() + 7_200_000,
}));
const plan = planChronologicalDiscountedCharging({ timeline, currentStoredKwh: 5, capacityKwh: 10,
  dischargeFloorKwh: 0, maximumTargetPercent: 80, maximumChargeWatts: 4_000 });
assert.equal(plan.plannedChargeKwh, 3);
const view = buildAdaptiveChargingTimelineView({ timeline, slots: plan.slots, initialStoredKwh: 5,
  floorKwh: 0, capacityKwh: 10, maximumChargeWatts: 4_000, config });
assert.ok(Math.abs(view.at(-1)!.predictedEndSocPercent! - plan.windows[0]!.predictedEndSocPercent!) < 0.01,
  "optimizer and displayed timeline must simulate the same Standby policy");
assert.equal(applyAdaptiveChargingTimelineSlot(0, { startMs: 0, endMs: 1_800_000, netKwh: 5, chargeCapacityKwh: 1.5 },
  0.75, 0, 10, 1, 3_000), 1.5, "AUTO charging is capped for the AUTO fraction, not for the entire mixed interval");

const calibration = { factor: 4, learned: true, validDays: 10, groupFactors: { "2:morning": 1 } };
const before = solarCalibrationFactor(calibration, new Date(2026, 9, 31, 8));
const after = solarCalibrationFactor(calibration, new Date(2026, 10, 1, 8));
assert.ok(Math.abs(after - before) < 0.1, "a missing neighboring seasonal factor must blend toward fallback, not move the discontinuity");

const afternoon = new Date(2026, 5, 15, 16);
const comparisonDays = [3, 4, 5, 6, 7, 10, 11, 12].map((age, index) => {
  const date = new Date(afternoon); date.setDate(date.getDate() - age); date.setHours(0, 0, 0, 0);
  const watts = index < 3 || index === 7 ? 0 : 1_000;
  return { key: localDayKey(date), date, values: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, watts])),
    coverageByBucket: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 1_800])), coverage: 1, daytimeCoverage: 1 };
});
const partialDate = new Date(afternoon); partialDate.setHours(0, 0, 0, 0);
const partialDay = { key: localDayKey(partialDate), date: partialDate,
  values: new Map(Array.from({ length: 32 }, (_, bucket) => [bucket, 1_000])),
  coverageByBucket: new Map(Array.from({ length: 32 }, (_, bucket) => [bucket, 1_800])), coverage: 32 / 48, daytimeCoverage: 20 / 24 };
assert.equal(predictBranchDemand([], afternoon, new Map(), { historicalDays: comparisonDays }).profile.get(40), 0);
assert.equal(predictBranchDemand([], afternoon, new Map(), { historicalDays: [partialDay, ...comparisonDays] }).profile.get(40), 0,
  "a partial current day must not displace the eighth useful observation for an unobserved future bucket");

const samples: HistorySample[] = [0, 1].map((index) => ({
  timestamp: new Date(now.getTime() + (index + 1) * 1_800_000).toISOString(),
  rollupStart: new Date(now.getTime() + index * 1_800_000).toISOString(),
  rollupEnd: new Date(now.getTime() + (index + 1) * 1_800_000).toISOString(),
  branchDemandKwh: 0.5, solarGenerationKwh: 0.25, fuelCellKwh: 0.1, gridImportKwh: 0.15,
  coverageSeconds: { branchDemandKwh: 1_800, solarGenerationKwh: 1_800, fuelCellKwh: 1_800, gridImportKwh: 1_800 },
  startStateOfChargePercent: 50, endStateOfChargePercent: 50,
}));
const snapshot = { id: 1, createdAt: now.toISOString(), modelId: CURRENT_BACKTEST_MODEL.id,
  modelVersion: CURRENT_BACKTEST_MODEL.version, trigger: "test", config,
  plan: { available: true, slots: [], targetSunset: samples[1]!.rollupEnd,
    timeline: [{ start: now.toISOString(), end: samples[1]!.rollupEnd!, demandW: 1_000, solarW: 400, fuelCellMedianW: 200 }],
  },
};
const scored = evaluateBacktestCase({ snapshot, samples, now: new Date(samples[1]!.rollupEnd!) });
assert.equal(scored.components.solar.errorKwh, 0, "the configured 20% margin is reversed as 20%, not 0.99%");
assert.equal(scored.components.fuelCell.errorKwh, 0, "observe-only median forecasts remain scoreable");
assert.equal(evaluateBacktestCase({ snapshot, samples, now }).evaluable, false, "future horizons are not completed evidence");
const missing = samples.map((sample) => ({ ...sample, solarGenerationKwh: undefined,
  coverageSeconds: { ...sample.coverageSeconds, solarGenerationKwh: 0 } }));
assert.equal(evaluateBacktestCase({ snapshot, samples: missing, now: new Date(samples[1]!.rollupEnd!) }).modelOnly, null,
  "missing generation must not be simulated as zero");
const longSlot = { slots: [{ start: now.toISOString(), end: samples[1]!.rollupEnd!, targetWh: 1_000 }] };
const noLoad = samples.map((sample) => ({ ...sample, branchDemandKwh: 0, solarGenerationKwh: 0, fuelCellKwh: 0 }));
assert.equal(simulateModelOnlyExecution(longSlot, noLoad, config)!.endingSocPercent, 60,
  "a 1 kWh charge spanning two rollups must not be counted twice");

const database = new DatabaseSync(":memory:");
try {
  createHistorySchema(database, { schemaVersion: 8, energyCalculationVersion: 4, architectureVersion: 1 });
  let fuelIntervals: HistorySample[] = [{ ...samples[0], fuelCellKwh: 0.01, coverageSeconds: { fuelCellKwh: 30 } }];
  const repository = createForecastRepository({ database: () => database, intervalSamples: () => fuelIntervals,
    solarForecastMinimumCoverageRatio: 0.8 });
  const target = { start: samples[0]!.rollupStart, end: samples[0]!.rollupEnd, medianW: 200, sampleCount: 8 };
  repository.recordFuelCellForecasts([target], new Date(now.getTime() - 3_600_000).toISOString());
  assert.equal(repository.settleFuelCellForecastOutcomes(new Date(samples[0]!.rollupEnd!)), 0,
    "elapsed interval time is not a substitute for measured coverage");
  fuelIntervals = [{ ...samples[0], fuelCellKwh: 0.1, coverageSeconds: { fuelCellKwh: 1_800 } }];
  assert.equal(repository.settleFuelCellForecastOutcomes(new Date(samples[0]!.rollupEnd!)), 1);
  repository.recordFuelCellForecasts([target], new Date(now.getTime() - 1_800_000).toISOString());
  repository.recordFuelCellForecasts([target], new Date(now.getTime() - 60_000).toISOString());
  repository.settleFuelCellForecastOutcomes(new Date(samples[0]!.rollupEnd!));
  const canonical = repository.fuelCellForecastOutcomes(10, { canonical: true });
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]!.issuedAt, new Date(now.getTime() - 1_800_000).toISOString(), "fixed-cutoff selection happens before limiting rows");
  assert.equal(canonical[0]!.actualCoverageSeconds, 1_800);
} finally { database.close(); }

const demandDays = Array.from({ length: 21 }, (_, index) => {
  const date = new Date(now); date.setDate(date.getDate() - index - 1); date.setHours(0, 0, 0, 0);
  return { key: localDayKey(date), date, values: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 1_000])),
    coverageByBucket: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 1_800])), coverage: 1, daytimeCoverage: 1 };
});
const sparseFuel = demandDays.slice(0, 8).flatMap((day) => Array.from({ length: 16 }, (_, bucket) => ({
  timestamp: new Date(day.date.getTime() + bucket * 1_800_000).toISOString(), fuelCellPowerW: 700,
}))).concat([{ timestamp: now.toISOString(), fuelCellPowerW: 700 }]);
const activeConfig = { ...config, fuelCell: { ...config.fuelCell, includeInAdaptiveCharging: true } };
assert.equal(buildFuelCellGenerationModel(activeConfig, sparseFuel, now).ready, true);
const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
const solarForecast = { fetchedAt: now.toISOString(), timezone: "Asia/Tokyo", utcOffsetSeconds: 32_400,
  latitude: 35, longitude: 139,
  hours: Array.from({ length: 72 }, (_, hour) => ({ timestamp: new Date(startOfDay.getTime() + hour * 3_600_000).toISOString(), tiltedIrradianceWm2: 0 })),
  days: Array.from({ length: 3 }, (_, offset) => { const date = new Date(startOfDay); date.setDate(date.getDate() + offset);
    const sunset = new Date(date); sunset.setHours(18); return { date: localDayKey(date), sunrise: null, sunset: sunset.toISOString() }; }),
};
const unsafe = buildAdaptiveChargingPlan({ config: activeConfig,
  state: { forecast: solarForecast }, samples: [...sparseFuel, { timestamp: now.toISOString(), stateOfChargePercent: 50 }],
  historicalDemandDays: demandDays, now });
assert.equal(unsafe.available, false);
assert.match(String(unsafe.reason), /unknown generation.*headroom/);

let refreshAttempts = 0;
const orchestrationState = { ...await stateService.read(), forecast: { ...solarForecast,
  fetchedAt: new Date(Date.now() - 4 * 3_600_000).toISOString() },
  lastForecastError: { at: new Date().toISOString(), error: "provider down", kind: "provider", retryCount: 3 },
};
const guardRule = cleanAutomationRule({ type: "backup-demand-guard", enabled: true,
  conditions: { breakerVoltage: 200, breakerAmps: 30, reserveAmps: 0 } });
const orchestrator = createAutomationOrchestrator({
  intervalMs: 30_000, forecastRefreshMs: 3 * 3_600_000,
  readConfig: async () => config, readAutomationRules: async () => [guardRule],
  writeAutomationRuleStates: async () => {}, readOperationalOverridesState: async () => cleanOperationalOverridesState(),
  readAdaptiveChargingState: async () => orchestrationState, getStatusSnapshot: async () => ({}), deviceTimings: () => [],
  evaluateAutomationRule: async () => ({ changed: false }), executeAction: async () => {},
  refreshAdaptiveChargingForecast: async () => { refreshAttempts += 1; return orchestrationState; },
  evaluateAdaptiveCharging: async () => orchestrationState, notifications: { observeCondition: () => {}, enqueue: () => {} }, warn: () => {},
});
await orchestrator.run(); await orchestrator.run();
assert.equal(refreshAttempts, 0, "repeated automation ticks during backoff must not retry the provider");
orchestrationState.lastForecastError.at = new Date(Date.now() - 5 * 60_000).toISOString();
await orchestrator.run();
assert.equal(refreshAttempts, 1, "the provider is retried after the exponential delay expires");

const expiredRevision = await stateService.read();
for (let index = 0; index < 260; index += 1) await stateService.write(await stateService.read());
await assert.rejects(stateService.write(expiredRevision), /revision expired/, "expired snapshots must never fall back to unsafe last-write-wins");
console.log("forecast reliability regression tests passed");
