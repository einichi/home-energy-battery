export interface ServerEnvironment {
  host: string;
  /** Legacy alias for `httpPort`, retained for `/api/config` compatibility. */
  port: number;
  httpPort: number;
  httpsPort: number;
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

function text(value: unknown, fallback: string, name: string): string {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = String(value).trim();
  if (!parsed) throw new Error(`${name} must not be empty`);
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
  const httpPort = finiteInteger(input.HTTP_PORT ?? input.PORT, 8787, 1, 65_535, "HTTP_PORT");
  return {
    host: text(input.HOST, "0.0.0.0", "HOST"),
    port: httpPort,
    httpPort,
    httpsPort: finiteInteger(input.HTTPS_PORT, 443, 1, 65_535, "HTTPS_PORT"),
    dataDir,
    echonetTimeoutMs: finiteInteger(input.ECHONET_TIMEOUT_MS, 15_000, 100, 300_000, "ECHONET_TIMEOUT_MS"),
    scheduleCheckIntervalMs: finiteInteger(input.SCHEDULE_CHECK_INTERVAL_MS, 15_000, 10, 86_400_000, "SCHEDULE_CHECK_INTERVAL_MS"),
    automationCheckIntervalMs: finiteInteger(input.AUTOMATION_CHECK_INTERVAL_MS, 30_000, 50, 86_400_000, "AUTOMATION_CHECK_INTERVAL_MS"),
  };
}
