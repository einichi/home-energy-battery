import { cleanAdaptiveChargingState } from "../domain/adaptive-state.js";

type AdaptiveChargingState = ReturnType<typeof cleanAdaptiveChargingState>;

export interface AdaptiveStateDocumentStore {
  readDocument(key: "adaptiveChargingState", fallback: Record<string, unknown>): Record<string, unknown>;
  writeDocument(key: "adaptiveChargingState", value: Record<string, unknown>): unknown;
}

export interface AdaptiveStateHistory {
  isReady(): boolean;
  recordEvent(event: Record<string, unknown>): unknown;
}

export interface AdaptiveStateServiceDependencies {
  documents: AdaptiveStateDocumentStore;
  history: AdaptiveStateHistory;
  synchronizeDeadline(state: AdaptiveChargingState): unknown;
  now?: () => Date;
}

export function createAdaptiveStateService({
  documents,
  history,
  synchronizeDeadline,
  now = () => new Date(),
}: AdaptiveStateServiceDependencies) {
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<AdaptiveChargingState> {
    return cleanAdaptiveChargingState(documents.readDocument("adaptiveChargingState", {}));
  }

  async function commit(state: AdaptiveChargingState): Promise<AdaptiveChargingState> {
    const current = await read();
    const expectedRevision = Math.max(0, Math.floor(Number(state?.revision) || 0));
    if (current.revision !== expectedRevision) {
      throw new Error(`stale Adaptive Charging state revision ${expectedRevision}; current revision is ${current.revision}`);
    }
    const cleaned = cleanAdaptiveChargingState({
      ...state,
      revision: expectedRevision + 1,
      updatedAt: now().toISOString(),
    });
    documents.writeDocument("adaptiveChargingState", cleaned);
    if (history.isReady()) {
      for (const entry of cleaned.log) {
        history.recordEvent({
          eventKey: `adaptiveCharging:log:${entry.at}:${entry.kind ?? "info"}:${entry.message}`,
          at: entry.at,
          category: "adaptiveCharging",
          type: entry.kind ?? "log",
          message: entry.message,
        });
      }
      for (const summary of cleaned.windowSummaries) {
        history.recordEvent({
          eventKey: `adaptiveCharging:window:${summary.key}`,
          at: summary.completedAt ?? summary.windowEnd,
          category: "adaptiveCharging",
          type: "window-summary",
          message: summary.reason,
          payload: summary,
        });
      }
    }
    synchronizeDeadline(cleaned);
    return cleaned;
  }

  function write(state: AdaptiveChargingState): Promise<AdaptiveChargingState> {
    const task = writeQueue.then(() => commit(state));
    writeQueue = task.catch(() => undefined);
    return task;
  }

  return { read, write };
}
