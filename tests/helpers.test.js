import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createNotificationService,
  normalizeNotificationConfig,
  smtpTransportOptions,
  validateSmtpSettings,
} from "../lib/notifications.js";
import {
  activePlannerSlotStopReason,
  advancePlannerBreakerRecovery,
  applyInterruptedChargeCap,
  aggregateEnergyReportSamples,
  beginPlannerBreakerRecovery,
  capPlannerSlotToRemainingTime,
  clearStaleScheduleRuns,
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  cleanConfig,
  cleanPlannerChargingPerformance,
  cleanSolarPlannerState,
  consumeCompletedPlannerSlot,
  countGuardTriggersForRange,
  discountedBandOccurrence,
  discountedBandOccurrences,
  discountedPlanStatus,
  effectivePlannerChargeWatts,
  executePlannerChargeStart,
  enforcePlannerSlotEndDeadline,
  evaluateAutomationRule,
  estimateEffectiveBatteryCapacity,
  forecastHourForInterval,
  forecastIsFresh,
  finalizePlannerChargeSession,
  finalizePlannerWindowExecution,
  learnedSolarFactor,
  logPlannerInitialHeadroomWait,
  logPlannerBreakerWait,
  normalizeCircuitLabels,
  normalizeDashboardWidgets,
  normalizeRateBands,
  normalizeSubnets,
  nextPlanningBoundary,
  optimizeDiscountedChargeSlots,
  parseJsonWithContext,
  parseOpenMeteoForecast,
  planChronologicalDiscountedCharging,
  plannerLiveChargeHeadroom,
  plannerLiveImportSafety,
  plannerBreakerSettings,
  plannerBreakerRecoveryReady,
  plannerSlotEndDelayMs,
  plannerSlotEndKey,
  preserveInterruptedPlannerCharge,
  recordPlannerWindowInterruption,
  plannerTimezoneError,
  rateForTimestamp,
  readRecentHistorySamples,
  recoverConcatenatedJsonValue,
  sampleFromStatus,
  shouldTriggerDemandGuard,
  shouldHoldGuardStandbyForPlanner,
  solarPlanRefreshDecision,
  solarPlanLogMessage,
  solarPlannerAvailability,
  solarPlannerBaseAvailability,
  solarPowerFromIrradiance,
  predictHouseDemand,
  summarizeSamples,
  suspendPlannerChargeInStandby,
  syncPlannerWindowExecution,
} from "../server.js";

const staleSchedules = [
  { id: "stale", running: true, runningSince: "2026-06-15T02:59:01.000Z" },
  { id: "active", running: true, runningSince: "2026-06-20T02:59:01.000Z" },
];
assert.equal(clearStaleScheduleRuns(staleSchedules, new Set(["active"])), true);
assert.equal(staleSchedules[0].running, false);
assert.equal(staleSchedules[0].runningSince, null);
assert.equal(staleSchedules[1].running, true);

const migrated = cleanConfig({
  standardRateYenPerKwh: 36,
  offPeakRateYenPerKwh: 18,
  offPeakSavingsEnabled: true,
  settingCache: {
    discharge_limit: {
      lastKnown: { decoded: { percent: 30 } },
      lastReadAt: "2026-05-31T00:00:00.000Z",
    },
  },
});
assert.equal(migrated.rateMode, "offPeak");
assert.equal(migrated.rateBands.length, 2);
assert.equal(migrated.offPeakSavingsEnabled, true);
assert.equal(Math.max(...migrated.rateBands.map((band) => band.yenPerKwh)), 36);
assert.equal(migrated.settingCache.discharge_limit.lastKnown.decoded.percent, 30);

const simple = cleanConfig({ standardRateYenPerKwh: 42 });
assert.equal(simple.rateMode, "simple");
assert.equal(simple.offPeakSavingsEnabled, false);
assert.equal(simple.rateBands.length, 1);
assert.equal(simple.retention.rawTelemetryDays, 1095);
assert.equal(simple.retention.intervalAggregatesDays, null);
assert.equal(simple.retention.dailyAggregatesDays, null);
assert.equal(simple.retention.plannerHistoryDays, null);
assert.equal(simple.retention.automationEventDays, null);
assert.equal(simple.retention.notificationDeliveryDays, 365);
assert.equal(simple.retention.automaticMaintenance, true);
assert.equal(cleanConfig({ historyRetentionDays: 730 }).retention.rawTelemetryDays, 730);
assert.equal(cleanConfig({
  retention: {
    rawTelemetryDays: 365,
    intervalAggregatesDays: null,
    notificationDeliveryDays: 90,
    automaticMaintenance: false,
  },
}).retention.rawTelemetryDays, 365);
assert.equal(cleanConfig({
  retention: {
    rawTelemetryDays: 365,
    intervalAggregatesDays: null,
    notificationDeliveryDays: 90,
    automaticMaintenance: false,
  },
}).retention.intervalAggregatesDays, null);
assert.equal(cleanConfig({
  retention: {
    rawTelemetryDays: 365,
    intervalAggregatesDays: null,
    notificationDeliveryDays: 90,
    automaticMaintenance: false,
  },
}).retention.automaticMaintenance, false);
assert.equal(simple.updateIntervalSeconds, 15);
assert.equal(simple.co2TonnesPerKwh, 0.000423);
assert.equal(simple.smartCosmoEnabled, true);
assert.deepEqual(simple.circuitLabels, {});
assert.equal(simple.circuitSortMode, "number");
assert.equal(rateForTimestamp(simple.rateBands, "2026-05-31T23:30:00+09:00").yenPerKwh, 42);
assert.equal(simple.dashboardWidgets.length, 19);
assert.equal(simple.dashboardWidgets[0].id, "solarPower");
assert.deepEqual(simple.batteryCapabilities, { usableCapacityKwh: null, maximumChargeWatts: null });
assert.equal(simple.solarPlanner.enabled, false);
assert.equal(simple.solarPlanner.systemLossPercent, 14);
assert.equal(simple.solarPlanner.targetSocPercent, 100);
assert.equal(simple.solarPlanner.forecastMarginPercent, 10);
assert.equal(Object.prototype.hasOwnProperty.call(cleanConfig({
  automation: { breakerVoltage: 100, breakerAmps: 60, reserveAmps: 5 },
}), "automation"), false);
assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2200 } }).batteryCapabilities.maximumChargeWatts, 2200);
assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2224 } }).batteryCapabilities.maximumChargeWatts, 2200);
assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2225 } }).batteryCapabilities.maximumChargeWatts, 2250);

assert.equal(solarPowerFromIrradiance(500, {
  solarPlanner: { arrayPeakKw: 5, systemLossPercent: 14 },
}), 2150);
assert.equal(solarPowerFromIrradiance(2000, {
  solarPlanner: { arrayPeakKw: 5, systemLossPercent: 14 },
}), 5000);
assert.equal(forecastIsFresh({ fetchedAt: "2026-07-11T00:00:00.000Z" }, new Date("2026-07-11T05:59:00.000Z")), true);
assert.equal(forecastIsFresh({ fetchedAt: "2026-07-11T00:00:00.000Z" }, new Date("2026-07-11T06:01:00.000Z")), false);
const parsedForecast = parseOpenMeteoForecast({
  timezone: "Asia/Tokyo",
  utc_offset_seconds: 32400,
  hourly: {
    time: ["2026-07-11T12:00"],
    shortwave_radiation: [800],
    global_tilted_irradiance: [900],
    cloud_cover: [20],
    temperature_2m: [31],
  },
  daily: { time: ["2026-07-11"], sunrise: ["2026-07-11T04:35"], sunset: ["2026-07-11T18:58"] },
}, new Date("2026-07-11T00:00:00.000Z"));
assert.equal(parsedForecast.hours[0].tiltedIrradianceWm2, 900);
assert.equal(parsedForecast.days[0].sunset, "2026-07-11T18:58");
const precedingHourForecast = {
  hours: [
    { timestamp: "2026-07-11T10:00:00.000Z", tiltedIrradianceWm2: 100 },
    { timestamp: "2026-07-11T11:00:00.000Z", tiltedIrradianceWm2: 500 },
  ],
};
assert.equal(forecastHourForInterval(
  precedingHourForecast,
  "2026-07-11T10:15:00.000Z",
  "2026-07-11T10:45:00.000Z",
).tiltedIrradianceWm2, 500);
const partialIntervalStart = new Date(2026, 6, 11, 11, 5, 30);
assert.equal(
  nextPlanningBoundary(partialIntervalStart, new Date(2026, 6, 11, 12, 0)),
  new Date(2026, 6, 11, 11, 30).getTime(),
);
assert.equal(
  nextPlanningBoundary(new Date(2026, 6, 11, 11, 30), new Date(2026, 6, 11, 12, 0)),
  new Date(2026, 6, 11, 12, 0).getTime(),
);
const originalTimezone = process.env.TZ;
process.env.TZ = "Asia/Tokyo";
assert.equal(plannerTimezoneError(parsedForecast), null);
process.env.TZ = "UTC";
assert.match(plannerTimezoneError(parsedForecast), /does not match/);
if (originalTimezone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimezone;

const plannerConfig = cleanConfig({
  solarEnabled: true,
  smartCosmoEnabled: true,
  rateMode: "multi",
  standardRateYenPerKwh: 40,
  rateBands: [
    { start: "23:00", end: "01:00", yenPerKwh: 15, label: "Cheapest" },
    { start: "01:00", end: "03:00", yenPerKwh: 20, label: "Night" },
  ],
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 2000 },
  solarPlanner: { enabled: true, latitude: -33.8, longitude: -151.2, arrayPeakKw: 5 },
});
assert.equal(solarPlannerBaseAvailability(plannerConfig).available, true);
assert.equal(solarPlannerBaseAvailability(cleanConfig({ ...plannerConfig, rateMode: "simple" })).available, false);
const overnightOccurrence = discountedBandOccurrence(plannerConfig, new Date(2026, 6, 11, 23, 30));
assert.equal(new Date(overnightOccurrence.start).getHours(), 23);
assert.equal(new Date(overnightOccurrence.end).getDate(), new Date(2026, 6, 12).getDate());
assert.equal(new Date(overnightOccurrence.end).getHours(), 1);
const rebaseNow = new Date(2026, 6, 11, 23, 30);
const waitingPlannerState = {
  owner: null,
  forecast: { fetchedAt: "2026-07-11T10:00:00.000Z" },
  plan: { createdAt: rebaseNow.toISOString(), currentSocPercent: 30, forecastFetchedAt: "2026-07-11T10:00:00.000Z" },
  lastPlanEventKey: null,
};
const entryRefresh = solarPlanRefreshDecision(waitingPlannerState, plannerConfig, rebaseNow);
assert.equal(entryRefresh.refresh, true);
assert.match(entryRefresh.trigger, /30-minute slot boundary/);
const rebasedPlannerState = { ...waitingPlannerState, lastPlanEventKey: entryRefresh.eventKey };
assert.equal(solarPlanRefreshDecision(rebasedPlannerState, plannerConfig, rebaseNow).refresh, false);
assert.equal(solarPlanRefreshDecision(rebasedPlannerState, plannerConfig, new Date(2026, 6, 12, 0, 0)).refresh, true);
const prewindowNow = new Date(2026, 6, 11, 22, 30);
const prewindowRefresh = solarPlanRefreshDecision(waitingPlannerState, plannerConfig, prewindowNow);
assert.equal(prewindowRefresh.refresh, true);
assert.match(prewindowRefresh.trigger, /30 minutes before Cheapest/);
assert.equal(solarPlanRefreshDecision({
  ...waitingPlannerState,
  lastPlanEventKey: prewindowRefresh.eventKey,
}, plannerConfig, new Date(2026, 6, 11, 22, 45)).refresh, false);
const windowEntryRefresh = solarPlanRefreshDecision(waitingPlannerState, plannerConfig, new Date(2026, 6, 11, 23, 0));
assert.equal(windowEntryRefresh.refresh, true);
assert.match(windowEntryRefresh.trigger, /entering Cheapest/);
const forecastRefresh = solarPlanRefreshDecision({
  ...waitingPlannerState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
}, plannerConfig, new Date(2026, 6, 11, 12, 0));
assert.equal(forecastRefresh.refresh, true);
assert.equal(forecastRefresh.trigger, "forecast refresh");
const activeForecastRefresh = solarPlanRefreshDecision({
  ...waitingPlannerState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
}, plannerConfig, rebaseNow);
assert.equal(activeForecastRefresh.trigger, "forecast refresh");
assert.equal(solarPlanRefreshDecision({
  ...waitingPlannerState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
  plan: { ...waitingPlannerState.plan, forecastFetchedAt: "2026-07-11T11:00:00.000Z" },
  lastPlanEventKey: activeForecastRefresh.eventKey,
}, plannerConfig, rebaseNow).refresh, false);
const initialRefresh = solarPlanRefreshDecision({
  forecast: waitingPlannerState.forecast,
  plan: null,
  pendingPlanReason: "configuration changed",
}, plannerConfig, new Date(2026, 6, 11, 12, 0));
assert.equal(initialRefresh.trigger, "configuration changed");
const recalculationLog = solarPlanLogMessage({
  available: true,
  predictedSolarKwh: 5.65,
  predictedDemandKwh: 17.64,
  plannedChargeKwh: 1.97,
  warning: "test warning",
  windows: [{ label: "Cheapest", targetSocPercent: 52, plannedChargeKwh: 1.97 }],
  slots: [{ start: "2026-07-11T04:03:42.000Z", end: "2026-07-11T05:00:00.000Z", targetWh: 1970 }],
}, "entering Cheapest", 10);
assert.match(recalculationLog, /Plan recalculated \(entering Cheapest\)/);
assert.match(recalculationLog, /targets \[Cheapest 52%\/1\.97 kWh\]/);
assert.match(recalculationLog, /slots \[.*1970 Wh\]/);
assert.match(recalculationLog, /test warning/);
assert.equal(solarPlanRefreshDecision({
  ...waitingPlannerState,
  plan: { ...waitingPlannerState.plan, createdAt: "2026-07-01T00:00:00.000Z" },
}, plannerConfig, new Date(2026, 6, 11, 12, 0)).refresh, false);
assert.ok(discountedBandOccurrences(plannerConfig, prewindowNow).length >= 2);

const learnedChargingPerformance = cleanPlannerChargingPerformance({
  samples: Array.from({ length: 10 }, (_, index) => ({
    at: new Date(2026, 6, 11, 1, index).toISOString(),
    batteryChargingW: 2000 - index * 50,
    houseDemandW: index * 500,
    gridImportW: 2500 + index * 450,
  })),
  sessions: [{
    startedAt: new Date(2026, 6, 10, 1, 0).toISOString(),
    endedAt: new Date(2026, 6, 10, 2, 0).toISOString(),
    requestedWh: 2000,
    deliveredWh: 1900,
    startSocPercent: 20,
    endSocPercent: 39,
    socDeltaPercent: 19,
    averageChargeWatts: 1900,
    estimatedStorageEfficiencyPercent: 100,
  }],
});
assert.equal(learnedChargingPerformance.sampleCount, 10);
assert.equal(learnedChargingPerformance.learnedChargeWatts, 1950);
assert.ok(Math.abs(learnedChargingPerformance.demandImpactWattsPerKw + 100) < 0.001);
assert.equal(effectivePlannerChargeWatts(plannerConfig, {
  chargingPerformance: learnedChargingPerformance,
}).effectiveWatts, 1950);

const completedChargeState = {
  activeChargedKwh: 1,
  activeChargeSession: {
    startedAt: "2026-07-11T00:00:00.000Z",
    requestedWh: 1000,
    startSocPercent: 20,
    latestSocPercent: 30,
    capacityKwh: 10,
  },
  chargingPerformance: cleanPlannerChargingPerformance(),
};
const completedChargeSession = finalizePlannerChargeSession(
  completedChargeState,
  "Planned charge target reached",
  new Date("2026-07-11T01:00:00.000Z"),
);
assert.equal(completedChargeSession.deliveredWh, 1000);
assert.equal(completedChargeSession.averageChargeWatts, 1000);
assert.equal(completedChargeSession.estimatedStorageEfficiencyPercent, 100);
assert.equal(completedChargeState.chargingPerformance.sessionCount, 1);
assert.equal(completedChargeState.activeChargeSession, null);
const executionOccurrence = {
  start: "2026-07-11T11:00:00.000Z",
  end: "2026-07-11T13:00:00.000Z",
  band: { label: "Day discount", yenPerKwh: 12.6 },
};
const executionState = {
  owner: null,
  activeChargedKwh: 0,
  chargingPerformance: cleanPlannerChargingPerformance(),
  windowSummaries: [],
};
syncPlannerWindowExecution(executionState, executionOccurrence, {
  slots: [{
    start: "2026-07-11T12:30:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 1000,
  }],
}, 20, new Date("2026-07-11T11:00:00.000Z"));
executionState.owner = "planner";
executionState.activeChargedKwh = 0.2;
syncPlannerWindowExecution(executionState, executionOccurrence, {
  slots: [{
    start: "2026-07-11T12:30:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 1000,
  }],
}, 24, new Date("2026-07-11T12:10:00.000Z"));
assert.equal(executionState.activeWindowExecution.plannedWh, 1000);
executionState.owner = null;
executionState.activeChargeSession = {
  startedAt: "2026-07-11T12:00:00.000Z",
  requestedWh: 1000,
  startSocPercent: 20,
  latestSocPercent: 30,
  capacityKwh: 5,
};
executionState.activeChargedKwh = 0.6;
finalizePlannerChargeSession(executionState, "breaker interruption", new Date("2026-07-11T12:20:00.000Z"));
recordPlannerWindowInterruption(executionState);
syncPlannerWindowExecution(executionState, executionOccurrence, {
  slots: [{
    start: "2026-07-11T12:40:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 400,
  }],
}, 30, new Date("2026-07-11T12:30:00.000Z"));
const executionSummary = finalizePlannerWindowExecution(
  executionState,
  31,
  new Date("2026-07-11T13:00:00.000Z"),
);
assert.equal(executionSummary.plannedWh, 1000);
assert.equal(executionSummary.deliveredWh, 600);
assert.equal(executionSummary.unmetWh, 400);
assert.equal(executionSummary.interruptionCount, 1);
assert.equal(executionSummary.startSocPercent, 20);
assert.equal(executionSummary.endSocPercent, 31);
assert.equal(executionState.windowSummaries.length, 1);
assert.equal(executionState.activeWindowExecution, null);
const persistedPlannerExecution = cleanSolarPlannerState({
  breakerRecovery: {
    interruptedAt: "2026-07-11T00:00:00.000Z",
    cooldownUntil: "2026-07-11T00:03:00.000Z",
    consecutiveSafeChecks: 1,
  },
  windowSummaries: executionState.windowSummaries,
});
assert.equal(persistedPlannerExecution.breakerRecovery.consecutiveSafeChecks, 1);
assert.equal(persistedPlannerExecution.windowSummaries[0].unmetWh, 400);
const optimizedSlots = optimizeDiscountedChargeSlots({
  config: plannerConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 3, 0),
  requiredKwh: 4.5,
});
assert.equal(optimizedSlots.plannedChargeKwh, 4.5);
assert.equal(optimizedSlots.unmetChargeKwh, 0);
assert.equal(optimizedSlots.slots[0].yenPerKwh, 15);
assert.equal(optimizedSlots.slots.at(-1).yenPerKwh, 20);
assert.equal(optimizedSlots.slots.filter((slot) => slot.yenPerKwh === 15).at(-1).end, new Date(2026, 6, 12, 1, 0).toISOString());
const smallCharge = optimizeDiscountedChargeSlots({
  config: plannerConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 3, 0),
  requiredKwh: 0.5,
});
assert.equal(smallCharge.slots.length, 1);
assert.equal(smallCharge.slots[0].start, new Date(2026, 6, 12, 0, 45).toISOString());
assert.equal(smallCharge.slots[0].end, new Date(2026, 6, 12, 1, 0).toISOString());
const standardOnly = optimizeDiscountedChargeSlots({
  config: plannerConfig,
  start: new Date(2026, 6, 11, 12, 0),
  end: new Date(2026, 6, 11, 18, 0),
  requiredKwh: 2,
});
assert.equal(standardOnly.slots.length, 0);
assert.equal(standardOnly.unmetChargeKwh, 2);
const forecastDemandDoesNotRemoveSlots = optimizeDiscountedChargeSlots({
  config: plannerConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 1, 0),
  requiredKwh: 1,
  demandBySlot: new Map([[new Date(2026, 6, 11, 23, 0).getTime(), 99_000]]),
});
assert.equal(forecastDemandDoesNotRemoveSlots.plannedChargeKwh, 1);
assert.equal(forecastDemandDoesNotRemoveSlots.unmetChargeKwh, 0);

const plannerGuardRules = [{
  id: "guard-60a",
  name: "Charging Demand Guard",
  type: "backup-demand-guard",
  enabled: true,
  conditions: { breakerVoltage: 100, breakerAmps: 60, reserveAmps: 5 },
}];
const livePlannerHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3000 } },
}, plannerConfig, {}, plannerGuardRules);
assert.equal(livePlannerHeadroom.available, true);
assert.equal(livePlannerHeadroom.gridImportW, 3000);
assert.equal(plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 4000 } },
}, plannerConfig, {}, plannerGuardRules).available, false);
assert.equal(plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: null } },
}, plannerConfig, {}, plannerGuardRules).available, false);
const learnedHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3300 } },
}, plannerConfig, { chargingPerformance: learnedChargingPerformance }, plannerGuardRules);
assert.equal(learnedHeadroom.chargeWatts, 1950);
assert.equal(learnedHeadroom.thresholdW, 3350);
assert.equal(learnedHeadroom.available, true);
const enabledGuardRules = [{
  id: "guard-50a",
  name: "Charging Demand Guard",
  type: "backup-demand-guard",
  enabled: true,
  conditions: {
    breakerVoltage: 100,
    breakerAmps: 50,
    reserveAmps: 2,
  },
}];
assert.deepEqual(plannerBreakerSettings(enabledGuardRules), {
  breakerVoltage: 100,
  breakerAmps: 50,
  reserveAmps: 2,
  breakerLimitW: 4800,
  ruleId: "guard-50a",
  ruleName: "Charging Demand Guard",
  source: "automation-rule",
  valid: true,
});
assert.equal(plannerBreakerSettings([{
  ...enabledGuardRules[0],
  enabled: false,
}]).breakerLimitW, 4800);
assert.equal(plannerBreakerSettings([]).valid, false);
assert.equal(Number.isNaN(plannerBreakerSettings([]).breakerLimitW), true);
assert.deepEqual(solarPlannerAvailability(plannerConfig, []), {
  available: false,
  reason: "Charging Demand Guard settings are unavailable",
});
assert.equal(solarPlannerAvailability(plannerConfig, enabledGuardRules).available, true);
const missingGuardHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 0 } },
}, plannerConfig);
assert.equal(missingGuardHeadroom.available, false);
assert.equal(Number.isNaN(missingGuardHeadroom.thresholdW), true);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: 0 } },
}).available, false);
const guardRuleHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2380 } },
}, plannerConfig, {}, enabledGuardRules);
assert.equal(guardRuleHeadroom.breakerLimitW, 4800);
assert.equal(guardRuleHeadroom.thresholdW, 2600);
assert.equal(guardRuleHeadroom.available, true);
assert.equal(plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2700 } },
}, plannerConfig, {}, enabledGuardRules).available, false);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: 4799 } },
}, enabledGuardRules).available, true);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: 4800 } },
}, enabledGuardRules).available, false);
const initialWaitState = { log: [] };
const unavailableGuardHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2700 } },
}, plannerConfig, {}, enabledGuardRules);
assert.equal(logPlannerInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:00:00.000Z"),
), true);
assert.match(initialWaitState.log[0].message, /Grid Import \(2700 W\)/);
assert.match(initialWaitState.log[0].message, /50 A - 2 A reserve at 100 V/);
assert.match(initialWaitState.log[0].message, /Guard limit \(4800 W\)/);
assert.match(initialWaitState.log[0].message, /required at or below \(2600 W\)/);
assert.equal(logPlannerInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:01:00.000Z"),
), false);
assert.equal(logPlannerInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:05:00.000Z"),
), true);
const recoveryState = {};
beginPlannerBreakerRecovery(
  recoveryState,
  plannerLiveChargeHeadroom({ meter: { grid_import_power: { value: 4000 } } }, plannerConfig, {}, plannerGuardRules),
  new Date("2026-07-11T00:00:00.000Z"),
);
const safeRecoveryHeadroom = plannerLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3000 } },
}, plannerConfig, {}, plannerGuardRules);
const recoveryCheck1 = advancePlannerBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:00:30.000Z"),
);
assert.equal(recoveryCheck1.consecutiveSafeChecks, 1);
assert.equal(recoveryCheck1.ready, false);
recoveryState.log = [];
assert.equal(logPlannerBreakerWait(
  recoveryState,
  safeRecoveryHeadroom,
  recoveryCheck1,
  new Date("2026-07-11T00:00:30.000Z"),
), true);
assert.match(recoveryState.log[0].message, /Grid Import \(3000 W\)/);
assert.match(recoveryState.log[0].message, /required at or below \(3300 W\)/);
assert.match(recoveryState.log[0].message, /Guard limit \(5500 W\)/);
assert.match(recoveryState.log[0].message, /safe checks \(1\/3\)/);
recoveryState.breakerRecovery.lastWaitLogAt = "2026-07-11T00:00:30.000Z";
const recoveryCheck2 = advancePlannerBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:01:00.000Z"),
);
const recoveryCheck3 = advancePlannerBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:01:30.000Z"),
);
assert.equal(recoveryCheck2.shouldLog, false);
assert.equal(recoveryCheck3.consecutiveSafeChecks, 3);
assert.equal(recoveryCheck3.checksReady, true);
assert.equal(recoveryCheck3.cooldownReady, false);
const recoveryReady = advancePlannerBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:03:00.000Z"),
);
assert.equal(recoveryReady.ready, true);
const unsafeRecovery = advancePlannerBreakerRecovery(
  recoveryState,
  plannerLiveChargeHeadroom({ meter: { grid_import_power: { value: 4000 } } }, plannerConfig, {}, plannerGuardRules),
  new Date("2026-07-11T00:03:30.000Z"),
);
assert.equal(unsafeRecovery.consecutiveSafeChecks, 0);
assert.equal(unsafeRecovery.ready, false);
assert.equal(advancePlannerBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:06:00.000Z"),
).shouldLog, true);
recoveryState.breakerRecovery.consecutiveSafeChecks = 3;
recoveryState.breakerRecovery.cooldownUntil = "2026-07-11T00:05:00.000Z";
assert.equal(plannerBreakerRecoveryReady(recoveryState, new Date("2026-07-11T00:06:00.000Z")), true);
assert.equal(shouldHoldGuardStandbyForPlanner({
  ...recoveryState,
  interruptedCharge: { slotEnd: "2026-07-11T00:30:00.000Z" },
}, new Date("2026-07-11T00:06:00.000Z")), false);
recoveryState.breakerRecovery.consecutiveSafeChecks = 2;
assert.equal(shouldHoldGuardStandbyForPlanner({
  ...recoveryState,
  interruptedCharge: { slotEnd: "2026-07-11T00:30:00.000Z" },
}, new Date("2026-07-11T00:06:00.000Z")), true);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: 5400 } },
}, plannerGuardRules).available, true);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: 5500 } },
}, plannerGuardRules).available, false);
assert.equal(plannerLiveImportSafety({
  meter: { grid_import_power: { value: null } },
}, plannerGuardRules).available, false);
assert.equal(shouldTriggerDemandGuard({
  operationMode: "charging",
  batteryChargingW: 2000,
  guardDemandW: 5600,
  breakerLimitW: 5500,
}), true);
assert.equal(shouldTriggerDemandGuard({
  operationMode: "standby",
  batteryChargingW: 2000,
  guardDemandW: 5600,
  breakerLimitW: 5500,
}), false);

const activePlannerNow = new Date(2026, 6, 11, 23, 30);
const activePlannerSlot = {
  start: new Date(2026, 6, 11, 23, 0).toISOString(),
  end: new Date(2026, 6, 12, 0, 0).toISOString(),
  targetWh: 1000,
  targetSocPercent: 100,
};
assert.equal(activePlannerSlotStopReason({
  owner: "planner",
  activeSlot: activePlannerSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, plannerConfig, {
  createdAt: "new-plan",
  slots: [{ ...activePlannerSlot, targetWh: 800 }],
}, activePlannerNow), null);
assert.match(activePlannerSlotStopReason({
  owner: "planner",
  activeSlot: activePlannerSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, plannerConfig, {
  createdAt: "new-plan",
  slots: [{ ...activePlannerSlot, targetWh: 600 }],
}, activePlannerNow), /remaining charge target/);
assert.match(activePlannerSlotStopReason({
  owner: "planner",
  activeSlot: activePlannerSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, plannerConfig, {
  createdAt: "new-plan",
  slots: [],
}, activePlannerNow), /no longer includes/);

const interruptedSlot = {
  start: "2026-07-11T12:00:00.000Z",
  end: "2026-07-11T12:30:00.000Z",
  windowEnd: "2026-07-11T13:00:00.000Z",
  targetWh: 1050,
};
const interruptedState = {
  activeSlot: interruptedSlot,
  activeChargedKwh: 0.3,
  plan: { slots: [interruptedSlot] },
};
const firstInterruption = preserveInterruptedPlannerCharge(
  interruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);
assert.equal(firstInterruption.deliveredWh, 300);
assert.equal(firstInterruption.remainingWh, 750);
assert.equal(interruptedState.plan.slots[0].targetWh, 750);

interruptedState.activeSlot = interruptedState.plan.slots[0];
interruptedState.activeChargedKwh = 0.2;
const repeatedInterruption = preserveInterruptedPlannerCharge(
  interruptedState,
  new Date("2026-07-11T12:20:00.000Z"),
);
assert.equal(repeatedInterruption.deliveredWh, 200);
assert.equal(repeatedInterruption.remainingWh, 550);
assert.equal(interruptedState.plan.slots[0].targetWh, 550);

const cappedLargerReplan = applyInterruptedChargeCap({
  slots: [{ ...interruptedSlot, targetWh: 900 }],
}, firstInterruption, 2100, new Date("2026-07-11T12:15:00.000Z"));
assert.equal(cappedLargerReplan.plan.slots[0].targetWh, 750);
assert.equal(cappedLargerReplan.interruption.remainingWh, 750);
const cappedSmallerReplan = applyInterruptedChargeCap({
  slots: [{ ...interruptedSlot, targetWh: 600 }],
}, firstInterruption, 2100, new Date("2026-07-11T12:15:00.000Z"));
assert.equal(cappedSmallerReplan.plan.slots[0].targetWh, 600);
assert.equal(applyInterruptedChargeCap({ slots: [] }, firstInterruption, 2100).interruption, null);
const completedSlotPlan = consumeCompletedPlannerSlot({
  plannedChargeKwh: 1.8,
  slots: [
    { ...interruptedSlot, targetWh: 750 },
    { ...interruptedSlot, start: "2026-07-11T12:30:00.000Z", end: "2026-07-11T13:00:00.000Z", targetWh: 1050 },
  ],
  windows: [{ end: interruptedSlot.windowEnd, plannedChargeKwh: 1.8, requestedChargeKwh: 1.8 }],
}, { ...interruptedSlot, targetWh: 750 });
assert.equal(completedSlotPlan.slots.length, 1);
assert.equal(completedSlotPlan.slots[0].targetWh, 1050);
assert.ok(Math.abs(completedSlotPlan.plannedChargeKwh - 1.05) < 0.0001);
assert.ok(Math.abs(completedSlotPlan.windows[0].plannedChargeKwh - 1.05) < 0.0001);
const delayedCompletedSlotPlan = consumeCompletedPlannerSlot({
  plannedChargeKwh: 0.75,
  slots: [{ ...interruptedSlot, slotId: "window:slot", targetWh: 750 }],
  windows: [{ end: interruptedSlot.windowEnd, plannedChargeKwh: 0.75, requestedChargeKwh: 0.75 }],
}, {
  ...interruptedSlot,
  slotId: "window:slot",
  start: "2026-07-11T12:10:00.000Z",
  targetWh: 700,
});
assert.equal(delayedCompletedSlotPlan.slots.length, 0);
assert.equal(delayedCompletedSlotPlan.plannedChargeKwh, 0);
const legacyDelayedCompletedSlotPlan = consumeCompletedPlannerSlot({
  plannedChargeKwh: 0.75,
  slots: [{ ...interruptedSlot, targetWh: 750 }],
  windows: [{ end: interruptedSlot.windowEnd, plannedChargeKwh: 0.75, requestedChargeKwh: 0.75 }],
}, {
  ...interruptedSlot,
  start: "2026-07-11T12:10:00.000Z",
  targetWh: 700,
});
assert.equal(legacyDelayedCompletedSlotPlan.slots.length, 0);

const delayedInterruptedState = {
  activeSlot: {
    ...interruptedSlot,
    slotId: "window:interrupted",
    start: "2026-07-11T12:05:00.000Z",
  },
  activeChargedKwh: 0.3,
  plan: {
    slots: [{ ...interruptedSlot, slotId: "window:interrupted" }],
  },
};
const delayedInterruption = preserveInterruptedPlannerCharge(
  delayedInterruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);
assert.equal(delayedInterruption.remainingWh, 750);
assert.equal(delayedInterruptedState.plan.slots[0].targetWh, 750);

const suspendedActions = [];
const suspendedState = {
  owner: "planner",
  activeSlot: interruptedSlot,
  activePlanCreatedAt: "plan",
  activeChargedKwh: 0.25,
  activeLastCheckedAt: "2026-07-11T12:10:00.000Z",
  activeChargeSession: null,
  log: [],
};
await suspendPlannerChargeInStandby(
  suspendedState,
  "Breaker limit reached",
  new Date("2026-07-11T12:10:00.000Z"),
  null,
  async (action, payload) => {
    suspendedActions.push({ action, payload });
    return { ok: true };
  },
);
assert.deepEqual(suspendedActions, [{ action: "set-mode", payload: { mode: "standby" } }]);
assert.equal(suspendedState.owner, null);
assert.match(suspendedState.log.at(-1).message, /maintaining Standby operation mode/);

const resumedActions = [];
await executePlannerChargeStart({ targetWh: 750 }, {
  resumeFromStandby: true,
  execute: async (action, payload) => {
    resumedActions.push({ action, payload });
    return { ok: true };
  },
});
assert.deepEqual(resumedActions, [
  { action: "set-mode", payload: { mode: "auto" } },
  { action: "charge", payload: { targetWh: 750 } },
]);

const failedResumeActions = [];
await assert.rejects(executePlannerChargeStart({ targetWh: 750 }, {
  resumeFromStandby: true,
  execute: async (action, payload) => {
    failedResumeActions.push({ action, payload });
    if (action === "charge") throw new Error("charge failed");
    return { ok: true };
  },
}), /charge failed/);
assert.deepEqual(failedResumeActions, [
  { action: "set-mode", payload: { mode: "auto" } },
  { action: "charge", payload: { targetWh: 750 } },
  { action: "set-mode", payload: { mode: "standby" } },
]);

const latePlannerSlot = capPlannerSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 750 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
);
assert.equal(latePlannerSlot.targetWh, 350);
assert.equal(latePlannerSlot.start, "2026-07-11T12:20:00.000Z");
assert.equal(capPlannerSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 49 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
), null);
assert.equal(capPlannerSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 50 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
)?.targetWh, 50);
assert.equal(capPlannerSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 750 },
  2100,
  new Date("2026-07-11T12:30:00.000Z"),
), null);

const deadlineState = {
  owner: "planner",
  activePlanCreatedAt: "deadline-plan",
  activeSlot: {
    start: "2026-07-11T12:00:00.000Z",
    end: "2026-07-11T12:30:00.000Z",
    targetWh: 1050,
  },
};
const deadlineKey = plannerSlotEndKey(deadlineState);
assert.equal(
  plannerSlotEndDelayMs(deadlineState, new Date("2026-07-11T12:20:00.000Z")),
  10 * 60_000,
);
assert.equal(plannerSlotEndKey({ ...deadlineState, owner: null }), null);

let deadlineReleaseCount = 0;
let deadlineWriteCount = 0;
const deadlineDependencies = {
  readState: async () => deadlineState,
  release: async (state) => {
    deadlineReleaseCount += 1;
    state.owner = null;
    state.activeSlot = null;
    return true;
  },
  writeState: async () => {
    deadlineWriteCount += 1;
  },
};
const earlyDeadline = await enforcePlannerSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:29:55.000Z"),
});
assert.equal(earlyDeadline.stopped, false);
assert.equal(earlyDeadline.remainingMs, 5000);
assert.equal(deadlineReleaseCount, 0);
assert.equal(deadlineWriteCount, 0);

const expiredDeadline = await enforcePlannerSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:30:00.000Z"),
});
assert.equal(expiredDeadline.stopped, true);
assert.equal(deadlineReleaseCount, 1);
assert.equal(deadlineWriteCount, 1);
assert.equal(deadlineState.owner, null);
assert.equal(deadlineState.activeSlot, null);

const staleDeadline = await enforcePlannerSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:31:00.000Z"),
});
assert.equal(staleDeadline.stopped, false);
assert.equal(staleDeadline.reason, "active planner slot changed");
assert.equal(deadlineReleaseCount, 1);

function chronologicalSlot(hour, band, netKwh = 0, highSolarNetKwh = netKwh) {
  const startMs = Date.parse("2026-07-12T00:00:00.000Z") + hour * 3_600_000;
  return {
    startMs,
    endMs: startMs + 30 * 60_000,
    band,
    demandW: 1000,
    netKwh,
    highSolarNetKwh,
    chargeCapacityKwh: band ? 1 : 0,
  };
}

const userTariffTimeline = [];
for (let halfHour = 0; halfHour < 38; halfHour += 1) {
  const hour = halfHour / 2;
  const band = hour >= 1 && hour < 5
    ? { start: "01:00", end: "05:00", yenPerKwh: 14.6, label: "Night" }
    : hour >= 11 && hour < 13
      ? { start: "11:00", end: "13:00", yenPerKwh: 12.6, label: "Day" }
      : null;
  const netKwh = hour >= 5 && hour < 11 ? -0.2 : hour >= 13 ? -0.1 : 0;
  userTariffTimeline.push(chronologicalSlot(hour, band, netKwh));
}
const userTariffPlan = planChronologicalDiscountedCharging({
  timeline: userTariffTimeline,
  currentStoredKwh: 1.5,
  capacityKwh: 5,
  dischargeFloorKwh: 1,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
assert.equal(userTariffPlan.windows.length, 2);
assert.equal(userTariffPlan.windows[0].bridgeToCheaperWindow, true);
assert.ok(Math.abs(userTariffPlan.windows[0].targetStoredKwh - 3.4) < 0.0001);
assert.ok(Math.abs(userTariffPlan.windows[0].plannedChargeKwh - 1.9) < 0.0001);
assert.equal(userTariffPlan.windows[1].targetSocPercent, 100);
assert.ok(Math.abs(userTariffPlan.windows[1].plannedChargeKwh - 4) < 0.0001);
assert.ok(Math.abs(userTariffPlan.expectedEndStoredKwh - 3.8) < 0.0001);

const configuredWindowStartMs = Date.parse("2026-07-12T01:00:00.000Z");
const configuredWindowEndMs = Date.parse("2026-07-12T05:00:00.000Z");
const partialWindowStartMs = Date.parse("2026-07-12T01:35:22.000Z");
const fixedTitlePlan = planChronologicalDiscountedCharging({
  timeline: [{
    startMs: partialWindowStartMs,
    endMs: Date.parse("2026-07-12T02:00:00.000Z"),
    band: { start: "01:00", end: "05:00", yenPerKwh: 14.6, label: "Night" },
    rateWindowStartMs: configuredWindowStartMs,
    rateWindowEndMs: configuredWindowEndMs,
    demandW: 0,
    netKwh: 0,
    highSolarNetKwh: 0,
    chargeCapacityKwh: 1,
  }],
  currentStoredKwh: 1,
  capacityKwh: 2,
  dischargeFloorKwh: 0,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
assert.equal(fixedTitlePlan.windows[0].start, new Date(configuredWindowStartMs).toISOString());
assert.equal(fixedTitlePlan.windows[0].end, new Date(configuredWindowEndMs).toISOString());
assert.equal(fixedTitlePlan.windows[0].planningStart, new Date(partialWindowStartMs).toISOString());
assert.equal(fixedTitlePlan.slots[0].windowStart, new Date(configuredWindowStartMs).toISOString());
assert.equal(fixedTitlePlan.slots[0].windowEnd, new Date(configuredWindowEndMs).toISOString());

const solarHeadroomTimeline = userTariffTimeline.map((slot) => ({ ...slot }));
for (let index = 26; index < 30; index += 1) {
  solarHeadroomTimeline[index].netKwh = 0.2;
  solarHeadroomTimeline[index].highSolarNetKwh = 0.25;
}
const solarHeadroomPlan = planChronologicalDiscountedCharging({
  timeline: solarHeadroomTimeline,
  currentStoredKwh: 1.5,
  capacityKwh: 5,
  dischargeFloorKwh: 1,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
assert.ok(Math.abs(solarHeadroomPlan.windows[1].solarHeadroomKwh - 1) < 0.0001);
assert.equal(solarHeadroomPlan.windows[1].targetSocPercent, 80);

const floorClippedWindowPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5, 1, 1.5].map((hour) => chronologicalSlot(
    hour,
    { start: "00:00", end: "02:00", yenPerKwh: 10, label: "Discounted" },
    -0.5,
  )),
  currentStoredKwh: 2,
  capacityKwh: 5,
  dischargeFloorKwh: 1,
  maximumTargetPercent: 80,
  maximumChargeWatts: 2000,
});
assert.equal(floorClippedWindowPlan.slots.length, 3);
assert.ok(Math.abs(floorClippedWindowPlan.plannedChargeKwh - 8 / 3) < 0.001);
assert.ok(floorClippedWindowPlan.unmetChargeKwh < 0.0001);
assert.ok(Math.abs(floorClippedWindowPlan.expectedEndStoredKwh - 4) < 0.0001);

const forcedChargeDemandTimeline = [0, 0.5, 1, 1.5].map((hour) => ({
  ...chronologicalSlot(
    hour,
    { start: "00:00", end: "02:00", yenPerKwh: 10, label: "Day discount" },
    -0.4,
  ),
  chargeCapacityKwh: 1.05,
}));
const forcedChargeDemandPlan = planChronologicalDiscountedCharging({
  timeline: forcedChargeDemandTimeline,
  currentStoredKwh: 0.465,
  capacityKwh: 4.65,
  dischargeFloorKwh: 0.465,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2100,
});
assert.ok(Math.abs(forcedChargeDemandPlan.plannedChargeKwh - 4.185) < 0.001);
assert.ok(forcedChargeDemandPlan.unmetChargeKwh < 0.0001);
assert.ok(Math.abs(forcedChargeDemandPlan.windows[0].predictedEndSocPercent - 100) < 0.001);

const backwardFeasibilityTimeline = [
  ...[0, 0.5, 1, 1.5].map((hour) => chronologicalSlot(
    hour,
    { start: "00:00", end: "02:00", yenPerKwh: 20, label: "Earlier discount" },
  )),
  chronologicalSlot(2, null),
  chronologicalSlot(2.5, null),
  ...[3, 3.5].map((hour) => chronologicalSlot(
    hour,
    { start: "03:00", end: "04:00", yenPerKwh: 10, label: "Cheapest discount" },
  )),
];
const backwardFeasibilityPlan = planChronologicalDiscountedCharging({
  timeline: backwardFeasibilityTimeline,
  currentStoredKwh: 0.5,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
assert.ok(backwardFeasibilityPlan.unmetChargeKwh < 0.0001);
assert.ok(Math.abs(backwardFeasibilityPlan.windows[0].backfillForLaterKwh - 2.5) < 0.001);
assert.ok(Math.abs(backwardFeasibilityPlan.windows[0].plannedChargeKwh - 2.5) < 0.001);
assert.ok(Math.abs(backwardFeasibilityPlan.windows[1].plannedChargeKwh - 2) < 0.001);
assert.ok(Math.abs(backwardFeasibilityPlan.windows[1].predictedEndSocPercent - 100) < 0.001);

const constrainedWindowPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5].map((hour) => chronologicalSlot(
    hour,
    { start: "00:00", end: "01:00", yenPerKwh: 10, label: "Short window" },
  )),
  currentStoredKwh: 0.5,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
const constrainedPlanStatus = discountedPlanStatus(constrainedWindowPlan);
assert.equal(constrainedWindowPlan.plannedChargeKwh, 2);
assert.equal(constrainedWindowPlan.unmetChargeKwh, 2.5);
assert.equal(constrainedPlanStatus.available, true);
assert.equal(constrainedPlanStatus.reason, null);
assert.match(constrainedPlanStatus.warning, /2\.50 kWh shortfall remains.*feasible discounted capacity/);
assert.equal(discountedPlanStatus({ plannedChargeKwh: 0, unmetChargeKwh: 2 }).available, false);
const migratedShortfallState = cleanSolarPlannerState({
  plan: {
    available: false,
    reason: "discounted windows cannot safely reach their planned SOC targets",
    plannedChargeKwh: 7.35,
    requiredGridChargeKwh: 8.67,
    unmetChargeKwh: 1.32,
    slots: [{ targetWh: 1050 }],
  },
});
assert.equal(migratedShortfallState.plan.available, true);
assert.equal(migratedShortfallState.plan.reason, null);
assert.match(migratedShortfallState.plan.warning, /7\.35 kWh of 8\.67 kWh requested/);

const moreExpensiveLaterTimeline = [
  chronologicalSlot(1, { start: "01:00", end: "02:00", yenPerKwh: 10, label: "Cheapest" }),
  chronologicalSlot(1.5, { start: "01:00", end: "02:00", yenPerKwh: 10, label: "Cheapest" }),
  chronologicalSlot(2, null, -0.2),
  chronologicalSlot(2.5, null, -0.2),
  chronologicalSlot(3, { start: "03:00", end: "04:00", yenPerKwh: 20, label: "Later" }),
  chronologicalSlot(3.5, { start: "03:00", end: "04:00", yenPerKwh: 20, label: "Later" }),
];
const moreExpensiveLaterPlan = planChronologicalDiscountedCharging({
  timeline: moreExpensiveLaterTimeline,
  currentStoredKwh: 3,
  capacityKwh: 5,
  dischargeFloorKwh: 1,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
});
assert.equal(moreExpensiveLaterPlan.windows[0].bridgeToCheaperWindow, false);
assert.equal(moreExpensiveLaterPlan.windows[0].targetSocPercent, 100);

const demandSamples = [];
for (let week = 1; week <= 8; week += 1) {
  const day = new Date(2026, 6, 13 - week * 7);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    demandSamples.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 1000 + week * 10,
    });
  }
}
const demandPrediction = predictHouseDemand(demandSamples, new Date(2026, 6, 13));
assert.equal(demandPrediction.available, true);
assert.equal(demandPrediction.profile.size, 48);
assert.equal(demandPrediction.seasonalYears.length, 0);
assert.equal(demandPrediction.seasonalBlendWeight, 0);

const multiYearDemandSamples = [...demandSamples];
for (const year of [2023, 2024, 2025]) {
  const day = new Date(year, 6, 13);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    multiYearDemandSamples.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 3000,
    });
  }
}
const seasonalDemandPrediction = predictHouseDemand(multiYearDemandSamples, new Date(2026, 6, 13));
assert.equal(seasonalDemandPrediction.available, true);
assert.deepEqual(seasonalDemandPrediction.seasonalYears, [2025, 2024, 2023]);
assert.equal(seasonalDemandPrediction.seasonalComparableDays.length, 3);
assert.equal(seasonalDemandPrediction.seasonalBlendWeight, 0.3);
assert.ok(seasonalDemandPrediction.profile.get(12) > demandPrediction.profile.get(12));

const indexedSeasonalDays = [2023, 2024, 2025].map((year) => ({
  key: `${year}-07-13`,
  date: new Date(year, 6, 13),
  coverage: 1,
  daytimeCoverage: 1,
  values: new Map(Array.from({ length: 48 }, (_, bucket) => [bucket, 3000])),
}));
const indexedSeasonalPrediction = predictHouseDemand(
  demandSamples,
  new Date(2026, 6, 13),
  new Map(),
  { historicalDays: indexedSeasonalDays },
);
assert.deepEqual(indexedSeasonalPrediction.seasonalYears, [2025, 2024, 2023]);
assert.equal(indexedSeasonalPrediction.seasonalBlendWeight, 0.3);
assert.ok(indexedSeasonalPrediction.profile.get(12) > demandPrediction.profile.get(12));

const outOfSeasonDemandSamples = [...demandSamples];
for (let bucket = 0; bucket < 48; bucket += 1) {
  outOfSeasonDemandSamples.push({
    timestamp: new Date(2025, 0, 13, Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
    houseDemandW: 5000,
  });
}
const outOfSeasonDemandPrediction = predictHouseDemand(outOfSeasonDemandSamples, new Date(2026, 6, 13));
assert.equal(outOfSeasonDemandPrediction.seasonalComparableDays.length, 0);
assert.equal(outOfSeasonDemandPrediction.seasonalBlendWeight, 0);

const youngDemandHistory = [];
for (let daysAgo = 1; daysAgo <= 10; daysAgo += 1) {
  const day = new Date(2026, 6, 12 - daysAgo);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    youngDemandHistory.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 900 + daysAgo * 20,
    });
  }
}
const youngWeekendPrediction = predictHouseDemand(youngDemandHistory, new Date(2026, 6, 12));
assert.equal(youngWeekendPrediction.available, true);
assert.equal(youngWeekendPrediction.validDayCount, 10);
assert.equal(youngWeekendPrediction.sameDayTypeDays.length, 3);
assert.equal(youngWeekendPrediction.usedDayTypeFallback, true);

const incompleteDemandHistory = youngDemandHistory.filter((sample) => new Date(sample.timestamp).getHours() < 8);
const incompletePrediction = predictHouseDemand(incompleteDemandHistory, new Date(2026, 6, 12));
assert.equal(incompletePrediction.available, false);
assert.match(incompletePrediction.reason, /0 of 10 days.*daytime coverage/);

const capacitySamples = [{ timestamp: "2026-07-11T00:00:00.000Z", stateOfChargePercent: 20, batteryPowerW: 1000 }];
for (let index = 1; index <= 6; index += 1) {
  capacitySamples.push({
    timestamp: new Date(Date.parse("2026-07-11T00:00:00.000Z") + index * 15 * 60_000).toISOString(),
    stateOfChargePercent: 20 + index * 10,
    batteryPowerW: 1000,
  });
}
const capacity = estimateEffectiveBatteryCapacity(capacitySamples, 2);
assert.equal(capacity.sessionCount, 6);
assert.equal(capacity.learnedCapacityKwh, 2.5);

const reversingCapacity = estimateEffectiveBatteryCapacity([
  { timestamp: "2026-07-11T00:00:00.000Z", stateOfChargePercent: 20, batteryPowerW: 1000 },
  { timestamp: "2026-07-11T00:15:00.000Z", stateOfChargePercent: 28, batteryPowerW: 1000 },
  { timestamp: "2026-07-11T00:30:00.000Z", stateOfChargePercent: 24, batteryPowerW: -1000 },
  { timestamp: "2026-07-11T00:45:00.000Z", stateOfChargePercent: 31, batteryPowerW: 1000 },
], 5);
assert.equal(reversingCapacity.sessionCount, 0);
assert.equal(reversingCapacity.learnedCapacityKwh, null);

const alignedSolarSamples = [];
const alignedWeather = [];
for (let day = 1; day <= 7; day += 1) {
  const sampleTime = Date.parse(`2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`);
  alignedSolarSamples.push({ timestamp: new Date(sampleTime).toISOString(), solarPowerW: 1000 });
  alignedWeather.push(
    { timestamp: new Date(sampleTime).toISOString(), tiltedIrradianceWm2: 100 },
    { timestamp: new Date(sampleTime + 3_600_000).toISOString(), tiltedIrradianceWm2: 500 },
  );
}
const alignedSolarFactor = learnedSolarFactor(alignedSolarSamples, alignedWeather, plannerConfig);
assert.equal(alignedSolarFactor.learned, true);
assert.equal(alignedSolarFactor.factor, 2);

const historyTailDir = await mkdtemp(path.join(os.tmpdir(), "home-energy-history-tail-"));
try {
  const historyFile = path.join(historyTailDir, "samples.jsonl");
  const historyStart = Date.parse("2026-01-01T00:00:00.000Z");
  const rows = Array.from({ length: 7000 }, (_, index) => ({
    timestamp: new Date(historyStart + index * 60_000).toISOString(),
    houseDemandW: index,
    rateLabel: `\u591c\u9593-${index}`,
    padding: "x".repeat(80),
  }));
  await writeFile(historyFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const recent = await readRecentHistorySamples(
    historyStart + 6990 * 60_000,
    historyStart + 6999 * 60_000,
    historyFile,
  );
  assert.equal(recent.length, 10);
  assert.equal(recent[0].houseDemandW, 6990);
  assert.equal(recent.at(-1).rateLabel, "\u591c\u9593-6999");
} finally {
  await rm(historyTailDir, { recursive: true, force: true });
}

assert.equal(cleanConfig({ updateIntervalSeconds: 2 }).updateIntervalSeconds, 5);
assert.equal(cleanConfig({ updateIntervalSeconds: 30 }).updateIntervalSeconds, 30);
assert.equal(cleanConfig({ smartCosmoEnabled: false }).smartCosmoEnabled, false);
assert.equal(cleanConfig({ co2TonnesPerKwh: 0.0005 }).co2TonnesPerKwh, 0.0005);
assert.deepEqual(normalizeCircuitLabels({ 1: "Kitchen", 2: "", bad: "Nope", 253: "Too high" }), { 1: "Kitchen" });
assert.deepEqual(cleanConfig({ circuitLabels: [{ channel: 6, label: "EV charger" }] }).circuitLabels, { 6: "EV charger" });
assert.equal(cleanConfig({ circuitSortMode: "energy" }).circuitSortMode, "current");
assert.equal(cleanConfig({ circuitSortMode: "current" }).circuitSortMode, "current");
assert.equal(cleanConfig({ circuitSortMode: "accumulated" }).circuitSortMode, "accumulated");
assert.equal(cleanConfig({ circuitSortMode: "bad" }).circuitSortMode, "number");

const normalizedWidgets = normalizeDashboardWidgets([
  { id: "solarPower", visible: false, priority: 90 },
  { id: "houseDemandPower", visible: true, priority: "bad" },
  { id: "unknownWidget", visible: true, priority: 1 },
]);
assert.equal(normalizedWidgets.length, 19);
assert.deepEqual(normalizedWidgets.find((widget) => widget.id === "solarPower"), {
  id: "solarPower",
  group: "trends",
  visible: false,
  priority: 90,
});
assert.deepEqual(normalizedWidgets.find((widget) => widget.id === "houseDemandPower"), {
  id: "houseDemandPower",
  group: "trends",
  visible: true,
  priority: 30,
});
assert.equal(normalizedWidgets.some((widget) => widget.id === "unknownWidget"), false);
assert.equal(normalizedWidgets.some((widget) => widget.id === "fuelCellPower"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "powerImported"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "powerExported"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "guardTriggerCount"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "energySources"), true);

assert.throws(
  () => parseJsonWithContext("[1]\n[2]", "test.json"),
  /test\.json at line 2, column 1, position 4/,
);
const recoveredState = recoverConcatenatedJsonValue(
  '{"old":{"lastResult":{"ok":false}}}\n{"new":{"lastResult":{"ok":true}}}',
  (value) => value && typeof value === "object" && !Array.isArray(value),
);
assert.equal(recoveredState.documentCount, 2);
assert.deepEqual(recoveredState.value, { new: { lastResult: { ok: true } } });
assert.equal(
  recoverConcatenatedJsonValue(
    '[{"id":"old"}]\n[{"id":"new"}]',
    (value) => value && typeof value === "object" && !Array.isArray(value),
  ),
  null,
);

assert.deepEqual(normalizeSubnets(["192.168.1.0/24", "bad", "192.168.1.0/24"]), ["192.168.1.0/24"]);

const bands = normalizeRateBands({
  rateBands: [
    { start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" },
    { start: "07:00", end: "23:00", yenPerKwh: 40, label: "Day" },
  ],
});
assert.equal(rateForTimestamp(bands, "2026-05-31T23:30:00+09:00").yenPerKwh, 20);
assert.equal(rateForTimestamp(bands, "2026-05-31T12:00:00+09:00").yenPerKwh, 40);

const partialBands = normalizeRateBands({
  rateMode: "multi",
  rateBands: [{ start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" }],
});
assert.equal(rateForTimestamp(partialBands, "2026-05-31T12:00:00+09:00", 40).yenPerKwh, 40);

const sample = sampleFromStatus({
  read_at: "2026-05-31T12:15:00+09:00",
  energy: {
    battery: { instant_power: { value: 500 }, remaining_percent: { value: 60 } },
    solar: { instant_power: { value: 1200 } },
    fuel_cells: [{ instant_power: { value: 300 } }],
  },
  meter: {
    house_demand_power: { value: 1800 },
    grid_import_power: { value: 200 },
    grid_export_power: { value: 100 },
    channel_power: {
      decoded: {
        channels: [
          { channel: 1, value: 120 },
          { channel: 2, value: 80 },
        ],
      },
    },
    channel_energy: {
      decoded: {
        channels: [
          { channel: 1, value: 10.5 },
          { channel: 2, value: 20.25 },
        ],
      },
    },
  },
}, { ...migrated, rateBands: bands }, {
  timestamp: "2026-05-31T11:45:00+09:00",
  circuitCumulativeKwh: { 1: 10, 2: 20 },
});
assert.equal(sample.rateYenPerKwh, 40);
assert.equal(sample.solarSavingYen, 24);
assert.equal(sample.solarGenerationKwh, 0.6);
assert.equal(sample.gridImportKwh, 0.1);
assert.equal(sample.gridExportKwh, 0.05);
assert.equal(sample.circuitPowerW["1"], 120);
assert.equal(sample.circuitCumulativeKwh["2"], 20.25);
assert.equal(sample.circuitEnergyKwh["1"], 0.5);
assert.equal(sample.circuitEnergyKwh["2"], 0.25);

const offPeakTimestamp = new Date(2026, 4, 31, 1, 0).toISOString();
const previousOffPeakTimestamp = new Date(2026, 4, 31, 0, 30).toISOString();
const mixedGridSolarCharge = sampleFromStatus({
  read_at: offPeakTimestamp,
  energy: {
    battery: { instant_power: { value: 1000 } },
    solar: { instant_power: { value: 600 } },
  },
  meter: { grid_import_power: { value: 700 } },
}, { ...migrated, rateBands: bands }, { timestamp: previousOffPeakTimestamp });
assert.equal(mixedGridSolarCharge.offPeakSavingYen, 7);

const mixedChargeWithoutGridMeter = sampleFromStatus({
  read_at: offPeakTimestamp,
  energy: {
    battery: { instant_power: { value: 1000 } },
    solar: { instant_power: { value: 600 } },
  },
}, { ...migrated, rateBands: bands }, { timestamp: previousOffPeakTimestamp });
assert.equal(mixedChargeWithoutGridMeter.offPeakSavingYen, 4);

const smartCosmoDisabledSample = sampleFromStatus({
  read_at: "2026-05-31T12:15:00+09:00",
  meter: {
    house_demand_power: { value: 1800 },
    grid_import_power: { value: 200 },
    grid_export_power: { value: 100 },
    channel_power: { decoded: { channels: [{ channel: 1, value: 120 }] } },
  },
}, { ...migrated, smartCosmoEnabled: false });
assert.equal(smartCosmoDisabledSample.houseDemandW, null);
assert.equal(smartCosmoDisabledSample.gridImportW, null);
assert.deepEqual(smartCosmoDisabledSample.circuitPowerW, {});

const unavailableSample = sampleFromStatus({
  read_at: "2026-05-31T12:30:00+09:00",
  energy: { battery: { instant_power: { value: null }, remaining_percent: {} } },
  meter: { grid_import_power: { value: null } },
}, { ...migrated, rateBands: bands });
assert.equal(unavailableSample.batteryPowerW, null);
assert.equal(unavailableSample.stateOfChargePercent, null);
assert.equal(unavailableSample.gridImportW, null);

const summary = summarizeSamples([
  { solarSavingYen: 1, offPeakSavingYen: 2, solarGenerationKwh: 0.25, gridImportKwh: 0.4, gridExportKwh: 0.1, circuitEnergyKwh: { 1: 0.2 } },
  { solarSavingYen: 3, offPeakSavingYen: 4, solarGenerationKwh: 0.75, gridImportKwh: 0.6, gridExportKwh: 0.2, circuitEnergyKwh: { 1: 0.3, 2: 0.1 }, circuitPowerW: { 2: 50 }, guardTriggerCount: 1 },
], { co2TonnesPerKwh: 0.000423, circuitLabels: { 1: "Kitchen" } });
assert.equal(summary.solarSavingYen, 4);
assert.equal(summary.offPeakSavingYen, 6);
assert.equal(summary.solarGenerationKwh, 1);
assert.equal(summary.co2SavingKg, 0.423);
assert.equal(summary.gridImportKwh, 1);
assert.ok(Math.abs(summary.gridExportKwh - 0.3) < 0.000001);
assert.equal(summary.circuits.find((item) => item.channel === 1).label, "Kitchen");
assert.equal(summary.circuits.find((item) => item.channel === 1).totalKwh, 0.5);
assert.equal(summary.circuits.find((item) => item.channel === 2).totalKwh, 0.1);
assert.equal(summary.circuitTotalKwh, 0.6);
assert.equal(summary.guardTriggerCount, 1);

const energySourceSummary = summarizeSamples([
  {
    timestamp: "2026-07-11T01:30:00+09:00",
    gridImportKwh: 0.4,
    gridExportKwh: 0,
    solarGenerationKwh: 0,
  },
  {
    timestamp: "2026-07-11T08:00:00+09:00",
    gridImportKwh: 0.5,
    gridExportKwh: 0.2,
    solarGenerationKwh: 1.2,
  },
  {
    timestamp: "2026-07-11T11:30:00+09:00",
    gridImportKwh: 0.6,
    gridExportKwh: 0,
    solarGenerationKwh: 0,
  },
], {
  standardRateYenPerKwh: 25.77,
  rateBands: [
    { start: "01:00", end: "05:00", yenPerKwh: 14.6, label: "Night" },
    { start: "11:00", end: "13:00", yenPerKwh: 12.6, label: "Day" },
  ],
});
assert.equal(energySourceSummary.energySources.peakGridKwh, 0.5);
assert.equal(energySourceSummary.energySources.offPeakGridKwh, 1);
assert.equal(energySourceSummary.energySources.solarUsedKwh, 1);
assert.equal(energySourceSummary.energySources.totalKwh, 2.5);
assert.equal(energySourceSummary.energySources.peakGridPercent, 20);
assert.equal(energySourceSummary.energySources.offPeakGridPercent, 40);
assert.equal(energySourceSummary.energySources.solarUsedPercent, 40);

const reportSamples = [
  {
    timestamp: "2026-07-01T00:15:00",
    houseDemandKwh: 1,
    solarGenerationKwh: 0.4,
    gridImportKwh: 0.5,
    gridExportKwh: 0.1,
    fuelCellKwh: 0.2,
    batteryChargeKwh: 0.3,
    batteryDischargeKwh: 0,
    solarSavingYen: 12,
    offPeakSavingYen: 1,
    houseDemandW: 1200,
  },
  {
    timestamp: "2026-07-01T12:15:00",
    houseDemandKwh: 2,
    solarGenerationKwh: 0.8,
    gridImportKwh: 0.3,
    gridExportKwh: 0.2,
    fuelCellKwh: 0.1,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0.4,
    solarSavingYen: 24,
    offPeakSavingYen: 2,
    houseDemandW: 2400,
  },
  {
    timestamp: "2026-07-02T00:15:00",
    houseDemandKwh: 6,
    solarGenerationKwh: 1.5,
    gridImportKwh: 1,
    gridExportKwh: 0.4,
    fuelCellKwh: 0.3,
    batteryChargeKwh: 0.1,
    batteryDischargeKwh: 0.2,
    solarSavingYen: 45,
    offPeakSavingYen: 3,
    houseDemandW: 1800,
  },
];
const dailyReport = aggregateEnergyReportSamples(reportSamples, {
  start: "2026-07-01T00:00:00",
  end: "2026-07-03T00:00:00",
  bucket: "day",
  config: { co2TonnesPerKwh: 0.000423 },
});
assert.equal(dailyReport.buckets.length, 2);
assert.equal(dailyReport.buckets[0].key, "2026-07-01");
assert.equal(dailyReport.buckets[0].houseDemandKwh, 3);
assert.equal(dailyReport.buckets[0].gridImportKwh, 0.8);
assert.equal(dailyReport.buckets[0].peakDemandW, 2400);
assert.equal(dailyReport.buckets[1].previousHouseDemandKwh, 3);
assert.equal(dailyReport.buckets[1].houseDemandDeltaKwh, 3);
assert.equal(dailyReport.buckets[1].houseDemandDeltaPercent, 100);
assert.equal(dailyReport.totals.houseDemandKwh, 9);
assert.equal(dailyReport.totals.solarGenerationKwh, 2.7);
assert.ok(Math.abs(dailyReport.totals.solarCoveragePercent - 30) < 0.000001);

const dailyReportWithGap = aggregateEnergyReportSamples(reportSamples.slice(0, 1), {
  start: "2026-07-01T00:00:00",
  end: "2026-07-03T00:00:00",
  bucket: "day",
});
assert.equal(dailyReportWithGap.buckets.length, 2);
assert.equal(dailyReportWithGap.buckets[1].key, "2026-07-02");
assert.equal(dailyReportWithGap.buckets[1].houseDemandKwh, null);
assert.equal(dailyReportWithGap.buckets[1].sampleCount, 0);

const missingUsageReport = aggregateEnergyReportSamples([
  { timestamp: "2026-07-01T01:00:00", solarGenerationKwh: 0.5 },
], {
  start: "2026-07-01T00:00:00",
  end: "2026-07-02T00:00:00",
  bucket: "day",
});
assert.equal(missingUsageReport.buckets[0].houseDemandKwh, null);
assert.equal(missingUsageReport.totals.houseDemandKwh, null);

const weeklyReport = aggregateEnergyReportSamples(reportSamples, {
  start: "2026-07-01T00:00:00",
  end: "2026-07-03T00:00:00",
  bucket: "week",
});
assert.equal(weeklyReport.buckets[0].key, "2026-06-29");
assert.equal(weeklyReport.buckets[0].houseDemandKwh, 9);

const monthlyReport = aggregateEnergyReportSamples(reportSamples, {
  start: "2026-07-01T00:00:00",
  end: "2026-07-31T23:59:00",
  bucket: "month",
});
assert.equal(monthlyReport.buckets[0].key, "2026-07");
assert.equal(monthlyReport.buckets[0].houseDemandKwh, 9);

const disabledFeatureReport = aggregateEnergyReportSamples(reportSamples, {
  start: "2026-07-01T00:00:00",
  end: "2026-07-03T00:00:00",
  bucket: "day",
  config: { solarEnabled: false, smartCosmoEnabled: false, fuelCellEnabled: false },
});
assert.equal(disabledFeatureReport.features.solarEnabled, false);
assert.equal(disabledFeatureReport.features.smartCosmoEnabled, false);
assert.equal(disabledFeatureReport.features.fuelCellEnabled, false);

const guardRules = [{
  type: "backup-demand-guard",
  log: [
    { at: "2026-05-31T01:00:00.000Z", kind: "guard", message: "new guard" },
    { at: "2026-05-31T02:00:00.000Z", message: "Grid Import (4000 W) exceeds Charge Demand Guard limit (3500 W), setting operation mode from auto to Standby" },
    { at: "2026-05-31T03:00:00.000Z", kind: "restore", message: "restore" },
  ],
}];
assert.equal(
  countGuardTriggersForRange(guardRules, "2026-05-31T00:00:00.000Z", "2026-05-31T02:30:00.000Z"),
  2,
);
assert.equal(
  countGuardTriggersForRange(
    guardRules,
    "2026-05-31T00:00:00.000Z",
    "2026-05-31T02:30:00.000Z",
    { excludeTimes: new Set(["2026-05-31T01:00:00.000Z"]) },
  ),
  1,
);
assert.equal(countGuardTriggersForRange(guardRules, null, "2026-05-31T01:30:00.000Z"), 1);

const legacyPowerSummary = summarizeSamples([
  { timestamp: "2026-05-31T00:00:00.000Z", gridImportW: 1000, gridExportW: 500 },
  { timestamp: "2026-05-31T00:30:00.000Z", gridImportW: 2000, gridExportW: 1000 },
]);
assert.equal(legacyPowerSummary.gridImportKwh, 1);
assert.equal(legacyPowerSummary.gridExportKwh, 0.5);

const rule = cleanAutomationRule({ enabled: true, conditions: { breakerAmps: 40, reserveAmps: 5, source: "houseDemandW" } });
assert.equal(rule.action, "set-mode");
assert.equal(rule.payload.mode, "standby");
assert.equal(rule.restoreAction, "set-mode");
assert.equal(rule.restorePayload.mode, "auto");
assert.equal(cleanAutomationRule({}).conditions.source, "gridImportW");
const mergedRule = cleanAutomationRule({
  updatedAt: "2026-05-31T00:00:00.000Z",
  stateUpdatedAt: "2026-05-31T00:01:00.000Z",
});
assert.equal(mergedRule.updatedAt, "2026-05-31T00:00:00.000Z");
assert.equal(mergedRule.stateUpdatedAt, "2026-05-31T00:01:00.000Z");
const ruleConfig = cleanAutomationRuleConfig({
  id: "rule-1",
  enabled: true,
  state: { awaitingRestore: true },
  lastResult: { ok: true },
  log: [{ message: "state only" }],
});
assert.equal(ruleConfig.id, "rule-1");
assert.equal("state" in ruleConfig, false);
assert.equal("lastResult" in ruleConfig, false);
assert.equal("log" in ruleConfig, false);
const skipped = await evaluateAutomationRule(rule, {
  settings: { mode: { decoded: { mode: "eco" } } },
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 0 } } },
  meter: { house_demand_power: { value: 1000 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(skipped.result.skipped, "conditions not met");

const unavailableDemand = await evaluateAutomationRule(rule, {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: null } } },
  meter: { grid_import_power: { value: null } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(unavailableDemand.result.skipped, "demand unavailable");

const actualChargingSafe = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  conditions: { source: "houseDemandW", breakerAmps: 40, reserveAmps: 5, batteryChargingEstimateW: 1000 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { house_demand_power: { value: 2800 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(actualChargingSafe.result.skipped, "conditions not met");
assert.equal(actualChargingSafe.result.actualDemandWithChargingW, 3400);

const gridImportDoesNotDoubleCountCharging = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  conditions: { source: "gridImportW", breakerAmps: 40, reserveAmps: 5, batteryChargingEstimateW: 1000 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { grid_import_power: { value: 3400 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(gridImportDoesNotDoubleCountCharging.result.skipped, "conditions not met");
assert.equal(gridImportDoesNotDoubleCountCharging.result.guardDemandW, 3400);


const restoreWouldTrip = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  conditions: {
    breakerAmps: 40,
    source: "houseDemandW",
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
  },
}), {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { house_demand_power: { value: 2600 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(restoreWouldTrip.result.skipped, "restore would exceed breaker reserve");
assert.equal(restoreWouldTrip.result.estimatedRestoredDemandW, 3600);

const repeatedRestoreLogRule = cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  lastResult: { ok: true, at: "2026-05-31T00:00:00.000Z", skipped: "restore demand still high" },
  conditions: {
    source: "gridImportW",
    breakerAmps: 40,
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
  },
});
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3200 } },
}, new Date("2026-05-31T00:01:00.000Z"));
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3100 } },
}, new Date("2026-05-31T00:02:00.000Z"));
assert.equal(repeatedRestoreLogRule.log.length, 2);
assert.match(repeatedRestoreLogRule.log[0].message, /Grid Import \(3200 W\) still exceeds/);
assert.match(repeatedRestoreLogRule.log[1].message, /Grid Import \(3100 W\) still exceeds/);

const reassertActions = [];
const reassertStandbyRule = cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  conditions: {
    source: "gridImportW",
    breakerAmps: 40,
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
  },
});
await evaluateAutomationRule(reassertStandbyRule, {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 2000 } },
}, new Date("2026-05-31T00:03:00.000Z"), () => {}, null, {
  execute: async (action, payload) => {
    reassertActions.push({ action, payload });
    return { ok: true };
  },
});
assert.deepEqual(reassertActions, [{ action: "set-mode", payload: { mode: "standby" } }]);
assert.equal(reassertStandbyRule.state.awaitingRestore, true);
assert.match(reassertStandbyRule.log.at(-1).message, /returning it to Standby/);

const deferredRestoreActions = [];
const deferredRestoreRule = cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true, restoreSince: "2026-05-31T00:00:00.000Z" },
  conditions: {
    source: "gridImportW",
    breakerAmps: 40,
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
    restoreDelaySeconds: 30,
  },
});
const deferredRestore = await evaluateAutomationRule(deferredRestoreRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 2000 } },
}, new Date("2026-05-31T00:01:00.000Z"), () => {}, null, {
  holdStandbyForPlanner: true,
  execute: async (action, payload) => deferredRestoreActions.push({ action, payload }),
});
assert.equal(deferredRestore.result.skipped, "planner waiting to resume charging");
assert.deepEqual(deferredRestoreActions, []);
assert.equal(deferredRestoreRule.state.awaitingRestore, true);

const normalizedNotifications = normalizeNotificationConfig({
  enabled: "true",
  channels: [{
    id: "mail",
    type: "smtp",
    settings: {
      host: " smtp.example.test ",
      port: 70000,
      security: "bad",
      from: "energy@example.test",
      recipients: "one@example.test, two@example.test, one@example.test",
    },
  }],
  triggers: { scheduleFailed: { enabled: false, cooldownMinutes: 0 } },
});
assert.equal(normalizedNotifications.enabled, true);
assert.equal(normalizedNotifications.channels[0].settings.host, "smtp.example.test");
assert.equal(normalizedNotifications.channels[0].settings.port, 65535);
assert.equal(normalizedNotifications.channels[0].settings.security, "starttls");
assert.deepEqual(normalizedNotifications.channels[0].settings.recipients, ["one@example.test", "two@example.test"]);
assert.equal(normalizedNotifications.triggers.scheduleFailed.enabled, false);
assert.equal(normalizedNotifications.triggers.scheduleFailed.cooldownMinutes, 1);
assert.equal(normalizedNotifications.triggers.lowBattery.enabled, false);
assert.equal(normalizedNotifications.triggers.lowBattery.thresholdPercent, 20);
assert.equal(cleanConfig({ notifications: normalizedNotifications }).notifications.channels[0].id, "mail");

assert.deepEqual(validateSmtpSettings({
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  from: "energy@example.test",
  recipients: ["owner@example.test"],
}), []);
assert.match(validateSmtpSettings({ security: "none", recipients: [] }).join("; "), /SMTP host is required/);
assert.deepEqual(smtpTransportOptions({
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "energy",
}, { password: "secret" }).auth, { user: "energy", pass: "secret" });

const notificationDir = await mkdtemp(path.join(os.tmpdir(), "home-energy-notifications-"));
const sentMessages = [];
const recordedNotificationEvents = [];
const notificationConfig = normalizeNotificationConfig({
  enabled: true,
  channels: [{
    id: "primary-email",
    type: "smtp",
    enabled: true,
    settings: {
      host: "smtp.example.test",
      port: 587,
      security: "starttls",
      username: "energy",
      from: "energy@example.test",
      recipients: ["owner@example.test"],
    },
  }],
});
const notificationService = createNotificationService({
  dataDir: notificationDir,
  getConfig: async () => ({ notifications: notificationConfig }),
  createTransport: (options) => ({
    async sendMail(message) {
      sentMessages.push({ options, message });
      return { messageId: `message-${sentMessages.length}` };
    },
    close() {},
  }),
  recordEvent: async (event) => recordedNotificationEvents.push(event),
});
await notificationService.updateSecret({ channelId: "primary-email", password: "secret" });
assert.equal((await notificationService.view()).passwordConfigured, true);
await notificationService.deliver({
  type: "scheduleFailed",
  title: "Schedule failed",
  message: "Test failure",
  dedupeKey: "schedule:test",
});
assert.equal((await notificationService.deliver({
  type: "scheduleFailed",
  title: "Schedule failed",
  message: "Test failure",
  dedupeKey: "schedule:test",
})).skipped, "cooldown");
assert.equal(sentMessages.length, 1);
assert.equal(recordedNotificationEvents.length, 1);
assert.equal(recordedNotificationEvents[0].category, "notification");
assert.equal(recordedNotificationEvents[0].type, "delivered");

for (let index = 0; index < 3; index += 1) {
  await notificationService.observeCondition({
    key: "device-health-test",
    active: true,
    activateAfter: 3,
    recoverAfter: 2,
    activeEvent: {
      type: "deviceOffline",
      title: "Offline",
      message: "Device is offline",
      dedupeKey: "device:test:offline",
    },
    recoveryEvent: {
      type: "deviceRecovered",
      title: "Recovered",
      message: "Device recovered",
      dedupeKey: "device:test:recovered",
    },
  });
}
assert.equal(sentMessages.length, 2);
for (let index = 0; index < 2; index += 1) {
  await notificationService.observeCondition({
    key: "device-health-test",
    active: false,
    activateAfter: 3,
    recoverAfter: 2,
    recoveryEvent: {
      type: "deviceRecovered",
      title: "Recovered",
      message: "Device recovered",
      dedupeKey: "device:test:recovered",
    },
  });
}
assert.equal(sentMessages.length, 3);
await notificationService.sendTest();
assert.equal(sentMessages.length, 4);
assert.match(sentMessages.at(-1).message.subject, /Test notification/);
assert.equal((await notificationService.view()).deliveries.length, 4);
await notificationService.updateSecret({ channelId: "primary-email", clearPassword: true });
assert.equal((await notificationService.view()).passwordConfigured, false);
await rm(notificationDir, { recursive: true, force: true });

console.log("helper tests passed");
