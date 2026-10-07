import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface HistoryDatabaseInspection {
  state: "new" | "current" | "migratable" | "invalid" | "incompatible";
  databaseFile: string;
  databaseBytes: number | null;
  version?: number | null;
  targetVersion?: number;
  error?: string;
}

function createBacktestSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_plan_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      trigger TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adaptive_plan_snapshots_time_idx
      ON adaptive_plan_snapshots(created_at_ms, id);
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      started_at_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      range_name TEXT NOT NULL,
      mode TEXT NOT NULL,
      period_start_ms INTEGER NOT NULL,
      period_end_ms INTEGER NOT NULL,
      summary_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS backtest_runs_started_idx
      ON backtest_runs(started_at_ms DESC);
    CREATE TABLE IF NOT EXISTS backtest_outcomes (
      run_id TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      plan_key TEXT NOT NULL,
      evaluation_at_ms INTEGER NOT NULL,
      outcome_json TEXT NOT NULL,
      PRIMARY KEY(run_id, plan_key)
    );
    CREATE INDEX IF NOT EXISTS backtest_outcomes_run_time_idx
      ON backtest_outcomes(run_id, evaluation_at_ms);
  `);
}

export interface HistorySchemaVersions {
  schemaVersion: number;
  energyCalculationVersion: number;
  architectureVersion: number;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function historyDatabaseFile(dataDir: string): string {
  return path.join(dataDir, "history.sqlite");
}

export function createHistorySchema(database: DatabaseSync, versions: HistorySchemaVersions): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_documents (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_file TEXT,
      source_line INTEGER,
      UNIQUE(source_file, source_line)
    );
    CREATE INDEX IF NOT EXISTS samples_timestamp_idx ON samples(timestamp_ms, id);
    CREATE UNIQUE INDEX IF NOT EXISTS samples_timestamp_unique_idx ON samples(timestamp_ms);
    CREATE TABLE IF NOT EXISTS rollups (
      resolution TEXT NOT NULL,
      bucket_start_ms INTEGER NOT NULL,
      bucket_end_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      PRIMARY KEY(resolution, bucket_start_ms)
    );
    CREATE INDEX IF NOT EXISTS rollups_range_idx ON rollups(resolution, bucket_start_ms, bucket_end_ms);
    CREATE INDEX IF NOT EXISTS rollups_end_idx ON rollups(resolution, bucket_end_ms);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      timestamp_ms INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS events_category_time_idx ON events(category, timestamp_ms);
    CREATE TABLE IF NOT EXISTS away_periods (
      id TEXT PRIMARY KEY,
      start_ms INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      until_ms INTEGER NOT NULL,
      until_at TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS away_periods_range_idx ON away_periods(start_ms, until_ms);
    CREATE TABLE IF NOT EXISTS forecasts (
      fetched_at_ms INTEGER PRIMARY KEY,
      fetched_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weather (
      time_ms INTEGER PRIMARY KEY,
      time TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS solar_forecast_daily (
      target_date TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      issued_at TEXT NOT NULL,
      period_start_ms INTEGER NOT NULL,
      period_end_ms INTEGER NOT NULL,
      raw_predicted_kwh REAL NOT NULL,
      bias_factor REAL NOT NULL,
      predicted_kwh REAL NOT NULL,
      planning_kwh REAL NOT NULL,
      margin_percent REAL NOT NULL,
      calibration_json TEXT,
      actual_kwh REAL,
      actual_coverage_seconds REAL,
      completed_at TEXT,
      PRIMARY KEY(target_date, issued_at_ms)
    );
    CREATE INDEX IF NOT EXISTS solar_forecast_daily_period_idx
      ON solar_forecast_daily(period_end_ms, completed_at);
    CREATE TABLE IF NOT EXISTS gas_tariff_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      billing_month TEXT NOT NULL,
      version INTEGER NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      source_url TEXT,
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(provider, billing_month, version)
    );
    CREATE TABLE IF NOT EXISTS gas_tariff_overrides (
      provider TEXT NOT NULL,
      billing_month TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(provider, billing_month)
    );
    CREATE TABLE IF NOT EXISTS fuel_cell_forecasts (
      target_start_ms INTEGER NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      target_start TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actual_kwh REAL,
      completed_at TEXT,
      PRIMARY KEY(target_start_ms, issued_at_ms)
    );
  `);
  createBacktestSchema(database);
  const setMetadata = database.prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  setMetadata.run("schemaVersion", JSON.stringify(versions.schemaVersion));
  setMetadata.run("energyCalculationVersion", JSON.stringify(versions.energyCalculationVersion));
  setMetadata.run("architectureVersion", JSON.stringify(versions.architectureVersion));
}

export function migrateHistorySchema(database: DatabaseSync, versions: HistorySchemaVersions): void {
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as
    | { value?: unknown }
    | undefined;
  const version = Number(row ? parseJson(row.value) : Number.NaN);
  if (version === versions.schemaVersion) return;
  if (version !== 7 || versions.schemaVersion !== 8) {
    throw new Error(`history database schema ${Number.isInteger(version) ? version : "unknown"} cannot be migrated to ${versions.schemaVersion}`);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    createBacktestSchema(database);
    const setMetadata = database.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setMetadata.run("schemaVersion", JSON.stringify(versions.schemaVersion));
    setMetadata.run("energyCalculationVersion", JSON.stringify(versions.energyCalculationVersion));
    setMetadata.run("architectureVersion", JSON.stringify(versions.architectureVersion));
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function inspectHistoryDatabase(
  dataDir: string,
  schemaVersion: number,
): Promise<HistoryDatabaseInspection> {
  const databaseFile = historyDatabaseFile(dataDir);
  try {
    const fileStat = await stat(databaseFile);
    let walBytes = 0;
    try {
      walBytes = (await stat(`${databaseFile}-wal`)).size;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const databaseBytes = fileStat.size + walBytes;
    if (fileStat.size === 0) {
      return { state: "invalid", databaseFile, databaseBytes: 0, error: "Database file is empty" };
    }
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const metadata = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
      ).get();
      if (!metadata) {
        return { state: "invalid", databaseFile, databaseBytes, error: "Schema metadata is missing" };
      }
      const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as
        | { value?: unknown }
        | undefined;
      const version = Number(row ? parseJson(row.value) : Number.NaN);
      if (!Number.isInteger(version) || version < 1) {
        return { state: "invalid", databaseFile, databaseBytes, error: "Schema version is missing or invalid" };
      }
      if (version === 7 && schemaVersion === 8) {
        return {
          state: "migratable",
          databaseFile,
          databaseBytes,
          version,
          targetVersion: schemaVersion,
        };
      }
      if (version !== schemaVersion) {
        return {
          state: "incompatible",
          databaseFile,
          databaseBytes,
          version,
          targetVersion: schemaVersion,
          error: `Database schema v${version} is incompatible; schema v${schemaVersion} is required. Run the bridge release first.`,
        };
      }
      return {
        state: "current",
        databaseFile,
        databaseBytes,
        version,
        targetVersion: schemaVersion,
      };
    } finally {
      database.close();
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { state: "new", databaseFile, databaseBytes: 0, version: null, targetVersion: schemaVersion };
    }
    return {
      state: "invalid",
      databaseFile,
      databaseBytes: null,
      error: errorMessage(error),
      targetVersion: schemaVersion,
    };
  }
}
