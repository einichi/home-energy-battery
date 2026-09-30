import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationConfig, RetentionConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import type { AdaptiveChargingState, AdaptivePlan } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import type { EneFarmSummary } from "../services/ene-farm-reporting-service.js";
import type { OperationalOverridesState } from "../domain/operational-overrides.js";
import type { SolarForecastHour } from "../domain/solar-forecast.js";
import { createSystemRouteHandler } from "./routes/system-routes.js";
import { createHistoryRouteHandler } from "./routes/history-routes.js";
import { createOperationsRouteHandler } from "./routes/operations-routes.js";
import { createAutomationRouteHandler } from "./routes/automation-routes.js";
import type { BatteryStrategy, RuntimeInformation } from "../../shared/api-contracts.js";

type JsonObject = Record<string, unknown>;
type ConfigurationService = ReturnType<typeof import("../services/configuration-service.js").createConfigurationService>;
type AdaptiveStateService = ReturnType<typeof import("../services/adaptive-state-service.js").createAdaptiveStateService>;
type AutomationStoreService = ReturnType<typeof import("../services/automation-store-service.js").createAutomationStoreService>;
type ScheduleService = ReturnType<typeof import("../services/schedule-service.js").createScheduleService>;
type CommandReceiptService = ReturnType<typeof import("../services/command-receipt-service.js").createCommandReceiptService>;
type DiscoveryService = ReturnType<typeof import("../services/discovery-service.js").createDiscoveryService>;
type NotificationService = ReturnType<typeof import("../notifications.js").createNotificationService>;
type AdaptiveHistoryService = ReturnType<typeof import("../services/adaptive-history-service.js").createAdaptiveHistoryService>;
type AdaptiveForecastService = ReturnType<typeof import("../services/adaptive-forecast-service.js").createAdaptiveForecastService>;
type HistoryReportingService = ReturnType<typeof import("../services/history-reporting-service.js").createHistoryReportingService>;
type EneFarmReportingService = ReturnType<typeof import("../services/ene-farm-reporting-service.js").createEneFarmReportingService>;
type AwayPeriodService = ReturnType<typeof import("../services/away-period-service.js").createAwayPeriodService>;
type DeviceCommandService = ReturnType<typeof import("../services/device-command-service.js").createDeviceCommandService>;
type SystemAlertService = ReturnType<typeof import("../services/system-alert-service.js").createSystemAlertService>;

export interface ApiDependencies {
  ALL_DAYS: number[];
  DEFAULT_CONFIG: ApplicationConfig;
  EXTERNAL_IO_DISABLED: boolean;
  PORT: number;
  UI_DEVELOPMENT_MODE: boolean;
  adaptiveChargingAvailability: typeof import("../domain/adaptive-planning.js").adaptiveChargingAvailability;
  adaptiveChargingConfiguredActive: typeof import("../domain/adaptive-control.js").adaptiveChargingConfiguredActive;
  adaptiveChargingPlanLogMessage: typeof import("../domain/adaptive-control.js").adaptiveChargingPlanLogMessage;
  adaptiveChargingScheduledEvent: typeof import("../domain/adaptive-control.js").adaptiveChargingScheduledEvent;
  adaptiveChargingSolarForecastAccuracy: AdaptiveForecastService["accuracy"];
  adaptiveChargingView(config: ApplicationConfig, state: AdaptiveChargingState, rules?: AutomationRule[], now?: Date): unknown;
  appendAdaptiveChargingLog: typeof import("../domain/adaptive-state.js").appendAdaptiveChargingLog;
  applicationArchitectureStatus(): NonNullable<RuntimeInformation["architecture"]>;
  applyInterruptedChargeCap: typeof import("../domain/adaptive-control.js").applyInterruptedChargeCap;
  assertActionAllowedByOperationalOverride(source: string, action: string): Promise<void>;
  awayPeriodsView: AwayPeriodService["view"];
  awayTimestamp: AwayPeriodService["timestamp"];
  backupPreparationView: typeof import("../domain/operational-overrides.js").backupPreparationView;
  batteryStrategyView(now?: Date): Promise<BatteryStrategy>;
  billingPeriodKey: typeof import("../domain/ene-farm.js").billingPeriodKey;
  buildAdaptiveChargingPlan: typeof import("../domain/adaptive-planning.js").buildAdaptiveChargingPlan;
  cleanAutomationRule: typeof import("../domain/automation-rules.js").cleanAutomationRule;
  cleanNewAwayPeriod: AwayPeriodService["cleanNew"];
  createAwayPeriod: AwayPeriodService["create"];
  databaseBackupsView(): Promise<unknown>;
  discoveryInProgress(): boolean;
  discoveryService: DiscoveryService;
  endBackupPreparation(now?: Date): Promise<unknown>;
  eneFarmReport: EneFarmReportingService["report"];
  ensureAwayPeriodDoesNotOverlap: AwayPeriodService["ensureDoesNotOverlap"];
  forecastIsFresh: typeof import("../domain/adaptive-planning.js").forecastIsFresh;
  gasTariffHash: typeof import("../gas-tariffs.js").gasTariffHash;
  getDatabaseOperation(): { busy: boolean; type?: string | null; error?: string | null; startedAt?: string | null };
  getLatestStatusSnapshot(): JsonObject | null;
  getStatusSnapshot(options?: JsonObject): Promise<JsonObject>;
  historicalWeather(): SolarForecastHour[];
  findAwayPeriod: AwayPeriodService["find"];
  importGasTariff: typeof import("../gas-tariffs.js").importGasTariff;
  json<T>(response: ServerResponse, status: number, body: T): void;
  manualDatabaseBackup(): Promise<unknown>;
  measuredFuelCellGasByBillingPeriod: EneFarmReportingService["measuredGasByBillingPeriod"];
  mergeAutomationRule: typeof import("../domain/automation-rules.js").mergeAutomationRule;
  mutateSchedules: ScheduleService["mutate"];
  normalizeGasTariffPayload: typeof import("../gas-tariffs.js").normalizeGasTariffPayload;
  normalizeNotificationConfig: typeof import("../notifications.js").normalizeNotificationConfig;
  normalizeReportBucket: typeof import("../domain/energy-report.js").normalizeReportBucket;
  normalizeRetentionConfig: typeof import("../domain/configuration.js").normalizeRetentionConfig;
  notificationService: NotificationService;
  parseRunAt: typeof import("../domain/schedules.js").parseRunAt;
  queueAdaptiveChargingForAwayChange(reason: string, now?: Date): Promise<void>;
  randomUUID(): string;
  readAdaptiveChargingDemandProfileDays: AdaptiveHistoryService["readDemandProfileDays"];
  readAdaptiveChargingHistory: AdaptiveHistoryService["readHistory"];
  readAdaptiveChargingState: AdaptiveStateService["read"];
  readAutomationRules: AutomationStoreService["read"];
  readBody(request: IncomingMessage): Promise<JsonObject>;
  readCommandReceipt: CommandReceiptService["read"];
  readCommandReceipts: CommandReceiptService["list"];
  readConfig: ConfigurationService["read"];
  readEnergyReport: HistoryReportingService["readEnergyReport"];
  readHistoryRange: HistoryReportingService["readRange"];
  readHistorySamplesInRange(startMs: number, endMs: number): Promise<HistorySample[]>;
  readHistoryStats: HistoryReportingService["readStats"];
  readHistorySummaryRange: HistoryReportingService["readSummaryRange"];
  readOperationalOverridesState(): Promise<OperationalOverridesState>;
  readSchedules: ScheduleService["read"];
  recordFuelCellPlanForecast(plan: AdaptivePlan | null, now?: Date): number;
  recordGasTariffSnapshot: EneFarmReportingService["recordGasTariffSnapshot"];
  readFuelCellTransitions: EneFarmReportingService["transitionsThrough"];
  refreshAdaptiveChargingForecast: AdaptiveForecastService["refresh"];
  refreshBatteryLearning: AdaptiveHistoryService["refreshBatteryLearning"];
  removeDatabaseBackup(filename: string): Promise<unknown>;
  removeAwayPeriod: AwayPeriodService["remove"];
  requestError(status: number, message: string): Error;
  restoreDatabaseBackup(filename: string): Promise<unknown>;
  resumeAdaptiveCharging(now?: Date): Promise<AdaptiveChargingState>;
  startBackupPreparation(options?: { allowDemandGuard?: boolean }, now?: Date): Promise<unknown>;
  startDeviceCommand: DeviceCommandService["start"];
  summarizeEneFarmSamples(samples: HistorySample[], config: ApplicationConfig, options?: { start?: string; end?: string; billingPeriodGasM3?: number | null }): EneFarmSummary;
  systemAlertsView: SystemAlertService;
  trimHistory(retention: Partial<RetentionConfig>): Promise<unknown>;
  validBillingMonth: typeof import("../gas-tariffs.js").validBillingMonth;
  listAwayPeriods: AwayPeriodService["periods"];
  updateAwayPeriod: AwayPeriodService["update"];
  writeAdaptiveChargingState: AdaptiveStateService["write"];
  writeAutomationRuleStates: AutomationStoreService["writeStates"];
  writeAutomationRules: AutomationStoreService["writeConfigs"];
  writeConfig: ConfigurationService["write"];
}

export function createApiHandler(dependencies: ApiDependencies) {
  const {
    databaseBackupsView,
    json,
    getDatabaseOperation,
  } = dependencies;
  const handleSystemRoute = createSystemRouteHandler(dependencies);
  const handleHistoryRoute = createHistoryRouteHandler(dependencies);
  const handleOperationsRoute = createOperationsRouteHandler(dependencies);
  const handleAutomationRoute = createAutomationRouteHandler(dependencies);
return async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/database-backups") {
    return json(res, 200, await databaseBackupsView());
  }
  if (getDatabaseOperation().busy) {
    return json(res, 503, {
      error: `Database ${getDatabaseOperation().type} is in progress`,
      operation: { ...getDatabaseOperation() },
    });
  }
  if (await handleSystemRoute(req, res, url) !== false) return;
  if (await handleHistoryRoute(req, res, url) !== false) return;
  if (await handleOperationsRoute(req, res, url) !== false) return;
  if (await handleAutomationRoute(req, res, url) !== false) return;
  return json(res, 404, { error: "not found" });
}
}
