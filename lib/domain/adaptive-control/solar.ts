import { ADAPTIVE_CHARGING_MIN_SOLAR_WH, ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_WH, ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_W, ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS, ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS, ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS, ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W, ControlStatus, ExportEvidence, PlanLike, StateLike } from "./shared.js";
import { batteryChargingWatts } from "../automation-rules.js";
import { finiteNumberOrNull } from "../numbers.js";
import { selectedFuelCellReading, numericMetric } from "../telemetry.js";

export function adaptiveChargingWindowSolarOpportunity(
  plan: PlanLike | null | undefined,
  occurrence: { start?: string; end?: string } | null | undefined,
) {
  const windowStartMs = new Date(String(occurrence?.start ?? "")).getTime();
  const windowEndMs = new Date(String(occurrence?.end ?? "")).getTime();
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
    return { available: false, predictedSolarWh: 0, predictedSurplusWh: 0, peakSurplusW: 0 };
  }
  let predictedSolarWh = 0;
  let predictedSurplusWh = 0;
  let peakSurplusW = 0;
  const fuelCellActive = plan?.fuelCellModel?.influence === "active";
  for (const interval of plan?.timeline ?? []) {
    const intervalStartMs = new Date(String(interval.start ?? "")).getTime();
    const intervalEndMs = new Date(String(interval.end ?? "")).getTime();
    if (!Number.isFinite(intervalStartMs) || !Number.isFinite(intervalEndMs)) continue;
    const overlapMs = Math.max(0, Math.min(windowEndMs, intervalEndMs) - Math.max(windowStartMs, intervalStartMs));
    if (!overlapMs) continue;
    const durationHours = overlapMs / 3_600_000;
    const solarW = Math.max(0, Number(interval.solarW) || 0);
    const fuelCellW = fuelCellActive ? Math.max(0, Number(interval.fuelCellP20W) || 0) : 0;
    const demandW = Math.max(0, Number(interval.demandW) || 0);
    const surplusW = Math.max(0, solarW + fuelCellW - demandW);
    predictedSolarWh += solarW * durationHours;
    predictedSurplusWh += surplusW * durationHours;
    peakSurplusW = Math.max(peakSurplusW, surplusW);
  }
  return {
    available: predictedSolarWh >= ADAPTIVE_CHARGING_MIN_SOLAR_WH
      && predictedSurplusWh >= ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_WH
      && peakSurplusW >= ADAPTIVE_CHARGING_MIN_SOLAR_SURPLUS_W,
    predictedSolarWh: Math.round(predictedSolarWh),
    predictedSurplusWh: Math.round(predictedSurplusWh),
    peakSurplusW: Math.round(peakSurplusW),
  };
}

export function updateAdaptiveChargingSolarHeadroomHold(state: StateLike, liveExportNeedsHeadroom: boolean, now: Date = new Date()) {
  const holdUntil = state.solarHeadroomHoldUntil;
  if (!holdUntil) {
    state.solarHeadroomClearChecks = 0;
    return { active: false, released: false, expired: false };
  }

  const holdUntilMs = new Date(holdUntil).getTime();
  if (!Number.isFinite(holdUntilMs) || holdUntilMs <= now.getTime()) {
    state.solarHeadroomHoldUntil = null;
    state.solarHeadroomClearChecks = 0;
    return { active: false, released: false, expired: true };
  }

  if (liveExportNeedsHeadroom) {
    state.solarHeadroomClearChecks = 0;
    return { active: true, released: false, expired: false };
  }

  state.solarHeadroomClearChecks = Math.max(0, Number(state.solarHeadroomClearChecks) || 0) + 1;
  if (state.solarHeadroomClearChecks < ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS) {
    return { active: true, released: false, expired: false };
  }

  state.solarHeadroomHoldUntil = null;
  state.solarHeadroomClearChecks = 0;
  return { active: false, released: true, expired: false };
}

export function adaptiveChargingExportEvidence(status: ControlStatus): ExportEvidence {
  const gridExportW = numericMetric(status.meter?.grid_export_power);
  const gridImportW = numericMetric(status.meter?.grid_import_power);
  const branchDemandW = numericMetric(status.meter?.branch_demand_power);
  const batteryChargingW = batteryChargingWatts(status);
  const batteryNetW = numericMetric(status.energy?.battery?.instant_power);
  const solarW = numericMetric(status.energy?.solar?.instant_power);
  const fuelCellW = numericMetric(selectedFuelCellReading(status.energy?.fuel_cells ?? [])?.instant_power);
  const aboveThreshold = gridExportW !== null && Number.isFinite(gridExportW) && gridExportW > ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W;
  const balanceAvailable = [gridImportW, branchDemandW, batteryNetW, solarW]
    .every(Number.isFinite);
  if (!aboveThreshold) {
    return { aboveThreshold: false, balanceAvailable, coherent: false, gridExportW, residualW: null };
  }
  if (!balanceAvailable) {
    return { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW, residualW: null };
  }
  if (gridImportW === null || gridExportW === null || branchDemandW === null || batteryNetW === null || solarW === null) {
    return { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW, residualW: null };
  }
  const fuelCellContributionW = fuelCellW !== null && Number.isFinite(fuelCellW) ? fuelCellW : 0;
  // Use the signed battery power so discharge is included in the balance.
  const expectedGridW = branchDemandW + batteryNetW - solarW - fuelCellContributionW;
  const measuredGridW = gridImportW - gridExportW;
  const residualW = Math.abs(expectedGridW - measuredGridW);
  const toleranceW = Math.max(300, Math.max(Math.abs(expectedGridW), Math.abs(measuredGridW)) * 0.25);
  return {
    aboveThreshold: true,
    balanceAvailable: true,
    coherent: expectedGridW < -ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W && residualW <= toleranceW,
    gridExportW,
    gridImportW,
    branchDemandW,
    batteryChargingW,
    solarW,
    fuelCellW,
    expectedGridW,
    measuredGridW,
    residualW,
    toleranceW,
  };
}

export function updateAdaptiveChargingExportConfirmation(state: StateLike, evidence: Partial<ExportEvidence>, now: Date = new Date()) {
  const current = state.exportConfirmation ?? {};
  if (!evidence.aboveThreshold) {
    const cleared = Number(current.count) > 0;
    state.exportConfirmation = {
      count: 0,
      coherent: false,
      firstSeenAt: null,
      lastSeenAt: now.toISOString(),
      lastRejectedAt: current.lastRejectedAt ?? null,
      lastRejectedLogAt: current.lastRejectedLogAt ?? null,
      lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
      lastBalanceResidualW: null,
    };
    return { confirmed: false, pending: false, rejected: false, cleared, requiredChecks: 0 };
  }
  if (evidence.balanceAvailable && !evidence.coherent) {
    state.exportConfirmation = {
      count: 0,
      coherent: false,
      firstSeenAt: null,
      lastSeenAt: now.toISOString(),
      lastRejectedAt: now.toISOString(),
      lastRejectedLogAt: current.lastRejectedLogAt ?? null,
      lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
      lastBalanceResidualW: finiteNumberOrNull(evidence.residualW),
    };
    return {
      confirmed: false,
      pending: false,
      rejected: true,
      cleared: false,
      requiredChecks: ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS,
    };
  }
  const coherent = evidence.coherent === true;
  const compatibleSequence = Number(current.count) > 0 && current.coherent === coherent;
  const count = compatibleSequence ? Number(current.count) + 1 : 1;
  const requiredChecks = coherent
    ? ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS
    : ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS;
  state.exportConfirmation = {
    count,
    coherent,
    firstSeenAt: compatibleSequence ? current.firstSeenAt : now.toISOString(),
    lastSeenAt: now.toISOString(),
    lastRejectedAt: current.lastRejectedAt ?? null,
    lastRejectedLogAt: current.lastRejectedLogAt ?? null,
    lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
    lastBalanceResidualW: finiteNumberOrNull(evidence.residualW),
  };
  return {
    confirmed: count >= requiredChecks,
    pending: count < requiredChecks,
    rejected: false,
    cleared: false,
    count,
    requiredChecks,
    coherent,
  };
}
