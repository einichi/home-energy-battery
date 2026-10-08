import { MILLISECONDS_PER_DAY } from "../domain/time.js";
import runtimeDefaults from "../../shared/runtime-defaults.json" with { type: "json" };

export interface ServerEnvironment {
  port: number;
  dataDir: string;
  echonetTimeoutMs: number;
  scheduleCheckIntervalMs: number;
  automationCheckIntervalMs: number;
}

function finiteInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function normalizeServerEnvironment(
  input: Readonly<Record<string, unknown>>,
  defaultDataDir: string,
): ServerEnvironment {
  const dataDir = input.DATA_DIR === undefined || input.DATA_DIR === null
    ? defaultDataDir
    : String(input.DATA_DIR).trim();
  if (!dataDir) throw new Error("DATA_DIR must not be empty");
  return {
    port: finiteInteger(input.PORT, runtimeDefaults.port, 1, 65_535, "PORT"),
    dataDir,
    echonetTimeoutMs: finiteInteger(input.ECHONET_TIMEOUT_MS, 15_000, 100, 300_000, "ECHONET_TIMEOUT_MS"),
    scheduleCheckIntervalMs: finiteInteger(input.SCHEDULE_CHECK_INTERVAL_MS, 15_000, 10, MILLISECONDS_PER_DAY, "SCHEDULE_CHECK_INTERVAL_MS"),
    automationCheckIntervalMs: finiteInteger(input.AUTOMATION_CHECK_INTERVAL_MS, 30_000, 50, MILLISECONDS_PER_DAY, "AUTOMATION_CHECK_INTERVAL_MS"),
  };
}
