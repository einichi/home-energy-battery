export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timestampMs(value: unknown): number | null {
  const time = new Date(String(value ?? "")).getTime();
  return Number.isFinite(time) ? time : null;
}
