import assert from "node:assert/strict";

import { mkdtemp, rm } from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { createDeviceSimulator } from "./support/device-simulator.js";

import {
  createNotificationService,
  normalizeNotificationConfig,
  smtpTransportOptions,
  validateSmtpSettings,
} from "../lib/notifications.js";

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

import {
  cleanAdaptiveChargingPerformance,
  cleanAdaptiveChargingState,
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
} from "../lib/domain/adaptive-control.js";

import {
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  countGuardTriggersForRange,
  shouldTriggerDemandGuard,
} from "../lib/domain/automation-rules.js";

import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "../lib/counter-utils.js";

assert.equal(cleanConfig({ updateIntervalSeconds: 2 }).updateIntervalSeconds, 5);

assert.equal(cleanConfig({ updateIntervalSeconds: 30 }).updateIntervalSeconds, 30);

assert.equal(cleanConfig({ smartCosmoEnabled: false }).smartCosmoEnabled, false);

assert.equal(cleanConfig({ co2TonnesPerKwh: 0.0005 }).co2TonnesPerKwh, 0.0005);

assert.deepEqual(normalizeCircuitLabels({ 1: "Kitchen", 2: "", bad: "Nope", 253: "Too high" }), { 1: "Kitchen" });

assert.deepEqual(cleanConfig({ circuitLabels: [{ channel: 6, label: "EV charger" }] }).circuitLabels, { 6: "EV charger" });

assert.deepEqual(cleanConfig({
  circuitDashboardVisibility: { 1: false, 2: true, bad: false, 253: false },
}).circuitDashboardVisibility, { 1: false, 2: true });

assert.deepEqual(cleanConfig({
  circuitDashboardVisibility: [{ channel: 6, visible: false }, { channel: 7 }],
}).circuitDashboardVisibility, { 6: false, 7: true });

assert.equal(cleanConfig({ circuitSortMode: "energy" }).circuitSortMode, "current");

assert.equal(cleanConfig({ circuitSortMode: "current" }).circuitSortMode, "current");

assert.equal(cleanConfig({ circuitSortMode: "accumulated" }).circuitSortMode, "accumulated");

assert.equal(cleanConfig({ circuitSortMode: "bad" }).circuitSortMode, "number");


const normalizedWidgets = normalizeDashboardWidgets([
  { id: "solarPower", visible: false, priority: 90 },
  { id: "houseDemandPower", visible: true, priority: "bad" },
  { id: "unknownWidget", visible: true, priority: 1 },
]);

assert.equal(normalizedWidgets.length, 24);

assert.deepEqual(normalizedWidgets.find((widget: any) => widget.id === "solarPower"), {
  id: "solarPower",
  group: "trends",
  visible: false,
  priority: 90,
});

assert.deepEqual(normalizedWidgets.find((widget: any) => widget.id === "houseDemandPower"), {
  id: "houseDemandPower",
  group: "trends",
  visible: true,
  priority: 30,
});

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "unknownWidget"), false);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "fuelCellPower"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "powerImported"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "powerExported"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "guardTriggerCount"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "energySources"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "fuelCellStateTimeline"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "fuelCellHotWater"), true);

assert.equal(normalizedWidgets.some((widget: any) => widget.id === "adaptiveCharging"), true);


assert.throws(
  () => parseJsonWithContext("[1]\n[2]", "test.json"),
  /test\.json at line 2, column 1, position 4/,
);

assert.deepEqual(normalizeSubnets(["192.168.1.0/24", "bad", "192.168.1.0/24"]), ["192.168.1.0/24"]);


const partialBands = normalizeRateBands({
  rateMode: "multi",
  rateBands: [{ start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" }],
});

assert.equal(rateForTimestamp(partialBands, "2026-05-31T12:00:00+09:00", 40).yenPerKwh, 40);


assert.deepEqual(
  cumulativeCounterDeltaResult(11.04, null, COUNTER_POLICIES.grid, 7),
  { delta: null, issue: null },
);

assert.deepEqual(
  cumulativeCounterDeltaResult(11.04, 0, COUNTER_POLICIES.grid, 7),
  { delta: null, issue: "invalid-jump" },
);

assert.ok(Math.abs(
  Number(cumulativeCounterDeltaResult(11.04, 11.03, COUNTER_POLICIES.grid, 7).delta) - 0.01,
) < 0.000001);


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

assert.equal(summary.circuits.find((item: any) => item.channel === 1)!.label, "Kitchen");

assert.equal(summary.circuits.find((item: any) => item.channel === 1)!.totalKwh, 0.5);

assert.equal(summary.circuits.find((item: any) => item.channel === 2)!.totalKwh, 0.1);

assert.equal(summary.circuitTotalKwh, 0.6);

assert.equal(summary.guardTriggerCount, 1);


const discountedSavingsSummary = summarizeSamples([
  {
    timestamp: "2026-07-15T01:30:00+09:00",
    gridImportKwh: 1,
    batteryChargeKwh: 0.4,
    rateYenPerKwh: 10,
  },
  {
    timestamp: "2026-07-15T14:30:00+09:00",
    gridImportKwh: 2,
    batteryChargeKwh: 0.5,
    rateYenPerKwh: 25,
  },
], { standardRateYenPerKwh: 25 });

assert.equal(discountedSavingsSummary.totalOffPeakSavingYen, 15);

assert.equal(discountedSavingsSummary.batteryOffPeakSavingYen, 6);

assert.equal(discountedSavingsSummary.gridOffPeakSavingYen, 9);

assert.equal(
  discountedSavingsSummary.totalOffPeakSavingYen,
  discountedSavingsSummary.batteryOffPeakSavingYen + discountedSavingsSummary.gridOffPeakSavingYen,
);


const calendarSavingsSample = (year: any, month: any, day: any, solarSavingYen: any, solarGenerationKwh: any) => {
  const start = new Date(year, month, day);
  const end = new Date(year, month, day + 1);
  return {
    timestamp: new Date(end.getTime() - 1).toISOString(),
    rollupStart: start.toISOString(),
    rollupEnd: end.toISOString(),
    solarSavingYen,
    offPeakSavingYen: solarSavingYen * 2,
    solarGenerationKwh,
    gridImportKwh: solarSavingYen / 10,
    batteryChargeKwh: solarSavingYen / 20,
    rateYenPerKwh: 10,
  };
};

const calendarSavingsEnd = new Date(2026, 6, 15, 12);

const calendarSavings = summarizeCalendarSavings([
  calendarSavingsSample(2026, 0, 1, 10, 1),
  calendarSavingsSample(2026, 5, 30, 20, 2),
  calendarSavingsSample(2026, 6, 1, 30, 3),
  calendarSavingsSample(2026, 6, 12, 40, 4),
  calendarSavingsSample(2026, 6, 13, 50, 5),
  {
    timestamp: calendarSavingsEnd.toISOString(),
    rollupStart: new Date(2026, 6, 15, 11, 30).toISOString(),
    rollupEnd: calendarSavingsEnd.toISOString(),
    solarSavingYen: 60,
    offPeakSavingYen: 120,
    solarGenerationKwh: 6,
  },
], { co2TonnesPerKwh: 0.000423, standardRateYenPerKwh: 20 }, calendarSavingsEnd, {
  solarSavingYen: 61,
  offPeakSavingYen: 122,
  co2SavingKg: 2.6,
});

assert.equal(calendarSavings.today.solarSavingYen, 61, "today should retain the exact live summary");

assert.equal(calendarSavings.lastMonth.solarSavingYen, 20, "last month should be a complete calendar month");

assert.equal(calendarSavings.month.solarSavingYen, 180);

assert.equal(calendarSavings.year.solarSavingYen, 210);

assert.equal(calendarSavings.lastMonth.offPeakSavingYen, 40);

assert.equal(calendarSavings.lastMonth.totalOffPeakSavingYen, 20);

assert.equal(calendarSavings.lastMonth.batteryOffPeakSavingYen, 10);

assert.equal(calendarSavings.lastMonth.gridOffPeakSavingYen, 10);

assert.ok(Math.abs(calendarSavings.lastMonth.co2SavingKg - 0.846) < 0.000001);

assert.equal(new Date(calendarSavings.lastMonth.start).getMonth(), 5);

assert.equal(new Date(calendarSavings.lastMonth.end).getMonth(), 6);


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
    fuelCellKwh: 0.5,
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

assert.equal(energySourceSummary.energySources.fuelCellContributionKwh, 0.5);

assert.equal(energySourceSummary.energySources.totalKwh, 3);

assert.ok(Math.abs(energySourceSummary.energySources.peakGridPercent - 16.6666666667) < 0.000001);

assert.ok(Math.abs(energySourceSummary.energySources.offPeakGridPercent - 100 / 3) < 0.000001);

assert.ok(Math.abs(energySourceSummary.energySources.solarUsedPercent - 100 / 3) < 0.000001);

assert.ok(Math.abs(energySourceSummary.energySources.fuelCellContributionPercent - 16.6666666667) < 0.000001);


const reportSamples: any[] = [
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

assert.ok(Math.abs(dailyReport.totals.solarCoveragePercent! - 30) < 0.000001);


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


const guardRules: any[] = [{
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

assert.equal(legacyPowerSummary.gridImportKwh, 0.75);

assert.equal(legacyPowerSummary.gridExportKwh, 0.375);


const recordingGapSummary = summarizeSamples([
  { timestamp: "2026-05-31T00:00:00.000Z", gridImportW: 1000, expectedIntervalSeconds: 15 },
  { timestamp: "2026-05-31T02:00:00.000Z", gridImportW: 1000, expectedIntervalSeconds: 15 },
]);

assert.equal(recordingGapSummary.gridImportKwh, 0, "recording gaps must not be filled with invented energy");


const partialRangeReport = aggregateEnergyReportSamples([{
  timestamp: "2026-05-31T00:30:00.000Z",
  rollupStart: "2026-05-31T00:00:00.000Z",
  rollupEnd: "2026-05-31T00:30:00.000Z",
  gridImportKwh: 0.5,
  solarGenerationKwh: 0.3,
  batteryChargeKwh: 0.2,
  solarSavingYen: 30,
  offPeakSavingYen: 12,
  coverageSeconds: { gridImportKwh: 1800, solarGenerationKwh: 1800, batteryChargeKwh: 1800 },
  energyQuality: { gridImportKwh: "integrated", solarGenerationKwh: "integrated", batteryChargeKwh: "integrated" },
}], {
  start: "2026-05-31T00:10:00.000Z",
  end: "2026-05-31T00:27:00.000Z",
  bucket: "day",
});

assert.ok(Math.abs(partialRangeReport.totals.gridImportKwh! - 17 / 60) < 1e-9);

assert.ok(Math.abs(partialRangeReport.totals.solarSavingYen - 17) < 1e-9);

assert.ok(Math.abs(partialRangeReport.totals.offPeakSavingYen - 6.8) < 1e-9);

assert.equal(
  partialRangeReport.buckets[0].dataQuality.gridImportKwh.coveragePercent,
  100,
  "partial calendar buckets report coverage against the selected range",
);

assert.equal(partialRangeReport.buckets[0].dataQuality.batteryChargedKwh.quality, "integrated");
assert.equal(partialRangeReport.buckets[0].dataQuality.batteryChargedKwh.coveragePercent, 100);
assert.equal(partialRangeReport.buckets[0].dataQuality.batteryDischargedKwh.quality, "unavailable");
