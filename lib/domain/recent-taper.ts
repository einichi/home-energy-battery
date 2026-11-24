import { MILLISECONDS_PER_DAY } from "./time.js";

const TAPER_LOOKBACK_MS = 14 * MILLISECONDS_PER_DAY;
const TAPER_MIN_COVERAGE_MS = 2 * 60_000;
const TAPER_MAX_SAMPLE_GAP_MS = 2 * 60_000;
const TAPER_SLOW_RATE_FRACTION = 0.9;

export interface ChargeCurveSample {
  at?: string;
  day?: string;
  sessionId?: string;
  socPercent?: unknown;
  batteryChargingW?: unknown;
}

export function recentTaperWatts(samples: readonly ChargeCurveSample[], activeWatts: number, now: Date): number | null {
  const endMs = now.getTime();
  const sessions = new Map<string, Array<{ time: number; watts: number }>>();
  for (const sample of samples) {
    const time = Date.parse(sample.at ?? "");
    if (!sample.sessionId || !Number.isFinite(time) || time < endMs - TAPER_LOOKBACK_MS || time > endMs
      || Number(sample.socPercent) >= 100) continue;
    const readings = sessions.get(sample.sessionId) ?? [];
    readings.push({ time, watts: Number(sample.batteryChargingW) });
    sessions.set(sample.sessionId, readings);
  }

  const rates: Array<{ end: number; watts: number }> = [];
  for (const readings of sessions.values()) {
    readings.sort((left, right) => left.time - right.time);
    let coverageMs = 0;
    let wattMs = 0;
    for (let index = 1; index < readings.length; index++) {
      const previous = readings[index - 1]!;
      const current = readings[index]!;
      const elapsedMs = current.time - previous.time;
      if (elapsedMs > TAPER_MAX_SAMPLE_GAP_MS) continue;
      coverageMs += elapsedMs;
      wattMs += elapsedMs * (previous.watts + current.watts) / 2;
    }
    if (coverageMs >= TAPER_MIN_COVERAGE_MS) {
      rates.push({ end: readings.at(-1)!.time, watts: wattMs / coverageMs });
    }
  }
  rates.sort((left, right) => right.end - left.end);
  if (rates.length < 2) return null;
  // Reserve only the slowdown both recent sessions support.
  const fasterWatts = Math.max(rates[0]!.watts, rates[1]!.watts);
  return fasterWatts <= activeWatts * TAPER_SLOW_RATE_FRACTION ? fasterWatts : null;
}
