import type { ApplicationConfig } from "../contracts/configuration.js";
import { median } from "./statistics.js";
import { localDayKey } from "./time.js";
import { explicitDiscountedBand } from "./tariffs.js";

type DateInput = Date | string | number;

interface SolarConfiguration {
  adaptiveCharging: {
    arrayPeakKw?: unknown;
    systemLossPercent?: unknown;
    forecastMarginPercent?: unknown;
  };
}

interface SolarSettings {
  arrayPeakKw?: unknown;
  systemLossPercent?: unknown;
}

export interface SolarForecastHour {
  time?: string;
  timestamp: string;
  shortwaveRadiationWm2?: number;
  tiltedIrradianceWm2: number;
  cloudCoverPercent?: number;
  temperatureC?: number;
}

export interface SolarForecastDay {
  date: string;
  sunrise: string | null;
  sunset: string | null;
}

interface SolarForecastInput {
  fetchedAt?: string;
  timezone?: string | null;
  hours?: SolarForecastHour[];
  days?: Array<Pick<SolarForecastDay, "date"> & Partial<Pick<SolarForecastDay, "sunrise" | "sunset">>>;
}

export interface SolarForecast {
  fetchedAt: string;
  timezone: string | null;
  utcOffsetSeconds: number | null;
  latitude: number | null;
  longitude: number | null;
  hours: SolarForecastHour[];
  days: SolarForecastDay[];
}

export interface SolarCalibration {
  factor: number | null;
  groupFactors: Record<string, number>;
  validDays: number;
  learned: boolean;
}

export interface SolarForecastAccuracy {
  learned?: boolean;
  factor?: unknown;
}

export interface DailySolarForecastIssue {
  targetDate: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  rawPredictedKwh: number;
  biasFactor: number;
  predictedKwh: number;
  planningKwh: number;
  marginPercent: number;
  calibration: Pick<SolarCalibration, "learned" | "validDays" | "factor">;
}

interface SolarHistorySample {
  timestamp: DateInput;
  solarPowerW?: unknown;
}

interface WeatherHourInput {
  timestamp?: DateInput;
  time?: DateInput;
  tiltedIrradianceWm2?: unknown;
  temperatureC?: unknown;
}

interface CalibrationDay {
  factors: number[];
  groups: Map<string, number[]>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function optionalNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function indexedNumber(value: unknown, index: number): number {
  if (!Array.isArray(value)) return 0;
  return Number(value[index]) || 0;
}

function indexedOptionalNumber(value: unknown, index: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  return optionalNumber(value[index]) ?? undefined;
}

function indexedOptionalString(value: unknown, index: number): string | null {
  if (!Array.isArray(value)) return null;
  return optionalString(value[index]);
}

export function solarPowerFromIrradiance(
  irradianceWm2: unknown,
  config: SolarConfiguration | SolarSettings,
  learnedFactor: unknown = null,
): number {
  const irradiance = Math.max(0, Number(irradianceWm2) || 0);
  const adaptiveCharging = "adaptiveCharging" in config ? config.adaptiveCharging : config;
  const arrayPeakKw = Math.max(0, Number(adaptiveCharging.arrayPeakKw) || 0);
  const peakW = arrayPeakKw * 1000;
  const fallbackFactor = arrayPeakKw
    * (1 - Math.max(0, Number(adaptiveCharging.systemLossPercent) || 0) / 100);
  const factor = Number.isFinite(Number(learnedFactor)) && Number(learnedFactor) > 0
    ? Number(learnedFactor)
    : fallbackFactor;
  return Math.min(peakW, irradiance * factor);
}

export function applySolarForecastBias(
  solarW: unknown,
  peakW: unknown,
  accuracy: SolarForecastAccuracy = {},
): number {
  const value = Math.max(0, Number(solarW) || 0);
  const maximum = Math.max(0, Number(peakW) || 0);
  const factor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  return Math.min(maximum, value * factor);
}

export function parseOpenMeteoForecast(data: unknown, fetchedAt: DateInput = new Date()): SolarForecast {
  const root = recordValue(data);
  const hourly = recordValue(root.hourly);
  const hours = stringArray(hourly.time).map((time, index) => ({
    time,
    timestamp: new Date(time).toISOString(),
    shortwaveRadiationWm2: indexedNumber(hourly.shortwave_radiation, index),
    tiltedIrradianceWm2: indexedNumber(hourly.global_tilted_irradiance, index),
    cloudCoverPercent: indexedOptionalNumber(hourly.cloud_cover, index),
    temperatureC: indexedOptionalNumber(hourly.temperature_2m, index),
  }));
  const daily = recordValue(root.daily);
  const days = stringArray(daily.time).map((date, index) => ({
    date,
    sunrise: indexedOptionalString(daily.sunrise, index),
    sunset: indexedOptionalString(daily.sunset, index),
  }));
  return {
    fetchedAt: (fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt)).toISOString(),
    timezone: optionalString(root.timezone),
    utcOffsetSeconds: optionalNumber(root.utc_offset_seconds),
    latitude: optionalNumber(root.latitude),
    longitude: optionalNumber(root.longitude),
    hours,
    days,
  };
}

export function temperatureByDayFromWeather(hours: readonly WeatherHourInput[] = []): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const hour of hours) {
    const value = Number(hour.temperatureC);
    if (!Number.isFinite(value)) continue;
    const key = String(hour.time ?? hour.timestamp).slice(0, 10);
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [
    key,
    values.reduce((sum, value) => sum + value, 0) / values.length,
  ]));
}

export function solarCalibrationGroup(date: DateInput): string {
  const value = date instanceof Date ? date : new Date(date);
  const season = Math.floor(value.getMonth() / 3);
  const solarHour = value.getHours() < 10 ? "morning" : value.getHours() < 14 ? "midday" : "afternoon";
  return `${season}:${solarHour}`;
}

export function learnedSolarFactor(
  samples: readonly SolarHistorySample[],
  historicalWeather: readonly WeatherHourInput[],
  config: SolarConfiguration,
): SolarCalibration {
  const weatherByHour = new Map<number, WeatherHourInput>(historicalWeather.map((hour) => [
    Math.floor(new Date(hour.timestamp ?? hour.time ?? Number.NaN).getTime() / 3_600_000),
    hour,
  ]));
  const daily = new Map<string, CalibrationDay>();
  for (const sample of samples) {
    const solarW = Number(sample.solarPowerW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(solarW) || Number.isNaN(time.getTime())) continue;
    const weather = weatherByHour.get(Math.floor(time.getTime() / 3_600_000) + 1);
    const irradiance = Number(weather?.tiltedIrradianceWm2);
    if (!Number.isFinite(irradiance) || irradiance < 50) continue;
    const key = localDayKey(time);
    const row = daily.get(key) ?? { factors: [], groups: new Map<string, number[]>() };
    row.factors.push(solarW / irradiance);
    const group = solarCalibrationGroup(time);
    const grouped = row.groups.get(group) ?? [];
    grouped.push(solarW / irradiance);
    row.groups.set(group, grouped);
    daily.set(key, row);
  }
  const factors = [...daily.values()]
    .map((day) => median(day.factors))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fallback = Number(config.adaptiveCharging.arrayPeakKw)
    * (1 - Number(config.adaptiveCharging.systemLossPercent) / 100);
  const learned = factors.length >= 7;
  const groupNames = new Set([...daily.values()].flatMap((day) => [...day.groups.keys()]));
  const groupFactors: Record<string, number> = {};
  for (const group of groupNames) {
    const values = [...daily.values()]
      .map((day) => median(day.groups.get(group) ?? []))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const factor = median(values.slice(-30));
    if (learned && values.length >= 4 && factor !== null) groupFactors[group] = factor;
  }
  return {
    factor: learned ? median(factors.slice(-30)) : fallback,
    groupFactors,
    validDays: factors.length,
    learned,
  };
}

export function localDayRange(dayKey: string): { start: Date; end: Date } | null {
  const start = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export function dailySolarForecastIssues(
  forecast: SolarForecastInput | null | undefined,
  config: SolarConfiguration,
  calibration: SolarCalibration,
  accuracy: SolarForecastAccuracy = {},
): DailySolarForecastIssue[] {
  const issuedAt = forecast?.fetchedAt;
  if (!issuedAt || Number.isNaN(new Date(issuedAt).getTime())) return [];
  const biasFactor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  const marginPercent = Math.max(0, Number(config.adaptiveCharging.forecastMarginPercent) || 0);
  const marginFactor = Math.max(0, 1 - marginPercent / 100);
  const peakW = Math.max(0, Number(config.adaptiveCharging.arrayPeakKw) || 0) * 1000;
  const targetDates = new Set([
    ...(forecast.days ?? []).map((day) => day.date),
    ...(forecast.hours ?? []).map((hour) => localDayKey(hour.timestamp ?? hour.time ?? Number.NaN)),
  ].filter((value): value is string => Boolean(value)));
  const issues: DailySolarForecastIssue[] = [];
  for (const targetDate of [...targetDates].sort()) {
    const range = localDayRange(targetDate);
    if (!range) continue;
    let rawPredictedKwh = 0;
    let predictedKwh = 0;
    for (const hour of forecast.hours ?? []) {
      const timestamp = new Date(hour.timestamp ?? hour.time ?? Number.NaN);
      if (Number.isNaN(timestamp.getTime()) || localDayKey(timestamp) !== targetDate) continue;
      const factor = calibration.groupFactors[solarCalibrationGroup(timestamp)] ?? calibration.factor;
      const rawW = solarPowerFromIrradiance(hour.tiltedIrradianceWm2, config, factor);
      rawPredictedKwh += rawW / 1000;
      predictedKwh += applySolarForecastBias(rawW, peakW, {
        learned: accuracy.learned,
        factor: biasFactor,
      }) / 1000;
    }
    issues.push({
      targetDate,
      issuedAt,
      periodStart: range.start.toISOString(),
      periodEnd: range.end.toISOString(),
      rawPredictedKwh,
      biasFactor,
      predictedKwh,
      planningKwh: predictedKwh * marginFactor,
      marginPercent,
      calibration: {
        learned: calibration.learned,
        validDays: calibration.validDays,
        factor: calibration.factor,
      },
    });
  }
  return issues;
}

export function forecastHourForInterval(
  forecast: Pick<SolarForecastInput, "hours"> | null | undefined,
  start: DateInput,
  end: DateInput,
): SolarForecastHour | null {
  const midpoint = (new Date(start).getTime() + new Date(end).getTime()) / 2;
  const target = Math.ceil(midpoint / 3_600_000) * 3_600_000;
  let best: { hour: SolarForecastHour; distance: number } | null = null;
  for (const hour of forecast?.hours ?? []) {
    const distance = Math.abs(new Date(hour.timestamp).getTime() - target);
    if (!best || distance < best.distance) best = { hour, distance };
  }
  return best?.hour ?? null;
}

export function nextPlanningBoundary(time: DateInput, end: DateInput, intervalMinutes = 30): number {
  const current = new Date(time);
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(endMs)) return Number.NaN;
  const next = new Date(current);
  next.setSeconds(0, 0);
  const elapsedInHour = next.getMinutes();
  const nextMinute = (Math.floor(elapsedInHour / intervalMinutes) + 1) * intervalMinutes;
  if (nextMinute >= 60) next.setHours(next.getHours() + 1, 0, 0, 0);
  else next.setMinutes(nextMinute, 0, 0);
  return Math.min(endMs, next.getTime());
}

export function planningSunsetWithDiscountedWindow(
  config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh">,
  forecast: Pick<SolarForecastInput, "days"> | null | undefined,
  now: Date = new Date(),
): (Pick<SolarForecastDay, "date"> & Partial<Pick<SolarForecastDay, "sunrise" | "sunset">> & { timestamp: number }) | null {
  const startMs = now.getTime();
  return (forecast?.days ?? [])
    .map((day) => ({ ...day, timestamp: new Date(day.sunset ?? Number.NaN).getTime() }))
    .filter((day) => Number.isFinite(day.timestamp) && day.timestamp > startMs)
    .sort((left, right) => left.timestamp - right.timestamp)
    .find((day) => {
      for (let time = startMs; time < day.timestamp;) {
        if (explicitDiscountedBand(config, new Date(time))) return true;
        time = nextPlanningBoundary(time, day.timestamp);
      }
      return false;
    }) ?? null;
}

export function adaptiveChargingTimezoneError(
  forecast: Pick<SolarForecast, "timezone"> | null | undefined,
  configuredTimezone: string | null | undefined,
): string | null {
  if (!configuredTimezone) return "container TZ must be configured before rate-band times can be aligned";
  if (!forecast?.timezone) return "forecast timezone is unavailable";
  return configuredTimezone === forecast.timezone
    ? null
    : `container timezone ${configuredTimezone} does not match forecast timezone ${forecast.timezone}`;
}
