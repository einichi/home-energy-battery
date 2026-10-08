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
import { errorMessage } from "../domain/values.js";

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
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  readHistory(now?: Date): Promise<Array<HistorySample & { timestamp: string }>>;
  logError(label: string, error: unknown): void;
}

interface RefreshOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  forceHistorical?: boolean;
}

export function createAdaptiveForecastService(dependencies: AdaptiveForecastDependencies) {
  async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
    if (dependencies.externalIoDisabled) {
      throw new Error("External HTTP access is disabled in simulated UI development");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function openMeteoUrl(config: ApplicationConfig, historical = false, now = new Date()): string {
    const adaptiveCharging = config.adaptiveCharging;
    const endpoint = historical
      ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
      : "https://api.open-meteo.com/v1/jma";
    const params = new URLSearchParams({
      latitude: String(adaptiveCharging.latitude),
      longitude: String(adaptiveCharging.longitude),
      hourly: "shortwave_radiation,global_tilted_irradiance,cloud_cover,temperature_2m",
      timezone: "auto",
      tilt: String(adaptiveCharging.panelTiltDegrees),
      azimuth: String(adaptiveCharging.panelAzimuthDegrees),
    });
    if (historical) {
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
    }
    return `${endpoint}?${params}`;
  }

  async function refresh(
    config: ApplicationConfig,
    { fetchImpl = fetch, now = new Date(), forceHistorical = false }: RefreshOptions = {},
  ): Promise<AdaptiveChargingState> {
    const state = await dependencies.readState();
    try {
      const forecast = parseOpenMeteoForecast(
        await fetchJson(openMeteoUrl(config, false, now), fetchImpl),
        now,
      );
      const timezoneError = adaptiveChargingTimezoneError(forecast, dependencies.timezone);
      if (timezoneError) throw new Error(timezoneError);
      state.forecast = forecast;
      state.lastForecastError = null;
      appendAdaptiveChargingLog(
        state,
        `Open-Meteo forecast refreshed for ${forecast.timezone || "local time"}`,
        "forecast",
        now,
      );
      dependencies.history.recordForecast(forecast);
    } catch (error: unknown) {
      const message = errorMessage(error);
      state.lastForecastError = { at: now.toISOString(), error: message };
      appendAdaptiveChargingLog(state, `Forecast refresh failed: ${message}`, "error", now);
      return dependencies.writeState(state);
    }
    const historicalAge = now.getTime() - new Date(state.historicalWeatherFetchedAt ?? 0).getTime();
    if (forceHistorical || !Number.isFinite(historicalAge) || historicalAge > 24 * 60 * 60_000) {
      try {
        const historical = parseOpenMeteoForecast(
          await fetchJson(openMeteoUrl(config, true, now), fetchImpl),
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
