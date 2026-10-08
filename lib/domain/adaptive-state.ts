import { BATTERY_LEARNING_MODEL_VERSION, cleanBatteryLearningModel } from "./battery-learning.js";
import type { BatteryLearningModel } from "./battery-learning.js";
import { discountedPlanStatus } from "./adaptive-planning.js";
import type { AdaptiveChargeSlot } from "./adaptive-planning.js";
import type { SolarForecast, SolarForecastAccuracy, SolarForecastHour } from "./solar-forecast.js";
import { batteryChargingWatts } from "./automation-rules.js";
import { finiteNumberOrNull } from "./numbers.js";
import { median } from "./statistics.js";
import { numericMetric } from "./telemetry.js";

const ADAPTIVE_CHARGE_SESSION_LIMIT = 30;
const ADAPTIVE_CHARGE_SAMPLE_LIMIT = 500;
const ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT = 30;

export interface AdaptivePlanWindow {
  start: string;
  end: string;
  label?: string;
  targetSocPercent?: number | null;
  plannedChargeKwh?: number;
  plannedStoredChargeKwh?: number;
  requestedChargeKwh?: number;
  unmetChargeKwh?: number;
  schedulingWatts?: number;
  timingReserveMs?: number;
  schedulingSource?: string;
  guardDeliverability?: {
    learned?: boolean;
    sampleCount?: number;
    interruptedSampleCount?: number;
    distinctDays?: number;
    deliveryFactor?: number;
    observedDeliveryRatio?: number;
    recoveryTimeFactor?: number;
    interruptionReserveMs?: number;
    blockers?: string[];
  };
}

export interface AdaptivePlan {
  [key: string]: unknown;
  available?: boolean;
  reason?: string | null;
  warning?: string | null;
  createdAt?: string;
  forecastFetchedAt?: string | null;
  plannedChargeKwh?: number;
  requiredGridChargeKwh?: number;
  unmetChargeKwh?: number;
  chargePerformance?: { effectiveWatts?: number };
  batteryModel?: {
    version?: number;
    chargeToStoredRatio?: number;
    charge?: { whPerSocPoint?: number; source?: string };
    discharge?: { whPerSocPoint?: number; source?: string };
    power?: { effectiveWatts?: number; source?: string };
  };
  demandHistory?: {
    awaySlotCount?: number;
    awayConfidence?: string;
    awayComparableDayCount?: number;
    awayFallbackSlotCount?: number;
  };
  fuelCellModel?: { method?: string; influence?: string; blockers?: string[] } | null;
  timeline?: Array<{
    start: string;
    end: string;
    solarW?: number;
    fuelCellP20W?: number;
    fuelCellMedianW?: number;
    fuelCellP80W?: number;
    fuelCellSampleCount?: number;
    demandW?: number;
  }>;
  predictedFuelCellKwh?: number;
  predictedSolarKwh?: number;
  predictedDemandKwh?: number;
  currentSocPercent?: number;
  slots: AdaptiveChargeSlot[];
  windows?: AdaptivePlanWindow[];
}
type AdaptiveLogKind = string;

interface AdaptiveLogEntry {
  at: string;
  kind: AdaptiveLogKind;
  message: string;
}

export interface AdaptiveChargePerformanceSample {
  at: string;
  batteryChargingW: number;
  socPercent: number | null;
  branchDemandW: number | null;
  gridImportW: number | null;
}

export interface AdaptiveChargePerformanceSession {
  startedAt: string;
  endedAt: string;
  reason: string | null;
  requestedWh: number;
  deliveredWh: number;
  startSocPercent: number | null;
  endSocPercent: number | null;
  socDeltaPercent: number | null;
  averageChargeWatts: number | null;
  estimatedDeliveryWh: number;
  modelVersion: number;
}

export interface AdaptiveChargingPerformance {
  samples: AdaptiveChargePerformanceSample[];
  sessions: AdaptiveChargePerformanceSession[];
  sampleCount: number;
  sessionCount: number;
  learnedChargeWatts: number | null;
  demandImpactWattsPerKw: number | null;
}

export interface ActiveChargeSession {
  startedAt: string | null;
  requestedWh: number;
  startSocPercent: number | null;
  latestSocPercent: number | null;
  latestChargingW: number | null;
  lastSampleAt: string | null;
  idleSince?: string | null;
  idleCheckedAt?: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  label: string | null;
}

export interface InterruptedCharge {
  slotId: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  remainingWh: number;
  deliveredWh: number;
  interruptedAt: string | null;
}

export interface BreakerRecovery {
  interruptedAt: string;
  cooldownUntil: string | null;
  consecutiveSafeChecks: number;
  lastCheckedAt: string | null;
  lastWaitLogAt: string | null;
  currentImportW: number | null;
  thresholdW: number | null;
  chargeWatts: number | null;
  safetyMarginW: number | null;
}

interface WindowExecution {
  key: string;
  windowStart: string | null;
  windowEnd: string | null;
  label: string | null;
  yenPerKwh: number | null;
  plannedWh: number;
  deliveredWh: number;
  estimatedDeliveryWh: number;
  interruptionCount: number;
  guardInterruptedMs: number;
  guardInterruptionStartedAt: string | null;
  solarHeadroomInterruptionCount: number;
  startSocPercent: number | null;
  latestSocPercent: number | null;
  peakSocPercent: number | null;
  targetSocPercent: number | null;
  idleRecoveryCount: number;
  startedTrackingAt: string | null;
  updatedAt: string | null;
}

export interface WindowSummary extends Omit<WindowExecution, "latestSocPercent" | "peakSocPercent" | "guardInterruptionStartedAt" | "idleRecoveryCount" | "startedTrackingAt" | "updatedAt"> {
  unmetWh: number;
  socTargetReached: boolean;
  endSocPercent: number | null;
  completedAt: string | null;
  reason: string | null;
  modelVersion: number;
}

export interface ExportConfirmation {
  count: number;
  coherent: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRejectedAt: string | null;
  lastRejectedLogAt: string | null;
  lastGridExportW: number | null;
  lastBalanceResidualW: number | null;
}

export interface AdaptiveChargingState {
  [key: string]: unknown;
  revision: number;
  forecast: SolarForecast | null;
  plan: AdaptivePlan | null;
  owner: "adaptiveCharging" | null;
  activeSlot: (AdaptiveChargeSlot & { start: string; end: string; windowStart: string; windowEnd: string }) | null;
  activePlanCreatedAt: string | null;
  activeChargedKwh: number;
  activeLastCheckedAt: string | null;
  standbyHoldUntil: string | null;
  activeChargeSession: ActiveChargeSession | null;
  chargingPerformance: AdaptiveChargingPerformance;
  batteryLearning: BatteryLearningModel;
  lastPlanEventKey: string | null;
  pendingPlanReason: string | null;
  pendingPlanRequestId: string | null;
  pendingPlanRequestedAt: string | null;
  interruptedCharge: InterruptedCharge | null;
  breakerRecovery: BreakerRecovery | null;
  lastHeadroomWaitLogAt: string | null;
  activeWindowExecution: WindowExecution | null;
  windowSummaries: WindowSummary[];
  pausedUntil: string | null;
  solarHeadroomHoldUntil: string | null;
  solarHeadroomClearChecks: number;
  exportConfirmation: ExportConfirmation;
  lastResult: Record<string, unknown> | null;
  lastForecastError: Record<string, unknown> | null;
  historicalWeatherFetchedAt: string | null;
  lastAwayStateKey: string | null;
  log: AdaptiveLogEntry[];
  updatedAt: string;
  historicalWeather?: SolarForecastHour[];
  solarForecastAccuracy?: SolarForecastAccuracy & { sampleCount?: number; measuredFactor?: unknown };
}

interface AdaptiveStatus {
  [key: string]: unknown;
  energy?: { battery?: { remaining_percent?: { value?: unknown }; instant_power?: { value?: unknown } } };
  meter?: { branch_demand_power?: { value?: unknown }; grid_import_power?: { value?: unknown } };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}


export function cleanAdaptiveChargingState(): AdaptiveChargingState;
export function cleanAdaptiveChargingState<T extends Record<string, unknown>>(input: T): AdaptiveChargingState & T;
export function cleanAdaptiveChargingState(input: unknown = {}): AdaptiveChargingState {
  const value = record(input);
  const rawPlan = value.plan && typeof value.plan === "object" ? value.plan as AdaptivePlan : null;
  const plan = rawPlan?.available === false
    && rawPlan.reason === "discounted windows cannot safely reach their planned SOC targets"
    && Number(rawPlan.plannedChargeKwh) > 0
    ? { ...rawPlan, ...discountedPlanStatus({
      plannedChargeKwh: Number(rawPlan.plannedChargeKwh),
      unmetChargeKwh: Number(rawPlan.unmetChargeKwh),
      requiredGridChargeKwh: Number(rawPlan.requiredGridChargeKwh),
    }) }
    : rawPlan;
  const activeChargeSession = record(value.activeChargeSession);
  const interruptedCharge = record(value.interruptedCharge);
  const breakerRecovery = record(value.breakerRecovery);
  const activeWindowExecution = record(value.activeWindowExecution);
  const exportConfirmation = record(value.exportConfirmation);
  return {
    revision: Math.max(0, Math.floor(Number(value.revision) || 0)),
    forecast: value.forecast && typeof value.forecast === "object" ? value.forecast as SolarForecast : null,
    plan,
    owner: value.owner === "adaptiveCharging" ? "adaptiveCharging" : null,
    activeSlot: value.activeSlot && typeof value.activeSlot === "object"
      ? value.activeSlot as AdaptiveChargingState["activeSlot"]
      : null,
    activePlanCreatedAt: stringOrNull(value.activePlanCreatedAt),
    activeChargedKwh: Math.max(0, Number(value.activeChargedKwh) || 0),
    activeLastCheckedAt: stringOrNull(value.activeLastCheckedAt),
    standbyHoldUntil: stringOrNull(value.standbyHoldUntil),
    activeChargeSession: value.activeChargeSession ? {
      startedAt: stringOrNull(activeChargeSession.startedAt),
      requestedWh: Math.max(0, Math.round(Number(activeChargeSession.requestedWh) || 0)),
      startSocPercent: finiteNumberOrNull(activeChargeSession.startSocPercent),
      latestSocPercent: finiteNumberOrNull(activeChargeSession.latestSocPercent),
      latestChargingW: finiteNumberOrNull(activeChargeSession.latestChargingW),
      lastSampleAt: stringOrNull(activeChargeSession.lastSampleAt),
      idleSince: stringOrNull(activeChargeSession.idleSince),
      idleCheckedAt: stringOrNull(activeChargeSession.idleCheckedAt),
      slotStart: stringOrNull(activeChargeSession.slotStart),
      slotEnd: stringOrNull(activeChargeSession.slotEnd),
      label: stringOrNull(activeChargeSession.label),
    } : null,
    chargingPerformance: cleanAdaptiveChargingPerformance(value.chargingPerformance),
    batteryLearning: cleanBatteryLearningModel(value.batteryLearning),
    lastPlanEventKey: stringOrNull(value.lastPlanEventKey),
    pendingPlanReason: stringOrNull(value.pendingPlanReason),
    pendingPlanRequestId: stringOrNull(value.pendingPlanRequestId)
      ?? (value.pendingPlanReason ? `legacy:${value.pendingPlanReason}` : null),
    pendingPlanRequestedAt: stringOrNull(value.pendingPlanRequestedAt),
    interruptedCharge: value.interruptedCharge
      && Number.isFinite(Number(interruptedCharge.remainingWh))
      && Number(interruptedCharge.remainingWh) > 0
      ? {
        slotId: stringOrNull(interruptedCharge.slotId),
        slotStart: stringOrNull(interruptedCharge.slotStart),
        slotEnd: stringOrNull(interruptedCharge.slotEnd),
        windowStart: stringOrNull(interruptedCharge.windowStart),
        windowEnd: stringOrNull(interruptedCharge.windowEnd),
        remainingWh: Math.max(1, Math.round(Number(interruptedCharge.remainingWh))),
        deliveredWh: Math.max(0, Math.round(Number(interruptedCharge.deliveredWh) || 0)),
        interruptedAt: stringOrNull(interruptedCharge.interruptedAt),
      }
      : null,
    breakerRecovery: breakerRecovery.interruptedAt
      ? {
        interruptedAt: String(breakerRecovery.interruptedAt),
        cooldownUntil: stringOrNull(breakerRecovery.cooldownUntil),
        consecutiveSafeChecks: Math.max(0, Math.round(Number(breakerRecovery.consecutiveSafeChecks) || 0)),
        lastCheckedAt: stringOrNull(breakerRecovery.lastCheckedAt),
        lastWaitLogAt: stringOrNull(breakerRecovery.lastWaitLogAt),
        currentImportW: finiteNumberOrNull(breakerRecovery.currentImportW),
        thresholdW: finiteNumberOrNull(breakerRecovery.thresholdW),
        chargeWatts: finiteNumberOrNull(breakerRecovery.chargeWatts),
        safetyMarginW: finiteNumberOrNull(breakerRecovery.safetyMarginW),
      }
      : null,
    lastHeadroomWaitLogAt: stringOrNull(value.lastHeadroomWaitLogAt),
    activeWindowExecution: activeWindowExecution.key
      ? {
        key: String(activeWindowExecution.key),
        windowStart: stringOrNull(activeWindowExecution.windowStart),
        windowEnd: stringOrNull(activeWindowExecution.windowEnd),
        label: stringOrNull(activeWindowExecution.label),
        yenPerKwh: finiteNumberOrNull(activeWindowExecution.yenPerKwh),
        plannedWh: Math.max(0, Math.round(Number(activeWindowExecution.plannedWh) || 0)),
        deliveredWh: Math.max(0, Math.round(Number(activeWindowExecution.deliveredWh) || 0)),
        estimatedDeliveryWh: Math.max(0, Math.round(Number(activeWindowExecution.estimatedDeliveryWh) || 0)),
        interruptionCount: Math.max(0, Math.round(Number(activeWindowExecution.interruptionCount) || 0)),
        guardInterruptedMs: Math.max(0, Math.round(Number(activeWindowExecution.guardInterruptedMs) || 0)),
        guardInterruptionStartedAt: stringOrNull(activeWindowExecution.guardInterruptionStartedAt),
        solarHeadroomInterruptionCount: Math.max(
          0,
          Math.round(Number(activeWindowExecution.solarHeadroomInterruptionCount) || 0),
        ),
        startSocPercent: finiteNumberOrNull(activeWindowExecution.startSocPercent),
        latestSocPercent: finiteNumberOrNull(activeWindowExecution.latestSocPercent),
        peakSocPercent: finiteNumberOrNull(activeWindowExecution.peakSocPercent)
          ?? finiteNumberOrNull(activeWindowExecution.startSocPercent),
        targetSocPercent: finiteNumberOrNull(activeWindowExecution.targetSocPercent),
        idleRecoveryCount: Math.max(0, Math.round(Number(activeWindowExecution.idleRecoveryCount) || 0)),
        startedTrackingAt: stringOrNull(activeWindowExecution.startedTrackingAt),
        updatedAt: stringOrNull(activeWindowExecution.updatedAt),
      }
      : null,
    windowSummaries: (Array.isArray(value.windowSummaries) ? value.windowSummaries : [])
      .map(record)
      .filter((summary) => summary.key && summary.windowStart && summary.windowEnd)
      .map((summary) => ({
        key: String(summary.key),
        windowStart: String(summary.windowStart),
        windowEnd: String(summary.windowEnd),
        label: stringOrNull(summary.label),
        yenPerKwh: finiteNumberOrNull(summary.yenPerKwh),
        plannedWh: Math.max(0, Math.round(Number(summary.plannedWh) || 0)),
        deliveredWh: Math.max(0, Math.round(Number(summary.deliveredWh) || 0)),
        estimatedDeliveryWh: Math.max(0, Math.round(Number(summary.estimatedDeliveryWh) || 0)),
        unmetWh: Math.max(0, Math.round(Number(summary.unmetWh) || 0)),
        targetSocPercent: finiteNumberOrNull(summary.targetSocPercent),
        socTargetReached: summary.socTargetReached === true,
        interruptionCount: Math.max(0, Math.round(Number(summary.interruptionCount) || 0)),
        guardInterruptedMs: Math.max(0, Math.round(Number(summary.guardInterruptedMs) || 0)),
        solarHeadroomInterruptionCount: Math.max(
          0,
          Math.round(Number(summary.solarHeadroomInterruptionCount) || 0),
        ),
        startSocPercent: finiteNumberOrNull(summary.startSocPercent),
        endSocPercent: finiteNumberOrNull(summary.endSocPercent),
        completedAt: stringOrNull(summary.completedAt),
        reason: stringOrNull(summary.reason),
        modelVersion: Number(summary.modelVersion) || BATTERY_LEARNING_MODEL_VERSION,
      }))
      .slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT),
    pausedUntil: stringOrNull(value.pausedUntil),
    solarHeadroomHoldUntil: stringOrNull(value.solarHeadroomHoldUntil),
    solarHeadroomClearChecks: Math.max(0, Math.round(Number(value.solarHeadroomClearChecks) || 0)),
    exportConfirmation: {
      count: Math.max(0, Math.round(Number(exportConfirmation.count) || 0)),
      coherent: exportConfirmation.coherent === true,
      firstSeenAt: stringOrNull(exportConfirmation.firstSeenAt),
      lastSeenAt: stringOrNull(exportConfirmation.lastSeenAt),
      lastRejectedAt: stringOrNull(exportConfirmation.lastRejectedAt),
      lastRejectedLogAt: stringOrNull(exportConfirmation.lastRejectedLogAt),
      lastGridExportW: finiteNumberOrNull(exportConfirmation.lastGridExportW),
      lastBalanceResidualW: finiteNumberOrNull(exportConfirmation.lastBalanceResidualW),
    },
    lastResult: value.lastResult && typeof value.lastResult === "object" ? value.lastResult as Record<string, unknown> : null,
    lastForecastError: value.lastForecastError && typeof value.lastForecastError === "object"
      ? value.lastForecastError as Record<string, unknown>
      : null,
    historicalWeatherFetchedAt: stringOrNull(value.historicalWeatherFetchedAt),
    lastAwayStateKey: stringOrNull(value.lastAwayStateKey),
    log: (Array.isArray(value.log) ? value.log : []).map(record)
      .filter((entry) => typeof entry.at === "string" && typeof entry.message === "string")
      .map((entry) => ({ at: String(entry.at), kind: String(entry.kind ?? "info"), message: String(entry.message) }))
      .slice(-200),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}


export function cleanAdaptiveChargingPerformance(input: unknown = {}): AdaptiveChargingPerformance {
  const value = record(input);
  const samples = (Array.isArray(value.samples) ? value.samples : [])
    .map(record)
    .map((sample) => ({
      at: stringOrNull(sample.at),
      batteryChargingW: Number(sample.batteryChargingW),
      socPercent: finiteNumberOrNull(sample.socPercent),
      branchDemandW: sample.branchDemandW === null || sample.branchDemandW === undefined
        ? null
        : Number(sample.branchDemandW),
      gridImportW: sample.gridImportW === null || sample.gridImportW === undefined
        ? null
        : Number(sample.gridImportW),
    }))
    .filter((sample): sample is AdaptiveChargePerformanceSample => typeof sample.at === "string"
      && Number.isFinite(sample.batteryChargingW)
      && sample.batteryChargingW > 0)
    .slice(-ADAPTIVE_CHARGE_SAMPLE_LIMIT);
  const sessions = (Array.isArray(value.sessions) ? value.sessions : [])
    .map(record)
    .map((session) => ({
      startedAt: stringOrNull(session.startedAt),
      endedAt: stringOrNull(session.endedAt),
      reason: stringOrNull(session.reason),
      requestedWh: Math.max(0, Math.round(Number(session.requestedWh) || 0)),
      deliveredWh: Math.max(0, Math.round(Number(session.deliveredWh) || 0)),
      startSocPercent: finiteNumberOrNull(session.startSocPercent),
      endSocPercent: finiteNumberOrNull(session.endSocPercent),
      socDeltaPercent: finiteNumberOrNull(session.socDeltaPercent),
      averageChargeWatts: finiteNumberOrNull(session.averageChargeWatts),
      estimatedDeliveryWh: Math.max(0, Math.round(Number(session.estimatedDeliveryWh) || 0)),
      modelVersion: Number(session.modelVersion) || BATTERY_LEARNING_MODEL_VERSION,
    }))
    .filter((session): session is AdaptiveChargePerformanceSession => typeof session.startedAt === "string" && typeof session.endedAt === "string")
    .slice(-ADAPTIVE_CHARGE_SESSION_LIMIT);
  const chargingPowers = samples.map((sample) => sample.batteryChargingW).sort((left, right) => left - right);
  const upperQuartile = chargingPowers.slice(Math.floor(chargingPowers.length * 0.75));
  const learnedChargeWatts = chargingPowers.length >= 10 ? median(upperQuartile) : null;
  const demandPairs = samples.filter((sample) => Number.isFinite(sample.branchDemandW));
  let demandImpactWattsPerKw: number | null = null;
  if (demandPairs.length >= 10) {
    const meanDemand = demandPairs.reduce((sum, sample) => sum + Number(sample.branchDemandW), 0) / demandPairs.length;
    const meanCharge = demandPairs.reduce((sum, sample) => sum + sample.batteryChargingW, 0) / demandPairs.length;
    const variance = demandPairs.reduce((sum, sample) => sum + (Number(sample.branchDemandW) - meanDemand) ** 2, 0);
    if (variance > 0) {
      const covariance = demandPairs.reduce(
        (sum, sample) => sum + (Number(sample.branchDemandW) - meanDemand) * (sample.batteryChargingW - meanCharge),
        0,
      );
      demandImpactWattsPerKw = covariance / variance * 1000;
    }
  }
  return {
    samples,
    sessions,
    sampleCount: samples.length,
    sessionCount: sessions.length,
    learnedChargeWatts,
    demandImpactWattsPerKw,
  };
}


export function appendAdaptiveChargingLog(
  state: AdaptiveChargingState,
  message: string,
  kind: AdaptiveLogKind = "info",
  at: Date = new Date(),
): void {
  state.log = [
    ...(Array.isArray(state.log) ? state.log : []),
    { at: at.toISOString(), kind, message },
  ].slice(-200);
}


export function startAdaptiveChargeSession(
  state: AdaptiveChargingState,
  slot: AdaptiveChargeSlot | null | undefined,
  soc: unknown,
  now: Date = new Date(),
): void {
  state.activeChargeSession = {
    startedAt: now.toISOString(),
    requestedWh: Math.max(0, Math.round(Number(slot?.targetWh) || 0)),
    startSocPercent: finiteNumberOrNull(soc),
    latestSocPercent: finiteNumberOrNull(soc),
    latestChargingW: null,
    lastSampleAt: null,
    slotStart: slot?.start ?? null,
    slotEnd: slot?.end ?? null,
    label: slot?.label ?? null,
  };
}


export function adaptiveChargingWindowKey(window: {
  start?: string;
  end?: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  band?: { yenPerKwh?: unknown; label?: unknown };
  yenPerKwh?: unknown;
  label?: unknown;
} | null | undefined): string | null {
  const start = window?.start ?? window?.windowStart;
  const end = window?.end ?? window?.windowEnd;
  if (!start || !end) return null;
  return JSON.stringify([start, end, Number(window?.band?.yenPerKwh ?? window?.yenPerKwh), window?.band?.label ?? window?.label ?? null]);
}


export function adaptiveChargingWindowRemainingWh(
  plan: AdaptivePlan | null | undefined,
  window: { end?: string; windowEnd?: string | null } | null | undefined,
): number {
  const endMs = new Date(window?.end ?? window?.windowEnd ?? "").getTime();
  if (!Number.isFinite(endMs)) return 0;
  return (plan?.slots ?? [])
    .filter((slot) => new Date(slot.windowEnd ?? slot.end).getTime() === endMs)
    .reduce((sum, slot) => sum + Math.max(0, Math.round(Number(slot.targetWh) || 0)), 0);
}


export function finalizeAdaptiveChargingWindowExecution(
  state: AdaptiveChargingState,
  endSocPercent: unknown = null,
  now: Date = new Date(),
  reason = "discounted window ended",
): WindowSummary | null {
  const active = state.activeWindowExecution;
  if (!active) return null;
  const endSoc = Number.isFinite(finiteNumberOrNull(endSocPercent))
    ? finiteNumberOrNull(endSocPercent)
    : finiteNumberOrNull(active.latestSocPercent);
  const targetSocPercent = finiteNumberOrNull(active.targetSocPercent);
  const socTargetReached = Number.isFinite(endSoc) && Number.isFinite(targetSocPercent)
    && Number(endSoc) >= Number(targetSocPercent);
  const activeGuardStartedMs = new Date(active.guardInterruptionStartedAt ?? "").getTime();
  const additionalGuardInterruptedMs = Number.isFinite(activeGuardStartedMs)
    ? Math.max(0, now.getTime() - activeGuardStartedMs)
    : 0;
  const summary: WindowSummary = {
    key: active.key,
    windowStart: active.windowStart,
    windowEnd: active.windowEnd,
    label: active.label,
    yenPerKwh: active.yenPerKwh,
    plannedWh: active.plannedWh,
    deliveredWh: active.deliveredWh,
    estimatedDeliveryWh: Math.max(0, Math.round(Number(active.estimatedDeliveryWh) || 0)),
    unmetWh: Math.max(0, active.plannedWh - active.deliveredWh),
    targetSocPercent,
    socTargetReached,
    interruptionCount: active.interruptionCount,
    guardInterruptedMs: Math.max(0, Math.round(active.guardInterruptedMs + additionalGuardInterruptedMs)),
    solarHeadroomInterruptionCount: Math.max(
      0,
      Math.round(Number(active.solarHeadroomInterruptionCount) || 0),
    ),
    startSocPercent: active.startSocPercent,
    endSocPercent: endSoc,
    completedAt: now.toISOString(),
    reason,
    modelVersion: BATTERY_LEARNING_MODEL_VERSION,
  };
  state.windowSummaries = [
    ...state.windowSummaries.filter((item) => item.key !== summary.key),
    summary,
  ].slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT);
  state.activeWindowExecution = null;
  appendAdaptiveChargingLog(
    state,
    `${active.label || "Discounted window"} summary: ${summary.plannedWh} Wh planned, ${summary.deliveredWh} Wh delivered${summary.estimatedDeliveryWh > 0 ? ` (${summary.estimatedDeliveryWh} Wh estimated at exact boundaries)` : ""}, ${summary.unmetWh} Wh ${socTargetReached ? "unused (SOC target achieved)" : "unmet"}, ${summary.interruptionCount} breaker interruptions (${Math.round(summary.guardInterruptedMs / 60_000)} min), ${summary.solarHeadroomInterruptionCount} solar-headroom pauses, SOC ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%`,
    summary.unmetWh > 0 && !socTargetReached ? "warning" : "summary",
    now,
  );
  return summary;
}


export function syncAdaptiveChargingWindowExecution(
  state: AdaptiveChargingState,
  occurrence: { start: string; end: string; band?: { label?: string; yenPerKwh?: unknown } } | null,
  plan: AdaptivePlan | null,
  soc: unknown,
  now: Date = new Date(),
  planRecalculated = false,
): WindowExecution | null {
  if (!occurrence) return null;
  const key = adaptiveChargingWindowKey(occurrence);
  if (!key) return null;
  if (state.activeWindowExecution && state.activeWindowExecution.key !== key) {
    finalizeAdaptiveChargingWindowExecution(state, soc, now, "next discounted window started");
  }
  const remainingWh = adaptiveChargingWindowRemainingWh(plan, occurrence);
  const targetSocPercent = finiteNumberOrNull((plan?.windows ?? []).find(
    (window) => window.start === occurrence.start && window.end === occurrence.end,
  )?.targetSocPercent);
  const activeDeliveredWh = planRecalculated && state.owner === "adaptiveCharging"
    ? Math.max(0, Math.round(Number(state.activeChargedKwh) * 1000))
    : 0;
  if (!state.activeWindowExecution) {
    state.activeWindowExecution = {
      key,
      windowStart: occurrence.start,
      windowEnd: occurrence.end,
      label: occurrence.band?.label || "Discounted",
      yenPerKwh: Number(occurrence.band?.yenPerKwh),
      plannedWh: remainingWh,
      deliveredWh: 0,
      estimatedDeliveryWh: 0,
      interruptionCount: 0,
      guardInterruptedMs: 0,
      guardInterruptionStartedAt: null,
      solarHeadroomInterruptionCount: 0,
      startSocPercent: finiteNumberOrNull(soc),
      latestSocPercent: finiteNumberOrNull(soc),
      peakSocPercent: finiteNumberOrNull(soc),
      targetSocPercent,
      idleRecoveryCount: 0,
      startedTrackingAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  } else {
    state.activeWindowExecution.latestSocPercent = finiteNumberOrNull(soc);
    const nextSoc = finiteNumberOrNull(soc);
    if (nextSoc !== null) {
      state.activeWindowExecution.peakSocPercent = Math.max(
        nextSoc,
        state.activeWindowExecution.peakSocPercent ?? nextSoc,
      );
    }
    if (targetSocPercent !== null) state.activeWindowExecution.targetSocPercent = targetSocPercent;
    if (planRecalculated) {
      state.activeWindowExecution.plannedWh = state.activeWindowExecution.deliveredWh + activeDeliveredWh + remainingWh;
    }
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  return state.activeWindowExecution;
}


export function finalizeExpiredAdaptiveChargingWindow(
  state: AdaptiveChargingState,
  soc: unknown,
  now: Date = new Date(),
): WindowSummary | null {
  const active = state.activeWindowExecution;
  if (!active || state.owner === "adaptiveCharging") return null;
  const endMs = new Date(active.windowEnd ?? "").getTime();
  if (!Number.isFinite(endMs) || now.getTime() < endMs) return null;
  return finalizeAdaptiveChargingWindowExecution(state, soc, now);
}


export function recordAdaptiveChargingWindowInterruption(state: AdaptiveChargingState, now: Date = new Date()): number {
  if (!state.activeWindowExecution) return 0;
  if (!state.activeWindowExecution.guardInterruptionStartedAt) {
    state.activeWindowExecution.interruptionCount += 1;
    state.activeWindowExecution.guardInterruptionStartedAt = now.toISOString();
  }
  return state.activeWindowExecution.interruptionCount;
}


export function completeAdaptiveChargingWindowInterruption(state: AdaptiveChargingState, now: Date = new Date()): number {
  const execution = state.activeWindowExecution;
  if (!execution?.guardInterruptionStartedAt) return 0;
  const startedMs = new Date(execution.guardInterruptionStartedAt).getTime();
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : 0;
  execution.guardInterruptedMs = Math.max(0, execution.guardInterruptedMs + elapsedMs);
  execution.guardInterruptionStartedAt = null;
  return elapsedMs;
}


export function recordAdaptiveChargingSolarHeadroomInterruption(state: AdaptiveChargingState): number {
  if (!state.activeWindowExecution) return 0;
  state.activeWindowExecution.solarHeadroomInterruptionCount = Math.max(
    0,
    Math.round(Number(state.activeWindowExecution.solarHeadroomInterruptionCount) || 0),
  ) + 1;
  return state.activeWindowExecution.solarHeadroomInterruptionCount;
}


export function recordAdaptiveChargeSample(
  state: AdaptiveChargingState,
  status: AdaptiveStatus,
  now: Date = new Date(),
): boolean {
  if (state.owner !== "adaptiveCharging") return false;
  const observedChargingW = batteryChargingWatts(status);
  const batteryChargingW = observedChargingW ?? 0;
  if (state.activeLastCheckedAt) {
    const elapsedHours = Math.max(
      0,
      Math.min(0.1, (now.getTime() - new Date(state.activeLastCheckedAt).getTime()) / 3_600_000),
    );
    state.activeChargedKwh += batteryChargingW * elapsedHours / 1000;
  }
  state.activeLastCheckedAt = now.toISOString();
  const soc = numericMetric(status.energy?.battery?.remaining_percent);
  if (!state.activeChargeSession) startAdaptiveChargeSession(state, state.activeSlot, soc, now);
  const activeSession = state.activeChargeSession;
  if (!activeSession) return false;
  if (Number.isFinite(soc)) activeSession.latestSocPercent = soc;
  if (Number.isFinite(observedChargingW)) {
    activeSession.latestChargingW = observedChargingW;
    activeSession.lastSampleAt = now.toISOString();
  }
  if (batteryChargingW > 0) {
    const branchDemandW = numericMetric(status.meter?.branch_demand_power);
    const gridImportW = numericMetric(status.meter?.grid_import_power);
    state.chargingPerformance = cleanAdaptiveChargingPerformance({
      ...state.chargingPerformance,
      samples: [
        ...(state.chargingPerformance?.samples ?? []),
        { at: now.toISOString(), batteryChargingW, socPercent: soc, branchDemandW, gridImportW },
      ],
    });
  }
  return true;
}


export function adaptiveChargeBoundaryTailWh(
  state: AdaptiveChargingState,
  active: ActiveChargeSession,
  reason: string,
  now: Date = new Date(),
): number {
  if (!["Planned charging slot ended", "Planned discounted window ended"].includes(reason)) return 0;
  const chargingW = Number(active.latestChargingW);
  const lastSampleMs = new Date(active.lastSampleAt ?? "").getTime();
  const slotEndMs = new Date(active.slotEnd ?? "").getTime();
  if (!(chargingW > 0) || !Number.isFinite(lastSampleMs)) return 0;
  const estimateEndMs = Number.isFinite(slotEndMs)
    ? Math.min(now.getTime(), slotEndMs)
    : now.getTime();
  const elapsedMs = Math.max(0, estimateEndMs - lastSampleMs);
  const measuredWh = Math.max(0, Number(state.activeChargedKwh) * 1000);
  const remainingWh = Math.max(0, Number(active.requestedWh) - measuredWh);
  return Math.min(remainingWh, chargingW * elapsedMs / 3_600_000);
}


export function finalizeAdaptiveChargeSession(
  state: AdaptiveChargingState,
  reason: string,
  now: Date = new Date(),
): AdaptiveChargePerformanceSession | null {
  const active = state.activeChargeSession;
  if (!active) return null;
  const estimatedDeliveryWh = adaptiveChargeBoundaryTailWh(state, active, reason, now);
  const deliveredWh = Math.max(
    0,
    Math.round(Number(state.activeChargedKwh) * 1000 + estimatedDeliveryWh),
  );
  const startSocPercent = finiteNumberOrNull(active.startSocPercent);
  const endSocPercent = finiteNumberOrNull(active.latestSocPercent);
  const socDeltaPercent = Number.isFinite(startSocPercent) && Number.isFinite(endSocPercent)
    ? Math.max(0, Number(endSocPercent) - Number(startSocPercent))
    : null;
  const durationHours = Math.max(0, (now.getTime() - new Date(active.startedAt ?? "").getTime()) / 3_600_000);
  const averageChargeWatts = durationHours > 0 ? deliveredWh / durationHours : null;
  const session: AdaptiveChargePerformanceSession = {
    startedAt: active.startedAt ?? now.toISOString(),
    endedAt: now.toISOString(),
    reason,
    requestedWh: active.requestedWh,
    deliveredWh,
    startSocPercent: Number.isFinite(startSocPercent) ? startSocPercent : null,
    endSocPercent: Number.isFinite(endSocPercent) ? endSocPercent : null,
    socDeltaPercent,
    averageChargeWatts,
    estimatedDeliveryWh: Math.max(0, Math.round(estimatedDeliveryWh)),
    modelVersion: BATTERY_LEARNING_MODEL_VERSION,
  };
  state.chargingPerformance = cleanAdaptiveChargingPerformance({
    ...state.chargingPerformance,
    sessions: [...(state.chargingPerformance?.sessions ?? []), session],
  });
  if (state.activeWindowExecution) {
    state.activeWindowExecution.deliveredWh += deliveredWh;
    state.activeWindowExecution.estimatedDeliveryWh = Math.max(
      0,
      Math.round(Number(state.activeWindowExecution.estimatedDeliveryWh) || 0),
    ) + session.estimatedDeliveryWh;
    state.activeWindowExecution.latestSocPercent = endSocPercent;
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  state.activeChargeSession = null;
  return session;
}
