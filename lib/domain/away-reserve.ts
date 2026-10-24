import type { AwayPeriod } from "../contracts/away-period.js";
import { asRecord } from "./values.js";
import { finiteNumberOrNull } from "./numbers.js";

export type AwayReservePhase = "idle" | "applying" | "active" | "restoring" | "suspended" | "manual" | "manual-pending";
export interface AwayReserveState {
  [key: string]: unknown;
  version: 1;
  phase: AwayReservePhase;
  host: string | null;
  previousPercent: number | null;
  windowFrom: string | null;
  windowUntil: string | null;
  manualRequestedPercent: number | null;
  manualWindowFrom: string | null;
  manualHost: string | null;
  lastError: string | null;
  retryAt: string | null;
  updatedAt: string | null;
}

export function reservePercent(value: unknown): number | null {
  const number = finiteNumberOrNull(value);
  return number !== null && Number.isInteger(number) && number >= 0 && number <= 100 && number % 10 === 0 ? number : null;
}

export function cleanAwayReserveState(value: unknown = {}): AwayReserveState {
  const input = asRecord(value);
  const phase = ["idle", "applying", "active", "restoring", "suspended", "manual", "manual-pending"].includes(String(input.phase))
    ? input.phase as AwayReservePhase : "idle";
  return {
    version: 1, phase,
    host: typeof input.host === "string" ? input.host : null,
    previousPercent: reservePercent(input.previousPercent),
    windowFrom: typeof input.windowFrom === "string" ? input.windowFrom : null,
    windowUntil: typeof input.windowUntil === "string" ? input.windowUntil : null,
    manualRequestedPercent: reservePercent(input.manualRequestedPercent),
    manualWindowFrom: typeof input.manualWindowFrom === "string" ? input.manualWindowFrom : null,
    manualHost: typeof input.manualHost === "string" ? input.manualHost : null,
    lastError: typeof input.lastError === "string" ? input.lastError : null,
    retryAt: typeof input.retryAt === "string" ? input.retryAt : null,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
  };
}

/** Treat touching periods as one continuous absence, including at their shared boundary. */
export function continuousAwayWindow(periods: readonly AwayPeriod[], now: Date): { from: string; until: string } | null {
  const ranges = periods.map((period) => ({ from: Date.parse(period.from), until: Date.parse(period.until) }))
    .filter((range) => Number.isFinite(range.from) && range.until > range.from).sort((a, b) => a.from - b.from);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.until) previous.until = Math.max(previous.until, range.until);
    else merged.push({ ...range });
  }
  const range = merged.find((entry) => entry.from <= now.getTime() && now.getTime() < entry.until);
  return range ? { from: new Date(range.from).toISOString(), until: new Date(range.until).toISOString() } : null;
}

export function ownsAwayReserve(state: AwayReserveState): boolean {
  return ["applying", "active", "restoring"].includes(state.phase) && state.previousPercent !== null && Boolean(state.host);
}
