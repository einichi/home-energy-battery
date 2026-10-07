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
  adaptiveChargingTimezoneError,
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
  shouldTriggerDemandGuard,
} from "../lib/domain/automation-rules.js";

import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "../lib/counter-utils.js";

const inactiveBackupPreparation: Record<string, any> = { backupPreparation: { active: false, allowDemandGuard: true } };

const guardedBackupPreparation: Record<string, any> = { backupPreparation: { active: true, allowDemandGuard: true } };

const isolatedBackupPreparation: Record<string, any> = { backupPreparation: { active: true, allowDemandGuard: false } };

assert.equal(backupPreparationBlocksActions(inactiveBackupPreparation), false);

assert.equal(backupPreparationBlocksActions(guardedBackupPreparation), true);

assert.equal(backupPreparationAllowsActionSource(guardedBackupPreparation, "backup-preparation"), true);

assert.equal(backupPreparationAllowsActionSource(guardedBackupPreparation, "charging-demand-guard"), true);

assert.equal(backupPreparationAllowsActionSource(guardedBackupPreparation, "manual"), false);

assert.equal(backupPreparationAllowsActionSource(guardedBackupPreparation, "schedule"), false);

assert.equal(backupPreparationAllowsActionSource(guardedBackupPreparation, "adaptive-charging"), false);

assert.equal(backupPreparationAllowsActionSource(isolatedBackupPreparation, "charging-demand-guard"), false);


const timestampWrites: any[] = [];

const testConsole: Record<string, any> = {
  log: (...args: any[]) => timestampWrites.push(args),
  warn: (...args: any[]) => timestampWrites.push(args),
};

assert.equal(timestampConsole(testConsole, () => new Date("2026-07-21T03:30:00.123Z")), true);

testConsole.log("automation", { state: "ready" });

assert.deepEqual(timestampWrites[0], [
  `[${localIsoTimestamp("2026-07-21T03:30:00.123Z")}]`,
  "automation",
  { state: "ready" },
]);

assert.equal(timestampConsole(testConsole), false);


assert.equal(fuelCellHotWaterEmptyNotificationActive({
  hot_water_level: { value: 0 },
  generation_status: { value: "stopped" },
}), true);

assert.equal(fuelCellHotWaterEmptyNotificationActive({
  hot_water_level: { value: 0 },
  generation_status: { value: "generating" },
}), false, "an empty tank must not notify while the Ene-Farm is generating");

assert.equal(fuelCellHotWaterEmptyNotificationActive({
  hot_water_level: { value: 1 },
  generation_status: { value: "stopped" },
}), false);

assert.equal(fuelCellHotWaterEmptyNotificationActive({
  hot_water_level: { value: 0 },
}), null, "an unknown generation state must not produce an empty-tank alert");


assert.throws(
  () => assertDeviceCommandResult({ ok: false, esv: "SetC_SNA" }, "test write"),
  /test write failed: rejected with SetC_SNA/,
);

assert.throws(
  () => assertDeviceCommandResult({ results: [{ epc: "0xDA", ok: false, esv: "SetC_SNA" }] }, "multi-write"),
  /0xDA rejected with SetC_SNA/,
);


let operationModeReadCount = 0;

let operationModeWaitCount = 0;

const verifiedOperationMode = await verifyBatteryOperationMode(
  { ok: true },
  "192.0.2.10",
  "standby",
  {
    attempts: 3,
    delayMs: 1,
    readStatus: async () => operationModeReadCount++ === 0
      ? { battery: { operation_mode: { value: "auto" } } }
      : { raw: "0x44" },
    wait: async () => { operationModeWaitCount += 1; },
  },
);

assert.equal(verifiedOperationMode.verified, true);

assert.equal(verifiedOperationMode.readBack.operationMode, "standby");

assert.equal(verifiedOperationMode.readBack.attempts, 2);

assert.equal(operationModeWaitCount, 1);

await assert.rejects(
  verifyBatteryOperationMode(
    { ok: true },
    "192.0.2.10",
    "standby",
    {
      attempts: 2,
      delayMs: 0,
      readStatus: async () => ({ battery: { operation_mode: { value: "auto" } } }),
    },
  ),
  /still read back as auto after 2 attempts/,
);

// An alias like "charge" verifies against the canonical readback "charging".
const verifiedModeAlias = await verifyBatteryOperationMode(
  { ok: true },
  "192.0.2.10",
  "charge",
  {
    attempts: 2,
    delayMs: 0,
    readStatus: async () => ({ battery: { operation_mode: { value: "charging" } } }),
  },
);
assert.equal(verifiedModeAlias.verified, true);


const staleSchedules: any[] = [
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

assert.equal(Math.max(...migrated.rateBands.map((band: any) => band.yenPerKwh)), 36);

const migratedFuelCellHosts = cleanConfig({
  meterHost: "10.0.0.135",
  fuelCellHosts: ["10.0.0.135", "10.0.0.150"],
});

assert.equal(migratedFuelCellHosts.fuelCellPrimaryHost, "10.0.0.150");

assert.deepEqual(migratedFuelCellHosts.fuelCellProxyHosts, ["10.0.0.135"]);

const proxyOnlyFuelCell = cleanConfig({ meterHost: "10.0.0.135", fuelCellHosts: ["10.0.0.135"] });

assert.equal(proxyOnlyFuelCell.fuelCellPrimaryHost, "");

assert.deepEqual(proxyOnlyFuelCell.fuelCellProxyHosts, ["10.0.0.135"]);

const normalizedFuelCellTariff = cleanConfig({
  fuelCell: { tariff: {
    region: "gunma",
    plan: "enefarm",
    equipmentDiscount: "floor",
    expectedWinterMonthlyM3: 80,
    expectedOtherMonthlyM3: 35,
  } },
});

assert.equal(normalizedFuelCellTariff.fuelCell.tariff.region, "gunma");

assert.equal(normalizedFuelCellTariff.fuelCell.tariff.plan, "enefarm");

assert.equal(normalizedFuelCellTariff.fuelCell.tariff.equipmentDiscount, "floor");

assert.equal("expectedWinterMonthlyM3" in normalizedFuelCellTariff.fuelCell.tariff, false);

assert.equal("expectedOtherMonthlyM3" in normalizedFuelCellTariff.fuelCell.tariff, false);

const invalidFuelCellTariff = cleanConfig({
  fuelCell: { tariff: { region: "unknown", plan: "other", equipmentDiscount: "enefarm" } },
});

assert.equal(invalidFuelCellTariff.fuelCell.tariff.region, "tokyo");

assert.equal(invalidFuelCellTariff.fuelCell.tariff.plan, "enefarm");

assert.equal(invalidFuelCellTariff.fuelCell.tariff.equipmentDiscount, "");

const migratedFuelCellForecastInfluence = cleanConfig({
  fuelCell: {
    generationModel: "fixed",
    plannerInfluence: "active",
    fixedWindows: [{ label: "Legacy", days: [1, 2, 3], start: "08:00", end: "10:00" }],
  },
}).fuelCell;

assert.equal(migratedFuelCellForecastInfluence.includeInAdaptiveCharging, false);

assert.equal("automation" in migratedFuelCellForecastInfluence, false);


const billingPeriodGas = fuelCellGasUsageByBillingPeriod([
  { timestamp: "2026-07-09T00:00:00", fuelCellGasM3: 1.25 },
  { timestamp: "2026-08-07T23:59:00", fuelCellGasM3: 0.75 },
  { timestamp: "2026-08-08T00:00:00", fuelCellGasM3: 2 },
  { timestamp: "2026-08-09T00:00:00", fuelCellGasM3: null },
], 8);

assert.equal(billingPeriodGas.get("2026-07"), 2);

assert.equal(billingPeriodGas.get("2026-08"), 2);


const fuelCellSamples: any[] = [];

for (let day = 1; day <= 8; day += 1) {
  for (let bucket = 0; bucket < 20; bucket += 1) {
    fuelCellSamples.push({
      timestamp: new Date(2026, 6, day, 8 + Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      fuelCellPowerW: 650 + day * 2,
      fuelCellGenerationState: "generating",
    });
  }
}

const automatedFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { includeInAdaptiveCharging: true },
}), fuelCellSamples, new Date(2026, 6, 9, 9));

assert.equal(automatedFuelCellModel.influence, "active");

assert.equal(automatedFuelCellModel.method, "observed");

assert.ok(automatedFuelCellModel.forecastAt(new Date(2026, 6, 9, 10)).medianW > 600);

assert.equal(automatedFuelCellModel.forecastAt(new Date(2026, 6, 9, 20)).medianW, 0);

const observedFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { includeInAdaptiveCharging: false },
}), fuelCellSamples, new Date(2026, 6, 9, 9));

assert.equal(observedFuelCellModel.ready, true);

assert.equal(observedFuelCellModel.influence, "observe");

const immatureFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { includeInAdaptiveCharging: true },
}), fuelCellSamples.filter((sample: any) => new Date(sample.timestamp).getDate() <= 3), new Date(2026, 6, 9, 9));

assert.equal(immatureFuelCellModel.ready, false);

assert.equal(immatureFuelCellModel.influence, "observe");

assert.match(immatureFuelCellModel.blockers.join("; "), /valid observation days required/);

const denseFuelCellSamples = fuelCellSamples.flatMap((sample: any) => [
  sample,
  { ...sample, timestamp: new Date(new Date(sample.timestamp).getTime() + 5 * 60_000).toISOString() },
  { ...sample, timestamp: new Date(new Date(sample.timestamp).getTime() + 10 * 60_000).toISOString() },
]);

const denseFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { includeInAdaptiveCharging: false },
}), denseFuelCellSamples, new Date(2026, 6, 9, 9));

assert.equal(
  denseFuelCellModel.forecastAt(new Date(2026, 6, 9, 10)).medianW,
  observedFuelCellModel.forecastAt(new Date(2026, 6, 9, 10)).medianW,
);

assert.equal(migrated.settingCache.discharge_limit.lastKnown.decoded.percent, 30);


const simple = cleanConfig({ standardRateYenPerKwh: 42 });

assert.equal(simple.rateMode, "simple");

assert.equal(simple.offPeakSavingsEnabled, false);

assert.equal(simple.rateBands.length, 1);

assert.equal(simple.retention.rawTelemetryDays, 1095);

assert.equal(simple.retention.intervalAggregatesDays, null);

assert.equal(simple.retention.dailyAggregatesDays, null);

assert.equal(simple.retention.adaptiveChargingHistoryDays, null);

assert.equal(simple.retention.automationEventDays, null);

assert.equal(simple.retention.commandReceiptDays, 365);

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

assert.deepEqual(simple.circuitDashboardVisibility, {});

assert.equal(simple.circuitSortMode, "number");

assert.equal(rateForTimestamp(simple.rateBands, "2026-05-31T23:30:00+09:00").yenPerKwh, 42);

// Off-peak mode must honour caller-supplied rate bands (e.g. 23:00-07:00).
const offPeakWithBands = cleanConfig({
  rateMode: "offPeak",
  standardRateYenPerKwh: 40,
  offPeakRateYenPerKwh: 15,
  rateBands: [
    { start: "07:00", end: "23:00", yenPerKwh: 40, label: "Standard" },
    { start: "23:00", end: "07:00", yenPerKwh: 15, label: "Off-peak" },
  ],
});
assert.equal(offPeakWithBands.rateBands.length, 2);
assert.equal(rateForTimestamp(offPeakWithBands.rateBands, "2026-05-31T23:30:00+09:00").yenPerKwh, 15);

// Multi mode must keep a legitimate all-day discount band (start === end) and
// not mistake it for the stale simple-mode artifact.
const multiAllDay = cleanConfig({
  rateMode: "multi",
  standardRateYenPerKwh: 30,
  rateBands: [
    { start: "00:00", end: "00:00", yenPerKwh: 22, label: "All-day discount" },
    { start: "06:00", end: "22:00", yenPerKwh: 30, label: "Peak" },
  ],
});
assert.equal(multiAllDay.rateBands.length, 2);
assert.equal(rateForTimestamp(multiAllDay.rateBands, "2026-05-31T03:00:00+09:00").yenPerKwh, 22);

// A lone flat band carried over from simple mode is still replaced when the
// mode is explicitly off-peak.
const staleSimpleBand = cleanConfig({
  rateMode: "offPeak",
  standardRateYenPerKwh: 40,
  offPeakRateYenPerKwh: 15,
  rateBands: [{ start: "00:00", end: "00:00", yenPerKwh: 40, label: "Simple" }],
});
assert.equal(staleSimpleBand.rateBands.length, 2);
assert.equal(rateForTimestamp(staleSimpleBand.rateBands, "2026-05-31T03:00:00+09:00").yenPerKwh, 15);

assert.equal(simple.dashboardWidgets.length, 24);

assert.equal(simple.dashboardWidgets[0].id, "solarPower");

assert.equal(simple.dashboardWidgets.find((widget: any) => widget.id === "adaptiveCharging")?.priority, 5);

assert.equal(simple.dashboardWidgets.find((widget: any) => widget.id === "backupPreparation")?.priority, 6);

assert.equal(simple.dashboardWidgets.find((widget: any) => widget.id === "awayStatus")?.priority, 7);

assert.deepEqual(simple.batteryCapabilities, { usableCapacityKwh: null, maximumChargeWatts: null, roundTripEfficiency: 0.9 });
assert.equal(cleanConfig({ batteryCapabilities: { roundTripEfficiency: 0.85 } }).batteryCapabilities.roundTripEfficiency, 0.85);
assert.equal(cleanConfig({ batteryCapabilities: { roundTripEfficiency: 0.1 } }).batteryCapabilities.roundTripEfficiency, 0.5);

assert.equal(simple.adaptiveCharging.enabled, false);

assert.equal(simple.adaptiveCharging.systemLossPercent, 14);

assert.equal(simple.adaptiveCharging.targetSocPercent, 100);

assert.equal(simple.adaptiveCharging.forecastMarginPercent, 10);

assert.equal(Object.prototype.hasOwnProperty.call(cleanConfig({
  automation: { breakerVoltage: 100, breakerAmps: 60, reserveAmps: 5 },
}), "automation"), false);

assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2200 } }).batteryCapabilities.maximumChargeWatts, 2200);

assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2192 } }).batteryCapabilities.maximumChargeWatts, 2192);

assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2192.4 } }).batteryCapabilities.maximumChargeWatts, 2192);

assert.equal(cleanConfig({ batteryCapabilities: { maximumChargeWatts: 2192.5 } }).batteryCapabilities.maximumChargeWatts, 2193);


const timelineView = buildAdaptiveChargingTimelineView({
  timeline: [
    { startMs: 0, endMs: 1_800_000, demandW: 1000, solarKwh: 0.1, netKwh: -0.4, chargeCapacityKwh: 1, band: { label: "Night", yenPerKwh: 12 } },
    { startMs: 1_800_000, endMs: 3_600_000, demandW: 800, solarKwh: 0.6, netKwh: 0.2, chargeCapacityKwh: 0, band: null },
  ],
  slots: [{ start: new Date(900_000).toISOString(), end: new Date(1_800_000).toISOString(), targetWh: 500 }],
  initialStoredKwh: 2,
  floorKwh: 1,
  capacityKwh: 5,
  chargeToStoredRatio: 0.8,
  config: {
    rateBands: [{ start: "00:00", end: "00:30", label: "Night", yenPerKwh: 12 }],
    standardRateYenPerKwh: 30,
  },
});

assert.equal(timelineView.length, 3);

assert.equal(timelineView[0].start, new Date(0).toISOString());

assert.equal(timelineView[0].end, new Date(900_000).toISOString());

assert.equal(timelineView[0].plannedChargeWh, 0);

assert.equal(timelineView[1].start, new Date(900_000).toISOString());

assert.equal(timelineView[1].end, new Date(1_800_000).toISOString());

assert.equal(timelineView[1].plannedChargeWh, 500);

assert.equal(timelineView[1].predictedStoredChargeWh, 400);

assert.equal(timelineView[0].discounted, true);

assert.equal(timelineView[0].rateLabel, "Night");

assert.ok(timelineView.every((item: any) => item.predictedSocPercent >= 20));

assert.ok(Math.abs(timelineView[0]!.predictedStartSocPercent! - 40) < 1e-9);

assert.ok(Math.abs(timelineView[0]!.predictedEndSocPercent! - 36) < 1e-9);

assert.equal(timelineView[1].predictedStartSocPercent, timelineView[0].predictedEndSocPercent);

assert.ok(Math.abs(timelineView[1]!.predictedEndSocPercent! - 44) < 1e-9);

assert.equal(timelineView[2].predictedStartSocPercent, timelineView[1].predictedEndSocPercent);

assert.ok(Math.abs(timelineView[2]!.predictedEndSocPercent! - 47.2) < 1e-9);


const awayPeriods: any[] = [
  { from: "2026-07-12T09:00:00.000Z", until: "2026-07-12T12:00:00.000Z" },
  { from: "2026-07-13T09:00:00.000Z", until: "2026-07-13T12:00:00.000Z" },
  { from: "2026-07-14T09:00:00.000Z", until: "2026-07-14T12:00:00.000Z" },
];

assert.equal(awayPeriodContains(awayPeriods[0], Date.parse("2026-07-12T09:30:00.000Z")), true);

assert.equal(awayPeriodContains(awayPeriods[0], Date.parse("2026-07-12T12:00:00.000Z")), false);

assert.equal(
  awayPeriodForecastContains(awayPeriods[0], Date.parse("2026-07-12T11:45:00.000Z")),
  false,
  "future planning restores home demand during the return buffer",
);

const occupancySamples: any[] = [
  { timestamp: "2026-07-12T08:30:00.000Z", houseDemandW: 1200, coverageSeconds: { houseDemandKwh: 1800 } },
  { timestamp: "2026-07-12T09:30:00.000Z", houseDemandW: 300, coverageSeconds: { houseDemandKwh: 1800 } },
];

const homeDemandDays = aggregateDemandDays(occupancySamples, { awayPeriods, occupancy: "home" });

const awayDemandDays = aggregateDemandDays(occupancySamples, { awayPeriods, occupancy: "away" });

assert.deepEqual([...homeDemandDays[0].values.values()], [1200], "Away buckets are excluded from normal demand training");

assert.deepEqual([...awayDemandDays[0].values.values()], [300], "Away buckets remain available to Away training");

assert.equal(filterDemandDaysByOccupancy(homeDemandDays, awayPeriods, "home")[0].values.size, 1);


const directPowerCoverageDays = aggregateDemandDays([{
  timestamp: "2026-07-12T09:30:00.000Z",
  houseDemandW: 900,
  intervalAveragePowerW: { houseDemandW: 1000 },
  powerCoverageSeconds: { houseDemandW: 1800 },
  coverageSeconds: { houseDemandKwh: 0 },
}]);

const directCoverageTime = new Date("2026-07-12T09:30:00.000Z");

const directCoverageBucket = directCoverageTime.getHours() * 2 + (directCoverageTime.getMinutes() >= 30 ? 1 : 0);

assert.equal(
  directPowerCoverageDays[0]!.coverageByBucket!.get(directCoverageBucket),
  1800,
  "Demand learning uses direct power coverage instead of unrelated energy coverage",
);

assert.equal(directPowerCoverageDays[0].values.get(directCoverageBucket), 1000);


const awayBucketDate = new Date("2026-07-12T09:30:00.000Z");

const awayBucket = awayBucketDate.getHours() * 2 + (awayBucketDate.getMinutes() >= 30 ? 1 : 0);


const learnedAway = predictAwayDemand(
  [
    { timestamp: "2026-07-12T09:30:00.000Z", houseDemandW: 300, coverageSeconds: { houseDemandKwh: 1800 } },
    { timestamp: "2026-07-13T09:30:00.000Z", houseDemandW: 400, coverageSeconds: { houseDemandKwh: 1800 } },
    { timestamp: "2026-07-14T09:30:00.000Z", houseDemandW: 500, coverageSeconds: { houseDemandKwh: 1800 } },
  ],
  new Date("2026-07-15T09:30:00.000Z"),
  new Map(),
  {
    awayPeriods,
    normalPrediction: { profile: new Map([[awayBucket, 1400]]), lowProfile: new Map([[awayBucket, 600]]) },
  },
);

assert.equal(learnedAway.learnedBuckets.has(awayBucket), true);

assert.equal(learnedAway.profile.get(awayBucket), 400);

const fallbackAway = predictAwayDemand(
  [
    { timestamp: "2026-07-12T09:30:00.000Z", houseDemandW: 300 },
    { timestamp: "2026-07-13T09:30:00.000Z", houseDemandW: 400 },
  ],
  new Date("2026-07-15T09:30:00.000Z"),
  new Map(),
  {
    awayPeriods,
    normalPrediction: { profile: new Map([[awayBucket, 1400]]), lowProfile: new Map([[awayBucket, 600]]) },
  },
);

assert.equal(fallbackAway.learnedBuckets.has(awayBucket), false);

assert.equal(fallbackAway.fallbackBuckets.has(awayBucket), true);

assert.equal(fallbackAway.profile.get(awayBucket), 600);


assert.equal(solarPowerFromIrradiance(500, {
  adaptiveCharging: { arrayPeakKw: 5, systemLossPercent: 14 },
}), 2150);

assert.equal(solarPowerFromIrradiance(2000, {
  adaptiveCharging: { arrayPeakKw: 5, systemLossPercent: 14 },
}), 5000);

assert.equal(applySolarForecastBias(1000, 5000, { learned: false, factor: 1.2 }), 1000);

assert.equal(applySolarForecastBias(1000, 5000, { learned: true, factor: 1.2 }), 1200);

assert.equal(applySolarForecastBias(4800, 5000, { learned: true, factor: 1.2 }), 5000);

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

const forecastIssueTimezone = process.env.TZ;

process.env.TZ = "Asia/Tokyo";

const forecastIssues = dailySolarForecastIssues({
  fetchedAt: "2026-07-10T12:00:00.000Z",
  days: [{ date: "2026-07-11" }],
  hours: [
    { timestamp: "2026-07-11T03:00:00.000Z", tiltedIrradianceWm2: 500 },
    { timestamp: "2026-07-11T04:00:00.000Z", tiltedIrradianceWm2: 500 },
  ],
}, {
  adaptiveCharging: {
    arrayPeakKw: 5,
    systemLossPercent: 14,
    forecastMarginPercent: 10,
  },
}, {
  factor: 2,
  groupFactors: {},
  learned: true,
  validDays: 10,
}, {
  learned: true,
  factor: 1.2,
});

assert.equal(forecastIssues.length, 1);

assert.equal(forecastIssues[0].targetDate, "2026-07-11");

assert.equal(forecastIssues[0].rawPredictedKwh, 2);

assert.equal(forecastIssues[0].predictedKwh, 2.4);

assert.equal(forecastIssues[0].planningKwh, 2.16);

if (forecastIssueTimezone === undefined) delete process.env.TZ;
else process.env.TZ = forecastIssueTimezone;

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
)?.tiltedIrradianceWm2, 500);

const partialIntervalStart = new Date(2026, 6, 11, 11, 5, 30);

assert.equal(
  nextPlanningBoundary(partialIntervalStart, new Date(2026, 6, 11, 12, 0)),
  new Date(2026, 6, 11, 11, 30).getTime(),
);

assert.equal(
  nextPlanningBoundary(new Date(2026, 6, 11, 11, 30), new Date(2026, 6, 11, 12, 0)),
  new Date(2026, 6, 11, 12, 0).getTime(),
);

assert.equal(adaptiveChargingTimezoneError(parsedForecast, "Asia/Tokyo"), null);
assert.match(adaptiveChargingTimezoneError(parsedForecast, "UTC")!, /does not match/);
assert.match(adaptiveChargingTimezoneError(parsedForecast, null)!, /must be configured/);


const youngDemandHistory: any[] = [];

for (let daysAgo = 1; daysAgo <= 10; daysAgo += 1) {
  const day = new Date(2026, 6, 12 - daysAgo);
  for (let bucket = 0; bucket < 48; bucket += 1) {
    youngDemandHistory.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      houseDemandW: 900 + daysAgo * 20,
      coverageSeconds: { houseDemandKwh: 1800 },
    });
  }
}

const youngWeekendPrediction = predictHouseDemand(youngDemandHistory, new Date(2026, 6, 12));

assert.equal(youngWeekendPrediction.available, true);

assert.equal(youngWeekendPrediction.validDayCount, 10);

assert.equal(youngWeekendPrediction.sameDayTypeDays.length, 3);

assert.equal(youngWeekendPrediction.usedDayTypeFallback, true);


const indexedYoungDemandDays = aggregateDemandDays(youngDemandHistory);

const compactYoungDemandHistory = youngDemandHistory.map(({ coverageSeconds, ...sample }: any) => sample);

const indexedYoungPrediction = predictHouseDemand(
  compactYoungDemandHistory,
  new Date(2026, 6, 12),
  new Map(),
  { historicalDays: indexedYoungDemandDays },
);

assert.equal(indexedYoungPrediction.available, true);

assert.equal(indexedYoungPrediction.validDayCount, 10);


const incompleteDemandHistory = youngDemandHistory.filter((sample: any) => new Date(sample.timestamp).getHours() < 8);

const incompletePrediction = predictHouseDemand(incompleteDemandHistory, new Date(2026, 6, 12));

assert.equal(incompletePrediction.available, false);

assert.match(incompletePrediction.reason!, /0 of 10 days.*daytime coverage/);


const bands = normalizeRateBands({
  rateBands: [
    { start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" },
    { start: "07:00", end: "23:00", yenPerKwh: 40, label: "Day" },
  ],
});

assert.equal(rateForTimestamp(bands, "2026-05-31T23:30:00+09:00").yenPerKwh, 20);

assert.equal(rateForTimestamp(bands, "2026-05-31T12:00:00+09:00").yenPerKwh, 40);


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

assert.equal(sample.solarSavingYen, undefined);

assert.equal(sample.solarGenerationKwh, undefined);

assert.equal(sample.gridImportKwh, undefined);

assert.equal(sample.gridExportKwh, undefined);

assert.equal(sample.houseDemandKwh, 0.75);

assert.equal(sample.circuitPowerW["1"], 120);

assert.equal(sample.circuitCumulativeKwh["2"], 20.25);

assert.equal(sample.circuitEnergyKwh["1"], 0.5);

assert.equal(sample.circuitEnergyKwh["2"], 0.25);


const primaryFuelCellSample = sampleFromStatus({
  read_at: "2026-05-31T12:30:00+09:00",
  energy: { fuel_cells: [
    { host: "10.0.0.135", source_role: "proxy", instant_power: { value: 700 }, generation_status: { value: "generating", human: "generating" } },
    {
      host: "10.0.0.150",
      source_role: "primary",
      instant_power: { value: 650 },
      generation_status: { value: "generating", human: "generating" },
      cumulative_generation: { value: 100.25 },
      cumulative_gas: { value: 50.125 },
      hot_water_level: { value: 4 },
      interconnection_status: { value: "grid_connected_reverse_flow_prohibited", human: "grid_connected_reverse_flow_prohibited" },
    },
  ] },
}, { ...migratedFuelCellHosts, fuelCellEnabled: true }, {
  timestamp: "2026-05-31T12:15:00+09:00",
  fuelCellCumulativeGenerationKwh: 100,
  fuelCellCumulativeGasM3: 50,
  fuelCellGenerationState: "stopped",
  fuelCellCounterSourceHost: "10.0.0.150",
});

assert.equal(primaryFuelCellSample.fuelCellPowerW, 650);

assert.equal(primaryFuelCellSample.fuelCellKwh, 0.25);

assert.equal(primaryFuelCellSample.fuelCellGasM3, 0.125);

assert.equal(primaryFuelCellSample.fuelCellSourceHost, "10.0.0.150");

assert.equal(primaryFuelCellSample.fuelCellDataQuality, "counter");

assert.equal(primaryFuelCellSample.fuelCellHotWaterLevel, 4);

assert.equal(primaryFuelCellSample.fuelCellStartCount, 1);


const proxyFuelCellSample = sampleFromStatus({
  read_at: "2026-05-31T12:45:00+09:00",
  energy: { fuel_cells: [
    { host: "10.0.0.135", source_role: "proxy", instant_power: { value: 710 }, generation_status: { value: "generating", human: "generating" } },
  ] },
}, { ...proxyOnlyFuelCell, fuelCellEnabled: true }, primaryFuelCellSample);

assert.equal(proxyFuelCellSample.fuelCellPowerW, 710);

assert.equal(proxyFuelCellSample.fuelCellKwh, undefined);

assert.equal(proxyFuelCellSample.fuelCellGasM3, undefined);

assert.equal(proxyFuelCellSample.fuelCellDataQuality, "integrated");

assert.equal(proxyFuelCellSample.fuelCellCounterSourceHost, null);


const resetFuelCellSample = sampleFromStatus({
  read_at: "2026-05-31T13:00:00+09:00",
  energy: { fuel_cells: [{
    host: "10.0.0.150",
    source_role: "primary",
    instant_power: { value: 650 },
    cumulative_generation: { value: 1 },
    cumulative_gas: { value: 2 },
  }] },
}, { ...migratedFuelCellHosts, fuelCellEnabled: true }, {
  timestamp: "2026-05-31T12:45:00+09:00",
  fuelCellCumulativeGenerationKwh: 100,
  fuelCellCumulativeGasM3: 50,
  fuelCellCounterSourceHost: "10.0.0.150",
});

assert.equal(resetFuelCellSample.fuelCellKwh, undefined);

assert.deepEqual(resetFuelCellSample.fuelCellCounterIssues, [
  { counter: "electricity", issue: "reset" },
  { counter: "gas", issue: "reset" },
]);


const counterConfig: Record<string, any> = { ...migratedFuelCellHosts, smartCosmoEnabled: true, meterHost: "10.0.0.135" };

const missingCounterSample = sampleFromStatus({
  read_at: "2026-07-22T10:09:34.000Z",
  meter: {
    cumulative_bought: { value: 674.1 },
    cumulative_sold: { value: null },
    channel_energy: { decoded: { channels: [
      { channel: 1, value: null },
      { channel: 2, value: null },
    ] } },
  },
  energy: { fuel_cells: [{
    host: "10.0.0.150",
    source_role: "primary",
    cumulative_generation: { value: 4.5 },
    cumulative_gas: { value: null },
  }] },
}, counterConfig, {
  timestamp: "2026-07-22T10:09:27.000Z",
  meterCounterSourceHost: "10.0.0.135",
  gridImportCumulativeKwh: 674.1,
  gridExportCumulativeKwh: 11.04,
  circuitCumulativeKwh: { 1: 10, 2: 20 },
  fuelCellCounterSourceHost: "10.0.0.150",
  fuelCellCumulativeGenerationKwh: 4.5,
  fuelCellCumulativeGasM3: 1.5,
});

assert.equal(missingCounterSample.gridExportKwh, undefined);

assert.equal(missingCounterSample.fuelCellGasM3, undefined);

assert.deepEqual(missingCounterSample.circuitCumulativeKwh, {});

assert.deepEqual(missingCounterSample.circuitEnergyKwh, {});


const recoveredCounterSample = sampleFromStatus({
  read_at: "2026-07-22T10:09:41.000Z",
  meter: {
    cumulative_bought: { value: 674.1 },
    cumulative_sold: { value: 11.04 },
    channel_energy: { decoded: { channels: [
      { channel: 1, value: 10 },
      { channel: 2, value: 20 },
    ] } },
  },
  energy: { fuel_cells: [{
    host: "10.0.0.150",
    source_role: "primary",
    cumulative_generation: { value: 4.5 },
    cumulative_gas: { value: 1.5 },
  }] },
}, counterConfig, missingCounterSample);

assert.equal(recoveredCounterSample.gridExportKwh, undefined);

assert.equal(recoveredCounterSample.fuelCellGasM3, undefined);

assert.deepEqual(recoveredCounterSample.circuitEnergyKwh, {});


const resumedCounterSample = sampleFromStatus({
  read_at: "2026-07-22T10:09:48.000Z",
  meter: {
    cumulative_bought: { value: 674.11 },
    cumulative_sold: { value: 11.05 },
    channel_energy: { decoded: { channels: [
      { channel: 1, value: 10.01 },
      { channel: 2, value: 20 },
    ] } },
  },
  energy: { fuel_cells: [{
    host: "10.0.0.150",
    source_role: "primary",
    cumulative_generation: { value: 4.501 },
    cumulative_gas: { value: 1.501 },
  }] },
}, counterConfig, recoveredCounterSample);

assert.ok(Math.abs(resumedCounterSample.gridExportKwh! - 0.01) < 0.000001);

assert.ok(Math.abs(resumedCounterSample.gridImportKwh! - 0.01) < 0.000001);

assert.ok(Math.abs(resumedCounterSample.fuelCellKwh! - 0.001) < 0.000001);

assert.ok(Math.abs(resumedCounterSample.fuelCellGasM3! - 0.001) < 0.000001);

assert.ok(Math.abs(resumedCounterSample.circuitEnergyKwh["1"] - 0.01) < 0.000001);

assert.equal(resumedCounterSample.circuitEnergyKwh["2"], 0);


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

assert.equal(mixedGridSolarCharge.offPeakSavingYen, undefined);


const mixedChargeWithoutGridMeter = sampleFromStatus({
  read_at: offPeakTimestamp,
  energy: {
    battery: { instant_power: { value: 1000 } },
    solar: { instant_power: { value: 600 } },
  },
}, { ...migrated, rateBands: bands }, { timestamp: previousOffPeakTimestamp });

assert.equal(mixedChargeWithoutGridMeter.offPeakSavingYen, undefined);


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
