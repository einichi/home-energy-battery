import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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

try {
  child = spawn(process.execPath, [path.resolve("server.js")], {
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

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
  assert.equal(initial.payload.energy.battery.remaining_percent.value, 62);
  assert.equal(initial.payload.energy.solar.instant_power.value, 850);
  assert.equal(initial.payload.meter.house_demand_power.value, 1410);
  assert.equal(initial.payload.meter.channel_power.decoded.channels.length, 3);
  assert.equal(initial.payload.energy.fuel_cells[0].source_role, "primary");
  assert.equal(initial.payload.energy.fuel_cells[0].cumulative_generation.value, 4321.234);
  assert.equal(initial.payload.energy.fuel_cells[0].hot_water_level.value, 4);
  assert.equal(initial.payload.energy.fuel_cells[1].source_role, "proxy");

  const manualGeneration = await request(baseUrl, "/api/actions/fuel-cell-start", {
    method: "POST",
    body: { host: "10.250.0.10" },
  });
  assert.equal(manualGeneration.response.status, 200);
  assert.equal(manualGeneration.payload.host, "10.250.0.30");
  assert.equal(manualGeneration.payload.epc, "0xCA");
  assert.equal(manualGeneration.payload.requested, "on");
  const startingFuelCell = await request(baseUrl, "/api/status");
  assert.equal(startingFuelCell.payload.energy.fuel_cells[0].generation_status.value, "starting");

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
