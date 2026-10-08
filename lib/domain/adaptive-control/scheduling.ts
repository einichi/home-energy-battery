import { ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH, ControlConfig, SlotLike, PlanLike, StateLike } from "./shared.js";
import type { AdaptiveChargeSlot } from "../adaptive-planning.js";
import type { AdaptivePlan, InterruptedCharge } from "../adaptive-state.js";

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
