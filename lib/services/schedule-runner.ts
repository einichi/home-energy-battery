import { randomUUID } from "node:crypto";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BatterySchedule } from "../contracts/schedules.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import { backupPreparationBlocksActions } from "../domain/operational-overrides.js";
import { clearStaleScheduleRuns, isDue } from "../domain/schedules.js";
import { localDayKey } from "../domain/time.js";

export interface ScheduleRunnerDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readOperationalOverrides(): Promise<unknown>;
  readAutomationRules(): Promise<AutomationRule[]>;
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
          // One-time schedules must not stay "enabled" with a permanent blocked
          // intent: isDue() requires no executionIntent, so they could never run
          // again. Mirror the Backup Preparation handling and complete them.
          if (schedule.repeat !== "daily") {
            schedule.enabled = false;
            schedule.completed = true;
          }
          continue;
        }
        runningIds.add(schedule.id);
        schedule.running = true;
        schedule.runningSince = attemptAt;
        await dependencies.writeSchedules(schedules);
        try {
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
          await dependencies.writeSchedules(schedules);
        }
      }
    });
  }

  return { activeCount: () => runningIds.size, run };
}
