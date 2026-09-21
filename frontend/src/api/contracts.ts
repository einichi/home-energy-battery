export type Metric<T = number> = {
  value?: T | null;
  human?: string | null;
  error?: string | null;
};

export type BatteryStatus = {
  configured?: boolean;
  instant_power?: Metric<number>;
  remaining_percent?: Metric<number>;
  working_status?: Metric<string>;
  operation_mode?: Metric<string>;
  vendor_profile?: Metric<string>;
  error?: string | null;
};

export type FuelCellStatus = {
  instant_power?: Metric<number>;
  generation_status?: Metric<string>;
  hot_water_level?: Metric<number>;
  source_role?: string;
  error?: string | null;
};

export type SavingsSummary = {
  start?: string | null;
  end?: string | null;
  solarSavingYen?: number | null;
  co2SavingKg?: number | null;
  guardTriggerCount?: number | null;
  gridImportKwh?: number | null;
  gridExportKwh?: number | null;
  totalOffPeakSavingYen?: number | null;
  gridOffPeakSavingYen?: number | null;
  batteryOffPeakSavingYen?: number | null;
  sampleCount?: number | null;
  energySources?: EnergySources;
};

export type EnergySources = {
  peakGridKwh?: number | null;
  peakGridPercent?: number | null;
  offPeakGridKwh?: number | null;
  offPeakGridPercent?: number | null;
  solarUsedKwh?: number | null;
  solarUsedPercent?: number | null;
  fuelCellContributionKwh?: number | null;
  fuelCellContributionPercent?: number | null;
  totalKwh?: number | null;
};

export type EneFarmInterval = {
  start: string;
  end: string;
  state?: string | null;
  durationSeconds?: number | null;
  generatedKwh?: number | null;
  gasM3?: number | null;
  quality?: string | null;
};

export type EneFarmSummary = {
  configured?: boolean;
  sampleCount?: number;
  start?: string | null;
  end?: string | null;
  generatedKwh?: number | null;
  gasM3?: number | null;
  electricalYieldKwhPerM3?: number | null;
  operatingSeconds?: number | null;
  startCount?: number | null;
  averageGeneratingW?: number | null;
  currentState?: string | null;
  stateSince?: string | null;
  timeInStateSeconds?: number | null;
  lastStopAt?: string | null;
  dataQuality?: string | null;
  stateIntervals?: EneFarmInterval[];
  estimateNotice?: string | null;
};

export type EnergySample = {
  timestamp: string;
  batteryPowerW?: number | null;
  stateOfChargePercent?: number | null;
  solarPowerW?: number | null;
  houseDemandW?: number | null;
  fuelCellPowerW?: number | null;
  fuelCellHotWaterLevel?: number | null;
  gridImportW?: number | null;
  gridExportW?: number | null;
  circuitPowerW?: Record<string, number | null>;
  circuitEnergyKwh?: Record<string, number | null>;
  circuitCumulativeKwh?: Record<string, number | null>;
  energyQuality?: Record<string, string | null>;
};

export type DataQuality = {
  quality?: string | null;
  coverageSeconds?: number | null;
  coveragePercent?: number | null;
};

export type CircuitSummary = {
  channel: number;
  id?: string;
  label?: string;
  totalKwh?: number | null;
  latestWatts?: number | null;
};

export type HistorySummary = {
  sampleCount?: number;
  start?: string | null;
  end?: string | null;
  solarGenerationKwh?: number | null;
  fuelCellKwh?: number | null;
  houseDemandKwh?: number | null;
  gridImportKwh?: number | null;
  gridExportKwh?: number | null;
  batteryChargedKwh?: number | null;
  batteryDischargedKwh?: number | null;
  batteryNetKwh?: number | null;
  averageStateOfChargePercent?: number | null;
  solarSavingYen?: number | null;
  offPeakSavingYen?: number | null;
  totalOffPeakSavingYen?: number | null;
  gridOffPeakSavingYen?: number | null;
  batteryOffPeakSavingYen?: number | null;
  co2SavingKg?: number | null;
  guardTriggerCount?: number | null;
  circuits?: CircuitSummary[];
  circuitTotalKwh?: number | null;
  dataQuality?: Record<string, DataQuality>;
  energySources?: EnergySources;
  solarCoveragePercent?: number | null;
};

export type HistoryResponse = {
  samples: EnergySample[];
  summary: HistorySummary;
};

export type EnergyReportBucket = HistorySummary & {
  key: string;
  label: string;
  start: string;
  end: string;
  previousHouseDemandKwh?: number | null;
  houseDemandDeltaKwh?: number | null;
  houseDemandDeltaPercent?: number | null;
  peakDemandW?: number | null;
  sampleCount?: number;
};

export type EnergyReport = {
  start: string;
  end: string;
  bucket: "day" | "week" | "month";
  buckets: EnergyReportBucket[];
  totals: EnergyReportBucket;
  features?: { solarEnabled?: boolean; smartCosmoEnabled?: boolean; fuelCellEnabled?: boolean };
  meta?: { recordsRead?: number; recordsIncluded?: number; invalidRecords?: number; resolution?: string };
};

export type EneFarmReportBucket = EneFarmSummary & {
  key: string;
  label: string;
  onSiteKwh?: number | null;
  generationCoveragePercent?: number | null;
  estimatedGasCost?: {
    marginalCostYen?: number | null;
    standingChargeInclusive?: { available?: boolean; totalYen?: number | null; allocatedYenPerM3?: number | null; reason?: string | null };
  } | null;
  carbon?: { estimated?: boolean; directGasCo2Kg?: number | null; avoidedGridCo2Kg?: number | null; electricityOnlyBalanceKg?: number | null; methodology?: string };
};

export type EneFarmReport = {
  start: string;
  end: string;
  bucket: "day" | "week" | "month";
  buckets: EneFarmReportBucket[];
  totals: EneFarmReportBucket;
  estimateNotice?: string;
};

export type StatusSnapshot = {
  read_at?: string;
  statusRefreshPaused?: boolean;
  statusRefreshPausedReason?: string | null;
  alerts?: SystemAlert[];
  hosts?: { battery?: string | null };
  energy?: {
    battery?: BatteryStatus;
    solar?: { configured?: boolean; instant_power?: Metric<number>; error?: string | null };
    fuel_cells?: FuelCellStatus[];
    error?: string | null;
    errors?: Array<{ error?: string | null }>;
  };
  meter?: {
    configured?: boolean;
    house_demand_power?: Metric<number>;
    grid_import_power?: Metric<number>;
    grid_export_power?: Metric<number>;
    channel_power?: { decoded?: { channels?: Array<{ channel: number; value?: number | null }> } };
    error?: string | null;
    errors?: Array<{ error?: string | null }>;
  };
  settings?: {
    mode?: { decoded?: { mode?: string | null }; mode?: string | null; error?: string | null };
    discharge_limit?: { decoded?: { percent?: number | null }; available?: boolean; error?: string | null };
    osaifu_charge_window?: { decoded?: BatteryWindow; available?: boolean; error?: string | null };
    osaifu_discharge_window?: { decoded?: BatteryWindow; available?: boolean; error?: string | null };
  };
  batteryStrategy?: BatteryStrategy;
  savings?: SavingsSummary;
  savingsPeriods?: {
    today?: SavingsSummary;
    lastMonth?: SavingsSummary;
    month?: SavingsSummary;
    year?: SavingsSummary;
  };
};

export type SystemAlert = {
  id: string;
  source?: string | null;
  severity: "info" | "warning" | "critical";
  title: string;
  startedAt: string;
  impact: string;
  suggestedAction: string;
  href?: string | null;
  resolution: "active" | "resolved" | string;
};

export type BatteryStrategy = {
  kind: "backup-preparation" | "demand-guard" | "adaptive-charging" | "away" | "manual" | "schedule" | "device-auto";
  title: string;
  description: string;
  manualOverride?: { active: boolean; label?: string; until?: string | null; untilChanged?: boolean };
  nextSchedule?: { id: string; name: string; action: string; at: string } | null;
  nextAction?: {
    action?: "charge" | "continue-charging" | string;
    title: string;
    reason: string;
    at?: string | null;
    endAt?: string | null;
    targetSocPercent?: number | null;
    confidence?: string | null;
    href: string;
  } | null;
};

export type BatteryWindow = {
  start_hour?: number | null;
  end_hour?: number | null;
  human?: string | null;
};

export type RuntimeInformation = {
  uiDevelopment: boolean;
  simulatedDevices: boolean;
  externalIoDisabled: boolean;
};

export type AppConfig = {
  updateIntervalSeconds: number;
  language: "en" | "ja";
  solarEnabled: boolean;
  smartCosmoEnabled: boolean;
  fuelCellEnabled: boolean;
  rateMode?: "simple" | "off-peak" | "multi" | string;
  runtime?: RuntimeInformation;
  batteryHost?: string;
  meterHost?: string;
  meterEoj?: string;
  solarHost?: string;
  fuelCellPrimaryHost?: string;
  fuelCellProxyHosts?: string[];
  discoverySubnets?: string[];
  circuitLabels?: Record<string, string>;
  circuitDashboardVisibility?: Record<string, boolean>;
  circuitSortMode?: "number" | "current" | "accumulated" | string;
  standardRateYenPerKwh?: number;
  offPeakRateYenPerKwh?: number;
  offPeakSavingsEnabled?: boolean;
  co2TonnesPerKwh?: number;
  rateBands?: Array<{ start: string; end: string; yenPerKwh: number; label?: string }>;
  fuelCell?: {
    includeInAdaptiveCharging?: boolean;
    gasCo2KgPerM3?: number;
    tariff?: { provider?: string; region?: string; plan?: string; equipmentDiscount?: string; meterReadingDay?: number; automaticUpdates?: boolean; marginalRateOverrideYenPerM3?: number | null };
  };
  retention?: { rawTelemetryDays?: number; intervalAggregatesDays?: number | null; dailyAggregatesDays?: number | null; adaptiveChargingHistoryDays?: number | null; automationEventDays?: number | null; commandReceiptDays?: number | null; notificationDeliveryDays?: number; automaticMaintenance?: boolean };
  dashboardWidgets?: Array<{ id: string; group?: string; visible: boolean; priority?: number }>;
  notifications?: NotificationConfig;
  batteryCapabilities?: { usableCapacityKwh?: number | null; maximumChargeWatts?: number | null };
  adaptiveCharging?: {
    enabled?: boolean;
    latitude?: number | null;
    longitude?: number | null;
    arrayPeakKw?: number | null;
    panelTiltDegrees?: number | null;
    panelAzimuthDegrees?: number | null;
    systemLossPercent?: number | null;
    targetSocPercent?: number | null;
    forecastMarginPercent?: number | null;
  };
};

export type NotificationTrigger = { enabled: boolean; cooldownMinutes: number; thresholdPercent?: number };
export type NotificationConfig = {
  enabled: boolean;
  channels: Array<{ id: string; type: "smtp" | string; enabled: boolean; settings: { host?: string; port?: number; security?: string; username?: string; from?: string; recipients?: string[] } }>;
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
  source?: "manual" | "scheduled" | string;
  status?: "scheduled" | "active" | "completed" | string;
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
  predictedSolarKwh?: number | null;
  predictedDemandKwh?: number | null;
  predictedFuelCellKwh?: number | null;
  predictedSurplusKwh?: number | null;
  plannedChargeKwh?: number | null;
  plannedStoredChargeKwh?: number | null;
  timeline?: AdaptiveTimelineItem[];
  slots?: Array<{ start: string; end: string; windowEnd?: string; targetWh?: number; targetSocPercent?: number; label?: string }>;
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
    status?: "learning" | "validating" | "active" | "degraded" | string;
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
