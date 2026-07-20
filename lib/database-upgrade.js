import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

const BACKUP_MARGIN_BYTES = 64 * 1024 * 1024;

function timestampForFilename(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function progressTransform(totalBytes, onProgress) {
  let processedBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      processedBytes += chunk.length;
      onProgress?.({ processedBytes, totalBytes });
      callback(null, chunk);
    },
  });
}

async function cleanupStaleBackupFiles(backupDir) {
  let entries = [];
  try {
    entries = await readdir(backupDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await Promise.all(entries
    .filter((name) => name.endsWith(".partial") || name.includes(".snapshot.tmp"))
    .map((name) => rm(path.join(backupDir, name), { force: true })));
}

async function cleanupSnapshotFiles(snapshotFile) {
  await Promise.all([
    snapshotFile,
    `${snapshotFile}-wal`,
    `${snapshotFile}-shm`,
    `${snapshotFile}-journal`,
  ].map((file) => rm(file, { force: true })));
}

async function cleanupStaleRestoreExtractions(workingDir) {
  let entries = [];
  try {
    entries = await readdir(workingDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await Promise.all(entries
    .filter((name) => name.startsWith(".restore-") && name.endsWith(".sqlite.tmp"))
    .map((name) => cleanupSnapshotFiles(path.join(workingDir, name))));
}

export function databaseBackupFilename(sourceVersion, targetVersion, now = new Date()) {
  return `history-v${sourceVersion}-before-v${targetVersion}-${timestampForFilename(now)}.sqlite.zst`;
}

export function manualDatabaseBackupFilename(sourceVersion, now = new Date()) {
  return `history-v${sourceVersion}-manual-${timestampForFilename(now)}.sqlite.zst`;
}

export function preRestoreDatabaseBackupFilename(sourceVersion, now = new Date()) {
  return `history-v${sourceVersion}-before-restore-${timestampForFilename(now)}.sqlite.zst`;
}

function backupTimestamp(value) {
  const match = String(value).match(/(\d{8}T\d{6}Z)(?:-\d+)?\.sqlite\.zst$/);
  if (!match) return null;
  const compact = match[1];
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function databaseBackupMetadata(filename, currentVersion = null) {
  const name = String(filename);
  const versionMatch = name.match(/^history-v(\d+)-/);
  const schemaVersion = versionMatch ? Number(versionMatch[1]) : null;
  const upgradeMatch = name.match(/^history-v\d+-before-v(\d+)-/);
  const kind = /-manual-/.test(name)
    ? "manual"
    : /-before-restore-/.test(name)
      ? "pre-restore"
      : upgradeMatch
        ? "pre-upgrade"
        : "unknown";
  return {
    filename: name,
    kind,
    schemaVersion,
    targetVersion: upgradeMatch ? Number(upgradeMatch[1]) : null,
    createdAt: backupTimestamp(name),
    compatible: Number.isInteger(schemaVersion) && schemaVersion === currentVersion,
  };
}

async function createDatabaseBackup({
  databaseFile,
  backupDir,
  sourceVersion,
  baseFilename,
  onProgress = () => {},
}) {
  const startedAt = Date.now();
  await mkdir(backupDir, { recursive: true });
  await cleanupStaleBackupFiles(backupDir);
  const sourceStat = await stat(databaseFile);
  let walBytes = 0;
  try {
    walBytes = (await stat(`${databaseFile}-wal`)).size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const sourceBytes = sourceStat.size + walBytes;
  const volume = await statfs(backupDir);
  const availableBytes = Number(volume.bavail) * Number(volume.bsize);
  const requiredBytes = sourceBytes * 2 + BACKUP_MARGIN_BYTES;
  if (availableBytes < requiredBytes) {
    const error = new Error(`Insufficient backup space: ${requiredBytes} bytes required, ${availableBytes} bytes available`);
    error.code = "INSUFFICIENT_BACKUP_SPACE";
    error.requiredBytes = requiredBytes;
    error.availableBytes = availableBytes;
    throw error;
  }

  let filename = baseFilename;
  let finalFile = path.join(backupDir, filename);
  for (let suffix = 2; ; suffix += 1) {
    try {
      await stat(finalFile);
      filename = baseFilename.replace(/\.sqlite\.zst$/, `-${suffix}.sqlite.zst`);
      finalFile = path.join(backupDir, filename);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  const partialFile = `${finalFile}.partial`;
  const snapshotFile = path.join(backupDir, `${filename}.snapshot.tmp`);
  try {
    const source = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      onProgress({ phase: "copying", percent: 0, processed: 0, total: 0 });
      await sqliteBackup(source, snapshotFile, {
        rate: 100,
        progress({ totalPages, remainingPages }) {
          const processed = Math.max(0, totalPages - remainingPages);
          onProgress({
            phase: "copying",
            percent: totalPages ? Math.round((processed / totalPages) * 100) : 0,
            processed,
            total: totalPages,
            unit: "pages",
          });
        },
      });
    } finally {
      source.close();
    }

    onProgress({ phase: "validating", percent: 100, processed: 1, total: 1 });
    const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
    try {
      const result = snapshot.prepare("PRAGMA quick_check").all();
      if (result.length !== 1 || result[0].quick_check !== "ok") {
        throw new Error(`SQLite backup validation failed: ${JSON.stringify(result)}`);
      }
    } finally {
      snapshot.close();
    }

    const snapshotStat = await stat(snapshotFile);
    onProgress({ phase: "compressing", percent: 0, processed: 0, total: snapshotStat.size, unit: "bytes" });
    await pipeline(
      createReadStream(snapshotFile),
      progressTransform(snapshotStat.size, ({ processedBytes, totalBytes }) => {
        onProgress({
          phase: "compressing",
          percent: totalBytes ? Math.round((processedBytes / totalBytes) * 100) : 0,
          processed: processedBytes,
          total: totalBytes,
          unit: "bytes",
        });
      }),
      createZstdCompress(),
      createWriteStream(partialFile, { flags: "wx" }),
    );
    await rename(partialFile, finalFile);
    const backupStat = await stat(finalFile);
    return {
      filename,
      path: finalFile,
      sourceVersion,
      sourceBytes,
      compressedBytes: backupStat.size,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await cleanupSnapshotFiles(snapshotFile);
    await rm(partialFile, { force: true });
  }
}

export async function backupDatabaseBeforeUpgrade({
  databaseFile,
  backupDir,
  sourceVersion,
  targetVersion,
  onProgress = () => {},
  now = new Date(),
}) {
  return {
    ...(await createDatabaseBackup({
      databaseFile,
      backupDir,
      sourceVersion,
      baseFilename: databaseBackupFilename(sourceVersion, targetVersion, now),
      onProgress,
    })),
    targetVersion,
    kind: "pre-upgrade",
  };
}

export async function backupDatabaseManually({
  databaseFile,
  backupDir,
  sourceVersion,
  onProgress = () => {},
  now = new Date(),
  beforeRestore = false,
}) {
  return {
    ...(await createDatabaseBackup({
      databaseFile,
      backupDir,
      sourceVersion,
      baseFilename: beforeRestore
        ? preRestoreDatabaseBackupFilename(sourceVersion, now)
        : manualDatabaseBackupFilename(sourceVersion, now),
      onProgress,
    })),
    targetVersion: null,
    kind: beforeRestore ? "pre-restore" : "manual",
  };
}

export async function listDatabaseBackups({ backupDir, currentVersion }) {
  await mkdir(backupDir, { recursive: true });
  const backups = [];
  for (const filename of await readdir(backupDir)) {
    if (!filename.endsWith(".sqlite.zst")) continue;
    const file = path.join(backupDir, filename);
    const fileStat = await lstat(file);
    if (!fileStat.isFile()) continue;
    backups.push({
      ...databaseBackupMetadata(filename, currentVersion),
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }
  return backups.sort((a, b) => (
    new Date(b.createdAt ?? b.modifiedAt).getTime() - new Date(a.createdAt ?? a.modifiedAt).getTime()
  ));
}

export async function extractAndValidateDatabaseBackup({
  backupFile,
  workingDir,
  onProgress = () => {},
}) {
  await mkdir(workingDir, { recursive: true });
  await cleanupStaleRestoreExtractions(workingDir);
  const sourceStat = await stat(backupFile);
  const snapshotFile = path.join(workingDir, `.restore-${randomUUID()}.sqlite.tmp`);
  try {
    onProgress({ phase: "decompressing", percent: 0, processed: 0, total: sourceStat.size, unit: "bytes" });
    await pipeline(
      createReadStream(backupFile),
      progressTransform(sourceStat.size, ({ processedBytes, totalBytes }) => {
        onProgress({
          phase: "decompressing",
          percent: totalBytes ? Math.round((processedBytes / totalBytes) * 100) : 0,
          processed: processedBytes,
          total: totalBytes,
          unit: "bytes",
        });
      }),
      createZstdDecompress(),
      createWriteStream(snapshotFile, { flags: "wx" }),
    );
    onProgress({ phase: "validating", percent: 100, processed: 1, total: 1, unit: "checks" });
    const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
    try {
      const quickCheck = snapshot.prepare("PRAGMA quick_check").all();
      if (quickCheck.length !== 1 || quickCheck[0].quick_check !== "ok") {
        throw new Error(`SQLite backup validation failed: ${JSON.stringify(quickCheck)}`);
      }
      const metadataTable = snapshot.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
      ).get();
      const row = metadataTable
        ? snapshot.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get()
        : null;
      const schemaVersion = row ? JSON.parse(row.value) : null;
      if (!Number.isInteger(schemaVersion)) throw new Error("Backup schema version metadata is missing or invalid");
      return { snapshotFile, schemaVersion, sizeBytes: (await stat(snapshotFile)).size };
    } finally {
      snapshot.close();
    }
  } catch (error) {
    await cleanupSnapshotFiles(snapshotFile);
    throw error;
  }
}

export async function deleteDatabaseBackup({ backupDir, filename }) {
  if (path.basename(filename) !== filename || !filename.endsWith(".sqlite.zst")) {
    throw new Error("Invalid database backup filename");
  }
  const backupFile = path.join(backupDir, filename);
  await rm(backupFile);
  return { filename };
}

export async function cleanupExtractedDatabaseBackup(snapshotFile) {
  await cleanupSnapshotFiles(snapshotFile);
}
