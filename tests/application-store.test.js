import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ARCHITECTURE_VERSION,
  architectureVersionForDatabase,
  createApplicationStore,
} from "../lib/application-store.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "application-store-"));
try {
  const databaseFile = path.join(dataDir, "history.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata(key, value) VALUES ('schemaVersion', '7');
    CREATE TABLE samples (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, payload_json TEXT);
    INSERT INTO samples(timestamp, payload_json) VALUES ('2026-09-21T15:00:00.000Z', '{}');
    CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, payload_json TEXT);
    INSERT INTO events(timestamp, payload_json) VALUES ('2026-09-21T16:00:00.000Z', '{}');
  `);
  database.close();

  const sourceConfig = { batteryHost: "192.0.2.44", language: "ja" };
  const sourceSchedules = [{ id: "night-charge", enabled: true }];
  const notificationState = { deliveries: [{ at: "2026-09-22T00:00:00.000Z" }] };
  await writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(sourceConfig)}\n`);
  await writeFile(path.join(dataDir, "schedules.json"), `${JSON.stringify(sourceSchedules)}\n`);
  await writeFile(path.join(dataDir, "notification-state.json"), `${JSON.stringify(notificationState)}\n`);
  await writeFile(path.join(dataDir, "notification-secrets.json"), '{"channels":{"primary-email":{"password":"secret"}}}\n');

  const messages = [];
  const store = createApplicationStore({ dataDir, logger: { info: (message) => messages.push(message) } });
  const migration = await store.initializeBridge();
  assert.equal(migration.architectureVersion, ARCHITECTURE_VERSION);
  assert.equal(migration.state, "complete");
  assert.equal(migration.validation.state, "passed");
  assert.equal(migration.validation.database, "ok");
  assert.equal(migration.validation.itemCounts.schedules, 1);
  assert.equal(migration.validation.secretsBackedUp, true);
  assert.deepEqual(migration.validation.history, {
    count: 1,
    earliest: "2026-09-21T15:00:00.000Z",
    latest: "2026-09-21T15:00:00.000Z",
  });
  assert.deepEqual(store.readDocument("config"), sourceConfig);
  assert.deepEqual(store.readDocument("schedules"), sourceSchedules);
  assert.deepEqual(store.readDocument("notificationState"), notificationState);
  assert.equal(store.validateCurrent(), true);
  assert.match(messages[0], /migrated 3 application documents/);

  const backupEntries = await readdir(path.join(dataDir, "backups"));
  assert.equal(backupEntries.length, 1);
  const backupDirectory = path.join(dataDir, "backups", backupEntries[0]);
  const manifest = JSON.parse(await readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "architecture-bridge");
  assert.ok(manifest.files.some((file) => file.path === "history.sqlite"));
  assert.ok(manifest.files.some((file) => file.path === "notification-secrets.json"));

  store.writeDocument("config", { batteryHost: "192.0.2.99", language: "en" });
  store.close();
  await writeFile(path.join(dataDir, "config.json"), '{"batteryHost":"stale-file"}\n');

  const reopened = createApplicationStore({ dataDir, logger: { info() {} } });
  const reopenedMigration = await reopened.initializeBridge();
  assert.equal(reopenedMigration.migratedAt, migration.migratedAt);
  assert.deepEqual(reopened.readDocument("config"), { batteryHost: "192.0.2.99", language: "en" });
  assert.equal((await readdir(path.join(dataDir, "backups"))).length, 1);
  reopened.close();

  assert.equal(architectureVersionForDatabase(databaseFile), ARCHITECTURE_VERSION);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("application store bridge tests passed");
