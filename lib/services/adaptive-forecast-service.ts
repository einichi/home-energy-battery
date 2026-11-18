import { MILLISECONDS_PER_DAY } from "../domain/time.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import { appendAdaptiveChargingLog, type AdaptiveChargingState } from "../domain/adaptive-state.js";
import {
  adaptiveChargingTimezoneError,
  dailySolarForecastIssues,
  learnedSolarFactor,
  parseOpenMeteoForecast,
  type DailySolarForecastIssue,
  type SolarForecast,
  type SolarForecastHour,
} from "../domain/solar-forecast.js";
import { localDayKey } from "../domain/time.js";
import { asRecord, errorMessage } from "../domain/values.js";

interface ForecastOutcome {
  rawPredictedKwh: number;
  actualKwh: number;
  errorPercent: number | null;
}

interface ForecastAccuracy {
  learned: boolean;
  sampleCount: number;
  measuredFactor: number | null;
  factor: number;
  meanAbsolutePercentageError: number | null;
  outcomes: ForecastOutcome[];
  error?: string;
}

interface AdaptiveForecastHistoryPort {
  recordForecast(forecast: SolarForecast): boolean;
  recordWeather(records: SolarForecastHour[]): number;
  isReady(): boolean;
  settleSolarForecastOutcomes(now: Date): number;
  historicalWeather(): SolarForecastHour[];
  solarForecastAccuracy(): ForecastAccuracy;
  recordSolarForecastIssues(issues: DailySolarForecastIssue[]): number;
}

interface AdaptiveForecastDependencies {
  history: AdaptiveForecastHistoryPort;
  externalIoDisabled: boolean;
  timezone: string | null;
  readState(): Promise<AdaptiveChargingState>;
  readConfig?(): Promise<ApplicationConfig>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  readHistory(now?: Date): Promise<Array<HistorySample & { timestamp: string }>>;
  logError(label: string, error: unknown): void;
}

interface RefreshOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  forceHistorical?: boolean;
}

const OPEN_METEO_ENDPOINTS = {
  jma: "https://api.open-meteo.com/v1/jma",
  "previous-runs": "https://previous-runs-api.open-meteo.com/v1/forecast",
  historical: "https://historical-forecast-api.open-meteo.com/v1/forecast",
};
const FORECAST_HOUR_FIELDS = ["shortwave_radiation", "global_tilted_irradiance", "cloud_cover", "temperature_2m"];
const REQUEST_BUDGET_MS = 15_000;
const PRIMARY_BUDGET_MS = 8_000;
const HOUR_MS = 3_600_000;

type LiveForecastSource = NonNullable<SolarForecast["source"]>;

class ForecastError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "provider" | "incompatible",
    readonly retryAt?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function rateLimitRetryAt(response: Response, now: Date): number {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  const retryAt = /^\d+$/.test(value) ? now.getTime() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(retryAt) ? retryAt : now.getTime() + 60_000;
}

function requestError(error: unknown, timedOut: boolean): ForecastError {
  const code = error instanceof Error ? asRecord(error.cause).code : null;
  if (timedOut || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return new ForecastError("The connection to Open-Meteo timed out.", "transient", undefined, error);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ForecastError("DNS could not resolve the Open-Meteo hostname.", "transient", undefined, error);
  }
  if (error instanceof SyntaxError) {
    return new ForecastError("Open-Meteo returned an invalid JSON response.", "transient", undefined, error);
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    const detail = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
    return new ForecastError(`Could not connect to Open-Meteo${detail}.`, "transient", undefined, error);
  }
  return new ForecastError(errorMessage(error), "transient", undefined, error);
}

function parseLiveForecast(data: unknown, source: LiveForecastSource, timezone: string | null, now: Date): SolarForecast {
  const root = asRecord(data);
  const forecastTimezone = typeof root.timezone === "string" ? root.timezone : null;
  if (!forecastTimezone) throw new ForecastError("Open-Meteo did not return a forecast timezone.", "transient");
  const timezoneError = adaptiveChargingTimezoneError({ timezone: forecastTimezone }, timezone);
  if (timezoneError) throw new ForecastError(timezoneError, "incompatible");
  const hourly = asRecord(root.hourly);
  if (source === "previous-runs") {
    // The API can return Day 0 with the base field names.
    for (const field of FORECAST_HOUR_FIELDS) {
      hourly[field] = hourly[`${field}_previous_day0`] ?? hourly[field];
    }
  }
  const times = Array.isArray(hourly.time)
    ? hourly.time.map((time: unknown) => typeof time === "string" ? Date.parse(time) : Number.NaN)
    : [];
  const irradiance = hourly.global_tilted_irradiance;
  const lastHour = times.at(-1) ?? Number.NaN;
  const validHours = times.length > 1 && times[0] <= now.getTime() && lastHour > now.getTime()
    && times.every((time, index) => Number.isFinite(time) && (index === 0 || time - times[index - 1] === HOUR_MS));
  if (!validHours || !Array.isArray(irradiance) || irradiance.length !== times.length
      || !irradiance.every((value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new ForecastError("Open-Meteo returned incomplete hourly solar forecast data.", "transient");
  }
  const forecast = parseOpenMeteoForecast({ ...root, hourly }, now);
  const hasUpcomingSunset = forecast.days.some((day) => {
    const sunset = Date.parse(day.sunset ?? "");
    return sunset > now.getTime() && sunset <= lastHour;
  });
  if (!hasUpcomingSunset) throw new ForecastError("Open-Meteo returned no upcoming sunset within the solar forecast.", "transient");
  return { ...forecast, source };
}

export function createAdaptiveForecastService(dependencies: AdaptiveForecastDependencies) {
  async function fetchJson(url: string, fetchImpl: typeof fetch, now: Date, timeoutMs = REQUEST_BUDGET_MS): Promise<unknown> {
    if (dependencies.externalIoDisabled) {
      throw new Error("External HTTP access is disabled in simulated UI development");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ForecastError(
          `Open-Meteo returned HTTP ${response.status}.`,
          response.status >= 500 && response.status <= 599 ? "transient" : "provider",
          response.status === 429 ? rateLimitRetryAt(response, now) : undefined,
        );
      }
      return await response.json();
    } catch (error: unknown) {
      throw error instanceof ForecastError ? error : requestError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  }

  function openMeteoUrl(config: ApplicationConfig, source: keyof typeof OPEN_METEO_ENDPOINTS, now: Date): string {
    const adaptiveCharging = config.adaptiveCharging;
    const fields = source === "previous-runs" ? FORECAST_HOUR_FIELDS.map((field) => `${field}_previous_day0`) : FORECAST_HOUR_FIELDS;
    const params = new URLSearchParams({
      latitude: String(adaptiveCharging.latitude),
      longitude: String(adaptiveCharging.longitude),
      hourly: fields.join(","),
      timezone: "auto",
      tilt: String(adaptiveCharging.panelTiltDegrees),
      azimuth: String(adaptiveCharging.panelAzimuthDegrees),
    });
    if (source === "historical") {
      const end = new Date(now);
      end.setDate(end.getDate() - 1);
      const start = new Date(end);
      start.setDate(start.getDate() - 89);
      params.set("start_date", localDayKey(start));
      params.set("end_date", localDayKey(end));
      params.set("models", "jma_msm");
    } else {
      params.set("forecast_days", "3");
      params.set("daily", "sunrise,sunset");
      if (source === "previous-runs") {
        params.set("past_days", "0");
        params.set("models", "jma_msm");
      }
    }
    return `${OPEN_METEO_ENDPOINTS[source]}?${params}`;
  }

  async function fetchLiveForecast(config: ApplicationConfig, fetchImpl: typeof fetch, now: Date): Promise<SolarForecast> {
    const deadline = performance.now() + REQUEST_BUDGET_MS;
    try {
      const primary = await fetchJson(openMeteoUrl(config, "jma", now), fetchImpl, now, PRIMARY_BUDGET_MS);
      return parseLiveForecast(primary, "jma", dependencies.timezone, now);
    } catch (primaryError: unknown) {
      if (!(primaryError instanceof ForecastError) || primaryError.kind !== "transient") throw primaryError;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw primaryError;
      try {
        const fallback = await fetchJson(openMeteoUrl(config, "previous-runs", now), fetchImpl, now, remaining);
        return parseLiveForecast(fallback, "previous-runs", dependencies.timezone, now);
      } catch (fallbackError: unknown) {
        throw new ForecastError(
          `JMA forecast failed (${primaryError.message.replace(/\.$/, "")}). Previous Runs failed (${errorMessage(fallbackError).replace(/\.$/, "")}).`,
          fallbackError instanceof ForecastError && fallbackError.kind === "incompatible" ? "incompatible" : "provider",
          fallbackError instanceof ForecastError ? fallbackError.retryAt : undefined,
          fallbackError,
        );
      }
    }
  }

  async function refresh(
    config: ApplicationConfig,
    { fetchImpl = fetch, now = new Date(), forceHistorical = false }: RefreshOptions = {},
  ): Promise<AdaptiveChargingState> {
    const initialState = await dependencies.readState();
    if (Number(initialState.lastForecastError?.retryAt) > now.getTime()) return initialState;
    let forecast: SolarForecast;
    try {
      forecast = await fetchLiveForecast(config, fetchImpl, now);
      dependencies.history.recordForecast(forecast);
    } catch (error: unknown) {
      const message = errorMessage(error);
      const state = await dependencies.readState();
      const prior = state.lastForecastError;
      const priorRetries = Number(prior?.retryCount) || 0;
      state.lastForecastError = {
        at: now.toISOString(), error: message,
        kind: error instanceof ForecastError && error.kind === "incompatible" ? "incompatible" : "provider",
        retryCount: priorRetries + 1,
        ...(error instanceof ForecastError && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
      };
      appendAdaptiveChargingLog(state, `Forecast refresh failed: ${message}`, "error", now);
      return dependencies.writeState(state);
    }
    // Re-read after the network wait. Forecast refresh owns only forecast
    // fields; carrying its pre-fetch snapshot forward could erase a manual
    // pause, Away update, or active charge transition.
    const state = await dependencies.readState();
    state.forecast = forecast;
    state.lastForecastError = null;
    const source = forecast.source === "previous-runs" ? "Open-Meteo Previous Runs" : "Open-Meteo JMA";
    appendAdaptiveChargingLog(state, `${source} forecast refreshed for ${forecast.timezone}`, "forecast", now);
    const historicalAge = now.getTime() - new Date(initialState.historicalWeatherFetchedAt ?? 0).getTime();
    if (forceHistorical || !Number.isFinite(historicalAge) || historicalAge > MILLISECONDS_PER_DAY) {
      try {
        const historical = parseOpenMeteoForecast(
          await fetchJson(openMeteoUrl(config, "historical", now), fetchImpl, now),
          now,
        );
        dependencies.history.recordWeather(historical.hours);
        state.historicalWeatherFetchedAt = now.toISOString();
      } catch (error: unknown) {
        appendAdaptiveChargingLog(
          state,
          `Historical weather refresh failed; using demand recency fallback: ${errorMessage(error)}`,
          "warning",
          now,
        );
      }
    }
    if (dependencies.history.isReady() && state.forecast) {
      try {
        dependencies.history.settleSolarForecastOutcomes(now);
        const samples = await dependencies.readHistory(now);
        const calibration = learnedSolarFactor(samples, dependencies.history.historicalWeather(), config);
        const accuracy = dependencies.history.solarForecastAccuracy();
        dependencies.history.recordSolarForecastIssues(
          dailySolarForecastIssues(state.forecast, config, calibration, accuracy),
        );
      } catch (error: unknown) {
        appendAdaptiveChargingLog(
          state,
          `Solar forecast outcome recording failed: ${errorMessage(error)}`,
          "warning",
          now,
        );
      }
    }
    if (dependencies.readConfig) {
      const currentConfig = await dependencies.readConfig();
      const forecastInputs = (value: ApplicationConfig) => [value.adaptiveCharging.latitude, value.adaptiveCharging.longitude,
        value.adaptiveCharging.panelTiltDegrees, value.adaptiveCharging.panelAzimuthDegrees];
      if (JSON.stringify(forecastInputs(currentConfig)) !== JSON.stringify(forecastInputs(config))) return dependencies.readState();
    }
    return dependencies.writeState(state);
  }

  function accuracy(now = new Date()): ForecastAccuracy {
    const fallback: ForecastAccuracy = {
      learned: false,
      sampleCount: 0,
      measuredFactor: null,
      factor: 1,
      meanAbsolutePercentageError: null,
      outcomes: [],
    };
    if (!dependencies.history.isReady()) return fallback;
    try {
      dependencies.history.settleSolarForecastOutcomes(now);
      return dependencies.history.solarForecastAccuracy();
    } catch (error: unknown) {
      dependencies.logError("solar-forecast-accuracy", error);
      return { ...fallback, error: errorMessage(error) };
    }
  }

  return { accuracy, refresh };
}
