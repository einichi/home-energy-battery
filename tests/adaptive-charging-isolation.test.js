import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-charging-isolation-"));
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
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Adaptive Charging isolation test\n${output}`);
}

async function request(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { response, payload };
}

async function assertIndependentApisAvailable(baseUrl, label) {
  const start = encodeURIComponent("2026-07-18T00:00:00.000Z");
  const end = encodeURIComponent("2026-07-19T00:00:00.000Z");
  const endpoints = [
    "/api/status",
    "/api/automation-rules",
    "/api/notifications",
    "/api/history/stats",
    `/api/history?start=${start}&end=${end}`,
    `/api/reports/energy?start=${start}&end=${end}&bucket=day`,
    `/api/ene-farm?start=${start}&end=${end}`,
    `/api/reports/ene-farm?start=${start}&end=${end}&bucket=day`,
    "/api/gas-tariffs?month=2026-07",
    "/api/away-periods",
  ];
  for (const endpoint of endpoints) {
    const { response, payload } = await request(baseUrl, endpoint);
    assert.equal(response.status, 200, `${label}: ${endpoint} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
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
      SCHEDULE_CHECK_INTERVAL_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  await waitFor(async () => (await fetch(`${baseUrl}/api/config`)).ok);
  const disabledConfig = await request(baseUrl, "/api/config", {
    method: "PUT",
    body: {
      adaptiveCharging: { enabled: false },
      batteryHost: "192.0.2.10",
      meterHost: "192.0.2.20",
      solarHost: "192.0.2.10",
      fuelCellHosts: ["192.0.2.30"],
    },
  });
  assert.equal(disabledConfig.response.status, 200);
  assert.equal(disabledConfig.payload.adaptiveCharging.enabled, false);

  await assertIndependentApisAvailable(baseUrl, "Adaptive Charging disabled");
  const recordedStats = await request(baseUrl, "/api/history/stats");
  assert.ok(recordedStats.payload.sampleCount >= 1, "status collection should continue recording while Adaptive Charging is disabled");

  const trim = await request(baseUrl, "/api/history/trim", {
    method: "POST",
    body: { retentionDays: 1095 },
  });
  assert.equal(trim.response.status, 200, `retention trim failed: ${JSON.stringify(trim.payload)}`);

  const rule = await request(baseUrl, "/api/automation-rules", {
    method: "POST",
    body: {
      name: "Isolation test Demand Guard",
      type: "backup-demand-guard",
      enabled: false,
      conditions: { source: "gridImportW", breakerAmps: 40, reserveAmps: 5 },
    },
  });
  assert.equal(rule.response.status, 201);
  const enabledRule = await request(baseUrl, `/api/automation-rules/${rule.payload.id}`, {
    method: "PATCH",
    body: { enabled: true },
  });
  assert.equal(enabledRule.response.status, 200);
  assert.equal(enabledRule.payload.enabled, true);
  const deletedRule = await request(baseUrl, `/api/automation-rules/${rule.payload.id}`, { method: "DELETE" });
  assert.equal(deletedRule.response.status, 200);
  assert.equal(deletedRule.payload.ok, true);

  const schedule = await request(baseUrl, "/api/schedules", {
    method: "POST",
    body: {
      name: "No-device isolation schedule",
      action: "test-unsupported-action",
      repeat: "once",
      runAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert.equal(schedule.response.status, 201);
  const executedSchedule = await waitFor(async () => {
    const result = await request(baseUrl, "/api/schedules");
    return result.payload.find((item) => item.id === schedule.payload.id && item.lastResult) ?? null;
  });
  assert.equal(executedSchedule.lastResult.ok, false);
  assert.match(executedSchedule.lastResult.error, /unknown action: test-unsupported-action/);
  const deletedSchedule = await request(baseUrl, `/api/schedules/${schedule.payload.id}`, { method: "DELETE" });
  assert.equal(deletedSchedule.response.status, 200);
  assert.equal(deletedSchedule.payload.ok, true);

  const enabledConfig = await request(baseUrl, "/api/config", {
    method: "PUT",
    body: {
      adaptiveCharging: { enabled: true },
      solarEnabled: true,
      rateMode: "multi",
    },
  });
  assert.equal(enabledConfig.response.status, 200);
  assert.equal(enabledConfig.payload.adaptiveCharging.enabled, true);

  const blockedSchedule = await request(baseUrl, "/api/schedules", {
    method: "POST",
    body: {
      name: "Should be blocked",
      action: "test-unsupported-action",
      repeat: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal(blockedSchedule.response.status, 409);
  assert.match(blockedSchedule.payload.error, /disabled while adaptive charging is enabled/);
  await assertIndependentApisAvailable(baseUrl, "Adaptive Charging enabled");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
}

console.log("Adaptive Charging isolation tests passed");
