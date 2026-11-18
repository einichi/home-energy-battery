import type { ApplicationConfig } from "../contracts/configuration.js";
import { adaptiveChargingBreakerSettings } from "./adaptive-plan-utils.js";
import type { AdaptiveChargingState } from "./adaptive-state.js";
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
  return Number.isFinite(fetchedAt) && fetchedAt <= now.getTime()
    && now.getTime() - fetchedAt <= SOLAR_FORECAST_MAX_AGE_MS;
}

export function cachedForecastIsUsable(
  state: { forecast: Pick<SolarForecast, "fetchedAt"> | null; lastForecastError?: Record<string, unknown> | null },
  now = new Date(),
): boolean {
  const error = state.lastForecastError;
  const incompatible = error?.kind === "incompatible"
    || (!error?.kind && /timezone|coordinate|configuration/i.test(String(error?.error ?? "")));
  return forecastIsFresh(state.forecast, now) && !incompatible;
}

export function describeSolarForecastError(error: unknown): string | null {
  if (error === "fetch failed") return "Could not connect to Open-Meteo.";
  return typeof error === "string" && error ? error : null;
}

export function adaptiveChargingPlanningBlock(
  config: ApplicationConfig,
  state: AdaptiveChargingState,
  rules: AutomationRule[],
  now: Date,
) {
  if (state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime()) {
    return { kind: "paused", title: "Adaptive Charging paused", reason: `Paused until ${state.pausedUntil}` } as const;
  }
  if (config.adaptiveCharging?.enabled && state.lastResult?.kind === "equipment-unavailable" && typeof state.lastResult.skipped === "string") {
    return { kind: "equipment", title: "Waiting for equipment", reason: state.lastResult.skipped } as const;
  }
  const availability = adaptiveChargingAvailability(config, rules);
  if (!availability.available) {
    return { kind: "configuration", title: "Charging setup needs attention", reason: availability.reason ?? "Charging setup is incomplete." } as const;
  }
  if (!cachedForecastIsUsable(state, now)) {
    const reason = describeSolarForecastError(state.lastForecastError?.error)
      ?? (state.forecast ? "The last solar forecast has expired." : "Waiting for the first Open-Meteo solar forecast.");
    return { kind: "forecast", title: "Waiting for solar forecast", reason } as const;
  }
  if (state.plan?.available === false) {
    return { kind: "plan", title: "Charging plan unavailable", reason: state.plan.reason || "Adaptive Charging could not build a plan." } as const;
  }
  return null;
}
