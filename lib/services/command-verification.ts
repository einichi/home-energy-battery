type UnknownRecord = Record<string, unknown>;
type ReadStatus = () => Promise<unknown>;
type Wait = (milliseconds: number) => Promise<unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function commandRequestPayload(value: unknown = {}): UnknownRecord {
  const payload = record(value);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "host"));
}

export function commandResultSummary(value: unknown = {}): UnknownRecord {
  const result = record(value);
  return {
    ok: result.ok ?? null,
    esv: result.esv ?? null,
    acknowledged: result.acknowledged ?? null,
    results: Array.isArray(result.results) ? result.results : null,
  };
}

export function commandFailureType(error: unknown): "timed-out" | "mismatched" | "failed" {
  const message = errorMessage(error);
  if (/timed? out|timeout|exceeded .*ms/i.test(message)) return "timed-out";
  if (/still read back as|verification mismatch|expected .* observed/i.test(message)) return "mismatched";
  return "failed";
}

export function assertDeviceCommandResult(
  value: unknown,
  description = "device command",
  invalidate: () => void = () => undefined,
): UnknownRecord & { acknowledged: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} returned no acknowledgement`);
  }
  const result = value as UnknownRecord;
  const failures: string[] = [];
  if (result.error) failures.push(String(result.error));
  if (result.ok === false) failures.push(result.esv ? `rejected with ${String(result.esv)}` : "was rejected");
  for (const value of Array.isArray(result.results) ? result.results : []) {
    const write = record(value);
    if (write.ok === false) failures.push(`${String(write.epc ?? "write")} rejected with ${String(write.esv ?? "unknown ESV")}`);
  }
  if (failures.length) throw new Error(`${description} failed: ${failures.join("; ")}`);
  invalidate();
  return {
    ...result,
    acknowledged: result.acknowledged === true
      || result.ok === true
      || (Array.isArray(result.results) && result.results.length > 0),
  };
}

const BATTERY_OPERATION_MODE_BY_EDT = new Map<number, string>([
  [0x40, "other"],
  [0x41, "rapid_charging"],
  [0x42, "charging"],
  [0x43, "discharging"],
  [0x44, "standby"],
  [0x45, "test"],
  [0x46, "auto"],
  [0x47, "restart"],
  [0x48, "capacity_recalculation"],
]);

export function batteryOperationModeFromReadback(value: unknown): string | null {
  const status = record(value);
  const battery = record(status.battery);
  const operationMode = record(battery.operation_mode);
  const decoded = operationMode.value ?? operationMode.human ?? null;
  if (decoded !== null) return String(decoded);
  const rawMatch = String(status.raw ?? "").match(/^0x([0-9a-f]{2})$/i);
  return rawMatch ? BATTERY_OPERATION_MODE_BY_EDT.get(Number.parseInt(rawMatch[1]!, 16)) ?? null : null;
}

export async function verifyBatteryOperationMode(
  value: unknown,
  _host: string,
  expectedMode: unknown,
  {
    attempts = 4,
    delayMs = 750,
    readStatus,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }: { attempts?: number; delayMs?: number; readStatus: ReadStatus; wait?: Wait },
): Promise<UnknownRecord & { verified: true; readBack: { operationMode: string; attempts: number } }> {
  const result = record(value);
  const normalizedExpected = String(expectedMode).toLowerCase().replaceAll("-", "_");
  let actualMode: string | null = null;
  let lastReadError: unknown = null;
  const maximumAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      actualMode = batteryOperationModeFromReadback(await readStatus());
      const normalizedActual = actualMode?.toLowerCase().replaceAll("-", "_") ?? null;
      if (normalizedActual === normalizedExpected) {
        return { ...result, verified: true, readBack: { operationMode: actualMode ?? normalizedExpected, attempts: attempt } };
      }
      lastReadError = null;
    } catch (error: unknown) {
      lastReadError = error;
      break;
    }
    if (attempt < maximumAttempts && delayMs > 0) await wait(delayMs);
  }
  if (lastReadError) {
    throw new Error(
      `operation mode ${String(expectedMode)} was acknowledged but verification failed after ${maximumAttempts} attempts: ${errorMessage(lastReadError)}`,
      { cause: lastReadError },
    );
  }
  if (!actualMode) throw new Error(`operation mode ${String(expectedMode)} was acknowledged but could not be verified after ${maximumAttempts} attempts`);
  throw new Error(`operation mode ${String(expectedMode)} was acknowledged but still read back as ${actualMode} after ${maximumAttempts} attempts`);
}

export async function verifyBatterySetting(
  value: unknown,
  host: string,
  command: string,
  expected: unknown,
  readObserved: (readback: unknown) => unknown,
  {
    attempts = 4,
    delayMs = 750,
    run,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }: {
    attempts?: number;
    delayMs?: number;
    run: (command: string, args: { host: string }) => Promise<unknown>;
    wait?: Wait;
  },
): Promise<UnknownRecord & { verified: true; readBack: { value: unknown; attempts: number } }> {
  const result = record(value);
  let observed: unknown = null;
  let lastReadError: unknown = null;
  const maximumAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (attempt > 1 && delayMs > 0) await wait(delayMs);
    try {
      observed = readObserved(await run(command, { host }));
      lastReadError = null;
      if (JSON.stringify(observed) === JSON.stringify(expected)) {
        return { ...result, verified: true, readBack: { value: observed, attempts: attempt } };
      }
    } catch (error: unknown) {
      lastReadError = error;
    }
  }
  if (lastReadError) throw new Error(`${command} was acknowledged but verification failed: ${errorMessage(lastReadError)}`, { cause: lastReadError });
  throw new Error(`${command} verification mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
}
