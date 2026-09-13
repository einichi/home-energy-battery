#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UI_DEVELOPMENT_DATA_PREFIX,
  assertSafeUiDevelopmentEnvironment,
} from "../lib/development-safety.js";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = Number(process.env.UI_DEV_API_PORT ?? 8797);
const uiPort = Number(process.env.UI_DEV_PORT ?? 5173);

if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || apiPort === 8787) {
  throw new Error("UI_DEV_API_PORT must be a non-production port from 1024 to 65535 and may not be 8787");
}
if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535 || uiPort === apiPort) {
  throw new Error("UI_DEV_PORT must be a distinct port from 1024 to 65535");
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), UI_DEVELOPMENT_DATA_PREFIX));
const simulatorPath = path.join(projectDir, "tests/support/device-simulator.js");
await writeFile(path.join(dataDir, "config.json"), `${JSON.stringify({
  batteryHost: "10.250.0.10",
  meterHost: "10.250.0.20",
  meterEoj: "0x028701",
  solarHost: "10.250.0.10",
  fuelCellHosts: ["10.250.0.30"],
  fuelCellPrimaryHost: "10.250.0.30",
  fuelCellProxyHosts: ["10.250.0.20"],
  solarEnabled: true,
  smartCosmoEnabled: true,
  fuelCellEnabled: true,
  adaptiveCharging: { enabled: false },
  notifications: { enabled: false },
}, null, 2)}\n`);
const sharedEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  UI_DEVELOPMENT_MODE: "1",
  DISABLE_EXTERNAL_IO: "1",
  DATA_DIR: dataDir,
  DEVICE_COMMAND_ADAPTER_MODULE: simulatorPath,
  DEVICE_SIMULATOR_SCENARIO: process.env.DEVICE_SIMULATOR_SCENARIO || "normal",
};

assertSafeUiDevelopmentEnvironment(sharedEnvironment, { projectDir });

const children = new Set();
let stopping = false;

function start(label, args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env: environment,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped unexpectedly (${signal ?? code ?? "unknown"})`);
      void stop(code || 1);
    }
  });
  return child;
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const runningChildren = [...children];
  const exits = runningChildren.map((child) => child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve)));
  for (const child of runningChildren) child.kill("SIGTERM");
  await Promise.all(exits);
  await rm(dataDir, { recursive: true, force: true });
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

console.log("SIMULATED UI DEVELOPMENT — production devices and external I/O are disabled");
console.log(`Simulator data: ${dataDir}`);
console.log(`React UI: http://127.0.0.1:${uiPort}/ui/`);
console.log(`Simulated API: http://127.0.0.1:${apiPort}`);

start("simulated API", [path.join(projectDir, "server.js")], {
  ...sharedEnvironment,
  PORT: String(apiPort),
});
start(
  "Vite",
  [
    path.join(projectDir, "node_modules/vite/bin/vite.js"),
    "--config",
    path.join(projectDir, "frontend/vite.config.ts"),
    "--host",
    "127.0.0.1",
    "--port",
    String(uiPort),
    "--strictPort",
  ],
  {
    ...sharedEnvironment,
    VITE_API_PORT: String(apiPort),
  },
);
