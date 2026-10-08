import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHistorySchema, inspectHistoryDatabase, isSchemaMigratableFrom } from "../lib/persistence/history-database.js";
import { createHistoryStore } from "../lib/history-store.js";

const readValue = (database: DatabaseSync, sql: string, column: string): unknown => {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? row[column] : undefined;
};
const parse = (value: unknown): Record<string, any> => JSON.parse(String(value));

// migratable predicate
assert.equal(isSchemaMigratableFrom(7, 9), true);
assert.equal(isSchemaMigratableFrom(8, 9), true);
assert.equal(isSchemaMigratableFrom(9, 9), false);
assert.equal(isSchemaMigratableFrom(6, 9), false);
assert.equal(isSchemaMigratableFrom(7, 8), true);

// --- v8 -> v9 -----------------------------------------------------------------
const dir = await mkdtemp(path.join(os.tmpdir(), "heb-migration-"));
const file = path.join(dir, "history.sqlite");
try {
  const seed = new DatabaseSync(file);
  createHistorySchema(seed, { schemaVersion: 8, energyCalculationVersion: 4, architectureVersion: 1 });
  const now = Date.now();
  const insertDocument = (key: string, payload: unknown) => seed
    .prepare("INSERT INTO application_documents(key, payload_json, updated_at) VALUES (?,?,?)")
    .run(key, JSON.stringify(payload), new Date().toISOString());
  seed.prepare("INSERT INTO samples(timestamp_ms, timestamp, payload_json) VALUES (?,?,?)")
    .run(now, new Date(now).toISOString(), JSON.stringify({ houseDemandW: 1234, solarPowerW: 10 }));
  seed.prepare("INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json) VALUES (?,?,?,?,?)")
    .run("daily", 0, 1,
      JSON.stringify({
        houseDemandKwh: 1,
        houseDemandW: 900,
        peakHouseDemandW: 1500,
        powerCoverageSeconds: { houseDemandW: 1800 },
        intervalAveragePowerW: { houseDemandW: 900 },
        coverageSeconds: { houseDemandKwh: 1800 },
        energyQuality: { houseDemandKwh: "counter" },
      }),
      JSON.stringify({
        powers: { houseDemandW: { weight: 1 } },
        peakHouseDemandW: 1500,
        energy: { houseDemandKwh: { count: 1 } },
        coverageSeconds: { houseDemandKwh: 1 },
        energyQualities: { houseDemandKwh: { counter: 1 } },
      }));
  insertDocument("automationRules", [{ conditions: { source: "houseDemandW" } }]);
  insertDocument("config", { dashboardWidgets: [{ id: "houseDemandPower", visible: true }] });
  insertDocument("adaptiveChargingState", { chargingPerformance: { samples: [{ houseDemandW: 800 }] } });
  seed.close();

  const inspection = await inspectHistoryDatabase(dir, 9);
  assert.equal(inspection.state, "migratable");
  assert.equal(inspection.version, 8);

  const store = createHistoryStore({ dataDir: dir });
  await store.initialize();
  store.close();

  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(parse(readValue(database, "SELECT value FROM metadata WHERE key = 'schemaVersion'", "value"))), 9);

    const sample = parse(readValue(database, "SELECT payload_json FROM samples LIMIT 1", "payload_json"));
    assert.equal(sample.branchDemandW, 1234);
    assert.equal(sample.houseDemandW, undefined);
    assert.equal(sample.solarPowerW, 10);

    const rollup = parse(readValue(database, "SELECT payload_json FROM rollups LIMIT 1", "payload_json"));
    assert.equal(rollup.branchDemandKwh, 1);
    assert.equal(rollup.branchDemandW, 900);
    assert.equal(rollup.peakBranchDemandW, 1500);
    assert.equal(rollup.powerCoverageSeconds.branchDemandW, 1800);
    assert.equal(rollup.coverageSeconds.branchDemandKwh, 1800);
    assert.equal(rollup.energyQuality.branchDemandKwh, "counter");
    assert.equal(rollup.houseDemandW, undefined);
    assert.equal(rollup.houseDemandKwh, undefined);

    const state = parse(readValue(database, "SELECT state_json FROM rollups LIMIT 1", "state_json"));
    assert.ok(state.powers.branchDemandW);
    assert.equal(state.peakBranchDemandW, 1500);
    assert.ok(state.energy.branchDemandKwh);
    assert.ok(state.coverageSeconds.branchDemandKwh);
    assert.ok(state.energyQualities.branchDemandKwh);
    assert.equal(state.powers.houseDemandW, undefined);

    const rules = parse(readValue(database, "SELECT payload_json FROM application_documents WHERE key = 'automationRules'", "payload_json"));
    assert.equal(rules[0].conditions.source, "branchDemandW");
    const config = parse(readValue(database, "SELECT payload_json FROM application_documents WHERE key = 'config'", "payload_json"));
    assert.equal(config.dashboardWidgets[0].id, "branchDemandPower");
    const adaptive = parse(readValue(database, "SELECT payload_json FROM application_documents WHERE key = 'adaptiveChargingState'", "payload_json"));
    assert.equal(adaptive.chargingPerformance.samples[0].branchDemandW, 800);

    // A pre-upgrade backup was created and labeled with the source version.
    const backups = await readdir(path.join(dir, "backups"));
    assert.ok(backups.some((name) => /^history-v8-before-upgrade-/.test(name)), backups.join(", "));

    // Idempotent: re-initializing a current v9 database is a no-op.
    const again = createHistoryStore({ dataDir: dir });
    await again.initialize();
    again.close();
  } finally {
    database.close();
  }

  // --- v7 -> v9 chain ---------------------------------------------------------
  const chainDir = await mkdtemp(path.join(os.tmpdir(), "heb-migration-chain-"));
  try {
    const chainFile = path.join(chainDir, "history.sqlite");
    const chainSeed = new DatabaseSync(chainFile);
    createHistorySchema(chainSeed, { schemaVersion: 7, energyCalculationVersion: 4, architectureVersion: 1 });
    chainSeed.prepare("INSERT INTO samples(timestamp_ms, timestamp, payload_json) VALUES (?,?,?)")
      .run(1, new Date(1).toISOString(), JSON.stringify({ houseDemandW: 555 }));
    chainSeed.close();
    const chainStore = createHistoryStore({ dataDir: chainDir });
    await chainStore.initialize();
    chainStore.close();
    const chainDb = new DatabaseSync(chainFile, { readOnly: true });
    try {
      assert.equal(Number(parse(readValue(chainDb, "SELECT value FROM metadata WHERE key = 'schemaVersion'", "value"))), 9);
      assert.ok(readValue(chainDb, "SELECT value FROM metadata WHERE key = 'compaction:schema-v7'", "value") !== undefined);
      const chainSample = parse(readValue(chainDb, "SELECT payload_json FROM samples LIMIT 1", "payload_json"));
      assert.equal(chainSample.branchDemandW, 555);
    } finally {
      chainDb.close();
    }
  } finally {
    await rm(chainDir, { recursive: true, force: true });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("history migration tests passed");
