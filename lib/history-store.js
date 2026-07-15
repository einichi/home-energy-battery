import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const SCHEMA_VERSION = 2;
const MAX_RAW_AUTO_SAMPLES = 250_000;
const ENERGY_KEYS = [
  "houseDemandKwh",
  "solarGenerationKwh",
  "gridImportKwh",
  "gridExportKwh",
  "fuelCellKwh",
  "batteryChargeKwh",
  "batteryDischargeKwh",
];
const POWER_KEYS = [
  "batteryPowerW",
  "solarPowerW",
  "houseDemandW",
  "fuelCellPowerW",
  "gridExportW",
  "gridImportW",
];

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function localBucketStart(timeMs, resolution) {
  const date = new Date(timeMs);
  if (resolution === "daily") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  const minute = date.getMinutes() < 30 ? 0 : 30;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), minute).getTime();
}

function bucketEnd(startMs, resolution) {
  if (resolution === "daily") {
    const date = new Date(startMs);
    date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return startMs + 30 * 60_000;
}

function intervalEnergy(sample, previousSample, directKey, wattsKey, transform = (value) => Math.max(0, value)) {
  const direct = finite(sample?.[directKey]);
  if (direct !== null) return direct;
  const watts = finite(sample?.[wattsKey]);
  const currentMs = timestampMs(sample?.timestamp);
  const previousMs = timestampMs(previousSample?.timestamp);
  if (watts === null || currentMs === null || previousMs === null) return null;
  const hours = Math.max(0, Math.min(1, (currentMs - previousMs) / 3_600_000));
  return hours * transform(watts) / 1000;
}

export function enrichHistorySample(sample, previousSample = null) {
  const enriched = { ...sample };
  const mappings = [
    ["houseDemandKwh", "houseDemandW", (value) => Math.max(0, value)],
    ["solarGenerationKwh", "solarPowerW", (value) => Math.max(0, value)],
    ["gridImportKwh", "gridImportW", (value) => Math.max(0, value)],
    ["gridExportKwh", "gridExportW", (value) => Math.max(0, value)],
    ["fuelCellKwh", "fuelCellPowerW", (value) => Math.max(0, value)],
    ["batteryChargeKwh", "batteryPowerW", (value) => Math.max(0, value)],
    ["batteryDischargeKwh", "batteryPowerW", (value) => Math.max(0, -value)],
  ];
  const currentMs = timestampMs(sample?.timestamp);
  const previousMs = timestampMs(previousSample?.timestamp);
  const coveredSeconds = currentMs !== null && previousMs !== null
    ? Math.max(0, Math.min(3600, (currentMs - previousMs) / 1000))
    : 0;
  const coverageSeconds = { ...(sample?.coverageSeconds ?? {}) };
  for (const [directKey, wattsKey, transform] of mappings) {
    const value = intervalEnergy(sample, previousSample, directKey, wattsKey, transform);
    if (value !== null) {
      enriched[directKey] = value;
      coverageSeconds[directKey] = Number(coverageSeconds[directKey] ?? 0) + coveredSeconds;
    }
  }
  if (Object.keys(coverageSeconds).length) enriched.coverageSeconds = coverageSeconds;
  return enriched;
}

function emptyRollupState(startMs, resolution) {
  return {
    resolution,
    startMs,
    endMs: bucketEnd(startMs, resolution),
    count: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    powers: {},
    soc: { sum: 0, count: 0, min: null, max: null, first: null, last: null },
    energy: {},
    coverageSeconds: {},
    savings: { offPeakSavingYen: 0, solarSavingYen: 0 },
    circuits: { power: {}, energy: {}, cumulative: {} },
    guardTriggerCount: 0,
    rateYenPerKwh: null,
    rateLabel: null,
  };
}

function addAverageMetric(target, key, value) {
  const number = finite(value);
  if (number === null) return;
  const metric = target[key] ?? { sum: 0, count: 0, min: null, max: null };
  metric.sum += number;
  metric.count += 1;
  metric.min = metric.min === null ? number : Math.min(metric.min, number);
  metric.max = metric.max === null ? number : Math.max(metric.max, number);
  target[key] = metric;
}

function addRollupSample(state, sample) {
  state.count += Number(sample.rollupSampleCount ?? 1) || 1;
  state.firstTimestamp ??= sample.timestamp;
  state.lastTimestamp = sample.timestamp;
  for (const key of POWER_KEYS) addAverageMetric(state.powers, key, sample[key]);
  const soc = finite(sample.stateOfChargePercent);
  if (soc !== null) {
    state.soc.sum += soc;
    state.soc.count += 1;
    state.soc.min = state.soc.min === null ? soc : Math.min(state.soc.min, soc);
    state.soc.max = state.soc.max === null ? soc : Math.max(state.soc.max, soc);
    state.soc.first ??= soc;
    state.soc.last = soc;
  }
  for (const key of ENERGY_KEYS) {
    const value = finite(sample[key]);
    if (value === null) continue;
    const energy = state.energy[key] ?? { sum: 0, count: 0 };
    energy.sum += value;
    energy.count += 1;
    state.energy[key] = energy;
  }
  for (const [key, value] of Object.entries(sample.coverageSeconds ?? {})) {
    const seconds = finite(value);
    if (seconds !== null) state.coverageSeconds[key] = Number(state.coverageSeconds[key] ?? 0) + seconds;
  }
  state.savings.offPeakSavingYen += finite(sample.offPeakSavingYen) ?? 0;
  state.savings.solarSavingYen += finite(sample.solarSavingYen) ?? 0;
  for (const [channel, value] of Object.entries(sample.circuitPowerW ?? {})) {
    addAverageMetric(state.circuits.power, channel, value);
  }
  for (const [channel, value] of Object.entries(sample.circuitEnergyKwh ?? {})) {
    const energy = finite(value);
    if (energy !== null) state.circuits.energy[channel] = Number(state.circuits.energy[channel] ?? 0) + energy;
  }
  for (const [channel, value] of Object.entries(sample.circuitCumulativeKwh ?? {})) {
    const cumulative = finite(value);
    if (cumulative !== null) state.circuits.cumulative[channel] = cumulative;
  }
  state.guardTriggerCount += Math.max(0, finite(sample.guardTriggerCount) ?? 0);
  state.rateYenPerKwh = finite(sample.rateYenPerKwh) ?? state.rateYenPerKwh;
  state.rateLabel = sample.rateLabel ?? state.rateLabel;
  return state;
}

function rollupPayload(state) {
  const payload = {
    timestamp: state.lastTimestamp ?? new Date(Math.max(state.startMs, state.endMs - 1)).toISOString(),
    rollupResolution: state.resolution,
    rollupStart: new Date(state.startMs).toISOString(),
    rollupEnd: new Date(state.endMs).toISOString(),
    rollupSampleCount: state.count,
    coverageSeconds: state.coverageSeconds,
    offPeakSavingYen: state.savings.offPeakSavingYen,
    solarSavingYen: state.savings.solarSavingYen,
    guardTriggerCount: state.guardTriggerCount,
  };
  for (const [key, metric] of Object.entries(state.powers)) {
    if (metric.count > 0) payload[key] = metric.sum / metric.count;
  }
  if (state.powers.houseDemandW?.max != null) payload.peakHouseDemandW = state.powers.houseDemandW.max;
  if (state.soc.count > 0) {
    payload.stateOfChargePercent = state.soc.sum / state.soc.count;
    payload.startStateOfChargePercent = state.soc.first;
    payload.endStateOfChargePercent = state.soc.last;
    payload.minimumStateOfChargePercent = state.soc.min;
    payload.maximumStateOfChargePercent = state.soc.max;
  }
  for (const [key, energy] of Object.entries(state.energy)) {
    if (energy.count > 0) payload[key] = energy.sum;
  }
  const circuitPowerW = {};
  for (const [channel, metric] of Object.entries(state.circuits.power)) {
    if (metric.count > 0) circuitPowerW[channel] = metric.sum / metric.count;
  }
  if (Object.keys(circuitPowerW).length) payload.circuitPowerW = circuitPowerW;
  if (Object.keys(state.circuits.energy).length) payload.circuitEnergyKwh = state.circuits.energy;
  if (Object.keys(state.circuits.cumulative).length) payload.circuitCumulativeKwh = state.circuits.cumulative;
  if (state.rateYenPerKwh !== null) payload.rateYenPerKwh = state.rateYenPerKwh;
  if (state.rateLabel !== null) payload.rateLabel = state.rateLabel;
  return payload;
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function normalizeRetentionPolicy(policy = {}, legacyRawTelemetryDays = undefined) {
  const days = (value, fallback) => {
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
  };
  return {
    rawTelemetryDays: days(policy.rawTelemetryDays ?? legacyRawTelemetryDays, 1095),
    intervalAggregatesDays: days(policy.intervalAggregatesDays, null),
    dailyAggregatesDays: days(policy.dailyAggregatesDays, null),
    adaptiveChargingHistoryDays: days(policy.adaptiveChargingHistoryDays, null),
    automationEventDays: days(policy.automationEventDays, null),
    notificationDeliveryDays: days(policy.notificationDeliveryDays, 365),
  };
}

export function createHistoryStore({ dataDir, logger = console } = {}) {
  const databaseFile = path.join(dataDir, "history.sqlite");
  const legacyHistoryFile = path.join(dataDir, "history", "samples.jsonl");
  const legacyForecastFile = path.join(dataDir, "adaptive-charging", "forecast-snapshots.jsonl");
  const legacyWeatherFile = path.join(dataDir, "adaptive-charging", "historical-weather.jsonl");
  let database = null;
  let previousSample = null;
  const rollupStates = new Map();

  const ready = () => database !== null;
  const requireDatabase = () => {
    if (!database) throw new Error("history database is not initialized");
    return database;
  };

  function metadataGet(key, fallback = null) {
    const row = requireDatabase().prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    return row ? parseJson(row.value, fallback) : fallback;
  }

  function metadataSet(key, value) {
    requireDatabase().prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  function createSchema() {
    const db = requireDatabase();
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS rollups (
        resolution TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        bucket_end_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY(resolution, bucket_start_ms)
      );
      CREATE INDEX IF NOT EXISTS rollups_range_idx ON rollups(resolution, bucket_start_ms, bucket_end_ms);
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
    `);
    metadataSet("schemaVersion", SCHEMA_VERSION);
  }

  function loadRollupState(resolution, startMs) {
    const key = `${resolution}:${startMs}`;
    if (rollupStates.has(key)) return rollupStates.get(key);
    const row = requireDatabase().prepare(
      "SELECT state_json FROM rollups WHERE resolution = ? AND bucket_start_ms = ?",
    ).get(resolution, startMs);
    const state = row ? parseJson(row.state_json) : emptyRollupState(startMs, resolution);
    rollupStates.set(key, state);
    return state;
  }

  function persistRollup(state) {
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

  function updateRollups(sample) {
    const timeMs = timestampMs(sample.timestamp);
    if (timeMs === null) return;
    for (const resolution of ["interval", "daily"]) {
      const startMs = localBucketStart(timeMs, resolution);
      const state = loadRollupState(resolution, startMs);
      addRollupSample(state, sample);
      persistRollup(state);
    }
  }

  function insertSample(sample, { sourceFile = null, sourceLine = null } = {}) {
    const timeMs = timestampMs(sample?.timestamp);
    if (timeMs === null) return { inserted: false, sample: null };
    const enriched = enrichHistorySample(sample, previousSample);
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO samples(timestamp_ms, timestamp, payload_json, source_file, source_line)
      VALUES (?, ?, ?, ?, ?)
    `).run(timeMs, enriched.timestamp, JSON.stringify(enriched), sourceFile, sourceLine);
    if (Number(result.changes) > 0) {
      updateRollups(enriched);
      previousSample = enriched;
      return { inserted: true, sample: enriched };
    }
    return { inserted: false, sample: enriched };
  }

  function appendSample(sample) {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = insertSample(sample);
      db.exec("COMMIT");
      return result.sample;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function latestRawSample() {
    const row = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
    ).get();
    return row ? parseJson(row.payload_json) : null;
  }

  async function migrateJsonLines(file, metadataKey, consume) {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") return { imported: 0, skipped: 0, missing: true };
      throw error;
    }
    const marker = metadataGet(metadataKey, { line: 0, size: 0, complete: false });
    if (marker.complete && Number(marker.size) === Number(fileStat.size)) {
      return { imported: 0, skipped: 0, complete: true };
    }
    if (marker.complete && Number(fileStat.size) < Number(marker.size)) {
      logger.warn?.(`history: ${file} is smaller than its completed migration marker; leaving it untouched`);
      return { imported: 0, skipped: 0, complete: true, truncated: true };
    }
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let imported = 0;
    let skipped = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const db = requireDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of batch) {
          if (consume(item.value, item.line)) imported += 1;
        }
        metadataSet(metadataKey, { line: batch.at(-1).line, size: fileStat.size, complete: false });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      batch = [];
    };
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (lineNumber <= Number(marker.line ?? 0) || !line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch (error) {
          skipped += 1;
          if (skipped <= 20) {
            logger.warn?.(`history: failed to parse ${file}:line ${lineNumber}: ${error.message}; JSON: ${line.slice(0, 2000)}`);
          }
          continue;
        }
        if (!value || typeof value !== "object") {
          skipped += 1;
          if (skipped <= 20) logger.warn?.(`history: ignored non-object ${file}:line ${lineNumber}; JSON: ${line.slice(0, 2000)}`);
          continue;
        }
        batch.push({ line: lineNumber, value });
        if (batch.length >= 1000) flush();
      }
      flush();
      metadataSet(metadataKey, {
        line: lineNumber,
        size: fileStat.size,
        complete: true,
        completedAt: new Date().toISOString(),
      });
    } finally {
      lines.close();
      if (!stream.destroyed) stream.destroy();
    }
    return { imported, skipped, complete: true };
  }

  async function migrateLegacyHistory() {
    previousSample = latestRawSample();
    const result = await migrateJsonLines(
      legacyHistoryFile,
      "migration:history-jsonl-v1",
      (sample, line) => insertSample(sample, { sourceFile: "history/samples.jsonl", sourceLine: line }).inserted,
    );
    if (result.imported || result.skipped) {
      logger.log?.(`history: imported ${result.imported} legacy samples into SQLite${result.skipped ? `; skipped ${result.skipped} invalid records` : ""}`);
    }
    previousSample = latestRawSample();
    return result;
  }

  function recordForecast(forecast) {
    const fetchedAt = forecast?.fetchedAt ?? new Date().toISOString();
    const timeMs = timestampMs(fetchedAt);
    if (timeMs === null) return false;
    requireDatabase().prepare(`
      INSERT INTO forecasts(fetched_at_ms, fetched_at, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(fetched_at_ms) DO UPDATE SET payload_json = excluded.payload_json
    `).run(timeMs, fetchedAt, JSON.stringify(forecast));
    return true;
  }

  function insertWeather(records = []) {
    const statement = requireDatabase().prepare(`
      INSERT INTO weather(time_ms, time, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(time_ms) DO UPDATE SET payload_json = excluded.payload_json
    `);
    let inserted = 0;
    for (const record of records) {
      const time = record.time ?? record.timestamp;
      const timeMs = timestampMs(time);
      if (timeMs === null) continue;
      statement.run(timeMs, time, JSON.stringify(record));
      inserted += 1;
    }
    return inserted;
  }

  function recordWeather(records = []) {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = insertWeather(records);
      db.exec("COMMIT");
      return inserted;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function migrateAdaptiveChargingContext() {
    await migrateJsonLines(legacyForecastFile, "migration:forecast-jsonl-v1", (forecast) => recordForecast(forecast));
    await migrateJsonLines(legacyWeatherFile, "migration:weather-jsonl-v1", (record) => {
      return insertWeather([record]) > 0;
    });
  }

  async function initialize() {
    if (database) return;
    await mkdir(dataDir, { recursive: true });
    database = new DatabaseSync(databaseFile);
    createSchema();
    await migrateLegacyHistory();
    await migrateAdaptiveChargingContext();
    previousSample = latestRawSample();
  }

  function rowsToPayloads(rows) {
    return rows.map((row) => parseJson(row.payload_json)).filter(Boolean);
  }

  function rawRows(startMs, endMs) {
    return requireDatabase().prepare(`
      SELECT payload_json FROM samples
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms, id
    `).all(startMs, endMs);
  }

  function rollupRows(startMs, endMs, resolution) {
    return requireDatabase().prepare(`
      SELECT payload_json FROM rollups
      WHERE resolution = ? AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms
    `).all(resolution, startMs, endMs);
  }

  function rawRangeStats(startMs, endMs) {
    const row = requireDatabase().prepare(`
      SELECT COUNT(*) AS count, MIN(timestamp_ms) AS earliest, MAX(timestamp_ms) AS latest
      FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).get(startMs, endMs);
    return {
      count: Number(row?.count ?? 0),
      earliest: finite(row?.earliest),
      latest: finite(row?.latest),
    };
  }

  function intervalRangeBounds(startMs, endMs) {
    const firstRow = requireDatabase().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms ASC LIMIT 1
    `).get(startMs, endMs);
    const lastRow = requireDatabase().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms DESC LIMIT 1
    `).get(startMs, endMs);
    if (!firstRow || !lastRow) return { earliest: null, latest: null };
    const first = parseJson(firstRow.state_json, {});
    const last = parseJson(lastRow.state_json, {});
    return {
      earliest: timestampMs(first.firstTimestamp),
      latest: timestampMs(last.lastTimestamp),
    };
  }

  function detailedAvailableRows(startMs, endMs, earliestRaw) {
    const olderRows = requireDatabase().prepare(`
      SELECT payload_json, state_json, bucket_end_ms FROM rollups
      WHERE resolution = 'interval'
        AND bucket_end_ms > ?
        AND bucket_start_ms <= ?
        AND bucket_start_ms < ?
      ORDER BY bucket_start_ms
    `).all(startMs, endMs, earliestRaw);
    const retainedRollups = [];
    for (const row of olderRows) {
      const state = parseJson(row.state_json, {});
      const lastTimestamp = timestampMs(state.lastTimestamp);
      const endsBeforeRaw = lastTimestamp !== null
        ? lastTimestamp < earliestRaw
        : Number(row.bucket_end_ms) <= earliestRaw;
      if (!endsBeforeRaw) continue;
      retainedRollups.push(row);
    }
    return [
      ...rowsToPayloads(retainedRollups),
      ...rowsToPayloads(rawRows(earliestRaw, endMs)),
    ];
  }

  function querySamples(startMs, endMs, { resolution = "auto" } = {}) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
    if (resolution === "raw") return rowsToPayloads(rawRows(startMs, endMs));
    if (resolution === "interval" || resolution === "daily") {
      return rowsToPayloads(rollupRows(startMs, endMs, resolution));
    }
    const rawStats = rawRangeStats(startMs, endMs);
    if (rawStats.count === 0) {
      return rowsToPayloads(rollupRows(startMs, endMs, "interval"));
    }

    const intervalBounds = intervalRangeBounds(startMs, endMs);
    const intervalCoversRaw =
      intervalBounds.earliest !== null &&
      intervalBounds.latest !== null &&
      intervalBounds.earliest <= rawStats.earliest &&
      intervalBounds.latest >= rawStats.latest;
    if (rawStats.count > MAX_RAW_AUTO_SAMPLES && intervalCoversRaw) {
      return rowsToPayloads(rollupRows(startMs, endMs, "interval"));
    }
    return detailedAvailableRows(startMs, endMs, rawStats.earliest);
  }

  function recordEvent({ eventKey, at, category, type = "event", message = null, payload = null }) {
    const timestamp = at ?? new Date().toISOString();
    const timeMs = timestampMs(timestamp);
    if (timeMs === null || !eventKey) return false;
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO events(event_key, timestamp_ms, timestamp, category, type, message, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventKey, timeMs, timestamp, category, type, message, payload === null ? null : JSON.stringify(payload));
    return Number(result.changes) > 0;
  }

  function recentEvents(category, limit = 200) {
    return requireDatabase().prepare(`
      SELECT timestamp, type, message, payload_json FROM events
      WHERE category = ? ORDER BY timestamp_ms DESC, id DESC LIMIT ?
    `).all(category, Math.max(1, Math.round(limit))).map((row) => ({
      at: row.timestamp,
      type: row.type,
      message: row.message,
      payload: row.payload_json ? parseJson(row.payload_json) : null,
    })).reverse();
  }

  function awayPeriodView(row, nowMs = Date.now()) {
    if (!row) return null;
    const status = nowMs < row.start_ms
      ? "scheduled"
      : nowMs < row.until_ms
        ? "active"
        : "completed";
    return {
      id: row.id,
      from: row.start_at,
      until: row.until_at,
      source: row.source,
      status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function awayPeriod(id, nowMs = Date.now()) {
    return awayPeriodView(requireDatabase().prepare(`
      SELECT * FROM away_periods WHERE id = ?
    `).get(id), nowMs);
  }

  function awayPeriods({ includeCompleted = true, startMs = null, endMs = null, nowMs = Date.now() } = {}) {
    const rows = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? requireDatabase().prepare(`
          SELECT * FROM away_periods
          WHERE start_ms < ? AND until_ms > ?
          ORDER BY start_ms, id
        `).all(endMs, startMs)
      : requireDatabase().prepare(`
          SELECT * FROM away_periods ORDER BY start_ms, id
        `).all();
    return rows
      .map((row) => awayPeriodView(row, nowMs))
      .filter((period) => includeCompleted || period.status !== "completed");
  }

  function createAwayPeriod(period) {
    requireDatabase().prepare(`
      INSERT INTO away_periods(id, start_ms, start_at, until_ms, until_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      period.id,
      timestampMs(period.from),
      period.from,
      timestampMs(period.until),
      period.until,
      period.source,
      period.createdAt,
      period.updatedAt,
    );
    return awayPeriod(period.id);
  }

  function updateAwayPeriod(period) {
    const result = requireDatabase().prepare(`
      UPDATE away_periods
      SET start_ms = ?, start_at = ?, until_ms = ?, until_at = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      timestampMs(period.from),
      period.from,
      timestampMs(period.until),
      period.until,
      period.source,
      period.updatedAt,
      period.id,
    );
    return Number(result.changes) > 0 ? awayPeriod(period.id) : null;
  }

  function deleteAwayPeriod(id) {
    return Number(requireDatabase().prepare("DELETE FROM away_periods WHERE id = ?").run(id).changes) > 0;
  }

  function historicalWeather() {
    return requireDatabase().prepare("SELECT payload_json FROM weather ORDER BY time_ms").all()
      .map((row) => parseJson(row.payload_json)).filter(Boolean);
  }

  async function databaseSizeBytes() {
    let total = 0;
    for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      try {
        total += (await stat(file)).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return total;
  }

  async function stats() {
    const db = requireDatabase();
    const raw = db.prepare(`
      SELECT COUNT(*) AS sampleCount, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM samples
    `).get();
    const rollups = Object.fromEntries(db.prepare(`
      SELECT resolution, COUNT(*) AS count FROM rollups GROUP BY resolution
    `).all().map((row) => [row.resolution, Number(row.count)]));
    const events = Object.fromEntries(db.prepare(`
      SELECT category, COUNT(*) AS count FROM events GROUP BY category
    `).all().map((row) => [row.category, Number(row.count)]));
    const earliestMs = timestampMs(raw.earliest);
    const latestMs = timestampMs(raw.latest);
    return {
      sizeBytes: await databaseSizeBytes(),
      sampleCount: Number(raw.sampleCount),
      earliest: raw.earliest ?? null,
      latest: raw.latest ?? null,
      daysRecorded: earliestMs !== null && latestMs !== null ? Math.max(0, (latestMs - earliestMs) / 86_400_000) : 0,
      rollups: {
        interval: rollups.interval ?? 0,
        daily: rollups.daily ?? 0,
      },
      events,
      forecasts: Number(db.prepare("SELECT COUNT(*) AS count FROM forecasts").get().count),
      weatherRecords: Number(db.prepare("SELECT COUNT(*) AS count FROM weather").get().count),
      databaseFile,
      legacyHistoryFile,
      migration: metadataGet("migration:history-jsonl-v1", null),
      adaptiveChargingMigrations: {
        forecasts: metadataGet("migration:forecast-jsonl-v1", null),
        weather: metadataGet("migration:weather-jsonl-v1", null),
      },
    };
  }

  async function deleteInChunks(sql, parameters = []) {
    const statement = requireDatabase().prepare(sql);
    let deleted = 0;
    while (true) {
      const result = statement.run(...parameters);
      const changes = Number(result.changes);
      deleted += changes;
      if (changes < 10_000) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return deleted;
  }

  async function applyRetention(policyInput = {}, now = new Date()) {
    const policy = normalizeRetentionPolicy(policyInput);
    const before = await stats();
    const cutoff = (days) => now.getTime() - days * 86_400_000;
    const deleted = {
      rawSamples: await deleteInChunks(`
        DELETE FROM samples WHERE id IN (
          SELECT id FROM samples WHERE timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000
        )
      `, [cutoff(policy.rawTelemetryDays)]),
      intervalRollups: 0,
      dailyRollups: 0,
      adaptiveChargingEvents: 0,
      automationEvents: 0,
      notificationEvents: 0,
    };
    if (policy.intervalAggregatesDays !== null) {
      deleted.intervalRollups = await deleteInChunks(`
        DELETE FROM rollups WHERE rowid IN (
          SELECT rowid FROM rollups WHERE resolution = 'interval' AND bucket_end_ms < ? LIMIT 10000
        )
      `, [cutoff(policy.intervalAggregatesDays)]);
    }
    if (policy.dailyAggregatesDays !== null) {
      deleted.dailyRollups = await deleteInChunks(`
        DELETE FROM rollups WHERE rowid IN (
          SELECT rowid FROM rollups WHERE resolution = 'daily' AND bucket_end_ms < ? LIMIT 10000
        )
      `, [cutoff(policy.dailyAggregatesDays)]);
    }
    const eventRetention = [
      ["adaptiveCharging", policy.adaptiveChargingHistoryDays, "adaptiveChargingEvents"],
      ["automation", policy.automationEventDays, "automationEvents"],
      ["notification", policy.notificationDeliveryDays, "notificationEvents"],
    ];
    for (const [category, days, resultKey] of eventRetention) {
      if (days === null) continue;
      deleted[resultKey] = await deleteInChunks(`
        DELETE FROM events WHERE id IN (
          SELECT id FROM events WHERE category = ? AND timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000
        )
      `, [category, cutoff(days)]);
    }
    if (policy.adaptiveChargingHistoryDays !== null) {
      await deleteInChunks(`
        DELETE FROM forecasts WHERE fetched_at_ms IN (
          SELECT fetched_at_ms FROM forecasts WHERE fetched_at_ms < ? ORDER BY fetched_at_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
      await deleteInChunks(`
        DELETE FROM weather WHERE time_ms IN (
          SELECT time_ms FROM weather WHERE time_ms < ? ORDER BY time_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
    }
    requireDatabase().exec("PRAGMA wal_checkpoint(PASSIVE)");
    const after = await stats();
    return { policy, before, after, deleted };
  }

  function close() {
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
    historicalWeather,
    initialize,
    isReady: ready,
    latestSample: latestRawSample,
    querySamples,
    recentEvents,
    recordEvent,
    recordForecast,
    recordWeather,
    stats,
    updateAwayPeriod,
  };
}
