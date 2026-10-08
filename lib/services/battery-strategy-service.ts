import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BatterySchedule } from "../contracts/schedules.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import type { OperationalOverridesState } from "../domain/operational-overrides.js";
import { backupPreparationView } from "../domain/operational-overrides.js";
import { finiteNumberOrNull } from "../domain/numbers.js";
import { nextScheduleAt } from "../domain/schedules.js";
import { adaptiveChargingConfiguredActive } from "../domain/adaptive-control.js";
import type { AwayPeriod } from "../contracts/away-period.js";
import type { BatteryStrategy } from "../../shared/api-contracts.js";

interface CommandReceipt {
  state: string;
  source?: string | null;
  action: string;
  request?: Record<string, unknown>;
}

interface AwayPeriodsView {
  active: AwayPeriod | null;
  next: AwayPeriod | null;
  state: string;
}

export interface BatteryStrategyDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readAdaptiveChargingState(): Promise<AdaptiveChargingState>;
  readOperationalOverridesState(): Promise<OperationalOverridesState>;
  readAutomationRules(): Promise<AutomationRule[]>;
  readSchedules(): Promise<BatterySchedule[]>;
  readCommandReceipts(limit: number, beforeMs: number): CommandReceipt[];
  historyReady(): boolean;
  awayPeriodsView(now: Date): AwayPeriodsView;
  solarForecastAccuracy(now: Date): { learned?: boolean };
}

export function createBatteryStrategyService(dependencies: BatteryStrategyDependencies) {
  return async function view(now: Date = new Date()) {
    const [config, adaptive, overrides, rules, schedules] = await Promise.all([
      dependencies.readConfig(),
      dependencies.readAdaptiveChargingState(),
      dependencies.readOperationalOverridesState(),
      dependencies.readAutomationRules(),
      dependencies.readSchedules(),
    ]);
    const backup = backupPreparationView(overrides);
    const away = dependencies.historyReady()
      ? dependencies.awayPeriodsView(now)
      : { active: null, next: null, state: "home" };
    const guard = rules.find((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
    const recentTerminal = dependencies.readCommandReceipts(20, now.getTime())
      .find((receipt) => ["succeeded", "failed", "timed-out", "mismatched"].includes(receipt.state));
    const nextSchedule = adaptiveChargingConfiguredActive(config)
      ? null
      : schedules
        .map((schedule) => ({ schedule, at: nextScheduleAt(schedule, now) }))
        .filter((item): item is { schedule: BatterySchedule; at: string } => typeof item.at === "string")
        .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())[0] ?? null;
    const paused = adaptive.pausedUntil && new Date(adaptive.pausedUntil).getTime() > now.getTime();
    const manualDirect = recentTerminal?.state === "succeeded"
      && recentTerminal.source === "manual"
      && ["charge", "discharge", "set-mode"].includes(recentTerminal.action)
      && !(recentTerminal.action === "set-mode" && recentTerminal.request?.mode === "auto");
    const manualProfile = recentTerminal?.state === "succeeded" && recentTerminal.source === "manual" && recentTerminal.action === "vendor-profile";
    const scheduledCommand = recentTerminal?.state === "succeeded" && recentTerminal.source === "schedule";
    const forecastConfidence = dependencies.solarForecastAccuracy(now).learned ? "calibrated" : "initial";

    let strategy: Pick<BatteryStrategy, "kind" | "title" | "description">;
    if (backup.active) {
      strategy = { kind: "backup-preparation", title: "Disaster Prep", description: `Holding the ${backup.currentProfile ?? "backup"} profile while normal automation is suspended.` };
    } else if (guard) {
      strategy = { kind: "demand-guard", title: "Charging Demand Guard", description: "Standby is being held to preserve configured breaker headroom." };
    } else if (adaptive.owner === "adaptiveCharging") {
      strategy = { kind: "adaptive-charging", title: "Adaptive Charging", description: adaptive.plan?.reason ?? "The active charging plan currently owns battery operation." };
    } else if (away.active) {
      strategy = { kind: "away", title: "Away mode", description: `Away assumptions remain active until ${away.active.until}.` };
    } else if (manualDirect || manualProfile || paused) {
      strategy = {
        kind: "manual",
        title: "Manual control",
        description: paused
          ? `A manual battery action paused Adaptive Charging until ${adaptive.pausedUntil}.`
          : manualProfile
            ? `The ${recentTerminal.request?.mode ?? "selected"} charging profile was selected manually.`
            : "The latest direct battery command remains in effect until changed by another command or automation.",
      };
    } else if (config.adaptiveCharging?.enabled) {
      strategy = { kind: "adaptive-charging", title: "Adaptive Charging", description: adaptive.plan?.reason ?? "Waiting for the next planned charging window." };
    } else if (scheduledCommand) {
      strategy = { kind: "schedule", title: "Scheduled control", description: `The latest schedule applied ${recentTerminal.action}; that result remains in effect until another command or automation changes it.` };
    } else if (nextSchedule) {
      strategy = { kind: "schedule", title: "Scheduled control", description: `${nextSchedule.schedule.name} is next at ${nextSchedule.at}.` };
    } else {
      strategy = { kind: "device-auto", title: "Device-managed operation", description: "No application automation currently owns the battery." };
    }
    const upcomingAdaptiveSlot = adaptive.plan?.slots
      ?.filter((slot) => new Date(slot.end).getTime() > now.getTime())
      .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())[0] ?? null;
    const nextAction: BatteryStrategy["nextAction"] = adaptive.owner === "adaptiveCharging" && adaptive.activeSlot
      ? {
          action: "continue-charging",
          title: "Continue charging",
          reason: adaptive.plan?.reason ?? "The active discounted window currently owns battery charging.",
          at: adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd ?? null,
          endAt: adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd ?? null,
          targetSocPercent: finiteNumberOrNull(adaptive.activeSlot.targetSocPercent),
          confidence: forecastConfidence,
          href: "/automation",
        }
      : config.adaptiveCharging?.enabled && upcomingAdaptiveSlot
        ? {
            action: "charge",
            title: "Charge",
            reason: adaptive.plan?.reason ?? "Charging is planned during a discounted period.",
            at: upcomingAdaptiveSlot.start,
            endAt: upcomingAdaptiveSlot.end,
            targetSocPercent: finiteNumberOrNull(upcomingAdaptiveSlot.targetSocPercent),
            confidence: forecastConfidence,
            href: "/automation",
          }
        : nextSchedule
          ? {
              title: nextSchedule.schedule.name,
              reason: `${nextSchedule.schedule.action} is the next enabled battery schedule.`,
              at: nextSchedule.at,
              targetSocPercent: null,
              confidence: null,
              href: "/battery/schedules",
            }
          : {
              title: config.adaptiveCharging?.enabled ? "No grid charging currently planned" : "No application action scheduled",
              reason: adaptive.plan?.reason ?? "The battery remains under its current strategy until conditions change.",
              at: null,
              targetSocPercent: null,
              confidence: config.adaptiveCharging?.enabled ? forecastConfidence : null,
              href: config.adaptiveCharging?.enabled ? "/automation" : "/battery/schedules",
            };
    return {
      ...strategy,
      manualOverride: manualDirect || manualProfile || paused ? {
        active: true,
        label: manualDirect ? `${recentTerminal.action} override` : manualProfile ? `${recentTerminal.request?.mode ?? "Profile"} override` : "Manual override",
        until: paused ? adaptive.pausedUntil : null,
        untilChanged: !paused,
      } : { active: false },
      nextSchedule: nextSchedule ? { id: nextSchedule.schedule.id, name: nextSchedule.schedule.name, action: nextSchedule.schedule.action, at: nextSchedule.at } : null,
      nextAction,
    } satisfies BatteryStrategy;
  };
}
