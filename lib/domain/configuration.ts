import { normalizeRetentionPolicy } from "./retention.js";
import { DEFAULT_NOTIFICATION_CONFIG, normalizeNotificationConfig } from "./notification-configuration.js";
import type {
  AdaptiveChargingConfig,
  ApplicationConfig,
  BatteryCapabilities,
  DashboardWidget,
  FuelCellConfig,
  NotificationConfig,
  RateBand,
  RateMode,
  RetentionConfig,
  SettingCacheEntry,
} from "../contracts/configuration.js";
import { normalizeCircuitLabels } from "./circuits.js";
import { isDocumentationHost } from "./status-alerts.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

export const DEFAULT_DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  { id: "solarPower", group: "trends", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", visible: true, priority: 70 },
  { id: "adaptiveCharging", group: "status", visible: true, priority: 5 },
  { id: "backupPreparation", group: "status", visible: true, priority: 6 },
  { id: "awayStatus", group: "status", visible: true, priority: 7 },
  { id: "batteryWorking", group: "status", visible: true, priority: 10 },
  { id: "operationMode", group: "status", visible: true, priority: 20 },
  { id: "vendorProfile", group: "status", visible: true, priority: 30 },
  { id: "dischargeLimit", group: "status", visible: true, priority: 40 },
  { id: "fuelCellStatus", group: "status", visible: true, priority: 50 },
  { id: "fuelCellStateTimeline", group: "status", visible: true, priority: 55 },
  { id: "fuelCellHotWater", group: "status", visible: true, priority: 57 },
  { id: "solarSavings", group: "status", visible: true, priority: 60 },
  { id: "co2Savings", group: "status", visible: true, priority: 70 },
  { id: "offPeakSavings", group: "status", visible: true, priority: 80 },
  { id: "powerImported", group: "status", visible: true, priority: 90 },
  { id: "powerExported", group: "status", visible: true, priority: 100 },
  { id: "guardTriggerCount", group: "status", visible: true, priority: 110 },
  { id: "energySources", group: "status", visible: true, priority: 120 },
];

const normalizedRetention = normalizeRetentionPolicy();
const DEFAULT_RETENTION: RetentionConfig = {
  rawTelemetryDays: nullableRetentionDays(normalizedRetention.rawTelemetryDays, 1095),
  intervalAggregatesDays: nullableRetentionDays(normalizedRetention.intervalAggregatesDays, null),
  dailyAggregatesDays: nullableRetentionDays(normalizedRetention.dailyAggregatesDays, null),
  adaptiveChargingHistoryDays: nullableRetentionDays(normalizedRetention.adaptiveChargingHistoryDays, null),
  automationEventDays: nullableRetentionDays(normalizedRetention.automationEventDays, null),
  commandReceiptDays: nullableRetentionDays(normalizedRetention.commandReceiptDays, 365),
  notificationDeliveryDays: nullableRetentionDays(normalizedRetention.notificationDeliveryDays, 365),
  automaticMaintenance: true,
};

export const DEFAULT_CONFIG: ApplicationConfig = {
  batteryHost: "192.0.2.10",
  meterHost: "192.0.2.20",
  meterEoj: "0x028701",
  smartCosmoEnabled: true,
  circuitLabels: {},
  circuitDashboardVisibility: {},
  circuitSortMode: "number",
  solarHost: "192.0.2.10",
  solarEnabled: true,
  fuelCellHosts: ["192.0.2.30"],
  fuelCellPrimaryHost: "192.0.2.30",
  fuelCellProxyHosts: [],
  fuelCellEnabled: true,
  fuelCell: {
    includeInAdaptiveCharging: false,
    gasCo2KgPerM3: 2.21,
    tariff: {
      provider: "tokyo-gas",
      region: "tokyo",
      plan: "enefarm",
      equipmentDiscount: "",
      meterReadingDay: 1,
      automaticUpdates: false,
      marginalRateOverrideYenPerM3: null,
    },
  },
  rateMode: "simple",
  standardRateYenPerKwh: 35,
  offPeakRateYenPerKwh: 25,
  offPeakSavingsEnabled: false,
  discoverySubnets: [],
  retention: DEFAULT_RETENTION,
  updateIntervalSeconds: 15,
  co2TonnesPerKwh: 0.000423,
  rateBands: [{ start: "00:00", end: "00:00", yenPerKwh: 35, label: "Simple" }],
  batteryCapabilities: { usableCapacityKwh: null, maximumChargeWatts: null, roundTripEfficiency: 0.9 },
  adaptiveCharging: {
    enabled: false,
    latitude: null,
    longitude: null,
    arrayPeakKw: null,
    panelTiltDegrees: 30,
    panelAzimuthDegrees: 0,
    systemLossPercent: 14,
    targetSocPercent: 100,
    forecastMarginPercent: 10,
  },
  notifications: DEFAULT_NOTIFICATION_CONFIG as NotificationConfig,
  dashboardWidgets: [...DEFAULT_DASHBOARD_WIDGETS],
  settingCache: {},
  language: "en",
};

export function normalizeHostList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return values.map((item) => String(item).trim()).filter(Boolean);
}

export function configBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

export function configNumber(value: unknown, fallback: number, min = 0, max = 1000): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function nullableRetentionDays(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
}

export function optionalConfigNumber(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}

function optionalSteppedConfigNumber(value: unknown, min: number, max: number, step: number): number | null {
  const number = optionalConfigNumber(value, min, max);
  return number === null ? null : Math.max(min, Math.min(max, Math.round(number / step) * step));
}

export function isValidTime(value: unknown): boolean {
  if (!/^\d{2}:\d{2}$/.test(String(value ?? ""))) return false;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function minutesOfDay(value: unknown): number | null {
  if (!isValidTime(value)) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export { normalizePrivateDiscoverySubnets as normalizeSubnets } from "./discovery-subnets.js";
import { normalizePrivateDiscoverySubnets } from "./discovery-subnets.js";

function normalizeRateModeRecord(input: UnknownRecord): RateMode {
  if (input.rateMode === "simple" || input.rateMode === "offPeak" || input.rateMode === "multi") return input.rateMode;
  if (input.offPeakSavingsEnabled === true) {
    return Array.isArray(input.rateBands) && input.rateBands.length > 2 ? "multi" : "offPeak";
  }
  return DEFAULT_CONFIG.rateMode;
}

export function normalizeRateMode(input: unknown = {}): RateMode {
  return normalizeRateModeRecord(record(input));
}

export function normalizeRateBands(input: unknown = {}): RateBand[] {
  const sourceInput = record(input);
  const hasRateMode = sourceInput.rateMode === "simple" || sourceInput.rateMode === "offPeak" || sourceInput.rateMode === "multi";
  const rateMode = hasRateMode ? sourceInput.rateMode as RateMode : normalizeRateModeRecord(sourceInput);
  const standardRate = configNumber(sourceInput.standardRateYenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000);
  const offPeakRate = configNumber(sourceInput.offPeakRateYenPerKwh, DEFAULT_CONFIG.offPeakRateYenPerKwh, 0, 1000);
  const providedBands = Array.isArray(sourceInput.rateBands) && sourceInput.rateBands.length ? sourceInput.rateBands : null;
  const source: unknown[] = !hasRateMode && providedBands
    ? providedBands
    : rateMode === "simple"
      ? [{ start: "00:00", end: "00:00", yenPerKwh: standardRate, label: "Simple" }]
      : providedBands
        ? providedBands
        : rateMode === "offPeak"
          ? [
              { start: "00:00", end: "07:00", yenPerKwh: offPeakRate, label: "Off-peak" },
              { start: "07:00", end: "00:00", yenPerKwh: standardRate, label: "Standard" },
            ]
          : [{ start: "00:00", end: "07:00", yenPerKwh: offPeakRate, label: "Off-peak" }];
  const bands = source.map((value): RateBand => {
    const band = record(value);
    return {
      start: isValidTime(band.start) ? String(band.start) : "00:00",
      end: isValidTime(band.end) ? String(band.end) : "00:00",
      yenPerKwh: configNumber(band.yenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000),
      label: String(band.label ?? "").trim(),
    };
  });
  return bands.length ? bands : [...DEFAULT_CONFIG.rateBands];
}

function normalizeBatteryCapabilities(value: unknown): BatteryCapabilities {
  const input = record(value);
  return {
    usableCapacityKwh: optionalConfigNumber(input.usableCapacityKwh, 0.1, 1000),
    maximumChargeWatts: optionalSteppedConfigNumber(input.maximumChargeWatts, 50, 100000, 1),
    roundTripEfficiency: configNumber(input.roundTripEfficiency, DEFAULT_CONFIG.batteryCapabilities.roundTripEfficiency, 0.5, 1),
  };
}

function normalizeAdaptiveCharging(value: unknown): AdaptiveChargingConfig {
  const input = record(value);
  return {
    enabled: configBool(input.enabled, DEFAULT_CONFIG.adaptiveCharging.enabled),
    latitude: optionalConfigNumber(input.latitude, -90, 90),
    longitude: optionalConfigNumber(input.longitude, -180, 180),
    arrayPeakKw: optionalConfigNumber(input.arrayPeakKw, 0.1, 10000),
    panelTiltDegrees: configNumber(input.panelTiltDegrees, DEFAULT_CONFIG.adaptiveCharging.panelTiltDegrees, 0, 90),
    panelAzimuthDegrees: configNumber(input.panelAzimuthDegrees, DEFAULT_CONFIG.adaptiveCharging.panelAzimuthDegrees, -180, 180),
    systemLossPercent: configNumber(input.systemLossPercent, DEFAULT_CONFIG.adaptiveCharging.systemLossPercent, 0, 50),
    targetSocPercent: configNumber(input.targetSocPercent, DEFAULT_CONFIG.adaptiveCharging.targetSocPercent, 50, 100),
    forecastMarginPercent: configNumber(input.forecastMarginPercent, DEFAULT_CONFIG.adaptiveCharging.forecastMarginPercent, 0, 50),
  };
}

function normalizeFuelCellConfig(value: unknown): FuelCellConfig {
  const input = record(value);
  const tariff = record(input.tariff);
  const region = String(tariff.region ?? "tokyo").trim();
  const discount = String(tariff.equipmentDiscount ?? "").trim();
  return {
    includeInAdaptiveCharging: configBool(input.includeInAdaptiveCharging, false),
    gasCo2KgPerM3: configNumber(input.gasCo2KgPerM3, 2.21, 0, 100),
    tariff: {
      provider: String(tariff.provider ?? "tokyo-gas").trim() || "tokyo-gas",
      region: region === "gunma" ? "gunma" : "tokyo",
      plan: "enefarm",
      equipmentDiscount: discount === "bath" || discount === "floor" || discount === "set" ? discount : "",
      meterReadingDay: configNumber(tariff.meterReadingDay, 1, 1, 31),
      automaticUpdates: configBool(tariff.automaticUpdates, false),
      marginalRateOverrideYenPerM3: optionalConfigNumber(tariff.marginalRateOverrideYenPerM3, 0, 100000),
    },
  };
}

function normalizeFuelCellHosts(input: UnknownRecord): { primary: string; proxies: string[]; all: string[] } {
  const legacy = normalizeHostList(input.fuelCellHosts ?? DEFAULT_CONFIG.fuelCellHosts);
  const configuredPrimary = String(input.fuelCellPrimaryHost ?? "").trim();
  const meterHost = String(input.meterHost ?? "");
  const primary = configuredPrimary && configuredPrimary !== meterHost
    ? configuredPrimary
    : legacy.find((host) => host !== meterHost) ?? "";
  const configuredProxies = input.fuelCellProxyHosts === undefined
    ? legacy.filter((host) => host !== primary)
    : normalizeHostList(input.fuelCellProxyHosts);
  const proxies = [...new Set([
    ...configuredProxies,
    ...(configuredPrimary === meterHost ? [configuredPrimary] : []),
    ...legacy.filter((host) => host === meterHost && host !== primary),
  ])].filter((host) => host && host !== primary);
  return { primary, proxies, all: [...new Set([primary, ...proxies].filter(Boolean))] };
}

export function normalizeDashboardWidgets(value: unknown = []): DashboardWidget[] {
  const inputById = new Map<string, UnknownRecord>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const widget = record(candidate);
    const id = String(widget.id ?? "");
    if (DEFAULT_DASHBOARD_WIDGETS.some((item) => item.id === id)) inputById.set(id, widget);
  }
  return DEFAULT_DASHBOARD_WIDGETS.map((defaults) => {
    const input = inputById.get(defaults.id) ?? {};
    return {
      ...defaults,
      visible: configBool(input.visible, defaults.visible),
      priority: configNumber(input.priority, defaults.priority, 0, 10000),
    };
  });
}

function normalizeCircuitDashboardVisibility(value: unknown): Record<string, boolean> {
  const output: Record<string, boolean> = {};
  const entries: Array<[unknown, unknown]> = Array.isArray(value)
    ? value.map((item) => {
        const input = record(item);
        return [input.channel, input.visible];
      })
    : Object.entries(record(value));
  for (const [channelValue, visibleValue] of entries) {
    const channel = Number(channelValue);
    if (Number.isInteger(channel) && channel >= 1 && channel <= 252) output[String(channel)] = configBool(visibleValue, true);
  }
  return output;
}

export function normalizeRetentionConfig(value: unknown, legacyDays?: unknown): RetentionConfig {
  const input = record(value);
  const normalized = normalizeRetentionPolicy(input, legacyDays);
  return {
    rawTelemetryDays: nullableRetentionDays(normalized.rawTelemetryDays, DEFAULT_RETENTION.rawTelemetryDays),
    intervalAggregatesDays: nullableRetentionDays(normalized.intervalAggregatesDays, DEFAULT_RETENTION.intervalAggregatesDays),
    dailyAggregatesDays: nullableRetentionDays(normalized.dailyAggregatesDays, DEFAULT_RETENTION.dailyAggregatesDays),
    adaptiveChargingHistoryDays: nullableRetentionDays(normalized.adaptiveChargingHistoryDays, DEFAULT_RETENTION.adaptiveChargingHistoryDays),
    automationEventDays: nullableRetentionDays(normalized.automationEventDays, DEFAULT_RETENTION.automationEventDays),
    commandReceiptDays: nullableRetentionDays(normalized.commandReceiptDays, DEFAULT_RETENTION.commandReceiptDays),
    notificationDeliveryDays: nullableRetentionDays(normalized.notificationDeliveryDays, DEFAULT_RETENTION.notificationDeliveryDays),
    automaticMaintenance: configBool(input.automaticMaintenance, true),
  };
}

function normalizeSettingCache(value: unknown): Record<string, SettingCacheEntry> {
  const input = record(value);
  const output: Record<string, SettingCacheEntry> = {};
  for (const key of ["discharge_limit", "osaifu_charge_window", "osaifu_discharge_window"]) {
    const cached = record(input[key]);
    if (cached.lastKnown) {
      const lastKnown = record(cached.lastKnown);
      output[key] = {
        lastKnown: { ...lastKnown, decoded: record(lastKnown.decoded) },
        lastReadAt: cached.lastReadAt ?? null,
      };
    }
  }
  return output;
}

export function cleanConfig(value: unknown = {}, options: { externalIoDisabled?: boolean } = {}): ApplicationConfig {
  const input = record(value);
  const rateMode = normalizeRateModeRecord(input);
  const rateBands = normalizeRateBands({ ...input, rateMode });
  const standardRate = configNumber(input.standardRateYenPerKwh, Math.max(...rateBands.map((band) => band.yenPerKwh)));
  const offPeakRate = configNumber(input.offPeakRateYenPerKwh, Math.min(...rateBands.map((band) => band.yenPerKwh)));
  const fuelCellHosts = normalizeFuelCellHosts(input);
  const notifications = normalizeNotificationConfig(record(input.notifications)) as NotificationConfig;
  return {
    batteryHost: String(input.batteryHost ?? DEFAULT_CONFIG.batteryHost).trim(),
    meterHost: String(input.meterHost ?? DEFAULT_CONFIG.meterHost).trim(),
    meterEoj: String(input.meterEoj ?? DEFAULT_CONFIG.meterEoj).trim() || DEFAULT_CONFIG.meterEoj,
    smartCosmoEnabled: configBool(input.smartCosmoEnabled, DEFAULT_CONFIG.smartCosmoEnabled),
    circuitLabels: normalizeCircuitLabels(input.circuitLabels ?? DEFAULT_CONFIG.circuitLabels),
    circuitDashboardVisibility: normalizeCircuitDashboardVisibility(input.circuitDashboardVisibility),
    circuitSortMode: input.circuitSortMode === "energy" ? "current"
      : input.circuitSortMode === "current" || input.circuitSortMode === "accumulated" ? input.circuitSortMode : "number",
    solarHost: String(input.solarHost ?? input.batteryHost ?? DEFAULT_CONFIG.solarHost).trim(),
    solarEnabled: configBool(input.solarEnabled, DEFAULT_CONFIG.solarEnabled),
    fuelCellHosts: fuelCellHosts.all,
    fuelCellPrimaryHost: fuelCellHosts.primary,
    fuelCellProxyHosts: fuelCellHosts.proxies,
    fuelCellEnabled: configBool(input.fuelCellEnabled, DEFAULT_CONFIG.fuelCellEnabled),
    fuelCell: normalizeFuelCellConfig(input.fuelCell),
    rateMode,
    standardRateYenPerKwh: standardRate,
    offPeakRateYenPerKwh: offPeakRate,
    offPeakSavingsEnabled: rateMode !== "simple",
    co2TonnesPerKwh: configNumber(input.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1),
    discoverySubnets: normalizePrivateDiscoverySubnets(input.discoverySubnets),
    retention: normalizeRetentionConfig(input.retention, input.historyRetentionDays),
    updateIntervalSeconds: configNumber(input.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 5, 3600),
    rateBands,
    batteryCapabilities: normalizeBatteryCapabilities(input.batteryCapabilities),
    adaptiveCharging: normalizeAdaptiveCharging(input.adaptiveCharging),
    notifications: options.externalIoDisabled ? { ...notifications, enabled: false } : notifications,
    dashboardWidgets: normalizeDashboardWidgets(input.dashboardWidgets),
    settingCache: normalizeSettingCache(input.settingCache),
    language: input.language === "ja" ? "ja" : "en",
  };
}

export function anyDeviceConfigured(config: ApplicationConfig): boolean {
  const hosts: Array<string | null> = [
    config.batteryHost,
    config.smartCosmoEnabled ? config.meterHost : null,
    config.solarEnabled ? config.solarHost : null,
    ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
  ];
  return hosts.some((host) => Boolean(host && !isDocumentationHost(host)));
}
