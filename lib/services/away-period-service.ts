import { randomUUID } from "node:crypto";
import { awayPeriodsOverlap } from "../domain/time.js";
import type { AwayPeriod as ManagedAwayPeriod } from "../contracts/away-period.js";
export type { AwayPeriod as ManagedAwayPeriod } from "../contracts/away-period.js";

export interface AwayPeriodRepository {
  awayPeriods(options: { includeCompleted: boolean; nowMs?: number }): unknown[];
  awayPeriod(id: string, nowMs?: number): unknown;
  createAwayPeriod(period: ManagedAwayPeriod): unknown;
  updateAwayPeriod(period: ManagedAwayPeriod): unknown;
  deleteAwayPeriod(id: string): boolean;
}

export interface AwayPeriodServiceDependencies {
  repository: AwayPeriodRepository;
  createError(status: number, message: string): Error;
  returnBufferMs: number;
}

function normalizePeriod(value: unknown): ManagedAwayPeriod | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const period = value as Record<string, unknown>;
  if (!period.id || !period.from || !period.until) return null;
  const status = period.status === "scheduled" || period.status === "active" || period.status === "completed"
    ? period.status
    : undefined;
  return {
    id: String(period.id),
    from: String(period.from),
    until: String(period.until),
    source: period.source === "manual" ? "manual" : "scheduled",
    createdAt: String(period.createdAt ?? ""),
    updatedAt: String(period.updatedAt ?? ""),
    ...(status ? { status } : {}),
  };
}

export function createAwayPeriodService({ repository, createError, returnBufferMs }: AwayPeriodServiceDependencies) {
  function timestamp(value: unknown, label: string): Date {
    const time = new Date(String(value ?? ""));
    if (Number.isNaN(time.getTime())) throw createError(400, `${label} must be a valid date and time`);
    return time;
  }

  function periods(includeCompleted: boolean, nowMs?: number): ManagedAwayPeriod[] {
    return repository.awayPeriods({ includeCompleted, ...(nowMs === undefined ? {} : { nowMs }) })
      .map(normalizePeriod)
      .filter((period): period is ManagedAwayPeriod => period !== null);
  }

  function ensureDoesNotOverlap(period: ManagedAwayPeriod, excludeId: string | null = null): void {
    const conflict = periods(true).find((candidate) => candidate.id !== excludeId && awayPeriodsOverlap(period, candidate));
    if (conflict) {
      throw createError(409, `Away period overlaps the existing period from ${conflict.from} until ${conflict.until}`);
    }
  }

  function view(now: Date = new Date()) {
    const upcoming = periods(false, now.getTime());
    const state: "home" | "away" = upcoming.some((period) => period.status === "active") ? "away" : "home";
    return {
      periods: upcoming,
      active: upcoming.find((period) => period.status === "active") ?? null,
      next: upcoming.find((period) => period.status === "scheduled") ?? null,
      state,
      returnBufferMinutes: returnBufferMs / 60_000,
    };
  }

  function cleanNew(value: unknown, now: Date = new Date()): ManagedAwayPeriod {
    const body = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const from = timestamp(body.from, "From");
    const until = timestamp(body.until, "Until");
    if (from.getTime() < now.getTime() - 60_000) throw createError(400, "From cannot be in the past");
    if (until.getTime() <= from.getTime()) throw createError(400, "Until must be after From");
    const at = now.toISOString();
    return { id: randomUUID(), from: from.toISOString(), until: until.toISOString(), source: body.source === "manual" ? "manual" : "scheduled", createdAt: at, updatedAt: at };
  }

  function find(id: string, now: Date = new Date()): ManagedAwayPeriod | null {
    return normalizePeriod(repository.awayPeriod(id, now.getTime()));
  }

  function create(period: ManagedAwayPeriod): ManagedAwayPeriod {
    const created = normalizePeriod(repository.createAwayPeriod(period));
    if (!created) throw new Error("Away period repository returned an invalid created period");
    return created;
  }

  function update(period: ManagedAwayPeriod): ManagedAwayPeriod | null {
    return normalizePeriod(repository.updateAwayPeriod(period));
  }

  function remove(id: string): boolean {
    return repository.deleteAwayPeriod(id);
  }

  return { cleanNew, create, ensureDoesNotOverlap, find, periods, remove, timestamp, update, view };
}
