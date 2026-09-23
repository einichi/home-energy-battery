import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ARCHITECTURE_VERSION,
  architectureVersionForDatabase,
  createApplicationStore,
} from "../lib/application-store.js";

function createCurrentDatabase(databaseFile: any, architectureVersion: any = ARCHITECTURE_VERSION): any {
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata(key, value) VALUES ('schemaVersion', '7');
    INSERT INTO metadata(key, value) VALUES ('architectureVersion', '${architectureVersion}');
    CREATE TABLE application_documents (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.close();
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "application-store-"));
try {
  const databaseFile = path.join(dataDir, "history.sqlite");
  createCurrentDatabase(databaseFile);
  const store = createApplicationStore({ dataDir });
  assert.deepEqual(await store.initialize(), { architectureVersion: 1, state: "current" });
  store.writeDocument("config", { batteryHost: "192.0.2.99", language: "en" });
  store.writeDocument("schedules", [{ id: "night-charge" }]);
  assert.deepEqual(store.readDocument("config"), { batteryHost: "192.0.2.99", language: "en" });
  assert.deepEqual(store.readDocument("schedules"), [{ id: "night-charge" }]);
  assert.equal(store.validateCurrent(), true);
  store.close();
  assert.equal(architectureVersionForDatabase(databaseFile), ARCHITECTURE_VERSION);

  const incompatibleDir = await mkdtemp(path.join(os.tmpdir(), "application-store-incompatible-"));
  try {
    createCurrentDatabase(path.join(incompatibleDir, "history.sqlite"), 0);
    const incompatible = createApplicationStore({ dataDir: incompatibleDir });
    await assert.rejects(incompatible.initialize(), /Run the bridge release first/);
    assert.equal(incompatible.isReady(), false);
  } finally {
    await rm(incompatibleDir, { recursive: true, force: true });
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("application store tests passed");
