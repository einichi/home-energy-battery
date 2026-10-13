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
  let controlQueue: Promise<unknown> = Promise.resolve();
  // Keep the exact base seen by each reader. A state write is a snapshot from
  // that revision; only fields changed since that base are overlaid on the
  // latest document. This preserves concurrent, unrelated state mutations.
  const snapshots = new Map<number, AdaptiveChargingState>();

  async function read(): Promise<AdaptiveChargingState> {
    const state = structuredClone(cleanAdaptiveChargingState(documents.readDocument("adaptiveChargingState", {})));
    snapshots.set(state.revision, structuredClone(state));
    while (snapshots.size > 256) snapshots.delete(snapshots.keys().next().value!);
    return state;
  }

  async function commit(state: AdaptiveChargingState): Promise<AdaptiveChargingState> {
    const base = snapshots.get(state.revision);
    const current = await read();
    if (!base) throw new Error("Adaptive state revision expired; re-read before retrying the mutation");
    const merged: Record<string, unknown> = { ...current };
    const operatorIntentChanged = current.pausedUntil !== base.pausedUntil;
    const controlFields = new Set([
      "owner", "activeSlot", "activePlanCreatedAt", "activeChargedKwh", "activeLastCheckedAt",
      "standbyHoldUntil", "activeChargeSession", "interruptedCharge", "breakerRecovery", "plan",
    ]);
    for (const key of Object.keys(state)) {
      if (key === "revision" || key === "updatedAt") continue;
      const incomingChanged = JSON.stringify(state[key]) !== JSON.stringify(base[key]);
      const currentChanged = JSON.stringify(current[key]) !== JSON.stringify(base[key]);
      if (!incomingChanged) continue;
      // Do not resurrect control decisions superseded by a manual pause, or
      // overwrite a newer mutation to the same field (especially Away requests).
      if (operatorIntentChanged && controlFields.has(key)) continue;
      if (!currentChanged) merged[key] = state[key];
      else if (key === "log") {
        const entries = [...current.log, ...state.log];
        merged.log = [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()]
          .sort((left, right) => left.at.localeCompare(right.at));
      }
    }
    const cleaned = cleanAdaptiveChargingState({
      ...merged,
      revision: current.revision + 1,
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

  // Serialize complete control workflows, not merely their final commits.
  // Forecast network I/O remains outside this queue so it cannot delay a pause.
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = controlQueue.then(operation);
    controlQueue = task.catch(() => undefined);
    return task;
  }

  return { read, write, exclusive };
}
