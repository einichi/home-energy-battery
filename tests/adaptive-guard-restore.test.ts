import assert from "node:assert/strict";
import { cleanConfig } from "../lib/domain/configuration.js";
import { type AdaptiveChargingState, cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { adaptiveChargingPlanRefreshDecision } from "../lib/domain/adaptive-control.js";
import { createAdaptiveControlService } from "../lib/services/adaptive-control-service.js";

const now = new Date("2026-10-19T12:00:00.000Z");
for (const owner of [null, "adaptiveCharging"] as const) {
  const pausedUntil = new Date(now.getTime() + 60_000).toISOString();
  let state: AdaptiveChargingState = cleanAdaptiveChargingState({
    owner,
    activeSlot: { start: now.toISOString(), end: pausedUntil, targetWh: 1000 },
    activeChargedKwh: 0.5,
    activePlanCreatedAt: now.toISOString(),
    activeLastCheckedAt: now.toISOString(),
    interruptedCharge: { remainingWh: 500, slotEnd: pausedUntil },
    breakerRecovery: { interruptedAt: now.toISOString(), cooldownUntil: pausedUntil },
    plan: { available: true, createdAt: now.toISOString(), slots: [] },
    pausedUntil,
    standbyHoldUntil: pausedUntil,
    solarHeadroomHoldUntil: pausedUntil,
  });
  const config = cleanConfig({});
  const service = createAdaptiveControlService({
    readConfig: async () => config,
    readState: async () => state,
    writeState: async (next) => { state = next; return next; },
    releaseCharge: async () => { throw new Error("Auto was already restored"); },
    execute: async () => { throw new Error("preparation must not issue device commands"); },
    enforceDeadline: async () => ({}),
    logError: () => undefined,
    deadlineRetryMs: 1000,
    maxTimerDelayMs: 1000,
  });
  await service.prepareGuardRestore(now);
  assert.equal(state.owner, null, "even ownership not yet observed by the guard evaluator is retired");
  assert.equal(state.activeSlot, null);
  assert.equal(state.activeChargedKwh, 0);
  assert.equal(state.activePlanCreatedAt, null);
  assert.equal(state.activeLastCheckedAt, null);
  assert.equal(state.interruptedCharge, null, "the new plan must not be capped by the old target");
  assert.equal(state.breakerRecovery, null, "manual restore clears the recovery wait");
  assert.equal(state.standbyHoldUntil, null);
  assert.equal(state.plan, null);
  assert.equal(state.pausedUntil, pausedUntil, "restore must not cancel an explicit manual pause");
  assert.equal(state.solarHeadroomHoldUntil, pausedUntil);
  assert.equal(state.pendingPlanReason, "manual Demand Guard restore");
  assert.equal(adaptiveChargingPlanRefreshDecision(state, config, now).refresh, true);
}

// Exercise the fresh planner and real evaluator after restoration, including a
// changed charge requirement and conditions that must prevent an immediate start.
const { createAdaptiveChargingEvaluator } = await import("../lib/services/adaptive-charging-evaluator.js");
const { cleanAutomationRule } = await import("../lib/domain/automation-rules.js");
const { cleanOperationalOverridesState } = await import("../lib/domain/operational-overrides.js");
const evaluationAt = new Date(2026, 9, 19, 0, 45);
const config = cleanConfig({
  solarEnabled: true, smartCosmoEnabled: true, fuelCellEnabled: false,
  settingCache: { discharge_limit: { lastKnown: { decoded: { percent: 10 } }, lastReadAt: evaluationAt.toISOString() } },
  rateMode: "multi", standardRateYenPerKwh: 40,
  rateBands: [
    { start: "23:00", end: "01:00", yenPerKwh: 15, label: "Night" },
    { start: "01:00", end: "23:00", yenPerKwh: 40, label: "Standard" },
  ],
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 2000 },
  adaptiveCharging: { enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 5 },
});
const guard = cleanAutomationRule({
  enabled: true, conditions: { breakerAmps: 60, reserveAmps: 5, breakerVoltage: 100 },
});
for (const scenario of ["due", "full", "high-demand", "paused"] as const) {
  let state: AdaptiveChargingState = cleanAdaptiveChargingState({
    forecast: {
      fetchedAt: evaluationAt.toISOString(),
      hours: Array.from({ length: 48 }, (_, index) => ({
        timestamp: new Date(evaluationAt.getTime() + index * 3600_000).toISOString(),
        tiltedIrradianceWm2: 0, temperatureC: 20,
      })),
      days: [0, 1].map((offset) => ({
        date: `2026-10-${19 + offset}`,
        sunrise: new Date(2026, 9, 19 + offset, 6).toISOString(),
        sunset: new Date(2026, 9, 19 + offset, 18).toISOString(),
      })),
    },
    interruptedCharge: { remainingWh: 10, slotEnd: new Date(evaluationAt.getTime() + 900_000).toISOString() },
    breakerRecovery: { interruptedAt: evaluationAt.toISOString(), cooldownUntil: new Date(evaluationAt.getTime() + 600_000).toISOString() },
    pausedUntil: scenario === "paused" ? new Date(evaluationAt.getTime() + 600_000).toISOString() : null,
  });
  const readState = async () => state;
  const writeState = async (next: AdaptiveChargingState) => { state = next; return next; };
  const control = createAdaptiveControlService({
    readConfig: async () => config, readState, writeState,
    releaseCharge: async () => false, execute: async () => ({}),
    enforceDeadline: async () => ({}), logError: () => undefined,
    deadlineRetryMs: 1000, maxTimerDelayMs: 1000,
  });
  const starts: Array<Record<string, unknown>> = [];
  const evaluator = createAdaptiveChargingEvaluator({
    readState, writeState,
    history: { awayPeriods: () => [], historicalWeather: () => [] },
    readOperationalOverrides: async () => cleanOperationalOverridesState(),
    executeAction: async () => ({}), releaseCharge: async () => false,
    suspendInStandby: async () => false, recoverIdle: async () => false,
    startCharge: async (slot) => { starts.push(slot); return { verified: true }; },
    readHistory: async () => [], refreshBatteryLearning: async () => state.batteryLearning,
    readDemandProfileDays: async () => Array.from({ length: 12 }, (_, index) => {
      const date = new Date(evaluationAt);
      date.setDate(date.getDate() - index - 1);
      return {
        key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        date, values: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 500])),
        coverage: 1, daytimeCoverage: 1,
      };
    }), solarForecastAccuracy: () => ({}) as never,
    recordFuelCellPlanForecast: () => 0, breakerWaitLogMs: 60_000,
  });
  await control.prepareGuardRestore(evaluationAt);
  await evaluator(config, {
    energy: { battery: {
      remaining_percent: { value: scenario === "full" ? 100 : 10 },
      instant_power: { value: 0 }, operation_mode: { value: "auto" },
    }, solar: { instant_power: { value: 0 } } },
    meter: {
      branch_demand_power: { value: 500 },
      grid_import_power: { value: scenario === "high-demand" ? 5000 : 500 },
      grid_export_power: { value: 0 },
    },
  }, [guard], evaluationAt);
  if (scenario === "due") {
    assert.equal(state.plan?.available, true, state.plan?.reason ?? "fresh plan unavailable");
    assert.equal(starts.length, 1, JSON.stringify(state.lastResult));
    assert.ok(Number(starts[0].targetWh) > 10, "the latest plan replaces the old 10 Wh remainder");
    assert.equal(state.owner, "adaptiveCharging");
  } else {
    assert.equal(starts.length, 0, `${scenario} must not resume charging`);
  }
}
