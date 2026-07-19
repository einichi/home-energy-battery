import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHistoryStore } from "../lib/history-store.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "database-gate-server-"));
const databaseFile = path.join(dataDir, "history.sqlite");
const port = 20_000 + (process.pid % 20_000);
let child = null;
let output = "";

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for database upgrade server\n${output}`);
}

try {
  const store = createHistoryStore({ dataDir, logger: { log() {}, warn() {} } });
  await store.initialize();
  store.appendSample({ timestamp: "2026-07-19T00:00:00.000Z", houseDemandW: 500 });
  store.close();
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    DROP TABLE fuel_cell_forecasts;
    DROP TABLE gas_tariff_overrides;
    DROP TABLE gas_tariff_snapshots;
  `);
  database.prepare("UPDATE metadata SET value = ? WHERE key = 'schemaVersion'").run(JSON.stringify(3));
  database.close();

  child = spawn(process.execPath, [path.resolve("server.js")], {
    cwd: path.resolve("."),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), TZ: "Asia/Tokyo" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/database-upgrade/status`);
    return response.ok ? response.json() : null;
  });

  const status = await (await fetch(`http://127.0.0.1:${port}/api/database-upgrade/status`)).json();
  assert.equal(status.state, "awaiting-decision");
  assert.equal(status.sourceVersion, 3);
  assert.equal(status.applicationReady, false);

  const ordinaryApi = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(ordinaryApi.status, 503);
  const ordinaryPage = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(ordinaryPage.status, 302);
  assert.equal(ordinaryPage.headers.get("location"), "/database-upgrade");
  await assert.rejects(access(path.join(dataDir, "config.json")));

  const decision = await fetch(`http://127.0.0.1:${port}/api/database-upgrade/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backup: false }),
  });
  assert.equal(decision.status, 202);

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    return response.ok;
  });
  const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(configResponse.status, 200);
  const completedStatus = await (await fetch(`http://127.0.0.1:${port}/api/database-upgrade/status`)).json();
  assert.equal(completedStatus.state, "complete");
  assert.equal(completedStatus.applicationReady, true);
  assert.match(output, /decision=skip/);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
}

console.log("database upgrade server tests passed");
