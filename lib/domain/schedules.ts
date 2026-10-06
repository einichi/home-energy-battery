import { localDayKey } from "./time.js";
import type { BatterySchedule } from "../contracts/schedules.js";

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];


export function nextScheduleAt(schedule: BatterySchedule, now: Date = new Date()): string | null {
  if (!schedule.enabled) return null;
  if (schedule.repeat !== "daily") {
    const timestamp = new Date(schedule.runAt ?? "").getTime();
    return Number.isFinite(timestamp) && timestamp > now.getTime() ? new Date(timestamp).toISOString() : null;
  }
  if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) return null;
  const [hour, minute] = (schedule.time ?? "").split(":").map(Number);
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : ALL_DAYS;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (days.includes(candidate.getDay()) && candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return null;
}


export function parseRunAt(schedule: BatterySchedule): string | null {
  if (schedule.repeat === "daily") {
    if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) throw new Error("daily schedules require time as HH:MM");
    const [hh, mm] = (schedule.time ?? "").split(":").map(Number);
    if (hh > 23 || mm > 59) throw new Error("daily schedule time must be HH:MM");
    return null;
  }
  const runAt = new Date(schedule.runAt ?? "");
  if (Number.isNaN(runAt.getTime())) throw new Error("one-time schedules require runAt as an ISO date/time");
  return runAt.toISOString();
}


export function isDue(schedule: BatterySchedule, now: Date): boolean {
  // Daily schedules run once per local calendar day; one-off schedules disable
  // themselves after a successful attempt.
  if (!schedule.enabled) return false;
  if (schedule.running) return false;
  if (schedule.repeat === "daily") {
    const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : ALL_DAYS;
    if (!days.includes(now.getDay())) return false;
    const match = /^(\d{2}):(\d{2})$/.exec(schedule.time ?? "");
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return false;
    const todayKey = localDayKey(now);
    if (schedule.lastRunDate === todayKey || schedule.lastAttemptDate === todayKey) return false;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const scheduledMinutes = hour * 60 + minute;
    // Run on the first tick at or after the scheduled minute so a delayed tick,
    // a restart, or a DST spring-forward gap does not silently skip the day.
    if (nowMinutes < scheduledMinutes) return false;
    // Do not fire a schedule that was created after its time today; wait for the
    // next occurrence instead of running it immediately on creation.
    const createdMs = new Date(schedule.createdAt ?? "").getTime();
    if (Number.isFinite(createdMs) && localDayKey(new Date(createdMs)) === todayKey) {
      const createdMinutes = new Date(createdMs).getHours() * 60 + new Date(createdMs).getMinutes();
      if (createdMinutes > scheduledMinutes) return false;
    }
    return true;
  }
  return Boolean(schedule.runAt && new Date(schedule.runAt) <= now && !schedule.executionIntent);
}


export function clearStaleScheduleRuns(schedules: BatterySchedule[], activeIds: ReadonlySet<string>): boolean {
  let changed = false;
  for (const schedule of schedules) {
    if (!schedule.running || activeIds.has(schedule.id)) continue;
    schedule.running = false;
    schedule.runningSince = null;
    changed = true;
  }
  return changed;
}
