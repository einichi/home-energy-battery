import assert from "node:assert/strict";

import { mkdtemp, rm } from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { createDeviceSimulator } from "./support/device-simulator.js";
import { batteryLearningRollup, chronologicalSlot } from "./support/adaptive-domain-fixtures.js";

import {
  createNotificationService,
  normalizeNotificationConfig,
  smtpTransportOptions,
  validateSmtpSettings,
} from "../lib/notifications.js";

import { smtpSecurityWarning } from "../lib/domain/notification-configuration.js";

import { localIsoTimestamp, timestampConsole } from "../lib/console-timestamps.js";

import { parseJsonWithContext } from "../lib/domain/json.js";

import { normalizeCircuitLabels } from "../lib/domain/circuits.js";

import {
  cleanConfig,
  normalizeDashboardWidgets,
  normalizeRateBands,
  normalizeSubnets,
} from "../lib/domain/configuration.js";

import {
  backupPreparationAllowsActionSource,
  backupPreparationBlocksActions,
} from "../lib/domain/operational-overrides.js";

import {
  applySolarForecastBias,
  dailySolarForecastIssues,
  forecastHourForInterval,
  learnedSolarFactor,
  nextPlanningBoundary,
  parseOpenMeteoForecast,
  solarPowerFromIrradiance,
} from "../lib/domain/solar-forecast.js";

import {
  discountedBandOccurrence,
  discountedBandOccurrences,
  discountedHorizonEndMs,
  rateForTimestamp,
} from "../lib/domain/tariffs.js";

import { awayPeriodContains, awayPeriodForecastContains } from "../lib/domain/time.js";

import { sampleFromStatus } from "../lib/domain/telemetry.js";

import { fuelCellHotWaterEmptyNotificationActive } from "../lib/domain/status-alerts.js";

import { clearStaleScheduleRuns } from "../lib/domain/schedules.js";

import {
  assertDeviceCommandResult,
  verifyBatteryOperationMode,
} from "../lib/services/command-verification.js";

import { summarizeCalendarSavings, summarizeSamples } from "../lib/domain/energy-summary.js";

import { aggregateEnergyReportSamples } from "../lib/domain/energy-report.js";

import { fuelCellGasUsageByBillingPeriod } from "../lib/domain/ene-farm.js";

import {
  adaptiveChargingTimingProfile,
  buildBatteryChargePowerCurve,
  buildBatteryLearningModel,
  effectiveAdaptiveChargeWatts,
  effectiveBatteryLearningModel,
  estimateChargeDurationMs,
  estimateDeliverableChargeWh,
  extractBatteryLearningObservations,
} from "../lib/domain/battery-learning.js";

import {
  aggregateDemandDays,
  buildFuelCellGenerationModel,
  filterDemandDaysByOccupancy,
  predictAwayDemand,
  predictHouseDemand,
} from "../lib/domain/demand-forecast.js";

import {
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  adaptiveChargingBreakerSettings,
  buildAdaptiveChargingTimelineView,
  discountedPlanStatus,
  forecastIsFresh,
  mergeAdaptiveChargingSlots,
  optimizeDiscountedChargeSlots,
  planChronologicalDiscountedCharging,
} from "../lib/domain/adaptive-planning.js";

import { latestFiniteSocPercent } from "../lib/domain/adaptive-plan-utils.js";

import {
  cleanAdaptiveChargingPerformance,
  cleanAdaptiveChargingState,
  completeAdaptiveChargingWindowInterruption,
  finalizeAdaptiveChargeSession,
  finalizeAdaptiveChargingWindowExecution,
  recordAdaptiveChargingSolarHeadroomInterruption,
  recordAdaptiveChargingWindowInterruption,
  syncAdaptiveChargingWindowExecution,
} from "../lib/domain/adaptive-state.js";

import {
  activeAdaptiveChargingSlotStopReason,
  adaptiveChargingBreakerRecoveryReady,
  adaptiveChargingExportEvidence,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingLiveImportSafety,
  adaptiveChargingPlanLogMessage,
  adaptiveChargingPlanRefreshDecision,
  adaptiveChargingWindowSolarOpportunity,
  adaptiveChargingWindowHasShortfall,
  advanceAdaptiveChargingBreakerRecovery,
  applyInterruptedChargeCap,
  batteryLearningModelSwitchDue,
  beginAdaptiveChargingBreakerRecovery,
  capAdaptiveChargingSlotToRemainingTime,
  consumeBatteryLearningModelSwitch,
  consumeCompletedAdaptiveChargingSlot,
  logAdaptiveChargingBreakerWait,
  logAdaptiveChargingInitialHeadroomWait,
  preserveInterruptedAdaptiveCharge,
  shouldHoldGuardStandbyForAdaptiveCharging,
  updateAdaptiveChargingExportConfirmation,
  updateAdaptiveChargingSolarHeadroomHold,
  adaptiveChargingSlotEndDelayMs,
  adaptiveChargingSlotEndKey,
  updateActiveAdaptiveChargingObjective,
} from "../lib/domain/adaptive-control.js";

import {
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  shouldTriggerDemandGuard,
} from "../lib/domain/automation-rules.js";

import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "../lib/counter-utils.js";

import { createAdaptiveChargingOperations } from "../lib/services/adaptive-charging-operations.js";

const unavailableOperation = async (): Promise<never> => {
  throw new Error("Test must inject the device operation");
};
const adaptiveChargingOperations = createAdaptiveChargingOperations({
  execute: unavailableOperation,
  readState: unavailableOperation,
  writeState: unavailableOperation,
  retryDelayMs: 5_000,
});
const recoverIdleAdaptiveCharge = adaptiveChargingOperations.recoverIdle;
const executeAdaptiveChargeStart = adaptiveChargingOperations.start;
const enforceAdaptiveChargingSlotEndDeadline = adaptiveChargingOperations.enforceDeadline;
const suspendAdaptiveChargeInStandby = adaptiveChargingOperations.suspendInStandby;


const adaptiveChargingConfig = cleanConfig({
  solarEnabled: true,
  smartCosmoEnabled: true,
  rateMode: "multi",
  standardRateYenPerKwh: 40,
  rateBands: [
    { start: "23:00", end: "01:00", yenPerKwh: 15, label: "Cheapest" },
    { start: "01:00", end: "03:00", yenPerKwh: 20, label: "Night" },
  ],
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 2000 },
  adaptiveCharging: { enabled: true, latitude: -33.8, longitude: -151.2, arrayPeakKw: 5 },
});

assert.equal(adaptiveChargingBaseAvailability(adaptiveChargingConfig).available, true);

assert.equal(adaptiveChargingBaseAvailability(cleanConfig({ ...adaptiveChargingConfig, rateMode: "simple" })).available, false);

const overnightOccurrence = discountedBandOccurrence(adaptiveChargingConfig, new Date(2026, 6, 11, 23, 30));

assert.ok(overnightOccurrence);

assert.equal(new Date(overnightOccurrence.start).getHours(), 23);

assert.equal(new Date(overnightOccurrence.end).getDate(), new Date(2026, 6, 12).getDate());

assert.equal(new Date(overnightOccurrence.end).getHours(), 1);

// A discounted window spanning sunset extends the planning horizon to its end;
// a window that ends before sunset leaves the horizon at sunset.
const eveningBandConfig = cleanConfig({
  rateMode: "multi",
  standardRateYenPerKwh: 40,
  rateBands: [{ start: "17:00", end: "20:00", yenPerKwh: 15, label: "Evening" }],
});
assert.equal(
  discountedHorizonEndMs(eveningBandConfig, new Date(2026, 6, 11, 18, 0).getTime()),
  new Date(2026, 6, 11, 20, 0).getTime(),
);
assert.equal(
  discountedHorizonEndMs(eveningBandConfig, new Date(2026, 6, 11, 21, 0).getTime()),
  new Date(2026, 6, 11, 21, 0).getTime(),
);

const rebaseNow = new Date(2026, 6, 11, 23, 30);

const waitingAdaptiveChargingState: Record<string, any> = {
  owner: null,
  forecast: { fetchedAt: "2026-07-11T10:00:00.000Z" },
  plan: { createdAt: rebaseNow.toISOString(), currentSocPercent: 30, forecastFetchedAt: "2026-07-11T10:00:00.000Z" },
  lastPlanEventKey: null,
};

const entryRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, rebaseNow);

assert.equal(entryRefresh.refresh, true);

assert.match(String(entryRefresh.trigger), /30-minute slot boundary/);

const rebasedAdaptiveChargingState: Record<string, any> = { ...waitingAdaptiveChargingState, lastPlanEventKey: entryRefresh.eventKey };

assert.equal(adaptiveChargingPlanRefreshDecision(rebasedAdaptiveChargingState, adaptiveChargingConfig, rebaseNow).refresh, false);

assert.equal(adaptiveChargingPlanRefreshDecision(rebasedAdaptiveChargingState, adaptiveChargingConfig, new Date(2026, 6, 12, 0, 0)).refresh, true);

const solarWindowPlan = {
  ...waitingAdaptiveChargingState.plan,
  timeline: [{
    start: overnightOccurrence.start,
    end: overnightOccurrence.end,
    solarW: 1_000,
    fuelCellP20W: 0,
    demandW: 300,
  }],
};
assert.deepEqual(adaptiveChargingWindowSolarOpportunity(solarWindowPlan, overnightOccurrence), {
  available: true,
  predictedSolarWh: 2_000,
  predictedSurplusWh: 1_400,
  peakSurplusW: 700,
});
// A fuel cell that is only observed must not contribute to the solar-opportunity
// check, but an actively-influencing fuel cell does.
const observedFuelCellPlan = {
  ...solarWindowPlan,
  fuelCellModel: { influence: "observe" },
  timeline: [{ ...solarWindowPlan.timeline[0], fuelCellP20W: 1_000 }],
};
assert.equal(adaptiveChargingWindowSolarOpportunity(observedFuelCellPlan, overnightOccurrence).predictedSurplusWh, 1_400);
const activeFuelCellPlan = {
  ...solarWindowPlan,
  fuelCellModel: { influence: "active" },
  timeline: [{ ...solarWindowPlan.timeline[0], fuelCellP20W: 1_000 }],
};
assert.equal(adaptiveChargingWindowSolarOpportunity(activeFuelCellPlan, overnightOccurrence).predictedSurplusWh, 3_400);
const solarWindowRefresh = adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  plan: solarWindowPlan,
}, adaptiveChargingConfig, rebaseNow);
assert.equal(solarWindowRefresh.refresh, true);
assert.match(String(solarWindowRefresh.trigger), /5-minute solar-window adjustment/);
assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  plan: solarWindowPlan,
  lastPlanEventKey: solarWindowRefresh.eventKey,
}, adaptiveChargingConfig, new Date(rebaseNow.getTime() + 4 * 60_000)).refresh, false);
assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  plan: solarWindowPlan,
  lastPlanEventKey: solarWindowRefresh.eventKey,
}, adaptiveChargingConfig, new Date(rebaseNow.getTime() + 5 * 60_000)).refresh, true);

const prewindowNow = new Date(2026, 6, 11, 22, 30);

const prewindowRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, prewindowNow);

assert.equal(prewindowRefresh.refresh, true);

assert.match(String(prewindowRefresh.trigger), /30 minutes before Cheapest/);

assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  lastPlanEventKey: prewindowRefresh.eventKey,
}, adaptiveChargingConfig, new Date(2026, 6, 11, 22, 45)).refresh, false);

const windowEntryRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, new Date(2026, 6, 11, 23, 0));

assert.equal(windowEntryRefresh.refresh, true);

assert.match(String(windowEntryRefresh.trigger), /entering Cheapest/);

const forecastRefresh = adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
}, adaptiveChargingConfig, new Date(2026, 6, 11, 12, 0));

assert.equal(forecastRefresh.refresh, true);

assert.equal(forecastRefresh.trigger, "forecast refresh");

const activeForecastRefresh = adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
}, adaptiveChargingConfig, rebaseNow);

assert.equal(activeForecastRefresh.trigger, "forecast refresh");

assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  forecast: { fetchedAt: "2026-07-11T11:00:00.000Z" },
  plan: { ...waitingAdaptiveChargingState.plan, forecastFetchedAt: "2026-07-11T11:00:00.000Z" },
  lastPlanEventKey: activeForecastRefresh.eventKey,
}, adaptiveChargingConfig, rebaseNow).refresh, false);

const initialRefresh = adaptiveChargingPlanRefreshDecision({
  forecast: waitingAdaptiveChargingState.forecast,
  plan: null,
  pendingPlanReason: "configuration changed",
  pendingPlanRequestId: "config-save-1",
}, adaptiveChargingConfig, new Date(2026, 6, 11, 12, 0));

assert.equal(initialRefresh.trigger, "configuration changed");

assert.equal(initialRefresh.eventKey, "pending:config-save-1");

assert.equal(adaptiveChargingPlanRefreshDecision({
  forecast: waitingAdaptiveChargingState.forecast,
  plan: null,
  pendingPlanReason: "configuration changed",
  pendingPlanRequestId: "config-save-1",
  updatedAt: "2026-07-11T12:00:30.000Z",
}, adaptiveChargingConfig, new Date(2026, 6, 11, 12, 0, 30)).eventKey, initialRefresh.eventKey);

const recalculationLog = adaptiveChargingPlanLogMessage({
  available: true,
  predictedSolarKwh: 5.65,
  predictedDemandKwh: 17.64,
  plannedChargeKwh: 1.97,
  warning: "test warning",
  batteryModel: {
    version: 2,
    charge: { whPerSocPoint: 54, source: "configured" },
    discharge: { whPerSocPoint: 50, source: "learned" },
    power: { effectiveWatts: 2192, source: "configured" },
  },
  windows: [{
    label: "Cheapest",
    targetSocPercent: 52,
    plannedChargeKwh: 1.97,
    schedulingWatts: 1644,
    timingReserveMs: 1_800_000,
    schedulingSource: "learned+guard-history",
    guardDeliverability: {
      learned: true,
      deliveryFactor: 0.75,
      sampleCount: 6,
      interruptionReserveMs: 900_000,
    },
  }],
  slots: [{ start: "2026-07-11T04:03:42.000Z", end: "2026-07-11T05:00:00.000Z", targetWh: 1970 }],
}, "entering Cheapest", 10);

assert.match(recalculationLog, /Plan recalculated \(entering Cheapest\)/);

assert.match(recalculationLog, /targets \[Cheapest 52%\/1\.97 kWh\]/);

assert.match(recalculationLog, /slots \[.*1970 Wh\]/);

assert.match(recalculationLog, /test warning/);

assert.match(recalculationLog, /guard 75% reliable from 6 windows, 15 min observed recovery reserve/);

assert.match(recalculationLog, /battery model v2 \[charge 54\.0 Wh\/SOC \(configured\), discharge 50\.0 Wh\/SOC \(learned\), power 2192 W \(configured\)\]/);

assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  plan: { ...waitingAdaptiveChargingState.plan, createdAt: "2026-07-01T00:00:00.000Z" },
}, adaptiveChargingConfig, new Date(2026, 6, 11, 12, 0)).refresh, false);

const modelSwitchNow = new Date("2026-07-19T04:00:00.000Z");

assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: null } }, modelSwitchNow), false);

assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: "2026-07-19T03:59:59.000Z" } }, modelSwitchNow), true);

assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: "2026-07-19T04:00:01.000Z" } }, modelSwitchNow), false);

let deferredModelSwitchState: ReturnType<typeof cleanAdaptiveChargingState> = cleanAdaptiveChargingState({
  batteryLearning: { switchAfterSlotEnd: "2026-07-19T03:59:59.000Z" },
});

assert.equal(consumeBatteryLearningModelSwitch(deferredModelSwitchState, modelSwitchNow), true);

assert.equal(deferredModelSwitchState.batteryLearning.switchAfterSlotEnd, null);

assert.equal(
  deferredModelSwitchState.batteryLearning.consumedSwitchAfterSlotEnd,
  "2026-07-19T03:59:59.000Z",
);

assert.equal(deferredModelSwitchState.pendingPlanReason, "battery model migration after active slot");

assert.equal(
  deferredModelSwitchState.pendingPlanRequestId,
  "battery-model-switch:2026-07-19T03:59:59.000Z",
);

deferredModelSwitchState.batteryLearning = buildBatteryLearningModel(
  adaptiveChargingConfig,
  [],
  deferredModelSwitchState.batteryLearning,
  modelSwitchNow,
);

assert.equal(deferredModelSwitchState.batteryLearning.switchAfterSlotEnd, null);

assert.equal(
  deferredModelSwitchState.batteryLearning.consumedSwitchAfterSlotEnd,
  "2026-07-19T03:59:59.000Z",
);

const persistedModelSwitchState = cleanAdaptiveChargingState(deferredModelSwitchState);

persistedModelSwitchState.batteryLearning.switchAfterSlotEnd = "2026-07-19T03:59:59.000Z";

assert.equal(consumeBatteryLearningModelSwitch(persistedModelSwitchState, new Date("2026-07-19T04:00:30.000Z")), false);

assert.equal(persistedModelSwitchState.batteryLearning.switchAfterSlotEnd, null);


const solarHeadroomState: Record<string, any> = {
  solarHeadroomHoldUntil: "2026-07-19T05:00:00.000Z",
  solarHeadroomClearChecks: 4,
};

assert.deepEqual(updateAdaptiveChargingSolarHeadroomHold(solarHeadroomState, true, modelSwitchNow), {
  active: true,
  released: false,
  expired: false,
});

assert.equal(solarHeadroomState.solarHeadroomClearChecks, 0);

assert.equal(updateAdaptiveChargingSolarHeadroomHold(solarHeadroomState, false, modelSwitchNow).active, true);

assert.equal(solarHeadroomState.solarHeadroomClearChecks, 1);

assert.deepEqual(updateAdaptiveChargingSolarHeadroomHold(solarHeadroomState, false, modelSwitchNow), {
  active: false,
  released: true,
  expired: false,
});

assert.equal(solarHeadroomState.solarHeadroomHoldUntil, null);

assert.equal(solarHeadroomState.solarHeadroomClearChecks, 0);


const chargeCurveEvidence: any[] = [
  ...Array.from({ length: 60 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-20T01:00:00.000Z") + index * 30_000).toISOString(),
    socPercent: 80 + index % 5,
    batteryChargingW: 1700,
    sessionId: `session-${index % 3}`,
    day: index % 2 ? "2026-07-20" : "2026-07-21",
  })),
  ...Array.from({ length: 60 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-22T01:00:00.000Z") + index * 30_000).toISOString(),
    socPercent: 85 + index % 5,
    batteryChargingW: 1400,
    sessionId: `session-${index % 3}`,
    day: index % 2 ? "2026-07-22" : "2026-07-23",
  })),
  ...Array.from({ length: 60 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-24T01:00:00.000Z") + index * 30_000).toISOString(),
    socPercent: 90 + index % 5,
    batteryChargingW: 1000,
    sessionId: `session-${index % 3}`,
    day: index % 2 ? "2026-07-24" : "2026-07-25",
  })),
  ...Array.from({ length: 60 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-26T01:00:00.000Z") + index * 30_000).toISOString(),
    socPercent: 95 + index % 5,
    batteryChargingW: 500,
    sessionId: `session-${index % 3}`,
    day: index % 2 ? "2026-07-26" : "2026-07-27",
  })),
];

const learnedChargeCurve = buildBatteryChargePowerCurve(chargeCurveEvidence, 2192, {
  source: "configured",
  activeWatts: 2192,
  candidateWatts: 2192,
  sampleCount: 120,
  sessionCount: 3,
  distinctDays: 2,
  dispersionPercent: 0,
  blockers: [],
});

assert.deepEqual(learnedChargeCurve.map((band: any) => Math.round(band.activeWatts)), [2192, 1700, 1400, 1000, 500]);

assert.ok(learnedChargeCurve.slice(1).every((band: any) => band.source === "learned"));

const sparseChargeCurve = buildBatteryChargePowerCurve(chargeCurveEvidence.slice(0, 20), 2192, {
  source: "configured",
  activeWatts: 2192,
  candidateWatts: 2192,
  blockers: [],
});

assert.equal(sparseChargeCurve[1].source, "configured");

assert.match(sparseChargeCurve[1].blockers.join("; "), /more samples required/);


const taperedDurationMs = estimateChargeDurationMs({
  targetWh: 2989,
  startSocPercent: 42,
  whPerSocPoint: 54,
  powerCurve: learnedChargeCurve,
  fallbackWatts: 2192,
});

assert.ok(taperedDurationMs > 2989 / 2192 * 3_600_000);

assert.ok(taperedDurationMs < 2 * 3_600_000);

assert.ok(estimateDeliverableChargeWh({
  durationMs: taperedDurationMs,
  startSocPercent: 42,
  whPerSocPoint: 54,
  powerCurve: learnedChargeCurve,
  fallbackWatts: 2192,
}) >= 2988);

const taperedTiming = adaptiveChargingTimingProfile({
  requiredWh: 2989,
  startSocPercent: 42,
  whPerSocPoint: 54,
  powerCurve: learnedChargeCurve,
  fallbackWatts: 2192,
  windowDurationMs: 2 * 3_600_000,
});

assert.ok(taperedTiming.timingReserveMs >= 5 * 60_000);

assert.ok(taperedTiming.scheduledDurationMs > taperedDurationMs);

assert.equal(taperedTiming.timeConstrainedWh, 0);

const taperWindowStart = Date.parse("2026-08-30T02:00:00.000Z");

const taperWindowEnd = taperWindowStart + 2 * 3_600_000;

const taperTimeline = Array.from({ length: 4 }, (_: any, index: any) => ({
  startMs: taperWindowStart + index * 1_800_000,
  endMs: taperWindowStart + (index + 1) * 1_800_000,
  netKwh: 0,
  highSolarNetKwh: 0,
  chargeCapacityKwh: 1.096,
  band: { label: "Daytime", yenPerKwh: 12.6 },
  rateWindowStartMs: taperWindowStart,
  rateWindowEndMs: taperWindowEnd,
}));

const taperPlan = planChronologicalDiscountedCharging({
  timeline: taperTimeline,
  currentStoredKwh: 5.4 * 0.42,
  capacityKwh: 5.4,
  dischargeFloorKwh: 0.54,
  maximumTargetPercent: 42 + 2989 / 54,
  maximumChargeWatts: 2192,
  chargePowerCurve: learnedChargeCurve,
  chargeWhPerSocPoint: 54,
  chargeToStoredRatio: 1,
});

assert.ok(Math.abs(taperPlan.plannedChargeKwh - 2.989) < 0.005);

assert.ok(new Date(taperPlan.slots[0].start).getTime() < taperWindowEnd - 2989 / 2192 * 3_600_000);

assert.equal(Math.round(taperPlan.slots.reduce((sum: any, slot: any) => sum + slot.targetWh, 0)), 2989);

const unvalidatedCurve = learnedChargeCurve.map((band: any) => (
  band.minSoc >= 80 ? { ...band, source: "configured", activeWatts: 2192 } : band
));

const conservativeTaperPlan = planChronologicalDiscountedCharging({
  timeline: taperTimeline,
  currentStoredKwh: 5.4 * 0.42,
  capacityKwh: 5.4,
  dischargeFloorKwh: 0.54,
  maximumTargetPercent: 42 + 2989 / 54,
  maximumChargeWatts: 2192,
  chargePowerCurve: unvalidatedCurve,
  chargeWhPerSocPoint: 54,
  chargeToStoredRatio: 1,
});

assert.equal(new Date(conservativeTaperPlan.slots[0].start).getTime(), taperWindowStart);


// Timing reserve must become usable continuous charging time, not pauses at
// each half-hour quota. Device mutations go only to the central simulator.
assert.equal(conservativeTaperPlan.slots.length, 1);

assert.equal(conservativeTaperPlan.slots[0].end, new Date(taperWindowEnd).toISOString());

const continuousSimulator = createDeviceSimulator({ state: { battery: { chargeTargetAccounting: "session-total" } } });

const continuousExecute = (action: any, payload: any) => continuousSimulator.execute(
  action, { host: "10.250.0.10", "target-wh": payload.targetWh },
  payload.mode ? [payload.mode] : [],
);

const continuousSlot = conservativeTaperPlan.slots[0];

await executeAdaptiveChargeStart(continuousSlot, { execute: continuousExecute });

let continuousState = cleanAdaptiveChargingState({
  owner: "adaptiveCharging",
  activeSlot: continuousSlot,
  activePlanCreatedAt: "original",
  activeChargedKwh: 0.9,
  activeChargeSession: {
    startedAt: continuousSlot.start, requestedWh: continuousSlot.targetWh,
    slotEnd: continuousSlot.end, startSocPercent: 34, latestSocPercent: 50,
  },
});

const checkpoint = new Date(taperWindowStart + 1_800_000);

const checkpointPlan: Record<string, any> = {
  createdAt: "checkpoint",
  slots: [{ ...continuousSlot, start: checkpoint.toISOString(), targetWh: 2000 }],
};

assert.equal(await updateActiveAdaptiveChargingObjective(
  continuousState, checkpointPlan, checkpoint, continuousExecute, 50,
), true);

assert.equal(continuousState.activeSlot.targetWh, 2900);

assert.equal(continuousState.activeChargedKwh, 0.9);

assert.equal(continuousState.activeChargeSession.requestedWh, 2900);

assert.equal(continuousSimulator.snapshot().battery.targetWh, 2900);

assert.deepEqual(continuousSimulator.calls.map((call: any) => call.command), ["charge", "charge"]);

const callsAtCheckpoint = continuousSimulator.calls.length;

await updateActiveAdaptiveChargingObjective(continuousState, checkpointPlan, checkpoint, continuousExecute, 50);

assert.equal(continuousSimulator.calls.length, callsAtCheckpoint);

continuousState = cleanAdaptiveChargingState(JSON.parse(JSON.stringify(continuousState)));

assert.equal(continuousState.activeSlot.continuousWindowCharge, true);

assert.equal(continuousState.activeChargedKwh, 0.9);

assert.ok((adaptiveChargingSlotEndDelayMs(continuousState, checkpoint) ?? 0) > 1_800_000);

const beforeFailedUpdate = structuredClone(continuousState);

continuousSimulator.failNext("charge");

await assert.rejects(updateActiveAdaptiveChargingObjective(
  continuousState, { ...checkpointPlan, createdAt: "changed", slots: [{ ...continuousSlot, targetWh: 1800 }] },
  checkpoint, continuousExecute, 50,
), /simulated failure/);

assert.deepEqual(continuousState, beforeFailedUpdate);

// A reduced SOC objective stops without sending another charging request.
const beforeSocStop = continuousSimulator.calls.length;

await updateActiveAdaptiveChargingObjective(
  continuousState, { ...checkpointPlan, createdAt: "soc-reduced", slots: [{ ...continuousSlot, targetWh: 100, targetSocPercent: 50 }] },
  checkpoint, continuousExecute, 50,
);

assert.equal(continuousSimulator.calls.length, beforeSocStop);

assert.equal(continuousState.activeSlot.targetSocPercent, 50);

const boundaryResult = await enforceAdaptiveChargingSlotEndDeadline(adaptiveChargingSlotEndKey(continuousState), {
  now: new Date(taperWindowEnd), readState: async () => continuousState,
  release: async (state: any) => { await continuousExecute("set-mode", { mode: "auto" }); state.owner = null; },
  suspend: async () => assert.fail("The continuous window must end in Auto"),
  writeState: async () => {},
});

assert.equal(boundaryResult.stopped, true);

assert.equal(continuousSimulator.snapshot().battery.operationMode, "auto");


// September 9: the remaining target at 11:30 (3272 Wh) must never replace
// the device's session-total target (4369 Wh). Exercise actual energy advance.
const cutoffSimulator = createDeviceSimulator({ state: { battery: {
  stateOfChargePercent: 15, dischargeLimitPercent: 0,
  chargeTargetAccounting: "session-total",
} } });

const cutoffExecute = (action: any, payload: any) => cutoffSimulator.execute(action,
  { host: "10.250.0.10", "target-wh": payload.targetWh }, payload.mode ? [payload.mode] : []);

const cutoffStart = "2026-09-09T02:00:24.843Z";

const cutoffSlot: Record<string, any> = { ...continuousSlot, start: cutoffStart, end: "2026-09-09T04:00:00.000Z",
  windowStart: "2026-09-09T02:00:00.000Z", windowEnd: "2026-09-09T04:00:00.000Z", targetWh: 4368, targetSocPercent: 100 };

await executeAdaptiveChargeStart(cutoffSlot, { execute: cutoffExecute });

let cutoffState = cleanAdaptiveChargingState({ owner: "adaptiveCharging", activeSlot: { ...cutoffSlot, deviceTargetWh: 4368 },
  activePlanCreatedAt: "initial", activeChargedKwh: 0,
  activeChargeSession: { startedAt: cutoffStart, requestedWh: 4368, slotEnd: cutoffSlot.end },
});

let cutoffPrevious = Date.parse(cutoffStart);

for (const [at, remaining] of [
  ["2026-09-09T02:30:26.975Z", 3272], ["2026-09-09T02:35:58.409Z", 3070],
  ["2026-09-09T03:00:28.592Z", 2175], ["2026-09-09T03:30:02.433Z", 1095],
]) {
  cutoffSimulator.advance(Date.parse(String(at)) - cutoffPrevious);
  cutoffPrevious = Date.parse(String(at));
  cutoffState.activeChargedKwh = cutoffSimulator.snapshot().battery.sessionChargedWh / 1000;
  await updateActiveAdaptiveChargingObjective(cutoffState,
    { createdAt: String(at), slots: [{ ...cutoffSlot, start: String(at), targetWh: Number(remaining) }] },
    new Date(String(at)), cutoffExecute, cutoffSimulator.snapshot().battery.stateOfChargePercent);
  cutoffState = cleanAdaptiveChargingState(JSON.parse(JSON.stringify(cutoffState)));
  assert.equal(cutoffSimulator.snapshot().battery.targetWh, 4369);
}

cutoffSimulator.advance(Date.parse(cutoffSlot.end) - cutoffPrevious);

assert.ok(cutoffSimulator.snapshot().battery.sessionChargedWh > 4350, "Use the final half-hour instead of stopping at 3274 Wh");

assert.deepEqual(cutoffSimulator.calls.map((call: any) => call.command), ["charge", "charge"]);

// A legacy state may claim the correct total while the device has the old,
// incorrectly reduced register. Repair it even without a new plan revision.
delete (cutoffState.activeSlot as { deviceTargetWh?: unknown }).deviceTargetWh;

cutoffState.activeChargedKwh = 3.274;

await updateActiveAdaptiveChargingObjective(cutoffState,
  { createdAt: cutoffState.activePlanCreatedAt, slots: [{ ...cutoffSlot, targetWh: 1095 }] },
  new Date("2026-09-09T03:31:00Z"), cutoffExecute, 76);

assert.equal(cutoffState.activeSlot.deviceTargetWh, 4369);

assert.equal(cutoffSimulator.snapshot().battery.targetWh, 4369);


const idleStart = new Date("2026-09-09T03:31:00Z");

const idleState = cleanAdaptiveChargingState({ ...cutoffState,
  plan: { slots: [{ ...cutoffSlot, targetWh: 4369 }] },
  activeWindowExecution: { key: "idle", windowStart: cutoffSlot.windowStart, windowEnd: cutoffSlot.windowEnd,
    plannedWh: 4369, deliveredWh: 0, latestSocPercent: 76 },
});

const idleStatus: Record<string, any> = { energy: { battery: { instant_power: { value: 0 }, remaining_percent: { value: 76 }, operation_mode: { value: "charging" } } } };

const idleCalls: any[] = [];

const idleExecute = async (action: any, payload: any) => { idleCalls.push({ action, payload }); };

assert.equal(await recoverIdleAdaptiveCharge(idleState, idleStatus, idleStart, idleExecute), false);

const unavailablePower = structuredClone(idleStatus);

unavailablePower.energy.battery.instant_power.value = null;

assert.equal(await recoverIdleAdaptiveCharge(idleState, unavailablePower, new Date(+idleStart + 30_000), idleExecute), false);

assert.equal(idleState.activeChargeSession.idleSince, null, "Missing telemetry is not an idle sample");

for (const seconds of [60, 90, 120]) {
  assert.equal(await recoverIdleAdaptiveCharge(idleState, idleStatus, new Date(+idleStart + seconds * 1000), idleExecute), false);
}

assert.equal(await recoverIdleAdaptiveCharge(idleState, idleStatus, new Date(+idleStart + 150_000), idleExecute), true);

assert.deepEqual(idleCalls, [{ action: "set-mode", payload: { mode: "auto" } }]);

assert.equal(idleState.owner, null);

assert.equal(idleState.activeWindowExecution.deliveredWh, 3274);

assert.equal(idleState.interruptedCharge!.remainingWh, 1095);

assert.equal(idleState.plan.slots[0].targetWh, 1095);

assert.equal(cleanAdaptiveChargingState(idleState).activeWindowExecution.idleRecoveryCount, 1);

await cutoffExecute("set-mode", { mode: "auto" });

await executeAdaptiveChargeStart(idleState.plan.slots[0], { execute: cutoffExecute });

assert.equal(cutoffSimulator.snapshot().battery.sessionChargedWh, 0, "An explicit Auto transition starts a fresh device session");

assert.equal(cutoffSimulator.snapshot().battery.targetWh, 1095);

cutoffSimulator.advance(1095 / 2192 * 3_600_000);

assert.ok(Math.abs(cutoffSimulator.snapshot().battery.sessionChargedWh + idleState.activeWindowExecution.deliveredWh - 4369) < 0.001);

// Slow taper must not trigger recovery, and recovery is bounded per window.
for (const [power, mode, count] of [[1, "charging", 0], [0, "standby", 0], [0, "charging", 2]]) {
  const protectedState = cleanAdaptiveChargingState({ ...cutoffState,
    activeWindowExecution: { ...idleState.activeWindowExecution, idleRecoveryCount: count },
    activeChargeSession: { ...cutoffState.activeChargeSession, idleSince: idleStart.toISOString(), idleCheckedAt: new Date(+idleStart + 120_000).toISOString() },
  });
  const protectedStatus = structuredClone(idleStatus);
  protectedStatus.energy.battery.instant_power.value = power;
  protectedStatus.energy.battery.operation_mode.value = mode;
  assert.equal(await recoverIdleAdaptiveCharge(protectedState, protectedStatus, new Date(+idleStart + 150_000),
    async () => assert.fail("Unexpected idle recovery")), false);
}


const separateSlots: any[] = [
  { ...continuousSlot, end: new Date(taperWindowStart + 1_800_000).toISOString(), targetWh: 500 },
  { ...continuousSlot, start: new Date(taperWindowStart + 3_600_000).toISOString(), targetWh: 500 },
];

assert.equal(mergeAdaptiveChargingSlots(separateSlots).length, 2, "Preserve intentional gaps");

assert.equal(mergeAdaptiveChargingSlots([
  separateSlots[0], { ...separateSlots[1], start: separateSlots[0].end, yenPerKwh: 99 },
]).length, 2, "Never merge different rates");


// Reproducible taper is not necessarily low-dispersion power. This regression
// characterizes the current learning gate; extra copies do not cure rejection.
const decliningCurveEvidence = Array.from({ length: 120 }, (_: any, index: any) => ({
  at: new Date(taperWindowStart + index * 30_000).toISOString(),
  socPercent: 90 + index % 5,
  batteryChargingW: [2000, 1400, 900, 600, 400][index % 5],
  sessionId: `repeat-${Math.floor(index / 40)}`,
  day: `2026-09-0${1 + Math.floor(index / 40)}`,
}));

const decliningCurve = buildBatteryChargePowerCurve(decliningCurveEvidence, 2192, { activeWatts: 2192 });

assert.equal(decliningCurve[3].source, "configured");

assert.deepEqual(decliningCurve[3].blockers, ["charge-power dispersion must be within 20%"]);

assert.equal(Math.round(conservativeTaperPlan.slots.reduce((sum: any, slot: any) => sum + slot.targetWh, 0)), 2989);


const exportStatus: Record<string, any> = {
  meter: {
    grid_export_power: { value: 150 },
    grid_import_power: { value: 0 },
    house_demand_power: { value: 368 },
  },
  energy: {
    battery: { instant_power: { value: 2192 } },
    solar: { instant_power: { value: 510 } },
    fuel_cells: [],
  },
};

const contradictoryExport = adaptiveChargingExportEvidence(exportStatus);

assert.equal(contradictoryExport.coherent, false);

const exportState: Record<string, any> = {};

assert.equal(updateAdaptiveChargingExportConfirmation(exportState, contradictoryExport, modelSwitchNow).rejected, true);

const coherentExport = adaptiveChargingExportEvidence({
  ...exportStatus,
  energy: { ...exportStatus.energy, battery: { instant_power: { value: 0 } } },
});

assert.equal(coherentExport.coherent, true);

assert.equal(updateAdaptiveChargingExportConfirmation(exportState, coherentExport, modelSwitchNow).pending, true);

assert.equal(updateAdaptiveChargingExportConfirmation(
  exportState,
  coherentExport,
  new Date(modelSwitchNow.getTime() + 30_000),
).confirmed, true);

const meterOnlyExport: Record<string, any> = { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW: 120 };

const meterOnlyState: Record<string, any> = {};

assert.equal(updateAdaptiveChargingExportConfirmation(meterOnlyState, meterOnlyExport, modelSwitchNow).confirmed, false);

assert.equal(updateAdaptiveChargingExportConfirmation(meterOnlyState, meterOnlyExport, new Date(modelSwitchNow.getTime() + 30_000)).confirmed, false);

assert.equal(updateAdaptiveChargingExportConfirmation(meterOnlyState, meterOnlyExport, new Date(modelSwitchNow.getTime() + 60_000)).confirmed, true);

assert.equal(updateAdaptiveChargingExportConfirmation(
  meterOnlyState,
  { aboveThreshold: false, balanceAvailable: false, coherent: false, gridExportW: 0 },
  new Date(modelSwitchNow.getTime() + 90_000),
).cleared, true);

assert.ok(discountedBandOccurrences(adaptiveChargingConfig, prewindowNow).length >= 2);


const learnedChargingPerformance = cleanAdaptiveChargingPerformance({
  samples: Array.from({ length: 10 }, (_: any, index: any) => ({
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

assert.ok(Math.abs(learnedChargingPerformance.demandImpactWattsPerKw! + 100) < 0.001);

assert.equal("estimatedStorageEfficiencyPercent" in learnedChargingPerformance.sessions[0], false);

const configuredChargePower = effectiveAdaptiveChargeWatts(adaptiveChargingConfig, {
  chargingPerformance: learnedChargingPerformance,
});

assert.equal(configuredChargePower.source, "configured");

assert.equal(configuredChargePower.effectiveWatts, 2000);

const configuredBatteryModel = effectiveBatteryLearningModel(adaptiveChargingConfig, {
  batteryLearning: {
    version: 2,
    charge: { source: "configured", candidateWhPerSocPoint: 50 },
    discharge: { source: "configured", candidateWhPerSocPoint: 48 },
    power: { source: "configured", candidateWatts: 1950 },
  },
});

assert.equal(configuredBatteryModel.charge.source, "configured");

assert.equal(configuredBatteryModel.charge.whPerSocPoint, 100);

assert.equal(configuredBatteryModel.discharge.whPerSocPoint, 100);

assert.equal(configuredBatteryModel.power.source, "configured");

assert.equal(configuredBatteryModel.power.effectiveWatts, 2000);

assert.equal(configuredBatteryModel.chargeToStoredRatio, 1);


const historicalChargeRollups = Array.from({ length: 10 }, (_: any, index: any) => (
  batteryLearningRollup(index + 1, "charge")
));

const freshChargeRollups = Array.from({ length: 5 }, (_: any, index: any) => (
  batteryLearningRollup(index + 11, "charge")
));

const historicalDischargeRollups = Array.from({ length: 10 }, (_: any, index: any) => (
  batteryLearningRollup(index + 1, "discharge")
));

const freshDischargeRollups = Array.from({ length: 5 }, (_: any, index: any) => (
  batteryLearningRollup(index + 11, "discharge")
));

const exactBatteryConfig = cleanConfig({
  batteryCapabilities: { usableCapacityKwh: 5.4, maximumChargeWatts: 2192 },
});

const candidateOnlyBatteryModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [...historicalChargeRollups, ...historicalDischargeRollups],
  { migratedAt: "2026-07-11T00:00:00.000Z" },
  new Date("2026-07-11T00:00:01.000Z"),
);

assert.equal(candidateOnlyBatteryModel.charge.candidateWhPerSocPoint, 50);

assert.equal(candidateOnlyBatteryModel.charge.source, "configured");

assert.equal(candidateOnlyBatteryModel.charge.activeWhPerSocPoint, 54);

assert.equal(candidateOnlyBatteryModel.discharge.source, "configured");

assert.match(candidateOnlyBatteryModel.charge.blockers.join("; "), /forward validations/);

const candidateOnlyEffectiveModel = effectiveBatteryLearningModel(exactBatteryConfig, {
  batteryLearning: candidateOnlyBatteryModel,
});

assert.equal(candidateOnlyEffectiveModel.charge.whPerSocPoint, 54);

assert.equal(candidateOnlyEffectiveModel.discharge.whPerSocPoint, 54);

assert.equal(candidateOnlyEffectiveModel.power.effectiveWatts, 2192);

assert.equal(candidateOnlyEffectiveModel.chargeToStoredRatio, 1);

const configuredFallbackPlan = planChronologicalDiscountedCharging({
  timeline: [{
    startMs: Date.parse("2026-07-11T01:00:00.000Z"),
    endMs: Date.parse("2026-07-11T02:00:00.000Z"),
    netKwh: 0,
    highSolarNetKwh: 0,
    chargeCapacityKwh: 2.192,
    band: { label: "Discount", yenPerKwh: 12 },
    rateWindowStartMs: Date.parse("2026-07-11T01:00:00.000Z"),
    rateWindowEndMs: Date.parse("2026-07-11T02:00:00.000Z"),
  }],
  currentStoredKwh: 0.54,
  capacityKwh: 5.4,
  dischargeFloorKwh: 0.54,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2192,
  chargeToStoredRatio: 1,
});

assert.equal(configuredFallbackPlan.plannedChargeKwh, 2.192);

assert.equal(configuredFallbackPlan.plannedStoredChargeKwh, 2.192);


const steadyPowerSamples: any[] = [
  ...Array.from({ length: 40 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-11T01:00:00.000Z") + index * 30_000).toISOString(),
    batteryChargingW: 2000,
  })),
  ...Array.from({ length: 40 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-12T01:00:00.000Z") + index * 30_000).toISOString(),
    batteryChargingW: 2000,
  })),
  ...Array.from({ length: 40 }, (_: any, index: any) => ({
    at: new Date(Date.parse("2026-07-12T03:00:00.000Z") + index * 30_000).toISOString(),
    batteryChargingW: 2000,
  })),
];

const activeBatteryModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [
    ...historicalChargeRollups,
    ...freshChargeRollups,
    ...historicalDischargeRollups,
    ...freshDischargeRollups,
  ],
  {
    migratedAt: "2026-07-11T00:00:00.000Z",
    performance: { samples: steadyPowerSamples },
  },
  new Date("2026-07-16T00:00:00.000Z"),
);

assert.equal(activeBatteryModel.charge.source, "learned");

assert.equal(activeBatteryModel.discharge.source, "learned");

assert.equal(activeBatteryModel.charge.activeWhPerSocPoint, 50);

assert.equal(activeBatteryModel.discharge.activeWhPerSocPoint, 50);

assert.equal(activeBatteryModel.charge.validation.count, 5);

assert.equal(activeBatteryModel.charge.validation.meanAbsoluteErrorSoc, 0);

assert.equal(activeBatteryModel.power.source, "learned");

assert.equal(activeBatteryModel.power.activeWatts, 2000);

assert.equal(activeBatteryModel.power.postMigrationSampleCount, 120);

assert.equal(activeBatteryModel.status, "active");

assert.equal(activeBatteryModel.charge.validation.seenIds.length, 5);

const lowerPlateauPowerModel = buildBatteryLearningModel(
  cleanConfig({ batteryCapabilities: { usableCapacityKwh: 5.4, maximumChargeWatts: 3000 } }),
  [],
  {
    migratedAt: "2026-07-11T00:00:00.000Z",
    performance: { samples: steadyPowerSamples },
  },
  new Date("2026-07-16T00:00:00.000Z"),
);

assert.equal(lowerPlateauPowerModel.power.source, "learned");

assert.equal(lowerPlateauPowerModel.power.candidateWatts, 2000);

assert.equal(lowerPlateauPowerModel.power.activeWatts, 2000);

assert.equal(lowerPlateauPowerModel.power.configuredWatts, 3000);

const retainedSnapshotModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [],
  { ...activeBatteryModel, performance: { samples: [] } },
  new Date("2026-10-20T00:00:00.000Z"),
);

assert.equal(retainedSnapshotModel.charge.source, "learned");

assert.equal(retainedSnapshotModel.charge.activeWhPerSocPoint, 50);

assert.equal(retainedSnapshotModel.discharge.source, "learned");

assert.equal(retainedSnapshotModel.discharge.activeWhPerSocPoint, 50);

assert.equal(retainedSnapshotModel.power.source, "learned");

assert.equal(retainedSnapshotModel.power.activeWatts, 2000);

assert.equal(retainedSnapshotModel.charge.activationSnapshot!.candidateWhPerSocPoint, 50);


const independentlyActiveChargeModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [...historicalChargeRollups, ...freshChargeRollups],
  { migratedAt: "2026-07-11T00:00:00.000Z" },
  new Date("2026-07-16T00:00:00.000Z"),
);

assert.equal(independentlyActiveChargeModel.charge.source, "learned");

assert.equal(independentlyActiveChargeModel.discharge.source, "configured");

assert.equal(independentlyActiveChargeModel.status, "active");


const driftedChargeRollups = Array.from({ length: 3 }, (_: any, index: any) => (
  batteryLearningRollup(index + 16, "charge", { energyWh: 1600 })
));

const degradedBatteryModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [
    ...historicalChargeRollups,
    ...freshChargeRollups,
    ...driftedChargeRollups,
    ...historicalDischargeRollups,
    ...freshDischargeRollups,
  ],
  { ...activeBatteryModel, performance: { samples: steadyPowerSamples } },
  new Date("2026-07-19T00:00:00.000Z"),
);

assert.equal(degradedBatteryModel.charge.source, "configured");

assert.ok(degradedBatteryModel.charge.demotedAt);

assert.match(degradedBatteryModel.charge.demotionReason!, /drift|validation/);

assert.equal(degradedBatteryModel.status, "degraded");


const rejectedBatteryObservations = extractBatteryLearningObservations([
  batteryLearningRollup(1, "charge", { startSoc: 70, endSoc: 100 }),
  batteryLearningRollup(2, "charge", { coverageSeconds: 1000 }),
  batteryLearningRollup(3, "charge", { manualAction: true }),
  batteryLearningRollup(4, "discharge", { startSoc: 20, endSoc: 40 }),
]);

assert.equal(rejectedBatteryObservations.length, 4);

assert.match(rejectedBatteryObservations[0].rejectionReason!, /censored upper SOC/);

assert.match(rejectedBatteryObservations[1].rejectionReason!, /coverage/);

assert.match(rejectedBatteryObservations[2].rejectionReason!, /manual action/);

assert.match(rejectedBatteryObservations[3].rejectionReason!, /reversed/);


const censoredTailObservations = extractBatteryLearningObservations([
  {
    ...batteryLearningRollup(5, "charge", { startSoc: 40, endSoc: 70, energyWh: 1500 }),
    rollupEnd: "2026-07-05T00:30:00.000Z",
  },
  {
    ...batteryLearningRollup(5, "charge", { startSoc: 70, endSoc: 100, energyWh: 1200 }),
    rollupStart: "2026-07-05T00:30:00.000Z",
    rollupEnd: "2026-07-05T01:00:00.000Z",
  },
]);

assert.equal(censoredTailObservations.length, 2);

assert.equal(censoredTailObservations[0].eligible, true);

assert.equal(censoredTailObservations[0].whPerSocPoint, 50);

assert.equal(censoredTailObservations[1].eligible, false);


const completedChargeState: Record<string, any> = {
  activeChargedKwh: 1,
  activeChargeSession: {
    startedAt: "2026-07-11T00:00:00.000Z",
    requestedWh: 1000,
    startSocPercent: 20,
    latestSocPercent: 30,
    capacityKwh: 10,
  },
  chargingPerformance: cleanAdaptiveChargingPerformance(),
};

const completedChargeSession = finalizeAdaptiveChargeSession(
  completedChargeState as ReturnType<typeof cleanAdaptiveChargingState>,
  "Planned charge target reached",
  new Date("2026-07-11T01:00:00.000Z"),
);

assert.equal(completedChargeSession!.deliveredWh, 1000);

assert.equal(completedChargeSession!.averageChargeWatts, 1000);

assert.equal("estimatedStorageEfficiencyPercent" in completedChargeSession!, false);

assert.equal("capacityKwh" in completedChargeSession!, false);

assert.equal(completedChargeSession!.modelVersion, 3);

assert.equal(completedChargeState.chargingPerformance.sessionCount, 1);

assert.equal(completedChargeState.activeChargeSession, null);


const boundaryEstimatedChargeState: Record<string, any> = {
  activeChargedKwh: 0.9,
  activeChargeSession: {
    startedAt: "2026-07-11T03:30:00.000Z",
    requestedWh: 1000,
    startSocPercent: 20,
    latestSocPercent: 38,
    latestChargingW: 2192,
    lastSampleAt: "2026-07-11T03:57:00.000Z",
    slotEnd: "2026-07-11T04:00:00.000Z",
  },
  chargingPerformance: cleanAdaptiveChargingPerformance(),
};

const boundaryEstimatedChargeSession = finalizeAdaptiveChargeSession(
  boundaryEstimatedChargeState as ReturnType<typeof cleanAdaptiveChargingState>,
  "Planned discounted window ended",
  new Date("2026-07-11T04:00:00.000Z"),
);

assert.equal(boundaryEstimatedChargeSession!.deliveredWh, 1000);

assert.equal(boundaryEstimatedChargeSession!.estimatedDeliveryWh, 100);


const nonBoundaryChargeState: Record<string, any> = {
  activeChargedKwh: 0.9,
  activeChargeSession: {
    startedAt: "2026-07-11T03:30:00.000Z",
    requestedWh: 1000,
    startSocPercent: 20,
    latestSocPercent: 38,
    latestChargingW: 2192,
    lastSampleAt: "2026-07-11T03:57:00.000Z",
    slotEnd: "2026-07-11T04:00:00.000Z",
  },
  chargingPerformance: cleanAdaptiveChargingPerformance(),
};

const nonBoundaryChargeSession = finalizeAdaptiveChargeSession(
  nonBoundaryChargeState as ReturnType<typeof cleanAdaptiveChargingState>,
  "Charging Demand Guard interrupted Adaptive Charging",
  new Date("2026-07-11T04:00:00.000Z"),
);

assert.equal(nonBoundaryChargeSession!.deliveredWh, 900);

assert.equal(nonBoundaryChargeSession!.estimatedDeliveryWh, 0);


const executionOccurrence: Record<string, any> = {
  start: "2026-07-11T11:00:00.000Z",
  end: "2026-07-11T13:00:00.000Z",
  band: { label: "Day discount", yenPerKwh: 12.6 },
};

const executionState: Record<string, any> = {
  owner: null,
  activeChargedKwh: 0,
  chargingPerformance: cleanAdaptiveChargingPerformance(),
  windowSummaries: [],
};

syncAdaptiveChargingWindowExecution(executionState as ReturnType<typeof cleanAdaptiveChargingState>, executionOccurrence as { start: string; end: string; band: { label: string; yenPerKwh: number } }, {
  slots: [{
    start: "2026-07-11T12:30:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 1000,
  }],
}, 20, new Date("2026-07-11T11:00:00.000Z"));

executionState.owner = "adaptiveCharging";

executionState.activeChargedKwh = 0.2;

syncAdaptiveChargingWindowExecution(executionState as ReturnType<typeof cleanAdaptiveChargingState>, executionOccurrence as { start: string; end: string; band: { label: string; yenPerKwh: number } }, {
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

finalizeAdaptiveChargeSession(executionState as ReturnType<typeof cleanAdaptiveChargingState>, "breaker interruption", new Date("2026-07-11T12:20:00.000Z"));

recordAdaptiveChargingWindowInterruption(
  executionState as ReturnType<typeof cleanAdaptiveChargingState>,
  new Date("2026-07-11T12:20:00.000Z"),
);

assert.equal(completeAdaptiveChargingWindowInterruption(
  executionState as ReturnType<typeof cleanAdaptiveChargingState>,
  new Date("2026-07-11T12:30:00.000Z"),
), 10 * 60_000);

syncAdaptiveChargingWindowExecution(executionState as ReturnType<typeof cleanAdaptiveChargingState>, executionOccurrence as { start: string; end: string; band: { label: string; yenPerKwh: number } }, {
  slots: [{
    start: "2026-07-11T12:40:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 400,
  }],
}, 30, new Date("2026-07-11T12:30:00.000Z"));

const executionSummary = finalizeAdaptiveChargingWindowExecution(
  executionState as ReturnType<typeof cleanAdaptiveChargingState>,
  31,
  new Date("2026-07-11T13:00:00.000Z"),
);

assert.equal(executionSummary!.plannedWh, 1000);

assert.equal(executionSummary!.deliveredWh, 600);

assert.equal(executionSummary!.unmetWh, 400);

assert.equal(executionSummary!.interruptionCount, 1);

assert.equal(executionSummary!.guardInterruptedMs, 10 * 60_000);

assert.equal(executionSummary!.estimatedDeliveryWh, 0);

assert.equal(executionSummary!.solarHeadroomInterruptionCount, 0);

assert.equal(executionSummary!.startSocPercent, 20);

assert.equal(executionSummary!.endSocPercent, 31);

assert.equal(executionState.windowSummaries.length, 1);

assert.equal(executionState.activeWindowExecution, null);

const persistedAdaptiveChargingExecution = cleanAdaptiveChargingState({
  breakerRecovery: {
    interruptedAt: "2026-07-11T00:00:00.000Z",
    cooldownUntil: "2026-07-11T00:03:00.000Z",
    consecutiveSafeChecks: 1,
  },
  windowSummaries: executionState.windowSummaries,
});

assert.equal(persistedAdaptiveChargingExecution.breakerRecovery.consecutiveSafeChecks, 1);

assert.equal(persistedAdaptiveChargingExecution.windowSummaries[0].unmetWh, 400);


const achievedState = cleanAdaptiveChargingState({ activeWindowExecution: {
  ...executionState.windowSummaries[0], plannedWh: 765, deliveredWh: 508,
  targetSocPercent: 84, latestSocPercent: 84,
} });

const achievedSummary = finalizeAdaptiveChargingWindowExecution(achievedState, 84);

assert.equal(achievedSummary!.unmetWh, 257, "Preserve the measured energy difference");

assert.equal(achievedSummary!.socTargetReached, true);

assert.equal(adaptiveChargingWindowHasShortfall(achievedSummary!), false);

const restoredSummary = cleanAdaptiveChargingState(achievedState).windowSummaries[0];

assert.equal(restoredSummary.socTargetReached, true);

assert.equal(restoredSummary.targetSocPercent, 84);

assert.equal(adaptiveChargingWindowHasShortfall({ ...achievedSummary!, socTargetReached: false }), true);

assert.equal(adaptiveChargingWindowHasShortfall({ unmetWh: 257 }), true, "Legacy summaries retain their meaning");

const missingSocState = cleanAdaptiveChargingState({ activeWindowExecution: {
  ...executionState.windowSummaries[0], targetSocPercent: 84,
  latestSocPercent: null, plannedWh: 765, deliveredWh: 508,
} });

const missingSocSummary = finalizeAdaptiveChargingWindowExecution(missingSocState, null);

assert.equal(missingSocSummary!.endSocPercent, null);

assert.equal(missingSocSummary!.socTargetReached, false);

const solarHeadroomExecution: Record<string, any> = {
  activeWindowExecution: { solarHeadroomInterruptionCount: 0 },
};

assert.equal(recordAdaptiveChargingSolarHeadroomInterruption(solarHeadroomExecution as ReturnType<typeof cleanAdaptiveChargingState>), 1);

assert.equal(solarHeadroomExecution.activeWindowExecution.solarHeadroomInterruptionCount, 1);

const optimizedSlots = optimizeDiscountedChargeSlots({
  config: adaptiveChargingConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 3, 0),
  requiredKwh: 4.5,
});

assert.equal(optimizedSlots.plannedChargeKwh, 4.5);

assert.equal(optimizedSlots.unmetChargeKwh, 0);

assert.equal(optimizedSlots.slots[0].yenPerKwh, 15);

assert.equal(optimizedSlots.slots.at(-1)!.yenPerKwh, 20);

assert.equal(optimizedSlots.slots.filter((slot: any) => slot.yenPerKwh === 15).at(-1)!.end, new Date(2026, 6, 12, 1, 0).toISOString());

const smallCharge = optimizeDiscountedChargeSlots({
  config: adaptiveChargingConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 3, 0),
  requiredKwh: 0.5,
});

assert.equal(smallCharge.slots.length, 1);

assert.equal(smallCharge.slots[0].start, new Date(2026, 6, 12, 0, 45).toISOString());

assert.equal(smallCharge.slots[0].end, new Date(2026, 6, 12, 1, 0).toISOString());

const standardOnly = optimizeDiscountedChargeSlots({
  config: adaptiveChargingConfig,
  start: new Date(2026, 6, 11, 12, 0),
  end: new Date(2026, 6, 11, 18, 0),
  requiredKwh: 2,
});

assert.equal(standardOnly.slots.length, 0);

assert.equal(standardOnly.unmetChargeKwh, 2);

const forecastDemandDoesNotRemoveSlots = optimizeDiscountedChargeSlots({
  config: adaptiveChargingConfig,
  start: new Date(2026, 6, 11, 23, 0),
  end: new Date(2026, 6, 12, 1, 0),
  requiredKwh: 1,
  demandBySlot: new Map([[new Date(2026, 6, 11, 23, 0).getTime(), 99_000]]),
});

assert.equal(forecastDemandDoesNotRemoveSlots.plannedChargeKwh, 1);

assert.equal(forecastDemandDoesNotRemoveSlots.unmetChargeKwh, 0);


const adaptiveChargingGuardRules: any[] = [{
  id: "guard-60a",
  name: "Charging Demand Guard",
  type: "backup-demand-guard",
  enabled: true,
  conditions: { breakerVoltage: 100, breakerAmps: 60, reserveAmps: 5 },
}];

const liveAdaptiveChargingHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3000 } },
}, adaptiveChargingConfig, {}, adaptiveChargingGuardRules);

assert.equal(liveAdaptiveChargingHeadroom.available, true);

assert.equal(liveAdaptiveChargingHeadroom.gridImportW, 3000);

assert.equal(adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 4000 } },
}, adaptiveChargingConfig, {}, adaptiveChargingGuardRules).available, false);

assert.equal(adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: null } },
}, adaptiveChargingConfig, {}, adaptiveChargingGuardRules).available, false);

const learnedHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3300 } },
}, adaptiveChargingConfig, { chargingPerformance: learnedChargingPerformance }, adaptiveChargingGuardRules);

assert.equal(learnedHeadroom.chargeWatts, 2000);

assert.equal(learnedHeadroom.thresholdW, 3300);

assert.equal(learnedHeadroom.available, true);

const enabledGuardRules: any[] = [{
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

assert.deepEqual(adaptiveChargingBreakerSettings(enabledGuardRules), {
  breakerVoltage: 100,
  breakerAmps: 50,
  reserveAmps: 2,
  breakerLimitW: 4800,
  ruleId: "guard-50a",
  ruleName: "Charging Demand Guard",
  source: "automation-rule",
  valid: true,
});

assert.equal(adaptiveChargingBreakerSettings([{
  ...enabledGuardRules[0],
  enabled: false,
}]).breakerLimitW, 4800);

assert.equal(adaptiveChargingBreakerSettings([]).valid, false);

assert.equal(Number.isNaN(adaptiveChargingBreakerSettings([]).breakerLimitW), true);

assert.deepEqual(adaptiveChargingAvailability(adaptiveChargingConfig, []), {
  available: false,
  reason: "Charging Demand Guard settings are unavailable",
});

assert.equal(adaptiveChargingAvailability(adaptiveChargingConfig, enabledGuardRules).available, true);

// A trailing sample with a null/empty SOC must not be coerced to 0%, and 0% is a
// legitimate value when it is genuinely reported.
assert.equal(latestFiniteSocPercent([{ timestamp: "2026-07-11T10:00:00.000Z", stateOfChargePercent: 40 }, { timestamp: "2026-07-11T11:00:00.000Z", stateOfChargePercent: null }]), 40);
assert.equal(latestFiniteSocPercent([{ timestamp: "2026-07-11T11:00:00.000Z", stateOfChargePercent: null }]), null);
assert.equal(latestFiniteSocPercent([{ timestamp: "2026-07-11T11:00:00.000Z", stateOfChargePercent: "" }]), null);
assert.equal(latestFiniteSocPercent([{ timestamp: "2026-07-11T11:00:00.000Z", stateOfChargePercent: undefined }]), null);
assert.equal(latestFiniteSocPercent([{ timestamp: "2026-07-11T10:00:00.000Z", stateOfChargePercent: 40 }, { timestamp: "2026-07-11T11:00:00.000Z", stateOfChargePercent: 0 }]), 0);
assert.equal(latestFiniteSocPercent([]), null);

const missingGuardHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 0 } },
}, adaptiveChargingConfig);

assert.equal(missingGuardHeadroom.available, false);

assert.equal(Number.isNaN(missingGuardHeadroom.thresholdW), true);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: 0 } },
}).available, false);

const guardRuleHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2380 } },
}, adaptiveChargingConfig, {}, enabledGuardRules);

assert.equal(guardRuleHeadroom.breakerLimitW, 4800);

assert.equal(guardRuleHeadroom.thresholdW, 2600);

assert.equal(guardRuleHeadroom.available, true);

assert.equal(adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2700 } },
}, adaptiveChargingConfig, {}, enabledGuardRules).available, false);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: 4799 } },
}, enabledGuardRules).available, true);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: 4800 } },
}, enabledGuardRules).available, false);

const initialWaitState: Record<string, any> = { log: [] };

const unavailableGuardHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 2700 } },
}, adaptiveChargingConfig, {}, enabledGuardRules);

assert.equal(logAdaptiveChargingInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:00:00.000Z"),
), true);

assert.match(initialWaitState.log[0].message, /Grid Import \(2700 W\)/);

assert.match(initialWaitState.log[0].message, /50 A - 2 A reserve at 100 V/);

assert.match(initialWaitState.log[0].message, /Guard limit \(4800 W\)/);

assert.match(initialWaitState.log[0].message, /required at or below \(2600 W\)/);

assert.equal(logAdaptiveChargingInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:01:00.000Z"),
), false);

assert.equal(logAdaptiveChargingInitialHeadroomWait(
  initialWaitState,
  unavailableGuardHeadroom,
  new Date("2026-07-11T00:05:00.000Z"),
), true);

const recoveryState: Record<string, any> = {};

beginAdaptiveChargingBreakerRecovery(
  recoveryState,
  adaptiveChargingLiveChargeHeadroom({ meter: { grid_import_power: { value: 4000 } } }, adaptiveChargingConfig, {}, adaptiveChargingGuardRules),
  new Date("2026-07-11T00:00:00.000Z"),
);

const safeRecoveryHeadroom = adaptiveChargingLiveChargeHeadroom({
  meter: { grid_import_power: { value: 3000 } },
}, adaptiveChargingConfig, {}, adaptiveChargingGuardRules);

const recoveryCheck1 = advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:00:30.000Z"),
);

assert.equal(recoveryCheck1.consecutiveSafeChecks, 1);

assert.equal(recoveryCheck1.ready, false);

recoveryState.log = [];

assert.equal(logAdaptiveChargingBreakerWait(
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

const recoveryCheck2 = advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:01:00.000Z"),
);

const recoveryCheck3 = advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:01:30.000Z"),
);

assert.equal(recoveryCheck2.shouldLog, false);

assert.equal(recoveryCheck3.consecutiveSafeChecks, 3);

assert.equal(recoveryCheck3.checksReady, true);

assert.equal(recoveryCheck3.cooldownReady, false);

const recoveryReady = advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:03:00.000Z"),
);

assert.equal(recoveryReady.ready, true);

const unsafeRecovery = advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  adaptiveChargingLiveChargeHeadroom({ meter: { grid_import_power: { value: 4000 } } }, adaptiveChargingConfig, {}, adaptiveChargingGuardRules),
  new Date("2026-07-11T00:03:30.000Z"),
);

assert.equal(unsafeRecovery.consecutiveSafeChecks, 0);

assert.equal(unsafeRecovery.ready, false);

assert.equal(advanceAdaptiveChargingBreakerRecovery(
  recoveryState,
  safeRecoveryHeadroom,
  new Date("2026-07-11T00:06:00.000Z"),
).shouldLog, true);

recoveryState.breakerRecovery.consecutiveSafeChecks = 3;

recoveryState.breakerRecovery.cooldownUntil = "2026-07-11T00:05:00.000Z";

assert.equal(adaptiveChargingBreakerRecoveryReady(recoveryState, new Date("2026-07-11T00:06:00.000Z")), true);

assert.equal(shouldHoldGuardStandbyForAdaptiveCharging({
  ...recoveryState,
  interruptedCharge: { slotEnd: "2026-07-11T00:30:00.000Z" },
}, new Date("2026-07-11T00:06:00.000Z")), false);

recoveryState.breakerRecovery.consecutiveSafeChecks = 2;

assert.equal(shouldHoldGuardStandbyForAdaptiveCharging({
  ...recoveryState,
  interruptedCharge: { slotEnd: "2026-07-11T00:30:00.000Z" },
}, new Date("2026-07-11T00:06:00.000Z")), true);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: 5400 } },
}, adaptiveChargingGuardRules).available, true);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: 5500 } },
}, adaptiveChargingGuardRules).available, false);

assert.equal(adaptiveChargingLiveImportSafety({
  meter: { grid_import_power: { value: null } },
}, adaptiveChargingGuardRules).available, false);

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


const activeAdaptiveChargingNow = new Date(2026, 6, 11, 23, 30);

const activeAdaptiveChargingSlot: Record<string, any> = {
  start: new Date(2026, 6, 11, 23, 0).toISOString(),
  end: new Date(2026, 6, 12, 0, 0).toISOString(),
  targetWh: 1000,
  targetSocPercent: 100,
};

assert.equal(activeAdaptiveChargingSlotStopReason({
  owner: "adaptiveCharging",
  activeSlot: activeAdaptiveChargingSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, adaptiveChargingConfig, {
  createdAt: "new-plan",
  slots: [{ ...activeAdaptiveChargingSlot, targetWh: 800 }],
}, activeAdaptiveChargingNow), null);

assert.match(activeAdaptiveChargingSlotStopReason({
  owner: "adaptiveCharging",
  activeSlot: activeAdaptiveChargingSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, adaptiveChargingConfig, {
  createdAt: "new-plan",
  slots: [{ ...activeAdaptiveChargingSlot, targetWh: 600 }],
}, activeAdaptiveChargingNow) ?? "", /remaining charge target/);

assert.match(activeAdaptiveChargingSlotStopReason({
  owner: "adaptiveCharging",
  activeSlot: activeAdaptiveChargingSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, adaptiveChargingConfig, {
  createdAt: "new-plan",
  slots: [],
}, activeAdaptiveChargingNow) ?? "", /no longer includes/);


const interruptedSlot: Record<string, any> = {
  start: "2026-07-11T12:00:00.000Z",
  end: "2026-07-11T12:30:00.000Z",
  windowEnd: "2026-07-11T13:00:00.000Z",
  targetWh: 1050,
};

const interruptedState: Record<string, any> = {
  activeSlot: interruptedSlot,
  activeChargedKwh: 0.3,
  plan: { slots: [interruptedSlot] },
};

const firstInterruption = preserveInterruptedAdaptiveCharge(
  interruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);

assert.equal(firstInterruption!.deliveredWh, 300);

assert.equal(firstInterruption!.remainingWh, 750);

assert.equal(interruptedState.plan.slots[0].targetWh, 750);


interruptedState.activeSlot = interruptedState.plan.slots[0];

interruptedState.activeChargedKwh = 0.2;

const repeatedInterruption = preserveInterruptedAdaptiveCharge(
  interruptedState,
  new Date("2026-07-11T12:20:00.000Z"),
);

assert.equal(repeatedInterruption!.deliveredWh, 200);

assert.equal(repeatedInterruption!.remainingWh, 550);

assert.equal(interruptedState.plan.slots[0].targetWh, 550);


const cappedLargerReplan = applyInterruptedChargeCap({
  slots: [{ ...interruptedSlot, targetWh: 900 }],
}, firstInterruption!, 2100, new Date("2026-07-11T12:15:00.000Z"));

assert.equal(cappedLargerReplan.plan.slots[0].targetWh, 750);

assert.equal(cappedLargerReplan.interruption!.remainingWh, 750);

const cappedSmallerReplan = applyInterruptedChargeCap({
  slots: [{ ...interruptedSlot, targetWh: 600 }],
}, firstInterruption!, 2100, new Date("2026-07-11T12:15:00.000Z"));

assert.equal(cappedSmallerReplan.plan.slots[0].targetWh, 600);

assert.equal(applyInterruptedChargeCap({ slots: [] }, firstInterruption, 2100).interruption, null);

const completedSlotPlan = consumeCompletedAdaptiveChargingSlot({
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

const delayedCompletedSlotPlan = consumeCompletedAdaptiveChargingSlot({
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

const legacyDelayedCompletedSlotPlan = consumeCompletedAdaptiveChargingSlot({
  plannedChargeKwh: 0.75,
  slots: [{ ...interruptedSlot, targetWh: 750 }],
  windows: [{ end: interruptedSlot.windowEnd, plannedChargeKwh: 0.75, requestedChargeKwh: 0.75 }],
}, {
  ...interruptedSlot,
  start: "2026-07-11T12:10:00.000Z",
  targetWh: 700,
});

assert.equal(legacyDelayedCompletedSlotPlan.slots.length, 0);


const delayedInterruptedState: Record<string, any> = {
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

const delayedInterruption = preserveInterruptedAdaptiveCharge(
  delayedInterruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);

assert.equal(delayedInterruption!.remainingWh, 750);

assert.equal(delayedInterruptedState.plan.slots[0].targetWh, 750);


const suspendedActions: any[] = [];

const suspendedState: Record<string, any> = {
  owner: "adaptiveCharging",
  activeSlot: interruptedSlot,
  activePlanCreatedAt: "plan",
  activeChargedKwh: 0.25,
  activeLastCheckedAt: "2026-07-11T12:10:00.000Z",
  activeChargeSession: null,
  log: [],
};

await suspendAdaptiveChargeInStandby(
  suspendedState as ReturnType<typeof cleanAdaptiveChargingState>,
  "Breaker limit reached",
  new Date("2026-07-11T12:10:00.000Z"),
  null,
  async (action: any, payload: any) => {
    suspendedActions.push({ action, payload });
    return { ok: true };
  },
);

assert.deepEqual(suspendedActions, [{ action: "set-mode", payload: { mode: "standby" } }]);

assert.equal(suspendedState.owner, null);

assert.match(suspendedState.log.at(-1).message, /maintaining Standby operation mode/);


const heldStandbyActions: any[] = [];

const heldStandbyState: Record<string, any> = {
  owner: "adaptiveCharging",
  activeSlot: interruptedSlot,
  activePlanCreatedAt: "plan",
  activeChargedKwh: 1.05,
  activeLastCheckedAt: "2026-07-11T12:28:30.000Z",
  activeChargeSession: null,
  log: [],
};

await suspendAdaptiveChargeInStandby(
  heldStandbyState as ReturnType<typeof cleanAdaptiveChargingState>,
  "Planned charge target reached",
  new Date("2026-07-11T12:28:30.000Z"),
  null,
  async (action: any, payload: any) => {
    heldStandbyActions.push({ action, payload });
    return { ok: true };
  },
  "2026-07-11T13:00:00.000Z",
);

assert.deepEqual(heldStandbyActions, [{ action: "set-mode", payload: { mode: "standby" } }]);

assert.equal(heldStandbyState.standbyHoldUntil, "2026-07-11T13:00:00.000Z");

assert.match(heldStandbyState.log.at(-1).message, /holding Standby operation mode until/);


const resumedActions: any[] = [];

await executeAdaptiveChargeStart({ targetWh: 750 }, {
  resumeFromStandby: true,
  execute: async (action: any, payload: any) => {
    resumedActions.push({ action, payload });
    return { ok: true };
  },
});

assert.deepEqual(resumedActions, [
  { action: "charge", payload: { targetWh: 750 } },
]);


const failedResumeActions: any[] = [];

await assert.rejects(executeAdaptiveChargeStart({ targetWh: 750 }, {
  resumeFromStandby: true,
  execute: async (action: any, payload: any) => {
    failedResumeActions.push({ action, payload });
    if (action === "charge") throw new Error("charge failed");
    return { ok: true };
  },
}), /charge failed/);

assert.deepEqual(failedResumeActions, [
  { action: "charge", payload: { targetWh: 750 } },
  { action: "set-mode", payload: { mode: "standby" } },
]);


const lateAdaptiveChargingSlot = capAdaptiveChargingSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 750 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
);

assert.equal(lateAdaptiveChargingSlot!.targetWh, 350);

assert.equal(lateAdaptiveChargingSlot!.start, "2026-07-11T12:20:00.000Z");

assert.equal(capAdaptiveChargingSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 49 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
), null);

assert.equal(capAdaptiveChargingSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 50 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
)?.targetWh, 50);

assert.equal(capAdaptiveChargingSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 750 },
  2100,
  new Date("2026-07-11T12:30:00.000Z"),
), null);


const deadlineState: Record<string, any> = {
  owner: "adaptiveCharging",
  activePlanCreatedAt: "deadline-plan",
  activeSlot: {
    start: "2026-07-11T12:00:00.000Z",
    end: "2026-07-11T12:30:00.000Z",
    windowEnd: "2026-07-11T12:30:00.000Z",
    targetWh: 1050,
  },
};

const deadlineKey = adaptiveChargingSlotEndKey(deadlineState);

assert.equal(
  adaptiveChargingSlotEndDelayMs(deadlineState, new Date("2026-07-11T12:20:00.000Z")),
  10 * 60_000,
);

assert.equal(adaptiveChargingSlotEndKey({ ...deadlineState, owner: null }), null);


let deadlineReleaseCount = 0;

let deadlineWriteCount = 0;

const deadlineDependencies: Record<string, any> = {
  readState: async () => deadlineState,
  release: async (state: any) => {
    deadlineReleaseCount += 1;
    state.owner = null;
    state.activeSlot = null;
    return true;
  },
  writeState: async () => {
    deadlineWriteCount += 1;
  },
};

const earlyDeadline = await enforceAdaptiveChargingSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:29:55.000Z"),
});

assert.equal(earlyDeadline.stopped, false);

assert.equal(earlyDeadline.remainingMs, 5000);

assert.equal(deadlineReleaseCount, 0);

assert.equal(deadlineWriteCount, 0);


const expiredDeadline = await enforceAdaptiveChargingSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:30:00.000Z"),
});

assert.equal(expiredDeadline.stopped, true);

assert.equal(deadlineReleaseCount, 1);

assert.equal(deadlineWriteCount, 1);

assert.equal(deadlineState.owner, null);

assert.equal(deadlineState.activeSlot, null);


const staleDeadline = await enforceAdaptiveChargingSlotEndDeadline(deadlineKey, {
  ...deadlineDependencies,
  now: new Date("2026-07-11T12:31:00.000Z"),
});

assert.equal(staleDeadline.stopped, false);

assert.equal(staleDeadline.reason, "active adaptiveCharging slot changed");

assert.equal(deadlineReleaseCount, 1);


const intermediateDeadlineState: Record<string, any> = {
  owner: "adaptiveCharging",
  activePlanCreatedAt: "intermediate-plan",
  activeSlot: {
    start: "2026-07-11T12:00:00.000Z",
    end: "2026-07-11T12:30:00.000Z",
    windowEnd: "2026-07-11T13:00:00.000Z",
    targetWh: 1050,
  },
};

const intermediateDeadlineKey = adaptiveChargingSlotEndKey(intermediateDeadlineState);

let intermediateSuspendCount = 0;

await enforceAdaptiveChargingSlotEndDeadline(intermediateDeadlineKey, {
  now: new Date("2026-07-11T12:30:00.000Z"),
  readState: async () => intermediateDeadlineState,
  suspend: async (state: any, reason: any, now: any, host: any, execute: any, holdUntil: any) => {
    intermediateSuspendCount += 1;
    state.owner = null;
    state.activeSlot = null;
    state.standbyHoldUntil = holdUntil;
    return true;
  },
  writeState: async () => {},
});

assert.equal(intermediateSuspendCount, 1);

assert.equal(intermediateDeadlineState.standbyHoldUntil, "2026-07-11T13:00:00.000Z");


const overdueWindowState: Record<string, any> = {
  owner: "adaptiveCharging",
  activePlanCreatedAt: "overdue-window-plan",
  activeSlot: {
    start: "2026-07-11T12:00:00.000Z",
    end: "2026-07-11T12:30:00.000Z",
    windowEnd: "2026-07-11T13:00:00.000Z",
    targetWh: 1050,
  },
};

let overdueReleaseCount = 0;

let overdueSuspendCount = 0;

await enforceAdaptiveChargingSlotEndDeadline(
  adaptiveChargingSlotEndKey(overdueWindowState),
  {
    now: new Date("2026-07-11T14:00:00.000Z"),
    readState: async () => overdueWindowState,
    release: async (state: any) => {
      overdueReleaseCount += 1;
      state.owner = null;
      state.activeSlot = null;
    },
    suspend: async () => { overdueSuspendCount += 1; },
    writeState: async () => {},
  },
);

assert.equal(overdueReleaseCount, 1);

assert.equal(overdueSuspendCount, 0);


const failedDeadlineState: Record<string, any> = {
  owner: "adaptiveCharging",
  activePlanCreatedAt: "failed-deadline-plan",
  activeSlot: {
    start: "2026-07-11T12:00:00.000Z",
    end: "2026-07-11T12:30:00.000Z",
    windowEnd: "2026-07-11T13:00:00.000Z",
    targetWh: 1050,
  },
  log: [],
};

let failedDeadlineWriteCount = 0;

const failedDeadlineResult = await enforceAdaptiveChargingSlotEndDeadline(
  adaptiveChargingSlotEndKey(failedDeadlineState),
  {
    now: new Date("2026-07-11T12:30:00.000Z"),
    readState: async () => failedDeadlineState,
    suspend: async () => { throw new Error("mode read-back remained auto"); },
    writeState: async () => { failedDeadlineWriteCount += 1; },
  },
);

assert.equal(failedDeadlineResult.stopped, false);

assert.equal(failedDeadlineResult.retryMs, 5000);

assert.equal(failedDeadlineState.owner, "adaptiveCharging");

assert.equal(failedDeadlineWriteCount, 1);

assert.match(failedDeadlineState.log.at(-1).message, /Failed to stop overdue charge/);

assert.equal(failedDeadlineState.lastResult.kind, "slot-end-retry");


const efficiencyAdjustedPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5, 1, 1.5, 2].map((hour: any) => chronologicalSlot(
    hour,
    { start: "00:00", end: "02:30", yenPerKwh: 10, label: "Discounted" },
  )),
  currentStoredKwh: 1,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
  chargeToStoredRatio: 0.8,
});

assert.ok(Math.abs(efficiencyAdjustedPlan.plannedChargeKwh - 5) < 0.001);

assert.ok(Math.abs(efficiencyAdjustedPlan.plannedStoredChargeKwh - 4) < 0.001);

assert.ok(Math.abs(efficiencyAdjustedPlan.expectedEndStoredKwh - 5) < 0.001);

assert.ok(efficiencyAdjustedPlan.unmetChargeKwh < 0.0001);


const efficiencyConstrainedPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5, 1, 1.5].map((hour: any) => chronologicalSlot(
    hour,
    { start: "00:00", end: "02:00", yenPerKwh: 10, label: "Discounted" },
  )),
  currentStoredKwh: 1,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2000,
  chargeToStoredRatio: 0.8,
});

assert.equal(efficiencyConstrainedPlan.plannedChargeKwh, 4);

assert.ok(Math.abs(efficiencyConstrainedPlan.plannedStoredChargeKwh - 3.2) < 0.001);

assert.ok(Math.abs(efficiencyConstrainedPlan.unmetStoredChargeKwh - 0.8) < 0.001);

assert.ok(Math.abs(efficiencyConstrainedPlan.unmetChargeKwh - 1) < 0.001);

assert.ok(Math.abs(efficiencyConstrainedPlan.requiredGridChargeKwh - 5) < 0.001);


const userTariffTimeline: any[] = [];

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


const solarHeadroomTimeline = userTariffTimeline.map((slot: any) => ({ ...slot }));

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
  timeline: [0, 0.5, 1, 1.5].map((hour: any) => chronologicalSlot(
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

assert.equal(floorClippedWindowPlan.slots.length, 1);

assert.ok(Math.abs(floorClippedWindowPlan.plannedChargeKwh - 8 / 3) < 0.001);

assert.ok(floorClippedWindowPlan.unmetChargeKwh < 0.0001);

assert.ok(Math.abs(floorClippedWindowPlan.expectedEndStoredKwh - 4) < 0.0001);


const forcedChargeDemandTimeline = [0, 0.5, 1, 1.5].map((hour: any) => ({
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

assert.ok(Math.abs(forcedChargeDemandPlan.windows[0]!.predictedEndSocPercent! - 100) < 0.001);


const heldTargetPlan = planChronologicalDiscountedCharging({
  timeline: forcedChargeDemandTimeline,
  currentStoredKwh: 4.2,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 84,
  maximumChargeWatts: 2100,
  standbyWindowEnd: new Date(forcedChargeDemandTimeline.at(-1)!.endMs).toISOString(),
});

assert.equal(heldTargetPlan.slots.length, 0, "Do not replace imaginary Auto discharge while holding Standby");

assert.equal(heldTargetPlan.plannedChargeKwh, 0);

assert.equal(heldTargetPlan.expectedEndStoredKwh, 4.2);


const backwardFeasibilityTimeline: any[] = [
  ...[0, 0.5, 1, 1.5].map((hour: any) => chronologicalSlot(
    hour,
    { start: "00:00", end: "02:00", yenPerKwh: 20, label: "Earlier discount" },
  )),
  chronologicalSlot(2, null),
  chronologicalSlot(2.5, null),
  ...[3, 3.5].map((hour: any) => chronologicalSlot(
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

assert.ok(Math.abs(backwardFeasibilityPlan.windows[1]!.predictedEndSocPercent! - 100) < 0.001);


const constrainedWindowPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5].map((hour: any) => chronologicalSlot(
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

assert.match(constrainedPlanStatus.warning!, /2\.50 kWh shortfall remains.*feasible discounted capacity/);

assert.equal(discountedPlanStatus({ plannedChargeKwh: 0, unmetChargeKwh: 2 }).available, false);

const migratedShortfallState = cleanAdaptiveChargingState({
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

assert.match(migratedShortfallState.plan.warning!, /7\.35 kWh of 8\.67 kWh requested/);


const moreExpensiveLaterTimeline: any[] = [
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


const demandSamples: any[] = [];

for (let week = 1; week <= 8; week += 1) {
  const day = new Date(2026, 6, 13 - week * 7);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    demandSamples.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 1000 + week * 10,
      coverageSeconds: { houseDemandKwh: 1800 },
    });
  }
}

const demandPrediction = predictHouseDemand(demandSamples, new Date(2026, 6, 13));

assert.equal(demandPrediction.available, true);

assert.equal(demandPrediction.profile.size, 48);

assert.equal(demandPrediction.seasonalYears.length, 0);

assert.equal(demandPrediction.seasonalBlendWeight, 0);


const multiYearDemandSamples: any[] = [...demandSamples];

for (const year of [2023, 2024, 2025]) {
  const day = new Date(year, 6, 13);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    multiYearDemandSamples.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 3000,
      coverageSeconds: { houseDemandKwh: 1800 },
    });
  }
}

const seasonalDemandPrediction = predictHouseDemand(multiYearDemandSamples, new Date(2026, 6, 13));

assert.equal(seasonalDemandPrediction.available, true);

assert.deepEqual(seasonalDemandPrediction.seasonalYears, [2025, 2024, 2023]);

assert.equal(seasonalDemandPrediction.seasonalComparableDays.length, 3);

assert.equal(seasonalDemandPrediction.seasonalBlendWeight, 0.3);

assert.ok(seasonalDemandPrediction.profile.get(12)! > demandPrediction.profile.get(12)!);


const indexedSeasonalDays = [2023, 2024, 2025].map((year: any) => ({
  key: `${year}-07-13`,
  date: new Date(year, 6, 13),
  coverage: 1,
  daytimeCoverage: 1,
  values: new Map(Array.from({ length: 48 }, (_: any, bucket: any) => [bucket, 3000])),
}));

const indexedSeasonalPrediction = predictHouseDemand(
  demandSamples,
  new Date(2026, 6, 13),
  new Map(),
  { historicalDays: indexedSeasonalDays },
);

assert.deepEqual(indexedSeasonalPrediction.seasonalYears, [2025, 2024, 2023]);

assert.equal(indexedSeasonalPrediction.seasonalBlendWeight, 0.3);

assert.ok(indexedSeasonalPrediction.profile.get(12)! > demandPrediction.profile.get(12)!);


const outOfSeasonDemandSamples: any[] = [...demandSamples];

for (let bucket = 0; bucket < 48; bucket += 1) {
  outOfSeasonDemandSamples.push({
    timestamp: new Date(2025, 0, 13, Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
    houseDemandW: 5000,
    coverageSeconds: { houseDemandKwh: 1800 },
  });
}

const outOfSeasonDemandPrediction = predictHouseDemand(outOfSeasonDemandSamples, new Date(2026, 6, 13));

assert.equal(outOfSeasonDemandPrediction.seasonalComparableDays.length, 0);

assert.equal(outOfSeasonDemandPrediction.seasonalBlendWeight, 0);


const alignedSolarSamples: any[] = [];

const alignedWeather: any[] = [];

for (let day = 1; day <= 7; day += 1) {
  const sampleTime = Date.parse(`2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`);
  alignedSolarSamples.push({ timestamp: new Date(sampleTime).toISOString(), solarPowerW: 1000 });
  alignedWeather.push(
    { timestamp: new Date(sampleTime).toISOString(), tiltedIrradianceWm2: 100 },
    { timestamp: new Date(sampleTime + 3_600_000).toISOString(), tiltedIrradianceWm2: 500 },
  );
}

const alignedSolarFactor = learnedSolarFactor(alignedSolarSamples, alignedWeather, adaptiveChargingConfig);

assert.equal(alignedSolarFactor.learned, true);

assert.equal(alignedSolarFactor.factor, 2);

assert.match(String(smtpSecurityWarning({ port: 465, security: "starttls" })), /465/);
assert.match(String(smtpSecurityWarning({ port: 587, security: "tls" })), /STARTTLS/);
assert.equal(smtpSecurityWarning({ port: 465, security: "tls" }), null);
assert.equal(smtpSecurityWarning({ port: 587, security: "starttls" }), null);
