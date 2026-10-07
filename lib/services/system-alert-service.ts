import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BatterySchedule } from "../contracts/schedules.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import { adaptiveChargingConfiguredActive } from "../domain/adaptive-control.js";

interface StatusErrorEntry { error?: unknown }
export interface SystemStatusSnapshot extends Record<string, unknown> {
  read_at?: string;
  energy?: {
    error?: unknown;
    battery?: { error?: unknown; configured?: boolean };
    solar?: { error?: unknown };
    fuel_cells?: StatusErrorEntry[];
    errors?: StatusErrorEntry[];
  };
  meter?: { error?: unknown; errors?: StatusErrorEntry[] };
}

interface SystemAlertInput {
  id: string;
  source: string;
  severity: "critical" | "warning" | "info";
  title: string;
  startedAt: string;
  impact: string;
  suggestedAction: string;
  href: string;
}
export interface SystemAlert extends SystemAlertInput { resolution: "active" }

interface CommandReceipt {
  commandId: string;
  state: string;
  action: string;
  requestedAt?: string | null;
  completedAt?: string | null;
  error?: unknown;
  message?: unknown;
}

interface NotificationView {
  deliveries?: Array<{
    ok?: boolean;
    at?: string;
    attempts?: Array<{ error?: string }>;
  }>;
}

interface DatabaseOperation {
  busy: boolean;
  error?: string | null;
  startedAt?: string | null;
}

interface AdaptiveChargingView {
  paused?: boolean;
  available?: boolean;
  reason?: unknown;
}

export interface SystemAlertDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readAdaptiveChargingState(): Promise<AdaptiveChargingState>;
  readAutomationRules(): Promise<AutomationRule[]>;
  readSchedules(): Promise<BatterySchedule[]>;
  notificationView(): Promise<NotificationView>;
  adaptiveChargingView(config: ApplicationConfig, state: AdaptiveChargingState, rules: AutomationRule[], now?: Date): AdaptiveChargingView;
  readCommandReceipts(limit: number, beforeMs: number): CommandReceipt[];
  getDatabaseOperation(): DatabaseOperation;
}

export function createSystemAlertService(dependencies: SystemAlertDependencies) {
  return async function view(snapshot: SystemStatusSnapshot, now: Date = new Date()): Promise<SystemAlert[]> {
    const [config, adaptiveState, rules, schedules, notifications] = await Promise.all([
      dependencies.readConfig(),
      dependencies.readAdaptiveChargingState(),
      dependencies.readAutomationRules(),
      dependencies.readSchedules(),
      dependencies.notificationView(),
    ]);
    const alerts: SystemAlert[] = [];
    const add = (alert: SystemAlertInput) => alerts.push({ resolution: "active", ...alert });
    const equipmentErrors = [
      snapshot.energy?.error,
      snapshot.energy?.battery?.error,
      snapshot.energy?.solar?.error,
      ...(snapshot.energy?.fuel_cells ?? []).map((item) => item.error),
      ...(snapshot.energy?.errors ?? []).map((item) => item.error),
      snapshot.meter?.error,
      ...(snapshot.meter?.errors ?? []).map((item) => item.error),
    ].filter(Boolean);
    if (equipmentErrors.length) add({
      id: "equipment",
      source: equipmentErrors.some((error) => /timeout|unreachable|network|EHOST|ENET/i.test(String(error))) ? "Local network" : "Device",
      severity: "warning",
      title: `${equipmentErrors.length} equipment issue${equipmentErrors.length === 1 ? "" : "s"}`,
      startedAt: snapshot.read_at ?? now.toISOString(),
      impact: String(equipmentErrors[0]),
      suggestedAction: "Inspect configured equipment and its latest contact status.",
      href: "/system/equipment",
    });
    if (snapshot.energy?.battery?.configured === false) add({
      id: "battery-configuration", source: "Configuration", severity: "warning", title: "Battery configuration incomplete",
      startedAt: snapshot.read_at ?? now.toISOString(),
      impact: "Battery state and controls are unavailable until equipment is configured.",
      suggestedAction: "Review the battery address and installed-equipment settings.", href: "/system/equipment",
    });
    const adaptive = dependencies.adaptiveChargingView(config, adaptiveState, rules, now);
    if (config.adaptiveCharging?.enabled && adaptive.paused) add({
      id: "automation-paused", source: "Automation", severity: "warning", title: "Adaptive Charging paused",
      startedAt: adaptiveState.updatedAt ?? now.toISOString(), impact: String(adaptive.reason ?? "The active plan cannot currently control battery charging."),
      suggestedAction: "Review the active override and resume automation when appropriate.", href: "/automation",
    });
    else if (adaptiveChargingConfiguredActive(config) && !adaptive.available) add({
      id: "automation-degraded", source: /weather|forecast/i.test(String(adaptive.reason ?? "")) ? "Weather service" : "Automation",
      severity: "critical", title: "Adaptive Charging degraded", startedAt: adaptiveState.updatedAt ?? now.toISOString(),
      impact: String(adaptive.reason ?? "A safe charging plan cannot currently be produced."),
      suggestedAction: "Review prerequisites and forecast status.", href: "/automation",
    });
    const failedReceipt = dependencies.readCommandReceipts(25, now.getTime()).find((receipt) =>
      ["failed", "timed-out", "mismatched"].includes(receipt.state)
        && now.getTime() - new Date(receipt.completedAt ?? receipt.requestedAt ?? 0).getTime() <= 24 * 60 * 60_000,
    );
    if (failedReceipt) add({
      id: `command:${failedReceipt.commandId}`, source: "Battery command", severity: "critical", title: "Battery command needs review",
      startedAt: failedReceipt.completedAt ?? failedReceipt.requestedAt ?? now.toISOString(),
      impact: String(failedReceipt.error ?? failedReceipt.message ?? `${failedReceipt.action} did not complete successfully.`),
      suggestedAction: "Review the command receipt and current battery state before retrying.", href: "/battery",
    });
    const failedSchedule = schedules.filter((schedule) => schedule.lastResult?.ok === false && !schedule.lastResult?.skipped)
      .sort((left, right) => new Date(right.lastResult?.at ?? 0).getTime() - new Date(left.lastResult?.at ?? 0).getTime())[0];
    if (failedSchedule) add({
      id: `schedule:${failedSchedule.id}`, source: "Schedule", severity: "warning", title: `Schedule failed: ${failedSchedule.name}`,
      startedAt: failedSchedule.lastResult?.at ?? now.toISOString(),
      impact: failedSchedule.lastResult?.error ?? "The scheduled battery action did not complete.",
      suggestedAction: "Review the schedule result and command activity.", href: "/battery/schedules",
    });
    const failedDelivery = notifications.deliveries?.[0]?.ok === false ? notifications.deliveries[0] : null;
    if (failedDelivery) add({
      id: `notification:${failedDelivery.at ?? "latest"}`, source: "SMTP", severity: "warning", title: "Notification delivery failed",
      startedAt: failedDelivery.at ?? now.toISOString(),
      impact: failedDelivery.attempts?.find((attempt) => attempt.error)?.error ?? "A configured notification channel rejected the latest delivery.",
      suggestedAction: "Review SMTP configuration and recent delivery history.", href: "/system/notifications",
    });
    const databaseOperation = dependencies.getDatabaseOperation();
    if (databaseOperation.busy || databaseOperation.error) add({
      id: "database", source: "Application database", severity: databaseOperation.error ? "critical" : "warning",
      title: databaseOperation.busy ? "Database maintenance in progress" : "Database operation failed",
      startedAt: databaseOperation.startedAt ?? now.toISOString(),
      impact: databaseOperation.error ?? "Historical data administration is temporarily limiting application work.",
      suggestedAction: "Review database health, maintenance, and backup state.", href: "/system/data",
    });
    return alerts.sort((left, right) => {
      const rank: Record<SystemAlert["severity"], number> = { critical: 0, warning: 1, info: 2 };
      return rank[left.severity] - rank[right.severity]
        || new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
    });
  };
}
