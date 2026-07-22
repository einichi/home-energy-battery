import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import {
  SCHEMA_VERSION,
  createHistoryStore,
  inspectHistoryDatabase,
  migrateHistoryDatabase,
} from "../lib/history-store.js";
import {
  backupDatabaseBeforeUpgrade,
  backupDatabaseManually,
  cleanupExtractedDatabaseBackup,
  databaseBackupFilename,
  databaseBackupMetadata,
  deleteDatabaseBackup,
  extractAndValidateDatabaseBackup,
  listDatabaseBackups,
  manualDatabaseBackupFilename,
} from "../lib/database-upgrade.js";

assert.match(databaseBackupFilename(3, 4, new Date("2026-07-19T12:34:56.000Z")),
  /^history-v3-before-v4-20260719T123456Z\.sqlite\.zst$/);
assert.match(manualDatabaseBackupFilename(5, new Date("2026-07-20T01:02:03.000Z")),
  /^history-v5-manual-20260720T010203Z\.sqlite\.zst$/);
assert.deepEqual(
  databaseBackupMetadata("history-v4-before-v5-20260720T010203Z.sqlite.zst", 5),
  {
    filename: "history-v4-before-v5-20260720T010203Z.sqlite.zst",
    kind: "pre-upgrade",
    schemaVersion: 4,
    targetVersion: 5,
    createdAt: "2026-07-20T01:02:03.000Z",
    compatible: false,
  },
);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "database-upgrade-"));
const backupDir = path.join(dataDir, "backups");
const databaseFile = path.join(dataDir, "history.sqlite");

try {
  const store = createHistoryStore({ dataDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  store.appendSample({ timestamp: "2026-07-19T00:00:00.000Z", fuelCellPowerW: 650 });
  store.close();

  const old = new DatabaseSync(databaseFile);
  old.exec("PRAGMA journal_mode=WAL");
  old.exec(`
    DROP TABLE fuel_cell_forecasts;
    DROP TABLE gas_tariff_overrides;
    DROP TABLE gas_tariff_snapshots;
  `);
  old.prepare("UPDATE metadata SET value = ? WHERE key = 'schemaVersion'").run(JSON.stringify(3));
  old.prepare("INSERT INTO samples(timestamp_ms, timestamp, payload_json) VALUES (?, ?, ?)").run(
    Date.parse("2026-07-19T00:00:05.000Z"),
    "2026-07-19T00:00:05.000Z",
    JSON.stringify({ timestamp: "2026-07-19T00:00:05.000Z", fuelCellPowerW: 700 }),
  );
  old.close();

  const inspection = await inspectHistoryDatabase(dataDir);
  assert.equal(inspection.state, "upgrade");
  assert.equal(inspection.version, 3);
  assert.equal(inspection.targetVersion, SCHEMA_VERSION);

  const phases = [];
  const backup = await backupDatabaseBeforeUpgrade({
    databaseFile,
    backupDir,
    sourceVersion: 3,
    targetVersion: SCHEMA_VERSION,
    now: new Date("2026-07-19T12:34:56.000Z"),
    onProgress(value) { phases.push(value.phase); },
  });
  assert.ok((await stat(backup.path)).size > 0);
  assert.ok(phases.includes("copying"));
  assert.ok(phases.includes("validating"));
  assert.ok(phases.includes("compressing"));
  const secondBackup = await backupDatabaseBeforeUpgrade({
    databaseFile,
    backupDir,
    sourceVersion: 3,
    targetVersion: SCHEMA_VERSION,
    now: new Date("2026-07-19T12:34:56.000Z"),
  });
  assert.match(secondBackup.filename, /-2\.sqlite\.zst$/);
  assert.deepEqual((await readdir(backupDir)).filter((name) => name.includes(".snapshot.tmp") || name.endsWith(".partial")), []);

  const restored = path.join(dataDir, "restored.sqlite");
  await pipeline(createReadStream(backup.path), createZstdDecompress(), createWriteStream(restored));
  const restoredDb = new DatabaseSync(restored, { readOnly: true });
  assert.equal(restoredDb.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM samples").get().count, 2);
  assert.equal(JSON.parse(restoredDb.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get().value), 3);
  restoredDb.close();

  const progress = [];
  const migrated = await migrateHistoryDatabase(dataDir, { onProgress(value) { progress.push(value); } });
  assert.equal(migrated.state, "current");
  assert.deepEqual(
    [...new Set(progress.map((item) => `${item.fromVersion}->${item.toVersion}`))],
    ["3->4", "4->5", "5->6", "6->7"],
  );
  assert.ok(progress.some((item) => item.phase === "compacting" && item.percent === 100));
  const upgraded = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal(upgraded.prepare("PRAGMA quick_check").get().quick_check, "ok");
  for (const table of ["gas_tariff_snapshots", "gas_tariff_overrides", "fuel_cell_forecasts"]) {
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  assert.equal(
    JSON.parse(upgraded.prepare("SELECT value FROM metadata WHERE key = 'energyCalculationVersion'").get().value),
    4,
  );
  upgraded.close();

  const repairDir = await mkdtemp(path.join(os.tmpdir(), "database-counter-repair-"));
  try {
    const repairStore = createHistoryStore({ dataDir: repairDir, logger: { log() {}, warn() {} } });
    await repairStore.initialize();
    repairStore.appendSample({
      timestamp: "2026-07-22T10:09:27.000Z",
      gridExportW: 0,
      gridImportW: 700,
      meterCounterSourceHost: "10.0.0.135",
      gridImportCumulativeKwh: 674.1,
      gridExportCumulativeKwh: 11.04,
      circuitPowerW: { 1: 100 },
      circuitCumulativeKwh: { 1: 10 },
    });
    repairStore.appendSample({
      timestamp: "2026-07-22T10:09:34.000Z",
      gridExportW: 0,
      gridImportW: 700,
      meterCounterSourceHost: "10.0.0.135",
      gridImportCumulativeKwh: 674.1,
      gridExportCumulativeKwh: null,
      circuitPowerW: { 1: 100 },
      circuitCumulativeKwh: { 1: 0 },
    });
    repairStore.appendSample({
      timestamp: "2026-07-22T10:09:41.000Z",
      gridExportW: 0,
      gridImportW: 700,
      meterCounterSourceHost: "10.0.0.135",
      gridImportCumulativeKwh: 674.1,
      gridExportCumulativeKwh: 11.04,
      gridExportKwh: 11.04,
      circuitPowerW: { 1: 100 },
      circuitCumulativeKwh: { 1: 10 },
      circuitEnergyKwh: { 1: 10 },
    });
    repairStore.recordFuelCellForecasts([{
      start: "2026-07-23T11:00:00.000Z",
      end: "2026-07-23T11:30:00.000Z",
      medianW: 600,
    }], "2026-07-22T10:01:00.000Z");
    repairStore.recordFuelCellForecasts([{
      start: "2026-07-23T11:00:00.000Z",
      end: "2026-07-23T11:30:00.000Z",
      medianW: 650,
    }], "2026-07-22T10:02:00.000Z");
    repairStore.close();
    const preRepair = new DatabaseSync(path.join(repairDir, "history.sqlite"));
    const corruptRow = preRepair.prepare("SELECT id, payload_json FROM samples ORDER BY timestamp_ms DESC LIMIT 1").get();
    const corruptPayload = JSON.parse(corruptRow.payload_json);
    corruptPayload.gridExportKwh = 11.04;
    corruptPayload.circuitEnergyKwh = { 1: 10 };
    corruptPayload.coverageSeconds = { gridExportKwh: 7, "circuit:1": 7 };
    corruptPayload.energyQuality = { gridExportKwh: "counter", "circuit:1": "counter" };
    corruptPayload.energyIntervalStart = {
      gridExportKwh: "2026-07-22T10:09:34.000Z",
      "circuit:1": "2026-07-22T10:09:34.000Z",
    };
    preRepair.prepare("UPDATE samples SET payload_json = ? WHERE id = ?").run(JSON.stringify(corruptPayload), corruptRow.id);
    const preMigrationPayloadBytes = Number(preRepair.prepare(
      "SELECT SUM(LENGTH(payload_json)) AS bytes FROM samples",
    ).get().bytes);
    preRepair.prepare("UPDATE metadata SET value = ? WHERE key = 'schemaVersion'").run(JSON.stringify(5));
    preRepair.prepare("UPDATE metadata SET value = ? WHERE key = 'energyCalculationVersion'").run(JSON.stringify(2));
    preRepair.close();

    await migrateHistoryDatabase(repairDir);
    const repaired = new DatabaseSync(path.join(repairDir, "history.sqlite"), { readOnly: true });
    const repairedSamples = repaired.prepare("SELECT payload_json FROM samples ORDER BY timestamp_ms").all()
      .map((row) => JSON.parse(row.payload_json));
    assert.equal(repairedSamples[2].gridExportKwh, undefined, "derived energy is not persisted in raw telemetry");
    assert.equal(repairedSamples[2].circuitEnergyKwh, undefined);
    assert.equal(repairedSamples[2].coverageSeconds, undefined);
    assert.equal(repairedSamples[2].calculationVersion, undefined);
    const postMigrationPayloadBytes = Number(repaired.prepare(
      "SELECT SUM(LENGTH(payload_json)) AS bytes FROM samples",
    ).get().bytes);
    assert.ok(postMigrationPayloadBytes < preMigrationPayloadBytes);
    assert.equal(repaired.prepare("SELECT COUNT(*) AS count FROM fuel_cell_forecasts").get().count, 1);
    assert.equal(
      JSON.parse(repaired.prepare("SELECT value FROM metadata WHERE key = 'energyCalculationVersion'").get().value),
      4,
    );
    const compaction = JSON.parse(repaired.prepare(
      "SELECT value FROM metadata WHERE key = 'compaction:schema-v7'",
    ).get().value);
    assert.equal(compaction.fuelCellForecastRowsRemoved, 1);
    const repairedRollup = JSON.parse(repaired.prepare(
      "SELECT payload_json FROM rollups WHERE resolution = 'interval' ORDER BY bucket_start_ms LIMIT 1",
    ).get().payload_json);
    assert.ok(repairedRollup.gridExportKwh < 0.001);
    assert.ok(repairedRollup.circuitEnergyKwh["1"] < 0.001);
    repaired.close();

    const repairedStore = createHistoryStore({ dataDir: repairDir, logger: { log() {}, warn() {} } });
    await repairedStore.initialize();
    const interpreted = repairedStore.querySamples(
      Date.parse("2026-07-22T10:09:27.000Z"),
      Date.parse("2026-07-22T10:09:41.000Z"),
      { resolution: "raw" },
    );
    assert.ok(interpreted[2].gridExportKwh < 0.001);
    assert.ok(interpreted[2].circuitEnergyKwh["1"] < 0.001);
    repairedStore.close();
  } finally {
    await rm(repairDir, { recursive: true, force: true });
  }

  const compactionDir = await mkdtemp(path.join(os.tmpdir(), "database-compaction-scale-"));
  try {
    const compactStore = createHistoryStore({ dataDir: compactionDir, logger: { log() {}, warn() {} } });
    await compactStore.initialize();
    compactStore.close();
    const compactFile = path.join(compactionDir, "history.sqlite");
    const bloated = new DatabaseSync(compactFile);
    bloated.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE; DELETE FROM rollups");
    const insert = bloated.prepare(`
      INSERT INTO samples(timestamp_ms, timestamp, payload_json) VALUES (?, ?, ?)
    `);
    const channels = Array.from({ length: 29 }, (_, index) => String(index + 1));
    for (let index = 0; index < 2000; index += 1) {
      const timestamp = new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 5000).toISOString();
      const previous = new Date(Date.parse(timestamp) - 5000).toISOString();
      const circuitPowerW = Object.fromEntries(channels.map((channel) => [channel, 100 + Number(channel)]));
      const circuitCumulativeKwh = Object.fromEntries(channels.map((channel) => [channel, 10 + Number(channel) + index / 100]));
      const metricKeys = [
        "gridImportKwh",
        "gridExportKwh",
        "houseDemandKwh",
        "fuelCellKwh",
        ...channels.map((channel) => `circuit:${channel}`),
      ];
      insert.run(Date.parse(timestamp), timestamp, JSON.stringify({
        timestamp,
        houseDemandW: 1000,
        gridImportW: 1000,
        gridExportW: 0,
        meterCounterSourceHost: "meter",
        gridImportCumulativeKwh: 100 + index / 100,
        gridExportCumulativeKwh: 10,
        circuitPowerW,
        circuitCumulativeKwh,
        circuitEnergyKwh: Object.fromEntries(channels.map((channel) => [channel, 0.01])),
        coverageSeconds: Object.fromEntries(metricKeys.map((key) => [key, 5])),
        powerCoverageSeconds: Object.fromEntries([
          ["houseDemandW", 5],
          ["gridImportW", 5],
          ...channels.map((channel) => [`circuit:${channel}`, 5]),
        ]),
        energyQuality: Object.fromEntries(metricKeys.map((key) => [key, "counter"])),
        energyIntervalStart: Object.fromEntries(metricKeys.map((key) => [key, previous])),
        intervalAveragePowerW: { houseDemandW: 1000, gridImportW: 1000, gridExportW: 0 },
        intervalAverageCircuitPowerW: circuitPowerW,
        calculationVersion: 3,
        expectedIntervalSeconds: 5,
      }));
    }
    bloated.prepare("UPDATE metadata SET value = ? WHERE key = 'schemaVersion'").run(JSON.stringify(6));
    bloated.prepare("UPDATE metadata SET value = ? WHERE key = 'energyCalculationVersion'").run(JSON.stringify(3));
    bloated.exec("COMMIT");
    bloated.close();
    const beforeBytes = (await stat(compactFile)).size;
    await migrateHistoryDatabase(compactionDir);
    const afterBytes = (await stat(compactFile)).size;
    assert.ok(afterBytes < beforeBytes * 0.6, `expected compaction below 60% of source size; ${beforeBytes} -> ${afterBytes}`);
    const compacted = createHistoryStore({ dataDir: compactionDir, logger: { log() {}, warn() {} } });
    await compacted.initialize();
    const compactedStats = await compacted.stats();
    assert.equal(compactedStats.sampleCount, 2000);
    assert.ok(compactedStats.averageSampleBytes < 2200);
    assert.ok(compactedStats.lastCompaction.sourceSamplePayloadBytes > compactedStats.lastCompaction.compactSamplePayloadBytes * 2);
    compacted.close();
  } finally {
    await rm(compactionDir, { recursive: true, force: true });
  }

  const manualBackup = await backupDatabaseManually({
    databaseFile,
    backupDir,
    sourceVersion: SCHEMA_VERSION,
    now: new Date("2026-07-20T01:02:03.000Z"),
  });
  const inventory = await listDatabaseBackups({ backupDir, currentVersion: SCHEMA_VERSION });
  const manualInventory = inventory.find((item) => item.filename === manualBackup.filename);
  assert.equal(manualInventory.kind, "manual");
  assert.equal(manualInventory.schemaVersion, SCHEMA_VERSION);
  assert.equal(manualInventory.compatible, true);
  assert.equal(inventory.find((item) => item.filename === backup.filename).compatible, false);

  const extractedManual = await extractAndValidateDatabaseBackup({
    backupFile: manualBackup.path,
    workingDir: dataDir,
  });
  assert.equal(extractedManual.schemaVersion, SCHEMA_VERSION);
  const extractedDb = new DatabaseSync(extractedManual.snapshotFile, { readOnly: true });
  assert.equal(extractedDb.prepare("PRAGMA quick_check").get().quick_check, "ok");
  extractedDb.close();
  await cleanupExtractedDatabaseBackup(extractedManual.snapshotFile);

  await deleteDatabaseBackup({ backupDir, filename: manualBackup.filename });
  assert.equal(
    (await listDatabaseBackups({ backupDir, currentVersion: SCHEMA_VERSION }))
      .some((item) => item.filename === manualBackup.filename),
    false,
  );
  await assert.rejects(
    deleteDatabaseBackup({ backupDir, filename: "../history.sqlite.zst" }),
    /Invalid database backup filename/,
  );

  const newerDir = await mkdtemp(path.join(os.tmpdir(), "database-newer-"));
  try {
    await mkdir(newerDir, { recursive: true });
    const newerDb = new DatabaseSync(path.join(newerDir, "history.sqlite"));
    newerDb.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    newerDb.prepare("INSERT INTO metadata(key, value) VALUES ('schemaVersion', ?)").run(JSON.stringify(SCHEMA_VERSION + 1));
    newerDb.close();
    assert.equal((await inspectHistoryDatabase(newerDir)).state, "newer");
  } finally {
    await rm(newerDir, { recursive: true, force: true });
  }

  const invalidDir = await mkdtemp(path.join(os.tmpdir(), "database-invalid-"));
  try {
    const invalidDb = new DatabaseSync(path.join(invalidDir, "history.sqlite"));
    invalidDb.exec("CREATE TABLE samples(id INTEGER PRIMARY KEY)");
    invalidDb.close();
    const invalid = await inspectHistoryDatabase(invalidDir);
    assert.equal(invalid.state, "invalid");
    assert.match(invalid.error, /metadata/i);
  } finally {
    await rm(invalidDir, { recursive: true, force: true });
  }

  const unsupportedOldDir = await mkdtemp(path.join(os.tmpdir(), "database-migration-gap-"));
  try {
    const unsupported = new DatabaseSync(path.join(unsupportedOldDir, "history.sqlite"));
    unsupported.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    unsupported.prepare("INSERT INTO metadata(key, value) VALUES ('schemaVersion', ?)").run(JSON.stringify(2));
    unsupported.close();
    await assert.rejects(migrateHistoryDatabase(unsupportedOldDir), /No database migration registered/);
    const unchanged = new DatabaseSync(path.join(unsupportedOldDir, "history.sqlite"), { readOnly: true });
    assert.equal(JSON.parse(unchanged.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get().value), 2);
    unchanged.close();
  } finally {
    await rm(unsupportedOldDir, { recursive: true, force: true });
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("database upgrade tests passed");
