import type { DatabaseSync } from "node:sqlite";
import type { HistorySample } from "../contracts/history.js";
import type { DailySolarForecastIssue } from "../domain/solar-forecast.js";
import { median } from "../domain/statistics.js";
import { timestampMs } from "../domain/values.js";

interface StoredForecast { fetchedAt?: string }
interface StoredWeatherRecord { time?: string; timestamp?: string }

export interface ForecastRepositoryDependencies {
  database(): DatabaseSync;
  intervalSamples(startMs: number, endMs: number): HistorySample[];
  solarForecastMinimumCoverageRatio: number;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function createForecastRepository(dependencies: ForecastRepositoryDependencies) {
  const requireDatabase = dependencies.database;
  const SOLAR_FORECAST_MIN_COVERAGE_RATIO = dependencies.solarForecastMinimumCoverageRatio;

  function recordForecast<T extends StoredForecast>(forecast: T): boolean {
    const fetchedAt = forecast?.fetchedAt ?? new Date().toISOString();
    const timeMs = timestampMs(fetchedAt);
    if (timeMs === null) return false;
    requireDatabase().prepare(`
      INSERT INTO forecasts(fetched_at_ms, fetched_at, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(fetched_at_ms) DO UPDATE SET payload_json = excluded.payload_json
    `).run(timeMs, fetchedAt, JSON.stringify(forecast));
    return true;
  }

  function recordSolarForecastIssues(issues: DailySolarForecastIssue[] = []): number {
    const statement = requireDatabase().prepare(`
      INSERT INTO solar_forecast_daily(
        target_date, issued_at_ms, issued_at, period_start_ms, period_end_ms,
        raw_predicted_kwh, bias_factor, predicted_kwh, planning_kwh,
        margin_percent, calibration_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_date, issued_at_ms) DO UPDATE SET
        period_start_ms = excluded.period_start_ms,
        period_end_ms = excluded.period_end_ms,
        raw_predicted_kwh = excluded.raw_predicted_kwh,
        bias_factor = excluded.bias_factor,
        predicted_kwh = excluded.predicted_kwh,
        planning_kwh = excluded.planning_kwh,
        margin_percent = excluded.margin_percent,
        calibration_json = excluded.calibration_json
    `);
    let recorded = 0;
    for (const issue of issues) {
      const issuedAt = issue?.issuedAt;
      const issuedAtMs = timestampMs(issuedAt);
      const periodStartMs = timestampMs(issue?.periodStart);
      const periodEndMs = timestampMs(issue?.periodEnd);
      const values: Array<number | null> = [
        finite(issue?.rawPredictedKwh),
        finite(issue?.biasFactor),
        finite(issue?.predictedKwh),
        finite(issue?.planningKwh),
        finite(issue?.marginPercent),
      ];
      if (!issue?.targetDate || issuedAtMs === null || periodStartMs === null || periodEndMs === null
        || periodEndMs <= periodStartMs || values.some((value) => value === null)) continue;
      statement.run(
        issue.targetDate,
        issuedAtMs,
        issuedAt,
        periodStartMs,
        periodEndMs,
        ...values,
        issue.calibration ? JSON.stringify(issue.calibration) : null,
      );
      recorded += 1;
    }
    return recorded;
  }

  function settleSolarForecastOutcomes(now: Date | string | number = new Date()): number {
    const nowMs = now instanceof Date ? now.getTime() : timestampMs(now);
    if (!Number.isFinite(nowMs)) return 0;
    const pending = requireDatabase().prepare(`
      SELECT DISTINCT target_date, period_start_ms, period_end_ms
      FROM solar_forecast_daily
      WHERE completed_at IS NULL AND period_end_ms <= ?
      ORDER BY period_start_ms
    `).all(nowMs) as Array<Record<string, unknown>>;
    const update = requireDatabase().prepare(`
      UPDATE solar_forecast_daily
      SET actual_kwh = ?, actual_coverage_seconds = ?, completed_at = ?
      WHERE target_date = ? AND period_start_ms = ? AND period_end_ms = ? AND completed_at IS NULL
    `);
    let settled = 0;
    for (const day of pending) {
      const rows = requireDatabase().prepare(`
        SELECT payload_json FROM rollups
        WHERE resolution = 'daily' AND bucket_start_ms >= ? AND bucket_end_ms <= ?
        ORDER BY bucket_start_ms
      `).all(day.period_start_ms as number, day.period_end_ms as number) as Array<Record<string, unknown>>;
      let actualKwh = 0;
      let coverageSeconds = 0;
      let hasActual = false;
      for (const row of rows) {
        const payload = parseJson(row.payload_json, {} as HistorySample);
        const actual = finite(payload.solarGenerationKwh);
        const coverage = finite(payload.coverageSeconds?.solarGenerationKwh);
        if (actual !== null) {
          actualKwh += actual;
          hasActual = true;
        }
        if (coverage !== null) coverageSeconds += coverage;
      }
      const requiredCoverage = (Number(day.period_end_ms) - Number(day.period_start_ms))
        / 1000 * SOLAR_FORECAST_MIN_COVERAGE_RATIO;
      if (!hasActual || coverageSeconds < requiredCoverage) continue;
      const result = update.run(
        actualKwh,
        coverageSeconds,
        (now instanceof Date ? now : new Date(nowMs!)).toISOString(),
        String(day.target_date ?? ""),
        day.period_start_ms as number,
        day.period_end_ms as number,
      );
      settled += Number(result.changes);
    }
    return settled;
  }

  function canonicalSolarForecastRows({ completedOnly = true }: { completedOnly?: boolean } = {}): Array<Record<string, unknown>> {
    const where = completedOnly ? "WHERE completed_at IS NOT NULL" : "";
    const rows = requireDatabase().prepare(`
      SELECT * FROM solar_forecast_daily ${where}
      ORDER BY target_date, issued_at_ms
    `).all() as Array<Record<string, unknown>>;
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const targetDate = String(row.target_date ?? "");
      const candidates = grouped.get(targetDate) ?? [];
      candidates.push(row);
      grouped.set(targetDate, candidates);
    }
    return [...grouped.values()].map((candidates) => {
      const beforeStart = candidates.filter((row) => Number(row.issued_at_ms) <= Number(row.period_start_ms));
      return (beforeStart.at(-1) ?? candidates[0])!;
    });
  }

  interface SolarForecastOutcome {
    targetDate: unknown;
    issuedAt: unknown;
    leadHours: number;
    forecastBasis: string;
    rawPredictedKwh: number;
    biasFactor: number;
    predictedKwh: number;
    planningKwh: number;
    marginPercent: number;
    actualKwh: number;
    errorKwh: number;
    errorPercent: number | null;
    actualCoverageSeconds: number;
    completedAt: unknown;
  }

  function solarForecastOutcomes(limit: number = 30): SolarForecastOutcome[] {
    const rows = canonicalSolarForecastRows();
    return rows.slice(-Math.max(1, Math.round(limit))).map((row) => {
      const predicted = Number(row.predicted_kwh);
      const actual = Number(row.actual_kwh);
      const errorKwh = actual - predicted;
      return {
        targetDate: row.target_date,
        issuedAt: row.issued_at,
        leadHours: (Number(row.period_start_ms) - Number(row.issued_at_ms)) / 3_600_000,
        forecastBasis: Number(row.issued_at_ms) <= Number(row.period_start_ms) ? "day-ahead" : "same-day",
        rawPredictedKwh: Number(row.raw_predicted_kwh),
        biasFactor: Number(row.bias_factor),
        predictedKwh: predicted,
        planningKwh: Number(row.planning_kwh),
        marginPercent: Number(row.margin_percent),
        actualKwh: actual,
        errorKwh,
        errorPercent: predicted > 0.05 ? errorKwh / predicted * 100 : null,
        actualCoverageSeconds: Number(row.actual_coverage_seconds),
        completedAt: row.completed_at,
      };
    });
  }

  function solarForecastAccuracy(limit: number = 30): {
    learned: boolean;
    sampleCount: number;
    measuredFactor: number | null;
    factor: number;
    meanAbsolutePercentageError: number | null;
    outcomes: SolarForecastOutcome[];
  } {
    const outcomes = solarForecastOutcomes(limit);
    const ratios = outcomes
      .filter((outcome) => outcome.rawPredictedKwh > 0.05 && outcome.actualKwh >= 0)
      .map((outcome) => outcome.actualKwh / outcome.rawPredictedKwh)
      .filter(Number.isFinite);
    const measuredFactor = median(ratios);
    const learned = ratios.length >= 5 && Number.isFinite(measuredFactor);
    const errors = outcomes
      .map((outcome) => outcome.errorPercent)
      .filter((value): value is number => value !== null && Number.isFinite(value))
      .map(Math.abs);
    return {
      learned,
      sampleCount: ratios.length,
      measuredFactor,
      factor: learned ? Math.max(0.5, Math.min(1.5, measuredFactor ?? 1)) : 1,
      meanAbsolutePercentageError: errors.length
        ? errors.reduce((sum, value) => sum + value, 0) / errors.length
        : null,
      outcomes,
    };
  }

  function insertWeather<T extends StoredWeatherRecord>(records: T[] = []): number {
    const statement = requireDatabase().prepare(`
      INSERT INTO weather(time_ms, time, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(time_ms) DO UPDATE SET payload_json = excluded.payload_json
    `);
    let inserted = 0;
    for (const record of records) {
      const time = record.time || record.timestamp;
      const timeMs = timestampMs(time);
      if (timeMs === null) continue;
      statement.run(timeMs, String(time ?? ""), JSON.stringify(record));
      inserted += 1;
    }
    return inserted;
  }

  function recordWeather<T extends StoredWeatherRecord>(records: T[] = []): number {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = insertWeather(records);
      db.exec("COMMIT");
      return inserted;
    } catch (error: unknown) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function recordFuelCellForecasts(entries: Array<Record<string, unknown>> = [], issuedAt: string = new Date().toISOString()): number {
    const issuedAtMs = timestampMs(issuedAt);
    if (issuedAtMs === null) return 0;
    const statement = requireDatabase().prepare(`
      INSERT INTO fuel_cell_forecasts(target_start_ms, issued_at_ms, target_start, issued_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(target_start_ms, issued_at_ms) DO UPDATE SET payload_json = excluded.payload_json
    `);
    let recorded = 0;
    for (const entry of entries) {
      const targetStartMs = timestampMs(entry.start);
      const targetEndMs = timestampMs(entry.end);
      if (targetStartMs === null || targetEndMs === null || targetEndMs <= targetStartMs) continue;
      statement.run(targetStartMs, issuedAtMs, String(entry.start ?? ""), issuedAt, JSON.stringify(entry));
      recorded += 1;
    }
    return recorded;
  }

  function settleFuelCellForecastOutcomes(now: Date | string | number = new Date()): number {
    const nowMs = timestampMs(now);
    if (nowMs === null) return 0;
    const rows = requireDatabase().prepare(`
      SELECT target_start_ms, issued_at_ms, payload_json FROM fuel_cell_forecasts
      WHERE completed_at IS NULL AND json_extract(payload_json, '$.end') <= ? ORDER BY target_start_ms
    `).all(new Date(nowMs).toISOString()) as Array<Record<string, unknown>>;
    const update = requireDatabase().prepare(`
      UPDATE fuel_cell_forecasts SET actual_kwh = ?, completed_at = ?, payload_json = ?
      WHERE target_start_ms = ? AND issued_at_ms = ?
    `);
    let settled = 0;
    const intervalResults = new Map<string, { actualKwh: number; coverageSeconds: number }>();
    for (const row of rows) {
      const payload = parseJson(row.payload_json, {} as Record<string, unknown>);
      const startMs = Number(row.target_start_ms);
      const endMs = timestampMs(payload.end);
      if (endMs === null || endMs > nowMs) continue;
      const intervalKey = `${startMs}:${endMs}`;
      let result = intervalResults.get(intervalKey);
      if (!result) {
        let actualKwh = 0;
        let coverageSeconds = 0;
        let cursorMs = startMs;
        for (const sample of dependencies.intervalSamples(startMs, endMs)) {
          const intervalStart = timestampMs(sample.rollupStart);
          const intervalEnd = timestampMs(sample.rollupEnd);
          const value = finite(sample.fuelCellKwh);
          const measuredSeconds = finite(sample.coverageSeconds?.fuelCellKwh);
          if (intervalStart === null || intervalEnd === null || intervalEnd <= intervalStart || value === null || measuredSeconds === null) continue;
          const overlapMs = Math.max(0, Math.min(endMs, intervalEnd) - Math.max(cursorMs, intervalStart));
          if (!overlapMs) continue;
          const fraction = overlapMs / (intervalEnd - intervalStart);
          actualKwh += value * fraction;
          coverageSeconds += Math.min(measuredSeconds, (intervalEnd - intervalStart) / 1000) * fraction;
          cursorMs = intervalEnd;
        }
        result = { actualKwh, coverageSeconds };
        intervalResults.set(intervalKey, result);
      }
      const { actualKwh, coverageSeconds } = result;
      const durationMs = endMs - startMs;
      const adequatelyCovered = durationMs > 0 && coverageSeconds >= durationMs / 1000 * SOLAR_FORECAST_MIN_COVERAGE_RATIO;
      const expiredUnmeasured = nowMs - endMs > 2 * 86_400_000;
      if (!adequatelyCovered && !expiredUnmeasured) continue;
      const finalPayload = {
        ...payload, settlementVersion: 2, actualCoverageSeconds: coverageSeconds,
        ...(!adequatelyCovered ? { settlementExcludedReason: "insufficient measured interval coverage" } : {}),
      };
      update.run(
        adequatelyCovered ? actualKwh : null,
        (now instanceof Date ? now : new Date(nowMs)).toISOString(),
        JSON.stringify(finalPayload),
        Number(row.target_start_ms),
        Number(row.issued_at_ms),
      );
      settled += 1;
    }
    return settled;
  }

  function fuelCellForecastOutcomes(limit: number = 100, { canonical = false }: { canonical?: boolean } = {}): Array<Record<string, unknown>> {
    return requireDatabase().prepare(`
      SELECT target_start, issued_at, payload_json, actual_kwh, completed_at
      FROM fuel_cell_forecasts AS forecast WHERE completed_at IS NOT NULL
      ${canonical ? `AND json_extract(payload_json, '$.settlementVersion') = 2
        AND json_extract(payload_json, '$.sampleCount') > 0
        AND actual_kwh IS NOT NULL AND issued_at_ms <= target_start_ms - 1800000
        AND issued_at_ms = (SELECT MAX(candidate.issued_at_ms) FROM fuel_cell_forecasts AS candidate
          WHERE candidate.target_start_ms = forecast.target_start_ms
            AND json_extract(candidate.payload_json, '$.end') = json_extract(forecast.payload_json, '$.end')
            AND candidate.issued_at_ms <= candidate.target_start_ms - 1800000
            AND candidate.actual_kwh IS NOT NULL
            AND json_extract(candidate.payload_json, '$.sampleCount') > 0
            AND json_extract(candidate.payload_json, '$.settlementVersion') = 2)` : ""}
      ORDER BY target_start_ms DESC, issued_at_ms DESC LIMIT ?
    `).all(Math.max(1, Math.round(limit))).map((row) => ({
      ...parseJson(row.payload_json, {}),
      targetStart: row.target_start,
      issuedAt: row.issued_at,
      actualKwh: finite(row.actual_kwh),
      completedAt: row.completed_at,
    }));
  }


  return {
    fuelCellForecastOutcomes,
    recordForecast,
    recordFuelCellForecasts,
    recordSolarForecastIssues,
    recordWeather,
    settleFuelCellForecastOutcomes,
    settleSolarForecastOutcomes,
    solarForecastAccuracy,
    solarForecastOutcomes,
  };
}
