import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initHistorySchema, rowToSample, summarizeSamples, writeSampleRow } from "../server.js";

function makeSample(overrides = {}) {
  return {
    timestamp: "2026-05-31T00:00:00.000Z",
    batteryPowerW: 500,
    stateOfChargePercent: 60,
    solarPowerW: 1200,
    houseDemandW: 1800,
    fuelCellPowerW: 300,
    gridExportW: 100,
    gridImportW: 200,
    solarGenerationKwh: 0.6,
    gridImportKwh: 0.1,
    gridExportKwh: 0.05,
    offPeakSavingYen: 0,
    solarSavingYen: 24,
    rateYenPerKwh: 40,
    rateLabel: "Day",
    ...overrides,
  };
}

test("history round-trips samples through SQLite and filters by range", () => {
  const db = new DatabaseSync(":memory:");
  initHistorySchema(db);

  const first = makeSample();
  const second = makeSample({
    timestamp: "2026-05-31T00:00:15.000Z",
    batteryPowerW: null,
    rateLabel: null,
  });
  const outOfRange = makeSample({ timestamp: "2026-06-01T00:00:00.000Z" });
  for (const sample of [first, second, outOfRange]) writeSampleRow(db, sample);

  const rows = db
    .prepare("SELECT * FROM samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC")
    .all(Date.parse(first.timestamp), Date.parse(second.timestamp));
  const samples = rows.map(rowToSample);

  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0], first);
  assert.equal(samples[1].batteryPowerW, null);
  assert.equal(samples[1].rateLabel, null);
});

test("summarizeSamples aggregates rows read back from SQLite", () => {
  const db = new DatabaseSync(":memory:");
  initHistorySchema(db);
  writeSampleRow(db, makeSample({ solarGenerationKwh: 0.25, solarSavingYen: 1, offPeakSavingYen: 2 }));
  writeSampleRow(
    db,
    makeSample({
      timestamp: "2026-05-31T00:00:15.000Z",
      solarGenerationKwh: 0.75,
      solarSavingYen: 3,
      offPeakSavingYen: 4,
    }),
  );
  const samples = db.prepare("SELECT * FROM samples ORDER BY ts ASC").all().map(rowToSample);
  const summary = summarizeSamples(samples, { co2TonnesPerKwh: 0.000423 });
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.solarGenerationKwh, 1);
  assert.equal(summary.solarSavingYen, 4);
  assert.equal(summary.offPeakSavingYen, 6);
  assert.equal(summary.co2SavingKg, 0.423);
});
