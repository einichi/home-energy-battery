import type { DatabaseSync } from "node:sqlite";
import type {
  AdaptivePlanSnapshot,
  BacktestOutcome,
  BacktestRunRecord,
} from "../contracts/backtesting.js";
import type { AdaptivePlan } from "../domain/adaptive-state.js";
import type { BacktestRunSummary } from "../../shared/api-contracts.js";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function createBacktestRepository(database: () => DatabaseSync) {
  function planSignature(plan: AdaptivePlan): string {
    const rounded = (value: unknown) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
    return JSON.stringify({
      available: plan.available === true,
      targetSunset: plan.targetSunset ?? null,
      predictedSolarKwh: rounded(plan.predictedSolarKwh),
      predictedDemandKwh: rounded(plan.predictedDemandKwh),
      predictedFuelCellKwh: rounded(plan.predictedFuelCellKwh),
      plannedChargeKwh: rounded(plan.plannedChargeKwh),
      slots: (plan.slots ?? []).map((slot) => [slot.start, slot.end, rounded(slot.targetWh)]),
    });
  }

  function recordPlanSnapshot(input: {
    createdAt: string;
    modelId: string;
    modelVersion: string;
    trigger?: string | null;
    config: AdaptivePlanSnapshot["config"];
    plan: AdaptivePlan;
  }): number {
    const createdAtMs = new Date(input.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) return 0;
    const previous = database().prepare(`
      SELECT id, created_at_ms, payload_json FROM adaptive_plan_snapshots
      WHERE model_id = ? AND model_version = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1
    `).get(input.modelId, input.modelVersion) as Record<string, unknown> | undefined;
    if (previous && createdAtMs - Number(previous.created_at_ms) < 30 * 60_000) {
      const previousPayload = parseJson(previous.payload_json, {} as { plan?: AdaptivePlan });
      if (previousPayload.plan && planSignature(previousPayload.plan) === planSignature(input.plan)) {
        return Number(previous.id);
      }
    }
    const result = database().prepare(`
      INSERT INTO adaptive_plan_snapshots(
        created_at_ms, created_at, model_id, model_version, trigger, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(createdAtMs, input.createdAt, input.modelId, input.modelVersion, input.trigger ?? null,
      JSON.stringify({ config: input.config, plan: input.plan }));
    return Number(result.lastInsertRowid);
  }

  function planSnapshots(startMs: number, endMs: number): AdaptivePlanSnapshot[] {
    return (database().prepare(`
      SELECT id, created_at, model_id, model_version, trigger, payload_json
      FROM adaptive_plan_snapshots WHERE created_at_ms >= ? AND created_at_ms <= ?
      ORDER BY created_at_ms, id
    `).all(startMs, endMs) as Array<Record<string, unknown>>).map((row) => {
      const payload = parseJson(row.payload_json, {} as { config?: AdaptivePlanSnapshot["config"]; plan?: AdaptivePlan });
      return {
        id: Number(row.id),
        createdAt: String(row.created_at),
        modelId: String(row.model_id),
        modelVersion: String(row.model_version),
        trigger: row.trigger == null ? null : String(row.trigger),
        config: payload.config ?? {} as AdaptivePlanSnapshot["config"],
        plan: payload.plan ?? { slots: [] },
      };
    });
  }

  function createRun(run: BacktestRunRecord): void {
    database().prepare(`
      INSERT INTO backtest_runs(
        id, started_at_ms, started_at, completed_at, status, model_id, model_version,
        range_name, mode, period_start_ms, period_end_ms, summary_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, new Date(run.startedAt).getTime(), run.startedAt, run.completedAt, run.status,
      run.modelId, run.modelVersion, run.range, run.mode, new Date(run.periodStart).getTime(),
      new Date(run.periodEnd).getTime(), run.summary ? JSON.stringify(run.summary) : null, run.error);
  }

  function saveOutcome(runId: string, outcome: BacktestOutcome): void {
    database().prepare(`
      INSERT INTO backtest_outcomes(run_id, plan_key, evaluation_at_ms, outcome_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, plan_key) DO UPDATE SET outcome_json = excluded.outcome_json
    `).run(runId, outcome.planKey, new Date(outcome.evaluationAt).getTime(), JSON.stringify(outcome));
  }

  function completeRun(summary: BacktestRunSummary): void {
    database().prepare(`
      UPDATE backtest_runs SET status = ?, completed_at = ?, summary_json = ?, error = ? WHERE id = ?
    `).run(summary.status, summary.completedAt, JSON.stringify(summary), summary.error, summary.id);
  }

  function listRuns(limit: number = 20): BacktestRunSummary[] {
    return (database().prepare(`
      SELECT summary_json FROM backtest_runs WHERE summary_json IS NOT NULL
      ORDER BY started_at_ms DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, Math.round(limit)))) as Array<{ summary_json?: unknown }>)
      .map((row) => parseJson(row.summary_json, null as BacktestRunSummary | null))
      .filter((row): row is BacktestRunSummary => row !== null);
  }

  function outcomes(runId: string): BacktestOutcome[] {
    return (database().prepare(`
      SELECT outcome_json FROM backtest_outcomes WHERE run_id = ? ORDER BY evaluation_at_ms
    `).all(runId) as Array<{ outcome_json?: unknown }>)
      .map((row) => parseJson(row.outcome_json, null as BacktestOutcome | null))
      .filter((row): row is BacktestOutcome => row !== null);
  }

  return { completeRun, createRun, listRuns, outcomes, planSnapshots, recordPlanSnapshot, saveOutcome };
}
