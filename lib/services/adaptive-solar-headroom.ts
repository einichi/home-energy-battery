import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import {
  adaptiveChargingExportEvidence,
  adaptiveChargingWindowSolarOpportunity,
  updateAdaptiveChargingExportConfirmation,
  updateAdaptiveChargingSolarHeadroomHold,
} from "../domain/adaptive-control.js";
import { appendAdaptiveChargingLog } from "../domain/adaptive-state.js";
import { discountedBandOccurrence } from "../domain/tariffs.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";

type DiscountedWindow = NonNullable<ReturnType<typeof discountedBandOccurrence>>;
type SolarOpportunity = ReturnType<typeof adaptiveChargingWindowSolarOpportunity>;
export const ADAPTIVE_CHARGING_SOLAR_WINDOW_DISCHARGE_BUDGET_PERCENT = 2;

export interface AdaptiveSolarHeadroomResult {
  solarOpportunity: SolarOpportunity;
  solarWindowSocDrop: number;
  solarWindowDischargeBudgetExceeded: boolean;
  solarResponsiveWindow: boolean;
  activeWindowTargetReached: boolean;
  liveExportNeedsHeadroom: boolean;
  solarHeadroomHold: ReturnType<typeof updateAdaptiveChargingSolarHeadroomHold>;
}

export async function evaluateAdaptiveSolarHeadroom(
  state: AdaptiveChargingState,
  status: AdaptiveEvaluationStatus,
  activeDiscountedWindow: DiscountedWindow | null,
  soc: number | null,
  now: Date,
  breakerWaitLogMs: number,
  executeAction: (action: string, payload: Record<string, unknown>) => Promise<unknown>,
): Promise<AdaptiveSolarHeadroomResult> {
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
    ? state.plan?.windows?.find((window) => window.start === activeDiscountedWindow.start
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
    if (!Number.isFinite(lastRejectedLogMs) || now.getTime() - lastRejectedLogMs >= breakerWaitLogMs) {
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
    await executeAction("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Live grid export indicates solar needs battery headroom; releasing Standby hold and restoring operation mode to Auto",
      "stop",
      now,
    );
    state.standbyHoldUntil = null;
  }
  return {
    solarOpportunity,
    solarWindowSocDrop,
    solarWindowDischargeBudgetExceeded,
    solarResponsiveWindow,
    activeWindowTargetReached,
    liveExportNeedsHeadroom,
    solarHeadroomHold,
  };
}
