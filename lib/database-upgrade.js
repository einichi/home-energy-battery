import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";

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

export function databaseBackupFilename(sourceVersion, targetVersion, now = new Date()) {
  return `history-v${sourceVersion}-before-v${targetVersion}-${timestampForFilename(now)}.sqlite.zst`;
}

export async function backupDatabaseBeforeUpgrade({
  databaseFile,
  backupDir,
  sourceVersion,
  targetVersion,
  onProgress = () => {},
  now = new Date(),
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

  const baseFilename = databaseBackupFilename(sourceVersion, targetVersion, now);
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
      targetVersion,
      sourceBytes,
      compressedBytes: backupStat.size,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await cleanupSnapshotFiles(snapshotFile);
    await rm(partialFile, { force: true });
  }
}
