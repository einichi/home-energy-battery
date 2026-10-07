#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNotificationService,
  normalizeNotificationConfig,
} from "./notifications.js";
import {
  createHistoryStore,
  inspectHistoryDatabase,
} from "./history-store.js";
import {
  gasTariffHash,
  importGasTariff,
  normalizeGasTariffPayload,
  validBillingMonth,
} from "./gas-tariffs.js";
import { timestampConsole } from "./console-timestamps.js";
import {
  assertSafeUiDevelopmentEnvironment,
  externalIoDisabled,
  uiDevelopmentMode,
} from "./development-safety.js";
import { createEchonetCommandAdapter } from "./echonet-service.js";
import { createApplicationStore } from "./application-store.js";
import { createTlsService } from "./services/tls-service.js";
import { isLoopbackAddress } from "./net/address-classification.js";
import {
  createStaticHandler,
  json,
  readBody as readJsonBody,
  requestError,
} from "./http/server.js";
import { createRequestListener } from "./http/request-listener.js";
import { NativeRouter } from "./http/router.js";
import { createApiHandler } from "./http/api.js";
import { startRuntime, stopRuntime } from "./runtime.js";
import { parseJsonWithContext } from "./domain/json.js";
import { logDetailedError } from "./logging.js";
import { normalizeServerEnvironment } from "./config/environment.js";
import {
  DEFAULT_CONFIG,
  anyDeviceConfigured,
  cleanConfig as normalizeApplicationConfig,
  normalizeRetentionConfig,
} from "./domain/configuration.js";
import type { ApplicationConfig, RetentionConfig } from "./contracts/configuration.js";
import type { HistorySample } from "./contracts/history.js";
import type { AdaptiveChargingState, AdaptivePlan } from "./domain/adaptive-state.js";
import type { AutomationRule } from "./domain/automation-rules.js";
import { backupPreparationBlocksActions, backupPreparationView } from "./domain/operational-overrides.js";
import {
  adaptiveChargingAvailability,
  buildAdaptiveChargingPlan,
  forecastIsFresh,
} from "./domain/adaptive-planning.js";
import {
  appendAdaptiveChargingLog,
} from "./domain/adaptive-state.js";
import {
  adaptiveChargingConfiguredActive,
  adaptiveChargingPlanLogMessage,
  adaptiveChargingScheduledEvent,
  applyInterruptedChargeCap,
  queueAdaptiveChargingPlanRefresh,
} from "./domain/adaptive-control.js";
import {
  activeEchonetLabel,
  cleanAutomationRule,
  mergeAutomationRule,
} from "./domain/automation-rules.js";
import { ALL_DAYS, parseRunAt } from "./domain/schedules.js";
import { normalizeReportBucket } from "./domain/energy-report.js";
import { billingPeriodKey } from "./domain/ene-farm.js";
import {
  DeviceCommandQueue,
  type DeviceCommandArguments,
  type DeviceCommandExecutor,
} from "./services/device-command-queue.js";
import { createDiscoveryService } from "./services/discovery-service.js";
import { createDatabaseAdministrationService } from "./services/database-administration.js";
import { createRuntimeCoordinator } from "./services/runtime-coordinator.js";
import { createOperationalOverrideService } from "./services/operational-overrides.js";
import { createScheduleService } from "./services/schedule-service.js";
import { createAdaptiveStateService } from "./services/adaptive-state-service.js";
import { createAutomationStoreService } from "./services/automation-store-service.js";
import { createConfigurationService } from "./services/configuration-service.js";
import { createAdaptiveChargingOperations } from "./services/adaptive-charging-operations.js";
import { createAutomationRuleEvaluator } from "./services/automation-rule-evaluator.js";
import { loadDeviceAdapter, type DeviceAdapter } from "./services/device-adapter.js";
import { createStatusCollectionService } from "./services/status-collection-service.js";
import { createAwayPeriodService } from "./services/away-period-service.js";
import { createDeviceCommandService, DEVICE_ACTIONS } from "./services/device-command-service.js";
import { createScheduleRunner } from "./services/schedule-runner.js";
import { createCommandReceiptService } from "./services/command-receipt-service.js";
import { createAdaptiveHistoryService } from "./services/adaptive-history-service.js";
import { createAdaptiveForecastService } from "./services/adaptive-forecast-service.js";
import { createHistoryReportingService } from "./services/history-reporting-service.js";
import { createEneFarmReportingService } from "./services/ene-farm-reporting-service.js";
import { createBatteryStrategyService } from "./services/battery-strategy-service.js";
import { createSystemAlertService } from "./services/system-alert-service.js";
import { createBackupPreparationService } from "./services/backup-preparation-service.js";
import { createAutomationOrchestrator } from "./services/automation-orchestrator.js";
import { createAdaptiveControlService } from "./services/adaptive-control-service.js";
import { createAdaptiveChargingEvaluator } from "./services/adaptive-charging-evaluator.js";
import { createStatusHistoryService } from "./services/status-history-service.js";
import { createConfigurationCommitService } from "./services/configuration-commit-service.js";
import { createScheduledAutomationService } from "./services/scheduled-automation-service.js";
import { createApplicationInitializer } from "./services/application-initializer.js";
import { createBacktestService } from "./services/backtest-service.js";
export interface ApplicationDependencies {
  environment?: NodeJS.ProcessEnv;
  createHistoryStore?: typeof createHistoryStore;
  createApplicationStore?: typeof createApplicationStore;
  loadDeviceAdapter?: typeof loadDeviceAdapter;
  createDefaultDeviceAdapter?: typeof createEchonetCommandAdapter;
}
export function createApplication(dependencies: ApplicationDependencies = {}) {
timestampConsole();
const environment = dependencies.environment ?? process.env;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED_ROOT = path.resolve(__dirname, "..");
const APP_ROOT = path.resolve(COMPILED_ROOT, "..");
const SERVER_ENVIRONMENT = normalizeServerEnvironment(environment, path.join(APP_ROOT, "data"));
const PORT = SERVER_ENVIRONMENT.port;
const DATA_DIR = SERVER_ENVIRONMENT.dataDir;
const UI_DEVELOPMENT_MODE = uiDevelopmentMode(environment);
const EXTERNAL_IO_DISABLED = externalIoDisabled(environment);
const DATABASE_BACKUP_DIR = path.join(DATA_DIR, "backups");
const ECHONET_TIMEOUT_MS = SERVER_ENVIRONMENT.echonetTimeoutMs;
const DEVICE_QUEUE_TIMEOUT_MS = Math.max(30_000, ECHONET_TIMEOUT_MS * 4);
const DEVICE_QUEUE_STARVATION_MS = Math.max(15_000, ECHONET_TIMEOUT_MS * 2);
const SCHEDULE_CHECK_INTERVAL_MS = SERVER_ENVIRONMENT.scheduleCheckIntervalMs;
const AUTOMATION_CHECK_INTERVAL_MS = SERVER_ENVIRONMENT.automationCheckIntervalMs;
const SOLAR_FORECAST_REFRESH_MS = 3 * 60 * 60_000;
const ADAPTIVE_CHARGING_HISTORY_CACHE_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_END_RETRY_MS = 5_000;
const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = 5 * 60_000;
const OPERATION_MODE_VERIFY_ATTEMPTS = 4;
const OPERATION_MODE_VERIFY_DELAY_MS = 750;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS = 10;
const AWAY_RETURN_BUFFER_MS = 30 * 60_000;
let adaptiveControlService: ReturnType<typeof createAdaptiveControlService> | null = null;
let commitConfigService: ReturnType<typeof createConfigurationCommitService> | null = null;
const historyStore = (dependencies.createHistoryStore ?? createHistoryStore)({ dataDir: DATA_DIR });
const applicationStore = (dependencies.createApplicationStore ?? createApplicationStore)({ dataDir: DATA_DIR });
const tlsService = createTlsService({
  dataDir: DATA_DIR,
  applicationStore,
  httpPort: SERVER_ENVIRONMENT.httpPort,
  httpsPort: SERVER_ENVIRONMENT.httpsPort,
  logError: logDetailedError,
});
const scheduleService = createScheduleService(applicationStore);
const readSchedules = scheduleService.read;
const writeSchedules = scheduleService.write;
const mutateSchedules = scheduleService.mutate;
const operationalOverrideService = createOperationalOverrideService(applicationStore, requestError);
const readOperationalOverridesState = operationalOverrideService.read;
const writeOperationalOverridesState = operationalOverrideService.write;
const withOperationalOverrideMutation = operationalOverrideService.mutate;
const assertActionAllowedByOperationalOverride = operationalOverrideService.assertAllowed;
const adaptiveStateService = createAdaptiveStateService({
  documents: applicationStore,
  history: historyStore,
  synchronizeDeadline: (state) => adaptiveControlService?.syncDeadline(state) ?? false,
});
const readAdaptiveChargingState = adaptiveStateService.read;
const writeAdaptiveChargingState = adaptiveStateService.write;
const automationStoreService = createAutomationStoreService(applicationStore, historyStore);
const readAutomationRules = automationStoreService.read;
const writeAutomationRules = automationStoreService.writeConfigs;
const writeAutomationRuleStates = automationStoreService.writeStates;
const configurationService = createConfigurationService({
  documents: applicationStore,
  defaultConfig: DEFAULT_CONFIG,
  normalize: (input) => normalizeApplicationConfig(input, { externalIoDisabled: EXTERNAL_IO_DISABLED }),
  commit: (previous, proposed) => {
    if (!commitConfigService) throw new Error("Configuration commit service is not initialized");
    return commitConfigService(previous, proposed);
  },
});
const cleanConfig = configurationService.normalize;
const readConfig = configurationService.read;
const updateConfig = configurationService.update;
const writeConfig = configurationService.write;
const adaptiveChargingOperations = createAdaptiveChargingOperations({
  execute: (action, payload) => executeAction(action, payload, { source: "adaptive-charging" }),
  readState: readAdaptiveChargingState,
  writeState: writeAdaptiveChargingState,
  retryDelayMs: ADAPTIVE_CHARGING_SLOT_END_RETRY_MS,
  guardOwnsStandby: async () => (await readAutomationRules()).some((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore === true),
});
const releaseAdaptiveCharge = adaptiveChargingOperations.release;
const suspendAdaptiveChargeInStandby = adaptiveChargingOperations.suspendInStandby;
const executeAdaptiveChargeStart = adaptiveChargingOperations.start;
const enforceAdaptiveChargingSlotEndDeadline = adaptiveChargingOperations.enforceDeadline;
const recoverIdleAdaptiveCharge = adaptiveChargingOperations.recoverIdle;
const notificationService = createNotificationService({
  dataDir: DATA_DIR,
  getConfig: () => readConfig(),
  recordEvent: (event: Record<string, unknown>) => historyStore.isReady() && historyStore.recordEvent(event),
  stateStore: {
    isReady: () => applicationStore.isReady(),
    read: (key: "notificationState", fallback: Record<string, unknown>) => applicationStore.readDocument(key, fallback),
    write: (key: "notificationState", value: Record<string, unknown>) => applicationStore.writeDocument(key, value),
  },
});
const evaluateAutomationRule = createAutomationRuleEvaluator({
  execute: (action, payload) => executeAction(action, payload),
  recordGuardTrigger: recordGuardTriggerSample,
  notify: (notification) => notificationService.enqueue(notification),
});
const adaptiveHistoryService = createAdaptiveHistoryService(historyStore, {
  cacheMs: ADAPTIVE_CHARGING_HISTORY_CACHE_MS,
  seasonalLookbackYears: ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS,
});
const {
  readHistory: readAdaptiveChargingHistory,
  refreshBatteryLearning,
  readDemandProfileDays: readAdaptiveChargingDemandProfileDays,
} = adaptiveHistoryService;
const statusHistoryService = createStatusHistoryService({
  history: historyStore,
  ensureDataDirectory: ensureDataDir,
  noteAdaptiveSample: adaptiveHistoryService.noteSample,
});
const adaptiveForecastService = createAdaptiveForecastService({
  history: historyStore,
  externalIoDisabled: EXTERNAL_IO_DISABLED,
  timezone: environment.TZ ?? null,
  readState: readAdaptiveChargingState,
  writeState: writeAdaptiveChargingState,
  readHistory: readAdaptiveChargingHistory,
  logError: logDetailedError,
});
const backtestService = createBacktestService({ history: historyStore, randomUUID });
const refreshAdaptiveChargingForecast = adaptiveForecastService.refresh;
const adaptiveChargingSolarForecastAccuracy = adaptiveForecastService.accuracy;
const historyReportingService = createHistoryReportingService({
  history: historyStore,
  ensureReady: ensureDataDir,
  readAutomationRules,
  defaultConfig: DEFAULT_CONFIG,
});
const {
  readRange: readHistoryRange, readSummaryRange: readHistorySummaryRange,
  readCalendarSavings, readEnergyReport, readStats: readHistoryStats,
} = historyReportingService;
const eneFarmReportingService = createEneFarmReportingService({
  history: historyStore,
  defaultConfig: DEFAULT_CONFIG,
  externalIoDisabled: EXTERNAL_IO_DISABLED,
});
const {
  measuredGasByBillingPeriod: measuredFuelCellGasByBillingPeriod,
  summarize: summarizeEneFarmSamples, report: eneFarmReport,
  transitionsThrough: readFuelCellTransitions, recordGasTariffSnapshot,
  updateCurrentTariff: updateCurrentGasTariff,
} = eneFarmReportingService;

let activeDeviceAdapter: DeviceAdapter | null = null;
const deviceQueue = new DeviceCommandQueue({
  executor: async () => { throw new Error("ECHONET adapter has not been initialized"); },
  queueTimeoutMs: DEVICE_QUEUE_TIMEOUT_MS,
  starvationMs: DEVICE_QUEUE_STARVATION_MS,
});
const setDeviceCommandExecutor = (executor: DeviceCommandExecutor) => deviceQueue.setExecutor(executor);
const runDeviceCommandQueued = (
  command: string,
  args: DeviceCommandArguments = {},
  positional: unknown[] = [],
  options: { priority?: number; queueTimeoutMs?: number } = {},
) => deviceQueue.run(command, args, positional, options);
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const statusCollectionService = createStatusCollectionService({
  readConfig,
  updateConfig,
  runDeviceCommand: runDeviceCommandQueued,
  recordStatusSample: statusHistoryService.record,
  readHistoryRange,
  readCalendarSavings,
  observeNotification: notificationService.observeCondition,
});
const getStatusSnapshot = statusCollectionService.get;
const invalidateStatusSnapshot = statusCollectionService.invalidate;
const observeDeviceNotifications = statusCollectionService.observeDevice;
const observeBatterySocNotifications = statusCollectionService.observeBattery;
const observeFuelCellHotWaterNotifications = statusCollectionService.observeFuelCell;

const awayPeriodService = createAwayPeriodService({
  repository: historyStore,
  createError: requestError,
  returnBufferMs: AWAY_RETURN_BUFFER_MS,
});
const {
  timestamp: awayTimestamp, ensureDoesNotOverlap: ensureAwayPeriodDoesNotOverlap,
  view: awayPeriodsView, cleanNew: cleanNewAwayPeriod, create: createAwayPeriod,
  find: findAwayPeriod, periods: listAwayPeriods, remove: removeAwayPeriod,
  update: updateAwayPeriod,
} = awayPeriodService;

const deviceCommandService = createDeviceCommandService({
  assertActionAllowed: assertActionAllowedByOperationalOverride,
  pauseAdaptiveCharging: (action: string) => {
    if (!adaptiveControlService) throw new Error("Adaptive control service is not initialized");
    return adaptiveControlService.pauseForManualAction(action);
  },
  readConfig,
  runDeviceCommand: runDeviceCommandQueued,
  invalidateStatus: invalidateStatusSnapshot,
  history: historyStore,
  createHttpError: requestError,
  operationModeVerifyAttempts: OPERATION_MODE_VERIFY_ATTEMPTS,
  operationModeVerifyDelayMs: OPERATION_MODE_VERIFY_DELAY_MS,
});
const executeAction = deviceCommandService.execute;
const startDeviceCommand = deviceCommandService.start;
const backupPreparationService = createBackupPreparationService({
  readConfig,
  readAdaptiveChargingState,
  writeAdaptiveChargingState,
  readAutomationRules,
  writeAutomationRuleStates,
  readOperationalOverridesState,
  writeOperationalOverridesState,
  withOperationalOverrideMutation,
  runDeviceCommandQueued,
  executeAction,
  releaseAdaptiveCharge,
  invalidateStatus: invalidateStatusSnapshot,
  requestError,
  logError: logDetailedError,
  sleep,
  verifyAttempts: OPERATION_MODE_VERIFY_ATTEMPTS,
  verifyDelayMs: OPERATION_MODE_VERIFY_DELAY_MS,
});
adaptiveControlService = createAdaptiveControlService({
  readConfig,
  readState: readAdaptiveChargingState,
  writeState: writeAdaptiveChargingState,
  releaseCharge: releaseAdaptiveCharge,
  execute: (action, payload) => executeAction(action, payload, { source: "adaptive-charging" }),
  enforceDeadline: enforceAdaptiveChargingSlotEndDeadline,
  logError: logDetailedError,
  deadlineRetryMs: ADAPTIVE_CHARGING_SLOT_END_RETRY_MS,
  maxTimerDelayMs: MAX_TIMER_DELAY_MS,
});
commitConfigService = createConfigurationCommitService({
  normalize: cleanConfig,
  ensureDataDirectory: ensureDataDir,
  readAdaptiveState: readAdaptiveChargingState,
  writeAdaptiveState: writeAdaptiveChargingState,
  readOperationalOverrides: readOperationalOverridesState,
  releaseAdaptiveCharge,
  executeAction: (action, payload) => executeAction(action, payload),
  writeConfigDocument: (config) => applicationStore.writeDocument("config", config),
  clearStatusHistory: statusHistoryService.clear,
  invalidateStatus: invalidateStatusSnapshot,
});

const scheduleRunner = createScheduleRunner({
  readConfig,
  readOperationalOverrides: readOperationalOverridesState,
  readAutomationRules,
  mutateSchedules,
  writeSchedules,
  executeAction,
  notify: notificationService.enqueue,
  warn: (message) => console.warn(message),
});
const runDueSchedules = scheduleRunner.run;

const commandReceiptService = createCommandReceiptService(historyStore);
const readCommandReceipts = commandReceiptService.list;
const readCommandReceipt = commandReceiptService.read;
const batteryStrategyServiceView = createBatteryStrategyService({
  readConfig,
  readAdaptiveChargingState,
  readOperationalOverridesState,
  readAutomationRules,
  readSchedules,
  readCommandReceipts,
  historyReady: historyStore.isReady,
  awayPeriodsView,
  solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy,
});
const discoveryService = createDiscoveryService({
  readConfig,
  cleanConfig,
  runDeviceCommand: runDeviceCommandQueued,
});
const discoveryInProgress = () => discoveryService.inProgress();

async function configureDeviceCommandAdapter(): Promise<void> {
  const adapter = await (dependencies.loadDeviceAdapter ?? loadDeviceAdapter)({
    environment,
    moduleBaseDirectory: __dirname,
    createDefaultAdapter: dependencies.createDefaultDeviceAdapter ?? createEchonetCommandAdapter,
    defaultOptions: {
      timeout: ECHONET_TIMEOUT_MS / 1000,
      netif: environment.ECHONET_NETIF ?? "",
      debug: environment.ECHONET_DEBUG === "1",
    },
  });
  activeDeviceAdapter = adapter;
  setDeviceCommandExecutor(adapter.execute);
}
async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}
async function readHistorySamplesInRange(startMs: number, endMs: number): Promise<HistorySample[]> {
  return historyStore.querySamples(startMs, endMs);
}

function adaptiveChargingView(
  config: ApplicationConfig,
  state: AdaptiveChargingState,
  rules: AutomationRule[] = [],
  now: Date = new Date(),
) {
  const solarForecastAccuracy = adaptiveChargingSolarForecastAccuracy(now);
  const availability = adaptiveChargingAvailability(config, rules);
  const forecastAgeMs = state.forecast?.fetchedAt
    ? now.getTime() - new Date(state.forecast.fetchedAt).getTime()
    : null;
  const paused = Boolean(state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime());
  const planUnavailableReason = state.plan && state.plan.available === false ? state.plan.reason : null;
  return {
    enabled: config.adaptiveCharging?.enabled === true,
    available: availability.available
      && forecastIsFresh(state.forecast, now)
      && !paused
      && !state.lastForecastError
      && !planUnavailableReason,
    reason: paused
      ? `paused until ${state.pausedUntil}`
      : availability.reason
        || state.lastForecastError?.error
        || planUnavailableReason
        || (!forecastIsFresh(state.forecast, now) ? "solar forecast is stale or unavailable" : null),
    warning: state.plan?.warning ?? null,
    away: historyStore.isReady() ? awayPeriodsView(now) : { periods: [], active: null, next: null, state: "home" },
    paused,
    pausedUntil: state.pausedUntil,
    forecast: state.forecast ? {
      fetchedAt: state.forecast.fetchedAt,
      ageMs: Number.isFinite(forecastAgeMs) ? Math.max(0, Number(forecastAgeMs)) : null,
      timezone: state.forecast.timezone,
      stale: !forecastIsFresh(state.forecast, now),
    } : null,
    solarForecastAccuracy,
    fuelCellForecastOutcomes: historyStore.isReady() ? historyStore.fuelCellForecastOutcomes(100) : [],
    plan: state.plan,
    owner: state.owner,
    activeSlot: state.activeSlot,
    interruptedCharge: state.interruptedCharge,
    breakerRecovery: state.breakerRecovery,
    standbyHoldUntil: state.standbyHoldUntil,
    exportConfirmation: state.exportConfirmation,
    activeWindowExecution: state.activeWindowExecution,
    windowSummaries: state.windowSummaries ?? [],
    chargingPerformance: state.chargingPerformance,
    batteryModel: state.batteryLearning,
    lastResult: state.lastResult,
    lastForecastError: state.lastForecastError,
    log: state.log ?? [],
  };
}

function recordFuelCellPlanForecast(plan: AdaptivePlan | null, now: Date = new Date()): number {
  if (!historyStore.isReady() || !plan?.fuelCellModel) return 0;
  const fuelCellModel = plan.fuelCellModel;
  historyStore.settleFuelCellForecastOutcomes(now);
  return historyStore.recordFuelCellForecasts((plan.timeline ?? []).map((interval) => ({
    start: interval.start,
    end: interval.end,
    p20W: interval.fuelCellP20W,
    medianW: interval.fuelCellMedianW,
    p80W: interval.fuelCellP80W,
    sampleCount: interval.fuelCellSampleCount,
    method: fuelCellModel.method,
    influence: fuelCellModel.influence,
  })), plan.createdAt ?? now.toISOString());
}

async function recordGuardTriggerSample(at: Date = new Date()): Promise<void> {
  await ensureDataDir();
  const timestamp = at.toISOString();
  historyStore.recordEvent({
    eventKey: `automation:guard-trigger:${timestamp}`,
    at: timestamp,
    category: "automation",
    type: "guard-trigger",
    message: "Charging Demand Guard entered Standby",
  });
}

async function trimHistory(retention: Partial<RetentionConfig>) {
  adaptiveHistoryService.invalidate();
  return historyStore.applyRetention(retention);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonBody(req, parseJsonWithContext);
}

async function queueAdaptiveChargingForAwayChange(reason: string, now: Date = new Date()): Promise<void> {
  const state = await readAdaptiveChargingState();
  queueAdaptiveChargingPlanRefresh(state, reason, now);
  state.lastPlanEventKey = null;
  appendAdaptiveChargingLog(state, `${reason}; Adaptive Charging recalculation queued`, "away", now);
  await writeAdaptiveChargingState(state);
}

const evaluateAdaptiveCharging = createAdaptiveChargingEvaluator({
  readState: readAdaptiveChargingState,
  writeState: writeAdaptiveChargingState,
  history: historyStore,
  readOperationalOverrides: readOperationalOverridesState,
  executeAction: (action, payload) => executeAction(action, payload, { source: "adaptive-charging" }),
  releaseCharge: releaseAdaptiveCharge,
  suspendInStandby: suspendAdaptiveChargeInStandby,
  startCharge: executeAdaptiveChargeStart,
  recoverIdle: recoverIdleAdaptiveCharge,
  readHistory: readAdaptiveChargingHistory,
  refreshBatteryLearning,
  readDemandProfileDays: readAdaptiveChargingDemandProfileDays,
  solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy,
  recordFuelCellPlanForecast,
  recordPlanSnapshot: historyStore.recordAdaptivePlanSnapshot,
  breakerWaitLogMs: ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS,
});

const automationOrchestrator = createAutomationOrchestrator({
  intervalMs: AUTOMATION_CHECK_INTERVAL_MS,
  forecastRefreshMs: SOLAR_FORECAST_REFRESH_MS,
  readConfig,
  readAutomationRules,
  writeAutomationRuleStates,
  readOperationalOverridesState,
  readAdaptiveChargingState,
  refreshAdaptiveChargingForecast,
  getStatusSnapshot,
  deviceTimings: () => deviceQueue.recentTimings,
  evaluateAutomationRule,
  executeAction,
  evaluateAdaptiveCharging,
  notifications: notificationService,
  warn: (message) => console.warn(message),
});
const scheduledAutomationService = createScheduledAutomationService({
  discoveryInProgress,
  discoveryLabel: discoveryService.label,
  runAutomation: automationOrchestrator.run,
  activeDeviceOperationLabel: () => activeEchonetLabel(deviceQueue.activeContext),
  warn: (message) => console.warn(message),
});

const runtimeCoordinator = createRuntimeCoordinator({
  scheduleIntervalMs: SCHEDULE_CHECK_INTERVAL_MS,
  automationIntervalMs: AUTOMATION_CHECK_INTERVAL_MS,
  defaultUpdateIntervalSeconds: DEFAULT_CONFIG.updateIntervalSeconds,
  runSchedules: runDueSchedules,
  runAutomation: scheduledAutomationService.run,
  readConfig,
  runRetention: trimHistory,
  updateGasTariff: updateCurrentGasTariff,
  readAdaptiveState: readAdaptiveChargingState,
  readOperationalOverrides: readOperationalOverridesState,
  backupPreparationBlocksActions,
  clearAdaptiveDeadline: () => adaptiveControlService?.clearDeadline(),
  syncAdaptiveDeadline: (state) => adaptiveControlService?.syncDeadline(state) ?? false,
  discoveryInProgress,
  discoveryLabel: discoveryService.label,
  anyDeviceConfigured,
  getStatus: getStatusSnapshot,
  observeStatus: (status, config) => {
    observeDeviceNotifications(status, config);
    observeBatterySocNotifications(status, config);
    observeFuelCellHotWaterNotifications(status, config);
  },
  activeWork: () => scheduledAutomationService.active()
    || deviceCommandService.activeCount() > 0
    || deviceQueue.isRunning
    || scheduleRunner.activeCount() > 0
    || statusCollectionService.hasActiveRefresh(),
  logError: logDetailedError,
});

const databaseAdministration = createDatabaseAdministrationService({
  applicationStore,
  historyStore,
  backupDir: DATABASE_BACKUP_DIR,
  dataDir: DATA_DIR,
  createError: requestError,
  logError: logDetailedError,
  resetAfterRestore: () => {
    statusHistoryService.loadLatest();
    statusCollectionService.invalidate();
    adaptiveHistoryService.invalidate();
  },
  startBackgroundProcesses: runtimeCoordinator.start,
  stopBackgroundProcesses: runtimeCoordinator.stop,
  waitForWriters: runtimeCoordinator.waitForIdle,
});
const systemAlertServiceView = createSystemAlertService({
  readConfig,
  readAdaptiveChargingState,
  readAutomationRules,
  readSchedules,
  notificationView: notificationService.view,
  adaptiveChargingView,
  readCommandReceipts,
  getDatabaseOperation: databaseAdministration.getOperation,
});

const api = createApiHandler({
  ALL_DAYS,
  DEFAULT_CONFIG,
  EXTERNAL_IO_DISABLED,
  HTTPS_PORT: SERVER_ENVIRONMENT.httpsPort,
  PORT,
  UI_DEVELOPMENT_MODE,
  adaptiveChargingAvailability,
  adaptiveChargingConfiguredActive,
  adaptiveChargingPlanLogMessage,
  adaptiveChargingScheduledEvent,
  adaptiveChargingSolarForecastAccuracy,
  adaptiveChargingView,
  backtestService,
  appendAdaptiveChargingLog,
  applicationArchitectureStatus: applicationStore.status,
  applyInterruptedChargeCap,
  assertActionAllowedByOperationalOverride,
  awayPeriodsView,
  awayTimestamp,
  backupPreparationView,
  batteryStrategyView: batteryStrategyServiceView,
  billingPeriodKey,
  buildAdaptiveChargingPlan,
  cleanAutomationRule,
  cleanNewAwayPeriod,
  createAwayPeriod,
  databaseBackupsView: databaseAdministration.backupsView,
  discoveryInProgress,
  discoveryService,
  endBackupPreparation: backupPreparationService.end,
  eneFarmReport,
  ensureAwayPeriodDoesNotOverlap,
  findAwayPeriod,
  forecastIsFresh,
  gasTariffHash,
  getDatabaseOperation: databaseAdministration.getOperation,
  getLatestStatusSnapshot: statusCollectionService.getLatest,
  getStatusSnapshot,
  historicalWeather: historyStore.historicalWeather,
  importGasTariff,
  json,
  manualDatabaseBackup: databaseAdministration.createBackup,
  measuredFuelCellGasByBillingPeriod,
  mergeAutomationRule,
  mutateSchedules,
  normalizeGasTariffPayload,
  normalizeNotificationConfig,
  normalizeReportBucket,
  normalizeRetentionConfig,
  notificationService,
  parseRunAt,
  queueAdaptiveChargingForAwayChange,
  randomUUID,
  readAdaptiveChargingDemandProfileDays,
  readAdaptiveChargingHistory,
  readAdaptiveChargingState,
  readAutomationRules,
  readBody,
  readCommandReceipt,
  readCommandReceipts,
  readConfig,
  readEnergyReport,
  readFuelCellTransitions,
  readHistoryRange,
  readHistorySamplesInRange,
  readHistoryStats,
  readHistorySummaryRange,
  readOperationalOverridesState,
  readSchedules,
  recordFuelCellPlanForecast,
  recordGasTariffSnapshot,
  refreshAdaptiveChargingForecast,
  refreshBatteryLearning,
  removeDatabaseBackup: databaseAdministration.removeBackup,
  removeAwayPeriod,
  requestError,
  restoreDatabaseBackup: databaseAdministration.restoreBackup,
  resumeAdaptiveCharging: (now) => {
    if (!adaptiveControlService) throw new Error("Adaptive control service is not initialized");
    return adaptiveControlService.resume(now);
  },
  startBackupPreparation: backupPreparationService.start,
  startDeviceCommand,
  summarizeEneFarmSamples,
  systemAlertsView: systemAlertServiceView,
  tlsService,
  trimHistory,
  listAwayPeriods,
  updateAwayPeriod,
  validBillingMonth,
  writeAdaptiveChargingState,
  writeAutomationRuleStates,
  writeAutomationRules,
  writeConfig,
});
const serveStatic = createStaticHandler(path.join(APP_ROOT, "public"));
const apiRouter = new NativeRouter().post(
  "/api/device-actions/:action",
  async ({ request, response, params }) => {
    const operation = databaseAdministration.getOperation();
    if (operation.busy) return void json(response, 503, { error: `Database ${operation.type} is in progress`, operation: { ...operation } });
    const body = await readBody(request);
    const action = params.action ?? "";
    if (!DEVICE_ACTIONS.has(action)) throw requestError(404, `unknown action: ${action}`);
    const result = await executeAction(action, body, { source: "manual" });
    json(response, 200, result);
  },
);
const applicationInitializer = createApplicationInitializer({
  initializeHistory: historyStore.initialize,
  initializeDocuments: applicationStore.initialize,
  configureDeviceAdapter: async () => {
    if (!activeDeviceAdapter) await configureDeviceCommandAdapter();
  },
  initializeState: async () => {
    statusHistoryService.loadLatest();
    const startupConfig = await readConfig();
    const startupAdaptiveChargingState = await readAdaptiveChargingState();
    await refreshBatteryLearning(startupConfig, startupAdaptiveChargingState);
    await writeAdaptiveChargingState(startupAdaptiveChargingState);
    await writeAutomationRuleStates(await readAutomationRules());
    await backupPreparationService.reconcileOnStartup();
  },
  startBackgroundProcesses: runtimeCoordinator.start,
});

const server = http.createServer(createRequestListener({
  api,
  apiRouter,
  serveStatic,
  trustedHosts: () => tlsService.trustedHosts(),
}));
async function start(): Promise<void> {
  // Behind the bundled Caddy the app listens on an ephemeral loopback port and
  // Caddy owns the public HTTP/HTTPS ports. A direct `npm start` binds HOST:P.
  const behindProxy = isLoopbackAddress(SERVER_ENVIRONMENT.host);
  await startRuntime({
    server,
    host: SERVER_ENVIRONMENT.host,
    port: behindProxy ? 0 : SERVER_ENVIRONMENT.httpPort,
    validateEnvironment: () => assertSafeUiDevelopmentEnvironment(environment, { projectDir: COMPILED_ROOT }),
    validateStorage: async () => {
      await ensureDataDir();
      const inspection = await inspectHistoryDatabase(DATA_DIR);
      if (inspection.state !== "new" && inspection.state !== "current" && inspection.state !== "migratable") {
        throw new Error(inspection.error ?? `Database is not usable (${inspection.state})`);
      }
    },
    initializeApplication: applicationInitializer.initialize,
  });
  if (behindProxy) {
    const address = server.address();
    if (address && typeof address === "object") {
      tlsService.setInternalPort(address.port);
      await tlsService.start();
    }
  }
}
async function stop(): Promise<void> {
  tlsService.stop();
  await stopRuntime({
    server,
    stopBackgroundProcesses: runtimeCoordinator.stop,
    waitForBackgroundProcesses: runtimeCoordinator.waitForIdle,
    closeResources: async () => {
      await activeDeviceAdapter?.close?.();
      applicationStore.close();
      historyStore.close();
    },
  });
}
  return { server, start, stop };
}
