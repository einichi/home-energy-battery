import type { ApplicationConfig } from "../contracts/configuration.js";
import { adaptiveChargingBreakerSettings } from "./adaptive-plan-utils.js";
import type { AutomationRule } from "./automation-rules.js";
import type { SolarForecast } from "./solar-forecast.js";

const SOLAR_FORECAST_MAX_AGE_MS = 6 * 60 * 60_000;

export interface AdaptiveChargingAvailability {
  available: boolean;
  reason: string | null;
}

export function adaptiveChargingBaseAvailability(config: ApplicationConfig): AdaptiveChargingAvailability {
  if (config.solarEnabled === false) return { available: false, reason: "solar generation is disabled" };
  if (!config.adaptiveCharging?.enabled) return { available: false, reason: "adaptive charging is disabled" };
  if (config.rateMode === "simple") return { available: false, reason: "Off-Peak or Multi-Rate pricing is required" };
  const coordinates: Array<[unknown, string]> = [
    [config.adaptiveCharging.latitude, "latitude"],
    [config.adaptiveCharging.longitude, "longitude"],
  ];
  const positive: Array<[unknown, string]> = [
    [config.adaptiveCharging.arrayPeakKw, "array peak capacity"],
    [config.batteryCapabilities?.usableCapacityKwh, "usable battery capacity"],
    [config.batteryCapabilities?.maximumChargeWatts, "maximum battery charge watts"],
  ];
  const missing = [
    ...coordinates.filter(([value]) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))),
    ...positive.filter(([value]) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0),
  ].map(([, label]) => label);
  if (missing.length) return { available: false, reason: `missing ${missing.join(", ")}` };
  if (config.smartCosmoEnabled === false) return { available: false, reason: "total circuit load is unavailable" };
  return { available: true, reason: null };
}

export function adaptiveChargingAvailability(
  config: ApplicationConfig,
  rules: AutomationRule[] = [],
): AdaptiveChargingAvailability {
  const base = adaptiveChargingBaseAvailability(config);
  if (!base.available) return base;
  return adaptiveChargingBreakerSettings(rules).valid
    ? base
    : { available: false, reason: "Charging Demand Guard settings are unavailable" };
}

export function forecastIsFresh(
  forecast: Pick<SolarForecast, "fetchedAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  const fetchedAt = new Date(forecast?.fetchedAt ?? "").getTime();
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= SOLAR_FORECAST_MAX_AGE_MS;
}
