import { effectiveBatteryLearningModel } from "./battery-learning.js";
import type { DemandDay, DemandSample } from "./demand-forecast.js";
import type { GuardDeliverabilityModel, GuardWindowOutcome } from "./guard-deliverability.js";
import type { ApplicationConfig, RateBand } from "../contracts/configuration.js";
import type { AwayPeriod } from "./time.js";
import type { SolarForecast, SolarForecastAccuracy, SolarForecastHour } from "./solar-forecast.js";

export interface AdaptiveTimelineSlot {
  startMs: number;
  endMs: number;
  demandW?: number;
  solarKwh?: number;
  fuelCellP20Kwh?: number;
  fuelCellMedianKwh?: number;
  fuelCellP80Kwh?: number;
  fuelCellSampleCount?: number;
  demandKwh?: number;
  netKwh: number;
  highSolarNetKwh?: number;
  band: (Pick<RateBand, "label" | "yenPerKwh"> & Partial<RateBand>) | null;
  rateWindowStartMs?: number | null;
  rateWindowEndMs?: number | null;
  chargeCapacityKwh: number;
  away?: boolean;
  awayDemandConfidence?: string | null;
}

export interface AdaptiveChargeSlot {
  [key: string]: unknown;
  slotId?: string;
  start: string;
  end: string;
  yenPerKwh?: number;
  label?: string;
  demandW?: number;
  targetWh: number;
  windowStart?: string;
  windowEnd?: string;
  targetSocPercent?: number;
  modeledDurationMs?: number;
  timingReserveMs?: number;
  schedulingWatts?: number;
  schedulingSource?: string;
  unvalidatedTaper?: boolean;
  continuousWindowCharge?: boolean;
}
export interface AdaptiveWindowPlan {
  start: string;
  end: string;
  planningStart: string;
  planningEnd: string;
  label: string;
  yenPerKwh: number;
  storedAtStartKwh: number;
  predictedStartSocPercent: number | null;
  predictedEndStoredKwh: number;
  predictedEndSocPercent: number | null;
  baseTargetStoredKwh: number;
  maximumTargetStoredKwh: number;
  targetStoredKwh: number;
  targetSocPercent: number | null;
  solarHeadroomKwh: number;
  bridgeToCheaperWindow: boolean;
  economic: boolean;
  backfillForLaterKwh: number;
  requestedChargeKwh: number;
  availableChargeKwh: number;
  plannedChargeKwh: number;
  plannedStoredChargeKwh: number;
  unmetChargeKwh: number;
  unmetStoredChargeKwh: number;
  modeledChargeDurationMs: number;
  timingReserveMs: number;
  schedulingWatts: number;
  schedulingSource: string;
  unvalidatedTaper: boolean;
  timeConstrainedWh: number;
  guardDeliverability: GuardDeliverabilityModel;
}

export interface ChronologicalPlan {
  slots: AdaptiveChargeSlot[];
  windows: AdaptiveWindowPlan[];
  plannedChargeKwh: number;
  plannedStoredChargeKwh: number;
  requiredGridChargeKwh: number;
  unmetChargeKwh: number;
  unmetStoredChargeKwh: number;
  timeConstrainedWh: number;
  expectedEndStoredKwh: number;
}
export interface AdaptivePlanningState {
  forecast: SolarForecast | null;
  historicalWeather?: SolarForecastHour[];
  solarForecastAccuracy?: SolarForecastAccuracy & { sampleCount?: number; measuredFactor?: unknown };
  standbyHoldUntil?: string | null;
  windowSummaries?: GuardWindowOutcome[];
  owner?: string | null;
  activeSlot?: { windowEnd?: string } | null;
  batteryLearning?: NonNullable<Parameters<typeof effectiveBatteryLearningModel>[1]>["batteryLearning"];
  chargingPerformance?: NonNullable<Parameters<typeof effectiveBatteryLearningModel>[1]>["chargingPerformance"];
}
export interface AdaptiveTimelineViewEntry {
  start: string;
  end: string;
  solarW: number;
  fuelCellP20W: number;
  fuelCellMedianW: number;
  fuelCellP80W: number;
  fuelCellSampleCount: number;
  demandW: number;
  predictedStartSocPercent: number | null;
  predictedEndSocPercent: number | null;
  predictedSocPercent: number | null;
  discounted: boolean;
  rateLabel: string | null;
  yenPerKwh: number | null;
  plannedChargeWh: number;
  predictedStoredChargeWh: number;
  away: boolean;
  awayDemandConfidence: string | null;
}
export interface PlanningInput {
  config: ApplicationConfig;
  state: AdaptivePlanningState;
  samples: DemandSample[];
  historicalDemandDays?: DemandDay[];
  awayPeriods?: AwayPeriod[];
  now?: Date;
}
