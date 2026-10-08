import { ENERGY_CALCULATION_VERSION, addRollupSample, compactHistorySample, emptyRollupState, enrichHistorySample, intervalEnergy, interpretHistorySample, localBucketStart, rollupPayload, updateMetricBaselines } from "./domain/history-samples.js";
import type { RollupState } from "./domain/history-samples.js";
import { MILLISECONDS_PER_DAY } from "./domain/time.js";
import { DatabaseSync } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARCHITECTURE_VERSION } from "./application-store.js";
import {
  createHistorySchema,
  isSchemaMigratableFrom,
  migrateHistorySchema,
  inspectHistoryDatabase as inspectHistoryDatabaseFile,
} from "./persistence/history-database.js";
import { backupDatabaseManually } from "./database-backup.js";

export { isSchemaMigratableFrom } from "./persistence/history-database.js";
import { createEventRepository } from "./persistence/event-repository.js";
import { createAwayPeriodRepository } from "./persistence/away-period-repository.js";
import {
  createGasTariffRepository,
} from "./persistence/gas-tariff-repository.js";
import { createForecastRepository } from "./persistence/forecast-repository.js";
import { createHistoryStatisticsRepository } from "./persistence/history-statistics-repository.js";
import { createBacktestRepository } from "./persistence/backtest-repository.js";
import { createRetentionRepository } from "./persistence/retention-repository.js";
import {
  createHistoryQueryRepository,
} from "./persistence/history-query-repository.js";
import type { HistoryResolution, HistorySample } from "./contracts/history.js";
import { timestampMs } from "./domain/values.js";

export { ENERGY_CALCULATION_VERSION, compactHistorySample, enrichHistorySample, interpretHistorySample, emptyRollupState, addRollupSample, rollupPayload };

export { historyDatabaseFile } from "./persistence/history-database.js";

export const SCHEMA_VERSION = 9;
const MAX_RAW_AUTO_SAMPLES = 10_000;
const MAX_RAW_AUTO_BYTES = 32 * 1024 * 1024;
const AUTO_RAW_DETAIL_WINDOW_MS = MILLISECONDS_PER_DAY;
const SOLAR_FORECAST_MIN_COVERAGE_RATIO = 0.8;
function parseJson<T = Record<string, unknown> | null>(text: unknown, fallback: T = null as T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function createHistoryStore({
  dataDir,
  maxRawAutoBytes = MAX_RAW_AUTO_BYTES,
}: { dataDir: string; logger?: Pick<Console, "log" | "warn">; maxRawAutoBytes?: number }) {
  const databaseFile = path.join(dataDir, "history.sqlite");
  let database: DatabaseSync | null = null;
  let previousSample: HistorySample | null = null;
  let metricBaselines: Record<string, HistorySample> = {};
  const rollupStates = new Map<string, RollupState>();
  // Bound the in-memory rollup cache; older buckets are re-read from SQLite if
  // ever touched again, so an unbounded map is unnecessary.
  const ROLLUP_STATE_CACHE_LIMIT = 512;

  const ready = () => database !== null;
  const requireDatabase = () => {
    if (!database) throw new Error("history database is not initialized");
    return database;
  };
  const eventRepository = createEventRepository({
    database: requireDatabase,
    timestampMs,
    parseJson: (value) => parseJson(value),
  });
  const awayPeriodRepository = createAwayPeriodRepository({ database: requireDatabase, timestampMs });
  const gasTariffRepository = createGasTariffRepository({ database: requireDatabase });
  const forecastRepository = createForecastRepository({
    database: requireDatabase,
    intervalEnergy,
    solarForecastMinimumCoverageRatio: SOLAR_FORECAST_MIN_COVERAGE_RATIO,
  });
  const backtestRepository = createBacktestRepository(requireDatabase);
  const statisticsRepository = createHistoryStatisticsRepository({ database: requireDatabase, databaseFile, metadataGet });
  const retentionRepository = createRetentionRepository({ database: requireDatabase, stats: statisticsRepository.stats });
  const queryRepository = createHistoryQueryRepository({
    database: requireDatabase,
    compactHistorySample,
    interpretHistorySample,
    updateMetricBaselines,
    maxRawAutoBytes,
    maxRawAutoSamples: MAX_RAW_AUTO_SAMPLES,
    autoRawDetailWindowMs: AUTO_RAW_DETAIL_WINDOW_MS,
  });
  const stats = statisticsRepository.stats;
  const applyRetention = retentionRepository.applyRetention;
  const { batteryChargeCurveSamples, historicalWeather, querySamples } = queryRepository;
  const { eventsBetween, eventsByKeyPrefix, recentEvents, tagEventsBefore } = eventRepository;
  const { awayPeriod, awayPeriods, createAwayPeriod, deleteAwayPeriod, updateAwayPeriod } = awayPeriodRepository;
  const {
    deleteOverride: deleteGasTariffOverride,
    override: gasTariffOverride,
    recordSnapshot: recordGasTariffSnapshot,
    setOverride: setGasTariffOverride,
    snapshots: gasTariffSnapshots,
  } = gasTariffRepository;
  const {
    fuelCellForecastOutcomes,
    recordForecast,
    recordFuelCellForecasts,
    recordSolarForecastIssues,
    recordWeather,
    settleFuelCellForecastOutcomes,
    settleSolarForecastOutcomes,
    solarForecastAccuracy,
    solarForecastOutcomes,
  } = forecastRepository;

  function recordEvent(event: Record<string, unknown>): boolean {
    return eventRepository.recordEvent({
      eventKey: String(event.eventKey ?? ""),
      category: String(event.category ?? ""),
      ...(typeof event.at === "string" ? { at: event.at } : {}),
      ...(typeof event.type === "string" ? { type: event.type } : {}),
      message: event.message === null || event.message === undefined ? null : String(event.message),
      payload: event.payload ?? null,
    });
  }

  function metadataGet<T>(key: string, fallback: T): T {
    const row = requireDatabase().prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return row ? parseJson(row.value, fallback) : fallback;
  }

  function loadRollupState(resolution: HistoryResolution, startMs: number): RollupState {
    const key = `${resolution}:${startMs}`;
    const cached = rollupStates.get(key);
    if (cached) return cached;
    const row = requireDatabase().prepare(
      "SELECT state_json FROM rollups WHERE resolution = ? AND bucket_start_ms = ?",
    ).get(resolution, startMs) as { state_json?: unknown } | undefined;
    const state = row ? parseJson(row.state_json, emptyRollupState(startMs, resolution)) : emptyRollupState(startMs, resolution);
    rollupStates.set(key, state);
    if (rollupStates.size > ROLLUP_STATE_CACHE_LIMIT) {
      const oldest = rollupStates.keys().next().value;
      if (oldest !== undefined && oldest !== key) rollupStates.delete(oldest);
    }
    return state;
  }

  function persistRollup(state: RollupState): void {
    const payload = rollupPayload(state);
    requireDatabase().prepare(`
      INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resolution, bucket_start_ms) DO UPDATE SET
        bucket_end_ms = excluded.bucket_end_ms,
        payload_json = excluded.payload_json,
        state_json = excluded.state_json
    `).run(state.resolution, state.startMs, state.endMs, JSON.stringify(payload), JSON.stringify(state));
  }

  function updateRollups(sample: HistorySample, previousFuelCellState: string | null = null): void {
    const timeMs = timestampMs(sample.timestamp);
    if (timeMs === null) return;
    for (const resolution of ["interval", "daily"] as HistoryResolution[]) {
      const startMs = localBucketStart(timeMs, resolution);
      const state = loadRollupState(resolution, startMs);
      addRollupSample(state, sample, previousFuelCellState);
      persistRollup(state);
    }
  }

  function insertSample(sample: HistorySample, { sourceFile = null, sourceLine = null }: { sourceFile?: string | null; sourceLine?: number | null } = {}) {
    const timeMs = timestampMs(sample?.timestamp);
    if (timeMs === null) return { inserted: false, sample: null };
    const compact = compactHistorySample(sample);
    // Runtime samples carry no source info, so the (source_file, source_line)
    // unique constraint never fires. Dedupe explicitly by timestamp so a
    // restart-adjacent duplicate cannot be integrated into rollups twice.
    const duplicate = requireDatabase().prepare("SELECT 1 AS present FROM samples WHERE timestamp_ms = ? LIMIT 1").get(timeMs);
    if (duplicate) return { inserted: false, sample: null };
    const interpreted = interpretHistorySample(compact, previousSample, { metricBaselines });
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO samples(timestamp_ms, timestamp, payload_json, source_file, source_line)
      VALUES (?, ?, ?, ?, ?)
    `).run(timeMs, String(compact.timestamp), JSON.stringify(compact), sourceFile, sourceLine);
    if (Number(result.changes) > 0) {
      updateRollups(interpreted, typeof previousSample?.fuelCellGenerationState === "string" ? previousSample.fuelCellGenerationState : null);
      previousSample = compact;
      updateMetricBaselines(metricBaselines, compact);
      return { inserted: true, sample: interpreted };
    }
    return { inserted: false, sample: interpreted };
  }

  function appendSample(sample: HistorySample): HistorySample | null {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = insertSample(sample);
      db.exec("COMMIT");
      return result.sample;
    } catch (error: unknown) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function latestRawSample(): HistorySample | null {
    const row = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
    ).get();
    return row ? parseJson((row as { payload_json?: unknown }).payload_json, null as HistorySample | null) : null;
  }

  function recentMetricBaselines(): Record<string, HistorySample> {
    const rows = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 5000",
    ).all().reverse();
    const baselines: Record<string, HistorySample> = {};
    for (const row of rows as Array<{ payload_json?: unknown }>) updateMetricBaselines(baselines, parseJson(row.payload_json, {} as HistorySample));
    return baselines;
  }

  async function initialize(): Promise<void> {
    if (database) return;
    await mkdir(dataDir, { recursive: true });
    let existing = true;
    try {
      await stat(databaseFile);
    } catch (error: unknown) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      existing = false;
    }
    if (existing) {
      // A schema upgrade is one-way; take and validate a backup before opening
      // the database writable, and fail startup if it cannot be completed.
      const inspection = await inspectHistoryDatabaseFile(dataDir, SCHEMA_VERSION);
      if (inspection.state === "migratable") {
        await backupDatabaseManually({
          databaseFile,
          backupDir: path.join(dataDir, "backups"),
          sourceVersion: inspection.version ?? SCHEMA_VERSION - 1,
          beforeUpgrade: true,
        });
      }
    }
    database = new DatabaseSync(databaseFile);
    if (!existing) {
      createHistorySchema(database, {
        schemaVersion: SCHEMA_VERSION,
        energyCalculationVersion: ENERGY_CALCULATION_VERSION,
        architectureVersion: ARCHITECTURE_VERSION,
      });
    } else {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
      const row = table ? database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as { value?: unknown } | undefined : null;
      const version = row ? parseJson(row.value, null as number | null) : null;
      if (isSchemaMigratableFrom(version ?? Number.NaN, SCHEMA_VERSION)) {
        migrateHistorySchema(database, {
          schemaVersion: SCHEMA_VERSION,
          energyCalculationVersion: ENERGY_CALCULATION_VERSION,
          architectureVersion: ARCHITECTURE_VERSION,
        });
      } else if (version !== SCHEMA_VERSION) {
        database.close();
        database = null;
        throw new Error(`history database schema ${version ?? "unknown"} is not ready for application schema ${SCHEMA_VERSION}`);
      }
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    }
    previousSample = latestRawSample();
    metricBaselines = recentMetricBaselines();
  }

  function close(): void {
    if (!database) return;
    database.close();
    database = null;
    previousSample = null;
    rollupStates.clear();
  }

  return {
    appendSample,
    applyRetention,
    awayPeriod,
    awayPeriods,
    close,
    createAwayPeriod,
    databaseFile,
    deleteAwayPeriod,
    enrichHistorySample,
    eventsBetween,
    eventsByKeyPrefix,
    historicalWeather,
    initialize,
    isReady: ready,
    latestSample: latestRawSample,
    batteryChargeCurveSamples,
    adaptivePlanSnapshots: backtestRepository.planSnapshots,
    backtestOutcomes: backtestRepository.outcomes,
    backtestRuns: backtestRepository.listRuns,
    completeBacktestRun: backtestRepository.completeRun,
    createBacktestRun: backtestRepository.createRun,
    querySamples,
    recordAdaptivePlanSnapshot: backtestRepository.recordPlanSnapshot,
    saveBacktestOutcome: backtestRepository.saveOutcome,
    recordEvent,
    recentEvents,
    recordGasTariffSnapshot,
    recordForecast,
    recordFuelCellForecasts,
    recordSolarForecastIssues,
    recordWeather,
    settleSolarForecastOutcomes,
    settleFuelCellForecastOutcomes,
    fuelCellForecastOutcomes,
    solarForecastAccuracy,
    solarForecastOutcomes,
    gasTariffOverride,
    gasTariffSnapshots,
    setGasTariffOverride,
    deleteGasTariffOverride,
    stats,
    tagEventsBefore,
    updateAwayPeriod,
  };
}

export async function inspectHistoryDatabase(dataDir: string) {
  return inspectHistoryDatabaseFile(dataDir, SCHEMA_VERSION);
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
