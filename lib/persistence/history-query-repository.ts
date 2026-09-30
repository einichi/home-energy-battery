import type { DatabaseSync } from "node:sqlite";

import type { HistorySample } from "../contracts/history.js";
import type { SolarForecastHour } from "../domain/solar-forecast.js";

export type HistoryResolution = "interval" | "daily";

export interface ChargeSession {
  startedAt?: string;
  endedAt?: string;
}

export interface BatteryChargeCurveSample {
  at: string;
  socPercent: number;
  batteryChargingW: number;
  sessionId: string;
  day: string;
}

interface PayloadRow {
  payload_json?: unknown;
  state_json?: unknown;
  bucket_end_ms?: unknown;
}

interface RangeStats {
  count: number;
  earliest: number | null;
  latest: number | null;
}

interface QueryRollupState {
  firstTimestamp: unknown;
  lastTimestamp: unknown;
  powers: Record<string, { weight: number | null; weightedSum: number | null }>;
}

interface HistoryQueryRepositoryDependencies {
  database: () => DatabaseSync;
  compactHistorySample: (sample: HistorySample) => HistorySample;
  interpretHistorySample: (
    rawSample: HistorySample,
    previousRawSample: HistorySample | null,
    options: { metricBaselines: Record<string, HistorySample> | null },
  ) => HistorySample;
  updateMetricBaselines: (
    metricBaselines: Record<string, HistorySample>,
    sample: HistorySample,
  ) => Record<string, HistorySample>;
  maxRawAutoBytes: number;
  maxRawAutoSamples: number;
  autoRawDetailWindowMs: number;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value: unknown): number | null {
  const time = new Date(String(value ?? "")).getTime();
  return Number.isFinite(time) ? time : null;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function historySample(value: unknown): HistorySample | null {
  return objectValue(value);
}

function rollupState(value: unknown): QueryRollupState {
  const record = objectValue(value) ?? {};
  const powersRecord = objectValue(record.powers) ?? {};
  const powers: QueryRollupState["powers"] = {};
  for (const [key, rawMetric] of Object.entries(powersRecord)) {
    const metric = objectValue(rawMetric);
    if (!metric) continue;
    powers[key] = {
      weight: finite(metric.weight),
      weightedSum: finite(metric.weightedSum),
    };
  }
  return {
    firstTimestamp: record.firstTimestamp,
    lastTimestamp: record.lastTimestamp,
    powers,
  };
}

export function createHistoryQueryRepository({
  database,
  compactHistorySample,
  interpretHistorySample,
  updateMetricBaselines,
  maxRawAutoBytes,
  maxRawAutoSamples,
  autoRawDetailWindowMs,
}: HistoryQueryRepositoryDependencies) {
  function rawRows(startMs: number, endMs: number): PayloadRow[] {
    return database().prepare(`
      SELECT payload_json FROM samples
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms, id
    `).all(startMs, endMs) as PayloadRow[];
  }

  function interpretedRawPayloads(startMs: number, endMs: number): HistorySample[] {
    const contextRows = database().prepare(`
      SELECT payload_json FROM samples
      WHERE timestamp_ms < ?
      ORDER BY timestamp_ms DESC, id DESC LIMIT 5000
    `).all(startMs).reverse() as PayloadRow[];
    const metricContext: Record<string, HistorySample> = {};
    let previousRaw: HistorySample | null = null;
    for (const row of contextRows) {
      const parsed = historySample(parseJson(row.payload_json));
      if (!parsed) continue;
      const raw = compactHistorySample(parsed);
      if (timestampMs(raw.timestamp) === null) continue;
      previousRaw = raw;
      updateMetricBaselines(metricContext, raw);
    }
    const result: HistorySample[] = [];
    for (const row of rawRows(startMs, endMs)) {
      const parsed = historySample(parseJson(row.payload_json));
      if (!parsed) continue;
      const raw = compactHistorySample(parsed);
      if (timestampMs(raw.timestamp) === null) continue;
      const previousTimestampMs = previousRaw ? timestampMs(previousRaw.timestamp) : null;
      const baselineIsOutsideRange = previousTimestampMs !== null && previousTimestampMs < startMs;
      const interpreted = interpretHistorySample(
        raw,
        baselineIsOutsideRange ? null : previousRaw,
        { metricBaselines: baselineIsOutsideRange ? null : metricContext },
      );
      result.push(interpreted);
      previousRaw = raw;
      updateMetricBaselines(metricContext, raw);
    }
    return result;
  }

  function rollupRowsToPayloads(rows: PayloadRow[]): HistorySample[] {
    const payloads: HistorySample[] = [];
    for (const row of rows) {
      const payload = historySample(parseJson(row.payload_json));
      if (!payload) continue;
      const state = rollupState(parseJson(row.state_json));
      const powerCoverageSeconds: Record<string, number> = { ...(payload.powerCoverageSeconds ?? {}) };
      const intervalAveragePowerW: Record<string, number> = { ...(payload.intervalAveragePowerW ?? {}) };
      for (const [key, metric] of Object.entries(state.powers)) {
        if (metric.weight === null || metric.weight <= 0 || metric.weightedSum === null) continue;
        powerCoverageSeconds[key] = metric.weight;
        intervalAveragePowerW[key] = metric.weightedSum / metric.weight;
      }
      if (Object.keys(powerCoverageSeconds).length) payload.powerCoverageSeconds = powerCoverageSeconds;
      if (Object.keys(intervalAveragePowerW).length) payload.intervalAveragePowerW = intervalAveragePowerW;
      payloads.push(payload);
    }
    return payloads;
  }

  function rollupRows(startMs: number, endMs: number, resolution: HistoryResolution): PayloadRow[] {
    return database().prepare(`
      SELECT payload_json, state_json FROM rollups
      WHERE resolution = ? AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms
    `).all(resolution, startMs, endMs) as PayloadRow[];
  }

  function rawRangeStats(startMs: number, endMs: number): RangeStats {
    const row = database().prepare(`
      SELECT COUNT(*) AS count,
        MIN(timestamp_ms) AS earliest,
        MAX(timestamp_ms) AS latest
      FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).get(startMs, endMs) as Record<string, unknown> | undefined;
    return {
      count: Number(row?.count ?? 0),
      earliest: finite(row?.earliest),
      latest: finite(row?.latest),
    };
  }

  function rawRangePayloadBytes(startMs: number, endMs: number): number {
    const row = database().prepare(`
      SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS payload_bytes
      FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).get(startMs, endMs) as Record<string, unknown> | undefined;
    return Number(row?.payload_bytes ?? 0);
  }

  function intervalRangeBounds(startMs: number, endMs: number): { earliest: number | null; latest: number | null } {
    const firstRow = database().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms ASC LIMIT 1
    `).get(startMs, endMs) as PayloadRow | undefined;
    const lastRow = database().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms DESC LIMIT 1
    `).get(startMs, endMs) as PayloadRow | undefined;
    if (!firstRow || !lastRow) return { earliest: null, latest: null };
    const first = rollupState(parseJson(firstRow.state_json));
    const last = rollupState(parseJson(lastRow.state_json));
    return {
      earliest: timestampMs(first.firstTimestamp),
      latest: timestampMs(last.lastTimestamp),
    };
  }

  function detailedAvailableRows(startMs: number, endMs: number, earliestRaw: number): HistorySample[] {
    const olderRows = database().prepare(`
      SELECT payload_json, state_json, bucket_end_ms FROM rollups
      WHERE resolution = 'interval'
        AND bucket_end_ms > ?
        AND bucket_start_ms <= ?
        AND bucket_start_ms < ?
      ORDER BY bucket_start_ms
    `).all(startMs, endMs, earliestRaw) as PayloadRow[];
    const retainedRollups: PayloadRow[] = [];
    for (const row of olderRows) {
      const state = rollupState(parseJson(row.state_json));
      const lastTimestamp = timestampMs(state.lastTimestamp);
      const endsBeforeRaw = lastTimestamp !== null
        ? lastTimestamp < earliestRaw
        : Number(row.bucket_end_ms) <= earliestRaw;
      if (endsBeforeRaw) retainedRollups.push(row);
    }
    return [
      ...rollupRowsToPayloads(retainedRollups),
      ...interpretedRawPayloads(earliestRaw, endMs),
    ];
  }

  function querySamples(
    startMs: number,
    endMs: number,
    { resolution = "auto" }: { resolution?: HistoryResolution | "raw" | "auto" } = {},
  ): HistorySample[] {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
    if (resolution === "raw") return interpretedRawPayloads(startMs, endMs);
    if (resolution === "interval" || resolution === "daily") {
      return rollupRowsToPayloads(rollupRows(startMs, endMs, resolution));
    }
    const rawStats = rawRangeStats(startMs, endMs);
    if (rawStats.count === 0) return rollupRowsToPayloads(rollupRows(startMs, endMs, "interval"));

    const intervalBounds = intervalRangeBounds(startMs, endMs);
    const intervalCoversRaw = rawStats.earliest !== null && rawStats.latest !== null
      && intervalBounds.earliest !== null
      && intervalBounds.latest !== null
      && intervalBounds.earliest <= rawStats.earliest
      && intervalBounds.latest >= rawStats.latest;
    const rawResponseTooLarge = rawStats.count > maxRawAutoSamples
      || rawRangePayloadBytes(startMs, endMs) > maxRawAutoBytes;
    const preserveRawDetail = endMs - startMs <= autoRawDetailWindowMs;
    if (!preserveRawDetail && rawResponseTooLarge && intervalCoversRaw) {
      return rollupRowsToPayloads(rollupRows(startMs, endMs, "interval"));
    }
    return detailedAvailableRows(startMs, endMs, rawStats.earliest!);
  }

  function batteryChargeCurveSamples(sessions: ChargeSession[] = []): BatteryChargeCurveSample[] {
    const query = database().prepare(`
      SELECT timestamp_ms, timestamp,
        json_extract(payload_json, '$.stateOfChargePercent') AS soc,
        json_extract(payload_json, '$.batteryPowerW') AS battery_power_w
      FROM samples
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms, id
    `);
    const seen = new Set<string>();
    const samples: BatteryChargeCurveSample[] = [];
    for (const [sessionIndex, session] of sessions.entries()) {
      const startMs = timestampMs(session.startedAt);
      const endMs = timestampMs(session.endedAt);
      if (startMs === null || endMs === null || endMs <= startMs) continue;
      for (const row of query.all(startMs, endMs) as Array<Record<string, unknown>>) {
        const soc = finite(row.soc);
        const batteryChargingW = finite(row.battery_power_w);
        const key = `${row.timestamp_ms}:${sessionIndex}`;
        if (seen.has(key) || soc === null || batteryChargingW === null || batteryChargingW <= 0) continue;
        seen.add(key);
        const observedAt = new Date(String(row.timestamp ?? ""));
        samples.push({
          at: String(row.timestamp ?? ""),
          socPercent: soc,
          batteryChargingW,
          sessionId: `${session.startedAt ?? ""}:${session.endedAt ?? ""}`,
          day: `${observedAt.getFullYear()}-${String(observedAt.getMonth() + 1).padStart(2, "0")}-${String(observedAt.getDate()).padStart(2, "0")}`,
        });
      }
    }
    return samples;
  }

  function historicalWeather(): SolarForecastHour[] {
    const rows = database().prepare("SELECT payload_json FROM weather ORDER BY time_ms").all() as PayloadRow[];
    const result: SolarForecastHour[] = [];
    for (const row of rows) {
      const record = objectValue(parseJson(row.payload_json));
      if (!record || typeof record.timestamp !== "string" || !Number.isFinite(Number(record.tiltedIrradianceWm2))) continue;
      result.push(record as unknown as SolarForecastHour);
    }
    return result;
  }

  return { batteryChargeCurveSamples, historicalWeather, querySamples };
}
