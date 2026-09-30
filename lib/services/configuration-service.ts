import type { ApplicationConfig } from "../contracts/configuration.js";

export interface ConfigurationDocumentStore {
  readDocument(key: "config", fallback: Record<string, unknown>): Record<string, unknown>;
}

export interface ConfigurationServiceDependencies {
  documents: ConfigurationDocumentStore;
  defaultConfig: ApplicationConfig;
  normalize(input: unknown): ApplicationConfig;
  commit(previous: ApplicationConfig, proposed: ApplicationConfig): Promise<ApplicationConfig>;
}

export function createConfigurationService({
  documents,
  defaultConfig,
  normalize,
  commit,
}: ConfigurationServiceDependencies) {
  let mutationQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<ApplicationConfig> {
    return normalize(documents.readDocument("config", defaultConfig));
  }

  function update(
    mutator: (config: ApplicationConfig) => ApplicationConfig | Promise<ApplicationConfig>,
  ): Promise<ApplicationConfig> {
    const task = mutationQueue.then(async () => {
      const previous = await read().catch(() => normalize(defaultConfig));
      const proposed = await mutator(structuredClone(previous));
      return commit(previous, proposed);
    });
    mutationQueue = task.catch(() => undefined);
    return task;
  }

  function write(patch: Partial<ApplicationConfig>): Promise<ApplicationConfig> {
    return update((previous) => ({ ...previous, ...patch }));
  }

  return { normalize, read, update, write };
}
