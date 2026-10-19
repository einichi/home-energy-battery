import { randomUUID } from "node:crypto";
import type { AutomationStatus } from "../domain/automation-rules.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BatterySchedule } from "../contracts/schedules.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import { backupPreparationBlocksActions } from "../domain/operational-overrides.js";
import { clearStaleScheduleRuns, isDue } from "../domain/schedules.js";
import { localDayKey } from "../domain/time.js";
import { chargingStartGuard } from "../domain/automation-rules.js";

export interface ScheduleRunnerDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readOperationalOverrides(): Promise<unknown>;
  readAutomationRules(): Promise<AutomationRule[]>;
  getStatusSnapshot(options: { maxAgeMs: number }): Promise<AutomationStatus>;
  mutateSchedules<T>(mutator: (schedules: BatterySchedule[]) => Promise<T> | T): Promise<T>;
  writeSchedules(schedules: BatterySchedule[]): Promise<BatterySchedule[]>;
  executeAction(action: string, payload: unknown, options: { source: string }): Promise<unknown>;
  notify(event: Record<string, unknown>): Promise<unknown> | unknown;
  warn(message: string): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createScheduleRunner(dependencies: ScheduleRunnerDependencies) {
  const runningIds = new Set<string>();

  async function run(): Promise<void> {
    const config = await dependencies.readConfig();
    if (config.adaptiveCharging.enabled && config.solarEnabled && config.rateMode !== "simple") return;
    if (backupPreparationBlocksActions(await dependencies.readOperationalOverrides())) {
      await dependencies.mutateSchedules(async (schedules) => {
        const now = new Date();
        for (const schedule of schedules) {
          if (!isDue(schedule, now)) continue;
          const attemptedAt = now.toISOString();
          const attemptDate = localDayKey(now);
          schedule.lastAttemptDate = attemptDate;
          schedule.lastResult = { ok: false, skipped: "Backup Preparation owns battery control", at: attemptedAt };
          schedule.executionIntent = { id: randomUUID(), state: "blocked", attemptedAt, completedAt: attemptedAt, action: schedule.action, payload: schedule.payload };
          if (schedule.repeat !== "daily") {
            schedule.enabled = false;
            schedule.completed = true;
          }
        }
      });
      return;
    }
    const rules = await dependencies.readAutomationRules();
    const guardOwner = rules.find((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state.awaitingRestore);
    await dependencies.mutateSchedules(async (schedules) => {
      const now = new Date();
      if (clearStaleScheduleRuns(schedules, runningIds)) dependencies.warn("scheduler: cleared stale running state from persisted schedule data");
      for (const schedule of schedules) {
        if (!isDue(schedule, now)) continue;
        const attemptAt = new Date().toISOString();
        const attemptDate = localDayKey(now);
        schedule.lastAttemptDate = attemptDate;
        schedule.executionIntent = { id: randomUUID(), state: guardOwner ? "blocked" : "pending", attemptedAt: attemptAt, action: schedule.action, payload: schedule.payload };
        if (guardOwner) {
          schedule.lastResult = { ok: false, skipped: "Charging Demand Guard owns Standby operation mode", at: attemptAt };
          schedule.executionIntent.state = "blocked";
          // One-time schedules must not stay enabled with a permanent blocked
          // intent: isDue() requires no executionIntent, so complete them.
          if (schedule.repeat !== "daily") {
            schedule.enabled = false;
            schedule.completed = true;
          }
          continue;
        }
        const isChargeStart = schedule.action === "charge"
          || (schedule.action === "set-mode"
            && schedule.payload !== null
            && typeof schedule.payload === "object"
            && !Array.isArray(schedule.payload)
            && (schedule.payload as Record<string, unknown>).mode === "charging");
        if (isChargeStart && rules.some((rule) => rule.enabled && rule.type === "backup-demand-guard")) {
          try {
            const status = await dependencies.getStatusSnapshot({ maxAgeMs: 0 });
            const decision = chargingStartGuard(status, config.batteryCapabilities.maximumChargeWatts, rules);
            if (!decision.allowed) {
              schedule.lastResult = { ok: false, skipped: decision.reason ?? undefined, at: attemptAt, ...decision };
              schedule.executionIntent.state = "blocked";
              schedule.executionIntent.completedAt = attemptAt;
              if (schedule.repeat !== "daily") {
                schedule.enabled = false;
                schedule.completed = true;
              }
              continue;
            }
          } catch (error: unknown) {
            schedule.lastResult = {
              ok: false,
              skipped: "Charging Demand Guard: status unavailable",
              at: attemptAt,
              error: message(error),
            };
            schedule.executionIntent.state = "blocked";
            schedule.executionIntent.completedAt = attemptAt;
            if (schedule.repeat !== "daily") {
              schedule.enabled = false;
              schedule.completed = true;
            }
            continue;
          }
        }
        runningIds.add(schedule.id);
        schedule.running = true;
        schedule.runningSince = attemptAt;
        try {
          // Persist the running intent before executing so a crash mid-action is
          // recovered by clearStaleScheduleRuns on restart; mutateSchedules()
          // persists the final state after this mutator returns.
          await dependencies.writeSchedules(schedules);
          const result = await dependencies.executeAction(schedule.action, schedule.payload, { source: "schedule" });
          schedule.lastResult = { ok: true, at: new Date().toISOString(), result };
          schedule.executionIntent.state = "succeeded";
          schedule.executionIntent.completedAt = schedule.lastResult.at;
          if (schedule.repeat === "daily") schedule.lastRunDate = attemptDate;
          else {
            schedule.enabled = false;
            schedule.completed = true;
          }
        } catch (error: unknown) {
          const detail = message(error);
          schedule.lastResult = { ok: false, at: new Date().toISOString(), error: detail };
          schedule.executionIntent.state = /timed? out|timeout/i.test(detail) ? "unknown" : "failed";
          schedule.executionIntent.completedAt = schedule.lastResult.at;
          if (schedule.repeat !== "daily") {
            schedule.enabled = false;
            schedule.completed = true;
          }
          void dependencies.notify({ type: "scheduleFailed", severity: "error", title: "Scheduled battery action failed", message: `${schedule.repeat === "daily" ? `Daily ${schedule.time}` : schedule.runAt} ${schedule.action} failed: ${detail}`, dedupeKey: `schedule-failed:${schedule.id}:${attemptDate}` });
        } finally {
          runningIds.delete(schedule.id);
          schedule.running = false;
          schedule.runningSince = null;
        }
      }
    });
  }

  return { activeCount: () => runningIds.size, run };
}
