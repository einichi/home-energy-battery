import type { DatabaseSync } from "node:sqlite";

export interface EventInput {
  eventKey: string;
  at?: string;
  category: string;
  type?: string;
  message?: string | null;
  payload?: unknown;
}

export interface StoredEvent {
  eventKey?: string;
  at: string;
  type: string;
  message: string | null;
  payload: unknown;
}

interface EventRow {
  id?: unknown;
  event_key?: unknown;
  timestamp?: unknown;
  type?: unknown;
  message?: unknown;
  payload_json?: unknown;
}

interface EventRepositoryDependencies {
  database(): DatabaseSync;
  timestampMs(value: unknown): number | null;
  parseJson(value: unknown): unknown;
}

function eventView(row: EventRow, includeKey: boolean): StoredEvent {
  return {
    ...(includeKey ? { eventKey: String(row.event_key ?? "") } : {}),
    at: String(row.timestamp ?? ""),
    type: String(row.type ?? "event"),
    message: row.message === null || row.message === undefined ? null : String(row.message),
    payload: row.payload_json ? row.payload_json : null,
  };
}

export function createEventRepository(dependencies: EventRepositoryDependencies) {
  function decodeEvent(row: EventRow, includeKey: boolean): StoredEvent {
    const view = eventView(row, includeKey);
    return {
      ...view,
      payload: row.payload_json ? dependencies.parseJson(row.payload_json) : null,
    };
  }

  function recordEvent({ eventKey, at, category, type = "event", message = null, payload = null }: EventInput): boolean {
    const timestamp = at ?? new Date().toISOString();
    const timeMs = dependencies.timestampMs(timestamp);
    if (timeMs === null || !eventKey) return false;
    const result = dependencies.database().prepare(`
      INSERT OR IGNORE INTO events(event_key, timestamp_ms, timestamp, category, type, message, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventKey, timeMs, timestamp, category, type, message, payload === null ? null : JSON.stringify(payload));
    return Number(result.changes) > 0;
  }

  function eventsBetween(category: string, startMs: number, endMs: number, types: string[] = []): StoredEvent[] {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
    const normalizedTypes = types.filter(Boolean).map(String);
    const typeClause = normalizedTypes.length
      ? ` AND type IN (${normalizedTypes.map(() => "?").join(", ")})`
      : "";
    const rows = dependencies.database().prepare(`
      SELECT timestamp, type, message, payload_json FROM events
      WHERE category = ? AND timestamp_ms >= ? AND timestamp_ms <= ?${typeClause}
      ORDER BY timestamp_ms, id
    `).all(category, startMs, endMs, ...normalizedTypes) as EventRow[];
    return rows.map((row) => decodeEvent(row, false));
  }

  function recentEvents(category: string, limit = 50, beforeMs = Date.now()): StoredEvent[] {
    const normalizedLimit = Math.max(1, Math.min(250, Math.floor(Number(limit) || 50)));
    const normalizedBeforeMs = Number.isFinite(Number(beforeMs)) ? Number(beforeMs) : Date.now();
    const rows = dependencies.database().prepare(`
      SELECT event_key, timestamp, type, message, payload_json FROM events
      WHERE category = ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms DESC, id DESC
      LIMIT ?
    `).all(category, normalizedBeforeMs, normalizedLimit) as EventRow[];
    return rows.map((row) => decodeEvent(row, true));
  }

  function eventsByKeyPrefix(prefix: string): StoredEvent[] {
    if (!prefix) return [];
    const rows = dependencies.database().prepare(`
      SELECT event_key, timestamp, type, message, payload_json FROM events
      WHERE event_key LIKE ?
      ORDER BY timestamp_ms, id
    `).all(`${prefix}%`) as EventRow[];
    return rows.map((row) => decodeEvent(row, true));
  }

  function tagEventsBefore(category: string, before: Date | string | number, fields: Record<string, unknown> = {}): number {
    const beforeMs = dependencies.timestampMs(before);
    if (beforeMs === null) return 0;
    const rows = dependencies.database().prepare(`
      SELECT id, payload_json FROM events WHERE category = ? AND timestamp_ms < ?
    `).all(category, beforeMs) as EventRow[];
    const update = dependencies.database().prepare("UPDATE events SET payload_json = ? WHERE id = ?");
    let changed = 0;
    dependencies.database().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const decoded = row.payload_json ? dependencies.parseJson(row.payload_json) : {};
        const payload = decoded !== null && typeof decoded === "object"
          ? decoded as Record<string, unknown>
          : {};
        if (Object.keys(fields).every((key) => payload[key] !== undefined)) continue;
        update.run(JSON.stringify({ ...payload, ...fields }), Number(row.id));
        changed += 1;
      }
      dependencies.database().exec("COMMIT");
    } catch (error: unknown) {
      dependencies.database().exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  return { eventsBetween, eventsByKeyPrefix, recentEvents, recordEvent, tagEventsBefore };
}
