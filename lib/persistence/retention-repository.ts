import type { DatabaseSync } from "node:sqlite";
import type { RetentionConfig } from "../contracts/configuration.js";
import { normalizeRetentionPolicy, type RetentionPolicy } from "../domain/retention.js";
import type { HistoryStoreStats } from "./history-statistics-repository.js";

interface Dependencies {
  database(): DatabaseSync;
  stats(): Promise<HistoryStoreStats>;
}

export function createRetentionRepository(dependencies: Dependencies) {
  async function deleteInChunks(sql: string, parameters: Array<string | number | null> = []): Promise<number> {
    const statement = dependencies.database().prepare(sql);
    let deleted = 0;
    while (true) {
      const changes = Number(statement.run(...parameters).changes);
      deleted += changes;
      if (changes < 10_000) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return deleted;
  }

  async function applyRetention(policyInput: Partial<RetentionConfig> = {}, now: Date = new Date()): Promise<{
    policy: RetentionPolicy; before: HistoryStoreStats; after: HistoryStoreStats; deleted: Record<string, number>;
  }> {
    const policy = normalizeRetentionPolicy(policyInput);
    const before = await dependencies.stats();
    const cutoff = (days: number) => now.getTime() - days * 86_400_000;
    const deleted: Record<string, number> = {
      rawSamples: await deleteInChunks("DELETE FROM samples WHERE id IN (SELECT id FROM samples WHERE timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000)", [cutoff(policy.rawTelemetryDays)]),
      intervalRollups: 0, dailyRollups: 0, adaptiveChargingEvents: 0, automationEvents: 0, commandReceiptEvents: 0, notificationEvents: 0,
    };
    if (policy.intervalAggregatesDays !== null) deleted.intervalRollups = await deleteInChunks("DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = 'interval' AND bucket_end_ms < ? LIMIT 10000)", [cutoff(policy.intervalAggregatesDays)]);
    if (policy.dailyAggregatesDays !== null) deleted.dailyRollups = await deleteInChunks("DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = 'daily' AND bucket_end_ms < ? LIMIT 10000)", [cutoff(policy.dailyAggregatesDays)]);
    const eventRetention: Array<[string, number | null, string]> = [
      ["adaptiveCharging", policy.adaptiveChargingHistoryDays, "adaptiveChargingEvents"],
      ["automation", policy.automationEventDays, "automationEvents"],
      ["command", policy.commandReceiptDays, "commandReceiptEvents"],
      ["notification", policy.notificationDeliveryDays, "notificationEvents"],
      ["fuelCell", policy.rawTelemetryDays, "fuelCellEvents"],
      ["database", policy.rawTelemetryDays, "databaseEvents"],
    ];
    for (const [category, days, resultKey] of eventRetention) {
      if (days !== null) deleted[resultKey] = await deleteInChunks("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE category = ? AND timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000)", [category, cutoff(days)]);
    }
    if (policy.adaptiveChargingHistoryDays !== null) {
      const cutoffMs = cutoff(policy.adaptiveChargingHistoryDays);
      await deleteInChunks("DELETE FROM forecasts WHERE fetched_at_ms IN (SELECT fetched_at_ms FROM forecasts WHERE fetched_at_ms < ? ORDER BY fetched_at_ms LIMIT 10000)", [cutoffMs]);
      await deleteInChunks("DELETE FROM weather WHERE time_ms IN (SELECT time_ms FROM weather WHERE time_ms < ? ORDER BY time_ms LIMIT 10000)", [cutoffMs]);
      await deleteInChunks("DELETE FROM solar_forecast_daily WHERE rowid IN (SELECT rowid FROM solar_forecast_daily WHERE period_end_ms < ? ORDER BY period_end_ms LIMIT 10000)", [cutoffMs]);
      await deleteInChunks("DELETE FROM fuel_cell_forecasts WHERE rowid IN (SELECT rowid FROM fuel_cell_forecasts WHERE target_start_ms < ? ORDER BY target_start_ms LIMIT 10000)", [cutoffMs]);
      deleted.adaptivePlanSnapshots = await deleteInChunks("DELETE FROM adaptive_plan_snapshots WHERE id IN (SELECT id FROM adaptive_plan_snapshots WHERE created_at_ms < ? ORDER BY created_at_ms LIMIT 10000)", [cutoffMs]);
    }
    // Bound auxiliary tables that have no dedicated retention field, using the
    // raw-telemetry window so they cannot grow without limit on defaults.
    const auxiliaryCutoff = cutoff(policy.rawTelemetryDays);
    deleted.backtestRuns = await deleteInChunks("DELETE FROM backtest_runs WHERE id IN (SELECT id FROM backtest_runs WHERE started_at_ms < ? LIMIT 10000)", [auxiliaryCutoff]);
    deleted.gasTariffSnapshots = await deleteInChunks("DELETE FROM gas_tariff_snapshots WHERE id IN (SELECT id FROM gas_tariff_snapshots WHERE fetched_at_ms < ? LIMIT 10000)", [auxiliaryCutoff]);
    dependencies.database().exec("PRAGMA wal_checkpoint(PASSIVE)");
    return { policy, before, after: await dependencies.stats(), deleted };
  }

  return { applyRetention };
}
