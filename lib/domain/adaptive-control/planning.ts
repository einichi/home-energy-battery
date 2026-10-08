import { ADAPTIVE_CHARGING_PREWINDOW_MS, ADAPTIVE_CHARGING_SLOT_MS, ADAPTIVE_CHARGING_SOLAR_REPLAN_MS, ControlConfig, StateLike } from "./shared.js";
import { adaptiveChargingWindowSolarOpportunity } from "./solar.js";
import { randomUUID } from "node:crypto";
import type { AdaptiveChargingState } from "../adaptive-state.js";
import { discountedBandOccurrence, discountedBandOccurrences } from "../tariffs.js";

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

function adaptiveChargingSolarReplanEvent(
  state: StateLike,
  scheduledEvent: ReturnType<typeof adaptiveChargingScheduledEvent>,
  now: Date,
) {
  const activeWindow = scheduledEvent.activeWindow;
  if (!activeWindow || !adaptiveChargingWindowSolarOpportunity(state.plan, activeWindow).available) return null;
  const elapsedMs = Math.max(0, now.getTime() - new Date(activeWindow.start).getTime());
  const intervalIndex = Math.floor(elapsedMs / ADAPTIVE_CHARGING_SOLAR_REPLAN_MS);
  return {
    ...scheduledEvent,
    eventKey: `solar-window:${activeWindow.key}:interval:${intervalIndex}`,
    trigger: intervalIndex === 0
      ? `entering solar-capable ${activeWindow.band.label || "discounted window"}`
      : `5-minute solar-window adjustment in ${activeWindow.band.label || "discounted window"}`,
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
  const effectiveEvent = adaptiveChargingSolarReplanEvent(state, scheduledEvent, now) ?? scheduledEvent;
  if (effectiveEvent.eventKey) {
    if (state.lastPlanEventKey !== effectiveEvent.eventKey) {
      return { refresh: true, ...effectiveEvent };
    }
    return { refresh: false, ...effectiveEvent };
  }
  return { refresh: false, ...effectiveEvent };
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
