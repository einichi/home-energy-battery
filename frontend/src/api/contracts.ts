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
  co2SavingKg?: number | null;
  circuits?: CircuitSummary[];
  dataQuality?: Record<string, DataQuality>;
  energySources?: {
    solarUsedKwh?: number | null;
    fuelCellContributionKwh?: number | null;
    totalKwh?: number | null;
  };
};

export type HistoryResponse = {
  samples: EnergySample[];
  summary: HistorySummary;
};

export type StatusSnapshot = {
  read_at?: string;
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
};

export type BatteryStrategy = {
  kind: "backup-preparation" | "demand-guard" | "adaptive-charging" | "away" | "manual" | "schedule" | "device-auto";
  title: string;
  description: string;
  manualOverride?: { active: boolean; label?: string; until?: string | null; untilChanged?: boolean };
  nextSchedule?: { id: string; name: string; action: string; at: string } | null;
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
  runtime?: RuntimeInformation;
  batteryHost?: string;
  adaptiveCharging?: { enabled?: boolean };
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

export type LoadingState = "loading" | "ready" | "refreshing" | "error";
