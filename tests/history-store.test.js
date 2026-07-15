import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createHistoryStore,
  enrichHistorySample,
  normalizeRetentionPolicy,
} from "../lib/history-store.js";

const sample = (timestamp, values = {}) => ({ timestamp, ...values });

assert.deepEqual(normalizeRetentionPolicy({}, 730), {
  rawTelemetryDays: 730,
  intervalAggregatesDays: null,
  dailyAggregatesDays: null,
  plannerHistoryDays: null,
  automationEventDays: null,
  notificationDeliveryDays: 365,
});

const enriched = enrichHistorySample(
  sample("2026-01-01T00:30:00.000Z", { houseDemandW: 1000, batteryPowerW: -500 }),
  sample("2026-01-01T00:00:00.000Z"),
);
assert.equal(enriched.houseDemandKwh, 0.5);
assert.equal(enriched.batteryChargeKwh, 0);
assert.equal(enriched.batteryDischargeKwh, 0.25);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "history-store-"));
try {
  await mkdir(path.join(dataDir, "history"), { recursive: true });
  await mkdir(path.join(dataDir, "solar-planner"), { recursive: true });
  const legacy = [
    sample("2024-01-01T00:00:00.000Z", { houseDemandW: 1000, solarPowerW: null }),
    sample("2024-01-01T00:30:00.000Z", { houseDemandW: 2000, solarPowerW: 500 }),
    sample("2024-01-01T01:00:00.000Z", { houseDemandW: null, solarPowerW: null }),
  ];
  await writeFile(
    path.join(dataDir, "history", "samples.jsonl"),
    `${legacy.map((value) => JSON.stringify(value)).join("\n")}\n{"truncated":\n`,
  );
  await writeFile(
    path.join(dataDir, "solar-planner", "forecast-snapshots.jsonl"),
    `${JSON.stringify({ fetchedAt: "2024-01-01T00:00:00.000Z", hours: [] })}\n`,
  );
  await writeFile(
    path.join(dataDir, "solar-planner", "historical-weather.jsonl"),
    `${JSON.stringify({ time: "2024-01-01T00:00:00.000Z", temperature: 10 })}\n`,
  );

  let store = createHistoryStore({ dataDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  let stats = await store.stats();
  assert.equal(stats.sampleCount, 3);
  assert.equal(stats.rollups.interval, 3);
  assert.equal(stats.rollups.daily, 1);
  assert.equal(stats.forecasts, 1);
  assert.equal(stats.weatherRecords, 1);

  const interval = store.querySamples(
    new Date("2024-01-01T00:00:00.000Z").getTime(),
    new Date("2024-01-01T02:00:00.000Z").getTime(),
    { resolution: "interval" },
  );
  assert.equal(interval.length, 3);
  assert.equal(interval[1].houseDemandKwh, 1);
  assert.equal(interval[1].solarGenerationKwh, 0.25);
  assert.equal(interval[2].houseDemandKwh, undefined);

  const oversizedRange = store.querySamples(
    new Date("2020-01-01T00:00:00.000Z").getTime(),
    new Date("2024-01-01T02:00:00.000Z").getTime(),
  );
  assert.equal(oversizedRange.length, 3);
  assert.ok(
    oversizedRange.every((value) => value.rollupResolution === undefined),
    "auto resolution returns all available raw records for a reasonably sized overlap",
  );

  store.recordEvent({
    eventKey: "notification:old",
    at: "2024-01-01T00:00:00.000Z",
    category: "notification",
    type: "delivery",
  });
  store.recordEvent({
    eventKey: "planner:old",
    at: "2024-01-01T00:00:00.000Z",
    category: "planner",
    type: "plan",
  });
  await store.applyRetention({
    rawTelemetryDays: 365,
    intervalAggregatesDays: null,
    dailyAggregatesDays: null,
    plannerHistoryDays: null,
    automationEventDays: null,
    notificationDeliveryDays: 365,
  }, new Date("2026-01-01T00:00:00.000Z"));
  stats = await store.stats();
  assert.equal(stats.sampleCount, 0);
  assert.equal(stats.rollups.interval, 3);
  assert.equal(stats.rollups.daily, 1);
  assert.equal(stats.events.notification ?? 0, 0);
  assert.equal(stats.events.planner, 1);
  store.close();

  store = createHistoryStore({ dataDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  stats = await store.stats();
  assert.equal(stats.sampleCount, 0, "completed legacy migration must not reinsert retained rows");
  assert.equal(stats.rollups.interval, 3);
  store.close();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

const partialRollupDir = await mkdtemp(path.join(os.tmpdir(), "history-store-partial-"));
try {
  let store = createHistoryStore({ dataDir: partialRollupDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  const firstDay = new Date("2026-01-01T00:00:00.000Z").getTime();
  for (let day = 0; day < 10; day += 1) {
    store.appendSample(sample(new Date(firstDay + day * 86_400_000).toISOString(), {
      houseDemandW: 1000 + day,
    }));
  }
  const complete = store.querySamples(firstDay - 20 * 86_400_000, firstDay + 10 * 86_400_000);
  assert.equal(complete.length, 10, "long requests return every available raw record under the cap");
  assert.ok(complete.every((value) => value.rollupResolution === undefined));
  store.close();

  const database = new DatabaseSync(path.join(partialRollupDir, "history.sqlite"));
  database.exec(`
    DELETE FROM rollups
    WHERE resolution = 'interval'
      AND bucket_start_ms < (
        SELECT MAX(bucket_start_ms) FROM rollups WHERE resolution = 'interval'
      )
  `);
  database.close();

  store = createHistoryStore({ dataDir: partialRollupDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  const recovered = store.querySamples(firstDay - 20 * 86_400_000, firstDay + 10 * 86_400_000);
  assert.equal(recovered.length, 10, "incomplete aggregates fall back to all available raw records");
  assert.ok(recovered.every((value) => value.rollupResolution === undefined));
  store.close();
} finally {
  await rm(partialRollupDir, { recursive: true, force: true });
}

const overlappingRollupDir = await mkdtemp(
  path.join(os.tmpdir(), "history-store-overlapping-rollup-"),
);
try {
  const store = createHistoryStore({
    dataDir: overlappingRollupDir,
    logger: { log() {}, warn() {} },
  });
  await store.initialize();
  const bucketStart = new Date("2026-07-15T00:00:00.000Z").getTime();
  for (let minute = 0; minute < 30; minute += 5) {
    store.appendSample(
      sample(new Date(bucketStart + minute * 60_000).toISOString(), {
        houseDemandW: 1000 + minute,
      }),
    );
  }
  const overlap = store.querySamples(
    bucketStart + 10 * 60_000,
    bucketStart + 30 * 60_000,
  );
  assert.equal(
    overlap.length,
    4,
    "a partial-bucket query returns every available raw sample",
  );
  assert.ok(
    overlap.every((value) => value.rollupResolution === undefined),
    "an overlapping interval rollup does not replace available raw telemetry",
  );
  assert.equal(overlap[0].timestamp, "2026-07-15T00:10:00.000Z");
  store.close();
} finally {
  await rm(overlappingRollupDir, { recursive: true, force: true });
}

console.log("history store tests passed");
