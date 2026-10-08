import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";
import type { createAdaptiveChargingOperations } from "./adaptive-charging-operations.js";
import {
  activeAdaptiveChargingSlotStopReason,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingSlotAt,
  beginAdaptiveChargingBreakerRecovery,
  consumeCompletedAdaptiveChargingSlot,
  preserveInterruptedAdaptiveCharge,
} from "../domain/adaptive-control.js";
import {
  appendAdaptiveChargingLog,
  recordAdaptiveChargingSolarHeadroomInterruption,
  recordAdaptiveChargingWindowInterruption,
} from "../domain/adaptive-state.js";

type AdaptiveOperations = ReturnType<typeof createAdaptiveChargingOperations>;
type DiscountedWindow = { start: string; end: string };
type LiveImportSafety = ReturnType<typeof import("../domain/adaptive-control.js").adaptiveChargingLiveImportSafety>;

export interface ActiveChargeStopDependencies {
  releaseCharge: AdaptiveOperations["release"];
  suspendInStandby: AdaptiveOperations["suspendInStandby"];
  executeAction(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
}

export async function stopOrRefreshActiveCharge(
  state: AdaptiveChargingState,
  config: ApplicationConfig,
  status: AdaptiveEvaluationStatus,
  now: Date,
  soc: number | null,
  activeDiscountedWindow: DiscountedWindow | null,
  liveImportSafety: LiveImportSafety,
  liveExportNeedsHeadroom: boolean,
  rules: AutomationRule[],
  dependencies: ActiveChargeStopDependencies,
): Promise<{ state: AdaptiveChargingState; stopped: boolean }> {
  const activeTargetKwh = Number(state.activeSlot?.targetWh ?? 0) / 1000;
  const activeTargetSocPercent = Number(state.activeSlot?.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  const activeExpired = state.activeSlot && now.getTime() >= new Date(state.activeSlot.end).getTime();
  const activePlanStopReason = activeAdaptiveChargingSlotStopReason(state, config, state.plan, now);
  const activeEnergyTargetReached = state.owner === "adaptiveCharging" && state.activeChargedKwh >= activeTargetKwh;
  const activeSocTargetReached = state.owner === "adaptiveCharging" && soc !== null && soc >= activeTargetSocPercent;
  const breakerReserveInterrupted = state.owner === "adaptiveCharging"
    && !activeExpired
    && !activePlanStopReason
    && !liveImportSafety.available
    && !activeEnergyTargetReached
    && !activeSocTargetReached
    && !liveExportNeedsHeadroom;
  if (state.owner === "adaptiveCharging" && (
    activeExpired
    || activePlanStopReason
    || !liveImportSafety.available
    || activeEnergyTargetReached
    || activeSocTargetReached
    || liveExportNeedsHeadroom
  )) {
    const completedSlot = state.activeSlot;
    let stopReason = "Planned charge target reached";
    if (activeExpired) {
      const activeWindowEndMs = new Date(completedSlot?.windowEnd ?? "").getTime();
      stopReason = Number.isFinite(activeWindowEndMs) && now.getTime() < activeWindowEndMs
        ? "Planned charging slot ended"
        : "Planned discounted window ended";
    } else if (activePlanStopReason) stopReason = activePlanStopReason;
    else if (!liveImportSafety.available) {
      const interruption = breakerReserveInterrupted ? preserveInterruptedAdaptiveCharge(state, now) : null;
      if (interruption) {
        recordAdaptiveChargingWindowInterruption(state, now);
        beginAdaptiveChargingBreakerRecovery(state, adaptiveChargingLiveChargeHeadroom(status, config, state, rules), now);
      }
      const importText = Number.isFinite(liveImportSafety.gridImportW) ? `${Math.round(liveImportSafety.gridImportW)} W` : "unavailable";
      const limitText = Number.isFinite(liveImportSafety.breakerLimitW) ? `${Math.round(liveImportSafety.breakerLimitW)} W` : "unavailable";
      stopReason = interruption
        ? `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText}) after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
        : `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText})`;
    } else if (liveExportNeedsHeadroom) {
      const interruption = preserveInterruptedAdaptiveCharge(state, now);
      if (interruption) recordAdaptiveChargingSolarHeadroomInterruption(state);
      stopReason = interruption
        ? `Live grid export indicates solar needs battery headroom after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
        : "Live grid export indicates solar needs battery headroom";
    }
    if (liveExportNeedsHeadroom && state.activeSlot?.windowEnd) {
      state.solarHeadroomHoldUntil = state.activeSlot.windowEnd;
      state.solarHeadroomClearChecks = 0;
    }
    const completedWindowEndMs = new Date(completedSlot?.windowEnd ?? "").getTime();
    const holdStandbyUntilWindowEnd = Boolean(
      activeDiscountedWindow
      && !liveExportNeedsHeadroom
      && Number.isFinite(completedWindowEndMs)
      && completedWindowEndMs > now.getTime(),
    );
    try {
      if (breakerReserveInterrupted) {
        await dependencies.suspendInStandby(state, stopReason, now);
      } else if (holdStandbyUntilWindowEnd) {
        await dependencies.suspendInStandby(state, stopReason, now, null, dependencies.executeAction, completedSlot?.windowEnd);
      } else {
        await dependencies.releaseCharge(state, stopReason, now);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendAdaptiveChargingLog(
        state,
        `Failed to stop active charge after ${stopReason.toLowerCase()}: ${message}; will retry on the next check`,
        "error",
        now,
      );
      state.lastResult = { ok: false, at: now.toISOString(), error: message, kind: "charge-stop-retry", reason: stopReason.toLowerCase() };
      return { state: await dependencies.writeState(state), stopped: true };
    }
    if (activeEnergyTargetReached || activeSocTargetReached) {
      if (state.plan) state.plan = consumeCompletedAdaptiveChargingSlot(state.plan, completedSlot) as typeof state.plan;
      state.interruptedCharge = null;
      state.breakerRecovery = null;
    }
  } else if (state.owner === "adaptiveCharging" && state.plan && state.activePlanCreatedAt !== state.plan.createdAt) {
    const replacement = adaptiveChargingSlotAt(state.plan, now);
    state.activeSlot = {
      ...state.activeSlot,
      ...replacement,
      targetWh: Number(state.activeSlot?.targetWh),
    } as typeof state.activeSlot;
    state.activePlanCreatedAt = state.plan.createdAt ?? null;
  }
  return { state, stopped: false };
}
