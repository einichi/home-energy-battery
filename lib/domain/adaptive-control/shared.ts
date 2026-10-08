import type { AdaptiveChargeSlot, adaptiveChargingBreakerSettings } from "../adaptive-planning.js";
import type { AutomationStatus } from "../automation-rules.js";
import type { AdaptiveChargingState, AdaptivePlan, AdaptivePlanWindow, ActiveChargeSession, BreakerRecovery, ExportConfirmation, InterruptedCharge } from "../adaptive-state.js";
import type { ApplicationConfig } from "../../contracts/configuration.js";

export const ADAPTIVE_CHARGING_PREWINDOW_MS = 30 * 60_000;
export const ADAPTIVE_CHARGING_SLOT_MS = 30 * 60_000;
export const ADAPTIVE_CHARGING_SOLAR_REPLAN_MS = 5 * 60_000;
export const ADAPTIVE_CHARGING_MIN_SOLAR_WH = 100;
export const ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_WH = 50;
export const ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_W = 200;
export const ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS = 3 * 60_000;
export const ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS = 3;
export const ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS = 2;
export const ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS = 2;
export const ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS = 3;
export const ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W = 50;
export const ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W = 200;
export const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = 5 * 60_000;
export const ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH = 50;

export type ControlConfig = Pick<ApplicationConfig,
  "adaptiveCharging" | "solarEnabled" | "rateMode" | "rateBands" | "standardRateYenPerKwh" | "batteryCapabilities"
> & Record<string, unknown>;

export type ControlStatus = AutomationStatus & {
  energy?: AutomationStatus["energy"] & {
    solar?: { instant_power?: { value?: unknown } };
    fuel_cells?: Array<{
      source_role?: string;
      host?: string;
      instant_power?: { value?: unknown };
      generation_status?: { value?: unknown };
    }>;
  };
  meter?: AutomationStatus["meter"] & { grid_export_power?: { value?: unknown } };
};

export interface ChargeHeadroom {
  available: boolean;
  gridImportW: number;
  maximumChargeWatts: number;
  chargeWatts: number;
  learnedChargeWatts: number | null;
  breakerLimitW: number;
  safetyMarginW: number;
  thresholdW: number;
  breakerSettings: ReturnType<typeof adaptiveChargingBreakerSettings>;
}

export interface ExportEvidence {
  aboveThreshold: boolean;
  balanceAvailable: boolean;
  coherent: boolean;
  gridExportW: number | null;
  residualW: number | null;
  gridImportW?: number | null;
  branchDemandW?: number | null;
  batteryChargingW?: number | null;
  solarW?: number | null;
  fuelCellW?: number | null;
  expectedGridW?: number | null;
  measuredGridW?: number | null;
  toleranceW?: number | null;
}

export type SlotLike = Partial<AdaptiveChargeSlot>;
export type WindowLike = Partial<AdaptivePlanWindow>;
export interface PlanLike {
  available?: boolean;
  reason?: string | null;
  warning?: string | null;
  createdAt?: string;
  forecastFetchedAt?: string | null;
  plannedChargeKwh?: number;
  plannedStoredChargeKwh?: number;
  requiredGridChargeKwh?: number;
  predictedSolarKwh?: number;
  predictedDemandKwh?: number;
  predictedFuelCellKwh?: number;
  chargePerformance?: { effectiveWatts?: number };
  batteryModel?: AdaptivePlan["batteryModel"];
  demandHistory?: AdaptivePlan["demandHistory"];
  fuelCellModel?: AdaptivePlan["fuelCellModel"];
  slots?: SlotLike[];
  windows?: WindowLike[];
  timeline?: Array<{
    start?: string;
    end?: string;
    solarW?: number;
    fuelCellP20W?: number;
    demandW?: number;
  }>;
}
export interface StateLike {
  plan?: PlanLike | null;
  forecast?: { fetchedAt?: string } | null;
  owner?: "adaptiveCharging" | null;
  activeSlot?: SlotLike | null;
  activePlanCreatedAt?: string | null;
  activeChargedKwh?: number;
  activeChargeSession?: Partial<ActiveChargeSession> | null;
  interruptedCharge?: Partial<InterruptedCharge> | null;
  breakerRecovery?: Partial<BreakerRecovery> | null;
  batteryLearning?: AdaptiveChargingState["batteryLearning"];
  lastPlanEventKey?: string | null;
  pendingPlanReason?: string | null;
  pendingPlanRequestId?: string | null;
  pendingPlanRequestedAt?: string | null;
  solarHeadroomHoldUntil?: string | null;
  solarHeadroomClearChecks?: number;
  exportConfirmation?: Partial<ExportConfirmation>;
  lastHeadroomWaitLogAt?: string | null;
  log?: AdaptiveChargingState["log"];
  updatedAt?: string;
}
export type CommandExecutor = (action: string, payload: Record<string, unknown>) => Promise<unknown>;
