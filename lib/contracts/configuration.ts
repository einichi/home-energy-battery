export type RateMode = "simple" | "offPeak" | "multi";

export interface RateBand {
  start: string;
  end: string;
  yenPerKwh: number;
  label: string;
}

export interface DashboardWidget {
  id: string;
  group: "trends" | "status";
  visible: boolean;
  priority: number;
}

export interface BatteryCapabilities {
  usableCapacityKwh: number | null;
  maximumChargeWatts: number | null;
  roundTripEfficiency: number;
}

export interface AdaptiveChargingConfig {
  enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  arrayPeakKw: number | null;
  panelTiltDegrees: number;
  panelAzimuthDegrees: number;
  systemLossPercent: number;
  targetSocPercent: number;
  forecastMarginPercent: number;
}

export interface FuelCellTariffConfig {
  provider: string;
  region: "tokyo" | "gunma";
  plan: "enefarm";
  equipmentDiscount: "" | "bath" | "floor" | "set";
  meterReadingDay: number;
  automaticUpdates: boolean;
  marginalRateOverrideYenPerM3: number | null;
}

export interface FuelCellConfig {
  includeInAdaptiveCharging: boolean;
  gasCo2KgPerM3: number;
  tariff: FuelCellTariffConfig;
}

export interface RetentionConfig {
  rawTelemetryDays: number | null;
  intervalAggregatesDays: number | null;
  dailyAggregatesDays: number | null;
  adaptiveChargingHistoryDays: number | null;
  automationEventDays: number | null;
  commandReceiptDays: number | null;
  notificationDeliveryDays: number | null;
  automaticMaintenance: boolean;
}

export interface SettingCacheEntry {
  lastKnown: Record<string, unknown> & { decoded: Record<string, unknown> };
  lastReadAt: unknown;
}

export interface NotificationChannelConfig {
  id: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface NotificationConfig {
  enabled: boolean;
  channels: NotificationChannelConfig[];
  triggers: Record<string, {
    enabled: boolean;
    cooldownMinutes: number;
    thresholdPercent?: number;
    [key: string]: unknown;
  }>;
}

export interface ApplicationConfig {
  [key: string]: unknown;
  batteryHost: string;
  meterHost: string;
  meterEoj: string;
  smartCosmoEnabled: boolean;
  circuitLabels: Record<string, string>;
  circuitDashboardVisibility: Record<string, boolean>;
  circuitSortMode: "number" | "current" | "accumulated";
  solarHost: string;
  solarEnabled: boolean;
  fuelCellHosts: string[];
  fuelCellPrimaryHost: string;
  fuelCellProxyHosts: string[];
  fuelCellEnabled: boolean;
  fuelCell: FuelCellConfig;
  rateMode: RateMode;
  standardRateYenPerKwh: number;
  offPeakRateYenPerKwh: number;
  offPeakSavingsEnabled: boolean;
  discoverySubnets: string[];
  retention: RetentionConfig;
  updateIntervalSeconds: number;
  co2TonnesPerKwh: number;
  rateBands: RateBand[];
  batteryCapabilities: BatteryCapabilities;
  adaptiveCharging: AdaptiveChargingConfig;
  notifications: NotificationConfig;
  dashboardWidgets: DashboardWidget[];
  settingCache: Record<string, SettingCacheEntry>;
  language: "en" | "ja";
}
