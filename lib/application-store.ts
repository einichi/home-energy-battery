import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const ARCHITECTURE_VERSION = 1;

export const APPLICATION_DOCUMENTS = Object.freeze({
  config: "object",
  schedules: "array",
  automationRules: "array",
  automationRuleState: "object",
  adaptiveChargingState: "object",
  operationalOverrides: "object",
  notificationState: "object",
});

export type ApplicationDocumentKey = keyof typeof APPLICATION_DOCUMENTS;
export type ApplicationDocument = Record<string, unknown> | unknown[];
export type ArchitectureStatus = {
  architectureVersion: number | null;
  state: string;
  [key: string]: unknown;
};

function validateDocument(key: ApplicationDocumentKey, value: unknown): asserts value is ApplicationDocument {
  const kind = APPLICATION_DOCUMENTS[key];
  if (!kind) throw new Error(`Unknown application document: ${key}`);
  const valid = kind === "array"
    ? Array.isArray(value)
    : value !== null && typeof value === "object" && !Array.isArray(value);
  if (!valid) throw new Error(`Application document ${key} must contain a JSON ${kind}`);
}

function readMetadata<T>(database: DatabaseSync, key: string, fallback: T): T {
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(String(row.value)) as T;
  } catch {
    return fallback;
  }
}

export function architectureVersionForDatabase(databaseFile: string): number | null {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
    return table ? readMetadata<number | null>(database, "architectureVersion", null) : null;
  } finally {
    database.close();
  }
}

export function createApplicationStore({ dataDir }: { dataDir: string }) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const databaseFile = path.join(dataDir, "history.sqlite");
  let database: DatabaseSync | null = null;
  let runtimeStatus: ArchitectureStatus | null = null;

  function requireDatabase() {
    if (!database) throw new Error("Application store is not initialized");
    return database;
  }

  function readDocument<T = undefined>(key: ApplicationDocumentKey, fallback?: T): ApplicationDocument | T | undefined {
    if (!Object.hasOwn(APPLICATION_DOCUMENTS, key)) throw new Error(`Unknown application document: ${key}`);
    const row = requireDatabase().prepare("SELECT payload_json FROM application_documents WHERE key = ?").get(key) as { payload_json?: unknown } | undefined;
    if (!row) return fallback;
    const value: unknown = JSON.parse(String(row.payload_json));
    validateDocument(key, value);
    return value;
  }

  function writeDocument<T extends ApplicationDocument>(key: ApplicationDocumentKey, value: T): T {
    validateDocument(key, value);
    requireDatabase().prepare(`
      INSERT INTO application_documents(key, payload_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
    return value;
  }

  function validateCurrent() {
    const db = requireDatabase();
    const version = readMetadata<number | null>(db, "architectureVersion", null);
    if (version !== ARCHITECTURE_VERSION) {
      throw new Error(
        `Application architecture ${version ?? "unversioned"} is incompatible; version ${ARCHITECTURE_VERSION} is required. Run the bridge release first.`,
      );
    }
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'application_documents'",
    ).get();
    if (!table) throw new Error("Application document storage is missing. Run the bridge release first.");
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0]?.quick_check !== "ok") {
      throw new Error(`Application database validation failed: ${JSON.stringify(check)}`);
    }
    for (const key of Object.keys(APPLICATION_DOCUMENTS) as ApplicationDocumentKey[]) {
      const value = readDocument(key, undefined);
      if (value !== undefined) validateDocument(key, value);
    }
    return true;
  }

  async function initialize(): Promise<ArchitectureStatus> {
    if (database && runtimeStatus) return runtimeStatus;
    database = new DatabaseSync(databaseFile);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try {
      validateCurrent();
    } catch (error) {
      close();
      throw error;
    }
    runtimeStatus = readMetadata<ArchitectureStatus | null>(database, "architectureMigration", null) ?? {
      architectureVersion: ARCHITECTURE_VERSION,
      state: "current",
    };
    return runtimeStatus;
  }

  function status(): ArchitectureStatus {
    return runtimeStatus ?? { architectureVersion: null, state: "not-initialized" };
  }

  function close() {
    if (!database) return;
    database.close();
    database = null;
    runtimeStatus = null;
  }

  return {
    close,
    databaseFile,
    initialize,
    isReady: () => database !== null,
    readDocument,
    status,
    validateCurrent,
    writeDocument,
  };
}
