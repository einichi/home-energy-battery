import { MILLISECONDS_PER_DAY } from "../domain/time.js";
import type { ApplicationConfig, RetentionConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";

export interface RuntimeCoordinatorDependencies {
  scheduleIntervalMs: number;
  automationIntervalMs: number;
  defaultUpdateIntervalSeconds: number;
  runSchedules: () => Promise<unknown>;
  runAutomation: () => Promise<unknown>;
  readConfig: () => Promise<ApplicationConfig>;
  runRetention: (retention: Partial<RetentionConfig>) => Promise<unknown>;
  updateGasTariff: (config: ApplicationConfig) => Promise<unknown>;
  readAdaptiveState: () => Promise<AdaptiveChargingState>;
  readOperationalOverrides: () => Promise<unknown>;
  backupPreparationBlocksActions: (state: unknown) => boolean;
  clearAdaptiveDeadline: () => void;
  syncAdaptiveDeadline: (state: AdaptiveChargingState) => unknown;
  discoveryInProgress: () => boolean;
  discoveryLabel: () => string | null;
  anyDeviceConfigured: (config: ApplicationConfig) => boolean;
  getStatus: (options: { maxAgeMs: number }) => Promise<unknown>;
  observeStatus: (status: unknown, config: ApplicationConfig) => void;
  activeWork: () => boolean;
  logError: (label: string, error: unknown) => void;
}

export function createRuntimeCoordinator(dependencies: RuntimeCoordinatorDependencies) {
  let scheduleTimer: NodeJS.Timeout | null = null;
  let automationTimer: NodeJS.Timeout | null = null;
  let recorderTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  let retentionRunPromise: Promise<unknown> | null = null;
  let enabled = false;

  const report = (label: string, operation: Promise<unknown>) => {
    operation.catch((error: unknown) => dependencies.logError(label, error));
  };

  function startScheduler(): void {
    scheduleTimer = setInterval(() => report("scheduler", dependencies.runSchedules()), dependencies.scheduleIntervalMs);
    automationTimer = setInterval(() => report("automation", dependencies.runAutomation()), dependencies.automationIntervalMs);
    report("scheduler", dependencies.runSchedules());
    report("automation", dependencies.runAutomation());
  }

  async function runRetentionMaintenance(): Promise<unknown> {
    if (retentionRunPromise) return retentionRunPromise;
    retentionRunPromise = (async () => {
      try {
        const config = await dependencies.readConfig();
        const retention: RetentionConfig | undefined = config.retention;
        if (retention?.automaticMaintenance) await dependencies.runRetention(retention);
        try {
          await dependencies.updateGasTariff(config);
        } catch (error: unknown) {
          dependencies.logError("gas-tariff", error);
        }
      } catch (error: unknown) {
        dependencies.logError("retention", error);
      } finally {
        retentionRunPromise = null;
      }
    })();
    return retentionRunPromise;
  }

  function startRecorder(): void {
    const scheduleNext = (intervalMs: number) => {
      if (!enabled) return;
      recorderTimer = setTimeout(tick, intervalMs);
      recorderTimer.unref();
    };
    async function tick(): Promise<void> {
      if (!enabled) return;
      let intervalMs = dependencies.defaultUpdateIntervalSeconds * 1000;
      try {
        const config = await dependencies.readConfig();
        const configuredSeconds = Number(config.updateIntervalSeconds);
        intervalMs = Math.max(5, Math.min(3600, Number.isFinite(configuredSeconds)
          ? configuredSeconds
          : dependencies.defaultUpdateIntervalSeconds)) * 1000;
        if (dependencies.discoveryInProgress()) {
          console.warn(`recorder: discovery is running (${dependencies.discoveryLabel()}); skipping this poll`);
        } else if (dependencies.anyDeviceConfigured(config)) {
          const status = await dependencies.getStatus({ maxAgeMs: Math.max(0, intervalMs - 1) });
          dependencies.observeStatus(status, config);
        }
      } catch (error: unknown) {
        dependencies.logError("recorder", error);
      } finally {
        scheduleNext(intervalMs);
      }
    }
    void tick();
  }

  function start(): void {
    if (enabled) return;
    enabled = true;
    Promise.all([dependencies.readAdaptiveState(), dependencies.readOperationalOverrides()])
      .then(([state, overrides]) => {
        if (dependencies.backupPreparationBlocksActions(overrides)) {
          dependencies.clearAdaptiveDeadline();
          return;
        }
        dependencies.syncAdaptiveDeadline(state);
      })
      .catch((error: unknown) => dependencies.logError("adaptive-charging-slot-end-startup", error));
    startScheduler();
    startRecorder();
    retentionTimer = setInterval(() => { void runRetentionMaintenance(); }, MILLISECONDS_PER_DAY);
    retentionTimer.unref();
    void runRetentionMaintenance();
  }

  function stop(): void {
    enabled = false;
    if (scheduleTimer) clearInterval(scheduleTimer);
    if (automationTimer) clearInterval(automationTimer);
    if (recorderTimer) clearTimeout(recorderTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    scheduleTimer = null;
    automationTimer = null;
    recorderTimer = null;
    retentionTimer = null;
    dependencies.clearAdaptiveDeadline();
  }

  async function waitForIdle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (dependencies.activeWork() || retentionRunPromise) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for active application work before database restore");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  return { start, stop, waitForIdle };
}
