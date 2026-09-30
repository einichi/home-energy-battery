import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { ARCHITECTURE_VERSION, architectureVersionForDatabase, createApplicationStore } from "../application-store.js";
import {
  backupDatabaseManually,
  cleanupExtractedDatabaseBackup,
  deleteDatabaseBackup,
  extractAndValidateDatabaseBackup,
  listDatabaseBackups,
} from "../database-backup.js";
import { SCHEMA_VERSION, createHistoryStore } from "../history-store.js";

type ApplicationStore = ReturnType<typeof createApplicationStore>;
type HistoryStore = ReturnType<typeof createHistoryStore>;
type DatabaseOperationType = "backup" | "restore" | "delete" | null;

interface DatabaseOperation {
  busy: boolean;
  type: DatabaseOperationType;
  filename: string | null;
  phase: string;
  percent: number;
  processed: number;
  total: number;
  unit: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  result: unknown;
}

type DatabaseProgress = Partial<Pick<DatabaseOperation, "phase" | "percent" | "processed" | "total" | "unit">>;

export interface DatabaseAdministrationDependencies {
  applicationStore: ApplicationStore;
  historyStore: HistoryStore;
  backupDir: string;
  dataDir: string;
  createError: (status: number, message: string) => Error;
  logError: (label: string, error: unknown) => void;
  resetAfterRestore: () => void;
  startBackgroundProcesses: () => void;
  stopBackgroundProcesses: () => void;
  waitForWriters: () => Promise<void>;
}

const idleOperation = (): DatabaseOperation => ({
  busy: false,
  type: null,
  filename: null,
  phase: "idle",
  percent: 0,
  processed: 0,
  total: 0,
  unit: null,
  startedAt: null,
  completedAt: null,
  error: null,
  result: null,
});

export function createDatabaseAdministrationService(dependencies: DatabaseAdministrationDependencies) {
  let databaseOperation = idleOperation();


  function databaseOperationProgress(patch: Partial<DatabaseOperation>): void {
    Object.assign(databaseOperation, patch);
  }


  async function databaseBackupsView() {
    return {
      schemaVersion: SCHEMA_VERSION,
      operation: { ...databaseOperation },
      backups: await listDatabaseBackups({
        backupDir: dependencies.backupDir,
        currentVersion: SCHEMA_VERSION,
      }),
    };
  }


  async function withDatabaseOperation<T>(
    type: Exclude<DatabaseOperationType, null>,
    filename: string | null,
    operation: (progress: (patch: DatabaseProgress) => void) => Promise<T>,
  ): Promise<T> {
    if (databaseOperation.busy) {
      throw dependencies.createError(409, `Database ${databaseOperation.type} is already running`);
    }
    databaseOperation = {
      busy: true,
      type,
      filename: filename ?? null,
      phase: "preparing",
      percent: 0,
      processed: 0,
      total: 0,
      unit: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      result: null,
    };
    try {
      const result = await operation((progress) => databaseOperationProgress(progress));
      databaseOperationProgress({
        busy: false,
        phase: "complete",
        percent: 100,
        completedAt: new Date().toISOString(),
        result,
      });
      return result;
    } catch (error: unknown) {
      databaseOperationProgress({
        busy: false,
        phase: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        result: null,
      });
      throw error;
    }
  }


  async function manualDatabaseBackup() {
    return withDatabaseOperation("backup", null, async (onProgress) => {
      const result = await backupDatabaseManually({
        databaseFile: dependencies.historyStore.databaseFile,
        backupDir: dependencies.backupDir,
        sourceVersion: SCHEMA_VERSION,
        onProgress,
      });
      dependencies.historyStore.recordEvent({
        eventKey: `database:manual-backup:${result.filename}`,
        at: new Date().toISOString(),
        category: "database",
        type: "manual-backup",
        message: `Manual database backup created: ${result.filename}`,
        payload: {
          filename: result.filename,
          compressedBytes: result.compressedBytes,
          durationMs: result.durationMs,
          schemaVersion: SCHEMA_VERSION,
        },
      });
      return {
        filename: result.filename,
        compressedBytes: result.compressedBytes,
        durationMs: result.durationMs,
        schemaVersion: SCHEMA_VERSION,
      };
    });
  }


  async function compatibleBackup(filename: string) {
    if (path.basename(filename) !== filename || !filename.endsWith(".sqlite.zst")) {
      throw dependencies.createError(400, "Invalid database backup filename");
    }
    const backups = await listDatabaseBackups({
      backupDir: dependencies.backupDir,
      currentVersion: SCHEMA_VERSION,
    });
    const backup = backups.find((item) => item.filename === filename);
    if (!backup) throw dependencies.createError(404, "Database backup not found");
    if (!backup.compatible) {
      throw dependencies.createError(409, `Backup schema v${backup.schemaVersion ?? "unknown"} cannot be restored by application schema v${SCHEMA_VERSION}`);
    }
    return { ...backup, path: path.join(dependencies.backupDir, filename) };
  }


  async function restoreDatabaseBackup(filename: string) {
    const backup = await compatibleBackup(filename);
    return withDatabaseOperation("restore", filename, async (onProgress) => {
      let extracted: Awaited<ReturnType<typeof extractAndValidateDatabaseBackup>> | null = null;
      let originalMoved = false;
      let backgroundStopped = false;
      let databaseReady = true;
      const databaseFile = dependencies.historyStore.databaseFile;
      const originalFile = `${databaseFile}.restore-original-${randomUUID()}.tmp`;
      try {
        extracted = await extractAndValidateDatabaseBackup({
          backupFile: backup.path,
          workingDir: dependencies.dataDir,
          onProgress,
        });
        if (extracted.schemaVersion !== SCHEMA_VERSION) {
          throw dependencies.createError(409, `Backup contains schema v${extracted.schemaVersion}; application requires schema v${SCHEMA_VERSION}`);
        }
        const backupArchitectureVersion = architectureVersionForDatabase(extracted.snapshotFile);
        if (backupArchitectureVersion !== ARCHITECTURE_VERSION) {
          throw dependencies.createError(
            409,
            `Backup uses application architecture ${backupArchitectureVersion ?? "unversioned"}; version ${ARCHITECTURE_VERSION} is required`,
          );
        }

        onProgress({ phase: "safety-backup", percent: 0, processed: 0, total: 0, unit: null });
        const safetyBackup = await backupDatabaseManually({
          databaseFile,
          backupDir: dependencies.backupDir,
          sourceVersion: SCHEMA_VERSION,
          beforeRestore: true,
          onProgress(progress): void {
            onProgress({ ...progress, phase: `safety-${progress.phase}` });
          },
        });

        onProgress({ phase: "stopping", percent: 0, processed: 0, total: 0, unit: null });
        dependencies.stopBackgroundProcesses();
        backgroundStopped = true;
        await dependencies.waitForWriters();
        dependencies.applicationStore.close();
        dependencies.historyStore.close();
        databaseReady = false;
        await Promise.all([
          rm(`${databaseFile}-wal`, { force: true }),
          rm(`${databaseFile}-shm`, { force: true }),
        ]);

        onProgress({ phase: "restoring", percent: 50, processed: 1, total: 2, unit: "files" });
        await rename(databaseFile, originalFile);
        originalMoved = true;
        await rename(extracted.snapshotFile, databaseFile);
        extracted = null;
        await dependencies.historyStore.initialize();
        await dependencies.applicationStore.initialize();
        databaseReady = true;
        await rm(originalFile, { force: true });
        originalMoved = false;
        dependencies.resetAfterRestore();
        try {
          dependencies.historyStore.recordEvent({
            eventKey: `database:restore:${filename}:${new Date().toISOString()}`,
            at: new Date().toISOString(),
            category: "database",
            type: "manual-restore",
            message: `Database restored from ${filename}`,
            payload: {
              filename,
              schemaVersion: SCHEMA_VERSION,
              safetyBackupFilename: safetyBackup.filename,
            },
          });
        } catch (error: unknown) {
          dependencies.logError("database-restore-event", error);
        }
        onProgress({ phase: "restarting", percent: 100, processed: 2, total: 2, unit: "files" });
        return {
          filename,
          schemaVersion: SCHEMA_VERSION,
          safetyBackupFilename: safetyBackup.filename,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (originalMoved) {
          try {
            dependencies.applicationStore.close();
            dependencies.historyStore.close();
            databaseReady = false;
            await Promise.all([
              rm(databaseFile, { force: true }),
              rm(`${databaseFile}-wal`, { force: true }),
              rm(`${databaseFile}-shm`, { force: true }),
            ]);
            await rename(originalFile, databaseFile);
            originalMoved = false;
            await dependencies.historyStore.initialize();
            await dependencies.applicationStore.initialize();
            databaseReady = true;
            dependencies.resetAfterRestore();
          } catch (rollbackError: unknown) {
            dependencies.logError("database-restore-rollback", rollbackError);
            throw new AggregateError(
              [error, rollbackError],
              `${message}; database rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              { cause: rollbackError },
            );
          }
        } else if (!databaseReady) {
          try {
            await dependencies.historyStore.initialize();
            await dependencies.applicationStore.initialize();
            databaseReady = true;
            dependencies.resetAfterRestore();
          } catch (reopenError: unknown) {
            dependencies.logError("database-restore-reopen", reopenError);
            throw new AggregateError(
              [error, reopenError],
              `${message}; database reopen also failed: ${reopenError instanceof Error ? reopenError.message : String(reopenError)}`,
              { cause: reopenError },
            );
          }
        }
        throw error;
      } finally {
        if (extracted?.snapshotFile) await cleanupExtractedDatabaseBackup(extracted.snapshotFile);
        if (backgroundStopped && databaseReady) dependencies.startBackgroundProcesses();
      }
    });
  }


  async function removeDatabaseBackup(filename: string) {
    if (path.basename(filename) !== filename || !filename.endsWith(".sqlite.zst")) {
      throw dependencies.createError(400, "Invalid database backup filename");
    }
    const backups = await listDatabaseBackups({ backupDir: dependencies.backupDir, currentVersion: SCHEMA_VERSION });
    if (!backups.some((item) => item.filename === filename)) throw dependencies.createError(404, "Database backup not found");
    return withDatabaseOperation("delete", filename, async (onProgress) => {
      onProgress({ phase: "deleting", percent: 50, processed: 0, total: 1, unit: "files" });
      await deleteDatabaseBackup({ backupDir: dependencies.backupDir, filename });
      onProgress({ phase: "deleting", percent: 100, processed: 1, total: 1, unit: "files" });
      return { filename };
    });
  }

  return {
    backupsView: databaseBackupsView,
    createBackup: manualDatabaseBackup,
    getOperation: () => databaseOperation,
    removeBackup: removeDatabaseBackup,
    restoreBackup: restoreDatabaseBackup,
  };
}
