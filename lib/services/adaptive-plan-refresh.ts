import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AwayPeriod } from "../contracts/away-period.js";
import type { AdaptiveChargingState, AdaptivePlan } from "../domain/adaptive-state.js";
import type { DemandDay } from "../domain/demand-forecast.js";
import type { SolarForecastHour } from "../domain/solar-forecast.js";
import { buildAdaptiveChargingPlan } from "../domain/adaptive-planning.js";
import { adaptiveChargingPlanLogMessage, applyInterruptedChargeCap } from "../domain/adaptive-control.js";
import { CURRENT_BACKTEST_MODEL } from "../domain/backtesting.js";
import { numericMetric, sampleFromStatus } from "../domain/telemetry.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";
import type { createAdaptiveHistoryService } from "./adaptive-history-service.js";
import type { createAdaptiveForecastService } from "./adaptive-forecast-service.js";

type AdaptiveHistory = ReturnType<typeof createAdaptiveHistoryService>;
type AdaptiveForecast = ReturnType<typeof createAdaptiveForecastService>;
export interface AdaptivePlanRefreshDecision {
  eventKey?: string | null;
  trigger?: string;
}

export interface PlanSnapshotRecorderInput {
  createdAt: string;
  modelId: string;
  modelVersion: string;
  trigger?: string | null;
  config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh" | "batteryCapabilities" | "adaptiveCharging"> & { settingCache?: ApplicationConfig["settingCache"] };
  plan: AdaptivePlan;
}

export interface AdaptivePlanRefreshDependencies {
  readHistory: AdaptiveHistory["readHistory"];
  historicalWeather(): SolarForecastHour[];
  solarForecastAccuracy: AdaptiveForecast["accuracy"];
  refreshBatteryLearning: AdaptiveHistory["refreshBatteryLearning"];
  readDemandProfileDays: AdaptiveHistory["readDemandProfileDays"];
  recordFuelCellPlanForecast(plan: AdaptivePlan | null, now?: Date): number;
  recordPlanSnapshot?(input: PlanSnapshotRecorderInput): number;
  appendLog: typeof import("../domain/adaptive-state.js").appendAdaptiveChargingLog;
}

export async function refreshAdaptivePlan(
  state: AdaptiveChargingState,
  config: ApplicationConfig,
  status: AdaptiveEvaluationStatus | null,
  awayPeriods: AwayPeriod[],
  decision: AdaptivePlanRefreshDecision,
  now: Date,
  dependencies: AdaptivePlanRefreshDependencies,
): Promise<AdaptiveChargingState> {
  const samples = await dependencies.readHistory(now);
  const liveSoc = status ? numericMetric(status.energy?.battery?.remaining_percent) : null;
  if (status) {
    samples.push({
      timestamp: now.toISOString(),
      stateOfChargePercent: liveSoc,
      batteryPowerW: numericMetric(status.energy?.battery?.instant_power),
      solarPowerW: numericMetric(status.energy?.solar?.instant_power),
      branchDemandW: numericMetric(status.meter?.branch_demand_power),
    });
    if (config.fuelCellEnabled !== false) {
      const liveSample = sampleFromStatus(status, config);
      // Keep the source observation time: a cached status must not make an
      // old tank reading look fresh merely because the plan was refreshed.
      samples.push({
        timestamp: typeof status.read_at === "string" ? status.read_at : now.toISOString(),
        fuelCellPowerW: liveSample.fuelCellPowerW,
        fuelCellGenerationState: liveSample.fuelCellGenerationState,
        fuelCellHotWaterLevel: liveSample.fuelCellHotWaterLevel,
      });
    }
  }
  state = {
    ...state,
    historicalWeather: dependencies.historicalWeather(),
    solarForecastAccuracy: dependencies.solarForecastAccuracy(now),
  };
  await dependencies.refreshBatteryLearning(config, state, now);
  const historicalDemandDays: DemandDay[] = await dependencies.readDemandProfileDays();
  state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
  dependencies.recordFuelCellPlanForecast(state.plan, now);
  state.lastPlanEventKey = decision.eventKey ?? null;
  state.pendingPlanReason = null;
  state.pendingPlanRequestId = null;
  state.pendingPlanRequestedAt = null;
  if (state.interruptedCharge) {
    const capped = applyInterruptedChargeCap(
      state.plan,
      state.interruptedCharge,
      config.batteryCapabilities.maximumChargeWatts,
      now,
    );
    state.plan = capped.plan;
    state.interruptedCharge = capped.interruption;
  }
  if (state.plan) {
    dependencies.recordPlanSnapshot?.({
      createdAt: now.toISOString(),
      modelId: CURRENT_BACKTEST_MODEL.id,
      modelVersion: CURRENT_BACKTEST_MODEL.version,
      trigger: decision.trigger,
      config: {
        rateBands: config.rateBands,
        standardRateYenPerKwh: config.standardRateYenPerKwh,
        batteryCapabilities: config.batteryCapabilities,
        adaptiveCharging: config.adaptiveCharging,
        settingCache: config.settingCache,
      },
      plan: state.plan,
    });
  }
  dependencies.appendLog(
    state,
    adaptiveChargingPlanLogMessage(state.plan, decision.trigger ?? "scheduled", liveSoc ?? state.plan?.currentSocPercent ?? null),
    state.plan?.warning ? "warning" : "plan",
    now,
  );
  return state;
}
