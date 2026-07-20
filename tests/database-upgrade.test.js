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
import { backupDatabaseBeforeUpgrade, databaseBackupFilename } from "../lib/database-upgrade.js";

assert.match(databaseBackupFilename(3, 4, new Date("2026-07-19T12:34:56.000Z")),
  /^history-v3-before-v4-20260719T123456Z\.sqlite\.zst$/);

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
  assert.deepEqual(progress, [
    { fromVersion: 3, toVersion: 4 },
    { fromVersion: 4, toVersion: 5 },
  ]);
  const upgraded = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal(upgraded.prepare("PRAGMA quick_check").get().quick_check, "ok");
  for (const table of ["gas_tariff_snapshots", "gas_tariff_overrides", "fuel_cell_forecasts"]) {
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  assert.equal(
    JSON.parse(upgraded.prepare("SELECT value FROM metadata WHERE key = 'energyCalculationVersion'").get().value),
    2,
  );
  upgraded.close();

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
