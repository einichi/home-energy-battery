export interface ApplicationInitializerDependencies {
  initializeHistory(): Promise<unknown>;
  initializeDocuments(): Promise<unknown>;
  configureDeviceAdapter(): Promise<void>;
  initializeState(): Promise<void>;
  startBackgroundProcesses(): void;
}

export function createApplicationInitializer(dependencies: ApplicationInitializerDependencies) {
  let initialized = false;
  let initialization: Promise<void> | null = null;

  async function run(): Promise<void> {
    await dependencies.initializeHistory();
    await dependencies.initializeDocuments();
    await dependencies.configureDeviceAdapter();
    await dependencies.initializeState();
    dependencies.startBackgroundProcesses();
    initialized = true;
  }

  return {
    initialize(): Promise<void> {
      if (initialized) return Promise.resolve();
      initialization ??= run().catch((error: unknown) => {
        initialization = null;
        throw error;
      });
      return initialization;
    },
    isInitialized(): boolean {
      return initialized;
    },
  };
}
