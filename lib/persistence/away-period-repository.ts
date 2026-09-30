import type { DatabaseSync } from "node:sqlite";
import type { AwayPeriod } from "../contracts/away-period.js";

export interface AwayPeriodQuery {
  includeCompleted?: boolean;
  startMs?: number | null;
  endMs?: number | null;
  nowMs?: number;
}

interface AwayPeriodRow {
  id?: unknown;
  start_ms?: unknown;
  start_at?: unknown;
  until_ms?: unknown;
  until_at?: unknown;
  source?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface AwayPeriodRepositoryDependencies {
  database(): DatabaseSync;
  timestampMs(value: unknown): number | null;
}

export function createAwayPeriodRepository(dependencies: AwayPeriodRepositoryDependencies) {
  function awayPeriodView(row: AwayPeriodRow | undefined, nowMs = Date.now()): AwayPeriod | null {
    if (!row) return null;
    const startMs = Number(row.start_ms);
    const untilMs = Number(row.until_ms);
    const status = nowMs < startMs ? "scheduled" : nowMs < untilMs ? "active" : "completed";
    return {
      id: String(row.id ?? ""),
      from: String(row.start_at ?? ""),
      until: String(row.until_at ?? ""),
      source: row.source === "manual" ? "manual" : "scheduled",
      status,
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  function awayPeriod(id: string, nowMs = Date.now()): AwayPeriod | null {
    const row = dependencies.database().prepare("SELECT * FROM away_periods WHERE id = ?").get(id) as AwayPeriodRow | undefined;
    return awayPeriodView(row, nowMs);
  }

  function awayPeriods({ includeCompleted = true, startMs = null, endMs = null, nowMs = Date.now() }: AwayPeriodQuery = {}): AwayPeriod[] {
    const rows = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? dependencies.database().prepare(`
          SELECT * FROM away_periods
          WHERE start_ms < ? AND until_ms > ?
          ORDER BY start_ms, id
        `).all(Number(endMs), Number(startMs))
      : dependencies.database().prepare("SELECT * FROM away_periods ORDER BY start_ms, id").all();
    return (rows as AwayPeriodRow[])
      .map((row) => awayPeriodView(row, nowMs))
      .filter((period): period is AwayPeriod => period !== null && (includeCompleted || period.status !== "completed"));
  }

  function createAwayPeriod(period: AwayPeriod): AwayPeriod {
    dependencies.database().prepare(`
      INSERT INTO away_periods(id, start_ms, start_at, until_ms, until_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      period.id,
      dependencies.timestampMs(period.from),
      period.from,
      dependencies.timestampMs(period.until),
      period.until,
      period.source,
      period.createdAt,
      period.updatedAt,
    );
    return awayPeriod(period.id)!;
  }

  function updateAwayPeriod(period: AwayPeriod): AwayPeriod | null {
    const result = dependencies.database().prepare(`
      UPDATE away_periods
      SET start_ms = ?, start_at = ?, until_ms = ?, until_at = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      dependencies.timestampMs(period.from),
      period.from,
      dependencies.timestampMs(period.until),
      period.until,
      period.source,
      period.updatedAt,
      period.id,
    );
    return Number(result.changes) > 0 ? awayPeriod(period.id) : null;
  }

  function deleteAwayPeriod(id: string): boolean {
    return Number(dependencies.database().prepare("DELETE FROM away_periods WHERE id = ?").run(id).changes) > 0;
  }

  return { awayPeriod, awayPeriods, createAwayPeriod, deleteAwayPeriod, updateAwayPeriod };
}
