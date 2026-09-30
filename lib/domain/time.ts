const AWAY_RETURN_BUFFER_MS = 30 * 60_000;

export interface AwayPeriod {
  from?: unknown;
  until?: unknown;
}

export function localDayKey(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function halfHourIndex(value: Date | string | number): number {
  const date = value instanceof Date ? value : new Date(value);
  return date.getHours() * 2 + (date.getMinutes() >= 30 ? 1 : 0);
}

export function awayPeriodContains(period: AwayPeriod, timeMs: number): boolean {
  const startMs = new Date(String(period.from ?? "")).getTime();
  const untilMs = new Date(String(period.until ?? "")).getTime();
  return Number.isFinite(startMs) && Number.isFinite(untilMs) && timeMs >= startMs && timeMs < untilMs;
}

export function awayPeriodForecastContains(period: AwayPeriod, timeMs: number): boolean {
  const startMs = new Date(String(period.from ?? "")).getTime();
  const untilMs = new Date(String(period.until ?? "")).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs) return false;
  const returnBufferMs = Math.min(AWAY_RETURN_BUFFER_MS, (untilMs - startMs) / 4);
  return timeMs >= startMs && timeMs < untilMs - returnBufferMs;
}

export function isAwayAt(
  timeMs: number,
  periods: readonly AwayPeriod[] = [],
  { forecast = false }: { forecast?: boolean } = {},
): boolean {
  const contains = forecast ? awayPeriodForecastContains : awayPeriodContains;
  return periods.some((period) => contains(period, timeMs));
}

export function awayPeriodRange(period: AwayPeriod): { startMs: number; untilMs: number } {
  return {
    startMs: new Date(String(period.from ?? "")).getTime(),
    untilMs: new Date(String(period.until ?? "")).getTime(),
  };
}

export function awayPeriodsOverlap(left: AwayPeriod, right: AwayPeriod): boolean {
  const leftRange = awayPeriodRange(left);
  const rightRange = awayPeriodRange(right);
  return leftRange.startMs < rightRange.untilMs && leftRange.untilMs > rightRange.startMs;
}
