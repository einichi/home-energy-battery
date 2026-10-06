import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BacktestCaseInput, BacktestOutcome } from "../contracts/backtesting.js";
import type { HistorySample } from "../contracts/history.js";
import type { AdaptivePlan } from "./adaptive-state.js";
import { rateForTimestamp } from "./tariffs.js";

export const BACKTEST_ENGINE_VERSION = 1;
export const CURRENT_BACKTEST_MODEL = Object.freeze({
  id: "adaptive-planner",
  version: "1",
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

function plannedChargeForSample(sample: HistorySample, plan: AdaptivePlan): number {
  return (plan.slots ?? []).reduce((sum, slot) => sum + Math.max(0, finite(slot.targetWh) ?? 0) / 1000
    * overlapFraction(sample, slot.start, slot.end), 0);
}

export function simulateModelOnlyExecution(
  plan: AdaptivePlan,
  samples: HistorySample[],
  config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh" | "batteryCapabilities"> & { settingCache?: ApplicationConfig["settingCache"] },
): BacktestOutcome["modelOnly"] {
  if (!samples.length) return null;
  const capacityKwh = finite(config.batteryCapabilities?.usableCapacityKwh);
  const startSoc = firstFinite(samples, ["startStateOfChargePercent", "stateOfChargePercent"]);
  if (capacityKwh === null || capacityKwh <= 0 || startSoc === null) return null;
  const floor = reserveFloor(config);
  const chargeToStoredRatio = Math.max(0.5, Math.min(1, finite(plan.batteryModel?.chargeToStoredRatio) ?? 1));
  let storedKwh = capacityKwh * startSoc / 100;
  let reserveViolation = false;
  let gridCostYen = 0;
  for (const sample of samples) {
    const demand = Math.max(0, finite(sample.houseDemandKwh) ?? 0);
    const solar = Math.max(0, finite(sample.solarGenerationKwh) ?? 0);
    const fuelCell = Math.max(0, finite(sample.fuelCellKwh) ?? 0);
    const forcedCharge = plannedChargeForSample(sample, plan);
    let netGridKwh = demand + forcedCharge - solar - fuelCell;
    if (forcedCharge > 0) {
      storedKwh = Math.min(capacityKwh, storedKwh + forcedCharge * chargeToStoredRatio);
    } else if (netGridKwh > 0) {
      const available = Math.max(0, storedKwh - capacityKwh * floor / 100);
      const discharged = Math.min(available, netGridKwh);
      storedKwh -= discharged;
      netGridKwh -= discharged;
    } else if (netGridKwh < 0) {
      const charged = Math.min(capacityKwh - storedKwh, -netGridKwh * chargeToStoredRatio);
      storedKwh += charged;
      netGridKwh += charged / chargeToStoredRatio;
    }
    const timestamp = sample.rollupStart ?? sample.timestamp;
    const rate = rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh).yenPerKwh;
    gridCostYen += Math.max(0, netGridKwh) * rate;
    reserveViolation ||= storedKwh <= capacityKwh * floor / 100 + 0.0001;
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

export function evaluateBacktestCase({ snapshot, samples }: BacktestCaseInput): BacktestOutcome {
  const plan = snapshot.plan;
  const horizonEnd = String(plan.targetSunset ?? plan.timeline?.at(-1)?.end ?? snapshot.createdAt);
  const expectedSeconds = Math.max(0, new Date(horizonEnd).getTime() - new Date(snapshot.createdAt).getTime()) / 1000;
  const demandCoverage = samples.reduce((sum, sample) => sum + (finite(sample.coverageSeconds?.houseDemandKwh) ?? 0), 0);
  const evaluable = samples.length > 0 && expectedSeconds > 0 && demandCoverage >= expectedSeconds * 0.8;
  const actualSolar = energy(samples, "solarGenerationKwh");
  const actualDemand = energy(samples, "houseDemandKwh");
  const actualFuelCell = energy(samples, "fuelCellKwh");
  const endingSoc = lastFinite(samples, ["endStateOfChargePercent", "stateOfChargePercent"]);
  const minimumSoc = Math.min(...samples.map((sample) => finite(sample.minimumStateOfChargePercent ?? sample.stateOfChargePercent)).filter((value): value is number => value !== null));
  const floor = reserveFloor(snapshot.config);
  const target = finite(plan.expectedSunsetSocPercent ?? plan.targetSocPercent);
  return {
    planKey: `${snapshot.createdAt}:${snapshot.id}`,
    evaluationAt: snapshot.createdAt,
    horizonEnd,
    season: seasonAt(snapshot.createdAt),
    evaluable,
    exclusionReason: evaluable ? null : "At least 80% demand coverage and a completed plan horizon are required.",
    exactReplay: true,
    assumptions: [
      "As-operated uses recorded grid import and SOC.",
      "Model-only replays the recorded plan against recorded demand and generation with ideal command delivery.",
      "Tariff and equipment configuration are captured when the plan is created.",
    ],
    components: {
      solar: component(predicted(plan, "predictedSolarKwh"), actualSolar),
      demand: component(predicted(plan, "predictedDemandKwh"), actualDemand),
      fuelCell: component(predicted(plan, "predictedFuelCellKwh"), actualFuelCell),
    },
    asOperated: evaluable ? {
      gridCostYen: actualGridCost(samples, snapshot.config),
      targetMet: target === null || endingSoc === null ? null : endingSoc >= target - 1,
      reserveViolation: Number.isFinite(minimumSoc) && minimumSoc <= floor,
      endingSocPercent: endingSoc,
    } : null,
    modelOnly: evaluable ? simulateModelOnlyExecution(plan, samples, snapshot.config) : null,
  };
}
