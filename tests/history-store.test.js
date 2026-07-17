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
  adaptiveChargingHistoryDays: null,
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
  await mkdir(path.join(dataDir, "adaptive-charging"), { recursive: true });
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
    path.join(dataDir, "adaptive-charging", "forecast-snapshots.jsonl"),
    `${JSON.stringify({ fetchedAt: "2024-01-01T00:00:00.000Z", hours: [] })}\n`,
  );
  await writeFile(
    path.join(dataDir, "adaptive-charging", "historical-weather.jsonl"),
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
    eventKey: "adaptiveCharging:old",
    at: "2024-01-01T00:00:00.000Z",
    category: "adaptiveCharging",
    type: "plan",
  });
  await store.applyRetention({
    rawTelemetryDays: 365,
    intervalAggregatesDays: null,
    dailyAggregatesDays: null,
    adaptiveChargingHistoryDays: null,
    automationEventDays: null,
    notificationDeliveryDays: 365,
  }, new Date("2026-01-01T00:00:00.000Z"));
  stats = await store.stats();
  assert.equal(stats.sampleCount, 0);
  assert.equal(stats.rollups.interval, 3);
  assert.equal(stats.rollups.daily, 1);
  assert.equal(stats.events.notification ?? 0, 0);
  assert.equal(stats.events.adaptiveCharging, 1);
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

const awayPeriodDir = await mkdtemp(path.join(os.tmpdir(), "history-store-away-periods-"));
try {
  const store = createHistoryStore({ dataDir: awayPeriodDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  const created = store.createAwayPeriod({
    id: "holiday",
    from: "2026-07-20T01:00:00.000Z",
    until: "2026-07-20T09:00:00.000Z",
    source: "scheduled",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(created.status, "scheduled");
  assert.equal(store.awayPeriod("holiday", Date.parse("2026-07-20T02:00:00.000Z")).status, "active");
  assert.equal(store.awayPeriod("holiday", Date.parse("2026-07-21T00:00:00.000Z")).status, "completed");
  assert.equal(store.awayPeriods({
    includeCompleted: false,
    nowMs: Date.parse("2026-07-21T00:00:00.000Z"),
  }).length, 0, "completed Away periods are hidden from management queries");
  assert.equal(store.awayPeriods({
    includeCompleted: true,
    nowMs: Date.parse("2026-07-21T00:00:00.000Z"),
  }).length, 1, "completed Away periods remain available for learning");
  assert.equal(store.updateAwayPeriod({
    ...created,
    until: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-15T00:01:00.000Z",
  }).until, "2026-07-20T10:00:00.000Z");
  assert.equal(store.awayPeriod("holiday").until, "2026-07-20T10:00:00.000Z");
  assert.equal(store.deleteAwayPeriod("holiday"), true);
  assert.equal(store.awayPeriod("holiday"), null);
  store.close();
} finally {
  await rm(awayPeriodDir, { recursive: true, force: true });
}

const solarForecastDir = await mkdtemp(path.join(os.tmpdir(), "history-store-solar-forecast-"));
try {
  const store = createHistoryStore({ dataDir: solarForecastDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  const dayRange = (targetDate) => {
    const start = new Date(`${targetDate}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  };
  const issue = ({ targetDate, issuedAt, raw = 2, predicted = 2.2, planning = 1.98 }) => {
    const range = dayRange(targetDate);
    return {
      targetDate,
      issuedAt,
      periodStart: range.start.toISOString(),
      periodEnd: range.end.toISOString(),
      rawPredictedKwh: raw,
      biasFactor: predicted / raw,
      predictedKwh: predicted,
      planningKwh: planning,
      marginPercent: 10,
      calibration: { learned: true, validDays: 10, factor: 2 },
    };
  };
  store.recordSolarForecastIssues([
    issue({ targetDate: "2026-07-01", issuedAt: "2026-06-30T06:00:00.000Z", predicted: 2 }),
    issue({ targetDate: "2026-07-01", issuedAt: "2026-06-30T12:00:00.000Z" }),
    issue({ targetDate: "2026-07-01", issuedAt: "2026-06-30T18:00:00.000Z", predicted: 2.4 }),
  ]);
  const firstDayStart = dayRange("2026-07-01").start.getTime();
  for (let hour = 0; hour < 24; hour += 1) {
    store.appendSample(sample(new Date(firstDayStart + hour * 3_600_000).toISOString(), {
      solarGenerationKwh: 0.1,
    }));
  }
  assert.equal(store.settleSolarForecastOutcomes(dayRange("2026-07-02").start), 3);
  let outcomes = store.solarForecastOutcomes();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].issuedAt, "2026-06-30T12:00:00.000Z", "latest pre-day forecast is canonical");
  assert.ok(Math.abs(outcomes[0].actualKwh - 2.4) < 0.000001);
  assert.ok(Math.abs(outcomes[0].errorKwh - 0.2) < 0.000001);
  assert.equal(store.solarForecastAccuracy().learned, false, "one outcome does not change future forecasts");

  for (let day = 2; day <= 6; day += 1) {
    const targetDate = `2026-07-${String(day).padStart(2, "0")}`;
    const startMs = dayRange(targetDate).start.getTime();
    store.recordSolarForecastIssues([issue({
      targetDate,
      issuedAt: new Date(startMs - 6 * 3_600_000).toISOString(),
      predicted: 2,
      planning: 1.8,
    })]);
    for (let hour = 0; hour < 24; hour += 1) {
      store.appendSample(sample(new Date(startMs + hour * 3_600_000).toISOString(), {
        solarGenerationKwh: 0.1,
      }));
    }
  }
  store.settleSolarForecastOutcomes(dayRange("2026-07-07").start);
  const accuracy = store.solarForecastAccuracy();
  assert.equal(accuracy.learned, true);
  assert.equal(accuracy.sampleCount, 6);
  assert.ok(
    Math.abs(accuracy.factor - 1.2) < 0.000001,
    `expected a 1.2 forecast correction, received ${JSON.stringify(accuracy)}`,
  );

  store.recordSolarForecastIssues([issue({
    targetDate: "2026-07-08",
    issuedAt: new Date(dayRange("2026-07-08").start.getTime() - 6 * 3_600_000).toISOString(),
  })]);
  const incompleteStart = dayRange("2026-07-08").start.getTime();
  for (let hour = 0; hour < 2; hour += 1) {
    store.appendSample(sample(new Date(incompleteStart + hour * 3_600_000).toISOString(), {
      solarGenerationKwh: 0.1,
    }));
  }
  assert.equal(store.settleSolarForecastOutcomes(dayRange("2026-07-09").start), 0);
  outcomes = store.solarForecastOutcomes();
  assert.equal(outcomes.some((outcome) => outcome.targetDate === "2026-07-08"), false);
  assert.ok((await store.stats()).solarForecastIssues > 0);
  await store.applyRetention({ adaptiveChargingHistoryDays: 1 }, dayRange("2026-07-12").start);
  assert.equal((await store.stats()).solarForecastIssues, 0);
  store.close();
} finally {
  await rm(solarForecastDir, { recursive: true, force: true });
}

console.log("history store tests passed");
