import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BacktestCaseInput, BacktestOutcome } from "../contracts/backtesting.js";
import type { HistorySample } from "../contracts/history.js";
import type { AdaptivePlan } from "./adaptive-state.js";
import { rateForTimestamp } from "./tariffs.js";
import { adaptiveChargingWindowSolarOpportunity } from "./adaptive-control/solar.js";

export const BACKTEST_ENGINE_VERSION = 2;
export const CURRENT_BACKTEST_MODEL = Object.freeze({
  id: "adaptive-planner",
  version: "2",
  label: "Current Adaptive Charging planner",
});

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function energy(samples: HistorySample[], key: keyof HistorySample): number | null {
  const values = samples.map((sample) => finite(sample[key])).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function seasonAt(value: string): BacktestOutcome["season"] {
  const month = new Date(value).getMonth() + 1;
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

function firstFinite(samples: HistorySample[], keys: string[]): number | null {
  for (const sample of samples) {
    for (const key of keys) {
      const value = finite(sample[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function lastFinite(samples: HistorySample[], keys: string[]): number | null {
  return firstFinite([...samples].reverse(), keys);
}

function predicted(plan: AdaptivePlan, key: keyof AdaptivePlan): number | null {
  return finite(plan[key]);
}

function reserveFloor(config: { settingCache?: ApplicationConfig["settingCache"] }): number {
  return Math.max(0, Math.min(100, finite(config.settingCache?.discharge_limit?.lastKnown?.decoded?.percent) ?? 0));
}

function component(predictedKwh: number | null, actualKwh: number | null) {
  return {
    predictedKwh,
    actualKwh,
    errorKwh: predictedKwh === null || actualKwh === null ? null : actualKwh - predictedKwh,
  };
}

function predictedTimelineEnergy(plan: AdaptivePlan, key: "demandW" | "solarW" | "fuelCellMedianW", start: string, end: string): number | null {
  if (!plan.timeline?.length) return null;
  let total = 0;
  let cursor = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  for (const slot of plan.timeline) {
    const slotStart = new Date(slot.start).getTime();
    const slotEnd = new Date(slot.end).getTime();
    const overlapMs = Math.max(0, Math.min(slotEnd, endMs) - Math.max(slotStart, cursor));
    if (!overlapMs) continue;
    const watts = finite(slot[key]);
    if (key === "fuelCellMedianW" && slot.fuelCellSampleCount === 0) return null;
    if (watts === null || slotStart > cursor) return null;
    total += watts * overlapMs / 3_600_000 / 1000;
    cursor = Math.min(slotEnd, endMs);
  }
  return cursor >= endMs ? total : null;
}

function actualGridCost(samples: HistorySample[], config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh">): number {
  return samples.reduce((sum, sample) => {
    const imported = finite(sample.gridImportKwh) ?? 0;
    const timestamp = sample.rollupStart ?? sample.timestamp;
    const recordedRate = finite(sample.rateYenPerKwh);
    const rate = recordedRate ?? rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh).yenPerKwh;
    return sum + imported * rate;
  }, 0);
}

function overlapFraction(sample: HistorySample, start: string, end: string): number {
  const sampleStart = new Date(sample.rollupStart ?? sample.timestamp ?? "").getTime();
  const sampleEnd = new Date(sample.rollupEnd ?? sample.timestamp ?? "").getTime();
  const slotStart = new Date(start).getTime();
  const slotEnd = new Date(end).getTime();
  const duration = sampleEnd - sampleStart;
  if (![sampleStart, sampleEnd, slotStart, slotEnd].every(Number.isFinite) || duration <= 0) return 0;
  return Math.max(0, Math.min(sampleEnd, slotEnd) - Math.max(sampleStart, slotStart)) / duration;
}

function clipSample(sample: HistorySample, start: string, end: string): HistorySample | null {
  const startMs = new Date(sample.rollupStart ?? sample.timestamp ?? "").getTime();
  const endMs = new Date(sample.rollupEnd ?? sample.timestamp ?? "").getTime();
  const clipStart = Math.max(startMs, new Date(start).getTime());
  const clipEnd = Math.min(endMs, new Date(end).getTime());
  const duration = endMs - startMs;
  if (![startMs, endMs, clipStart, clipEnd].every(Number.isFinite) || duration <= 0 || clipEnd <= clipStart) return null;
  const fraction = (clipEnd - clipStart) / duration;
  const clipped = { ...sample, rollupStart: new Date(clipStart).toISOString(), rollupEnd: new Date(clipEnd).toISOString() } as HistorySample;
  if (clipStart > startMs) delete clipped.startStateOfChargePercent;
  if (clipEnd < endMs) delete clipped.endStateOfChargePercent;
  if (clipStart > startMs || clipEnd < endMs) {
    delete clipped.stateOfChargePercent;
    delete clipped.minimumStateOfChargePercent;
    const observedAt = new Date(sample.timestamp ?? "").getTime();
    if (!Number.isFinite(observedAt) || observedAt < clipStart || observedAt > clipEnd) delete clipped.endStateOfChargePercent;
  }
  for (const key of ["branchDemandKwh", "solarGenerationKwh", "fuelCellKwh", "gridImportKwh"] as const) {
    const value = finite(sample[key]);
    if (value !== null) (clipped as Record<string, unknown>)[key] = value * fraction;
  }
  if (sample.coverageSeconds) {
    const coverage: Record<string, number> = {};
    for (const [key, raw] of Object.entries(sample.coverageSeconds)) {
      const seconds = finite(raw) ?? 0;
      coverage[key] = Math.min((clipEnd - clipStart) / 1000, seconds * fraction);
    }
    clipped.coverageSeconds = coverage;
  }
  return clipped;
}

function nonOverlappingSamples(samples: HistorySample[]): HistorySample[] {
  const ordered = [...samples].sort((left, right) => {
    const leftDuration = new Date(left.rollupEnd ?? left.timestamp ?? "").getTime() - new Date(left.rollupStart ?? left.timestamp ?? "").getTime();
    const rightDuration = new Date(right.rollupEnd ?? right.timestamp ?? "").getTime() - new Date(right.rollupStart ?? right.timestamp ?? "").getTime();
    return leftDuration - rightDuration || new Date(left.rollupStart ?? left.timestamp ?? "").getTime() - new Date(right.rollupStart ?? right.timestamp ?? "").getTime();
  });
  const accepted: HistorySample[] = [];
  const occupied: Array<[number, number]> = [];
  for (const sample of ordered) {
    const start = new Date(sample.rollupStart ?? sample.timestamp ?? "").getTime();
    const end = new Date(sample.rollupEnd ?? sample.timestamp ?? "").getTime();
    let fragments: Array<[number, number]> = [[start, end]];
    for (const [takenStart, takenEnd] of occupied) {
      fragments = fragments.flatMap(([fragmentStart, fragmentEnd]) => {
        if (takenEnd <= fragmentStart || takenStart >= fragmentEnd) return [[fragmentStart, fragmentEnd]];
        return [
          ...(takenStart > fragmentStart ? [[fragmentStart, takenStart] as [number, number]] : []),
          ...(takenEnd < fragmentEnd ? [[takenEnd, fragmentEnd] as [number, number]] : []),
        ];
      });
    }
    for (const [fragmentStart, fragmentEnd] of fragments) {
      const fragment = clipSample(sample, new Date(fragmentStart).toISOString(), new Date(fragmentEnd).toISOString());
      if (!fragment) continue;
      accepted.push(fragment);
      occupied.push([fragmentStart, fragmentEnd]);
    }
  }
  return accepted.sort((left, right) => new Date(left.rollupStart ?? left.timestamp ?? "").getTime() - new Date(right.rollupStart ?? right.timestamp ?? "").getTime());
}

function plannedChargeForSample(sample: HistorySample, plan: AdaptivePlan): number {
  const sampleDuration = new Date(sample.rollupEnd ?? "").getTime() - new Date(sample.rollupStart ?? "").getTime();
  return (plan.slots ?? []).reduce((sum, slot) => {
    const slotDuration = new Date(slot.end).getTime() - new Date(slot.start).getTime();
    return sum + (slotDuration > 0 ? Math.max(0, finite(slot.targetWh) ?? 0) / 1000
      * overlapFraction(sample, slot.start, slot.end) * sampleDuration / slotDuration : 0);
  }, 0);
}

export function simulateModelOnlyExecution(
  plan: AdaptivePlan,
  samples: HistorySample[],
  config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh" | "batteryCapabilities"> & { settingCache?: ApplicationConfig["settingCache"] },
): BacktestOutcome["modelOnly"] {
  if (!samples.length) return null;
  const capacityKwh = finite(plan.batteryModel?.capacityKwh) ?? finite(config.batteryCapabilities?.usableCapacityKwh);
  const startSoc = firstFinite(samples, ["startStateOfChargePercent", "stateOfChargePercent"]);
  if (capacityKwh === null || capacityKwh <= 0 || startSoc === null) return null;
  const floor = reserveFloor(config);
  const chargeToStoredRatio = Math.max(0.5, Math.min(1.5, finite(plan.batteryModel?.chargeToStoredRatio) ?? 1));
  let storedKwh = capacityKwh * startSoc / 100;
  let reserveViolation = false;
  let gridCostYen = 0;
  const maximumChargeWatts = finite(plan.batteryModel?.power?.effectiveWatts)
    ?? finite(config.batteryCapabilities?.maximumChargeWatts) ?? 0;
  const executionSamples = samples.flatMap((sample) => {
    const start = new Date(sample.rollupStart ?? "").getTime();
    const end = new Date(sample.rollupEnd ?? "").getTime();
    const boundaries = [...new Set([start, end, ...(plan.slots ?? []).flatMap((slot) => [
      new Date(slot.start).getTime(), new Date(slot.end).getTime(),
    ]), ...(plan.windows ?? []).flatMap((window) => [new Date(window.start).getTime(), new Date(window.end).getTime()])])]
      .filter((at) => Number.isFinite(at) && at >= start && at <= end).sort((left, right) => left - right);
    return boundaries.slice(0, -1).map((at, index) => clipSample(sample, new Date(at).toISOString(), new Date(boundaries[index + 1]!).toISOString()))
      .filter((segment): segment is HistorySample => segment !== null);
  });
  for (const sample of executionSamples) {
    const demand = Math.max(0, finite(sample.branchDemandKwh) ?? 0);
    const solar = Math.max(0, finite(sample.solarGenerationKwh) ?? 0);
    const fuelCell = Math.max(0, finite(sample.fuelCellKwh) ?? 0);
    const forcedCharge = plannedChargeForSample(sample, plan);
    const startMs = new Date(sample.rollupStart ?? "").getTime();
    const durationHours = (new Date(sample.rollupEnd ?? "").getTime() - startMs) / 3_600_000;
    const window = plan.windows?.find((candidate) => new Date(candidate.start).getTime() <= startMs && new Date(candidate.end).getTime() > startMs);
    const chargingStarted = window && plan.slots.some((slot) => slot.windowEnd === window.end && new Date(slot.start).getTime() <= startMs);
    const holdStandby = Boolean(window && (chargingStarted || !adaptiveChargingWindowSolarOpportunity(plan, window).available));
    let netGridKwh = demand + forcedCharge - solar - fuelCell;
    if (forcedCharge > 0) {
      storedKwh = Math.min(capacityKwh, storedKwh + forcedCharge * chargeToStoredRatio);
    } else if (netGridKwh > 0 && !holdStandby) {
      const reserveKwh = capacityKwh * floor / 100;
      const available = Math.max(0, storedKwh - reserveKwh);
      // A reserve breach is when the plan's demand requires discharging below the
      // reserve floor, not merely reaching it (the simulation clamps to the floor).
      if (netGridKwh > available + 1e-9) reserveViolation = true;
      const discharged = Math.min(available, netGridKwh);
      storedKwh -= discharged;
      netGridKwh -= discharged;
    } else if (netGridKwh < 0 && !holdStandby) {
      const charged = Math.min(capacityKwh - storedKwh, -netGridKwh * chargeToStoredRatio,
        maximumChargeWatts * Math.max(0, durationHours) / 1000 * chargeToStoredRatio);
      storedKwh += charged;
      netGridKwh += charged / chargeToStoredRatio;
    }
    const timestamp = sample.rollupStart ?? sample.timestamp;
    const rate = rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh).yenPerKwh;
    gridCostYen += Math.max(0, netGridKwh) * rate;
  }
  const endingSocPercent = storedKwh / capacityKwh * 100;
  const target = finite(plan.expectedSunsetSocPercent ?? plan.targetSocPercent);
  return {
    gridCostYen,
    targetMet: target === null ? null : endingSocPercent >= target - 1,
    reserveViolation,
    endingSocPercent,
  };
}

export function evaluateBacktestCase({ snapshot, samples, now = new Date() }: BacktestCaseInput): BacktestOutcome {
  const plan = snapshot.plan;
  const horizonEnd = String(plan.targetSunset ?? plan.timeline?.at(-1)?.end ?? snapshot.createdAt);
  const periodStart = snapshot.createdAt;
  const clippedSamples = nonOverlappingSamples(samples.map((sample) => clipSample(sample, periodStart, horizonEnd))
    .filter((sample): sample is HistorySample => sample !== null));
  const expectedSeconds = Math.max(0, new Date(horizonEnd).getTime() - new Date(periodStart).getTime()) / 1000;
  const hasCoverage = (key: string) => expectedSeconds > 0 && clippedSamples.reduce((sum, sample) =>
    sum + (finite(sample.coverageSeconds?.[key]) ?? 0), 0) >= expectedSeconds * 0.8;
  const versionSupported = snapshot.modelVersion === CURRENT_BACKTEST_MODEL.version;
  const complete = new Date(horizonEnd).getTime() <= now.getTime();
  const evaluable = versionSupported && plan.available !== false && complete && hasCoverage("branchDemandKwh");
  const actualSolar = snapshot.config.solarEnabled === false ? 0
    : hasCoverage("solarGenerationKwh") ? energy(clippedSamples, "solarGenerationKwh") : null;
  const actualDemand = evaluable ? energy(clippedSamples, "branchDemandKwh") : null;
  const actualFuelCell = snapshot.config.fuelCellEnabled === false ? 0
    : hasCoverage("fuelCellKwh") ? energy(clippedSamples, "fuelCellKwh") : null;
  const endpointSamples = clippedSamples.filter((sample) => {
    const at = new Date(sample.timestamp ?? sample.rollupEnd ?? "").getTime();
    return at <= new Date(horizonEnd).getTime() && at >= new Date(horizonEnd).getTime() - 5 * 60_000;
  });
  const endingSoc = lastFinite(endpointSamples, ["endStateOfChargePercent", "stateOfChargePercent"]);
  const minimumSoc = Math.min(...clippedSamples.map((sample) => finite(sample.minimumStateOfChargePercent ?? sample.stateOfChargePercent)).filter((value): value is number => value !== null));
  const floor = reserveFloor(snapshot.config);
  const target = finite(plan.expectedSunsetSocPercent ?? plan.targetSocPercent);
  const planningSolar = predictedTimelineEnergy(plan, "solarW", periodStart, horizonEnd);
  const margin = Math.max(0, Math.min(100, finite(snapshot.config.adaptiveCharging?.forecastMarginPercent) ?? 0)) / 100;
  const rawSolarPrediction = planningSolar === null
    ? (plan.timeline?.length ? null : predicted(plan, "forecastSolarKwh") ?? predicted(plan, "predictedSolarKwh"))
    : margin < 1 ? planningSolar / (1 - margin) : null;
  const modelCovered = actualDemand !== null && actualSolar !== null && actualFuelCell !== null;
  return {
    planKey: `${snapshot.createdAt}:${snapshot.id}`,
    evaluationAt: snapshot.createdAt,
    horizonEnd,
    season: seasonAt(snapshot.createdAt),
    evaluable,
    exclusionReason: evaluable ? null : !versionSupported
      ? `Plan snapshot model version ${snapshot.modelVersion} is not supported by this scoring engine.`
      : "At least 80% demand coverage and a completed plan horizon are required.",
    exactReplay: versionSupported && complete,
    assumptions: [
      "As-operated uses recorded grid import and SOC.",
      "Model-only replays the recorded plan against recorded demand and generation with ideal command delivery.",
      "Tariff and equipment configuration are captured when the plan is created.",
    ],
    components: {
      solar: component(rawSolarPrediction, actualSolar),
      demand: component(plan.timeline?.length ? predictedTimelineEnergy(plan, "demandW", periodStart, horizonEnd) : predicted(plan, "predictedDemandKwh"), actualDemand),
      fuelCell: component(plan.timeline?.length ? predictedTimelineEnergy(plan, "fuelCellMedianW", periodStart, horizonEnd) : predicted(plan, "predictedFuelCellKwh"), actualFuelCell),
    },
    asOperated: evaluable && hasCoverage("gridImportKwh") ? {
      gridCostYen: actualGridCost(clippedSamples, snapshot.config),
      targetMet: target === null || endingSoc === null ? null : endingSoc >= target - 1,
      reserveViolation: Number.isFinite(minimumSoc) && minimumSoc < floor,
      endingSocPercent: endingSoc,
    } : null,
    modelOnly: evaluable && modelCovered ? simulateModelOnlyExecution(plan, clippedSamples, snapshot.config) : null,
  };
}
