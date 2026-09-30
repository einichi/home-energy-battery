import { randomUUID } from "node:crypto";
import { BATTERY_LEARNING_MODEL_VERSION, effectiveAdaptiveChargeWatts } from "./battery-learning.js";
import { adaptiveChargingBreakerSettings } from "./adaptive-planning.js";
import type { AdaptiveChargeSlot } from "./adaptive-planning.js";
import { batteryChargingWatts } from "./automation-rules.js";
import type { AutomationRule, AutomationStatus } from "./automation-rules.js";
import { appendAdaptiveChargingLog } from "./adaptive-state.js";
import type {
  AdaptiveChargingState,
  AdaptivePlan,
  AdaptivePlanWindow,
  ActiveChargeSession,
  BreakerRecovery,
  ExportConfirmation,
  InterruptedCharge,
  WindowSummary,
} from "./adaptive-state.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import { finiteNumberOrNull } from "./numbers.js";
import { selectedFuelCellReading, numericMetric } from "./telemetry.js";
import { discountedBandOccurrence, discountedBandOccurrences, explicitDiscountedBand } from "./tariffs.js";

const ADAPTIVE_CHARGING_PREWINDOW_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS = 3 * 60_000;
const ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS = 3;
const ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS = 2;
const ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS = 2;
const ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS = 3;
const ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W = 50;
const ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W = 200;
const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = 5 * 60_000;
const ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH = 50;

type ControlConfig = Pick<ApplicationConfig,
  "adaptiveCharging" | "solarEnabled" | "rateMode" | "rateBands" | "standardRateYenPerKwh" | "batteryCapabilities"
> & Record<string, unknown>;

type ControlStatus = AutomationStatus & {
  energy?: AutomationStatus["energy"] & {
    solar?: { instant_power?: { value?: unknown } };
    fuel_cells?: Array<{
      source_role?: string;
      host?: string;
      instant_power?: { value?: unknown };
      generation_status?: { value?: unknown };
    }>;
  };
  meter?: AutomationStatus["meter"] & { grid_export_power?: { value?: unknown } };
};

interface ChargeHeadroom {
  available: boolean;
  gridImportW: number;
  maximumChargeWatts: number;
  chargeWatts: number;
  learnedChargeWatts: number | null;
  breakerLimitW: number;
  safetyMarginW: number;
  thresholdW: number;
  breakerSettings: ReturnType<typeof adaptiveChargingBreakerSettings>;
}

interface ExportEvidence {
  aboveThreshold: boolean;
  balanceAvailable: boolean;
  coherent: boolean;
  gridExportW: number | null;
  residualW: number | null;
  gridImportW?: number | null;
  houseDemandW?: number | null;
  batteryChargingW?: number | null;
  solarW?: number | null;
  fuelCellW?: number | null;
  expectedGridW?: number | null;
  measuredGridW?: number | null;
  toleranceW?: number | null;
}

type SlotLike = Partial<AdaptiveChargeSlot>;
type WindowLike = Partial<AdaptivePlanWindow>;
interface PlanLike {
  available?: boolean;
  reason?: string | null;
  warning?: string | null;
  createdAt?: string;
  forecastFetchedAt?: string | null;
  plannedChargeKwh?: number;
  plannedStoredChargeKwh?: number;
  requiredGridChargeKwh?: number;
  predictedSolarKwh?: number;
  predictedDemandKwh?: number;
  predictedFuelCellKwh?: number;
  chargePerformance?: { effectiveWatts?: number };
  batteryModel?: AdaptivePlan["batteryModel"];
  demandHistory?: AdaptivePlan["demandHistory"];
  fuelCellModel?: AdaptivePlan["fuelCellModel"];
  slots?: SlotLike[];
  windows?: WindowLike[];
}
interface StateLike {
  plan?: PlanLike | null;
  forecast?: { fetchedAt?: string } | null;
  owner?: "adaptiveCharging" | null;
  activeSlot?: SlotLike | null;
  activePlanCreatedAt?: string | null;
  activeChargedKwh?: number;
  activeChargeSession?: Partial<ActiveChargeSession> | null;
  interruptedCharge?: Partial<InterruptedCharge> | null;
  breakerRecovery?: Partial<BreakerRecovery> | null;
  batteryLearning?: AdaptiveChargingState["batteryLearning"];
  lastPlanEventKey?: string | null;
  pendingPlanReason?: string | null;
  pendingPlanRequestId?: string | null;
  pendingPlanRequestedAt?: string | null;
  solarHeadroomHoldUntil?: string | null;
  solarHeadroomClearChecks?: number;
  exportConfirmation?: Partial<ExportConfirmation>;
  lastHeadroomWaitLogAt?: string | null;
  log?: AdaptiveChargingState["log"];
  updatedAt?: string;
}
type CommandExecutor = (action: string, payload: Record<string, unknown>) => Promise<unknown>;


export function adaptiveChargingConfiguredActive(config: ControlConfig): boolean {
  return config.adaptiveCharging?.enabled === true && config.solarEnabled !== false && config.rateMode !== "simple";
}


export function nextLocalMidnight(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}


export function adaptiveChargingSlotAt(plan: AdaptivePlan | null | undefined, now?: Date): AdaptiveChargeSlot | null;
export function adaptiveChargingSlotAt(plan: PlanLike | null | undefined, now?: Date): SlotLike | null;
export function adaptiveChargingSlotAt(plan: PlanLike | null | undefined, now: Date = new Date()): SlotLike | null {
  const time = now.getTime();
  return (plan?.slots ?? []).find((slot) => new Date(String(slot.start ?? "")).getTime() <= time && time < new Date(String(slot.end ?? "")).getTime()) ?? null;
}


export function capAdaptiveChargingSlotToRemainingTime<S extends SlotLike>(slot: S, maximumChargeWatts: unknown, now?: Date): (S & { start: string; targetWh: number }) | null;
export function capAdaptiveChargingSlotToRemainingTime(slot: SlotLike | null | undefined, maximumChargeWatts: unknown, now?: Date): SlotLike | null;
export function capAdaptiveChargingSlotToRemainingTime(slot: SlotLike | null | undefined, maximumChargeWatts: unknown, now: Date = new Date()): SlotLike | null {
  const endMs = new Date(String(slot?.end ?? "")).getTime();
  const nowMs = now.getTime();
  const maximumWatts = Number(slot?.schedulingWatts ?? maximumChargeWatts);
  if (!Number.isFinite(endMs) || endMs <= nowMs || !Number.isFinite(maximumWatts) || maximumWatts <= 0) {
    return null;
  }
  const maximumRemainingWh = Math.floor(maximumWatts * (endMs - nowMs) / 3_600_000);
  const targetWh = Math.min(
    Math.max(0, Math.round(Number(slot?.targetWh) || 0)),
    Math.max(0, maximumRemainingWh),
  );
  if (targetWh < ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH) return null;
  const durationMs = targetWh / maximumWatts * 3_600_000;
  return {
    ...slot,
    start: new Date(Math.max(nowMs, endMs - durationMs)).toISOString(),
    targetWh,
  };
}


export function adaptiveChargingSlotIdentity(slot: SlotLike | null | undefined): string | null {
  if (!slot) return null;
  const endMs = new Date(String(slot.end ?? "")).getTime();
  const windowEndMs = new Date(String(slot.windowEnd ?? slot.end ?? "")).getTime();
  if (!Number.isFinite(endMs) || !Number.isFinite(windowEndMs)) return null;
  return JSON.stringify([
    Number.isFinite(new Date(String(slot.windowStart ?? "")).getTime()) ? new Date(String(slot.windowStart)).getTime() : null,
    windowEndMs,
    endMs,
    Number(slot.yenPerKwh),
    slot.label ?? null,
  ]);
}


export function adaptiveChargingSlotsMatch(left: SlotLike | null | undefined, right: SlotLike | null | undefined): boolean {
  if (left?.slotId && right?.slotId) return left.slotId === right.slotId;
  const leftIdentity = adaptiveChargingSlotIdentity(left);
  const rightIdentity = adaptiveChargingSlotIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}


export function consumeCompletedAdaptiveChargingSlot<P extends PlanLike>(plan: P, completedSlot: SlotLike): P;
export function consumeCompletedAdaptiveChargingSlot(plan: PlanLike | null, completedSlot: SlotLike | null): PlanLike | null;
export function consumeCompletedAdaptiveChargingSlot(plan: PlanLike | null, completedSlot: SlotLike | null): PlanLike | null {
  if (!plan || !completedSlot) return plan;
  let removedWh = 0;
  const slots = (plan.slots ?? []).filter((slot) => {
    if (!adaptiveChargingSlotsMatch(slot, completedSlot)) return true;
    removedWh += Math.max(0, Math.round(Number(slot.targetWh) || 0));
    return false;
  });
  if (!removedWh) return plan;
  const batteryModel = plan.batteryModel as { chargeToStoredRatio?: unknown } | undefined;
  const chargeToStoredRatio = Math.min(
    1.5,
    Math.max(0.5, Number(batteryModel?.chargeToStoredRatio) || 1),
  );
  const removedStoredKwh = removedWh / 1000 * chargeToStoredRatio;
  const completedWindowEnd = new Date(String(completedSlot.windowEnd ?? completedSlot.end ?? "")).getTime();
  return {
    ...plan,
    slots,
    plannedChargeKwh: Math.max(0, Number(plan.plannedChargeKwh || 0) - removedWh / 1000),
    plannedStoredChargeKwh: Math.max(
      0,
      Number(plan.plannedStoredChargeKwh || 0) - removedStoredKwh,
    ),
    requiredGridChargeKwh: Math.max(
      0,
      Number(plan.requiredGridChargeKwh || 0) - removedWh / 1000,
    ),
    windows: (plan.windows ?? []).map((window) => (
      new Date(String(window.end ?? "")).getTime() === completedWindowEnd
        ? {
          ...window,
          plannedChargeKwh: Math.max(0, Number(window.plannedChargeKwh || 0) - removedWh / 1000),
          plannedStoredChargeKwh: Math.max(
            0,
            Number(window.plannedStoredChargeKwh || 0) - removedStoredKwh,
          ),
          requestedChargeKwh: Math.max(0, Number(window.requestedChargeKwh || 0) - removedWh / 1000),
        }
        : window
    )),
  };
}


export function preserveInterruptedAdaptiveCharge(state: StateLike, now: Date = new Date()): InterruptedCharge | null {
  const activeSlot = state.activeSlot;
  const targetWh = Math.max(0, Math.round(Number(activeSlot?.targetWh) || 0));
  if (!activeSlot || !targetWh) return null;
  const deliveredWh = Math.max(
    0,
    Math.min(targetWh, Math.round(Number(state.activeChargedKwh || 0) * 1000)),
  );
  const remainingWh = Math.max(0, targetWh - deliveredWh);
  if (state.plan) {
    state.plan = {
      ...state.plan,
      slots: (state.plan.slots ?? []).flatMap((slot) => {
        if (!adaptiveChargingSlotsMatch(slot, activeSlot)) return [slot];
        return remainingWh > 0 ? [{ ...slot, targetWh: remainingWh }] : [];
      }),
    };
  }
  const interruption = remainingWh > 0 ? {
    slotId: activeSlot.slotId ?? null,
    slotStart: typeof activeSlot.start === "string" ? activeSlot.start : null,
    slotEnd: typeof activeSlot.end === "string" ? activeSlot.end : null,
    windowStart: typeof (activeSlot.windowStart ?? activeSlot.start) === "string" ? String(activeSlot.windowStart ?? activeSlot.start) : null,
    windowEnd: typeof (activeSlot.windowEnd ?? activeSlot.end) === "string" ? String(activeSlot.windowEnd ?? activeSlot.end) : null,
    remainingWh,
    deliveredWh,
    interruptedAt: now.toISOString(),
  } : null;
  state.interruptedCharge = interruption;
  return interruption;
}


export function applyInterruptedChargeCap<P extends PlanLike, I extends Partial<InterruptedCharge>>(plan: P, interruption: I, maximumChargeWatts: unknown, now?: Date): { plan: P; interruption: I | null };
export function applyInterruptedChargeCap(plan: PlanLike | null, interruption: Partial<InterruptedCharge> | null, maximumChargeWatts: unknown, now?: Date): { plan: PlanLike | null; interruption: Partial<InterruptedCharge> | null };
export function applyInterruptedChargeCap(plan: PlanLike | null, interruption: Partial<InterruptedCharge> | null, maximumChargeWatts: unknown, now: Date = new Date()): { plan: PlanLike | null; interruption: Partial<InterruptedCharge> | null } {
  if (!plan || !interruption) return { plan, interruption: null };
  const interruptedEnd = new Date(String(interruption.slotEnd ?? "")).getTime();
  if (!Number.isFinite(interruptedEnd) || interruptedEnd <= now.getTime()) {
    return { plan, interruption: null };
  }
  const remainingWh = Math.max(0, Math.round(Number(interruption.remainingWh) || 0));
  let matched = false;
  const slots = (plan.slots ?? []).map((slot) => {
    const sameSlot = interruption.slotId && slot.slotId
      ? interruption.slotId === slot.slotId
      : new Date(String(slot.end ?? "")).getTime() === interruptedEnd;
    if (!sameSlot) return slot;
    matched = true;
    const targetWh = Math.min(Math.max(0, Math.round(Number(slot.targetWh) || 0)), remainingWh);
    if (!targetWh) return null;
    const endMs = new Date(String(slot.end ?? "")).getTime();
    const maximumWatts = Number(slot.schedulingWatts ?? maximumChargeWatts);
    const durationMs = Number.isFinite(maximumWatts) && maximumWatts > 0
      ? targetWh / maximumWatts * 3_600_000
      : endMs - new Date(String(slot.start ?? "")).getTime();
    return {
      ...slot,
      start: new Date(Math.max(new Date(String(slot.start ?? "")).getTime(), endMs - durationMs)).toISOString(),
      targetWh,
    };
  }).filter((slot): slot is SlotLike => slot !== null);
  return {
    plan: matched ? { ...plan, slots } : plan,
    interruption: matched ? { ...interruption, remainingWh } : null,
  };
}


export function adaptiveChargingLiveChargeHeadroom(status: ControlStatus, config: ControlConfig, state: Partial<AdaptiveChargingState> = {}, rules: Array<Partial<AutomationRule>> = []): ChargeHeadroom {
  const rawGridImportW = status.meter?.grid_import_power?.value;
  const gridImportW = rawGridImportW === null || rawGridImportW === undefined || rawGridImportW === ""
    ? Number.NaN
    : Number(rawGridImportW);
  const maximumChargeWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const chargePerformance = effectiveAdaptiveChargeWatts(config, state);
  const chargeWatts = Number(chargePerformance.effectiveWatts);
  const breakerSettings = adaptiveChargingBreakerSettings(rules);
  const breakerLimitW = breakerSettings.breakerLimitW;
  const safetyMarginW = ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W;
  const thresholdW = breakerSettings.valid && breakerLimitW > 0
    ? breakerLimitW - chargeWatts - safetyMarginW
    : Number.NaN;
  const available = breakerSettings.valid
    && Number.isFinite(gridImportW)
    && Number.isFinite(chargeWatts)
    && gridImportW <= thresholdW;
  return {
    available,
    gridImportW,
    maximumChargeWatts,
    chargeWatts,
    learnedChargeWatts: chargePerformance.learnedWatts,
    breakerLimitW,
    safetyMarginW,
    thresholdW,
    breakerSettings,
  };
}


export function beginAdaptiveChargingBreakerRecovery(state: StateLike, headroom: ChargeHeadroom, now: Date = new Date()): BreakerRecovery {
  const recovery: BreakerRecovery = {
    interruptedAt: now.toISOString(),
    cooldownUntil: new Date(now.getTime() + ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS).toISOString(),
    consecutiveSafeChecks: 0,
    lastCheckedAt: null,
    lastWaitLogAt: null,
    currentImportW: finiteNumberOrNull(headroom?.gridImportW),
    thresholdW: finiteNumberOrNull(headroom?.thresholdW),
    chargeWatts: finiteNumberOrNull(headroom?.chargeWatts),
    safetyMarginW: finiteNumberOrNull(headroom?.safetyMarginW),
  };
  state.breakerRecovery = recovery;
  return recovery;
}


export function advanceAdaptiveChargingBreakerRecovery(state: StateLike, headroom: ChargeHeadroom, now: Date = new Date()) {
  const recovery = state.breakerRecovery;
  if (!recovery) return { ready: true, waiting: false };
  const checkedAt = now.toISOString();
  if (recovery.lastCheckedAt !== checkedAt) {
    recovery.consecutiveSafeChecks = headroom.available
      ? Number(recovery.consecutiveSafeChecks ?? 0) + 1
      : 0;
    recovery.lastCheckedAt = checkedAt;
  }
  recovery.currentImportW = finiteNumberOrNull(headroom.gridImportW);
  recovery.thresholdW = finiteNumberOrNull(headroom.thresholdW);
  recovery.chargeWatts = finiteNumberOrNull(headroom.chargeWatts);
  recovery.safetyMarginW = finiteNumberOrNull(headroom.safetyMarginW);
  const cooldownReady = now.getTime() >= new Date(String(recovery.cooldownUntil ?? "")).getTime();
  const checksReady = Number(recovery.consecutiveSafeChecks ?? 0) >= ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS;
  const lastWaitLogMs = new Date(recovery.lastWaitLogAt ?? 0).getTime();
  const shouldLog = !Number.isFinite(lastWaitLogMs)
    || lastWaitLogMs <= 0
    || now.getTime() - lastWaitLogMs >= ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS;
  return {
    ready: Boolean(headroom.available && cooldownReady && checksReady),
    waiting: true,
    cooldownReady,
    checksReady,
    shouldLog,
    consecutiveSafeChecks: recovery.consecutiveSafeChecks,
    requiredSafeChecks: ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS,
    cooldownUntil: recovery.cooldownUntil,
  };
}


export function adaptiveChargingBreakerRecoveryReady(state: { breakerRecovery?: Partial<BreakerRecovery> | null } | null | undefined, now: Date = new Date()): boolean {
  const recovery = state?.breakerRecovery;
  if (!recovery) return false;
  const cooldownUntilMs = new Date(String(recovery.cooldownUntil ?? "")).getTime();
  return Number.isFinite(cooldownUntilMs)
    && now.getTime() >= cooldownUntilMs
    && Number(recovery.consecutiveSafeChecks) >= ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS;
}


export function shouldHoldGuardStandbyForAdaptiveCharging(state: { interruptedCharge?: Partial<InterruptedCharge> | null; breakerRecovery?: Partial<BreakerRecovery> | null } | null | undefined, now: Date = new Date()): boolean {
  const slotEndMs = new Date(state?.interruptedCharge?.slotEnd ?? 0).getTime();
  return Number.isFinite(slotEndMs)
    && slotEndMs > now.getTime()
    && !adaptiveChargingBreakerRecoveryReady(state, now);
}


export function logAdaptiveChargingBreakerWait(state: StateLike, headroom: ChargeHeadroom, recoveryStatus: ReturnType<typeof advanceAdaptiveChargingBreakerRecovery>, now: Date = new Date()): boolean {
  if (!state.breakerRecovery || !recoveryStatus.shouldLog) return false;
  const importText = Number.isFinite(headroom.gridImportW) ? `(${Math.round(headroom.gridImportW)} W)` : "unavailable";
  const thresholdText = Number.isFinite(headroom.thresholdW) ? `(${Math.round(headroom.thresholdW)} W)` : "unrestricted";
  const limitText = Number.isFinite(headroom.breakerLimitW) ? `(${Math.round(headroom.breakerLimitW)} W)` : "unavailable";
  appendAdaptiveChargingLog(
    state as AdaptiveChargingState,
    `Waiting for breaker headroom: Grid Import ${importText}, required at or below ${thresholdText} from Charging Demand Guard limit ${limitText}, safe checks (${recoveryStatus.consecutiveSafeChecks}/${recoveryStatus.requiredSafeChecks}), retry after ${state.breakerRecovery.cooldownUntil}`,
    "guard",
    now,
  );
  state.breakerRecovery.lastWaitLogAt = now.toISOString();
  return true;
}


export function logAdaptiveChargingInitialHeadroomWait(state: StateLike, headroom: ChargeHeadroom, now: Date = new Date()): boolean {
  const lastLogMs = new Date(state.lastHeadroomWaitLogAt ?? 0).getTime();
  if (Number.isFinite(lastLogMs) && lastLogMs > 0 && now.getTime() - lastLogMs < ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS) {
    return false;
  }
  const importText = Number.isFinite(headroom.gridImportW) ? `${Math.round(headroom.gridImportW)} W` : "unavailable";
  const thresholdText = Number.isFinite(headroom.thresholdW) ? `${Math.round(headroom.thresholdW)} W` : "unrestricted";
  const limitText = Number.isFinite(headroom.breakerLimitW) ? `${Math.round(headroom.breakerLimitW)} W` : "unavailable";
  const chargeText = Number.isFinite(headroom.chargeWatts) ? `${Math.round(headroom.chargeWatts)} W` : "unavailable";
  const marginText = Number.isFinite(headroom.safetyMarginW) ? `${Math.round(headroom.safetyMarginW)} W` : "unavailable";
  const settings = headroom.breakerSettings ?? {};
  const guardValues = [settings.breakerAmps, settings.reserveAmps, settings.breakerVoltage]
    .every((value) => Number.isFinite(Number(value)))
    ? `${settings.breakerAmps} A - ${settings.reserveAmps} A reserve at ${settings.breakerVoltage} V`
    : "settings unavailable";
  appendAdaptiveChargingLog(
    state as AdaptiveChargingState,
    `Waiting to start planned charge: Grid Import (${importText}), required at or below (${thresholdText}) using Charging Demand Guard (${guardValues}) = Guard limit (${limitText}), charge estimate (${chargeText}), and safety margin (${marginText})`,
    "guard",
    now,
  );
  state.lastHeadroomWaitLogAt = now.toISOString();
  return true;
}


export function adaptiveChargingLiveImportSafety(status: ControlStatus, rules: Array<Partial<AutomationRule>> = []) {
  const rawGridImportW = status.meter?.grid_import_power?.value;
  const gridImportW = rawGridImportW === null || rawGridImportW === undefined || rawGridImportW === ""
    ? Number.NaN
    : Number(rawGridImportW);
  const breakerSettings = adaptiveChargingBreakerSettings(rules);
  const breakerLimitW = breakerSettings.breakerLimitW;
  return {
    available: breakerSettings.valid
      && Number.isFinite(gridImportW)
      && gridImportW < breakerLimitW,
    gridImportW,
    breakerLimitW,
    breakerSettings,
  };
}


export function activeAdaptiveChargingSlotStopReason(state: StateLike, config: ControlConfig, plan: PlanLike | null, now: Date = new Date()): string | null {
  if (state.owner !== "adaptiveCharging") return null;
  if (!explicitDiscountedBand(config, now)) return "Current rate is no longer discounted";
  const activeSlot = state.activeSlot;
  const replacement = activeSlot?.continuousWindowCharge
    ? (plan?.slots ?? []).find((slot) => slot.windowStart === activeSlot.windowStart
      && slot.windowEnd === activeSlot.windowEnd
      && slot.yenPerKwh === activeSlot.yenPerKwh && slot.label === activeSlot.label
      && new Date(String(slot.end ?? "")) > now)
    : adaptiveChargingSlotAt(plan, now);
  if (!replacement) return "Recalculated plan no longer includes the active charging period";
  const planChanged = state.activePlanCreatedAt !== plan?.createdAt;
  if (planChanged) {
    const activeRemainingWh = Math.max(
      0,
      Number(state.activeSlot?.targetWh ?? 0) - Number(state.activeChargedKwh ?? 0) * 1000,
    );
    const replacementWh = Number(replacement.targetWh);
    if (!Number.isFinite(replacementWh) || Math.abs(replacementWh - activeRemainingWh) > 50) {
      return "Recalculated plan changed the remaining charge target";
    }
  }
  const activeTarget = Number(state.activeSlot?.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  const replacementTarget = Number(replacement.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  if (Number.isFinite(activeTarget) && Number.isFinite(replacementTarget) && replacementTarget < activeTarget - 0.1) {
    return "Recalculated plan reduced the active SOC target";
  }
  const activeEnd = new Date(String(state.activeSlot?.end ?? "")).getTime();
  const replacementEnd = new Date(String(replacement.end ?? "")).getTime();
  if (Number.isFinite(activeEnd) && Number.isFinite(replacementEnd) && replacementEnd < activeEnd) {
    return "Recalculated plan shortened the active charging period";
  }
  return null;
}


export function adaptiveChargingScheduledEvent(config: ControlConfig, now: Date = new Date()) {
  const activeWindow = discountedBandOccurrence(config, now);
  if (activeWindow) {
    const elapsedMs = Math.max(0, now.getTime() - new Date(activeWindow.start).getTime());
    const slotIndex = Math.floor(elapsedMs / ADAPTIVE_CHARGING_SLOT_MS);
    return {
      eventKey: `window:${activeWindow.key}:slot:${slotIndex}`,
      trigger: slotIndex === 0
        ? `entering ${activeWindow.band.label || "discounted window"}`
        : `30-minute slot boundary in ${activeWindow.band.label || "discounted window"}`,
      activeWindow,
    };
  }
  const upcomingWindow = discountedBandOccurrences(config, now)
    .find((occurrence) => new Date(occurrence.start).getTime() > now.getTime());
  if (!upcomingWindow) return { upcomingWindow: null };
  const timeUntilStartMs = new Date(upcomingWindow.start).getTime() - now.getTime();
  if (timeUntilStartMs > ADAPTIVE_CHARGING_PREWINDOW_MS) return { upcomingWindow };
  return {
    eventKey: `prewindow:${upcomingWindow.key}`,
    trigger: `30 minutes before ${upcomingWindow.band.label || "discounted window"}`,
    upcomingWindow,
  };
}


export function queueAdaptiveChargingPlanRefresh(state: StateLike, reason: unknown, now: Date = new Date(), requestId: unknown = randomUUID()): string {
  state.pendingPlanReason = String(reason);
  state.pendingPlanRequestId = String(requestId);
  state.pendingPlanRequestedAt = now.toISOString();
  return state.pendingPlanRequestId!;
}


export function adaptiveChargingPlanRefreshDecision(state: StateLike, config: ControlConfig, now: Date = new Date()) {
  const forecastFetchedAt = state.forecast?.fetchedAt ?? null;
  const scheduledEvent = adaptiveChargingScheduledEvent(config, now);
  if (state.pendingPlanReason) {
    return {
      ...scheduledEvent,
      refresh: true,
      trigger: state.pendingPlanReason,
      eventKey: `pending:${state.pendingPlanRequestId ?? `legacy:${state.pendingPlanReason}`}`,
    };
  }
  if (!state.plan) {
    const trigger = state.pendingPlanReason || "initial plan";
    return {
      ...scheduledEvent,
      refresh: true,
      trigger,
      eventKey: scheduledEvent.eventKey ?? `initial:${trigger}:${forecastFetchedAt ?? "none"}`,
    };
  }
  if (forecastFetchedAt && state.plan.forecastFetchedAt !== forecastFetchedAt) {
    return {
      ...scheduledEvent,
      refresh: true,
      trigger: "forecast refresh",
      eventKey: scheduledEvent.eventKey ?? `forecast:${forecastFetchedAt}`,
    };
  }
  if (scheduledEvent.eventKey) {
    if (state.lastPlanEventKey !== scheduledEvent.eventKey) {
      return { refresh: true, ...scheduledEvent };
    }
    return { refresh: false, ...scheduledEvent };
  }
  return { refresh: false, ...scheduledEvent };
}


export function batteryLearningModelSwitchDue(state: { batteryLearning?: Partial<AdaptiveChargingState["batteryLearning"]> }, now: Date = new Date()): boolean {
  const switchAfterSlotEnd = state.batteryLearning?.switchAfterSlotEnd;
  if (!switchAfterSlotEnd) return false;
  const switchAt = new Date(switchAfterSlotEnd).getTime();
  return Number.isFinite(switchAt) && switchAt <= now.getTime();
}


export function consumeBatteryLearningModelSwitch(state: StateLike, now: Date = new Date()): boolean {
  const batteryLearning = state.batteryLearning;
  const switchAfterSlotEnd = batteryLearning?.switchAfterSlotEnd;
  if (!batteryLearning || !switchAfterSlotEnd || !batteryLearningModelSwitchDue(state, now)) return false;
  batteryLearning.switchAfterSlotEnd = null;
  if (batteryLearning.consumedSwitchAfterSlotEnd === switchAfterSlotEnd) return false;
  batteryLearning.consumedSwitchAfterSlotEnd = switchAfterSlotEnd;
  batteryLearning.switchConsumedAt = now.toISOString();
  queueAdaptiveChargingPlanRefresh(
    state,
    "battery model migration after active slot",
    now,
    `battery-model-switch:${switchAfterSlotEnd}`,
  );
  return true;
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
  const houseDemandW = numericMetric(status.meter?.house_demand_power);
  const batteryChargingW = batteryChargingWatts(status);
  const solarW = numericMetric(status.energy?.solar?.instant_power);
  const fuelCellW = numericMetric(selectedFuelCellReading(status.energy?.fuel_cells ?? [])?.instant_power);
  const aboveThreshold = gridExportW !== null && Number.isFinite(gridExportW) && gridExportW > ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W;
  const balanceAvailable = [gridImportW, houseDemandW, batteryChargingW, solarW]
    .every(Number.isFinite);
  if (!aboveThreshold) {
    return { aboveThreshold: false, balanceAvailable, coherent: false, gridExportW, residualW: null };
  }
  if (!balanceAvailable) {
    return { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW, residualW: null };
  }
  if (gridImportW === null || gridExportW === null || houseDemandW === null || batteryChargingW === null || solarW === null) {
    return { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW, residualW: null };
  }
  const fuelCellContributionW = fuelCellW !== null && Number.isFinite(fuelCellW) ? fuelCellW : 0;
  const expectedGridW = houseDemandW + batteryChargingW - solarW - fuelCellContributionW;
  const measuredGridW = gridImportW - gridExportW;
  const residualW = Math.abs(expectedGridW - measuredGridW);
  const toleranceW = Math.max(300, Math.max(Math.abs(expectedGridW), Math.abs(measuredGridW)) * 0.25);
  return {
    aboveThreshold: true,
    balanceAvailable: true,
    coherent: expectedGridW < -ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W && residualW <= toleranceW,
    gridExportW,
    gridImportW,
    houseDemandW,
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


export function adaptiveChargingClock(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}


export function adaptiveChargingPlanLogMessage(plan: PlanLike | null | undefined, trigger: unknown, liveSoc: unknown): string {
  if (!plan?.available) return `Plan recalculated (${trigger}); adaptiveCharging unavailable: ${plan?.reason || "unknown reason"}`;
  const targets = (plan.windows ?? [])
    .map((window) => `${String((window as Record<string, unknown>).label ?? "")} ${Number(window.targetSocPercent).toFixed(0)}%/${Number(window.plannedChargeKwh).toFixed(2)} kWh`)
    .join(", ") || "none";
  const slots = (plan.slots ?? [])
    .map((slot) => `${adaptiveChargingClock(String(slot.start ?? ""))}-${adaptiveChargingClock(String(slot.end ?? ""))} ${slot.targetWh} Wh`)
    .join(", ") || "none";
  const timing = (plan.windows ?? [])
    .filter((window) => Number(window.plannedChargeKwh) > 0
      && Number.isFinite(Number(window.schedulingWatts))
      && Number.isFinite(Number(window.timingReserveMs)))
    .map((window) => {
      const details = window as Record<string, unknown>;
      return `${String(details.label ?? "")} ${Math.round(Number(details.schedulingWatts))} W/${Math.round(Number(details.timingReserveMs) / 60_000)} min reserve/${String(details.schedulingSource ?? "")}`;
    })
    .join(", ");
  const timingSummary = timing ? `; timing [${timing}]` : "";
  const demandHistory = plan.demandHistory;
  const awaySummary = Number(demandHistory?.awaySlotCount) > 0
    ? `; away demand ${demandHistory?.awayConfidence} (${demandHistory?.awayComparableDayCount} comparable days, ${demandHistory?.awayFallbackSlotCount} fallback slots)`
    : "";
  const model = plan.batteryModel ?? {};
  const batteryModelSummary = Number.isFinite(Number(model.charge?.whPerSocPoint))
    ? `; battery model v${model.version ?? BATTERY_LEARNING_MODEL_VERSION} [charge ${Number(model.charge?.whPerSocPoint).toFixed(1)} Wh/SOC (${model.charge?.source}), discharge ${Number(model.discharge?.whPerSocPoint).toFixed(1)} Wh/SOC (${model.discharge?.source}), power ${Math.round(Number(model.power?.effectiveWatts))} W (${model.power?.source})]`
    : "";
  const fuelCell = plan.fuelCellModel;
  const fuelCellSummary = fuelCell
    ? `; Ene-Farm ${Number(plan.predictedFuelCellKwh ?? 0).toFixed(2)} kWh median (${fuelCell.method}, ${fuelCell.influence}${fuelCell.blockers?.length ? `; ${fuelCell.blockers.join(", ")}` : ""})`
    : "";
  return `Plan recalculated (${trigger}): SOC ${Number(liveSoc).toFixed(0)}%; ${Number(plan.predictedSolarKwh).toFixed(2)} kWh solar, ${Number(plan.predictedDemandKwh).toFixed(2)} kWh demand, ${Number(plan.plannedChargeKwh).toFixed(2)} kWh discounted charging; targets [${targets}]; slots [${slots}]${timingSummary}${awaySummary}${fuelCellSummary}${batteryModelSummary}${plan.warning ? `; ${plan.warning}` : ""}`;
}


export function adaptiveChargingWindowHasShortfall(summary: Partial<WindowSummary> | null | undefined): boolean {
  return Number(summary?.unmetWh) >= 50 && summary?.socTargetReached !== true;
}

export function adaptiveChargingSlotEndKey(state: StateLike | null | undefined): string | null {
  if (state?.owner !== "adaptiveCharging" || !state.activeSlot) return null;
  const endMs = new Date(String(state.activeSlot.end ?? "")).getTime();
  if (!Number.isFinite(endMs)) return null;
  return JSON.stringify([
    state.activeSlot.start ?? null,
    state.activeSlot.end,
    state.activePlanCreatedAt ?? null,
  ]);
}

export function adaptiveChargingSlotEndDelayMs(state: StateLike, now: Date = new Date()): number | null {
  if (!adaptiveChargingSlotEndKey(state)) return null;
  return Math.max(0, new Date(String(state.activeSlot?.end ?? "")).getTime() - now.getTime());
}

export async function updateActiveAdaptiveChargingObjective(
  state: StateLike,
  plan: PlanLike | null,
  now: Date,
  execute: CommandExecutor,
  soc: number | null = null,
): Promise<boolean> {
  if (state.owner !== "adaptiveCharging") return false;
  const active = state.activeSlot;
  if (!active || now.getTime() >= new Date(String(active.end ?? "")).getTime()) return false;
  const planChanged = state.activePlanCreatedAt !== plan?.createdAt;
  if (!planChanged && Number.isFinite(active?.deviceTargetWh)) return false;
  const replacement = (plan?.slots ?? []).find((slot) => slot.windowStart === active?.windowStart
    && slot.windowEnd === active?.windowEnd && slot.yenPerKwh === active?.yenPerKwh
    && slot.label === active?.label && new Date(String(slot.end ?? "")) > now);
  if (!replacement || !active?.continuousWindowCharge) return false;
  const deliveredWh = Math.max(0, Number(state.activeChargedKwh) * 1000);
  const remainingWh = Math.max(0, Math.round(Number(replacement.targetWh) || 0));
  if (!remainingWh) return false;
  const targetWh = planChanged ? Math.round(deliveredWh + remainingWh) : Number(active.targetWh);
  if (!Number.isFinite(targetWh) || targetWh <= 0) return false;
  const socReached = soc !== null && Number.isFinite(soc) && soc >= Number(replacement.targetSocPercent);
  let deviceTargetWh = active.deviceTargetWh;
  if (!socReached && targetWh !== deviceTargetWh) {
    await execute("charge", { targetWh });
    deviceTargetWh = targetWh;
  }
  state.activeSlot = { ...replacement, start: active.start, targetWh, deviceTargetWh, continuousWindowCharge: true };
  state.activePlanCreatedAt = plan?.createdAt ?? null;
  if (state.activeChargeSession) {
    state.activeChargeSession.requestedWh = targetWh;
    state.activeChargeSession.slotEnd = replacement.end;
  }
  return true;
}
