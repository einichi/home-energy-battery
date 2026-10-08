import type { AppConfig } from "./api-schemas.js";
export type {
  AppConfig, HistoryResponse, StatusSnapshot, BatteryStatus, FuelCellStatus, SavingsSummary, EnergySources,
  EneFarmInterval, EneFarmSummary, EnergySample, DataQuality, CircuitSummary, HistorySummary, EnergyReportBucket,
  EnergyReport, EnergyReportTotals, EneFarmReportBucket, EneFarmReportTotals, EneFarmReport, SystemAlert, BatteryStrategy, BatteryWindow, RuntimeInformation,
} from "./api-schemas.js";

export type Metric<T = number> = {
  value?: T | null;
  human?: string | null;
  error?: string | null;
  acquired_at?: string | null;
};

export type BacktestRange = "90d" | "all";
export type BacktestMode = "both" | "as-operated" | "model-only";

export type BacktestComponentMetrics = {
  sampleCount: number;
  meanAbsoluteErrorKwh: number | null;
  meanBiasKwh: number | null;
};

export type BacktestExecutionMetrics = {
  evaluablePlans: number;
  targetMetPercent: number | null;
  reserveViolationCount: number;
  totalGridCostYen: number | null;
  averageGridCostYen: number | null;
};

export type BacktestRunSummary = {
  id: string;
  engineVersion: number;
  modelId: string;
  modelVersion: string;
  status: "running" | "complete" | "failed";
  range: BacktestRange;
  mode: BacktestMode;
  startedAt: string;
  completedAt: string | null;
  periodStart: string;
  periodEnd: string;
  planCount: number;
  evaluablePlanCount: number;
  excludedPlanCount: number;
  exactReplayPlanCount: number;
  notes: string[];
  components: {
    solar: BacktestComponentMetrics;
    demand: BacktestComponentMetrics;
    fuelCell: BacktestComponentMetrics;
  };
  asOperated: BacktestExecutionMetrics | null;
  modelOnly: BacktestExecutionMetrics | null;
  seasonal: Array<{
    season: "winter" | "spring" | "summer" | "autumn";
    planCount: number;
    evaluablePlanCount: number;
    targetMetPercent: number | null;
    averageGridCostYen: number | null;
  }>;
  error: string | null;
};

export type BacktestRunRequest = {
  range?: BacktestRange;
  mode?: BacktestMode;
  modelId?: string;
};

export type BacktestRunsResponse = {
  models: Array<{ id: string; version: string; label: string }>;
  runs: BacktestRunSummary[];
  scheduling: "manual";
};

export type NotificationTrigger = { enabled: boolean; cooldownMinutes: number; thresholdPercent?: number };
export type NotificationConfig = {
  enabled: boolean;
  channels: Array<{ id: string; type: "smtp"; enabled: boolean; settings: { host?: string; port?: number; security?: string; username?: string; from?: string; recipients?: string[] } }>;
  triggers: Record<string, NotificationTrigger>;
};
export type NotificationDelivery = { at?: string; ok?: boolean; event?: { title?: string; type?: string; severity?: string; occurredAt?: string }; attempts?: Array<{ channelId?: string; ok?: boolean; error?: string; result?: { messageId?: string | null; response?: string | null } }> };
export type NotificationView = { config: NotificationConfig; passwordConfigured?: boolean; deliveries?: NotificationDelivery[] };
export type HistoryStats = { sizeBytes?: number; fileSizes?: { mainBytes?: number; walBytes?: number; shmBytes?: number; totalBytes?: number }; sampleCount?: number; averageSampleBytes?: number; estimatedDailyGrowthBytes?: number; earliest?: string | null; latest?: string | null; daysRecorded?: number; rollups?: { interval?: number; daily?: number }; events?: Record<string, number>; schemaVersion?: number; lastCompaction?: { completedAt?: string } | null };
export type DatabaseBackup = { filename: string; createdAt?: string; modifiedAt?: string; sizeBytes?: number; schemaVersion?: number; compatible?: boolean; kind?: string };
export type DatabaseBackupsView = { schemaVersion?: number; operation?: { busy?: boolean; phase?: string; percent?: number; error?: string | null }; backups: DatabaseBackup[] };
export type DiscoveryView = { discovered?: Array<{ host: string; roles?: string[]; instances?: unknown[] }>; suggestedConfig?: Partial<AppConfig> };
export type DiscoveryJob = {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  phase?: string;
  total?: number;
  scanned?: number;
  found?: number;
  network?: string;
  result?: DiscoveryView;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type CommandOutcome = {
  commandId: string;
  commandState: "succeeded";
  completedAt: string;
  acknowledged?: boolean;
  verified?: boolean;
  readBack?: unknown;
};

export type BatteryAction =
  | "vendor-profile"
  | "discharge-limit"
  | "osaifu-charge-window"
  | "osaifu-discharge-window"
  | "set-mode"
  | "charge"
  | "discharge";

export type CommandReceiptEvent = {
  eventKey: string;
  at: string;
  type: string;
  message?: string | null;
};

export type CommandReceipt = {
  commandId: string;
  action: string;
  source: string;
  target?: { kind?: string; host?: string } | null;
  request: Record<string, unknown>;
  state: string;
  requestedAt?: string | null;
  completedAt?: string | null;
  message?: string | null;
  error?: string | null;
  durationMs?: number | null;
  events: CommandReceiptEvent[];
};

export type BatterySchedule = {
  id: string;
  name: string;
  action: string;
  payload: Record<string, unknown>;
  repeat: "daily" | "once";
  days?: number[];
  time?: string;
  runAt?: string;
  enabled: boolean;
  lastResult?: { ok?: boolean; at?: string; error?: string } | null;
};

export type BackupPreparation = {
  active: boolean;
  phase: "inactive" | "starting" | "active" | "ending";
  allowDemandGuard: boolean;
  previousProfile?: string | null;
  currentProfile?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  lastResult?: { ok?: boolean; at?: string; error?: string } | null;
  log?: Array<{ at: string; message: string; kind: string }>;
};

export type AwayPeriod = {
  id: string;
  from: string;
  until: string;
  source?: "manual" | "scheduled";
  status?: "scheduled" | "active" | "completed";
};

export type AwayPeriodsView = {
  periods: AwayPeriod[];
  active: AwayPeriod | null;
  next: AwayPeriod | null;
  state: "home" | "away";
  returnBufferMinutes?: number;
};

export type AutomationLogEntry = {
  at?: string | null;
  kind?: string | null;
  message?: string | null;
};

export type AutomationRule = {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  dashboardWarningEnabled?: boolean;
  conditions?: {
    source?: string;
    breakerAmps?: number | null;
    breakerVoltage?: number | null;
    reserveAmps?: number | null;
    restoreBelowAmps?: number | null;
    restoreDelaySeconds?: number | null;
  };
  state?: { awaitingRestore?: boolean; triggeredAt?: string | null };
  log?: AutomationLogEntry[];
};

export type AdaptiveTimelineItem = {
  start: string;
  end: string;
  demandW?: number | null;
  solarW?: number | null;
  fuelCellMedianW?: number | null;
  predictedStartSocPercent?: number | null;
  predictedEndSocPercent?: number | null;
  plannedChargeWh?: number | null;
  discounted?: boolean;
  rateLabel?: string | null;
  yenPerKwh?: number | null;
  away?: boolean;
  awayDemandConfidence?: string | null;
};

export type AdaptiveChargingPlan = {
  available?: boolean;
  reason?: string | null;
  warning?: string | null;
  createdAt?: string | null;
  targetSunset?: string | null;
  currentSocPercent?: number | null;
  targetSocPercent?: number | null;
  expectedSunsetSocPercent?: number | null;
  horizonEnd?: string | null;
  forecastLastHour?: string | null;
  horizonTruncated?: boolean;
  predictedSolarKwh?: number | null;
  predictedDemandKwh?: number | null;
  predictedFuelCellKwh?: number | null;
  predictedSurplusKwh?: number | null;
  plannedChargeKwh?: number | null;
  plannedStoredChargeKwh?: number | null;
  timeline?: AdaptiveTimelineItem[];
  slots?: Array<{ start: string; end: string; windowEnd?: string; targetWh?: number; targetSocPercent?: number; label?: string }>;
  windows?: Array<{
    start?: string;
    end?: string;
    label?: string;
    targetSocPercent?: number | null;
    plannedChargeKwh?: number;
    unmetChargeKwh?: number;
    schedulingWatts?: number;
    timingReserveMs?: number;
    schedulingSource?: string;
    guardDeliverability?: {
      learned?: boolean;
      sampleCount?: number;
      interruptedSampleCount?: number;
      distinctDays?: number;
      deliveryFactor?: number;
      observedDeliveryRatio?: number;
      recoveryTimeFactor?: number;
      interruptionReserveMs?: number;
      blockers?: string[];
    };
  }>;
  demandHistory?: {
    recordedDayCount?: number;
    validDayCount?: number;
    recentComparableDayCount?: number;
    seasonalComparableDayCount?: number;
    seasonalYears?: number[];
    seasonalBlendPercent?: number;
    awaySlotCount?: number;
    awayComparableDayCount?: number;
    awayConfidence?: string | null;
  };
  solarCalibration?: { learned?: boolean; sampleCount?: number; factor?: number | null };
};

export type AdaptiveChargingStatus = {
  enabled: boolean;
  available: boolean;
  reason?: string | null;
  warning?: string | null;
  paused?: boolean;
  pausedUntil?: string | null;
  owner?: string | null;
  activeSlot?: { start?: string; end?: string; windowEnd?: string; targetWh?: number; targetSocPercent?: number; label?: string } | null;
  forecast?: { fetchedAt?: string | null; ageMs?: number | null; timezone?: string | null; stale?: boolean } | null;
  plan?: AdaptiveChargingPlan | null;
  away?: AwayPeriodsView;
  batteryModel?: {
    version?: number;
    status?: "learning" | "validating" | "active" | "degraded";
    charge?: { acceptedObservationCount?: number; distinctDays?: number; blockers?: string[] };
    discharge?: { acceptedObservationCount?: number; distinctDays?: number; blockers?: string[] };
    power?: { sampleCount?: number; sessionCount?: number; blockers?: string[] };
  } | null;
  solarForecastAccuracy?: {
    learned?: boolean;
    sampleCount?: number;
    factor?: number | null;
    meanAbsolutePercentageError?: number | null;
    outcomes?: Array<{
      targetDate?: string;
      predictedKwh?: number | null;
      planningKwh?: number | null;
      actualKwh?: number | null;
      errorKwh?: number | null;
      errorPercent?: number | null;
    }>;
  };
  fuelCellForecastOutcomes?: Array<{
    start?: string;
    targetStart?: string;
    end?: string;
    p20W?: number | null;
    medianW?: number | null;
    p80W?: number | null;
    actualKwh?: number | null;
    influence?: string | null;
  }>;
  windowSummaries?: Array<{
    key?: string;
    windowStart?: string;
    windowEnd?: string;
    label?: string | null;
    plannedWh?: number | null;
    deliveredWh?: number | null;
    estimatedDeliveryWh?: number | null;
    unmetWh?: number | null;
    targetSocPercent?: number | null;
    socTargetReached?: boolean;
    interruptionCount?: number;
    guardInterruptedMs?: number;
    solarHeadroomInterruptionCount?: number;
    startSocPercent?: number | null;
    endSocPercent?: number | null;
    completedAt?: string | null;
    reason?: string | null;
  }>;
  lastResult?: { skipped?: string; gridImportW?: number | null; thresholdW?: number | null; at?: string | null; error?: string | null } | null;
  lastForecastError?: { at?: string | null; error?: string | null } | null;
  log?: AutomationLogEntry[];
};

export type LoadingState = "loading" | "ready" | "refreshing" | "error";
