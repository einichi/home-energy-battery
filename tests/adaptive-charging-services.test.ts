import assert from "node:assert/strict";

import { cleanConfig } from "../lib/domain/configuration.js";
import { cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { adaptiveChargingPlanRefreshDecision, adaptiveChargingScheduledEvent } from "../lib/domain/adaptive-control.js";
import { cleanAutomationRule } from "../lib/domain/automation-rules.js";
import { cleanOperationalOverridesState } from "../lib/domain/operational-overrides.js";
import { createAdaptiveChargingEvaluator } from "../lib/services/adaptive-charging-evaluator.js";
import { createBatteryStrategyService } from "../lib/services/battery-strategy-service.js";
import type { BatterySchedule } from "../lib/contracts/schedules.js";

const now = new Date(2026, 6, 11, 23, 15, 0, 0);
const windowEnd = new Date(2026, 6, 12, 1, 0, 0, 0);
const slotStart = new Date(2026, 6, 12, 0, 30, 0, 0);
const forecastFetchedAt = new Date(now.getTime() - 60_000).toISOString();
const config = cleanConfig({
  solarEnabled: true,
  smartCosmoEnabled: true,
  rateMode: "multi",
  standardRateYenPerKwh: 40,
  rateBands: [
    { start: "23:00", end: "01:00", yenPerKwh: 15, label: "Night" },
    { start: "01:00", end: "23:00", yenPerKwh: 40, label: "Standard" },
  ],
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 2_000 },
  adaptiveCharging: {
    enabled: true,
    latitude: 35,
    longitude: 139,
    arrayPeakKw: 5,
  },
});
const guardRule = cleanAutomationRule({
  id: "guard",
  name: "Charging Demand Guard",
  type: "backup-demand-guard",
  enabled: true,
  conditions: { breakerVoltage: 100, breakerAmps: 60, reserveAmps: 5 },
});
const plan = {
  available: true,
  createdAt: now.toISOString(),
  forecastFetchedAt,
  chargePerformance: { effectiveWatts: 2_000 },
  slots: [{
    start: slotStart.toISOString(),
    end: windowEnd.toISOString(),
    windowStart: new Date(2026, 6, 11, 23, 0, 0, 0).toISOString(),
    windowEnd: windowEnd.toISOString(),
    label: "Night",
    yenPerKwh: 15,
    targetWh: 1_000,
    targetSocPercent: 90,
  }],
};
const state = cleanAdaptiveChargingState({
  forecast: { fetchedAt: forecastFetchedAt },
  plan,
  lastPlanEventKey: adaptiveChargingScheduledEvent(config, now).eventKey,
  lastAwayStateKey: "home",
});
const actions: Array<{ action: string; payload: Record<string, unknown> }> = [];
let chargeStartError: Error | null = null;
const evaluator = createAdaptiveChargingEvaluator({
  readState: async () => state,
  writeState: async (next) => next,
  history: { awayPeriods: () => [], historicalWeather: () => [] },
  readOperationalOverrides: async () => cleanOperationalOverridesState(),
  executeAction: async (action, payload) => {
    actions.push({ action, payload });
    return { ok: true };
  },
  releaseCharge: async () => false,
  suspendInStandby: async () => false,
  startCharge: async () => {
    if (chargeStartError) throw chargeStartError;
    return { ok: true };
  },
  recoverIdle: async () => false,
  readHistory: async () => [],
  refreshBatteryLearning: async () => state.batteryLearning,
  readDemandProfileDays: async () => [],
  solarForecastAccuracy: () => ({}) as never,
  recordFuelCellPlanForecast: () => 0,
  breakerWaitLogMs: 60_000,
});
const status = {
  energy: {
    battery: {
      remaining_percent: { value: 70 },
      instant_power: { value: -500 },
      operation_mode: { value: "auto" },
    },
    solar: { instant_power: { value: 0 } },
  },
  meter: {
    house_demand_power: { value: 500 },
    grid_import_power: { value: 20 },
    grid_export_power: { value: 0 },
  },
};

await evaluator(config, status, [guardRule], now);
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "standby" } }]);
assert.equal(state.standbyHoldUntil, windowEnd.toISOString());
assert.equal(state.lastResult?.skipped, "holding standby until planned discounted charging is due");
state.pendingPlanReason = null;
state.pendingPlanRequestId = null;
state.pendingPlanRequestedAt = null;

actions.length = 0;
status.energy.battery.instant_power.value = 0;
status.energy.battery.operation_mode.value = "standby";
await evaluator(config, status, [guardRule], new Date(now.getTime() + 5_000));
assert.deepEqual(actions, [], "an established discounted-window Standby hold should not issue repeated commands");

actions.length = 0;
status.energy.battery.instant_power.value = -200;
status.energy.battery.operation_mode.value = "auto";
await evaluator(config, status, [guardRule], new Date(now.getTime() + 10_000));
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "standby" } }], "a broken Standby hold should be reasserted when discharge is observed");

actions.length = 0;
state.standbyHoldUntil = null;
state.forecast!.fetchedAt = new Date(now.getTime() - 7 * 60 * 60_000).toISOString();
status.energy.battery.instant_power.value = -300;
status.energy.battery.operation_mode.value = "auto";
await evaluator(config, status, [guardRule], new Date(now.getTime() + 15_000));
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "standby" } }], "a stale forecast must not allow discounted-window discharge");
assert.equal(state.standbyHoldUntil, windowEnd.toISOString());

actions.length = 0;
chargeStartError = new Error("simulated charge failure");
state.standbyHoldUntil = null;
state.plan = plan;
state.pendingPlanReason = null;
state.pendingPlanRequestId = null;
state.pendingPlanRequestedAt = null;
state.forecast!.fetchedAt = forecastFetchedAt;
state.lastPlanEventKey = String(adaptiveChargingScheduledEvent(config, slotStart).eventKey);
status.energy.battery.instant_power.value = -250;
status.energy.battery.operation_mode.value = "auto";
await assert.rejects(evaluator(config, status, [guardRule], slotStart), /simulated charge failure/);
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "standby" } }], "a failed charge start must fall back to Standby for the discounted window");
assert.equal(state.standbyHoldUntil, windowEnd.toISOString());

actions.length = 0;
chargeStartError = null;
state.standbyHoldUntil = null;
state.pendingPlanReason = null;
state.pendingPlanRequestId = null;
state.pendingPlanRequestedAt = null;
state.activeWindowExecution = null;
state.plan = {
  ...plan,
  timeline: [{
    start: now.toISOString(),
    end: windowEnd.toISOString(),
    solarW: 1_200,
    fuelCellP20W: 0,
    demandW: 500,
  }],
};
state.lastPlanEventKey = String(adaptiveChargingScheduledEvent(config, now).eventKey);
const solarRefresh = adaptiveChargingPlanRefreshDecision(state, config, now);
state.lastPlanEventKey = String(solarRefresh.eventKey);
status.energy.battery.remaining_percent.value = 70;
status.energy.battery.instant_power.value = -300;
status.energy.battery.operation_mode.value = "auto";
await evaluator(config, status, [guardRule], now);
assert.deepEqual(actions, [], "a solar-capable window should remain in Auto before its planned charge");
assert.equal(state.lastResult?.skipped, "observing solar-capable window before planned charging");

actions.length = 0;
state.standbyHoldUntil = windowEnd.toISOString();
status.energy.battery.remaining_percent.value = 69;
status.energy.battery.instant_power.value = 0;
status.energy.battery.operation_mode.value = "standby";
await evaluator(config, status, [guardRule], new Date(now.getTime() + 30_000));
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "auto" } }], "a solar-capable window should release an obsolete Standby hold");
assert.equal(state.standbyHoldUntil, null);

actions.length = 0;
state.pendingPlanReason = null;
state.pendingPlanRequestId = null;
state.pendingPlanRequestedAt = null;
state.lastPlanEventKey = String(solarRefresh.eventKey);
status.energy.battery.remaining_percent.value = 68;
status.energy.battery.instant_power.value = -300;
status.energy.battery.operation_mode.value = "auto";
await evaluator(config, status, [guardRule], new Date(now.getTime() + 60_000));
assert.deepEqual(actions, [{ action: "set-mode", payload: { mode: "standby" } }], "a two-point SOC drop should exhaust the solar-window discharge budget");
assert.equal(state.lastResult?.skipped, "solar-window discharge budget reached; holding standby until planned charging is due");

const schedule: BatterySchedule = {
  id: "legacy-schedule",
  name: "set-mode",
  action: "set-mode",
  payload: { mode: "auto" },
  enabled: true,
  repeat: "daily",
  time: "23:30",
  days: [0, 1, 2, 3, 4, 5, 6],
};
let strategyConfig = config;
const strategyView = createBatteryStrategyService({
  readConfig: async () => strategyConfig,
  readAdaptiveChargingState: async () => state,
  readOperationalOverridesState: async () => cleanOperationalOverridesState(),
  readAutomationRules: async () => [guardRule],
  readSchedules: async () => [schedule],
  readCommandReceipts: () => [],
  historyReady: () => false,
  awayPeriodsView: () => ({ active: null, next: null, state: "home" }),
});

const adaptiveStrategy = await strategyView(now);
assert.equal(adaptiveStrategy.kind, "adaptive-charging");
assert.equal(adaptiveStrategy.nextSchedule, null, "disabled legacy schedules must not appear while Adaptive Charging is active");

strategyConfig = cleanConfig({ ...config, adaptiveCharging: { ...config.adaptiveCharging, enabled: false } });
const scheduledStrategy = await strategyView(now);
assert.equal(scheduledStrategy.nextSchedule?.id, schedule.id, "the next schedule should return when Adaptive Charging is disabled");

console.log("adaptive charging service tests passed");
