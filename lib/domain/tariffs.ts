import type { ApplicationConfig, RateBand } from "../contracts/configuration.js";
import { DEFAULT_CONFIG, configNumber, minutesOfDay, normalizeRateBands } from "./configuration.js";

type TariffConfig = Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh">;

export interface DiscountedBandOccurrence {
  band: RateBand;
  start: string;
  end: string;
  key: string;
}

export function rateForTimestamp(
  rateBands: unknown = DEFAULT_CONFIG.rateBands,
  timestamp: Date | string | number = new Date(),
  fallbackRate: unknown = null,
): RateBand {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const minute = date.getHours() * 60 + date.getMinutes();
  const bands = normalizeRateBands({ rateBands });
  const match = bands.find((band) => {
    const start = minutesOfDay(band.start);
    const end = minutesOfDay(band.end);
    if (start === null || end === null) return false;
    if (start === end) return true;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
  if (match) return match;
  if (fallbackRate !== null && fallbackRate !== undefined) {
    return {
      start: "00:00",
      end: "00:00",
      yenPerKwh: configNumber(fallbackRate, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000),
      label: "Standard",
    };
  }
  return bands[0] ?? DEFAULT_CONFIG.rateBands[0]!;
}

export function maxDailyRate(rateBands: unknown = DEFAULT_CONFIG.rateBands, fallbackRate: unknown = null): number {
  const rates = normalizeRateBands({ rateBands }).map((band) => band.yenPerKwh);
  if (fallbackRate !== null && fallbackRate !== undefined) {
    rates.push(configNumber(fallbackRate, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000));
  }
  return Math.max(...rates);
}

export function matchesDailyBand(date: Date, band: RateBand): boolean {
  const start = minutesOfDay(band.start);
  const end = minutesOfDay(band.end);
  if (start === null || end === null) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function explicitDiscountedBand(config: TariffConfig, date: Date): RateBand | null {
  return config.rateBands
    .filter((band) => band.yenPerKwh < config.standardRateYenPerKwh)
    .find((band) => matchesDailyBand(date, band)) ?? null;
}

export function discountedBandOccurrenceForDay(
  band: RateBand,
  day: Date = new Date(),
): DiscountedBandOccurrence | null {
  const startMinute = minutesOfDay(band.start);
  const endMinute = minutesOfDay(band.end);
  if (startMinute === null || endMinute === null) return null;
  const start = new Date(day);
  start.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  const end = new Date(day);
  end.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
  if (startMinute === endMinute || endMinute < startMinute) end.setDate(end.getDate() + 1);
  const key = JSON.stringify([start.toISOString(), end.toISOString(), band.yenPerKwh, band.label || null]);
  return { band, start: start.toISOString(), end: end.toISOString(), key };
}

export function discountedBandOccurrences(
  config: TariffConfig,
  now: Date = new Date(),
  horizonMs = 48 * 60 * 60_000,
): DiscountedBandOccurrence[] {
  const discountedBands = config.rateBands.filter((band) => band.yenPerKwh < config.standardRateYenPerKwh);
  const horizonEnd = now.getTime() + horizonMs;
  const occurrences: DiscountedBandOccurrence[] = [];
  for (let dayOffset = -1; dayOffset <= 3; dayOffset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    for (const band of discountedBands) {
      const occurrence = discountedBandOccurrenceForDay(band, day);
      if (!occurrence) continue;
      const startMs = new Date(occurrence.start).getTime();
      const endMs = new Date(occurrence.end).getTime();
      if (endMs > now.getTime() && startMs <= horizonEnd) occurrences.push(occurrence);
    }
  }
  return occurrences.sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
}

export function discountedBandOccurrence(config: TariffConfig, now: Date = new Date()): DiscountedBandOccurrence | null {
  const time = now.getTime();
  return discountedBandOccurrences(config, now)
    .find((occurrence) => new Date(occurrence.start).getTime() <= time && time < new Date(occurrence.end).getTime()) ?? null;
}

/**
 * The planning horizon for a sunset: normally the sunset itself, but extended to
 * the end of the discounted window that spans sunset so a cheap window running
 * past sunset is not truncated.
 */
export function discountedHorizonEndMs(config: TariffConfig, sunsetTimestamp: number): number {
  const occurrence = discountedBandOccurrence(config, new Date(sunsetTimestamp - 1));
  const endMs = occurrence ? new Date(occurrence.end).getTime() : Number.NaN;
  return Number.isFinite(endMs) && endMs > sunsetTimestamp ? endMs : sunsetTimestamp;
}
