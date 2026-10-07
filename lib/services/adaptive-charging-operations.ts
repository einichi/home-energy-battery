import {
  appendAdaptiveChargingLog,
  cleanAdaptiveChargingState,
  finalizeAdaptiveChargeSession,
  finalizeExpiredAdaptiveChargingWindow,
} from "../domain/adaptive-state.js";
import {
  adaptiveChargingSlotEndDelayMs,
  adaptiveChargingSlotEndKey,
  preserveInterruptedAdaptiveCharge,
} from "../domain/adaptive-control.js";
import { batteryChargingWatts, batteryOperationMode } from "../domain/automation-rules.js";
import { numericMetric } from "../domain/telemetry.js";

type AdaptiveChargingState = ReturnType<typeof cleanAdaptiveChargingState>;
type DeviceActionExecutor = (action: string, payload?: Record<string, unknown>) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AdaptiveChargingOperationDependencies {
  execute: DeviceActionExecutor;
  readState(): Promise<AdaptiveChargingState>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  retryDelayMs: number;
  guardOwnsStandby?: () => Promise<boolean>;
}

export function createAdaptiveChargingOperations({
  execute,
  readState,
  writeState,
  retryDelayMs,
  guardOwnsStandby,
}: AdaptiveChargingOperationDependencies) {
  async function release(
    state: AdaptiveChargingState,
    reason: string,
    now: Date = new Date(),
    batteryHost: string | null = null,
    actionExecutor: DeviceActionExecutor = execute,
  ): Promise<boolean> {
    if (state.owner !== "adaptiveCharging") return false;
    await actionExecutor("set-mode", { mode: "auto", ...(batteryHost ? { host: batteryHost } : {}) });
    finalizeAdaptiveChargeSession(state, reason, now);
    appendAdaptiveChargingLog(state, `${reason}; setting operation mode to Auto`, "stop", now);
    state.owner = null;
    state.activeSlot = null;
    state.activePlanCreatedAt = null;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = null;
    state.standbyHoldUntil = null;
    return true;
  }

  async function suspendInStandby(
    state: AdaptiveChargingState,
    reason: string,
    now: Date = new Date(),
    batteryHost: string | null = null,
    actionExecutor: DeviceActionExecutor = execute,
    holdUntil: string | null = null,
  ): Promise<boolean> {
    if (state.owner !== "adaptiveCharging") return false;
    await actionExecutor("set-mode", { mode: "standby", ...(batteryHost ? { host: batteryHost } : {}) });
    finalizeAdaptiveChargeSession(state, reason, now);
    const holdUntilMs = new Date(holdUntil ?? "").getTime();
    state.standbyHoldUntil = Number.isFinite(holdUntilMs) && holdUntilMs > now.getTime()
      ? new Date(holdUntilMs).toISOString()
      : null;
    appendAdaptiveChargingLog(
      state,
      state.standbyHoldUntil
        ? `${reason}; holding Standby operation mode until ${state.standbyHoldUntil}`
        : `${reason}; maintaining Standby operation mode`,
      "guard",
      now,
    );
    state.owner = null;
    state.activeSlot = null;
    state.activePlanCreatedAt = null;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = null;
    return true;
  }

  async function start(
    slot: Record<string, unknown>,
    options: { resumeFromStandby?: boolean; execute?: DeviceActionExecutor } = {},
  ): Promise<unknown> {
    const actionExecutor = options.execute ?? execute;
    try {
      return await actionExecutor("charge", { targetWh: slot.targetWh });
    } catch (error: unknown) {
      if (options.resumeFromStandby) {
        try {
          await actionExecutor("set-mode", { mode: "standby" });
        } catch (standbyError: unknown) {
          throw new AggregateError(
            [error, standbyError],
            `${errorMessage(error)}; failed to return battery to Standby: ${errorMessage(standbyError)}`,
            { cause: standbyError },
          );
        }
      }
      throw error;
    }
  }

  async function enforceDeadline(expectedKey: string | null, options: {
    now?: Date;
    readState?: () => Promise<AdaptiveChargingState | Record<string, unknown>>;
    release?: (state: AdaptiveChargingState, reason: string, now: Date) => Promise<unknown>;
    suspend?: (state: AdaptiveChargingState, reason: string, now: Date, batteryHost: null, actionExecutor: DeviceActionExecutor, holdUntil?: string) => Promise<unknown>;
    writeState?: (state: AdaptiveChargingState) => Promise<unknown>;
  } = {}) {
    const now = options.now ?? new Date();
    const state = await (options.readState ?? readState)() as AdaptiveChargingState;
    if (adaptiveChargingSlotEndKey(state) !== expectedKey) {
      return { stopped: false, reason: "active adaptiveCharging slot changed" };
    }
    const remainingMs = adaptiveChargingSlotEndDelayMs(state, now);
    if (remainingMs !== null && remainingMs > 0) return { stopped: false, remainingMs };
    // The Demand Guard owns Standby; do not release to Auto until it restores.
    if (guardOwnsStandby && await guardOwnsStandby()) {
      return { stopped: false, reason: "Charging Demand Guard owns Standby operation mode" };
    }
    const windowEndMs = new Date(state.activeSlot?.windowEnd ?? "").getTime();
    const slotEndMs = new Date(state.activeSlot?.end ?? "").getTime();
    const windowEnded = Number.isFinite(windowEndMs)
      && (now.getTime() >= windowEndMs || (Number.isFinite(slotEndMs) && slotEndMs >= windowEndMs));
    const reason = windowEnded ? "Planned discounted window ended" : "Planned charging slot ended";
    try {
      if (windowEnded) await (options.release ?? release)(state, reason, now);
      else await (options.suspend ?? suspendInStandby)(state, reason, now, null, execute, state.activeSlot?.windowEnd);
    } catch (error: unknown) {
      const message = errorMessage(error);
      appendAdaptiveChargingLog(state, `Failed to stop overdue charge after ${reason.toLowerCase()}: ${message}; retrying`, "error", now);
      state.lastResult = { ok: false, at: now.toISOString(), error: message, kind: "slot-end-retry", reason: reason.toLowerCase() };
      await (options.writeState ?? writeState)(state);
      return { stopped: false, retryMs: retryDelayMs, error: message };
    }
    finalizeExpiredAdaptiveChargingWindow(state, state.activeWindowExecution?.latestSocPercent, now);
    state.lastResult = { ok: true, at: now.toISOString(), kind: "stop", reason: reason.toLowerCase() };
    await (options.writeState ?? writeState)(state);
    return { stopped: true };
  }

  async function recoverIdle(
    state: AdaptiveChargingState,
    status: Record<string, unknown>,
    now: Date = new Date(),
    actionExecutor: DeviceActionExecutor = execute,
  ): Promise<boolean> {
    const session = state.activeChargeSession;
    const window = state.activeWindowExecution;
    if (state.owner !== "adaptiveCharging" || !session || !window) return false;
    const statusEnergy = status.energy && typeof status.energy === "object"
      ? status.energy as { battery?: { remaining_percent?: { value?: unknown } } }
      : undefined;
    const soc = numericMetric(state.owner ? statusEnergy?.battery?.remaining_percent : null);
    const remainingWh = Number(state.activeSlot?.targetWh) - Number(state.activeChargedKwh) * 1000;
    const eligible = batteryChargingWatts(status) === 0
      && batteryOperationMode(status) === "charging"
      && soc !== null && Number.isFinite(soc) && soc < Number(state.activeSlot?.targetSocPercent)
      && remainingWh >= 50 && new Date(state.activeSlot?.end ?? "").getTime() - now.getTime() > 120_000;
    if (!eligible) {
      session.idleSince = null;
      session.idleCheckedAt = null;
      return false;
    }
    const previousCheckMs = new Date(session.idleCheckedAt ?? "").getTime();
    if (!session.idleSince || !session.idleCheckedAt || now.getTime() - previousCheckMs > 60_000) session.idleSince = now.toISOString();
    session.idleCheckedAt = now.toISOString();
    if (now.getTime() - new Date(session.idleSince ?? "").getTime() < 90_000 || Number(window.idleRecoveryCount || 0) >= 2) return false;
    preserveInterruptedAdaptiveCharge(state, now);
    await release(state, "Battery remained idle below its charging objective for 90 seconds; restarting the remaining charge", now, null, actionExecutor);
    window.idleRecoveryCount = Number(window.idleRecoveryCount || 0) + 1;
    return true;
  }

  return { enforceDeadline, recoverIdle, release, start, suspendInStandby };
}
