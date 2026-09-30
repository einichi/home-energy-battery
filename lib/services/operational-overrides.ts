import {
  appendBackupPreparationLog,
  backupPreparationAllowsActionSource,
  backupPreparationBlocksActions,
  cleanOperationalOverridesState,
  type OperationalOverridesState,
} from "../domain/operational-overrides.js";

export interface OperationalOverrideDocumentStore {
  readDocument(key: "operationalOverrides", fallback: Record<string, unknown>): Record<string, unknown>;
  writeDocument(key: "operationalOverrides", value: OperationalOverridesState): unknown;
}

export function createOperationalOverrideService(
  store: OperationalOverrideDocumentStore,
  createError: (status: number, message: string) => Error,
) {
  let mutationQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<OperationalOverridesState> {
    return cleanOperationalOverridesState(store.readDocument("operationalOverrides", {}));
  }

  async function write(state: unknown): Promise<OperationalOverridesState> {
    const cleaned = cleanOperationalOverridesState(state);
    store.writeDocument("operationalOverrides", cleaned);
    return cleaned;
  }

  function mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const task = mutationQueue.then(mutation);
    mutationQueue = task.catch(() => undefined);
    return task;
  }

  async function recordBlocked(source: string, action: string): Promise<OperationalOverridesState> {
    return mutate(async () => {
      const state = await read();
      if (!backupPreparationBlocksActions(state)) return state;
      appendBackupPreparationLog(
        state,
        `Blocked ${source} action ${action} while Backup Preparation is active`,
        "blocked",
      );
      return write(state);
    });
  }

  async function assertAllowed(source: string, action: string): Promise<void> {
    const state = await read();
    if (backupPreparationAllowsActionSource(state, source)) return;
    await recordBlocked(source, action);
    throw createError(409, "Backup Preparation is active and owns battery control. End it before using this action.");
  }

  return { assertAllowed, mutate, read, recordBlocked, write };
}
