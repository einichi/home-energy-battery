import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION } from "../lib/history-store.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "device-adapter-integration-"));
let child = null;
let output = "";

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for simulated device server\n${output}`);
}

async function request(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;

function startTestServer() {
  const processHandle = spawn(process.execPath, [path.resolve("server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      TZ: "Asia/Tokyo",
      NODE_ENV: "test",
      DEVICE_COMMAND_ADAPTER_MODULE: path.resolve("tests/support/device-simulator.js"),
      DEVICE_SIMULATOR_SCENARIO: "normal",
      SCHEDULE_CHECK_INTERVAL_MS: "50",
      AUTOMATION_CHECK_INTERVAL_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle.stdout.on("data", (chunk) => { output += chunk; });
  processHandle.stderr.on("data", (chunk) => { output += chunk; });
  return processHandle;
}

try {
  child = startTestServer();

  await waitFor(async () => (await fetch(`${baseUrl}/api/config`)).ok);
  const indexResponse = await fetch(`${baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(indexResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");

  const invalidContentType = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(invalidContentType.status, 415);

  const crossOriginMutation = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: "{}",
  });
  assert.equal(crossOriginMutation.status, 403);

  const oversizedMutation = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
  });
  assert.equal(oversizedMutation.status, 413);

  const configured = await request(baseUrl, "/api/config", {
    method: "PUT",
    body: {
      batteryHost: "10.250.0.10",
      solarEnabled: true,
      solarHost: "10.250.0.10",
      smartCosmoEnabled: true,
      meterHost: "10.250.0.20",
      fuelCellEnabled: true,
      fuelCellPrimaryHost: "10.250.0.30",
      fuelCellProxyHosts: ["10.250.0.20"],
      adaptiveCharging: { enabled: false },
      updateIntervalSeconds: 3600,
    },
  });
  assert.equal(configured.response.status, 200, `configuration failed: ${JSON.stringify(configured.payload)}\n${output}`);

  const initial = await request(baseUrl, "/api/status");
  assert.equal(initial.response.status, 200, `initial status failed: ${JSON.stringify(initial.payload)}\n${output}`);
  assert.deepEqual(Object.keys(initial.payload.savingsPeriods), ["today", "lastMonth", "month", "year"]);
  assert.equal(typeof initial.payload.savingsPeriods.year.solarSavingYen, "number");
  assert.equal(typeof initial.payload.savingsPeriods.year.totalOffPeakSavingYen, "number");
  assert.equal(
    initial.payload.savingsPeriods.today.totalOffPeakSavingYen,
    initial.payload.savingsPeriods.today.batteryOffPeakSavingYen
      + initial.payload.savingsPeriods.today.gridOffPeakSavingYen,
  );
  assert.equal(initial.payload.energy.battery.remaining_percent.value, 62);
  assert.equal(initial.payload.energy.solar.instant_power.value, 850);
  assert.equal(initial.payload.meter.house_demand_power.value, 1410);
  assert.equal(initial.payload.meter.channel_power.decoded.channels.length, 3);
  assert.equal(initial.payload.energy.fuel_cells[0].source_role, "primary");
  assert.equal(initial.payload.energy.fuel_cells[0].cumulative_generation.value, 4321.234);
  assert.equal(initial.payload.energy.fuel_cells[0].hot_water_level.value, 4);
  assert.equal(initial.payload.energy.fuel_cells[1].source_role, "proxy");

  assert.equal((await request(baseUrl, "/api/fuel-cell-automation")).response.status, 404);
  assert.equal((await request(baseUrl, "/api/actions/fuel-cell-start", {
    method: "POST",
    body: {},
  })).response.status, 404);

  const charge = await request(baseUrl, "/api/actions/charge", {
    method: "POST",
    body: { targetWh: 500 },
  });
  assert.equal(charge.response.status, 200);
  const charging = await request(baseUrl, "/api/status");
  assert.equal(charging.payload.energy.battery.operation_mode.value, "charging");
  assert.equal(charging.payload.energy.battery.instant_power.value, 2192);
  assert.equal(charging.payload.meter.grid_import_power.value, 3112);

  const standby = await request(baseUrl, "/api/actions/set-mode", {
    method: "POST",
    body: { mode: "standby" },
  });
  assert.equal(standby.response.status, 200);
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.operation_mode.value, "standby");

  const limit = await request(baseUrl, "/api/settings/discharge-limit", {
    method: "POST",
    body: { percent: 30 },
  });
  assert.equal(limit.response.status, 200);
  assert.equal((await request(baseUrl, "/api/status")).payload.settings.discharge_limit.decoded.percent, 30);

  const schedule = await request(baseUrl, "/api/schedules", {
    method: "POST",
    body: {
      name: "Simulated Auto restore",
      action: "set-mode",
      payload: { mode: "auto" },
      repeat: "once",
      runAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(schedule.response.status, 201);
  await waitFor(async () => {
    const schedules = await request(baseUrl, "/api/schedules");
    return schedules.payload.find((item) => item.id === schedule.payload.id)?.lastResult?.ok === true;
  });
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.operation_mode.value, "auto");

  const inactiveBackupPreparation = await request(baseUrl, "/api/backup-preparation");
  assert.equal(inactiveBackupPreparation.response.status, 200);
  assert.equal(inactiveBackupPreparation.payload.active, false);

  const startedBackupPreparation = await request(baseUrl, "/api/backup-preparation/start", {
    method: "POST",
    body: { allowDemandGuard: true },
  });
  assert.equal(startedBackupPreparation.response.status, 200, JSON.stringify(startedBackupPreparation.payload));
  assert.equal(startedBackupPreparation.payload.active, true);
  assert.equal(startedBackupPreparation.payload.phase, "active");
  assert.equal(startedBackupPreparation.payload.previousProfile, "eco");
  assert.equal(startedBackupPreparation.payload.currentProfile, "backup");
  assert.equal(startedBackupPreparation.payload.allowDemandGuard, true);
  const protectedStatus = await request(baseUrl, "/api/status");
  assert.equal(protectedStatus.payload.energy.battery.vendor_profile.value, "backup");
  assert.equal(protectedStatus.payload.energy.battery.operation_mode.value, "auto");

  const blockedManualAction = await request(baseUrl, "/api/actions/vendor-profile", {
    method: "POST",
    body: { mode: "eco" },
  });
  assert.equal(blockedManualAction.response.status, 409);
  assert.match(blockedManualAction.payload.error, /Backup Preparation is active/);
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.vendor_profile.value, "backup");

  const blockedSchedule = await request(baseUrl, "/api/schedules", {
    method: "POST",
    body: {
      name: "Must not escape Backup Preparation",
      action: "vendor-profile",
      payload: { mode: "osaifu" },
      repeat: "once",
      runAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(blockedSchedule.response.status, 201);
  const skippedSchedule = await waitFor(async () => {
    const schedules = await request(baseUrl, "/api/schedules");
    const item = schedules.payload.find((candidate) => candidate.id === blockedSchedule.payload.id);
    return item?.lastResult?.skipped ? item : null;
  });
  assert.equal(skippedSchedule.lastResult.skipped, "Backup Preparation owns battery control");
  assert.equal(skippedSchedule.enabled, false);
  assert.equal(skippedSchedule.completed, true);
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.vendor_profile.value, "backup");

  const persistedOverride = JSON.parse(await readFile(path.join(dataDir, "operational-overrides.json"), "utf8"));
  assert.equal(persistedOverride.backupPreparation.active, true);
  assert.equal(persistedOverride.backupPreparation.previousProfile, "eco");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  child = startTestServer();
  await waitFor(async () => (await fetch(`${baseUrl}/api/config`)).ok);
  const restartedOverride = await request(baseUrl, "/api/backup-preparation");
  assert.equal(restartedOverride.payload.active, true);
  assert.equal(restartedOverride.payload.phase, "active");
  assert.equal(restartedOverride.payload.currentProfile, "backup");
  assert.equal(restartedOverride.payload.lastResult.recoveredAtStartup, true);
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.vendor_profile.value, "backup");

  const endedBackupPreparation = await request(baseUrl, "/api/backup-preparation/end", {
    method: "POST",
    body: {},
  });
  assert.equal(endedBackupPreparation.response.status, 200, JSON.stringify(endedBackupPreparation.payload));
  assert.equal(endedBackupPreparation.payload.active, false);
  assert.equal(endedBackupPreparation.payload.currentProfile, "eco");
  const restoredStatus = await request(baseUrl, "/api/status");
  assert.equal(restoredStatus.payload.energy.battery.vendor_profile.value, "eco");
  assert.equal(restoredStatus.payload.energy.battery.operation_mode.value, "auto");

  assert.equal((await request(baseUrl, "/api/actions/charge", {
    method: "POST",
    body: { targetWh: 500 },
  })).response.status, 200);
  const guard = await request(baseUrl, "/api/automation-rules", {
    method: "POST",
    body: {
      name: "Backup Preparation guard test",
      type: "backup-demand-guard",
      enabled: true,
      conditions: {
        source: "gridImportW",
        breakerAmps: 30,
        breakerVoltage: 100,
        reserveAmps: 0,
        restoreBelowAmps: 1,
        restoreDelaySeconds: 0,
      },
      cooldownSeconds: 0,
    },
  });
  assert.equal(guard.response.status, 201);
  await waitFor(async () => {
    const rules = await request(baseUrl, "/api/automation-rules");
    return rules.payload.find((item) => item.id === guard.payload.id)?.state?.awaitingRestore === true;
  });
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.operation_mode.value, "standby");
  const guardedBackupPreparation = await request(baseUrl, "/api/backup-preparation/start", {
    method: "POST",
    body: { allowDemandGuard: true },
  });
  assert.equal(guardedBackupPreparation.response.status, 200);
  const guardedStatus = await request(baseUrl, "/api/status");
  assert.equal(guardedStatus.payload.energy.battery.vendor_profile.value, "backup");
  assert.equal(guardedStatus.payload.energy.battery.operation_mode.value, "standby");
  assert.equal((await request(baseUrl, `/api/automation-rules/${guard.payload.id}`, {
    method: "DELETE",
    body: {},
  })).response.status, 200);
  assert.equal((await request(baseUrl, "/api/backup-preparation/end", {
    method: "POST",
    body: {},
  })).response.status, 200);
  assert.equal((await request(baseUrl, "/api/status")).payload.energy.battery.operation_mode.value, "auto");

  const isolatedBackupPreparation = await request(baseUrl, "/api/backup-preparation/start", {
    method: "POST",
    body: { allowDemandGuard: false },
  });
  assert.equal(isolatedBackupPreparation.response.status, 200);
  assert.equal(isolatedBackupPreparation.payload.allowDemandGuard, false);
  assert.equal((await request(baseUrl, "/api/backup-preparation")).payload.allowDemandGuard, false);
  assert.equal((await request(baseUrl, "/api/backup-preparation/end", {
    method: "POST",
    body: {},
  })).response.status, 200);

  const manualBackup = await request(baseUrl, "/api/database-backups", {
    method: "POST",
    body: {},
  });
  assert.equal(manualBackup.response.status, 201, JSON.stringify(manualBackup.payload));
  const compatible = manualBackup.payload.backups.find((item) => item.kind === "manual");
  assert.equal(compatible.compatible, true);

  const incompatibleFilename = compatible.filename.replace(/^history-v\d+-/, "history-v4-");
  await copyFile(
    path.join(dataDir, "backups", compatible.filename),
    path.join(dataDir, "backups", incompatibleFilename),
  );
  const backupInventory = await request(baseUrl, "/api/database-backups");
  assert.equal(backupInventory.payload.schemaVersion, SCHEMA_VERSION);
  const incompatible = backupInventory.payload.backups.find((item) => item.filename === incompatibleFilename);
  assert.equal(incompatible.compatible, false);
  assert.equal(incompatible.schemaVersion, 4);
  const incompatibleRestore = await request(
    baseUrl,
    `/api/database-backups/${encodeURIComponent(incompatibleFilename)}/restore`,
    { method: "POST", body: {} },
  );
  assert.equal(incompatibleRestore.response.status, 409);

  const restored = await request(
    baseUrl,
    `/api/database-backups/${encodeURIComponent(compatible.filename)}/restore`,
    { method: "POST", body: {} },
  );
  assert.equal(restored.response.status, 200, `${JSON.stringify(restored.payload)}\n${output}`);
  assert.ok(restored.payload.backups.some((item) => item.kind === "pre-restore"));
  assert.equal((await request(baseUrl, "/api/status")).response.status, 200);

  const deleted = await request(
    baseUrl,
    `/api/database-backups/${encodeURIComponent(incompatibleFilename)}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.backups.some((item) => item.filename === incompatibleFilename), false);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
}

console.log("device adapter integration tests passed");
