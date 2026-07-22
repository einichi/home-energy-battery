import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createNotificationService,
  normalizeNotificationConfig,
  smtpTransportOptions,
  validateSmtpSettings,
} from "../lib/notifications.js";
import { localIsoTimestamp, timestampConsole } from "../lib/console-timestamps.js";
import {
  activeAdaptiveChargingSlotStopReason,
  advanceAdaptiveChargingBreakerRecovery,
  aggregateDemandDays,
  applySolarForecastBias,
  applyInterruptedChargeCap,
  aggregateEnergyReportSamples,
  assertDeviceCommandResult,
  beginAdaptiveChargingBreakerRecovery,
  buildBatteryLearningModel,
  buildFuelCellGenerationModel,
  buildAdaptiveChargingTimelineView,
  batteryLearningModelSwitchDue,
  consumeBatteryLearningModelSwitch,
  capAdaptiveChargingSlotToRemainingTime,
  clearStaleScheduleRuns,
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  cleanConfig,
  cleanAdaptiveChargingPerformance,
  cleanAdaptiveChargingState,
  consumeCompletedAdaptiveChargingSlot,
  countGuardTriggersForRange,
  discountedBandOccurrence,
  discountedBandOccurrences,
  discountedPlanStatus,
  dailySolarForecastIssues,
  effectiveBatteryLearningModel,
  effectiveAdaptiveChargeWatts,
  executeAdaptiveChargeStart,
  enforceAdaptiveChargingSlotEndDeadline,
  evaluateAutomationRule,
  extractBatteryLearningObservations,
  forecastHourForInterval,
  forecastIsFresh,
  fuelCellGasUsageByBillingPeriod,
  finalizeAdaptiveChargeSession,
  finalizeAdaptiveChargingWindowExecution,
  learnedSolarFactor,
  logAdaptiveChargingInitialHeadroomWait,
  logAdaptiveChargingBreakerWait,
  migrateLegacyAdaptiveChargingData,
  migrateBatteryLearningState,
  normalizeCircuitLabels,
  normalizeDashboardWidgets,
  normalizeRateBands,
  normalizeSubnets,
  nextPlanningBoundary,
  optimizeDiscountedChargeSlots,
  parseJsonWithContext,
  parseOpenMeteoForecast,
  planChronologicalDiscountedCharging,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingLiveImportSafety,
  adaptiveChargingBreakerSettings,
  adaptiveChargingBreakerRecoveryReady,
  adaptiveChargingSlotEndDelayMs,
  adaptiveChargingSlotEndKey,
  preserveInterruptedAdaptiveCharge,
  recordAdaptiveChargingWindowInterruption,
  adaptiveChargingTimezoneError,
  awayPeriodContains,
  awayPeriodForecastContains,
  filterDemandDaysByOccupancy,
  predictAwayDemand,
  rateForTimestamp,
  recoverConcatenatedJsonValue,
  runCliQueued,
  sampleFromStatus,
  setDeviceCommandExecutor,
  shouldTriggerDemandGuard,
  shouldHoldGuardStandbyForAdaptiveCharging,
  adaptiveChargingPlanRefreshDecision,
  adaptiveChargingPlanLogMessage,
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  solarPowerFromIrradiance,
  predictHouseDemand,
  summarizeSamples,
  suspendAdaptiveChargeInStandby,
  syncAdaptiveChargingWindowExecution,
  updateAdaptiveChargingSolarHeadroomHold,
  verifyBatteryOperationMode,
} from "../server.js";

const timestampWrites = [];
const testConsole = {
  log: (...args) => timestampWrites.push(args),
  warn: (...args) => timestampWrites.push(args),
};
assert.equal(timestampConsole(testConsole, () => new Date("2026-07-21T03:30:00.123Z")), true);
testConsole.log("automation", { state: "ready" });
assert.deepEqual(timestampWrites[0], [
  `[${localIsoTimestamp("2026-07-21T03:30:00.123Z")}]`,
  "automation",
  { state: "ready" },
]);
assert.equal(timestampConsole(testConsole), false);

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

let releaseBlockedCli;
const restoreQueuedExecutor = setDeviceCommandExecutor(async (command) => {
  if (command === "inspect-host") {
    return new Promise((resolve) => { releaseBlockedCli = resolve; });
  }
  return { ok: true };
});
const blockedCli = runCliQueued("inspect-host", { host: "192.0.2.10" }, [], { queueTimeoutMs: 1000 });
await assert.rejects(
  runCliQueued("probe", { host: "192.0.2.11" }, [], { queueTimeoutMs: 5 }),
  /timed out after waiting 5ms in the device command queue/,
);
releaseBlockedCli({ ok: true });
await blockedCli;
restoreQueuedExecutor();

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
const migratedFuelCellAutomation = cleanConfig({
  fuelCell: {
    generationModel: "fixed",
    plannerInfluence: "active",
    fixedWindows: [{ label: "Legacy", days: [1, 2, 3], start: "08:00", end: "10:00" }],
  },
}).fuelCell.automation;
assert.equal(migratedFuelCellAutomation.enabled, false);
assert.equal(migratedFuelCellAutomation.includeInAdaptiveCharging, true);
assert.deepEqual(migratedFuelCellAutomation.schedules, [{
  label: "Legacy",
  days: [1, 2, 3],
  start: "08:00",
  end: "10:00",
}]);

const billingPeriodGas = fuelCellGasUsageByBillingPeriod([
  { timestamp: "2026-07-09T00:00:00", fuelCellGasM3: 1.25 },
  { timestamp: "2026-08-07T23:59:00", fuelCellGasM3: 0.75 },
  { timestamp: "2026-08-08T00:00:00", fuelCellGasM3: 2 },
  { timestamp: "2026-08-09T00:00:00", fuelCellGasM3: null },
], 8);
assert.equal(billingPeriodGas.get("2026-07"), 2);
assert.equal(billingPeriodGas.get("2026-08"), 2);

const fuelCellSamples = [];
for (let day = 1; day <= 8; day += 1) {
  for (let bucket = 0; bucket < 20; bucket += 1) {
    fuelCellSamples.push({
      timestamp: new Date(2026, 6, day, 8 + Math.floor(bucket / 2), bucket % 2 ? 30 : 0).toISOString(),
      fuelCellPowerW: 650 + day * 2,
      fuelCellGenerationState: "generating",
    });
  }
}
const fixedFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: {
    automation: {
      enabled: true,
      includeInAdaptiveCharging: true,
      schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00" }],
    },
  },
}), fuelCellSamples, new Date(2026, 6, 9, 9));
assert.equal(fixedFuelCellModel.influence, "active");
assert.ok(fixedFuelCellModel.forecastAt(new Date(2026, 6, 9, 10)).medianW > 600);
assert.equal(fixedFuelCellModel.forecastAt(new Date(2026, 6, 9, 20)).medianW, 0);
const observedFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { automation: { includeInAdaptiveCharging: false } },
}), fuelCellSamples, new Date(2026, 6, 9, 9));
assert.equal(observedFuelCellModel.ready, true);
assert.equal(observedFuelCellModel.influence, "observe");
const immatureFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { automation: { includeInAdaptiveCharging: true } },
}), fuelCellSamples.filter((sample) => new Date(sample.timestamp).getDate() <= 3), new Date(2026, 6, 9, 9));
assert.equal(immatureFuelCellModel.ready, false);
assert.equal(immatureFuelCellModel.influence, "observe");
assert.match(immatureFuelCellModel.blockers.join("; "), /valid observation days required/);
const denseFuelCellSamples = fuelCellSamples.flatMap((sample) => [
  sample,
  { ...sample, timestamp: new Date(new Date(sample.timestamp).getTime() + 5 * 60_000).toISOString() },
  { ...sample, timestamp: new Date(new Date(sample.timestamp).getTime() + 10 * 60_000).toISOString() },
]);
const denseFuelCellModel = buildFuelCellGenerationModel(cleanConfig({
  fuelCell: { automation: { includeInAdaptiveCharging: false } },
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
assert.equal(simple.dashboardWidgets.length, 23);
assert.equal(simple.dashboardWidgets[0].id, "solarPower");
assert.equal(simple.dashboardWidgets.find((widget) => widget.id === "adaptiveCharging")?.priority, 5);
assert.equal(simple.dashboardWidgets.find((widget) => widget.id === "awayStatus")?.priority, 7);
assert.deepEqual(simple.batteryCapabilities, { usableCapacityKwh: null, maximumChargeWatts: null });
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

const migrationDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-charging-migration-"));
try {
  await mkdir(path.join(migrationDir, "solar-planner"), { recursive: true });
  await writeFile(path.join(migrationDir, "config.json"), JSON.stringify({
    adaptiveCharging: null,
    solarPlanner: { enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 4 },
    retention: { plannerHistoryDays: 1800 },
    notifications: { triggers: { plannerUnavailable: { enabled: false, cooldownMinutes: 90 } } },
  }));
  await writeFile(path.join(migrationDir, "solar-planner-state.json"), JSON.stringify({
    owner: "planner",
    log: [{ at: "2026-07-11T00:00:00.000Z", message: "existing decision" }],
  }));
  await writeFile(path.join(migrationDir, "adaptive-charging-state.json"), "{invalid canonical state");
  await writeFile(
    path.join(migrationDir, "solar-planner", "demand-day-profiles.json"),
    JSON.stringify({ version: 1, days: {} }),
  );
  await migrateLegacyAdaptiveChargingData(migrationDir, { info() {}, warn() {} });
  const migratedConfig = JSON.parse(await readFile(path.join(migrationDir, "config.json"), "utf8"));
  assert.equal(migratedConfig.adaptiveCharging.enabled, true);
  assert.equal(migratedConfig.solarPlanner, undefined);
  assert.equal(migratedConfig.retention.adaptiveChargingHistoryDays, 1800);
  assert.equal(migratedConfig.notifications.triggers.adaptiveChargingUnavailable.enabled, false);
  const migratedState = JSON.parse(await readFile(path.join(migrationDir, "adaptive-charging-state.json"), "utf8"));
  assert.equal(migratedState.owner, "adaptiveCharging");
  assert.equal(
    JSON.parse(await readFile(path.join(migrationDir, "adaptive-charging", "demand-day-profiles.json"), "utf8")).version,
    1,
  );
  await assert.rejects(readFile(path.join(migrationDir, "solar-planner-state.json"), "utf8"), { code: "ENOENT" });
} finally {
  await rm(migrationDir, { recursive: true, force: true });
}

const batteryModelMigrationDir = await mkdtemp(path.join(os.tmpdir(), "battery-model-migration-"));
try {
  const legacyState = {
    owner: null,
    plan: { available: true, plannedChargeKwh: 4.2 },
    learnedConversionActive: true,
    chargingPerformance: {
      sessions: [{
        startedAt: "2026-07-10T01:00:00.000Z",
        endedAt: "2026-07-10T02:00:00.000Z",
        deliveredWh: 1900,
        capacityKwh: 4.4,
        estimatedStorageEfficiencyPercent: 79,
      }],
    },
    windowSummaries: [{
      key: "legacy-window",
      windowStart: "2026-07-10T01:00:00.000Z",
      windowEnd: "2026-07-10T05:00:00.000Z",
      deliveredWh: 1900,
    }],
  };
  await writeFile(
    path.join(batteryModelMigrationDir, "adaptive-charging-state.json"),
    JSON.stringify(legacyState),
  );
  const batteryMigration = await migrateBatteryLearningState(
    batteryModelMigrationDir,
    { info() {} },
  );
  assert.equal(batteryMigration.migrated, true);
  const canonical = JSON.parse(await readFile(
    path.join(batteryModelMigrationDir, "adaptive-charging-state.json"),
    "utf8",
  ));
  assert.equal(canonical.batteryLearning.version, 2);
  assert.equal(canonical.plan, null);
  assert.equal(canonical.pendingPlanReason, "battery model migration");
  assert.equal(canonical.learnedConversionActive, undefined);
  assert.equal(canonical.chargingPerformance.sessions[0].modelVersion, 1);
  assert.equal(canonical.chargingPerformance.sessions[0].estimatedStorageEfficiencyPercent, undefined);
  assert.equal(canonical.chargingPerformance.sessions[0].capacityKwh, undefined);
  assert.equal(canonical.windowSummaries[0].modelVersion, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      batteryModelMigrationDir,
      "adaptive-charging",
      "migrations",
      "adaptive-charging-state-model-v1.json",
    ), "utf8")),
    legacyState,
  );
  assert.equal((await migrateBatteryLearningState(batteryModelMigrationDir, { info() {} })).migrated, false);
} finally {
  await rm(batteryModelMigrationDir, { recursive: true, force: true });
}

const activeBatteryModelMigrationDir = await mkdtemp(
  path.join(os.tmpdir(), "active-battery-model-migration-"),
);
try {
  const activeMigrationSlotEnd = new Date(Date.now() + 60 * 60_000).toISOString();
  await writeFile(
    path.join(activeBatteryModelMigrationDir, "adaptive-charging-state.json"),
    JSON.stringify({
      owner: "adaptiveCharging",
      plan: { available: true, plannedChargeKwh: 1.2 },
      activeSlot: { targetWh: 900, end: activeMigrationSlotEnd },
      activeChargedKwh: 0.25,
      activeChargeSession: {
        startedAt: "2026-07-10T01:00:00.000Z",
        requestedWh: 900,
        capacityKwh: 4.4,
      },
    }),
  );
  await migrateBatteryLearningState(activeBatteryModelMigrationDir, { info() {} });
  const activeCanonical = JSON.parse(await readFile(
    path.join(activeBatteryModelMigrationDir, "adaptive-charging-state.json"),
    "utf8",
  ));
  assert.equal(activeCanonical.owner, "adaptiveCharging");
  assert.equal(activeCanonical.plan.plannedChargeKwh, 1.2);
  assert.equal(activeCanonical.activeSlot.targetWh, 900);
  assert.equal(activeCanonical.activeChargedKwh, 0.25);
  assert.equal(activeCanonical.pendingPlanReason, null);
  assert.equal(activeCanonical.batteryLearning.switchAfterSlotEnd, activeMigrationSlotEnd);
} finally {
  await rm(activeBatteryModelMigrationDir, { recursive: true, force: true });
}

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
assert.ok(timelineView.every((item) => item.predictedSocPercent >= 20));
assert.ok(Math.abs(timelineView[0].predictedStartSocPercent - 40) < 1e-9);
assert.ok(Math.abs(timelineView[0].predictedEndSocPercent - 36) < 1e-9);
assert.equal(timelineView[1].predictedStartSocPercent, timelineView[0].predictedEndSocPercent);
assert.ok(Math.abs(timelineView[1].predictedEndSocPercent - 44) < 1e-9);
assert.equal(timelineView[2].predictedStartSocPercent, timelineView[1].predictedEndSocPercent);
assert.ok(Math.abs(timelineView[2].predictedEndSocPercent - 47.2) < 1e-9);

const awayPeriods = [
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
const occupancySamples = [
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
  directPowerCoverageDays[0].coverageByBucket.get(directCoverageBucket),
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
assert.equal(adaptiveChargingTimezoneError(parsedForecast), null);
process.env.TZ = "UTC";
assert.match(adaptiveChargingTimezoneError(parsedForecast), /does not match/);
if (originalTimezone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimezone;

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
assert.equal(new Date(overnightOccurrence.start).getHours(), 23);
assert.equal(new Date(overnightOccurrence.end).getDate(), new Date(2026, 6, 12).getDate());
assert.equal(new Date(overnightOccurrence.end).getHours(), 1);
const rebaseNow = new Date(2026, 6, 11, 23, 30);
const waitingAdaptiveChargingState = {
  owner: null,
  forecast: { fetchedAt: "2026-07-11T10:00:00.000Z" },
  plan: { createdAt: rebaseNow.toISOString(), currentSocPercent: 30, forecastFetchedAt: "2026-07-11T10:00:00.000Z" },
  lastPlanEventKey: null,
};
const entryRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, rebaseNow);
assert.equal(entryRefresh.refresh, true);
assert.match(entryRefresh.trigger, /30-minute slot boundary/);
const rebasedAdaptiveChargingState = { ...waitingAdaptiveChargingState, lastPlanEventKey: entryRefresh.eventKey };
assert.equal(adaptiveChargingPlanRefreshDecision(rebasedAdaptiveChargingState, adaptiveChargingConfig, rebaseNow).refresh, false);
assert.equal(adaptiveChargingPlanRefreshDecision(rebasedAdaptiveChargingState, adaptiveChargingConfig, new Date(2026, 6, 12, 0, 0)).refresh, true);
const prewindowNow = new Date(2026, 6, 11, 22, 30);
const prewindowRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, prewindowNow);
assert.equal(prewindowRefresh.refresh, true);
assert.match(prewindowRefresh.trigger, /30 minutes before Cheapest/);
assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  lastPlanEventKey: prewindowRefresh.eventKey,
}, adaptiveChargingConfig, new Date(2026, 6, 11, 22, 45)).refresh, false);
const windowEntryRefresh = adaptiveChargingPlanRefreshDecision(waitingAdaptiveChargingState, adaptiveChargingConfig, new Date(2026, 6, 11, 23, 0));
assert.equal(windowEntryRefresh.refresh, true);
assert.match(windowEntryRefresh.trigger, /entering Cheapest/);
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
  windows: [{ label: "Cheapest", targetSocPercent: 52, plannedChargeKwh: 1.97 }],
  slots: [{ start: "2026-07-11T04:03:42.000Z", end: "2026-07-11T05:00:00.000Z", targetWh: 1970 }],
}, "entering Cheapest", 10);
assert.match(recalculationLog, /Plan recalculated \(entering Cheapest\)/);
assert.match(recalculationLog, /targets \[Cheapest 52%\/1\.97 kWh\]/);
assert.match(recalculationLog, /slots \[.*1970 Wh\]/);
assert.match(recalculationLog, /test warning/);
assert.match(recalculationLog, /battery model v2 \[charge 54\.0 Wh\/SOC \(configured\), discharge 50\.0 Wh\/SOC \(learned\), power 2192 W \(configured\)\]/);
assert.equal(adaptiveChargingPlanRefreshDecision({
  ...waitingAdaptiveChargingState,
  plan: { ...waitingAdaptiveChargingState.plan, createdAt: "2026-07-01T00:00:00.000Z" },
}, adaptiveChargingConfig, new Date(2026, 6, 11, 12, 0)).refresh, false);
const modelSwitchNow = new Date("2026-07-19T04:00:00.000Z");
assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: null } }, modelSwitchNow), false);
assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: "2026-07-19T03:59:59.000Z" } }, modelSwitchNow), true);
assert.equal(batteryLearningModelSwitchDue({ batteryLearning: { switchAfterSlotEnd: "2026-07-19T04:00:01.000Z" } }, modelSwitchNow), false);
const deferredModelSwitchState = cleanAdaptiveChargingState({
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

const solarHeadroomState = {
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
assert.ok(discountedBandOccurrences(adaptiveChargingConfig, prewindowNow).length >= 2);

const learnedChargingPerformance = cleanAdaptiveChargingPerformance({
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

function batteryLearningRollup(day, kind, {
  startSoc = kind === "charge" ? 10 : 40,
  endSoc = kind === "charge" ? 30 : 20,
  energyWh = 1000,
  coverageSeconds = 1800,
  manualAction = false,
} = {}) {
  const start = new Date(`2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 1_800_000);
  return {
    rollupStart: start.toISOString(),
    rollupEnd: end.toISOString(),
    startStateOfChargePercent: startSoc,
    endStateOfChargePercent: endSoc,
    batteryChargeKwh: kind === "charge" ? energyWh / 1000 : 0,
    batteryDischargeKwh: kind === "discharge" ? energyWh / 1000 : 0,
    coverageSeconds: {
      [kind === "charge" ? "batteryChargeKwh" : "batteryDischargeKwh"]: coverageSeconds,
    },
    manualAction,
  };
}

const historicalChargeRollups = Array.from({ length: 10 }, (_, index) => (
  batteryLearningRollup(index + 1, "charge")
));
const freshChargeRollups = Array.from({ length: 5 }, (_, index) => (
  batteryLearningRollup(index + 11, "charge")
));
const historicalDischargeRollups = Array.from({ length: 10 }, (_, index) => (
  batteryLearningRollup(index + 1, "discharge")
));
const freshDischargeRollups = Array.from({ length: 5 }, (_, index) => (
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

const steadyPowerSamples = [
  ...Array.from({ length: 40 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-11T01:00:00.000Z") + index * 30_000).toISOString(),
    batteryChargingW: 2000,
  })),
  ...Array.from({ length: 40 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-12T01:00:00.000Z") + index * 30_000).toISOString(),
    batteryChargingW: 2000,
  })),
  ...Array.from({ length: 40 }, (_, index) => ({
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
assert.equal(retainedSnapshotModel.charge.activationSnapshot.candidateWhPerSocPoint, 50);

const independentlyActiveChargeModel = buildBatteryLearningModel(
  exactBatteryConfig,
  [...historicalChargeRollups, ...freshChargeRollups],
  { migratedAt: "2026-07-11T00:00:00.000Z" },
  new Date("2026-07-16T00:00:00.000Z"),
);
assert.equal(independentlyActiveChargeModel.charge.source, "learned");
assert.equal(independentlyActiveChargeModel.discharge.source, "configured");
assert.equal(independentlyActiveChargeModel.status, "active");

const driftedChargeRollups = Array.from({ length: 3 }, (_, index) => (
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
assert.match(degradedBatteryModel.charge.demotionReason, /drift|validation/);
assert.equal(degradedBatteryModel.status, "degraded");

const rejectedBatteryObservations = extractBatteryLearningObservations([
  batteryLearningRollup(1, "charge", { startSoc: 70, endSoc: 100 }),
  batteryLearningRollup(2, "charge", { coverageSeconds: 1000 }),
  batteryLearningRollup(3, "charge", { manualAction: true }),
  batteryLearningRollup(4, "discharge", { startSoc: 20, endSoc: 40 }),
]);
assert.equal(rejectedBatteryObservations.length, 4);
assert.match(rejectedBatteryObservations[0].rejectionReason, /censored upper SOC/);
assert.match(rejectedBatteryObservations[1].rejectionReason, /coverage/);
assert.match(rejectedBatteryObservations[2].rejectionReason, /manual action/);
assert.match(rejectedBatteryObservations[3].rejectionReason, /reversed/);

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

const completedChargeState = {
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
  completedChargeState,
  "Planned charge target reached",
  new Date("2026-07-11T01:00:00.000Z"),
);
assert.equal(completedChargeSession.deliveredWh, 1000);
assert.equal(completedChargeSession.averageChargeWatts, 1000);
assert.equal("estimatedStorageEfficiencyPercent" in completedChargeSession, false);
assert.equal("capacityKwh" in completedChargeSession, false);
assert.equal(completedChargeSession.modelVersion, 2);
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
  chargingPerformance: cleanAdaptiveChargingPerformance(),
  windowSummaries: [],
};
syncAdaptiveChargingWindowExecution(executionState, executionOccurrence, {
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
syncAdaptiveChargingWindowExecution(executionState, executionOccurrence, {
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
finalizeAdaptiveChargeSession(executionState, "breaker interruption", new Date("2026-07-11T12:20:00.000Z"));
recordAdaptiveChargingWindowInterruption(executionState);
syncAdaptiveChargingWindowExecution(executionState, executionOccurrence, {
  slots: [{
    start: "2026-07-11T12:40:00.000Z",
    end: executionOccurrence.end,
    windowStart: executionOccurrence.start,
    windowEnd: executionOccurrence.end,
    targetWh: 400,
  }],
}, 30, new Date("2026-07-11T12:30:00.000Z"));
const executionSummary = finalizeAdaptiveChargingWindowExecution(
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
const optimizedSlots = optimizeDiscountedChargeSlots({
  config: adaptiveChargingConfig,
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

const adaptiveChargingGuardRules = [{
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
const initialWaitState = { log: [] };
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
const recoveryState = {};
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
const activeAdaptiveChargingSlot = {
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
}, activeAdaptiveChargingNow), /remaining charge target/);
assert.match(activeAdaptiveChargingSlotStopReason({
  owner: "adaptiveCharging",
  activeSlot: activeAdaptiveChargingSlot,
  activePlanCreatedAt: "old-plan",
  activeChargedKwh: 0.2,
}, adaptiveChargingConfig, {
  createdAt: "new-plan",
  slots: [],
}, activeAdaptiveChargingNow), /no longer includes/);

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
const firstInterruption = preserveInterruptedAdaptiveCharge(
  interruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);
assert.equal(firstInterruption.deliveredWh, 300);
assert.equal(firstInterruption.remainingWh, 750);
assert.equal(interruptedState.plan.slots[0].targetWh, 750);

interruptedState.activeSlot = interruptedState.plan.slots[0];
interruptedState.activeChargedKwh = 0.2;
const repeatedInterruption = preserveInterruptedAdaptiveCharge(
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
const delayedInterruption = preserveInterruptedAdaptiveCharge(
  delayedInterruptedState,
  new Date("2026-07-11T12:10:00.000Z"),
);
assert.equal(delayedInterruption.remainingWh, 750);
assert.equal(delayedInterruptedState.plan.slots[0].targetWh, 750);

const suspendedActions = [];
const suspendedState = {
  owner: "adaptiveCharging",
  activeSlot: interruptedSlot,
  activePlanCreatedAt: "plan",
  activeChargedKwh: 0.25,
  activeLastCheckedAt: "2026-07-11T12:10:00.000Z",
  activeChargeSession: null,
  log: [],
};
await suspendAdaptiveChargeInStandby(
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

const heldStandbyActions = [];
const heldStandbyState = {
  owner: "adaptiveCharging",
  activeSlot: interruptedSlot,
  activePlanCreatedAt: "plan",
  activeChargedKwh: 1.05,
  activeLastCheckedAt: "2026-07-11T12:28:30.000Z",
  activeChargeSession: null,
  log: [],
};
await suspendAdaptiveChargeInStandby(
  heldStandbyState,
  "Planned charge target reached",
  new Date("2026-07-11T12:28:30.000Z"),
  null,
  async (action, payload) => {
    heldStandbyActions.push({ action, payload });
    return { ok: true };
  },
  "2026-07-11T13:00:00.000Z",
);
assert.deepEqual(heldStandbyActions, [{ action: "set-mode", payload: { mode: "standby" } }]);
assert.equal(heldStandbyState.standbyHoldUntil, "2026-07-11T13:00:00.000Z");
assert.match(heldStandbyState.log.at(-1).message, /holding Standby operation mode until/);

const resumedActions = [];
await executeAdaptiveChargeStart({ targetWh: 750 }, {
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
await assert.rejects(executeAdaptiveChargeStart({ targetWh: 750 }, {
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

const lateAdaptiveChargingSlot = capAdaptiveChargingSlotToRemainingTime(
  { ...interruptedSlot, targetWh: 750 },
  2100,
  new Date("2026-07-11T12:20:00.000Z"),
);
assert.equal(lateAdaptiveChargingSlot.targetWh, 350);
assert.equal(lateAdaptiveChargingSlot.start, "2026-07-11T12:20:00.000Z");
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

const deadlineState = {
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

const intermediateDeadlineState = {
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
  suspend: async (state, reason, now, host, execute, holdUntil) => {
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

const overdueWindowState = {
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
    release: async (state) => {
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

const failedDeadlineState = {
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

const efficiencyAdjustedPlan = planChronologicalDiscountedCharging({
  timeline: [0, 0.5, 1, 1.5, 2].map((hour) => chronologicalSlot(
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
  timeline: [0, 0.5, 1, 1.5].map((hour) => chronologicalSlot(
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
      coverageSeconds: { houseDemandKwh: 1800 },
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
      coverageSeconds: { houseDemandKwh: 1800 },
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
    coverageSeconds: { houseDemandKwh: 1800 },
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
const compactYoungDemandHistory = youngDemandHistory.map(({ coverageSeconds, ...sample }) => sample);
const indexedYoungPrediction = predictHouseDemand(
  compactYoungDemandHistory,
  new Date(2026, 6, 12),
  new Map(),
  { historicalDays: indexedYoungDemandDays },
);
assert.equal(indexedYoungPrediction.available, true);
assert.equal(indexedYoungPrediction.validDayCount, 10);

const incompleteDemandHistory = youngDemandHistory.filter((sample) => new Date(sample.timestamp).getHours() < 8);
const incompletePrediction = predictHouseDemand(incompleteDemandHistory, new Date(2026, 6, 12));
assert.equal(incompletePrediction.available, false);
assert.match(incompletePrediction.reason, /0 of 10 days.*daytime coverage/);

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
const alignedSolarFactor = learnedSolarFactor(alignedSolarSamples, alignedWeather, adaptiveChargingConfig);
assert.equal(alignedSolarFactor.learned, true);
assert.equal(alignedSolarFactor.factor, 2);

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
assert.equal(normalizedWidgets.length, 23);
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
assert.equal(normalizedWidgets.some((widget) => widget.id === "fuelCellStateTimeline"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "fuelCellHotWater"), true);
assert.equal(normalizedWidgets.some((widget) => widget.id === "adaptiveCharging"), true);

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
assert.ok(Math.abs(partialRangeReport.totals.gridImportKwh - 17 / 60) < 1e-9);
assert.ok(Math.abs(partialRangeReport.totals.solarSavingYen - 17) < 1e-9);
assert.ok(Math.abs(partialRangeReport.totals.offPeakSavingYen - 6.8) < 1e-9);
assert.equal(
  partialRangeReport.buckets[0].dataQuality.gridImportKwh.coveragePercent,
  100,
  "partial calendar buckets report coverage against the selected range",
);

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
  conditions: { source: "houseDemandW", breakerAmps: 40, reserveAmps: 5 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { house_demand_power: { value: 2800 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(actualChargingSafe.result.skipped, "conditions not met");
assert.equal(actualChargingSafe.result.actualDemandWithChargingW, 3400);

const gridImportDoesNotDoubleCountCharging = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  conditions: { source: "gridImportW", breakerAmps: 40, reserveAmps: 5 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { grid_import_power: { value: 3400 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(gridImportDoesNotDoubleCountCharging.result.skipped, "conditions not met");
assert.equal(gridImportDoesNotDoubleCountCharging.result.guardDemandW, 3400);

const guardBatteryConfig = { batteryCapabilities: { maximumChargeWatts: 1000 } };

const restoreWouldTrip = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  conditions: {
    breakerAmps: 40,
    source: "houseDemandW",
    reserveAmps: 5,
    restoreBelowAmps: 30,
  },
}), {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { house_demand_power: { value: 2600 } },
}, new Date("2026-05-31T00:00:00.000Z"), () => {}, guardBatteryConfig);
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
    restoreBelowAmps: 30,
  },
});
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3200 } },
}, new Date("2026-05-31T00:01:00.000Z"), () => {}, guardBatteryConfig);
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3100 } },
}, new Date("2026-05-31T00:02:00.000Z"), () => {}, guardBatteryConfig);
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
    restoreBelowAmps: 30,
  },
});
await evaluateAutomationRule(reassertStandbyRule, {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 2000 } },
}, new Date("2026-05-31T00:03:00.000Z"), () => {}, guardBatteryConfig, {
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
    restoreBelowAmps: 30,
    restoreDelaySeconds: 30,
  },
});
const deferredRestore = await evaluateAutomationRule(deferredRestoreRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 2000 } },
}, new Date("2026-05-31T00:01:00.000Z"), () => {}, guardBatteryConfig, {
  holdStandbyForAdaptiveCharging: true,
  execute: async (action, payload) => deferredRestoreActions.push({ action, payload }),
});
assert.equal(deferredRestore.result.skipped, "adaptiveCharging waiting to resume charging");
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
