import { getJson, sendJson } from "./client";
import type {
  BackupPreparation,
  BatteryAction,
  BatterySchedule,
  CommandOutcome,
  CommandReceipt,
} from "./contracts";

export type { BatteryAction };

export function runBatteryAction(action: BatteryAction, payload: Record<string, unknown>) {
  return sendJson<CommandOutcome>(`/api/device-actions/${action}`, "POST", payload);
}

export function startBatteryAction(action: BatteryAction, payload: Record<string, unknown>) {
  return sendJson<{ commandId: string; commandState: "requested" }>("/api/device-commands", "POST", { action, payload });
}

export function getDeviceCommand(commandId: string, signal?: AbortSignal) {
  return getJson<CommandReceipt>(`/api/device-commands/${encodeURIComponent(commandId)}`, signal);
}

export function getCommandReceipts(signal?: AbortSignal) {
  return getJson<{ receipts: CommandReceipt[] }>("/api/command-receipts?limit=25", signal);
}

export function getSchedules(signal?: AbortSignal) {
  return getJson<BatterySchedule[]>("/api/schedules", signal);
}

export function createSchedule(schedule: Omit<BatterySchedule, "id" | "lastResult">) {
  return sendJson<BatterySchedule>("/api/schedules", "POST", schedule);
}

export function updateSchedule(id: string, patch: Partial<BatterySchedule>) {
  return sendJson<BatterySchedule>(`/api/schedules/${encodeURIComponent(id)}`, "PATCH", patch);
}

export function deleteSchedule(id: string) {
  return sendJson<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, "DELETE");
}

export function getBackupPreparation(signal?: AbortSignal) {
  return getJson<BackupPreparation>("/api/backup-preparation", signal);
}

export function setBackupPreparation(active: boolean, allowDemandGuard = true) {
  return sendJson<BackupPreparation>(
    active ? "/api/backup-preparation/start" : "/api/backup-preparation/end",
    "POST",
    active ? { allowDemandGuard } : {},
  );
}
