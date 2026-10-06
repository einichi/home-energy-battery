import { percentile } from "./statistics.js";

const MINIMUM_SAMPLES = 4;
const MINIMUM_INTERRUPTED_SAMPLES = 2;
const MINIMUM_DISTINCT_DAYS = 2;
const MAXIMUM_SAMPLES = 12;
const MINIMUM_DELIVERY_FACTOR = 0.5;

export interface GuardWindowOutcome {
  windowStart?: string | null;
  windowEnd?: string | null;
  label?: string | null;
  plannedWh?: number;
  deliveredWh?: number;
  estimatedDeliveryWh?: number;
  interruptionCount?: number;
  guardInterruptedMs?: number;
  solarHeadroomInterruptionCount?: number;
  socTargetReached?: boolean;
  completedAt?: string | null;
}

export interface GuardWindowIdentity {
  start: string | number | Date;
  end: string | number | Date;
  label?: string | null;
}

export interface GuardDeliverabilityModel {
  learned: boolean;
  sampleCount: number;
  interruptedSampleCount: number;
  distinctDays: number;
  deliveryFactor: number;
  observedDeliveryRatio: number;
  recoveryTimeFactor: number;
  interruptionReserveMs: number;
  blockers: string[];
}

export interface ChargeTimingProfile {
  modeledDurationMs: number;
  timingReserveMs: number;
  scheduledDurationMs: number;
  schedulingWatts: number;
  unvalidatedTaper: boolean;
  physicallyDeliverableWh: number;
  timeConstrainedWh: number;
  source: string;
}

function localWindowSignature(window: GuardWindowIdentity): string | null {
  const start = new Date(window.start instanceof Date ? window.start.getTime() : window.start);
  const end = new Date(window.end instanceof Date ? window.end.getTime() : window.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return JSON.stringify([
    window.label ?? "",
    start.getHours() * 60 + start.getMinutes(),
    end.getHours() * 60 + end.getMinutes(),
    Math.round((end.getTime() - start.getTime()) / 60_000),
  ]);
}

function completedTime(outcome: GuardWindowOutcome): number {
  return new Date(outcome.completedAt ?? outcome.windowEnd ?? "").getTime();
}

export function guardDeliverabilityForWindow(
  outcomes: readonly GuardWindowOutcome[] = [],
  window: GuardWindowIdentity,
): GuardDeliverabilityModel {
  const signature = localWindowSignature(window);
  const matching = signature === null ? [] : outcomes
    .filter((outcome) => Number(outcome.plannedWh) >= 100)
    .filter((outcome) => Number(outcome.solarHeadroomInterruptionCount) <= 0)
    .filter((outcome) => localWindowSignature({
      start: outcome.windowStart ?? "",
      end: outcome.windowEnd ?? "",
      label: outcome.label,
    }) === signature)
    .sort((left, right) => completedTime(right) - completedTime(left))
    .slice(0, MAXIMUM_SAMPLES);
  const interrupted = matching.filter((outcome) => Number(outcome.interruptionCount) > 0);
  const distinctDays = new Set(matching.map((outcome) => {
    const date = new Date(outcome.windowStart ?? "");
    return Number.isNaN(date.getTime()) ? null : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }).filter(Boolean)).size;
  const blockers: string[] = [];
  if (matching.length < MINIMUM_SAMPLES) blockers.push(`${MINIMUM_SAMPLES - matching.length} more comparable charging windows required`);
  if (interrupted.length < MINIMUM_INTERRUPTED_SAMPLES) blockers.push(`${MINIMUM_INTERRUPTED_SAMPLES - interrupted.length} more interrupted charging windows required`);
  if (distinctDays < MINIMUM_DISTINCT_DAYS) blockers.push(`${MINIMUM_DISTINCT_DAYS - distinctDays} more distinct observation days required`);
  const ratios = matching.map((outcome) => {
    if (outcome.socTargetReached === true || Number(outcome.interruptionCount) <= 0) return 1;
    const plannedWh = Math.max(1, Number(outcome.plannedWh));
    return Math.max(0, Math.min(1,
      (Math.max(0, Number(outcome.deliveredWh) || 0) + Math.max(0, Number(outcome.estimatedDeliveryWh) || 0)) / plannedWh,
    ));
  });
  const observedDeliveryRatio = percentile(ratios, 0.2) ?? 1;
  const interruptionReserveMs = Math.max(0, Math.round(percentile(
    interrupted.map((outcome) => Math.max(0, Number(outcome.guardInterruptedMs) || 0)),
    0.8,
  ) ?? 0));
  const learned = blockers.length === 0;
  const windowStartMs = new Date(window.start instanceof Date ? window.start.getTime() : window.start).getTime();
  const windowEndMs = new Date(window.end instanceof Date ? window.end.getTime() : window.end).getTime();
  const windowDurationMs = Math.max(1, windowEndMs - windowStartMs);
  const recoveryTimeFactor = learned
    ? Math.max(MINIMUM_DELIVERY_FACTOR, Math.min(1, 1 - interruptionReserveMs / windowDurationMs))
    : 1;
  return {
    learned,
    sampleCount: matching.length,
    interruptedSampleCount: interrupted.length,
    distinctDays,
    deliveryFactor: learned
      ? Math.max(MINIMUM_DELIVERY_FACTOR, Math.min(1, observedDeliveryRatio, recoveryTimeFactor))
      : 1,
    observedDeliveryRatio,
    recoveryTimeFactor,
    interruptionReserveMs: learned ? interruptionReserveMs : 0,
    blockers,
  };
}

export function applyGuardDeliverabilityToTiming(
  timing: ChargeTimingProfile,
  model: GuardDeliverabilityModel,
  requiredWh: number,
  windowDurationMs: number,
): ChargeTimingProfile {
  const schedulingWatts = Math.max(1, timing.schedulingWatts * model.deliveryFactor);
  const availableWh = schedulingWatts * windowDurationMs / 3_600_000;
  const scheduledDurationMs = requiredWh > 0
    ? Math.min(windowDurationMs, requiredWh / schedulingWatts * 3_600_000)
    : 0;
  return {
    ...timing,
    timingReserveMs: Math.max(0, scheduledDurationMs - timing.modeledDurationMs),
    scheduledDurationMs,
    schedulingWatts,
    physicallyDeliverableWh: Math.min(timing.physicallyDeliverableWh, availableWh),
    timeConstrainedWh: Math.max(0, requiredWh - Math.min(timing.physicallyDeliverableWh, availableWh)),
    source: model.learned ? `${timing.source}+guard-history` : timing.source,
  };
}
