import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function availablePort(): Promise<any> {
  const listener = net.createServer();
  await new Promise((resolve: any, reject: any) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as net.AddressInfo;
  await new Promise((resolve: any) => listener.close(resolve));
  return port;
}

async function waitFor(check: any, output: any, timeoutMs: any = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve: any) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for command lifecycle\n${output()}`);
}

async function jsonRequest(origin: any, pathname: any, { method = "GET", body }: any = {}): Promise<any> {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function verifyScenario(scenario: any, expectedState: any): Promise<any> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `command-lifecycle-${scenario}-`));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [path.resolve(".test-dist/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_ENV: "test",
      DEVICE_COMMAND_ADAPTER_MODULE: path.resolve(".test-dist/tests/support/device-simulator.js"),
      DEVICE_SIMULATOR_SCENARIO: scenario,
      SCHEDULE_CHECK_INTERVAL_MS: "1000",
      AUTOMATION_CHECK_INTERVAL_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: any) => { output += chunk; });
  child.stderr.on("data", (chunk: any) => { output += chunk; });

  try {
    await waitFor(async () => (await fetch(`${origin}/api/config`)).ok, () => output);
    const configured = await jsonRequest(origin, "/api/config", {
      method: "PUT",
      body: {
        batteryHost: "10.250.0.10",
        solarEnabled: false,
        smartCosmoEnabled: false,
        fuelCellEnabled: false,
        adaptiveCharging: { enabled: false },
        updateIntervalSeconds: 3600,
      },
    });
    assert.equal(configured.response.status, 200, output);

    const started = await jsonRequest(origin, "/api/device-commands", {
      method: "POST",
      body: { action: "set-mode", payload: { mode: "standby" } },
    });
    assert.equal(started.response.status, 202, output);
    const receipt = await waitFor(async () => {
      const current = await jsonRequest(origin, `/api/device-commands/${started.payload.commandId}`);
      return ["succeeded", "failed", "timed-out", "mismatched"].includes(current.payload.state) ? current.payload : null;
    }, () => output);

    assert.equal(receipt.state, expectedState, `${scenario}: ${JSON.stringify(receipt)}\n${output}`);
    assert.equal(receipt.events.at(-1).type, "requested");
    assert.ok(receipt.events.some((event: any) => event.type === "sending"));
    assert.ok(receipt.events.some((event: any) => event.type === expectedState));
    if (expectedState === "succeeded" || expectedState === "mismatched") {
      assert.ok(receipt.events.some((event: any) => event.type === "acknowledged"));
      assert.ok(receipt.events.some((event: any) => event.type === "verifying"));
    }
    if (scenario === "command-delay") assert.ok(receipt.durationMs >= 60);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve: any) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

await verifyScenario("command-delay", "succeeded");
await verifyScenario("command-rejection", "failed");
await verifyScenario("command-timeout", "timed-out");
await verifyScenario("readback-mismatch", "mismatched");

console.log("command lifecycle scenario tests passed");
