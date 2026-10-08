import { asRecord } from "./values.js";

export type BatteryProfile = "osaifu" | "eco" | "backup";
export const BATTERY_PROFILES: ReadonlySet<string> = new Set<BatteryProfile>(["osaifu", "eco", "backup"]);

export type BackupPreparationPhase = "inactive" | "starting" | "active" | "ending";

export interface BackupPreparationLogEntry {
  at: string;
  message: string;
  kind: string;
}

export interface OperationalOverridesState {
  [key: string]: unknown;
  version: 1;
  backupPreparation: {
    active: boolean;
    phase: BackupPreparationPhase;
    allowDemandGuard: boolean;
    previousProfile: BatteryProfile | null;
    currentProfile: BatteryProfile | null;
    startedAt: string | null;
    endedAt: string | null;
    updatedAt: string | null;
    lastResult: Record<string, unknown> | null;
  };
  log: BackupPreparationLogEntry[];
}

const BACKUP_PREPARATION_LOG_LIMIT = 50;

function profile(value: unknown): BatteryProfile | null {
  return value === "osaifu" || value === "eco" || value === "backup" ? value : null;
}

export function cleanOperationalOverridesState(value: unknown = {}): OperationalOverridesState {
  const input = asRecord(value);
  const backup = asRecord(input.backupPreparation);
  const phase: BackupPreparationPhase = backup.phase === "starting" || backup.phase === "active" || backup.phase === "ending"
    ? backup.phase
    : backup.active === true ? "active" : "inactive";
  const log = (Array.isArray(input.log) ? input.log : [])
    .map(asRecord)
    .filter((entry) => typeof entry.at === "string" && typeof entry.message === "string")
    .map((entry): BackupPreparationLogEntry => ({
      at: String(entry.at),
      message: String(entry.message),
      kind: String(entry.kind ?? "info"),
    }))
    .slice(-BACKUP_PREPARATION_LOG_LIMIT);
  return {
    version: 1,
    backupPreparation: {
      active: phase !== "inactive",
      phase,
      allowDemandGuard: backup.allowDemandGuard !== false,
      previousProfile: profile(backup.previousProfile),
      currentProfile: profile(backup.currentProfile),
      startedAt: typeof backup.startedAt === "string" ? backup.startedAt : null,
      endedAt: typeof backup.endedAt === "string" ? backup.endedAt : null,
      updatedAt: typeof backup.updatedAt === "string" ? backup.updatedAt : null,
      lastResult: Object.keys(asRecord(backup.lastResult)).length ? asRecord(backup.lastResult) : null,
    },
    log,
  };
}

export function appendBackupPreparationLog(
  state: OperationalOverridesState,
  message: string,
  kind = "info",
  now: Date = new Date(),
): void {
  state.log = [...state.log, { at: now.toISOString(), message, kind }].slice(-BACKUP_PREPARATION_LOG_LIMIT);
}

export function backupPreparationBlocksActions(value: unknown): boolean {
  return asRecord(asRecord(value).backupPreparation).active === true;
}

export function backupPreparationAllowsActionSource(value: unknown, source: string): boolean {
  if (!backupPreparationBlocksActions(value)) return true;
  if (source === "backup-preparation") return true;
  return source === "charging-demand-guard"
    && asRecord(asRecord(value).backupPreparation).allowDemandGuard !== false;
}

export function backupPreparationView(value: unknown): OperationalOverridesState["backupPreparation"] & { log: BackupPreparationLogEntry[] } {
  const state = cleanOperationalOverridesState(value);
  return { ...state.backupPreparation, log: [...state.log].reverse() };
}
