import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export interface HistoryStoreStats {
  sizeBytes: number;
  fileSizes: { mainBytes: number; walBytes: number; shmBytes: number; totalBytes: number };
  sampleCount: number;
  averageSampleBytes: number;
  estimatedDailyGrowthBytes: number;
  earliest: unknown;
  latest: unknown;
  daysRecorded: number;
  rollups: { interval: number; daily: number };
  events: Record<string, number>;
  forecasts: number;
  solarForecastIssues: number;
  solarForecastOutcomes: number;
  fuelCellForecastIssues: number;
  fuelCellForecastOutcomes: number;
  gasTariffSnapshots: number;
  gasTariffOverrides: number;
  weatherRecords: number;
  schemaVersion: unknown;
  energyCalculationVersion: unknown;
  lastCompaction: unknown;
  databaseFile: string;
}

interface Dependencies {
  database(): DatabaseSync;
  databaseFile: string;
  metadataGet<T>(key: string, fallback: T): T;
}

function timestampMs(value: unknown): number | null {
  const time = new Date(String(value ?? "")).getTime();
  return Number.isFinite(time) ? time : null;
}

function countRows(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

export function createHistoryStatisticsRepository(dependencies: Dependencies) {
  async function databaseFileSizes(): Promise<{ mainBytes: number; walBytes: number; shmBytes: number; totalBytes: number }> {
    const size = async (file: string): Promise<number> => {
      try { return (await stat(file)).size; }
      catch (error: unknown) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      }
    };
    const [mainBytes, walBytes, shmBytes] = await Promise.all([
      size(dependencies.databaseFile), size(`${dependencies.databaseFile}-wal`), size(`${dependencies.databaseFile}-shm`),
    ]);
    return { mainBytes, walBytes, shmBytes, totalBytes: mainBytes + walBytes + shmBytes };
  }

  async function stats(): Promise<HistoryStoreStats> {
    const database = dependencies.database();
    const raw = database.prepare("SELECT COUNT(*) AS sampleCount, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM samples").get() as Record<string, unknown>;
    const rollups = Object.fromEntries(database.prepare("SELECT resolution, COUNT(*) AS count FROM rollups GROUP BY resolution").all().map((row) => {
      const value = row as Record<string, unknown>;
      return [String(value.resolution ?? ""), Number(value.count)] as const;
    }));
    const events = Object.fromEntries(database.prepare("SELECT category, COUNT(*) AS count FROM events GROUP BY category").all().map((row) => {
      const value = row as Record<string, unknown>;
      return [String(value.category ?? ""), Number(value.count)] as const;
    }));
    const earliestMs = timestampMs(raw.earliest);
    const latestMs = timestampMs(raw.latest);
    const daysRecorded = earliestMs !== null && latestMs !== null ? Math.max(0, (latestMs - earliestMs) / 86_400_000) : 0;
    const payload = database.prepare("SELECT COALESCE(AVG(LENGTH(payload_json)), 0) AS average_bytes FROM (SELECT payload_json FROM samples ORDER BY id DESC LIMIT 1000)").get() as Record<string, unknown>;
    const fileSizes = await databaseFileSizes();
    const averageSampleBytes = Number(payload.average_bytes ?? 0);
    const samplesPerDay = daysRecorded > 0 ? Number(raw.sampleCount) / daysRecorded : 0;
    return {
      sizeBytes: fileSizes.totalBytes, fileSizes, sampleCount: Number(raw.sampleCount), averageSampleBytes,
      estimatedDailyGrowthBytes: Math.round(averageSampleBytes * samplesPerDay), earliest: raw.earliest ?? null,
      latest: raw.latest ?? null, daysRecorded,
      rollups: { interval: rollups.interval ?? 0, daily: rollups.daily ?? 0 }, events,
      forecasts: countRows(database, "SELECT COUNT(*) AS count FROM forecasts"),
      solarForecastIssues: countRows(database, "SELECT COUNT(*) AS count FROM solar_forecast_daily"),
      solarForecastOutcomes: countRows(database, "SELECT COUNT(*) AS count FROM solar_forecast_daily WHERE completed_at IS NOT NULL"),
      fuelCellForecastIssues: countRows(database, "SELECT COUNT(*) AS count FROM fuel_cell_forecasts"),
      fuelCellForecastOutcomes: countRows(database, "SELECT COUNT(*) AS count FROM fuel_cell_forecasts WHERE completed_at IS NOT NULL"),
      gasTariffSnapshots: countRows(database, "SELECT COUNT(*) AS count FROM gas_tariff_snapshots"),
      gasTariffOverrides: countRows(database, "SELECT COUNT(*) AS count FROM gas_tariff_overrides"),
      weatherRecords: countRows(database, "SELECT COUNT(*) AS count FROM weather"),
      schemaVersion: dependencies.metadataGet("schemaVersion", null),
      energyCalculationVersion: dependencies.metadataGet("energyCalculationVersion", null),
      lastCompaction: dependencies.metadataGet("compaction:schema-v7", null),
      databaseFile: dependencies.databaseFile,
    };
  }

  return { stats };
}
