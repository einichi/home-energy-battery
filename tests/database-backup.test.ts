import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARCHITECTURE_VERSION, createApplicationStore } from "../lib/application-store.js";
import {
  backupDatabaseManually,
  cleanupExtractedDatabaseBackup,
  deleteDatabaseBackup,
  extractAndValidateDatabaseBackup,
  listDatabaseBackups,
} from "../lib/database-backup.js";
import { SCHEMA_VERSION, createHistoryStore } from "../lib/history-store.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "database-backup-"));
try {
  const historyStore = createHistoryStore({ dataDir });
  await historyStore.initialize();
  historyStore.appendSample({ timestamp: "2026-09-22T00:00:00.000Z", houseDemandW: 1234 });
  historyStore.close();

  const applicationStore = createApplicationStore({ dataDir });
  await applicationStore.initialize();
  applicationStore.writeDocument("config", { language: "ja", batteryHost: "192.0.2.10" });
  applicationStore.close();

  const backupDir = path.join(dataDir, "backups");
  const progress: any[] = [];
  const backup = await backupDatabaseManually({
    databaseFile: path.join(dataDir, "history.sqlite"),
    backupDir,
    sourceVersion: SCHEMA_VERSION,
    onProgress: (value: any) => progress.push(value),
  });
  assert.equal(backup.kind, "manual");
  assert.ok(backup.compressedBytes > 0);
  assert.ok(progress.some((value: any) => value.phase === "validating"));

  const inventory = await listDatabaseBackups({ backupDir, currentVersion: SCHEMA_VERSION });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].compatible, true);
  assert.equal(inventory[0].kind, "manual");

  const extracted = await extractAndValidateDatabaseBackup({
    backupFile: backup.path,
    workingDir: dataDir,
  });
  assert.equal(extracted.schemaVersion, SCHEMA_VERSION);
  const restored = new DatabaseSync(extracted.snapshotFile, { readOnly: true });
  try {
    assert.equal(
      JSON.parse(String(restored.prepare("SELECT value FROM metadata WHERE key = 'architectureVersion'").get()!.value)),
      ARCHITECTURE_VERSION,
    );
    assert.deepEqual(
      JSON.parse(String(restored.prepare("SELECT payload_json FROM application_documents WHERE key = 'config'").get()!.payload_json)),
      { language: "ja", batteryHost: "192.0.2.10" },
    );
  } finally {
    restored.close();
  }
  await cleanupExtractedDatabaseBackup(extracted.snapshotFile);
  await assert.rejects(stat(extracted.snapshotFile), { code: "ENOENT" });

  await deleteDatabaseBackup({ backupDir, filename: backup.filename });
  assert.equal((await listDatabaseBackups({ backupDir, currentVersion: SCHEMA_VERSION })).length, 0);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("database backup tests passed");
