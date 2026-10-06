import { finiteNumberOrNull } from "./numbers.js";
import { median, percentile } from "./statistics.js";
import { localDayKey } from "./time.js";
import type { HistorySample } from "../contracts/history.js";

export const BATTERY_LEARNING_MODEL_VERSION = 3;
const BATTERY_CHARGE_CURVE_BANDS: Array<{ minSoc: number; maxSoc: number }> = [
  { minSoc: 0, maxSoc: 80 },
  { minSoc: 80, maxSoc: 85 },
  { minSoc: 85, maxSoc: 90 },
  { minSoc: 90, maxSoc: 95 },
  { minSoc: 95, maxSoc: 100 },
];
const BATTERY_CURVE_MIN_SAMPLES = 60;
const BATTERY_CURVE_MIN_SESSIONS = 3;
const BATTERY_CURVE_MIN_DAYS = 2;
const BATTERY_CURVE_MAX_DISPERSION_PERCENT = 20;
const BATTERY_LEARNING_MIN_OBSERVATIONS = 10;
const BATTERY_LEARNING_MIN_DAYS = 7;
const BATTERY_LEARNING_MIN_SOC_POINTS = 300;
const BATTERY_LEARNING_MIN_VALIDATIONS = 5;
const BATTERY_LEARNING_MAX_MAE_SOC = 3;
const BATTERY_LEARNING_MAX_BIAS_SOC = 2;
const BATTERY_LEARNING_MAX_ERROR_SOC = 6;
const BATTERY_LEARNING_DEMOTION_FAILURES = 3;
const ADAPTIVE_CHARGING_TIMING_RESERVE_MIN_MS = 5 * 60_000;
const ADAPTIVE_CHARGING_TIMING_RESERVE_MAX_MS = 15 * 60_000;
const ADAPTIVE_CHARGING_TIMING_RESERVE_FRACTION = 0.1;

type LearningSource = "learned" | "configured";
type BatteryDirection = "charge" | "discharge";

interface ValidationOutcome {
  id: string | null;
  predictedSocDelta: number | null;
  actualSocDelta: number | null;
  errorSoc: number | null;
}

interface BatteryLearningValidation {
  count: number;
  meanAbsoluteErrorSoc: number | null;
  biasSoc: number | null;
  maximumErrorSoc: number | null;
  seenIds: string[];
  outcomes: ValidationOutcome[];
}

export interface BatteryLearningCoefficient {
  source: LearningSource;
  configuredWhPerSocPoint: number | null;
  candidateWhPerSocPoint: number | null;
  activeWhPerSocPoint: number | null;
  observationCount: number;
  acceptedObservationCount: number;
  distinctDays: number;
  totalSocPoints: number;
  dispersionPercent: number | null;
  stabilityPercent: number | null;
  acceptancePercent: number | null;
  validation: BatteryLearningValidation;
  blockers: string[];
  activatedAt: string | null;
  activationSnapshot: Record<string, unknown> | null;
  demotedAt: string | null;
  demotionReason: string | null;
  failureStreak: number;
  lastValidationCount: number;
}

export interface BatteryChargePowerBand {
  minSoc: number;
  maxSoc: number;
  source: LearningSource;
  configuredWatts: number | null;
  candidateWatts: number | null;
  activeWatts: number | null;
  sampleCount: number;
  sessionCount: number;
  distinctDays: number;
  dispersionPercent: number | null;
  blockers: string[];
}

export interface BatteryLearningPower {
  source: LearningSource;
  configuredWatts: number | null;
  candidateWatts: number | null;
  activeWatts: number | null;
  sampleCount: number;
  postMigrationSampleCount: number;
  sessionCount: number;
  distinctDays: number;
  dispersionPercent: number | null;
  blockers: string[];
  activatedAt: string | null;
  activationSnapshot: Record<string, unknown> | null;
  demotedAt: string | null;
  demotionReason: string | null;
  curve: BatteryChargePowerBand[];
}

export interface BatteryLearningModel {
  version: number;
  migratedAt: string;
  status: "learning" | "validating" | "active" | "degraded";
  switchAfterSlotEnd: string | null;
  consumedSwitchAfterSlotEnd: string | null;
  switchConsumedAt: string | null;
  charge: BatteryLearningCoefficient;
  discharge: BatteryLearningCoefficient;
  power: BatteryLearningPower;
  lastEvaluatedAt: string | null;
}

interface BatteryLearningInterval {
  startMs: number;
  endMs: number;
  startSoc: number;
  endSoc: number;
  direction: BatteryDirection;
  energyWh: number;
  coverageSeconds: number;
  durationSeconds: number;
  manualAction: boolean;
}

interface BatteryLearningObservationAccumulator {
  direction: BatteryDirection;
  startMs: number;
  endMs: number;
  startSoc: number;
  endSoc: number;
  energyWh: number;
  coverageSeconds: number;
  durationSeconds: number;
  manualAction: boolean;
  reversed: boolean;
}

export interface BatteryLearningObservation {
  id: string;
  kind: BatteryDirection;
  start: string;
  end: string;
  energyWh: number;
  startSocPercent: number;
  endSocPercent: number;
  socDeltaPercent: number;
  coverageRatio: number;
  eligible: boolean;
  rejectionReason: string | null;
  whPerSocPoint: number | null;
}

interface ChargePerformanceSample {
  at: string;
  batteryChargingW: number;
  socPercent?: number | null;
  sessionId?: string;
  day?: string;
}

interface ChargeCurveSample {
  at?: string;
  day?: string;
  sessionId?: string;
  socPercent?: unknown;
  batteryChargingW?: unknown;
}

interface BatteryLearningConfig {
  batteryCapabilities?: { usableCapacityKwh?: unknown; maximumChargeWatts?: unknown };
}

interface BatteryLearningState {
  batteryLearning?: {
    version?: number;
    charge?: Partial<BatteryLearningCoefficient>;
    discharge?: Partial<BatteryLearningCoefficient>;
    power?: Partial<BatteryLearningPower>;
  };
  chargingPerformance?: { learnedChargeWatts?: unknown };
}

interface PreviousBatteryLearningModel extends Partial<BatteryLearningModel> {
  performance?: { samples?: ChargePerformanceSample[] };
}

interface ChargeTimingInput {
  targetWh?: unknown;
  requiredWh?: unknown;
  durationMs?: unknown;
  startSocPercent?: unknown;
  whPerSocPoint?: unknown;
  powerCurve?: BatteryChargePowerBand[];
  fallbackWatts?: unknown;
  windowDurationMs?: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}


export function cleanBatteryLearningCoefficient(input: unknown = {}): BatteryLearningCoefficient {
  const value = objectRecord(input);
  const validation = objectRecord(value.validation);
  return {
    source: value.source === "learned" ? "learned" : "configured",
    configuredWhPerSocPoint: finiteNumberOrNull(value.configuredWhPerSocPoint),
    candidateWhPerSocPoint: finiteNumberOrNull(value.candidateWhPerSocPoint),
    activeWhPerSocPoint: finiteNumberOrNull(value.activeWhPerSocPoint),
    observationCount: Math.max(0, Math.round(Number(value.observationCount) || 0)),
    acceptedObservationCount: Math.max(0, Math.round(Number(value.acceptedObservationCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(value.distinctDays) || 0)),
    totalSocPoints: Math.max(0, Number(value.totalSocPoints) || 0),
    dispersionPercent: finiteNumberOrNull(value.dispersionPercent),
    stabilityPercent: finiteNumberOrNull(value.stabilityPercent),
    acceptancePercent: finiteNumberOrNull(value.acceptancePercent),
    validation: {
      count: Math.max(0, Math.round(Number(validation.count) || 0)),
      meanAbsoluteErrorSoc: finiteNumberOrNull(validation.meanAbsoluteErrorSoc),
      biasSoc: finiteNumberOrNull(validation.biasSoc),
      maximumErrorSoc: finiteNumberOrNull(validation.maximumErrorSoc),
      seenIds: (Array.isArray(validation.seenIds) ? validation.seenIds : [])
        .filter(Boolean)
        .map(String)
        .slice(-500),
      outcomes: (Array.isArray(validation.outcomes) ? validation.outcomes : []).slice(-20).map((item) => {
        const outcome = objectRecord(item);
        return {
        id: typeof outcome.id === "string" ? outcome.id : null,
        predictedSocDelta: finiteNumberOrNull(outcome.predictedSocDelta),
        actualSocDelta: finiteNumberOrNull(outcome.actualSocDelta),
        errorSoc: finiteNumberOrNull(outcome.errorSoc),
        };
      }),
    },
    blockers: Array.isArray(value.blockers) ? value.blockers.map(String) : [],
    activatedAt: typeof value.activatedAt === "string" ? value.activatedAt : null,
    activationSnapshot: value.activationSnapshot && typeof value.activationSnapshot === "object"
      ? value.activationSnapshot as Record<string, unknown>
      : null,
    demotedAt: typeof value.demotedAt === "string" ? value.demotedAt : null,
    demotionReason: typeof value.demotionReason === "string" ? value.demotionReason : null,
    failureStreak: Math.max(0, Math.round(Number(value.failureStreak) || 0)),
    lastValidationCount: Math.max(0, Math.round(Number(value.lastValidationCount) || 0)),
  };
}


export function cleanBatteryLearningPower(input: unknown = {}): BatteryLearningPower {
  const value = objectRecord(input);
  const curve = (Array.isArray(value.curve) ? value.curve : []).map((item) => {
    const band = objectRecord(item);
    return {
    minSoc: Math.max(0, Math.min(100, Number(band.minSoc) || 0)),
    maxSoc: Math.max(0, Math.min(100, Number(band.maxSoc) || 0)),
    source: (band.source === "learned" ? "learned" : "configured") as LearningSource,
    configuredWatts: finiteNumberOrNull(band.configuredWatts),
    candidateWatts: finiteNumberOrNull(band.candidateWatts),
    activeWatts: finiteNumberOrNull(band.activeWatts),
    sampleCount: Math.max(0, Math.round(Number(band.sampleCount) || 0)),
    sessionCount: Math.max(0, Math.round(Number(band.sessionCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(band.distinctDays) || 0)),
    dispersionPercent: finiteNumberOrNull(band.dispersionPercent),
    blockers: Array.isArray(band.blockers) ? band.blockers.map(String) : [],
    };
  }).filter((band) => band.maxSoc > band.minSoc);
  return {
    source: value.source === "learned" ? "learned" : "configured",
    configuredWatts: finiteNumberOrNull(value.configuredWatts),
    candidateWatts: finiteNumberOrNull(value.candidateWatts),
    activeWatts: finiteNumberOrNull(value.activeWatts),
    sampleCount: Math.max(0, Math.round(Number(value.sampleCount) || 0)),
    postMigrationSampleCount: Math.max(0, Math.round(Number(value.postMigrationSampleCount) || 0)),
    sessionCount: Math.max(0, Math.round(Number(value.sessionCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(value.distinctDays) || 0)),
    dispersionPercent: finiteNumberOrNull(value.dispersionPercent),
    blockers: Array.isArray(value.blockers) ? value.blockers.map(String) : [],
    activatedAt: typeof value.activatedAt === "string" ? value.activatedAt : null,
    activationSnapshot: value.activationSnapshot && typeof value.activationSnapshot === "object"
      ? value.activationSnapshot as Record<string, unknown>
      : null,
    demotedAt: typeof value.demotedAt === "string" ? value.demotedAt : null,
    demotionReason: typeof value.demotionReason === "string" ? value.demotionReason : null,
    curve,
  };
}


export function cleanBatteryLearningModel(input: unknown = {}): BatteryLearningModel {
  const value = objectRecord(input);
  return {
    version: BATTERY_LEARNING_MODEL_VERSION,
    migratedAt: typeof value.migratedAt === "string" ? value.migratedAt : new Date().toISOString(),
    status: value.status === "validating" || value.status === "active" || value.status === "degraded"
      ? value.status
      : "learning",
    switchAfterSlotEnd: typeof value.switchAfterSlotEnd === "string" ? value.switchAfterSlotEnd : null,
    consumedSwitchAfterSlotEnd: typeof value.consumedSwitchAfterSlotEnd === "string" ? value.consumedSwitchAfterSlotEnd : null,
    switchConsumedAt: typeof value.switchConsumedAt === "string" ? value.switchConsumedAt : null,
    charge: cleanBatteryLearningCoefficient(value.charge),
    discharge: cleanBatteryLearningCoefficient(value.discharge),
    power: cleanBatteryLearningPower(value.power),
    lastEvaluatedAt: typeof value.lastEvaluatedAt === "string" ? value.lastEvaluatedAt : null,
  };
}


export function batteryLearningRollupInterval(sample: HistorySample): BatteryLearningInterval | null {
  const startMs = new Date(sample.rollupStart ?? sample.timestamp ?? "").getTime();
  const endMs = new Date(sample.rollupEnd ?? sample.timestamp ?? "").getTime();
  const startSoc = Number(sample?.startStateOfChargePercent ?? sample?.stateOfChargePercent);
  const endSoc = Number(sample?.endStateOfChargePercent ?? sample?.stateOfChargePercent);
  const chargeWh = Math.max(0, Number(sample?.batteryChargeKwh) || 0) * 1000;
  const dischargeWh = Math.max(0, Number(sample?.batteryDischargeKwh) || 0) * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (!Number.isFinite(startSoc) || !Number.isFinite(endSoc)) return null;
  const mixed = chargeWh >= 10 && dischargeWh >= 10;
  const direction = mixed ? null : chargeWh >= 10 ? "charge" : dischargeWh >= 10 ? "discharge" : null;
  if (!direction) return null;
  const energyWh = direction === "charge" ? chargeWh : dischargeWh;
  const coveredSeconds = Number(sample?.coverageSeconds?.[
    direction === "charge" ? "batteryChargeKwh" : "batteryDischargeKwh"
  ]);
  const durationSeconds = (endMs - startMs) / 1000;
  return {
    startMs,
    endMs,
    startSoc,
    endSoc,
    direction,
    energyWh,
    coverageSeconds: Number.isFinite(coveredSeconds) ? coveredSeconds : durationSeconds,
    durationSeconds,
    manualAction: sample?.manualAction === true,
  };
}


export function extractBatteryLearningObservations(samples: readonly HistorySample[] = []): BatteryLearningObservation[] {
  const intervals = samples
    .map(batteryLearningRollupInterval)
    .filter((value): value is BatteryLearningInterval => value !== null)
    .sort((left, right) => left.startMs - right.startMs);
  const observations: BatteryLearningObservation[] = [];
  let current: BatteryLearningObservationAccumulator | null = null;
  const flush = () => {
    if (!current) return;
    const socDelta = current.direction === "charge"
      ? current.endSoc - current.startSoc
      : current.startSoc - current.endSoc;
    const coverageRatio = current.durationSeconds > 0
      ? Math.min(1, current.coverageSeconds / current.durationSeconds)
      : 0;
    const reasons: string[] = [];
    if (current.reversed) reasons.push("SOC direction reversed");
    if (current.manualAction) reasons.push("manual action during observation");
    if (socDelta < 20) reasons.push("SOC change below 20 points");
    if (current.energyWh < 500) reasons.push("energy below 500 Wh");
    if (coverageRatio < 0.9) reasons.push("telemetry coverage below 90%");
    if (current.direction === "charge" && current.endSoc > 98) reasons.push("charge reached censored upper SOC");
    const eligible = reasons.length === 0;
    observations.push({
      id: `${current.direction}:${new Date(current.startMs).toISOString()}:${new Date(current.endMs).toISOString()}`,
      kind: current.direction,
      start: new Date(current.startMs).toISOString(),
      end: new Date(current.endMs).toISOString(),
      energyWh: current.energyWh,
      startSocPercent: current.startSoc,
      endSocPercent: current.endSoc,
      socDeltaPercent: socDelta,
      coverageRatio,
      eligible,
      rejectionReason: reasons.join("; ") || null,
      whPerSocPoint: eligible ? current.energyWh / socDelta : null,
    });
    current = null;
  };
  for (const interval of intervals) {
    if (interval.direction === "charge" && interval.endSoc > 98 && current) flush();
    const contiguous = current
      && current.direction === interval.direction
      && interval.startMs - current.endMs <= 35 * 60_000;
    if (!contiguous) {
      flush();
      current = {
        direction: interval.direction,
        startMs: interval.startMs,
        endMs: interval.endMs,
        startSoc: interval.startSoc,
        endSoc: interval.endSoc,
        energyWh: interval.energyWh,
        coverageSeconds: interval.coverageSeconds,
        durationSeconds: interval.durationSeconds,
        manualAction: interval.manualAction,
        reversed: interval.direction === "charge"
          ? interval.endSoc < interval.startSoc
          : interval.endSoc > interval.startSoc,
      };
      continue;
    }
    if (!current) continue;
    const intervalDelta = interval.direction === "charge"
      ? interval.endSoc - interval.startSoc
      : interval.startSoc - interval.endSoc;
    const boundaryReversed = interval.direction === "charge"
      ? interval.startSoc < current.endSoc
      : interval.startSoc > current.endSoc;
    current.endMs = interval.endMs;
    current.endSoc = interval.endSoc;
    current.energyWh += interval.energyWh;
    current.coverageSeconds += interval.coverageSeconds;
    current.durationSeconds += interval.durationSeconds;
    current.manualAction ||= interval.manualAction;
    if (intervalDelta < 0 || boundaryReversed) current.reversed = true;
  }
  flush();
  return observations;
}


export function batteryLearningValidation(
  observations: readonly BatteryLearningObservation[],
  migrationAt: Date | string | number,
): BatteryLearningValidation {
  const migrationMs = new Date(migrationAt).getTime();
  const validations: ValidationOutcome[] = [];
  const sorted = observations.filter((item) => item.eligible)
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
  for (let index = 0; index < sorted.length; index += 1) {
    const observation = sorted[index];
    if (new Date(observation.start).getTime() < migrationMs) continue;
    const priorValues = sorted.slice(0, index).map((item) => item.whPerSocPoint)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (priorValues.length < BATTERY_LEARNING_MIN_OBSERVATIONS) continue;
    const coefficient = median(priorValues);
    const predictedSocDelta = observation.energyWh / Number(coefficient);
    validations.push({
      id: observation.id,
      predictedSocDelta,
      actualSocDelta: observation.socDeltaPercent,
      errorSoc: predictedSocDelta - observation.socDeltaPercent,
    });
  }
  const errors = validations.map((item) => item.errorSoc)
    .filter((value): value is number => value !== null);
  return {
    count: validations.length,
    meanAbsoluteErrorSoc: errors.length
      ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length
      : null,
    biasSoc: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    maximumErrorSoc: errors.length ? Math.max(...errors.map(Math.abs)) : null,
    seenIds: [],
    outcomes: validations.slice(-20),
  };
}


export function batteryLearningCoefficient(
  kind: BatteryDirection,
  observations: readonly BatteryLearningObservation[],
  configuredWhPerSocPoint: unknown,
  previous: Partial<BatteryLearningCoefficient> = {},
  migrationAt: Date | string | number,
  now: Date = new Date(),
): BatteryLearningCoefficient {
  const matching = observations.filter((item) => item.kind === kind);
  const structurallyComplete = matching.filter((item) => item.energyWh >= 500 && item.socDeltaPercent >= 20);
  const eligible = structurallyComplete.filter((item) => item.eligible && Number.isFinite(item.whPerSocPoint));
  const values = eligible.map((item) => item.whPerSocPoint)
    .filter((value): value is number => value !== null);
  const candidate = median(values);
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const dispersionPercent = Number.isFinite(candidate) && Number(candidate) > 0 && Number.isFinite(q1) && Number.isFinite(q3)
    ? (Number(q3) - Number(q1)) / Number(candidate) * 100
    : null;
  const recentMedian = median(values.slice(-5));
  const priorMedian = median(values.slice(-10, -5));
  const stabilityPercent = Number.isFinite(recentMedian) && Number.isFinite(priorMedian) && Number(priorMedian) > 0
    ? Math.abs(Number(recentMedian) - Number(priorMedian)) / Number(priorMedian) * 100
    : null;
  const distinctDays = new Set(eligible.map((item) => localDayKey(new Date(item.start)))).size;
  const totalSocPoints = eligible.reduce((sum, item) => sum + item.socDeltaPercent, 0);
  const acceptancePercent = structurallyComplete.length ? eligible.length / structurallyComplete.length * 100 : 0;
  const validation = batteryLearningValidation(matching, migrationAt);
  const blockers: string[] = [];
  if (eligible.length < BATTERY_LEARNING_MIN_OBSERVATIONS) blockers.push(`${BATTERY_LEARNING_MIN_OBSERVATIONS - eligible.length} more eligible observations required`);
  if (distinctDays < BATTERY_LEARNING_MIN_DAYS) blockers.push(`${BATTERY_LEARNING_MIN_DAYS - distinctDays} more distinct days required`);
  if (totalSocPoints < BATTERY_LEARNING_MIN_SOC_POINTS) blockers.push(`${Math.ceil(BATTERY_LEARNING_MIN_SOC_POINTS - totalSocPoints)} more SOC points required`);
  const dispersionLimit = kind === "charge" ? 7 : 10;
  if (Number.isFinite(dispersionPercent) && Number(dispersionPercent) > dispersionLimit) blockers.push(`dispersion ${Number(dispersionPercent).toFixed(1)}% exceeds ${dispersionLimit}%`);
  const stabilityLimit = kind === "charge" ? 3 : 5;
  if (!Number.isFinite(stabilityPercent) || Number(stabilityPercent) > stabilityLimit) blockers.push(`rolling stability must be within ${stabilityLimit}%`);
  if (kind === "discharge" && acceptancePercent < 60) blockers.push(`valid observation acceptance ${acceptancePercent.toFixed(0)}% is below 60%`);
  if (validation.count < BATTERY_LEARNING_MIN_VALIDATIONS) blockers.push(`${BATTERY_LEARNING_MIN_VALIDATIONS - validation.count} more forward validations required`);
  if (validation.meanAbsoluteErrorSoc !== null && validation.meanAbsoluteErrorSoc > BATTERY_LEARNING_MAX_MAE_SOC) blockers.push("validation mean error exceeds 3 SOC points");
  if (validation.biasSoc !== null && Math.abs(validation.biasSoc) > BATTERY_LEARNING_MAX_BIAS_SOC) blockers.push("validation bias exceeds 2 SOC points");
  if (validation.maximumErrorSoc !== null && validation.maximumErrorSoc > BATTERY_LEARNING_MAX_ERROR_SOC) blockers.push("validation maximum error exceeds 6 SOC points");

  const previousSource = previous.source === "learned" ? "learned" : "configured";
  const previouslySeenValidationIds = new Set<string>([
    ...(previous.validation?.seenIds ?? []),
    ...(previous.validation?.outcomes ?? []).map((outcome) => outcome.id),
  ].filter((value): value is string => typeof value === "string" && Boolean(value)));
  const newValidationOutcomes = validation.outcomes.filter(
    (outcome) => outcome.id && !previouslySeenValidationIds.has(outcome.id),
  );
  validation.seenIds = [...previouslySeenValidationIds, ...newValidationOutcomes.map((outcome) => outcome.id!)]
    .slice(-500);
  const aggregateValidationFailed = validation.count >= BATTERY_LEARNING_MIN_VALIDATIONS && (
    Number(validation.meanAbsoluteErrorSoc) > BATTERY_LEARNING_MAX_MAE_SOC
    || Math.abs(Number(validation.biasSoc)) > BATTERY_LEARNING_MAX_BIAS_SOC
    || Number(validation.maximumErrorSoc) > BATTERY_LEARNING_MAX_ERROR_SOC
  );
  let failureStreak = Number(previous.failureStreak) || 0;
  if (previousSource === "learned" && newValidationOutcomes.length) {
    for (const outcome of newValidationOutcomes) {
      const failed = aggregateValidationFailed
        || Math.abs(Number(outcome.errorSoc)) > BATTERY_LEARNING_MAX_ERROR_SOC;
      failureStreak = failed ? failureStreak + 1 : 0;
    }
  }
  const materialDrift = previousSource === "learned" && (
    Number(dispersionPercent) > dispersionLimit * 2
    || Number(stabilityPercent) > stabilityLimit * 2
  );
  const demoted = previousSource === "learned"
    && (failureStreak >= BATTERY_LEARNING_DEMOTION_FAILURES || materialDrift);
  const activate = previousSource !== "learned" && blockers.length === 0 && Number.isFinite(candidate);
  const source = demoted ? "configured" : previousSource === "learned" || activate ? "learned" : "configured";
  const active = source === "learned"
    ? blockers.length === 0 && Number.isFinite(candidate)
      ? candidate
      : finiteNumberOrNull(previous.activeWhPerSocPoint) ?? candidate
    : configuredWhPerSocPoint;
  if (activate) failureStreak = 0;
  const demotionReason = materialDrift
    ? "material observation distribution drift"
    : "three consecutive forward-validation failures";
  return cleanBatteryLearningCoefficient({
    source,
    configuredWhPerSocPoint,
    candidateWhPerSocPoint: candidate,
    activeWhPerSocPoint: active,
    observationCount: structurallyComplete.length,
    acceptedObservationCount: eligible.length,
    distinctDays,
    totalSocPoints,
    dispersionPercent,
    stabilityPercent,
    acceptancePercent,
    validation,
    blockers,
    activatedAt: activate ? now.toISOString() : previous.activatedAt,
    activationSnapshot: activate ? {
      candidateWhPerSocPoint: candidate,
      observationCount: eligible.length,
      distinctDays,
      totalSocPoints,
      dispersionPercent,
      stabilityPercent,
      validation,
    } : previous.activationSnapshot,
    demotedAt: demoted ? now.toISOString() : previous.demotedAt,
    demotionReason: demoted ? demotionReason : previous.demotionReason,
    failureStreak,
    lastValidationCount: validation.count,
  });
}


export function batteryLearningPower(
  performance: { samples?: ChargePerformanceSample[] } | null | undefined,
  configuredWatts: number,
  previous: Partial<BatteryLearningPower> = {},
  migrationAt: Date | string | number,
  now: Date = new Date(),
): BatteryLearningPower {
  const samples = [...(performance?.samples ?? [])]
    .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
  const positiveValues = samples
    .map((item) => Number(item.batteryChargingW))
    .filter((watts) => Number.isFinite(watts) && watts > 0);
  const highWaterWatts = percentile(positiveValues, 0.9);
  const steadySamples = samples.filter((item) => {
    const watts = Number(item.batteryChargingW);
    return Number.isFinite(watts)
      && Number.isFinite(highWaterWatts)
      && watts >= Number(highWaterWatts) * 0.95;
  });
  const steadyValues = steadySamples.map((item) => Number(item.batteryChargingW)).sort((left, right) => left - right);
  const candidate = median(steadyValues);
  const q1 = percentile(steadyValues, 0.25);
  const q3 = percentile(steadyValues, 0.75);
  const dispersionPercent = Number.isFinite(candidate) && Number(candidate) > 0 && Number.isFinite(q1) && Number.isFinite(q3)
    ? (Number(q3) - Number(q1)) / Number(candidate) * 100
    : null;
  let sessionCount = 0;
  let previousMs: number | null = null;
  const migrationMs = new Date(migrationAt).getTime();
  const postMigrationSamples = steadySamples.filter((sample) => new Date(sample.at).getTime() >= migrationMs);
  for (const sample of postMigrationSamples) {
    const time = new Date(sample.at).getTime();
    if (previousMs === null || time - previousMs > 2 * 60_000) sessionCount += 1;
    previousMs = time;
  }
  const distinctDays = new Set(postMigrationSamples.map((item) => localDayKey(new Date(item.at)))).size;
  const blockers: string[] = [];
  if (postMigrationSamples.length < 120) blockers.push(`${120 - postMigrationSamples.length} more post-migration steady samples required`);
  if (sessionCount < 3) blockers.push(`${3 - sessionCount} more charging sessions required`);
  if (distinctDays < 2) blockers.push(`${2 - distinctDays} more distinct days required`);
  if (!Number.isFinite(dispersionPercent) || Number(dispersionPercent) > 3) blockers.push("charge-power dispersion must be within 3%");
  const protectiveReduction = Number.isFinite(candidate) && Number(candidate) <= configuredWatts * 0.95;
  const qualified = blockers.length === 0;
  const enoughCurrentEvidence = postMigrationSamples.length >= 120 && sessionCount >= 3 && distinctDays >= 2;
  const materialDrift = enoughCurrentEvidence && Number(dispersionPercent) > 3;
  const reductionNoLongerNeeded = enoughCurrentEvidence
    && Number.isFinite(candidate)
    && !protectiveReduction
    && !materialDrift;
  const demoted = previous.source === "learned" && (materialDrift || reductionNoLongerNeeded);
  const source = demoted
    ? "configured"
    : (qualified && protectiveReduction) || previous.source === "learned"
      ? "learned"
      : "configured";
  const activeWatts = source === "learned"
    ? qualified && protectiveReduction
      ? Math.min(configuredWatts, Number(candidate))
      : finiteNumberOrNull(previous.activeWatts) ?? configuredWatts
    : configuredWatts;
  return cleanBatteryLearningPower({
    source,
    configuredWatts,
    candidateWatts: candidate,
    activeWatts,
    sampleCount: steadySamples.length,
    postMigrationSampleCount: postMigrationSamples.length,
    sessionCount,
    distinctDays,
    dispersionPercent,
    blockers,
    activatedAt: source === "learned" && previous.source !== "learned" ? now.toISOString() : previous.activatedAt,
    activationSnapshot: source === "learned" && previous.source !== "learned" ? {
      candidateWatts: candidate,
      sampleCount: steadySamples.length,
      postMigrationSampleCount: postMigrationSamples.length,
      sessionCount,
      distinctDays,
      dispersionPercent,
    } : previous.activationSnapshot,
    demotedAt: demoted ? now.toISOString() : previous.demotedAt,
    demotionReason: demoted
      ? materialDrift
        ? "material charge-power distribution drift"
        : "measured charge power returned to configured range"
      : previous.demotionReason,
  });
}


export function buildBatteryChargePowerCurve(
  samples: readonly ChargeCurveSample[] = [],
  configuredWatts: number,
  plateauModel: Partial<BatteryLearningPower> = {},
  previousCurve: readonly BatteryChargePowerBand[] = [],
): BatteryChargePowerBand[] {
  const normalized = samples.filter((sample) => Number.isFinite(Number(sample.socPercent))
    && Number(sample.socPercent) >= 0
    && Number(sample.socPercent) <= 100
    && Number.isFinite(Number(sample.batteryChargingW))
    && Number(sample.batteryChargingW) > 0);
  let previousCandidate = Number(plateauModel.candidateWatts ?? plateauModel.activeWatts ?? configuredWatts);
  let previousActive = Number(plateauModel.activeWatts ?? configuredWatts);
  return BATTERY_CHARGE_CURVE_BANDS.map((definition, index) => {
    if (index === 0) {
      return {
        ...definition,
        source: plateauModel.source === "learned" ? "learned" : "configured",
        configuredWatts,
        candidateWatts: finiteNumberOrNull(plateauModel.candidateWatts),
        activeWatts: Math.min(configuredWatts, previousActive),
        sampleCount: plateauModel.sampleCount ?? 0,
        sessionCount: plateauModel.sessionCount ?? 0,
        distinctDays: plateauModel.distinctDays ?? 0,
        dispersionPercent: finiteNumberOrNull(plateauModel.dispersionPercent),
        blockers: plateauModel.blockers ?? [],
      };
    }
    const bandSamples = normalized.filter((sample) => Number(sample.socPercent) >= definition.minSoc
      && (Number(sample.socPercent) < definition.maxSoc || definition.maxSoc === 100));
    const values = bandSamples.map((sample) => Number(sample.batteryChargingW)).sort((left, right) => left - right);
    const medianWatts = median(values);
    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const rawCandidate = Number.isFinite(q1) ? Math.min(configuredWatts, Number(q1)) : null;
    const candidateWatts = Number.isFinite(rawCandidate)
      ? Math.min(previousCandidate, Number(rawCandidate))
      : null;
    if (Number.isFinite(candidateWatts)) previousCandidate = Number(candidateWatts);
    const sessionCount = new Set(bandSamples.map((sample) => sample.sessionId).filter(Boolean)).size;
    const distinctDays = new Set(bandSamples.map((sample) => sample.day ?? localDayKey(new Date(sample.at ?? "")))).size;
    const dispersionPercent = Number.isFinite(medianWatts) && Number(medianWatts) > 0
      && Number.isFinite(q1) && Number.isFinite(q3)
      ? (Number(q3) - Number(q1)) / Number(medianWatts) * 100
      : null;
    const blockers: string[] = [];
    if (values.length < BATTERY_CURVE_MIN_SAMPLES) {
      blockers.push(`${BATTERY_CURVE_MIN_SAMPLES - values.length} more samples required`);
    }
    if (sessionCount < BATTERY_CURVE_MIN_SESSIONS) {
      blockers.push(`${BATTERY_CURVE_MIN_SESSIONS - sessionCount} more charging sessions required`);
    }
    if (distinctDays < BATTERY_CURVE_MIN_DAYS) {
      blockers.push(`${BATTERY_CURVE_MIN_DAYS - distinctDays} more distinct days required`);
    }
    if (!Number.isFinite(dispersionPercent) || Number(dispersionPercent) > BATTERY_CURVE_MAX_DISPERSION_PERCENT) {
      blockers.push(`charge-power dispersion must be within ${BATTERY_CURVE_MAX_DISPERSION_PERCENT}%`);
    }
    const previousBand = previousCurve.find((band) => Number(band.minSoc) === definition.minSoc
      && Number(band.maxSoc) === definition.maxSoc);
    const qualified = blockers.length === 0 && Number.isFinite(candidateWatts);
    const source = qualified || previousBand?.source === "learned" ? "learned" : "configured";
    const learnedActive = qualified ? candidateWatts : finiteNumberOrNull(previousBand?.activeWatts);
    const activeWatts = source === "learned" && Number.isFinite(learnedActive)
      ? Math.min(previousActive, Number(learnedActive))
      : configuredWatts;
    previousActive = Math.min(previousActive, activeWatts);
    return {
      ...definition,
      source,
      configuredWatts,
      candidateWatts,
      activeWatts: previousActive,
      sampleCount: values.length,
      sessionCount,
      distinctDays,
      dispersionPercent,
      blockers,
    };
  });
}


export function buildBatteryLearningModel(
  config: BatteryLearningConfig,
  rollups: readonly HistorySample[] = [],
  previous: PreviousBatteryLearningModel = {},
  now: Date = new Date(),
  { curveSamples = [] }: { curveSamples?: ChargeCurveSample[] } = {},
): BatteryLearningModel {
  const configuredCapacityKwh = Number(config.batteryCapabilities?.usableCapacityKwh);
  const configuredWhPerSocPoint = configuredCapacityKwh * 1000 / 100;
  const configuredWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const migrationAt = previous.migratedAt ?? now.toISOString();
  const observations = extractBatteryLearningObservations(rollups);
  const charge = batteryLearningCoefficient("charge", observations, configuredWhPerSocPoint, previous.charge, migrationAt, now);
  const discharge = batteryLearningCoefficient("discharge", observations, configuredWhPerSocPoint, previous.discharge, migrationAt, now);
  const power = batteryLearningPower(previous.performance ?? {}, configuredWatts, previous.power, migrationAt, now);
  power.curve = buildBatteryChargePowerCurve(
    curveSamples,
    configuredWatts,
    power,
    previous.power?.curve ?? [],
  );
  const sources: LearningSource[] = [charge.source, discharge.source, power.source];
  const anyDegraded = [charge, discharge, power]
    .some((model) => model.source !== "learned" && model.demotedAt);
  const status = anyDegraded
    ? "degraded"
    : sources.some((source) => source === "learned")
      ? "active"
      : charge.validation.count || discharge.validation.count
        ? "validating"
        : "learning";
  return cleanBatteryLearningModel({
    ...previous,
    version: BATTERY_LEARNING_MODEL_VERSION,
    migratedAt: migrationAt,
    status,
    charge,
    discharge,
    power,
    lastEvaluatedAt: now.toISOString(),
  });
}


export function effectiveAdaptiveChargeWatts(config: BatteryLearningConfig, state: BatteryLearningState = {}) {
  const configuredWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const model = state.batteryLearning?.power;
  const learned = model?.source === "learned" && Number.isFinite(Number(model.activeWatts));
  const learnedWatts = Number(model?.candidateWatts ?? state.chargingPerformance?.learnedChargeWatts);
  return {
    configuredWatts,
    learnedWatts: Number.isFinite(learnedWatts) ? learnedWatts : null,
    effectiveWatts: learned ? Math.min(configuredWatts, Number(model.activeWatts)) : configuredWatts,
    learned,
    source: learned ? "learned" : "configured",
    curve: (model?.curve?.length ? model.curve : BATTERY_CHARGE_CURVE_BANDS.map((band) => ({
      ...band,
      source: "configured" as const,
      configuredWatts,
      candidateWatts: null,
      activeWatts: configuredWatts,
      sampleCount: 0,
      sessionCount: 0,
      distinctDays: 0,
      dispersionPercent: null,
      blockers: band.minSoc >= 80 ? ["charge-power curve is not yet validated"] : [],
    }))).map((band) => ({ ...band })),
  };
}


export function effectiveBatteryLearningModel(config: BatteryLearningConfig, state: BatteryLearningState = {}) {
  const configuredWhPerSocPoint = Number(config.batteryCapabilities?.usableCapacityKwh) * 1000 / 100;
  const coefficient = (key: "charge" | "discharge") => {
    const value = state.batteryLearning?.[key];
    const learned = value?.source === "learned" && Number.isFinite(Number(value.activeWhPerSocPoint));
    return {
      source: learned ? "learned" : "configured",
      whPerSocPoint: learned ? Number(value.activeWhPerSocPoint) : configuredWhPerSocPoint,
      candidateWhPerSocPoint: finiteNumberOrNull(value?.candidateWhPerSocPoint),
    };
  };
  const charge = coefficient("charge");
  const discharge = coefficient("discharge");
  const power = effectiveAdaptiveChargeWatts(config, state);
  return {
    version: BATTERY_LEARNING_MODEL_VERSION,
    charge,
    discharge,
    power,
    capacityKwh: discharge.whPerSocPoint * 100 / 1000,
    chargeToStoredRatio: discharge.whPerSocPoint / charge.whPerSocPoint,
  };
}


export function chargePowerCurveBand(
  curve: readonly BatteryChargePowerBand[] = [],
  socPercent: unknown = 0,
): BatteryChargePowerBand | null {
  const soc = Math.max(0, Math.min(100, Number(socPercent) || 0));
  return curve.find((band) => soc >= Number(band.minSoc)
    && (soc < Number(band.maxSoc) || Number(band.maxSoc) === 100)) ?? curve.at(-1) ?? null;
}


export function estimateChargeDurationMs({
  targetWh,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
}: ChargeTimingInput = {}): number {
  let remainingWh = Math.max(0, Number(targetWh) || 0);
  let soc = Math.max(0, Math.min(100, Number(startSocPercent) || 0));
  const whPerPoint = Math.max(0.001, Number(whPerSocPoint) || 0);
  let durationMs = 0;
  let guard = 0;
  while (remainingWh > 0.001 && guard < 20) {
    guard += 1;
    const band = chargePowerCurveBand(powerCurve, soc);
    const watts = Math.max(1, Number(band?.activeWatts ?? fallbackWatts) || 0);
    const maxSoc = Math.max(soc, Number(band?.maxSoc ?? 100));
    const bandWh = Math.max(0, (maxSoc - soc) * whPerPoint);
    const consumedWh = bandWh > 0 ? Math.min(remainingWh, bandWh) : remainingWh;
    durationMs += consumedWh / watts * 3_600_000;
    remainingWh -= consumedWh;
    soc = maxSoc < 100 ? maxSoc + 0.000001 : 100;
  }
  return durationMs;
}


export function estimateDeliverableChargeWh({
  durationMs,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
}: ChargeTimingInput = {}): number {
  let remainingMs = Math.max(0, Number(durationMs) || 0);
  let soc = Math.max(0, Math.min(100, Number(startSocPercent) || 0));
  const whPerPoint = Math.max(0.001, Number(whPerSocPoint) || 0);
  let deliveredWh = 0;
  let guard = 0;
  while (remainingMs > 0.1 && guard < 20) {
    guard += 1;
    const band = chargePowerCurveBand(powerCurve, soc);
    const watts = Math.max(1, Number(band?.activeWatts ?? fallbackWatts) || 0);
    const maxSoc = Math.max(soc, Number(band?.maxSoc ?? 100));
    const bandWh = Math.max(0, (maxSoc - soc) * whPerPoint);
    const bandDurationMs = bandWh > 0 ? bandWh / watts * 3_600_000 : remainingMs;
    const usedMs = Math.min(remainingMs, bandDurationMs);
    const addedWh = watts * usedMs / 3_600_000;
    deliveredWh += addedWh;
    remainingMs -= usedMs;
    soc += addedWh / whPerPoint;
    if (soc >= 100) break;
    if (usedMs >= bandDurationMs - 0.1) soc = maxSoc + 0.000001;
  }
  return deliveredWh;
}


export function adaptiveChargingTimingProfile({
  requiredWh,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
  windowDurationMs,
}: ChargeTimingInput = {}) {
  const targetWh = Math.max(0, Number(requiredWh) || 0);
  const modeledDurationMs = estimateChargeDurationMs({
    targetWh,
    startSocPercent,
    whPerSocPoint,
    powerCurve,
    fallbackWatts,
  });
  const endSocPercent = Math.min(100, Number(startSocPercent) + targetWh / Math.max(0.001, Number(whPerSocPoint)));
  const unvalidatedTaper = powerCurve.some((band) => Number(band.minSoc) >= 80
    && band.source !== "learned"
    && Number(startSocPercent) < Number(band.maxSoc)
    && endSocPercent > Number(band.minSoc));
  const timingReserveMs = Math.min(
    ADAPTIVE_CHARGING_TIMING_RESERVE_MAX_MS,
    Math.max(ADAPTIVE_CHARGING_TIMING_RESERVE_MIN_MS, modeledDurationMs * ADAPTIVE_CHARGING_TIMING_RESERVE_FRACTION),
  );
  const scheduledDurationMs = Math.min(
    Math.max(0, Number(windowDurationMs) || 0),
    unvalidatedTaper ? Number(windowDurationMs) : modeledDurationMs + timingReserveMs,
  );
  const physicallyDeliverableWh = estimateDeliverableChargeWh({
    durationMs: windowDurationMs,
    startSocPercent,
    whPerSocPoint,
    powerCurve,
    fallbackWatts,
  });
  const schedulableWh = Math.min(targetWh, physicallyDeliverableWh);
  const schedulingWatts = scheduledDurationMs > 0
    ? Math.min(Number(fallbackWatts), schedulableWh / scheduledDurationMs * 3_600_000)
    : Number(fallbackWatts);
  return {
    modeledDurationMs,
    timingReserveMs,
    scheduledDurationMs,
    schedulingWatts: Math.max(1, schedulingWatts || Number(fallbackWatts)),
    unvalidatedTaper,
    physicallyDeliverableWh,
    timeConstrainedWh: Math.max(0, targetWh - physicallyDeliverableWh),
    source: unvalidatedTaper ? "conservative-fallback" : "soc-curve",
  };
}
