import type { AwayPeriod } from "../contracts/away-period.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import {
  appendAdaptiveChargingLog,
  finalizeAdaptiveChargeSession,
  recordAdaptiveChargeSample,
} from "../domain/adaptive-state.js";
import { backupPreparationBlocksActions } from "../domain/operational-overrides.js";
import { queueAdaptiveChargingPlanRefresh } from "../domain/adaptive-control.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";

export interface AdaptiveEvaluationLifecycleDependencies {
  history: {
    awayPeriods(options: { includeCompleted: boolean; nowMs: number }): AwayPeriod[];
  };
  readOperationalOverrides(): Promise<unknown>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
}

export async function prepareAdaptiveEvaluation(
  state: AdaptiveChargingState,
  status: AdaptiveEvaluationStatus,
  now: Date,
  dependencies: AdaptiveEvaluationLifecycleDependencies,
): Promise<{ state: AdaptiveChargingState; awayPeriods: AwayPeriod[]; stopped: boolean }> {
  const awayPeriods = dependencies.history.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
  const activeAway = awayPeriods.find((period) => period.status === "active") ?? null;
  const awayStateKey = activeAway ? `away:${activeAway.id}:${activeAway.until}` : "home";
  if (state.lastAwayStateKey === null && !activeAway) {
    state.lastAwayStateKey = awayStateKey;
  } else if (state.lastAwayStateKey !== awayStateKey) {
    queueAdaptiveChargingPlanRefresh(state, activeAway ? "Away period started" : "Away period ended", now);
    state.lastPlanEventKey = null;
    state.lastAwayStateKey = awayStateKey;
  }

  recordAdaptiveChargeSample(state, status, now);
  if (!backupPreparationBlocksActions(await dependencies.readOperationalOverrides())) {
    return { state, awayPeriods, stopped: false };
  }

  if (state.owner === "adaptiveCharging") {
    finalizeAdaptiveChargeSession(state, "Backup Preparation activated", now);
    state.owner = null;
    state.activeSlot = null;
    state.activePlanCreatedAt = null;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = null;
  }
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.standbyHoldUntil = null;
  if (state.lastResult?.skipped !== "Backup Preparation active") {
    appendAdaptiveChargingLog(
      state,
      "Backup Preparation is active; Adaptive Charging will continue observing data without controlling the battery",
      "pause",
      now,
    );
  }
  state.lastResult = { ok: true, at: now.toISOString(), skipped: "Backup Preparation active" };
  return { state: await dependencies.writeState(state), awayPeriods, stopped: true };
}
