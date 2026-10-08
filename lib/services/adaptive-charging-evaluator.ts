import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState, AdaptivePlan } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import type { OperationalOverridesState } from "../domain/operational-overrides.js";
import type { AwayPeriod } from "../contracts/away-period.js";
import type { SolarForecastHour } from "../domain/solar-forecast.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";
import type { createAdaptiveChargingOperations } from "./adaptive-charging-operations.js";
import type { createAdaptiveHistoryService } from "./adaptive-history-service.js";
import type { createAdaptiveForecastService } from "./adaptive-forecast-service.js";
import { refreshAdaptivePlan } from "./adaptive-plan-refresh.js";
import type { PlanSnapshotRecorderInput } from "./adaptive-plan-refresh.js";
import {
  adaptiveChargingBaseAvailability,
  adaptiveChargingBreakerSettings,
  forecastIsFresh,
} from "../domain/adaptive-planning.js";
import {
  appendAdaptiveChargingLog,
  completeAdaptiveChargingWindowInterruption,
  finalizeAdaptiveChargeSession,
  finalizeExpiredAdaptiveChargingWindow,
  recordAdaptiveChargeSample,
  recordAdaptiveChargingSolarHeadroomInterruption,
  recordAdaptiveChargingWindowInterruption,
  startAdaptiveChargeSession,
  syncAdaptiveChargingWindowExecution,
} from "../domain/adaptive-state.js";
import {
  activeAdaptiveChargingSlotStopReason,
  adaptiveChargingExportEvidence,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingLiveImportSafety,
  adaptiveChargingPlanRefreshDecision,
  adaptiveChargingSlotAt,
  adaptiveChargingConfiguredActive,
  adaptiveChargingWindowSolarOpportunity,
  advanceAdaptiveChargingBreakerRecovery,
  beginAdaptiveChargingBreakerRecovery,
  capAdaptiveChargingSlotToRemainingTime,
  consumeBatteryLearningModelSwitch,
  consumeCompletedAdaptiveChargingSlot,
  logAdaptiveChargingBreakerWait,
  logAdaptiveChargingInitialHeadroomWait,
  preserveInterruptedAdaptiveCharge,
  queueAdaptiveChargingPlanRefresh,
  updateAdaptiveChargingExportConfirmation,
  updateAdaptiveChargingSolarHeadroomHold,
  updateActiveAdaptiveChargingObjective,
} from "../domain/adaptive-control.js";
import { backupPreparationBlocksActions } from "../domain/operational-overrides.js";
import { discountedBandOccurrence, explicitDiscountedBand } from "../domain/tariffs.js";
import { numericMetric } from "../domain/telemetry.js";
import { batteryOperationMode } from "../domain/automation-rules.js";

type AdaptiveOperations = ReturnType<typeof createAdaptiveChargingOperations>;
type AdaptiveHistory = ReturnType<typeof createAdaptiveHistoryService>;
type AdaptiveForecast = ReturnType<typeof createAdaptiveForecastService>;

const ADAPTIVE_CHARGING_SOLAR_WINDOW_DISCHARGE_BUDGET_PERCENT = 2;

export interface AdaptiveChargingEvaluatorDependencies {
  readState(): Promise<AdaptiveChargingState>;
  writeState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  history: {
    awayPeriods(options: { includeCompleted: boolean; nowMs: number }): AwayPeriod[];
    historicalWeather(): SolarForecastHour[];
  };
  readOperationalOverrides(): Promise<OperationalOverridesState>;
  executeAction(action: string, payload: Record<string, unknown>): Promise<unknown>;
  releaseCharge: AdaptiveOperations["release"];
  suspendInStandby: AdaptiveOperations["suspendInStandby"];
  startCharge: AdaptiveOperations["start"];
  recoverIdle: AdaptiveOperations["recoverIdle"];
  readHistory: AdaptiveHistory["readHistory"];
  refreshBatteryLearning: AdaptiveHistory["refreshBatteryLearning"];
  readDemandProfileDays: AdaptiveHistory["readDemandProfileDays"];
  solarForecastAccuracy: AdaptiveForecast["accuracy"];
  recordFuelCellPlanForecast(plan: AdaptivePlan | null, now?: Date): number;
  recordPlanSnapshot?(input: PlanSnapshotRecorderInput): number;
  breakerWaitLogMs: number;
}

export function createAdaptiveChargingEvaluator(dependencies: AdaptiveChargingEvaluatorDependencies) {
  const readAdaptiveChargingState = dependencies.readState;
  const writeAdaptiveChargingState = dependencies.writeState;
  const historyStore = dependencies.history;
  const readOperationalOverridesState = dependencies.readOperationalOverrides;
  const releaseAdaptiveCharge = dependencies.releaseCharge;
  const suspendAdaptiveChargeInStandby = dependencies.suspendInStandby;
  const executeAdaptiveChargeStart = dependencies.startCharge;
  const recoverIdleAdaptiveCharge = dependencies.recoverIdle;
  const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = dependencies.breakerWaitLogMs;
  const executeAdaptiveChargingAction = (action: string, payload: Record<string, unknown> = {}) =>
    dependencies.executeAction(action, payload);

  async function ensureDiscountedWindowStandby(
    state: AdaptiveChargingState,
    status: AdaptiveEvaluationStatus,
    windowEnd: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    const holdUntilMs = new Date(state.standbyHoldUntil ?? "").getTime();
    const windowEndMs = new Date(windowEnd).getTime();
    const holdActive = Number.isFinite(holdUntilMs) && holdUntilMs >= windowEndMs && holdUntilMs > now.getTime();
    const batteryPowerW = numericMetric(status.energy?.battery?.instant_power);
    const operationMode = batteryOperationMode(status);
    const needsReassertion = operationMode !== "standby" || (batteryPowerW !== null && batteryPowerW < 0);
    if (!holdActive || needsReassertion) {
      try {
        await executeAdaptiveChargingAction("set-mode", { mode: "standby" });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        appendAdaptiveChargingLog(
          state,
          `Failed to prevent battery discharge during the discounted window: ${message}; will retry on the next check`,
          "error",
          now,
        );
        state.lastResult = {
          ok: false,
          at: now.toISOString(),
          error: message,
          kind: "discounted-window-standby-retry",
        };
        await writeAdaptiveChargingState(state);
        throw error;
      }
      state.standbyHoldUntil = new Date(windowEndMs).toISOString();
      if (!holdActive) queueAdaptiveChargingPlanRefresh(state, "discounted window Standby established", now);
      appendAdaptiveChargingLog(
        state,
        `${reason}; holding Standby operation mode until ${state.standbyHoldUntil} to prevent battery discharge during the discounted window`,
        holdActive ? "maintain" : "guard",
        now,
      );
    }
  }

  async function ensureSolarWindowAuto(
    state: AdaptiveChargingState,
    status: AdaptiveEvaluationStatus,
    now: Date,
  ): Promise<void> {
    const operationMode = batteryOperationMode(status);
    const releasingHold = Boolean(state.standbyHoldUntil);
    if (operationMode === "standby" || releasingHold) {
      await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
      state.standbyHoldUntil = null;
      queueAdaptiveChargingPlanRefresh(state, "solar-capable window entered Auto", now);
      appendAdaptiveChargingLog(
        state,
        "Usable solar is predicted during this discounted window; using Auto before the planned charge and recalculating every five minutes",
        "solar",
        now,
      );
    }
  }

  return async function evaluateAdaptiveCharging(
    config: ApplicationConfig,
    status: AdaptiveEvaluationStatus,
    rules: AutomationRule[],
    now: Date = new Date(),
  ): Promise<AdaptiveChargingState> {
    let state = await readAdaptiveChargingState();
    if (consumeBatteryLearningModelSwitch(state, now)) {
      // Persist the one-shot transition before history/model work so a failed or
      // overlapping evaluation can retry the queued plan without re-arming it.
      state = await writeAdaptiveChargingState(state);
    }
    const awayPeriods = historyStore.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
    const activeAway = awayPeriods.find((period) => period.status === "active") ?? null;
    const awayStateKey = activeAway ? `away:${activeAway.id}:${activeAway.until}` : "home";
    if (state.lastAwayStateKey === null && !activeAway) {
      state.lastAwayStateKey = awayStateKey;
    } else if (state.lastAwayStateKey !== awayStateKey) {
      queueAdaptiveChargingPlanRefresh(
        state,
        activeAway ? "Away period started" : "Away period ended",
        now,
      );
      state.lastPlanEventKey = null;
      state.lastAwayStateKey = awayStateKey;
    }
    recordAdaptiveChargeSample(state, status, now);
    const operationalOverrides = await readOperationalOverridesState();
    if (backupPreparationBlocksActions(operationalOverrides)) {
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
      return writeAdaptiveChargingState(state);
    }
    if (state.interruptedCharge
      && new Date(state.interruptedCharge.slotEnd ?? "").getTime() <= now.getTime()) {
      state.interruptedCharge = null;
      state.breakerRecovery = null;
    }
    const paused = state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime();
    const guardActive = rules.some((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
    const activeDiscountedWindow = discountedBandOccurrence(config, now);
    const standbyHoldUntilMs = new Date(state.standbyHoldUntil ?? "").getTime();
    if (state.standbyHoldUntil
      && (!Number.isFinite(standbyHoldUntilMs) || standbyHoldUntilMs <= now.getTime())
      && !guardActive) {
      await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
      appendAdaptiveChargingLog(
        state,
        "Discounted charging hold ended; restoring operation mode to Auto",
        "stop",
        now,
      );
      state.standbyHoldUntil = null;
    }
    const guardSettings = adaptiveChargingBreakerSettings(rules);
    const base = adaptiveChargingBaseAvailability(config);
    const shouldProtectDiscountedWindow = Boolean(
      base.available
      && adaptiveChargingConfiguredActive(config)
      && activeDiscountedWindow
      && !paused
      && !guardActive,
    );
    const forecastError = state.lastForecastError?.error ? String(state.lastForecastError.error) : null;
    if (!base.available || !guardSettings.valid || paused || !forecastIsFresh(state.forecast, now) || forecastError) {
      const unavailableReason = paused
        ? "Adaptive Charging is paused"
        : base.reason
          || (!guardSettings.valid ? "Charging Demand Guard settings are unavailable" : null)
          || forecastError
          || "Forecast is unavailable";
      if (!guardActive && state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, unavailableReason, now);
      if (shouldProtectDiscountedWindow && activeDiscountedWindow) {
        await ensureDiscountedWindowStandby(
          state,
          status,
          activeDiscountedWindow.end,
          `Adaptive Charging is temporarily unavailable (${unavailableReason})`,
          now,
        );
      }
      finalizeExpiredAdaptiveChargingWindow(state, numericMetric(status.energy?.battery?.remaining_percent), now);
      state.lastResult = { ok: true, at: now.toISOString(), skipped: paused ? "paused after manual action" : unavailableReason };
      return writeAdaptiveChargingState(state);
    }
    if (guardActive) {
      if (activeDiscountedWindow && state.plan?.available) {
        syncAdaptiveChargingWindowExecution(
          state,
          activeDiscountedWindow,
          state.plan,
          numericMetric(status.energy?.battery?.remaining_percent),
          now,
        );
        if (adaptiveChargingSlotAt(state.plan, now)) {
          recordAdaptiveChargingWindowInterruption(state, now);
        }
      }
      if (state.owner === "adaptiveCharging") {
        const interruption = preserveInterruptedAdaptiveCharge(state, now);
        finalizeAdaptiveChargeSession(state, "Charging Demand Guard interrupted Adaptive Charging", now);
        state.owner = null;
        state.activeSlot = null;
        state.activePlanCreatedAt = null;
        state.activeChargedKwh = 0;
        state.activeLastCheckedAt = null;
        if (!interruption) state.plan = null;
        if (interruption) {
          recordAdaptiveChargingWindowInterruption(state, now);
          beginAdaptiveChargingBreakerRecovery(state, adaptiveChargingLiveChargeHeadroom(status, config, state, rules), now);
        }
        appendAdaptiveChargingLog(
          state,
          interruption
            ? `Charging Demand Guard interrupted Adaptive Charging after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains`
            : "Charging Demand Guard owns battery control; adaptiveCharging is waiting",
          "guard",
          now,
        );
      }
      if (state.breakerRecovery) {
        const headroom = adaptiveChargingLiveChargeHeadroom(status, config, state, rules);
        const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
        logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
      }
      finalizeExpiredAdaptiveChargingWindow(state, numericMetric(status.energy?.battery?.remaining_percent), now);
      state.lastResult = { ok: true, at: now.toISOString(), skipped: "Charging Demand Guard active" };
      return writeAdaptiveChargingState(state);
    }

    if (state.activeWindowExecution?.guardInterruptionStartedAt && !state.breakerRecovery) {
      completeAdaptiveChargingWindowInterruption(state, now);
    }

    const liveSoc = numericMetric(status.energy?.battery?.remaining_percent);
    const liveBranchDemandW = numericMetric(status.meter?.branch_demand_power);
    const liveGridImportW = numericMetric(status.meter?.grid_import_power);
    const telemetryChecks: Array<[number | null, string]> = [
      [liveSoc, "battery state of charge"],
      [liveBranchDemandW, "total circuit load"],
      [liveGridImportW, "grid import"],
    ];
    const missingTelemetry = telemetryChecks.filter(([value]) => !Number.isFinite(value)).map(([, label]) => label);
    if (missingTelemetry.length) {
      const reason = `${missingTelemetry.join(", ")} unavailable`;
      if (state.owner === "adaptiveCharging") {
        const interruption = preserveInterruptedAdaptiveCharge(state, now);
        await releaseAdaptiveCharge(
          state,
          interruption
            ? `${reason} after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
            : reason,
          now,
        );
      }
      if (shouldProtectDiscountedWindow && activeDiscountedWindow) {
        await ensureDiscountedWindowStandby(
          state,
          status,
          activeDiscountedWindow.end,
          `Waiting for ${missingTelemetry.join(", ")} before planned charging`,
          now,
        );
      }
      finalizeExpiredAdaptiveChargingWindow(state, liveSoc, now);
      state.lastResult = { ok: true, at: now.toISOString(), skipped: reason };
      return writeAdaptiveChargingState(state);
    }

    const refreshDecision = adaptiveChargingPlanRefreshDecision(state, config, now);
    if (refreshDecision.refresh) {
      state = await refreshAdaptivePlan(state, config, status, awayPeriods, refreshDecision, now, {
        readHistory: dependencies.readHistory,
        historicalWeather: historyStore.historicalWeather,
        solarForecastAccuracy: dependencies.solarForecastAccuracy,
        refreshBatteryLearning: dependencies.refreshBatteryLearning,
        readDemandProfileDays: dependencies.readDemandProfileDays,
        recordFuelCellPlanForecast: dependencies.recordFuelCellPlanForecast,
        recordPlanSnapshot: dependencies.recordPlanSnapshot,
        appendLog: appendAdaptiveChargingLog,
      });
    }
    if (!state.plan?.available) {
      if (state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, state.plan?.reason || "Plan is unavailable", now);
      if (shouldProtectDiscountedWindow && activeDiscountedWindow) {
        await ensureDiscountedWindowStandby(
          state,
          status,
          activeDiscountedWindow.end,
          state.plan?.reason || "The charging plan is temporarily unavailable",
          now,
        );
      }
      finalizeExpiredAdaptiveChargingWindow(state, liveSoc, now);
      state.lastResult = { ok: true, at: now.toISOString(), skipped: state.plan?.reason || "plan unavailable" };
      return writeAdaptiveChargingState(state);
    }

    const soc = liveSoc;
    if (activeDiscountedWindow) {
      syncAdaptiveChargingWindowExecution(state, activeDiscountedWindow, state.plan, soc, now, refreshDecision.refresh);
    }
    else finalizeExpiredAdaptiveChargingWindow(state, soc, now);
    const solarOpportunity = adaptiveChargingWindowSolarOpportunity(state.plan, activeDiscountedWindow);
    const solarWindowPeakSoc = state.activeWindowExecution?.peakSocPercent
      ?? state.activeWindowExecution?.startSocPercent;
    const solarWindowSocDrop = Number.isFinite(solarWindowPeakSoc) && Number.isFinite(soc)
      ? Number(solarWindowPeakSoc) - Number(soc)
      : 0;
    const solarWindowDischargeBudgetExceeded = solarOpportunity.available
      && solarWindowSocDrop >= ADAPTIVE_CHARGING_SOLAR_WINDOW_DISCHARGE_BUDGET_PERCENT;
    const solarResponsiveWindow = solarOpportunity.available && !solarWindowDischargeBudgetExceeded;
    const activeWindowTargetSoc = activeDiscountedWindow
      ? state.plan.windows?.find((window) => window.start === activeDiscountedWindow.start
        && window.end === activeDiscountedWindow.end)?.targetSocPercent
      : null;
    const activeWindowTargetReached = Number.isFinite(activeWindowTargetSoc)
      && Number.isFinite(soc)
      && Number(soc) >= Number(activeWindowTargetSoc);
    const exportEvidence = adaptiveChargingExportEvidence(status);
    const exportConfirmation = updateAdaptiveChargingExportConfirmation(state, exportEvidence, now);
    const liveExportNeedsHeadroom = exportConfirmation.confirmed;
    const solarHeadroomHold = updateAdaptiveChargingSolarHeadroomHold(state, exportEvidence.aboveThreshold, now);
    if (exportConfirmation.pending && exportConfirmation.count === 1) {
      appendAdaptiveChargingLog(
        state,
        `Grid export (${Math.round(Number(exportEvidence.gridExportW))} W) is awaiting confirmation (${exportConfirmation.count}/${exportConfirmation.requiredChecks})`,
        "observe",
        now,
      );
    }
    if (exportConfirmation.rejected) {
      const lastRejectedLogMs = new Date(state.exportConfirmation.lastRejectedLogAt ?? "").getTime();
      if (!Number.isFinite(lastRejectedLogMs) || now.getTime() - lastRejectedLogMs >= ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS) {
        appendAdaptiveChargingLog(
          state,
          `Rejected incoherent grid export (${Math.round(Number(exportEvidence.gridExportW))} W); calculated grid flow is ${Math.round(Number(exportEvidence.expectedGridW))} W (positive is import) with ${Math.round(Number(exportEvidence.residualW))} W residual`,
          "observe",
          now,
        );
        state.exportConfirmation.lastRejectedLogAt = now.toISOString();
      }
    }
    if (liveExportNeedsHeadroom && exportConfirmation.count === exportConfirmation.requiredChecks) {
      appendAdaptiveChargingLog(
        state,
        `Grid export (${Math.round(Number(exportEvidence.gridExportW))} W) confirmed after ${exportConfirmation.count} checks; preserving solar headroom`,
        "stop",
        now,
      );
    }
    if (solarHeadroomHold.released) {
      appendAdaptiveChargingLog(
        state,
        "Grid export remained clear for two checks; releasing solar headroom hold and allowing planned charging to resume",
        "resume",
        now,
      );
    }
    if (liveExportNeedsHeadroom && state.standbyHoldUntil && !activeDiscountedWindow) {
      await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
      appendAdaptiveChargingLog(
        state,
        "Live grid export indicates solar needs battery headroom; releasing Standby hold and restoring operation mode to Auto",
        "stop",
        now,
      );
      state.standbyHoldUntil = null;
    }
    const liveImportSafety = adaptiveChargingLiveImportSafety(status, rules);
    if (state.breakerRecovery && state.owner !== "adaptiveCharging" && !guardActive) {
      const recoveryHeadroom = adaptiveChargingLiveChargeHeadroom(status, config, state, rules);
      const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, recoveryHeadroom, now);
      if (recoveryStatus.ready) {
        const recoveredAfterMs = completeAdaptiveChargingWindowInterruption(state, now);
        state.breakerRecovery = null;
        appendAdaptiveChargingLog(
          state,
          `Charging Demand Guard headroom recovered after ${Math.round(recoveredAfterMs / 1000)} seconds; the remaining charge can be replanned`,
          "resume",
          now,
        );
      }
    }
    if (explicitDiscountedBand(config, now) && liveImportSafety.available && !liveExportNeedsHeadroom) {
      await updateActiveAdaptiveChargingObjective(state, state.plan, now, executeAdaptiveChargingAction, soc);
    }
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
      }
      else if (activePlanStopReason) stopReason = activePlanStopReason;
      else if (!liveImportSafety.available) {
        const interruption = breakerReserveInterrupted
          ? preserveInterruptedAdaptiveCharge(state, now)
          : null;
        if (interruption) {
          recordAdaptiveChargingWindowInterruption(state, now);
          beginAdaptiveChargingBreakerRecovery(state, adaptiveChargingLiveChargeHeadroom(status, config, state, rules), now);
        }
        const importText = Number.isFinite(liveImportSafety.gridImportW)
          ? `${Math.round(liveImportSafety.gridImportW)} W`
          : "unavailable";
        const limitText = Number.isFinite(liveImportSafety.breakerLimitW)
          ? `${Math.round(liveImportSafety.breakerLimitW)} W`
          : "unavailable";
        stopReason = interruption
          ? `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText}) after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
          : `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText})`;
      }
      else if (liveExportNeedsHeadroom) {
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
          await suspendAdaptiveChargeInStandby(state, stopReason, now);
        } else if (holdStandbyUntilWindowEnd) {
          await suspendAdaptiveChargeInStandby(
            state,
            stopReason,
            now,
            null,
            executeAdaptiveChargingAction,
            completedSlot?.windowEnd,
          );
        } else {
          await releaseAdaptiveCharge(state, stopReason, now);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        appendAdaptiveChargingLog(
          state,
          `Failed to stop active charge after ${stopReason.toLowerCase()}: ${message}; will retry on the next check`,
          "error",
          now,
        );
        state.lastResult = {
          ok: false,
          at: now.toISOString(),
          error: message,
          kind: "charge-stop-retry",
          reason: stopReason.toLowerCase(),
        };
        return writeAdaptiveChargingState(state);
      }
      if (activeEnergyTargetReached || activeSocTargetReached) {
        state.plan = consumeCompletedAdaptiveChargingSlot(state.plan, completedSlot) as typeof state.plan;
        state.interruptedCharge = null;
        state.breakerRecovery = null;
      }
    } else if (state.owner === "adaptiveCharging" && state.activePlanCreatedAt !== state.plan.createdAt) {
      const replacement = adaptiveChargingSlotAt(state.plan, now);
      state.activeSlot = {
        ...state.activeSlot,
        ...replacement,
        targetWh: Number(state.activeSlot?.targetWh),
      } as typeof state.activeSlot;
      state.activePlanCreatedAt = state.plan.createdAt ?? null;
    }

    // All override, telemetry, SOC, tariff, and live safety stop checks above
    // must run before idle recovery can release or restart device control.
    if (liveImportSafety.available && !liveExportNeedsHeadroom) {
      await recoverIdleAdaptiveCharge(state, status, now);
    }
    const plannedSlot = explicitDiscountedBand(config, now) ? adaptiveChargingSlotAt(state.plan, now) : null;
    const slot = plannedSlot ? capAdaptiveChargingSlotToRemainingTime(
      plannedSlot,
      state.plan?.chargePerformance?.effectiveWatts ?? config.batteryCapabilities.maximumChargeWatts,
      now,
    ) : null;
    if (liveExportNeedsHeadroom && slot?.windowEnd) {
      state.solarHeadroomHoldUntil = slot.windowEnd;
      state.solarHeadroomClearChecks = 0;
    }
    const solarHeadroomHoldActive = Boolean(
      solarHeadroomHold.active
      || (state.solarHeadroomHoldUntil && new Date(state.solarHeadroomHoldUntil).getTime() > now.getTime()),
    );
    const standbyHoldActive = Boolean(
      state.standbyHoldUntil && new Date(state.standbyHoldUntil).getTime() > now.getTime(),
    );
    const slotTargetReached = slot
      && soc !== null && Number.isFinite(soc)
      && soc >= Number(slot.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
    if (slot && state.owner !== "adaptiveCharging" && !solarHeadroomHoldActive && !slotTargetReached) {
      const resumeFromStandby = Boolean(state.breakerRecovery || state.interruptedCharge || standbyHoldActive);
      const headroom = adaptiveChargingLiveChargeHeadroom(status, config, state, rules);
      if (!headroom.available) {
        if (!state.breakerRecovery) logAdaptiveChargingInitialHeadroomWait(state, headroom, now);
        if (state.breakerRecovery) {
          const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
          logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
        }
        if (activeDiscountedWindow) {
          await ensureDiscountedWindowStandby(
            state,
            status,
            activeDiscountedWindow.end,
            "Waiting for safe breaker headroom before planned charging",
            now,
          );
        }
        state.lastResult = {
          ok: true,
          at: now.toISOString(),
          skipped: "live grid import leaves insufficient breaker headroom",
          ...headroom,
        };
        return writeAdaptiveChargingState(state);
      }
      if (state.breakerRecovery) {
        const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
        if (!recoveryStatus.ready) {
          logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
          if (activeDiscountedWindow) {
            await ensureDiscountedWindowStandby(
              state,
              status,
              activeDiscountedWindow.end,
              "Waiting for stable breaker headroom before resuming planned charging",
              now,
            );
          }
          state.lastResult = {
            ok: true,
            at: now.toISOString(),
            skipped: "waiting for stable breaker headroom",
            ...headroom,
            ...recoveryStatus,
          };
          return writeAdaptiveChargingState(state);
        }
      }
      let result;
      try {
        result = await executeAdaptiveChargeStart(slot, { resumeFromStandby });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (activeDiscountedWindow && !resumeFromStandby) {
          try {
            await ensureDiscountedWindowStandby(
              state,
              status,
              activeDiscountedWindow.end,
              "Planned charging could not start",
              now,
            );
          } catch (standbyError: unknown) {
            throw new AggregateError(
              [error, standbyError],
              `${message}; failed to prevent discounted-window discharge after the charge start failed`,
              { cause: standbyError },
            );
          }
        }
        appendAdaptiveChargingLog(
          state,
          resumeFromStandby
            ? `Failed to resume charging: ${message}; maintaining Standby operation mode`
            : `Failed to start charging: ${message}`,
          "error",
          now,
        );
        state.lastResult = { ok: false, at: now.toISOString(), error: message };
        await writeAdaptiveChargingState(state);
        throw error;
      }
      state.owner = "adaptiveCharging";
      state.activeSlot = { ...slot, deviceTargetWh: slot.targetWh } as typeof state.activeSlot;
      state.activePlanCreatedAt = state.plan?.createdAt ?? null;
      state.activeChargedKwh = 0;
      state.activeLastCheckedAt = now.toISOString();
      startAdaptiveChargeSession(state, slot as Parameters<typeof startAdaptiveChargeSession>[1], soc, now);
      state.interruptedCharge = null;
      completeAdaptiveChargingWindowInterruption(state, now);
      state.breakerRecovery = null;
      state.standbyHoldUntil = null;
      state.lastHeadroomWaitLogAt = null;
      state.lastResult = { ok: true, at: now.toISOString(), kind: "charge", slot, result };
      const startImportText = Number.isFinite(headroom.gridImportW) ? `${Math.round(headroom.gridImportW)} W` : "unavailable";
      const startThresholdText = Number.isFinite(headroom.thresholdW) ? `${Math.round(headroom.thresholdW)} W` : "unrestricted";
      const startLimitText = Number.isFinite(headroom.breakerLimitW) ? `${Math.round(headroom.breakerLimitW)} W` : "unavailable";
      appendAdaptiveChargingLog(
        state,
        `${resumeFromStandby ? "Resuming directly from Standby with" : "Starting"} ${slot.targetWh} Wh charge in ${slot.label} band at ${slot.yenPerKwh} yen/kWh; Grid Import (${startImportText}) is at or below start threshold (${startThresholdText}) from Charging Demand Guard limit (${startLimitText})`,
        "charge",
        now,
      );
    } else if (activeDiscountedWindow
      && state.owner !== "adaptiveCharging"
      && solarResponsiveWindow
      && !slotTargetReached
      && !activeWindowTargetReached) {
      await ensureSolarWindowAuto(state, status, now);
      state.lastResult = {
        ok: true,
        at: now.toISOString(),
        skipped: "observing solar-capable window before planned charging",
        solarOpportunity,
        socDropSinceWindowStart: Math.max(0, solarWindowSocDrop),
      };
    } else if (activeDiscountedWindow && state.owner !== "adaptiveCharging") {
      const reason = slot && solarHeadroomHoldActive
        ? "Planned charging is paused while solar export preserves battery headroom"
        : (slot && slotTargetReached) || activeWindowTargetReached
          ? "The discounted-window SOC target is already reached"
          : solarWindowDischargeBudgetExceeded
            ? `The solar-window discharge budget of ${ADAPTIVE_CHARGING_SOLAR_WINDOW_DISCHARGE_BUDGET_PERCENT}% SOC was reached`
            : "Waiting for the next planned charge in the discounted window";
      await ensureDiscountedWindowStandby(state, status, activeDiscountedWindow.end, reason, now);
      state.lastResult = {
        ok: true,
        at: now.toISOString(),
        skipped: slot && solarHeadroomHoldActive
          ? "solar export requires battery headroom for the rest of this window"
          : (slot && slotTargetReached) || activeWindowTargetReached
            ? "window SOC target already reached"
            : solarWindowDischargeBudgetExceeded
              ? "solar-window discharge budget reached; holding standby until planned charging is due"
              : "holding standby until planned discounted charging is due",
        ...(solarWindowDischargeBudgetExceeded ? {
          solarOpportunity,
          socDropSinceWindowStart: Math.max(0, solarWindowSocDrop),
        } : {}),
      };
    } else if (!slot && state.owner !== "adaptiveCharging") {
      state.lastResult = { ok: true, at: now.toISOString(), skipped: "no planned charge is due" };
    }
    finalizeExpiredAdaptiveChargingWindow(state, soc, now);
    return writeAdaptiveChargingState(state);
  }
}
