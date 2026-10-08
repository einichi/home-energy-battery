import { finiteNumberOrNull } from "./numbers.js";
import { median, percentile, weightedMedian } from "./statistics.js";
import { halfHourIndex, isAwayAt, localDayKey } from "./time.js";
import type { AwayPeriod } from "./time.js";

const ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS = 10;
const ADAPTIVE_CHARGING_SEASONAL_DAY_RANGE = 28;
const ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR = 2;
const AWAY_LEARNED_MIN_DAYS = 3;

type Occupancy = "all" | "home" | "away";

export interface DemandSample {
  timestamp: string;
  branchDemandW?: unknown;
  fuelCellPowerW?: unknown;
  fuelCellGenerationState?: unknown;
  intervalAveragePowerW?: { branchDemandW?: unknown };
  powerCoverageSeconds?: { branchDemandW?: unknown };
  coverageSeconds?: { branchDemandKwh?: unknown };
  expectedIntervalSeconds?: unknown;
  stateOfChargePercent?: unknown;
  solarPowerW?: unknown;
}

interface DemandBucketAccumulator {
  weightedSum: number;
  coverageSeconds: number;
}

interface RawDemandDay {
  key: string;
  date: Date;
  buckets: Map<number, DemandBucketAccumulator>;
}

export interface DemandDay {
  key: string;
  date: Date;
  values: Map<number, number>;
  coverageByBucket?: Map<number, number>;
  coverage: number;
  daytimeCoverage: number;
}

interface ScoredDemandDay extends DemandDay {
  ageDays?: number;
  sameDayType: boolean;
  score: number;
  weight: number;
  yearsAgo?: number;
  calendarDistance?: number;
  temperatureDistance?: number;
}

interface DemandPrediction {
  profile: Map<number, number>;
  lowProfile: Map<number, number>;
}

interface DemandOptions {
  occupancy?: Occupancy;
  awayPeriods?: AwayPeriod[];
  historicalDays?: DemandDay[];
  normalPrediction?: DemandPrediction;
}

interface FuelCellConfigInput {
  fuelCell?: { includeInAdaptiveCharging?: boolean };
}

interface FuelCellForecastOptions {
  temperatureByDay?: Map<string, number>;
  awayPeriods?: AwayPeriod[];
}


export function demandDayCoverage(coverageByBucket: ReadonlyMap<number, number>) {
  const seconds = [...coverageByBucket.values()].reduce(
    (sum, value) => sum + Math.min(1800, Number(value) || 0),
    0,
  );
  const daytimeSeconds = [...coverageByBucket]
    .filter(([bucket]) => bucket >= 12 && bucket < 36)
    .reduce((sum, [, value]) => sum + Math.min(1800, Number(value) || 0), 0);
  return {
    coverage: seconds / (48 * 1800),
    daytimeCoverage: daytimeSeconds / (24 * 1800),
  };
}


export function demandDayBucketMidpoint(day: Pick<DemandDay, "date">, bucket: number): number {
  return new Date(
    day.date.getFullYear(),
    day.date.getMonth(),
    day.date.getDate(),
    Math.floor(bucket / 2),
    bucket % 2 ? 45 : 15,
  ).getTime();
}


export function filterDemandDaysByOccupancy(
  days: readonly DemandDay[],
  awayPeriods: readonly AwayPeriod[] = [],
  occupancy: Occupancy = "home",
): DemandDay[] {
  if (occupancy === "all") return [...days];
  return days.map((day) => {
    const values = new Map([...day.values].filter(([bucket]) => {
      const away = isAwayAt(demandDayBucketMidpoint(day, bucket), awayPeriods);
      return occupancy === "away" ? away : !away;
    }));
    const sourceCoverage = day.coverageByBucket instanceof Map
      ? day.coverageByBucket
      : new Map([...day.values.keys()].map((bucket) => [bucket, 1800]));
    const coverageByBucket = new Map(
      [...sourceCoverage].filter(([bucket]) => values.has(bucket)),
    );
    return {
      ...day,
      ...demandDayCoverage(coverageByBucket),
      coverageByBucket,
      values,
    };
  }).filter((day) => day.values.size > 0);
}


export function aggregateDemandDays(
  samples: readonly DemandSample[],
  { awayPeriods = [], occupancy = "all" }: Pick<DemandOptions, "awayPeriods" | "occupancy"> = {},
): DemandDay[] {
  const days = new Map<string, RawDemandDay>();
  for (const sample of samples) {
    const demand = Number(sample.intervalAveragePowerW?.branchDemandW ?? sample.branchDemandW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) continue;
    const away = isAwayAt(time.getTime(), awayPeriods);
    if ((occupancy === "away" && !away) || (occupancy === "home" && away)) continue;
    const key = localDayKey(time);
    if (!days.has(key)) days.set(key, { key, date: new Date(time.getFullYear(), time.getMonth(), time.getDate()), buckets: new Map() });
    const day = days.get(key)!;
    const index = halfHourIndex(time);
    const seconds = Math.min(1800, Math.max(0,
      Number(sample.powerCoverageSeconds?.branchDemandW
        ?? sample.coverageSeconds?.branchDemandKwh
        ?? sample.expectedIntervalSeconds
        ?? 0),
    ));
    if (seconds <= 0) continue;
    const bucket = day.buckets.get(index) ?? { weightedSum: 0, coverageSeconds: 0 };
    // Only apply the coverage seconds still available in this bucket so the
    // weighted sum and the denominator stay consistent (no double-counting when
    // duplicate/DST samples push past 1800s).
    const appliedSeconds = Math.min(seconds, Math.max(0, 1800 - bucket.coverageSeconds));
    if (appliedSeconds <= 0) continue;
    bucket.weightedSum += demand * appliedSeconds;
    bucket.coverageSeconds += appliedSeconds;
    day.buckets.set(index, bucket);
  }
  return [...days.values()].map((day) => {
    const coverageByBucket = new Map(
      [...day.buckets].map(([index, bucket]) => [index, bucket.coverageSeconds]),
    );
    return {
      ...day,
      ...demandDayCoverage(coverageByBucket),
      coverageByBucket,
      values: new Map([...day.buckets].map(
        ([index, bucket]) => [index, bucket.weightedSum / bucket.coverageSeconds],
      )),
    };
  }).filter((day) => day.values.size > 0);
}


export function monthDistance(left: Date, right: Date): number {
  const raw = Math.abs(left.getMonth() - right.getMonth());
  return Math.min(raw, 12 - raw);
}


export function buildFuelCellGenerationModel(
  config: FuelCellConfigInput,
  samples: readonly DemandSample[] = [],
  now: Date = new Date(),
  options: FuelCellForecastOptions = {},
) {
  const method = "observed";
  const requestedInfluence = config.fuelCell?.includeInAdaptiveCharging ? "active" : "observe";
  const temperatureByDay = options.temperatureByDay instanceof Map ? options.temperatureByDay : new Map();
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const powerSamples = samples.flatMap((sample): Array<{ date: Date; watts: number; state: unknown }> => {
    const date = new Date(sample.timestamp);
    const watts = finiteNumberOrNull(sample.fuelCellPowerW);
    return Number.isNaN(date.getTime()) || watts === null
      ? []
      : [{ date, watts, state: sample.fuelCellGenerationState ?? null }];
  });
  type FuelCellDay = {
    key: string;
    date: Date;
    buckets: Map<number, { sum: number; count: number; states: Map<unknown, number> }>;
  };
  const days = new Map<string, FuelCellDay>();
  for (const sample of powerSamples) {
    const key = localDayKey(sample.date);
    const day: FuelCellDay = days.get(key) ?? {
      key,
      date: new Date(sample.date.getFullYear(), sample.date.getMonth(), sample.date.getDate()),
      buckets: new Map(),
    };
    const bucketIndex = halfHourIndex(sample.date);
    const bucket = day.buckets.get(bucketIndex) ?? { sum: 0, count: 0, states: new Map() };
    bucket.sum += Math.max(0, sample.watts);
    bucket.count += 1;
    if (sample.state) bucket.states.set(sample.state, Number(bucket.states.get(sample.state) ?? 0) + 1);
    day.buckets.set(bucketIndex, bucket);
    days.set(key, day);
  }
  const dailyBuckets = [...days.values()].map((day) => ({
    ...day,
    temperatureC: finiteNumberOrNull(temperatureByDay.get(day.key)),
    away: isAwayAt(new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), 12).getTime(), awayPeriods),
    values: new Map([...day.buckets].map(([index, bucket]) => [index, {
      watts: bucket.sum / bucket.count,
      state: [...bucket.states].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
    }])),
  }));
  const validDays = dailyBuckets.filter((day) => day.buckets.size >= 16);
  const currentDayType = now.getDay() === 0 || now.getDay() === 6;
  const currentAway = isAwayAt(now.getTime(), awayPeriods, { forecast: true });
  const currentTemperature = finiteNumberOrNull(temperatureByDay.get(localDayKey(now)));
  const comparableDays = validDays.filter((day) => {
    const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
    const temperatureMatches = currentTemperature === null ? true : day.temperatureC === null ? false : Math.abs(day.temperatureC - currentTemperature) <= 6;
    return weekend === currentDayType && day.away === currentAway && monthDistance(day.date, now) <= 2 && temperatureMatches;
  });
  const blockers: string[] = [];
  if (validDays.length < 7) blockers.push(`${7 - validDays.length} more valid observation days required`);
  if (comparableDays.length < 4) blockers.push(`${4 - comparableDays.length} more comparable observation days required`);
  const ready = blockers.length === 0;
  const influencesPlanner = requestedInfluence === "active" && ready;
  const latest = powerSamples.at(-1) ?? null;

  const forecastAt = (date: Date) => {
    const bucket = halfHourIndex(date);
    const targetWeekend = date.getDay() === 0 || date.getDay() === 6;
    const targetAway = isAwayAt(date.getTime(), awayPeriods, { forecast: true });
    const targetTemperature = finiteNumberOrNull(temperatureByDay.get(localDayKey(date)));
    let candidates = dailyBuckets.filter((day) => day.values.has(bucket));
    const comparable = candidates.filter((day) => {
      const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
      const temperatureMatches = targetTemperature === null ? true : day.temperatureC === null ? false : Math.abs(day.temperatureC - targetTemperature) <= 6;
      return weekend === targetWeekend && day.away === targetAway && monthDistance(day.date, date) <= 2 && temperatureMatches;
    });
    if (comparable.length >= 4) candidates = comparable;
    if (latest?.state && Math.abs(date.getTime() - now.getTime()) <= 2 * 60 * 60_000) {
      const sameRecentState = candidates.filter((day) => day.values.get(bucket)?.state === latest.state);
      if (sameRecentState.length >= 4) candidates = sameRecentState;
    }
    const values = candidates.map((day) => day.values.get(bucket)?.watts)
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    return {
      p20W: percentile(values, 0.2) ?? 0,
      medianW: median(values) ?? 0,
      p80W: percentile(values, 0.8) ?? 0,
      sampleCount: values.length,
    };
  };
  return {
    method,
    requestedInfluence,
    influence: influencesPlanner ? "active" : "observe",
    ready,
    blockers,
    validObservationDays: validDays.length,
    comparableDays: comparableDays.length,
    recentState: latest?.state ?? null,
    forecastAt,
  };
}


export function calendarDayDistance(left: Date, right: Date): number {
  const normalizedLeft = new Date(2000, left.getMonth(), left.getDate());
  const normalizedRight = new Date(2000, right.getMonth(), right.getDate());
  const distance = Math.abs(normalizedLeft.getTime() - normalizedRight.getTime()) / 86_400_000;
  return Math.min(distance, 366 - distance);
}


export function selectSeasonalDemandDays(
  validDays: readonly DemandDay[],
  target: Date,
  targetIsWeekend: boolean,
  targetTemperature: number,
  temperatureByDay: ReadonlyMap<string, number>,
): ScoredDemandDay[] {
  const byYear = new Map<number, ScoredDemandDay[]>();
  for (const day of validDays) {
    const yearsAgo = target.getFullYear() - day.date.getFullYear();
    if (yearsAgo < 1 || yearsAgo > ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS) continue;
    const calendarDistance = calendarDayDistance(day.date, target);
    if (calendarDistance > ADAPTIVE_CHARGING_SEASONAL_DAY_RANGE) continue;
    const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
    const temperature = Number(temperatureByDay.get(day.key));
    const hasTemperatureMatch = Number.isFinite(targetTemperature) && Number.isFinite(temperature);
    const temperatureDistance = hasTemperatureMatch
      ? Math.abs(targetTemperature - temperature)
      : Number.isFinite(targetTemperature) ? 5 : 0;
    const candidate: ScoredDemandDay = {
      ...day,
      yearsAgo,
      sameDayType,
      calendarDistance,
      temperatureDistance,
      score: calendarDistance * 2 + temperatureDistance * 2 + yearsAgo * 2 + (sameDayType ? 0 : 14),
      weight: (sameDayType ? 1 : 0.35)
        / (1 + calendarDistance / 7 + temperatureDistance + yearsAgo / 2),
    };
    const candidates = byYear.get(day.date.getFullYear()) ?? [];
    candidates.push(candidate);
    byYear.set(day.date.getFullYear(), candidates);
  }
  return [...byYear.values()]
    .flatMap((days) => days.sort((left, right) => left.score - right.score).slice(0, ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR))
    .sort((left, right) => left.score - right.score);
}


export function predictBranchDemand(
  samples: readonly DemandSample[],
  targetDate: Date | string | number = new Date(),
  temperatureByDay: ReadonlyMap<string, number> = new Map(),
  options: DemandOptions = {},
) {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const occupancy = options.occupancy ?? "home";
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const historicalDays = filterDemandDaysByOccupancy(
    Array.isArray(options.historicalDays) ? options.historicalDays : [],
    awayPeriods,
    occupancy,
  );
  const recordedDayMap = new Map<string, DemandDay>(historicalDays.map((day) => [day.key, day]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy })) {
    const existing = recordedDayMap.get(day.key);
    if (!existing || day.coverage >= existing.coverage) recordedDayMap.set(day.key, day);
  }
  const recordedDays = [...recordedDayMap.values()];
  const validDays = recordedDays.filter((day) => day.daytimeCoverage >= 0.8);
  const recentCandidates = validDays
    .map((day): ScoredDemandDay => {
      const ageDays = (target.getTime() - day.date.getTime()) / 86_400_000;
      const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
      const temperature = Number(temperatureByDay.get(day.key));
      const temperatureDistance = Number.isFinite(targetTemperature) && Number.isFinite(temperature)
        ? Math.abs(targetTemperature - temperature)
        : 5;
      const dayTypePenalty = sameDayType ? 0 : 14;
      const baseWeight = 1 / (1 + ageDays / 14 + temperatureDistance);
      return {
        ...day,
        ageDays,
        sameDayType,
        score: dayTypePenalty + temperatureDistance * 2 + ageDays / 14,
        weight: baseWeight * (sameDayType ? 1 : 0.35),
      };
    })
    .filter((day) => Number(day.ageDays) > 0 && Number(day.ageDays) <= 42)
    .sort((left, right) => left.score - right.score)
    .slice(0, 8);
  const seasonalCandidates = selectSeasonalDemandDays(
    validDays,
    target,
    targetIsWeekend,
    targetTemperature,
    temperatureByDay,
  );
  const seasonalYears = [...new Set(seasonalCandidates.map((day) => day.date.getFullYear()))]
    .sort((left, right) => right - left);
  // Let recurring seasonal behavior inform the forecast without allowing an
  // older household pattern to outweigh the most recent six weeks.
  const seasonalBlendWeight = Math.min(0.3, seasonalYears.length * 0.1);
  const profile = new Map<number, number>();
  const lowProfile = new Map<number, number>();
  for (let index = 0; index < 48; index += 1) {
    const recentValue = weightedMedian(recentCandidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index)!, weight: day.weight })));
    const seasonalValue = weightedMedian(seasonalCandidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index)!, weight: day.weight })));
    const value = Number.isFinite(recentValue) && Number.isFinite(seasonalValue)
      ? Number(recentValue) * (1 - seasonalBlendWeight) + Number(seasonalValue) * seasonalBlendWeight
      : recentValue;
    if (value !== null && Number.isFinite(value)) profile.set(index, value);
    const lowValue = percentile(
      recordedDays.filter((day) => day.values.has(index)).map((day) => day.values.get(index)!),
      0.2,
    );
    if (lowValue !== null && Number.isFinite(lowValue)) lowProfile.set(index, lowValue);
  }
  // Fill missing buckets with the profile mean instead of letting the planner
  // read them as zero demand.
  // Capture the observed bucket count before filling, so the availability gate
  // still reflects real coverage.
  const coveredBucketCount = profile.size;
  if (profile.size) {
    const mean = [...profile.values()].reduce((sum, value) => sum + value, 0) / profile.size;
    const lowMean = lowProfile.size ? [...lowProfile.values()].reduce((sum, value) => sum + value, 0) / lowProfile.size : mean;
    for (let index = 0; index < 48; index += 1) {
      if (!profile.has(index)) profile.set(index, mean);
      if (!lowProfile.has(index)) lowProfile.set(index, lowMean);
    }
  }
  return {
    available: validDays.length >= 7 && recentCandidates.length >= 4 && coveredBucketCount >= 39,
    reason: validDays.length < 7
      ? `house-demand history has ${validDays.length} of ${recordedDays.length} days with at least 80% daytime coverage; 7 are required`
      : recentCandidates.length < 4
      ? `only ${recentCandidates.length} usable demand days were found in the previous six weeks; 4 are required`
      : coveredBucketCount < 39
        ? "house-demand history coverage is below 80%"
        : null,
    comparableDays: [...recentCandidates, ...seasonalCandidates].map((day) => day.key),
    recentComparableDays: recentCandidates.map((day) => day.key),
    seasonalComparableDays: seasonalCandidates.map((day) => day.key),
    seasonalYears,
    seasonalBlendWeight,
    sameDayTypeDays: [...recentCandidates, ...seasonalCandidates]
      .filter((day) => day.sameDayType)
      .map((day) => day.key),
    usedDayTypeFallback: [...recentCandidates, ...seasonalCandidates].some((day) => !day.sameDayType),
    recordedDayCount: recordedDays.length,
    validDayCount: validDays.length,
    profile,
    lowProfile,
  };
}


export function predictAwayDemand(
  samples: readonly DemandSample[],
  targetDate: Date | string | number,
  temperatureByDay: ReadonlyMap<string, number>,
  options: DemandOptions = {},
) {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const historicalDays = filterDemandDaysByOccupancy(
    Array.isArray(options.historicalDays) ? options.historicalDays : [],
    awayPeriods,
    "away",
  );
  const recordedDayMap = new Map<string, DemandDay>(historicalDays.map((day) => [day.key, day]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy: "away" })) {
    const existing = recordedDayMap.get(day.key);
    if (!existing || day.coverage >= existing.coverage) recordedDayMap.set(day.key, day);
  }
  const candidates = [...recordedDayMap.values()].map((day): ScoredDemandDay => {
    const ageDays = (target.getTime() - day.date.getTime()) / 86_400_000;
    const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
    const temperature = Number(temperatureByDay.get(day.key));
    const temperatureDistance = Number.isFinite(targetTemperature) && Number.isFinite(temperature)
      ? Math.abs(targetTemperature - temperature)
      : 5;
    const calendarDistance = calendarDayDistance(day.date, target);
    return {
      ...day,
      ageDays,
      sameDayType,
      score: calendarDistance + temperatureDistance * 2 + ageDays / 90 + (sameDayType ? 0 : 10),
      weight: (sameDayType ? 1 : 0.4) / (1 + calendarDistance / 14 + temperatureDistance + ageDays / 365),
    };
  }).filter((day) => Number(day.ageDays) > 0 && Number(day.ageDays) <= ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS * 366)
    .sort((left, right) => left.score - right.score)
    .slice(0, 24);
  const normalPrediction = options.normalPrediction ?? { profile: new Map(), lowProfile: new Map() };
  const profile = new Map<number, number>();
  const learnedBuckets = new Set<number>();
  const fallbackBuckets = new Set<number>();
  for (let index = 0; index < 48; index += 1) {
    const values = candidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index)!, weight: day.weight }));
    const learned = values.length >= AWAY_LEARNED_MIN_DAYS ? weightedMedian(values) : null;
    if (learned !== null && Number.isFinite(learned)) {
      profile.set(index, learned);
      learnedBuckets.add(index);
      continue;
    }
    const normalValue = Number(normalPrediction.profile?.get(index));
    const lowValue = Number(normalPrediction.lowProfile?.get(index));
    const fallback = Number.isFinite(lowValue)
      ? Math.min(lowValue, Number.isFinite(normalValue) ? normalValue : lowValue)
      : Number.isFinite(normalValue)
        ? normalValue * 0.35
        : null;
    if (Number.isFinite(fallback)) {
      profile.set(index, Math.max(0, Number(fallback)));
      fallbackBuckets.add(index);
    }
  }
  return {
    profile,
    learnedBuckets,
    fallbackBuckets,
    comparableDays: candidates.map((day) => day.key),
    recordedDayCount: recordedDayMap.size,
  };
}
