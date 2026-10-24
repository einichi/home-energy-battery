import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "away-reserve-integration-"));
const origin = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, [path.resolve(".test-dist/server.js")], {
  env: { ...process.env, NODE_ENV: "test", DATA_DIR: dataDir, PORT: String(port), DISABLE_EXTERNAL_IO: "1",
    DEVICE_COMMAND_ADAPTER_MODULE: path.resolve(".test-dist/tests/support/device-simulator.js"),
    AUTOMATION_CHECK_INTERVAL_MS: "1000", SCHEDULE_CHECK_INTERVAL_MS: "1000" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
async function request(url: string, method = "GET", body?: Record<string, unknown>) {
  const response = await fetch(origin + url, { method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json() as Record<string, unknown>;
  return { status: response.status, payload };
}
async function successful(url: string, method = "GET", body?: Record<string, unknown>) {
  const result = await request(url, method, body);
  assert.ok(result.status >= 200 && result.status < 300, `${url}: ${JSON.stringify(result)}\n${output}`);
  return result.payload;
}
async function away() {
  const now = new Date();
  const result = await successful("/api/away-periods", "POST", { from: now.toISOString(), until: new Date(now.getTime() + 3_600_000).toISOString() });
  return (result.period as { id: string }).id;
}
async function floor() {
  const status = await successful("/api/status");
  return (status.settings as { discharge_limit: { decoded: { percent: number } } }).discharge_limit.decoded.percent;
}
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(origin + "/api/config")).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`Server startup failed\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await successful("/api/config", "PUT", { batteryHost: "10.250.0.10", solarEnabled: false, smartCosmoEnabled: false,
    fuelCellEnabled: false, adaptiveCharging: { enabled: false }, updateIntervalSeconds: 3600 });
  assert.equal((await successful("/api/away-reserve")).enabled, false);
  assert.equal((await request("/api/away-reserve", "PATCH", { enabled: "true" })).status, 400);
  const first = await away();
  const active = await successful("/api/away-reserve", "PATCH", { enabled: true });
  assert.equal(active.phase, "active"); assert.equal(active.previousPercent, 20); assert.equal(await floor(), 0);
  await successful(`/api/away-periods/${first}/back-home`, "POST", {});
  assert.equal(await floor(), 20); assert.equal((await successful("/api/away-reserve")).phase, "idle");

  const second = await away();
  await successful("/api/device-actions/discharge-limit", "POST", { percent: 30 });
  assert.equal((await successful("/api/away-reserve")).phase, "manual");
  await successful(`/api/away-periods/${second}/back-home`, "POST", {});
  assert.equal(await floor(), 30, "manual choice must survive return");

  const third = await away(); assert.equal(await floor(), 0);
  await successful("/api/backup-preparation/start", "POST", { allowDemandGuard: true });
  assert.equal(await floor(), 30); assert.equal((await successful("/api/away-reserve")).phase, "suspended");
  assert.equal((await request("/api/device-actions/discharge-limit", "POST", { percent: 40 })).status, 409);
  await successful("/api/backup-preparation/end", "POST", {});
  assert.equal(await floor(), 0);
  await successful(`/api/away-periods/${third}/back-home`, "POST", {});
  assert.equal(await floor(), 30);
  await successful("/api/away-reserve", "PATCH", { enabled: false });
  assert.equal((await successful("/api/config")).awayReserveEnabled, false);
  console.log("Away reserve API, verified device commands, manual priority and Backup Preparation integration passed");
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  await rm(dataDir, { recursive: true, force: true });
}
