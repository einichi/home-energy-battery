import { asRecord } from "../domain/values.js";

type UnknownRecord = Record<string, unknown>;

export interface CommandEvent extends UnknownRecord {
  type: string;
  at: string;
  message?: unknown;
  payload: UnknownRecord;
}

export interface CommandEventRepository {
  recentEvents(category: string, limit: number, beforeMs: number): unknown[];
  eventsByKeyPrefix(prefix: string): unknown[];
}

function event(value: unknown): CommandEvent {
  const source = asRecord(value);
  return { ...source, type: String(source.type ?? "event"), at: String(source.at ?? ""), payload: asRecord(source.payload) } as CommandEvent;
}

function receiptFromEvents(commandId: string, events: CommandEvent[]) {
  if (!events.length) return null;
  const ordered = [...events].reverse();
  const latest = ordered[0]!;
  const requested = events.find((item) => item.type === "requested");
  const terminal = ordered.find((item) => ["succeeded", "failed", "timed-out", "mismatched"].includes(item.type));
  return {
    commandId,
    action: String(latest.payload.action ?? requested?.payload.action ?? "unknown"),
    source: String(latest.payload.source ?? requested?.payload.source ?? "unknown"),
    target: latest.payload.target ?? requested?.payload.target ?? null,
    request: asRecord(latest.payload.request ?? requested?.payload.request),
    state: latest.type,
    requestedAt: requested?.at ?? null,
    completedAt: terminal?.at ?? null,
    message: latest.message,
    error: terminal?.payload.error ?? null,
    verification: terminal?.payload.verification ?? null,
    durationMs: terminal?.payload.durationMs ?? null,
    events: ordered,
  };
}

export function createCommandReceiptService(repository: CommandEventRepository) {
  function list(limit: unknown = 25, beforeMs = Date.now()) {
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 25)));
    const events = repository.recentEvents("command", Math.min(250, normalizedLimit * 8), beforeMs).map(event);
    const grouped = new Map<string, CommandEvent[]>();
    for (const item of events) {
      const commandId = String(item.payload.commandId ?? "");
      if (!commandId) continue;
      const commandEvents = grouped.get(commandId) ?? [];
      commandEvents.push(item);
      grouped.set(commandId, commandEvents);
    }
    return [...grouped.entries()]
      .map(([commandId, commandEvents]) => receiptFromEvents(commandId, [...commandEvents].reverse()))
      .filter((receipt) => receipt !== null)
      .slice(0, normalizedLimit);
  }

  function read(commandId: string) {
    return receiptFromEvents(commandId, repository.eventsByKeyPrefix(`command:${commandId}:`).map(event));
  }

  return { list, read };
}
