import { ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS, ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS, ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W, ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS, ControlConfig, ControlStatus, ChargeHeadroom, PlanLike, StateLike } from "./shared.js";
import { adaptiveChargingSlotAt } from "./scheduling.js";
import { effectiveAdaptiveChargeWatts } from "../battery-learning.js";
import { adaptiveChargingBreakerSettings } from "../adaptive-planning.js";
import type { AutomationRule } from "../automation-rules.js";
import { appendAdaptiveChargingLog } from "../adaptive-state.js";
import type { AdaptiveChargingState, BreakerRecovery, InterruptedCharge } from "../adaptive-state.js";
import { finiteNumberOrNull } from "../numbers.js";
import { explicitDiscountedBand } from "../tariffs.js";

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
