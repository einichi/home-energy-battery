import { MILLISECONDS_PER_DAY } from "../domain/time.js";
import type { BacktestHistoryPort, BacktestOutcome, BacktestRunRecord } from "../contracts/backtesting.js";
import {
  BACKTEST_ENGINE_VERSION,
  CURRENT_BACKTEST_MODEL,
  evaluateBacktestCase,
} from "../domain/backtesting.js";
import type {
  BacktestComponentMetrics,
  BacktestExecutionMetrics,
  BacktestMode,
  BacktestRange,
  BacktestRunRequest,
  BacktestRunSummary,
} from "../../shared/api-contracts.js";

interface BacktestServiceDependencies {
  history: BacktestHistoryPort;
  randomUUID(): string;
  now?(): Date;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function componentMetrics(errors: Array<number | null>): BacktestComponentMetrics {
  const values = errors.filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    sampleCount: values.length,
    meanAbsoluteErrorKwh: values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length : null,
    meanBiasKwh: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

function executionMetrics(outcomes: BacktestOutcome[], key: "asOperated" | "modelOnly"): BacktestExecutionMetrics {
  const executions = outcomes.map((outcome) => outcome[key]).filter((value): value is NonNullable<BacktestOutcome[typeof key]> => value !== null);
  const targetResults = executions.map((value) => value.targetMet).filter((value): value is boolean => value !== null);
  const totalGridCostYen = executions.length ? executions.reduce((sum, value) => sum + value.gridCostYen, 0) : null;
  return {
    evaluablePlans: executions.length,
    targetMetPercent: targetResults.length ? targetResults.filter(Boolean).length / targetResults.length * 100 : null,
    reserveViolationCount: executions.filter((value) => value.reserveViolation).length,
    totalGridCostYen,
    averageGridCostYen: totalGridCostYen === null ? null : totalGridCostYen / executions.length,
  };
}

function canonicalSnapshots(snapshots: ReturnType<BacktestHistoryPort["adaptivePlanSnapshots"]>) {
  const grouped = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const key = String(snapshot.plan.targetSunset ?? snapshot.createdAt).slice(0, 10);
    const group = grouped.get(key) ?? [];
    group.push(snapshot);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const deadline = Math.min(...group.flatMap((snapshot) => (snapshot.plan.slots ?? [])
      .map((slot) => new Date(slot.start).getTime()).filter(Number.isFinite)));
    const eligible = Number.isFinite(deadline)
      ? group.filter((snapshot) => new Date(snapshot.createdAt).getTime() <= deadline)
      : group;
    return (eligible.length ? eligible : group).at(-1)!;
  });
}

function validateRequest(input: BacktestRunRequest): { range: BacktestRange; mode: BacktestMode; modelId: string } {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  const range = input.range ?? "90d";
  const mode = input.mode ?? "both";
  const modelId = input.modelId ?? CURRENT_BACKTEST_MODEL.id;
  if (range !== "90d" && range !== "all") invalid("backtest range must be 90d or all");
  if (!(["both", "as-operated", "model-only"] as string[]).includes(mode)) invalid("backtest mode is invalid");
  if (modelId !== CURRENT_BACKTEST_MODEL.id) invalid(`unknown backtest model ${modelId}`);
  return { range, mode, modelId };
}

export function createBacktestService(dependencies: BacktestServiceDependencies) {
  let active = false;

  function list() {
    return {
      models: [CURRENT_BACKTEST_MODEL],
      runs: dependencies.history.backtestRuns(20),
      scheduling: "manual" as const,
    };
  }

  async function run(input: BacktestRunRequest = {}): Promise<BacktestRunSummary> {
    if (active) throw Object.assign(new Error("a backtest is already running"), { statusCode: 409 });
    const request = validateRequest(input);
    active = true;
    const now = dependencies.now?.() ?? new Date();
    const stats = await dependencies.history.stats();
    const earliestMs = new Date(String(stats.earliest ?? now.toISOString())).getTime();
    const periodEndMs = now.getTime();
    const periodStartMs = request.range === "90d"
      ? Math.max(Number.isFinite(earliestMs) ? earliestMs : periodEndMs, periodEndMs - 90 * MILLISECONDS_PER_DAY)
      : Number.isFinite(earliestMs) ? earliestMs : periodEndMs;
    const id = dependencies.randomUUID();
    const startedAt = now.toISOString();
    const record: BacktestRunRecord = {
      id,
      startedAt,
      completedAt: null,
      status: "running",
      modelId: request.modelId,
      modelVersion: CURRENT_BACKTEST_MODEL.version,
      range: request.range,
      mode: request.mode,
      periodStart: new Date(periodStartMs).toISOString(),
      periodEnd: new Date(periodEndMs).toISOString(),
      summary: null,
      error: null,
    };
    dependencies.history.createBacktestRun(record);
    try {
      const snapshots = canonicalSnapshots(dependencies.history.adaptivePlanSnapshots(periodStartMs, periodEndMs)
        .filter((snapshot) => snapshot.modelId === request.modelId));
      const outcomes: BacktestOutcome[] = [];
      for (const snapshot of snapshots) {
        const horizonEndMs = new Date(String(snapshot.plan.targetSunset ?? snapshot.plan.timeline?.at(-1)?.end ?? snapshot.createdAt)).getTime();
        const samples = dependencies.history.querySamples(new Date(snapshot.createdAt).getTime(), Math.min(periodEndMs, horizonEndMs), { resolution: "interval" });
        const outcome = evaluateBacktestCase({ snapshot, samples });
        if (request.mode === "as-operated") outcome.modelOnly = null;
        if (request.mode === "model-only") outcome.asOperated = null;
        outcomes.push(outcome);
        dependencies.history.saveBacktestOutcome(id, outcome);
      }

      const solarHistorical = dependencies.history.solarForecastOutcomes(10_000)
        .filter((outcome) => new Date(String(outcome.issuedAt)).getTime() >= periodStartMs);
      const fuelHistorical = dependencies.history.fuelCellForecastOutcomes(10_000)
        .filter((outcome) => new Date(String(outcome.issuedAt)).getTime() >= periodStartMs);
      const solarErrors = solarHistorical.map((outcome) => finite(outcome.errorKwh));
      const fuelErrors = fuelHistorical.map((outcome) => {
          const hours = Math.max(0, new Date(String(outcome.end)).getTime() - new Date(String(outcome.start ?? outcome.targetStart)).getTime()) / 3_600_000;
          const predictedKwh = (finite(outcome.medianW) ?? 0) * hours / 1000;
          const actualKwh = finite(outcome.actualKwh);
          return actualKwh === null ? null : actualKwh - predictedKwh;
        });
      const completedAt = (dependencies.now?.() ?? new Date()).toISOString();
      const seasons = (["winter", "spring", "summer", "autumn"] as const).map((season) => {
        const subset = outcomes.filter((outcome) => outcome.season === season);
        const metric = executionMetrics(subset, request.mode === "model-only" ? "modelOnly" : "asOperated");
        return { season, planCount: subset.length, evaluablePlanCount: metric.evaluablePlans, targetMetPercent: metric.targetMetPercent, averageGridCostYen: metric.averageGridCostYen };
      }).filter((season) => season.planCount > 0);
      const summary: BacktestRunSummary = {
        id,
        engineVersion: BACKTEST_ENGINE_VERSION,
        modelId: request.modelId,
        modelVersion: CURRENT_BACKTEST_MODEL.version,
        status: "complete",
        range: request.range,
        mode: request.mode,
        startedAt,
        completedAt,
        periodStart: record.periodStart,
        periodEnd: record.periodEnd,
        planCount: outcomes.length,
        evaluablePlanCount: outcomes.filter((outcome) => outcome.evaluable).length,
        excludedPlanCount: outcomes.filter((outcome) => !outcome.evaluable).length,
        exactReplayPlanCount: outcomes.filter((outcome) => outcome.exactReplay).length,
        notes: snapshots.length ? [
          "As-operated and model-only results are kept separate.",
          "Unknown or insufficiently covered periods are excluded rather than guessed.",
        ] : [
          "No versioned plan snapshots exist in this range. Component forecast scores use existing outcomes; full-chain replay starts accumulating after this release.",
          "Historical periods without a recorded plan are not reconstructed with hindsight.",
        ],
        components: {
          solar: componentMetrics(solarErrors),
          demand: componentMetrics(outcomes.map((outcome) => outcome.components.demand.errorKwh)),
          fuelCell: componentMetrics(fuelErrors),
        },
        asOperated: request.mode === "model-only" ? null : executionMetrics(outcomes, "asOperated"),
        modelOnly: request.mode === "as-operated" ? null : executionMetrics(outcomes, "modelOnly"),
        seasonal: seasons,
        error: null,
      };
      dependencies.history.completeBacktestRun(summary);
      return summary;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: BacktestRunSummary = {
        id, engineVersion: BACKTEST_ENGINE_VERSION, modelId: request.modelId,
        modelVersion: CURRENT_BACKTEST_MODEL.version, status: "failed", range: request.range,
        mode: request.mode, startedAt, completedAt: (dependencies.now?.() ?? new Date()).toISOString(),
        periodStart: record.periodStart, periodEnd: record.periodEnd, planCount: 0,
        evaluablePlanCount: 0, excludedPlanCount: 0, exactReplayPlanCount: 0,
        notes: [], components: { solar: componentMetrics([]), demand: componentMetrics([]), fuelCell: componentMetrics([]) },
        asOperated: null, modelOnly: null, seasonal: [], error: message,
      };
      dependencies.history.completeBacktestRun(failed);
      throw error;
    } finally {
      active = false;
    }
  }

  return { list, run };
}
