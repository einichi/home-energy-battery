import type { AwayPeriod } from "./time.js";
import { awayPeriodContains, MILLISECONDS_PER_DAY } from "./time.js";
import { finiteNumberOrNull } from "./numbers.js";

export const AWAY_FUEL_CELL_VERSION = 1;
const MAX_RAW_GAP_MS = 90_000;
const MAX_READING_AGE_MS = 45 * 60_000;
const SUSTAINED_GENERATION_MS = 30 * 60_000;
// Deliberately low: even modest output invalidates a confident off assumption.
export const AWAY_FUEL_CELL_GENERATION_THRESHOLD_W = 10;

export type AwayFuelCellRegime = "provisional-off" | "off-supported" | "normal-model" | "uncertain";
export type AwayFuelCellReason = "observing" | "quiet-cycle" | "sustained-generation" | "generation-detected" | "insufficient-coverage" | "stale-readings";
interface EvidenceInterval {
  startMs: number;
  endMs: number;
  coverage: number;
  generating: boolean;
}

export interface AwayFuelCellSummary {
  periodId: string;
  from: string;
  until: string;
  regime: AwayFuelCellRegime;
  reason: AwayFuelCellReason;
  observationFrom: string;
  coveragePercent: number;
  lastReadingAt: string | null;
  lastGeneratingAt: string | null;
  nextReviewAt: string;
  headroomAllowanceRetained: boolean;
}

export interface AwayFuelCellEvidence extends AwayFuelCellSummary {
  version: number;
  deviceKey: string;
  evaluatedAt: string;
  intervals: EvidenceInterval[];
}

export interface AwayFuelCellConfig {
  fuelCellEnabled?: boolean;
  fuelCellPrimaryHost?: string;
  fuelCellHosts?: string[];
  fuelCellProxyHosts?: string[];
}

interface FuelCellEvidenceSample {
  timestamp?: string;
  rollupStart?: string;
  rollupEnd?: string;
  fuelCellPowerW?: unknown;
  fuelCellGenerationState?: unknown;
  fuelCellSourceHost?: unknown;
  fuelCellSourceHosts?: unknown;
  expectedIntervalSeconds?: unknown;
  intervalAveragePowerW?: { fuelCellPowerW?: unknown; branchDemandW?: unknown };
  powerCoverageSeconds?: { fuelCellPowerW?: unknown; branchDemandW?: unknown };
}

export function awayFuelCellDeviceKey(config: AwayFuelCellConfig): string | null {
  if (config.fuelCellEnabled === false) return null;
  return config.fuelCellPrimaryHost || config.fuelCellHosts?.[0] || null;
}

export function awayFuelCellSummary(evidence: AwayFuelCellEvidence): AwayFuelCellSummary {
  return {
    periodId: evidence.periodId, from: evidence.from, until: evidence.until,
    regime: evidence.regime, reason: evidence.reason, observationFrom: evidence.observationFrom,
    coveragePercent: evidence.coveragePercent, lastReadingAt: evidence.lastReadingAt,
    lastGeneratingAt: evidence.lastGeneratingAt, nextReviewAt: evidence.nextReviewAt,
    headroomAllowanceRetained: evidence.regime !== "off-supported",
  };
}

/** Validate durable evidence; unknown/older versions are recomputed from history. */
export function cleanAwayFuelCellEvidence(input: unknown): AwayFuelCellEvidence | null {
  if (!input || typeof input !== "object") return null;
  const value = input as AwayFuelCellEvidence;
  if (value.version !== AWAY_FUEL_CELL_VERSION || typeof value.deviceKey !== "string" || !value.deviceKey
    || typeof value.periodId !== "string" || !Number.isFinite(Date.parse(value.from))
    || !Number.isFinite(Date.parse(value.until)) || !Number.isFinite(Date.parse(value.observationFrom))
    || !Number.isFinite(Date.parse(value.evaluatedAt))
    || !["provisional-off", "off-supported", "normal-model", "uncertain"].includes(value.regime)
    || !["observing", "quiet-cycle", "sustained-generation", "generation-detected", "insufficient-coverage", "stale-readings"].includes(value.reason)) return null;
  const evaluatedAt = Date.parse(value.evaluatedAt);
  if (Date.parse(value.until) <= Date.parse(value.from) || Date.parse(value.observationFrom) < Date.parse(value.from)
    || Date.parse(value.observationFrom) > evaluatedAt) return null;
  return {
    ...value,
    coveragePercent: Math.max(0, Math.min(100, finiteNumberOrNull(value.coveragePercent) ?? 0)),
    lastReadingAt: typeof value.lastReadingAt === "string" && Date.parse(value.lastReadingAt) <= evaluatedAt ? value.lastReadingAt : null,
    lastGeneratingAt: typeof value.lastGeneratingAt === "string" && Date.parse(value.lastGeneratingAt) <= evaluatedAt ? value.lastGeneratingAt : null,
    // Preserve the applied policy marker so observation can queue a refresh
    // when an upgrade changes the headroom policy for an existing quiet trip.
    headroomAllowanceRetained: typeof value.headroomAllowanceRetained === "boolean"
      ? value.headroomAllowanceRetained : value.regime !== "off-supported",
    intervals: (Array.isArray(value.intervals) ? value.intervals : []).filter((entry) => entry
      && Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.endMs > entry.startMs
      && entry.endMs <= evaluatedAt
      && Number.isFinite(entry.coverage) && entry.coverage > 0 && entry.coverage <= 1
      && typeof entry.generating === "boolean"),
  };
}

/** Union overlapping measurements. Coverage is never added twice; positive power wins conflicts. */
function unionIntervals(intervals: EvidenceInterval[], startMs: number, endMs: number): EvidenceInterval[] {
  const events = new Map<number, Array<{ id: number; add: boolean }>>();
  intervals.forEach((entry, id) => {
    const start = Math.max(startMs, entry.startMs);
    const end = Math.min(endMs, entry.endMs);
    if (end <= start) return;
    events.set(start, [...(events.get(start) ?? []), { id, add: true }]);
    events.set(end, [...(events.get(end) ?? []), { id, add: false }]);
  });
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Map<number, EvidenceInterval>();
  const result: EvidenceInterval[] = [];
  times.forEach((at, index) => {
    for (const event of events.get(at)!) {
      if (event.add) active.set(event.id, intervals[event.id]!);
      else active.delete(event.id);
    }
    const end = times[index + 1];
    if (end === undefined || !active.size) return;
    const entries = [...active.values()];
    const generating = entries.some((entry) => entry.generating);
    const coverage = Math.max(...entries.map((entry) => entry.coverage));
    const prior = result.at(-1);
    if (prior?.endMs === at && prior.generating === generating && prior.coverage === coverage) prior.endMs = end;
    else result.push({ startMs: at, endMs: end, coverage, generating });
  });
  return result;
}

/** Pure, rolling 24-hour inference. All evidence must have been available at now. */
export function inferAwayFuelCell(
  period: AwayPeriod & { id?: string },
  deviceKey: string,
  samples: readonly FuelCellEvidenceSample[],
  now: Date,
  previous: AwayFuelCellEvidence | null = null,
  sourceHosts: readonly string[] = [deviceKey],
): AwayFuelCellEvidence {
  const nowMs = now.getTime();
  const fromMs = Date.parse(String(period.from));
  const untilMs = Date.parse(String(period.until));
  const periodId = period.id ?? String(period.from);
  const prior = cleanAwayFuelCellEvidence(previous);
  const same = prior?.periodId === periodId && prior.from === period.from && prior.deviceKey === deviceKey
    && Date.parse(prior.evaluatedAt) <= nowMs;
  // A device replacement during a trip starts a fresh observation window.
  const observationStart = same ? Date.parse(prior.observationFrom)
    : prior?.periodId === periodId && prior.from === period.from ? nowMs : fromMs;
  const windowStart = Math.max(observationStart, nowMs - MILLISECONDS_PER_DAY);
  const windowEnd = Math.min(nowMs, untilMs);
  const intervals = same ? [...prior.intervals] : [];
  let lastReading = same && prior.lastReadingAt ? Date.parse(prior.lastReadingAt) : null;
  let lastGenerating = same && prior.lastGeneratingAt ? Date.parse(prior.lastGeneratingAt) : null;
  let lastConflictingReading: number | null = null;
  const readings = samples.flatMap((sample) => {
    const at = Date.parse(sample.timestamp ?? "");
    const rollup = sample.rollupStart !== undefined || sample.rollupEnd !== undefined;
    const start = rollup ? Date.parse(sample.rollupStart ?? "") : at;
    const end = rollup ? Date.parse(sample.rollupEnd ?? "") : at;
    const watts = finiteNumberOrNull(sample.intervalAveragePowerW?.fuelCellPowerW ?? sample.fuelCellPowerW);
    const rollupSources = sample.fuelCellSourceHosts && typeof sample.fuelCellSourceHosts === "object"
      ? Object.keys(sample.fuelCellSourceHosts) : [];
    if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)
      || at > nowMs || end > nowMs || end < windowStart || start > windowEnd
      || watts === null || watts < 0
      || (sample.fuelCellSourceHost && !sourceHosts.includes(String(sample.fuelCellSourceHost)))
      || rollupSources.some((host) => !sourceHosts.includes(host))) return [];
    // A zero reading while the appliance reports an active transition is not evidence of being off.
    const generating = watts > AWAY_FUEL_CELL_GENERATION_THRESHOLD_W;
    const reliable = generating || !["generating", "starting", "stopping"].includes(String(sample.fuelCellGenerationState ?? ""));
    return [{ sample, at, start, end, watts, generating, reliable, rollup }];
  }).sort((a, b) => a.at - b.at);
  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index]!;
    if ((reading.rollup ? reading.end > observationStart : reading.end >= observationStart) && reading.end <= windowEnd) {
      if (reading.reliable && reading.at >= observationStart) lastReading = Math.max(lastReading ?? 0, reading.at);
      if (!reading.reliable && reading.at >= observationStart) lastConflictingReading = Math.max(lastConflictingReading ?? 0, reading.at);
      // A boundary-straddling rollup cannot locate its generation after departure.
      if (reading.generating && reading.start >= observationStart) lastGenerating = Math.max(lastGenerating ?? 0, reading.end);
    }
    if (!reading.reliable) continue;
    if (reading.rollup) {
      const coverage = finiteNumberOrNull(reading.sample.powerCoverageSeconds?.fuelCellPowerW);
      const duration = (reading.end - reading.start) / 1000;
      if (coverage !== null && duration > 0 && duration <= 1_800 && coverage > 0) {
        intervals.push({ startMs: reading.start, endMs: reading.end, coverage: Math.min(1, coverage / duration), generating: reading.generating });
      }
    } else {
      const next = readings[index + 1];
      if (next && !next.rollup && next.at > reading.at && next.at - reading.at <= MAX_RAW_GAP_MS) {
        intervals.push({ startMs: reading.at, endMs: next.at, coverage: 1, generating: reading.generating });
      }
    }
  }
  const merged = unionIntervals(intervals, windowStart, windowEnd);
  const duration = Math.max(0, windowEnd - windowStart);
  const covered = merged.reduce((sum, entry) => sum + (entry.endMs - entry.startMs) * entry.coverage, 0);
  let cursor = windowStart;
  let maximumGap = 0;
  for (const entry of merged) {
    maximumGap = Math.max(maximumGap, entry.startMs - cursor);
    cursor = entry.endMs;
  }
  maximumGap = Math.max(maximumGap, windowEnd - cursor);
  const coveragePercent = duration > 0 ? covered / duration * 100 : 0;
  const fresh = lastReading !== null && nowMs - lastReading <= MAX_READING_AGE_MS;
  const quietCycle = duration >= MILLISECONDS_PER_DAY && coveragePercent >= 90 && maximumGap <= 60 * 60_000
    && !merged.some((entry) => entry.generating) && (lastGenerating === null || lastGenerating <= windowStart);
  const sustained = merged.some((entry) => entry.generating && (entry.endMs - entry.startMs) * entry.coverage >= SUSTAINED_GENERATION_MS);
  let regime: AwayFuelCellRegime = "provisional-off";
  let reason: AwayFuelCellReason = "observing";
  if (lastConflictingReading !== null && lastConflictingReading >= (lastReading ?? 0)) {
    // Fresh active/transition status with zero power contradicts being off.
    // Withdraw released headroom immediately, without waiting for staleness.
    regime = "uncertain";
    reason = "insufficient-coverage";
  } else if (nowMs >= observationStart && (!fresh || (duration >= MILLISECONDS_PER_DAY && (coveragePercent < 90 || maximumGap > 60 * 60_000)))) {
    regime = "uncertain";
    reason = !fresh ? "stale-readings" : "insufficient-coverage";
  } else if (sustained || (same && prior.regime === "normal-model" && !quietCycle)) {
    regime = "normal-model";
    reason = "sustained-generation";
  } else if (quietCycle) {
    regime = "off-supported";
    reason = "quiet-cycle";
  } else if (merged.some((entry) => entry.generating) || (lastGenerating !== null && lastGenerating >= windowStart)) {
    regime = "uncertain";
    reason = "generation-detected";
  } else if (duration >= MILLISECONDS_PER_DAY) {
    regime = "uncertain";
    reason = "insufficient-coverage";
  }
  return {
    version: AWAY_FUEL_CELL_VERSION, periodId, deviceKey,
    from: String(period.from), until: String(period.until),
    regime, reason, observationFrom: new Date(observationStart).toISOString(),
    coveragePercent: Math.round(coveragePercent * 10) / 10,
    lastReadingAt: lastReading === null ? null : new Date(lastReading).toISOString(),
    lastGeneratingAt: lastGenerating === null ? null : new Date(lastGenerating).toISOString(),
    evaluatedAt: now.toISOString(),
    nextReviewAt: new Date(Math.max(nowMs, observationStart) + (duration < MILLISECONDS_PER_DAY ? Math.max(0, MILLISECONDS_PER_DAY - duration) : 60 * 60_000)).toISOString(),
    headroomAllowanceRetained: regime !== "off-supported",
    intervals: merged,
  };
}

export function activeAwayFuelCellEvidence(
  config: AwayFuelCellConfig, periods: readonly (AwayPeriod & { id?: string })[],
  samples: readonly FuelCellEvidenceSample[], now: Date, previous: AwayFuelCellEvidence | null = null,
): AwayFuelCellEvidence | null {
  const deviceKey = awayFuelCellDeviceKey(config);
  const period = periods.find((entry) => awayPeriodContains(entry, now.getTime()));
  return deviceKey && period ? inferAwayFuelCell(period, deviceKey, samples, now, previous,
    [deviceKey, ...(config.fuelCellProxyHosts ?? [])]) : null;
}
