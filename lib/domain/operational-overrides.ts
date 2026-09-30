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

type UnknownRecord = Record<string, unknown>;
const BACKUP_PREPARATION_LOG_LIMIT = 50;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function profile(value: unknown): BatteryProfile | null {
  return value === "osaifu" || value === "eco" || value === "backup" ? value : null;
}

export function cleanOperationalOverridesState(value: unknown = {}): OperationalOverridesState {
  const input = record(value);
  const backup = record(input.backupPreparation);
  const phase: BackupPreparationPhase = backup.phase === "starting" || backup.phase === "active" || backup.phase === "ending"
    ? backup.phase
    : backup.active === true ? "active" : "inactive";
  const log = (Array.isArray(input.log) ? input.log : [])
    .map(record)
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
      lastResult: Object.keys(record(backup.lastResult)).length ? record(backup.lastResult) : null,
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
  return record(record(value).backupPreparation).active === true;
}

export function backupPreparationAllowsActionSource(value: unknown, source: string): boolean {
  if (!backupPreparationBlocksActions(value)) return true;
  if (source === "backup-preparation") return true;
  return source === "charging-demand-guard"
    && record(record(value).backupPreparation).allowDemandGuard !== false;
}

export function backupPreparationView(value: unknown): OperationalOverridesState["backupPreparation"] & { log: BackupPreparationLogEntry[] } {
  const state = cleanOperationalOverridesState(value);
  return { ...state.backupPreparation, log: [...state.log].reverse() };
}
