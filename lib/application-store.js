import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

export const ARCHITECTURE_VERSION = 1;

export const APPLICATION_DOCUMENTS = Object.freeze({
  config: { filename: "config.json", kind: "object" },
  schedules: { filename: "schedules.json", kind: "array" },
  automationRules: { filename: "automation-rules.json", kind: "array" },
  automationRuleState: { filename: "automation-rule-state.json", kind: "object" },
  adaptiveChargingState: { filename: "adaptive-charging-state.json", kind: "object" },
  operationalOverrides: { filename: "operational-overrides.json", kind: "object" },
  notificationState: { filename: "notification-state.json", kind: "object" },
});

const SQLITE_FILES = new Set(["history.sqlite", "history.sqlite-wal", "history.sqlite-shm"]);

function parseLatestJsonDocument(text, filename) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const starts = [];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "{" || text[index] === "[") starts.push(index);
    }
    for (const start of starts.reverse()) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // Keep looking for the last complete document. Older state writers could
        // leave concatenated JSON after an interrupted write.
      }
    }
    throw new Error(`Failed to parse bridge source ${filename}: ${cause.message}`, { cause });
  }
}

function validateDocument(key, value, kind) {
  const valid = kind === "array"
    ? Array.isArray(value)
    : value !== null && typeof value === "object" && !Array.isArray(value);
  if (!valid) throw new Error(`Bridge source ${APPLICATION_DOCUMENTS[key].filename} must contain a JSON ${kind}`);
}

function compactTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function fileInventory(root, relative = "") {
  const directory = path.join(root, relative);
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    if (entry.isDirectory()) rows.push(...await fileInventory(root, childRelative));
    else if (entry.isFile()) {
      const contents = await readFile(child);
      rows.push({
        path: childRelative,
        bytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotDataDirectory({ dataDir, databaseFile, architectureVersion, now = new Date() }) {
  const backupRoot = path.join(dataDir, "backups");
  await mkdir(backupRoot, { recursive: true });
  const baseName = `architecture-v${architectureVersion}-before-${compactTimestamp(now)}`;
  let finalDirectory = path.join(backupRoot, baseName);
  for (let suffix = 2; ; suffix += 1) {
    try {
      await stat(finalDirectory);
      finalDirectory = path.join(backupRoot, `${baseName}-${suffix}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  const temporaryName = `.${path.basename(finalDirectory)}.partial`;
  const temporaryDirectory = path.join(dataDir, temporaryName);
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    for (const entry of await readdir(dataDir, { withFileTypes: true })) {
      if (entry.name === temporaryName || SQLITE_FILES.has(entry.name) || entry.name.startsWith(".architecture-")) continue;
      await cp(path.join(dataDir, entry.name), path.join(temporaryDirectory, entry.name), {
        recursive: entry.isDirectory(),
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }

    try {
      await stat(databaseFile);
      const source = new DatabaseSync(databaseFile, { readOnly: true });
      const snapshotFile = path.join(temporaryDirectory, "history.sqlite");
      try {
        await sqliteBackup(source, snapshotFile);
      } finally {
        source.close();
      }
      const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
      try {
        const check = snapshot.prepare("PRAGMA quick_check").all();
        if (check.length !== 1 || check[0].quick_check !== "ok") {
          throw new Error(`Bridge snapshot database validation failed: ${JSON.stringify(check)}`);
        }
      } finally {
        snapshot.close();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const files = await fileInventory(temporaryDirectory);
    const manifest = {
      kind: "architecture-bridge",
      architectureVersion,
      createdAt: now.toISOString(),
      sourceDataDirectory: dataDir,
      files,
    };
    await writeFile(path.join(temporaryDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryDirectory, finalDirectory);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function readBridgeSources(dataDir) {
  const documents = new Map();
  for (const [key, definition] of Object.entries(APPLICATION_DOCUMENTS)) {
    const file = path.join(dataDir, definition.filename);
    try {
      const value = parseLatestJsonDocument(await readFile(file, "utf8"), definition.filename);
      validateDocument(key, value, definition.kind);
      documents.set(key, value);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return documents;
}

function readMetadata(database, key, fallback = null) {
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function tableCountAndRange(database, table, timestampColumn = null) {
  const exists = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return { count: 0, earliest: null, latest: null };
  if (!timestampColumn) {
    return { count: Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), earliest: null, latest: null };
  }
  const row = database.prepare(`
    SELECT COUNT(*) AS count, MIN(${timestampColumn}) AS earliest, MAX(${timestampColumn}) AS latest FROM ${table}
  `).get();
  return { count: Number(row.count), earliest: row.earliest ?? null, latest: row.latest ?? null };
}

export function architectureVersionForDatabase(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
    return table ? readMetadata(database, "architectureVersion") : null;
  } finally {
    database.close();
  }
}

export function createApplicationStore({ dataDir, logger = console } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const databaseFile = path.join(dataDir, "history.sqlite");
  let database = null;
  let migration = null;

  function requireDatabase() {
    if (!database) throw new Error("Application store is not initialized");
    return database;
  }

  function createSchema() {
    requireDatabase().exec(`
      CREATE TABLE IF NOT EXISTS application_documents (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  function readDocument(key, fallback = undefined) {
    if (!Object.hasOwn(APPLICATION_DOCUMENTS, key)) throw new Error(`Unknown application document: ${key}`);
    const row = requireDatabase().prepare("SELECT payload_json FROM application_documents WHERE key = ?").get(key);
    if (!row) return fallback;
    return JSON.parse(row.payload_json);
  }

  function writeDocument(key, value) {
    if (!Object.hasOwn(APPLICATION_DOCUMENTS, key)) throw new Error(`Unknown application document: ${key}`);
    validateDocument(key, value, APPLICATION_DOCUMENTS[key].kind);
    const updatedAt = new Date().toISOString();
    requireDatabase().prepare(`
      INSERT INTO application_documents(key, payload_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), updatedAt);
    return value;
  }

  function validateCurrent() {
    const db = requireDatabase();
    const version = readMetadata(db, "architectureVersion");
    if (version !== ARCHITECTURE_VERSION) {
      throw new Error(`Application architecture ${version ?? "unversioned"} is not ready for version ${ARCHITECTURE_VERSION}`);
    }
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0].quick_check !== "ok") {
      throw new Error(`Application database validation failed: ${JSON.stringify(check)}`);
    }
    for (const [key, definition] of Object.entries(APPLICATION_DOCUMENTS)) {
      const value = readDocument(key, undefined);
      if (value !== undefined) validateDocument(key, value, definition.kind);
    }
    return true;
  }

  async function initializeBridge() {
    if (database) return migration;
    await mkdir(dataDir, { recursive: true });
    database = new DatabaseSync(databaseFile);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    createSchema();

    const existingVersion = readMetadata(database, "architectureVersion");
    if (existingVersion !== null && existingVersion !== ARCHITECTURE_VERSION) {
      close();
      throw new Error(`Unsupported application architecture version ${existingVersion}; expected ${ARCHITECTURE_VERSION}`);
    }
    if (existingVersion === ARCHITECTURE_VERSION) {
      validateCurrent();
      migration = readMetadata(database, "architectureMigration", {
        architectureVersion: ARCHITECTURE_VERSION,
        state: "current",
      });
      return migration;
    }

    const historyBefore = tableCountAndRange(database, "samples", "timestamp");
    const eventsBefore = tableCountAndRange(database, "events", "timestamp");
    const backup = await snapshotDataDirectory({ dataDir, databaseFile, architectureVersion: ARCHITECTURE_VERSION });
    const sources = await readBridgeSources(dataDir);
    const migratedAt = new Date().toISOString();
    const itemCounts = Object.fromEntries([...sources].map(([key, value]) => [
      key,
      Array.isArray(value) ? value.length : Object.keys(value).length,
    ]));
    const migrationRecord = {
      architectureVersion: ARCHITECTURE_VERSION,
      state: "complete",
      migratedAt,
      sourceDocuments: [...sources.keys()],
      backupDirectory: path.basename(backup.directory),
      validation: {
        state: "passed",
        database: "ok",
        history: historyBefore,
        events: eventsBefore,
        itemCounts,
        secretsBackedUp: backup.manifest.files.some((file) => file.path === "notification-secrets.json"),
      },
    };

    database.exec("BEGIN IMMEDIATE");
    try {
      const insert = database.prepare(`
        INSERT INTO application_documents(key, payload_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `);
      for (const [key, value] of sources) insert.run(key, JSON.stringify(value), migratedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    for (const [key, source] of sources) {
      if (JSON.stringify(readDocument(key)) !== JSON.stringify(source)) {
        throw new Error(`Bridge validation failed for ${APPLICATION_DOCUMENTS[key].filename}`);
      }
    }
    const historyAfter = tableCountAndRange(database, "samples", "timestamp");
    const eventsAfter = tableCountAndRange(database, "events", "timestamp");
    if (JSON.stringify(historyAfter) !== JSON.stringify(historyBefore) || JSON.stringify(eventsAfter) !== JSON.stringify(eventsBefore)) {
      throw new Error("Bridge validation failed because history or event row ranges changed");
    }
    const check = database.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0].quick_check !== "ok") {
      throw new Error(`Bridge database validation failed: ${JSON.stringify(check)}`);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const metadata = database.prepare(`
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      metadata.run("architectureVersion", JSON.stringify(ARCHITECTURE_VERSION));
      metadata.run("architectureMigration", JSON.stringify(migrationRecord));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    validateCurrent();
    migration = migrationRecord;
    logger.info?.(`architecture bridge: migrated ${sources.size} application documents to SQLite; backup=${backup?.directory ?? "not required"}`);
    return migration;
  }

  function status() {
    if (!database) return { architectureVersion: null, state: "not-initialized" };
    return migration ?? {
      architectureVersion: readMetadata(database, "architectureVersion"),
      state: "current",
    };
  }

  function close() {
    if (!database) return;
    database.close();
    database = null;
  }

  return {
    close,
    databaseFile,
    initializeBridge,
    isReady: () => database !== null,
    readDocument,
    status,
    validateCurrent,
    writeDocument,
  };
}
