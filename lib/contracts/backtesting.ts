import type { ApplicationConfig } from "./configuration.js";
import type { HistorySample } from "./history.js";
import type { AdaptivePlan } from "../domain/adaptive-state.js";
import type {
  BacktestMode,
  BacktestRange,
  BacktestRunSummary,
} from "../../shared/api-contracts.js";

export interface AdaptivePlanSnapshot {
  id: number;
  createdAt: string;
  modelId: string;
  modelVersion: string;
  trigger: string | null;
  config: Pick<ApplicationConfig,
    | "rateBands"
    | "standardRateYenPerKwh"
    | "batteryCapabilities"
    | "adaptiveCharging"
  > & { settingCache?: ApplicationConfig["settingCache"] };
  plan: AdaptivePlan;
}

export interface BacktestOutcome {
  planKey: string;
  evaluationAt: string;
  horizonEnd: string;
  season: "winter" | "spring" | "summer" | "autumn";
  evaluable: boolean;
  exclusionReason: string | null;
  exactReplay: boolean;
  assumptions: string[];
  components: {
    solar: { predictedKwh: number | null; actualKwh: number | null; errorKwh: number | null };
    demand: { predictedKwh: number | null; actualKwh: number | null; errorKwh: number | null };
    fuelCell: { predictedKwh: number | null; actualKwh: number | null; errorKwh: number | null };
  };
  asOperated: {
    gridCostYen: number;
    targetMet: boolean | null;
    reserveViolation: boolean;
    endingSocPercent: number | null;
  } | null;
  modelOnly: {
    gridCostYen: number;
    targetMet: boolean | null;
    reserveViolation: boolean;
    endingSocPercent: number | null;
  } | null;
}

export interface BacktestRunRecord {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "complete" | "failed";
  modelId: string;
  modelVersion: string;
  range: BacktestRange;
  mode: BacktestMode;
  periodStart: string;
  periodEnd: string;
  summary: BacktestRunSummary | null;
  error: string | null;
}

export interface BacktestCaseInput {
  snapshot: AdaptivePlanSnapshot;
  samples: HistorySample[];
}

export interface BacktestHistoryPort {
  adaptivePlanSnapshots(startMs: number, endMs: number): AdaptivePlanSnapshot[];
  backtestRuns(limit?: number): BacktestRunSummary[];
  completeBacktestRun(summary: BacktestRunSummary): void;
  createBacktestRun(run: BacktestRunRecord): void;
  fuelCellForecastOutcomes(limit?: number): Array<Record<string, unknown>>;
  querySamples(startMs: number, endMs: number, options?: { resolution?: "auto" | "raw" | "interval" | "daily" }): HistorySample[];
  saveBacktestOutcome(runId: string, outcome: BacktestOutcome): void;
  solarForecastOutcomes(limit?: number): Array<{ issuedAt: unknown; errorKwh: number }>;
  stats(): Promise<{ earliest: unknown }>;
}
