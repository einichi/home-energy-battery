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
  shouldTriggerDemandGuard,
} from "../lib/domain/automation-rules.js";

import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "../lib/counter-utils.js";

import { createAutomationRuleEvaluator } from "../lib/services/automation-rule-evaluator.js";

const evaluateAutomationRule = createAutomationRuleEvaluator({
  execute: async () => ({ ok: true }),
  recordGuardTrigger: async () => undefined,
  notify: () => undefined,
});


const rule = cleanAutomationRule({ enabled: true, conditions: { breakerAmps: 40, reserveAmps: 5, source: "houseDemandW" } });

assert.equal(rule.action, "set-mode");

assert.equal(rule.payload.mode, "standby");

assert.equal(rule.restoreAction, "set-mode");

assert.equal(rule.restorePayload.mode, "auto");

assert.equal(rule.dashboardWarningEnabled, true);

assert.equal(cleanAutomationRule({ dashboardWarningEnabled: false }).dashboardWarningEnabled, false);

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

assert.equal(ruleConfig.dashboardWarningEnabled, true);

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


const guardBatteryConfig: Record<string, any> = { batteryCapabilities: { maximumChargeWatts: 1000 } };


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


const reassertActions: any[] = [];

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
  execute: async (action: any, payload: any) => {
    reassertActions.push({ action, payload });
    return { ok: true };
  },
});

assert.deepEqual(reassertActions, [{ action: "set-mode", payload: { mode: "standby" } }]);

assert.equal(reassertStandbyRule.state.awaitingRestore, true);

assert.match(reassertStandbyRule.log.at(-1)!.message, /returning it to Standby/);


const deferredRestoreActions: any[] = [];

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
  execute: async (action: any, payload: any) => deferredRestoreActions.push({ action, payload }),
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

assert.equal(normalizedNotifications.channels[0].settings.port, 587);

assert.equal(normalizedNotifications.channels[0].settings.security, "starttls");

assert.deepEqual(normalizedNotifications.channels[0].settings.recipients, ["one@example.test", "two@example.test"]);

assert.equal(normalizedNotifications.triggers.scheduleFailed.enabled, false);

assert.equal(normalizedNotifications.triggers.scheduleFailed.cooldownMinutes, 1);

assert.equal(normalizedNotifications.triggers.fuelCellHotWaterEmpty.enabled, true);

assert.equal(normalizedNotifications.triggers.fuelCellHotWaterEmpty.cooldownMinutes, 60);

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

for (const port of [25, 465, 587]) {
  assert.equal(validateSmtpSettings({
    host: "smtp.example.test",
    port,
    security: port === 465 ? "tls" : "starttls",
    from: "energy@example.test",
    recipients: ["owner@example.test"],
  }).length, 0);
}
assert.match(validateSmtpSettings({
  host: "smtp.example.test",
  port: 2525,
  security: "starttls",
  from: "energy@example.test",
  recipients: ["owner@example.test"],
}).join("; "), /25, 465, or 587/);
assert.equal(smtpTransportOptions({ port: 2525, security: "starttls" }).port, 587);

assert.deepEqual(smtpTransportOptions({
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "energy",
}, { password: "secret" }).auth, { user: "energy", pass: "secret" });


const notificationDir = await mkdtemp(path.join(os.tmpdir(), "home-energy-notifications-"));

const sentMessages: any[] = [];

const recordedNotificationEvents: any[] = [];

let notificationState: Record<string, any> = {};

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
  createTransport: (options: any) => ({
    async sendMail(message: any): Promise<any> {
      sentMessages.push({ options, message });
      return { messageId: `message-${sentMessages.length}` };
    },
    close(): any {},
  }),
  recordEvent: async (event: any) => recordedNotificationEvents.push(event),
  stateStore: {
    isReady: () => true,
    read: (_key: any, fallback: any) => notificationState ?? fallback,
    write: (_key: any, value: any) => { notificationState = structuredClone(value); },
  },
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

for (let index = 0; index < 2; index += 1) {
  await notificationService.observeCondition({
    key: "fuel-cell-hot-water-empty-test",
    active: true,
    activateAfter: 2,
    recoverAfter: 2,
    activeEvent: {
      type: "fuelCellHotWaterEmpty",
      title: "Ene-Farm hot-water tank is empty",
      message: "Tank level is 0/5",
      dedupeKey: "fuel-cell-hot-water:test:empty",
    },
  });
}

assert.equal(sentMessages.length, 4);

await notificationService.observeCondition({
  key: "fuel-cell-hot-water-empty-test",
  active: true,
  activateAfter: 2,
  activeEvent: {
    type: "fuelCellHotWaterEmpty",
    title: "Ene-Farm hot-water tank is empty",
    message: "Tank level is 0/5",
    dedupeKey: "fuel-cell-hot-water:test:empty",
  },
});

assert.equal(sentMessages.length, 4, "an empty tank should notify only once until it recovers");

await notificationService.sendTest();

assert.equal(sentMessages.length, 5);

assert.match(sentMessages.at(-1).message.subject, /Test notification/);

assert.equal((await notificationService.view()).deliveries.length, 5);

await notificationService.updateSecret({ channelId: "primary-email", clearPassword: true });

assert.equal((await notificationService.view()).passwordConfigured, false);

await rm(notificationDir, { recursive: true, force: true });


console.log("helper tests passed");
