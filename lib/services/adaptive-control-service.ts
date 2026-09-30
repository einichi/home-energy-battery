import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import { appendAdaptiveChargingLog } from "../domain/adaptive-state.js";
import {
  adaptiveChargingConfiguredActive,
  adaptiveChargingSlotEndDelayMs,
  adaptiveChargingSlotEndKey,
  nextLocalMidnight,
  queueAdaptiveChargingPlanRefresh,
} from "../domain/adaptive-control.js";

export interface AdaptiveControlDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readState(): Promise<AdaptiveChargingState>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  releaseCharge(state: AdaptiveChargingState, reason: string, now: Date): Promise<unknown>;
  execute(action: string, payload: Record<string, unknown>): Promise<unknown>;
  enforceDeadline(key: string): Promise<{ remainingMs?: unknown; retryMs?: unknown }>;
  logError(label: string, error: unknown): void;
  deadlineRetryMs: number;
  maxTimerDelayMs: number;
}

export function createAdaptiveControlService(dependencies: AdaptiveControlDependencies) {
  let deadlineTimer: NodeJS.Timeout | null = null;
  let deadlineTimerKey: string | null = null;

  async function pauseForManualAction(action: string, now: Date = new Date()): Promise<AdaptiveChargingState | null> {
    const config = await dependencies.readConfig();
    if (!adaptiveChargingConfiguredActive(config)) return null;
    const state = await dependencies.readState();
    if (state.owner === "adaptiveCharging") await dependencies.releaseCharge(state, "Manual battery action received", now);
    else if (state.standbyHoldUntil) {
      await dependencies.execute("set-mode", { mode: "auto" });
      appendAdaptiveChargingLog(state, "Manual battery action received; releasing Adaptive Charging Standby hold", "stop", now);
    }
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.standbyHoldUntil = null;
    state.pausedUntil = nextLocalMidnight(now);
    appendAdaptiveChargingLog(state, `Manual ${action} action paused Adaptive Charging until ${state.pausedUntil}`, "pause", now);
    return dependencies.writeState(state);
  }

  async function resume(now: Date = new Date()): Promise<AdaptiveChargingState> {
    const state = await dependencies.readState();
    state.pausedUntil = null;
    state.plan = null;
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.solarHeadroomHoldUntil = null;
    if (state.standbyHoldUntil) {
      await dependencies.execute("set-mode", { mode: "auto" });
      state.standbyHoldUntil = null;
    }
    state.lastPlanEventKey = null;
    queueAdaptiveChargingPlanRefresh(state, "manual resume", now);
    appendAdaptiveChargingLog(state, "Adaptive Charging resumed manually", "resume", now);
    return dependencies.writeState(state);
  }

  function clearDeadline(): void {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    deadlineTimerKey = null;
  }

  function armDeadline(key: string, delayMs: number): void {
    deadlineTimerKey = key;
    const timer = setTimeout(() => {
      dependencies.enforceDeadline(key)
        .then((result) => {
          if (deadlineTimer !== timer) return;
          deadlineTimer = null;
          deadlineTimerKey = null;
          const remainingMs = Number(result.remainingMs);
          const retryMs = Number(result.retryMs);
          const retryDelayMs = Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : retryMs;
          if (Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
            armDeadline(key, Math.min(retryDelayMs, dependencies.maxTimerDelayMs));
          }
        })
        .catch((error: unknown) => {
          if (deadlineTimer !== timer) return;
          deadlineTimer = null;
          deadlineTimerKey = null;
          dependencies.logError("adaptive-charging-slot-end", error);
          armDeadline(key, dependencies.deadlineRetryMs);
        });
    }, Math.max(0, Math.min(delayMs, dependencies.maxTimerDelayMs)));
    deadlineTimer = timer;
    deadlineTimer.unref();
  }

  function syncDeadline(state: AdaptiveChargingState, now: Date = new Date()): boolean {
    const key = adaptiveChargingSlotEndKey(state);
    if (!key) {
      clearDeadline();
      return false;
    }
    if (deadlineTimer && deadlineTimerKey === key) return true;
    clearDeadline();
    armDeadline(key, adaptiveChargingSlotEndDelayMs(state, now) ?? 0);
    return true;
  }

  return { clearDeadline, pauseForManualAction, resume, syncDeadline };
}
