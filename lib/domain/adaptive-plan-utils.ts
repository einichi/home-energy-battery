import type { AdaptiveChargeSlot, AdaptiveTimelineSlot } from "./adaptive-planning.js";
import type { AutomationRule } from "./automation-rules.js";
import type { DemandSample } from "./demand-forecast.js";
import { finiteNumberOrNull } from "./numbers.js";

export interface DiscountedTimelineWindow {
  key: string;
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
  configuredStartMs: number;
  configuredEndMs: number;
  yenPerKwh: number;
  label: string;
  slots: AdaptiveTimelineSlot[];
}

export function discountedTimelineWindows(timeline: AdaptiveTimelineSlot[] = []): DiscountedTimelineWindow[] {
  const windows: DiscountedTimelineWindow[] = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const slot = timeline[index];
    if (!slot.band) continue;
    const previous = windows.at(-1);
    const hasConfiguredOccurrence = Number.isFinite(Number(slot.rateWindowStartMs))
      && Number.isFinite(Number(slot.rateWindowEndMs));
    const configuredStartMs = hasConfiguredOccurrence ? Number(slot.rateWindowStartMs) : slot.startMs;
    const configuredEndMs = hasConfiguredOccurrence ? Number(slot.rateWindowEndMs) : slot.endMs;
    const key = hasConfiguredOccurrence
      ? `${configuredStartMs}-${configuredEndMs}-${slot.band.yenPerKwh}-${slot.band.label ?? ""}`
      : `${slot.band.start}-${slot.band.end}-${slot.band.yenPerKwh}-${slot.band.label ?? ""}`;
    if (previous && previous.key === key && previous.endMs === slot.startMs) {
      previous.endIndex = index + 1;
      previous.endMs = slot.endMs;
      if (!hasConfiguredOccurrence) previous.configuredEndMs = slot.endMs;
      previous.slots.push(slot);
    } else {
      windows.push({
        key,
        startIndex: index,
        endIndex: index + 1,
        startMs: slot.startMs,
        endMs: slot.endMs,
        configuredStartMs,
        configuredEndMs,
        yenPerKwh: Number(slot.band.yenPerKwh),
        label: slot.band.label || "Discounted",
        slots: [slot],
      });
    }
  }
  return windows;
}

export function latestFiniteSocPercent(samples: readonly DemandSample[]): number | null {
  // A trailing sample whose SOC is null/undefined/"" must not be coerced to 0 by
  // Number(); skip those and fall back to the most recent genuinely finite value.
  const sample = samples.findLast((item) => finiteNumberOrNull(item.stateOfChargePercent) !== null);
  return finiteNumberOrNull(sample?.stateOfChargePercent);
}

export function planningHorizon(nowMs: number, lastForecastHourMs: number, sunsetHorizonEndMs: number, lookAheadMs: number): { endMs: number; truncated: boolean } {
  const desiredMs = Math.max(nowMs + lookAheadMs, sunsetHorizonEndMs);
  const endMs = Number.isFinite(lastForecastHourMs) ? Math.min(desiredMs, lastForecastHourMs) : desiredMs;
  return { endMs, truncated: Number.isFinite(lastForecastHourMs) && desiredMs > lastForecastHourMs };
}

export function firstLocalSlotBoundary(startMs: number, slotMinutes: number): number {
  // Align to a local clock boundary (e.g. :00/:30) rather than an epoch multiple.
  const date = new Date(startMs);
  date.setSeconds(0, 0);
  const remainder = date.getMinutes() % slotMinutes;
  if (remainder !== 0) date.setMinutes(date.getMinutes() + (slotMinutes - remainder));
  if (date.getTime() < startMs) date.setMinutes(date.getMinutes() + slotMinutes);
  return date.getTime();
}

export function mergeAdaptiveChargingSlots(slots: AdaptiveChargeSlot[] = []): AdaptiveChargeSlot[] {
  const merged: AdaptiveChargeSlot[] = [];
  for (const slot of [...slots].sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())) {
    const previous = merged.at(-1);
    if (previous && previous.yenPerKwh === slot.yenPerKwh && previous.label === slot.label
      && previous.windowStart && previous.windowStart === slot.windowStart && previous.windowEnd === slot.windowEnd
      && Math.abs(new Date(previous.end).getTime() - new Date(slot.start).getTime()) <= 1
      && previous.targetSocPercent === slot.targetSocPercent) {
      previous.end = slot.end;
      previous.targetWh += slot.targetWh;
      previous.slotId = slot.slotId;
      previous.continuousWindowCharge = true;
    } else merged.push({ ...slot, continuousWindowCharge: true });
  }
  return merged;
}

export function adaptiveChargingBreakerSettings(rules: Array<Partial<AutomationRule>> = []) {
  const guardRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.type === "backup-demand-guard");
  const preferredRules = guardRules.some((rule) => rule.enabled)
    ? guardRules.filter((rule) => rule.enabled)
    : guardRules;
  const configuredGuards = preferredRules
    .map((rule) => {
      const conditions: Partial<AutomationRule["conditions"]> = rule.conditions ?? {};
      const breakerVoltage = Number(conditions.breakerVoltage);
      const breakerAmps = Number(conditions.breakerAmps);
      const reserveAmps = Number(conditions.reserveAmps);
      const breakerLimitW = (breakerAmps - reserveAmps) * breakerVoltage;
      return {
        breakerVoltage,
        breakerAmps,
        reserveAmps,
        breakerLimitW,
        ruleId: rule.id ?? null,
        ruleName: rule.name ?? "Charging Demand Guard",
        source: "automation-rule",
      };
    })
    .filter((settings) => Number.isFinite(settings.breakerLimitW) && settings.breakerLimitW > 0)
    .sort((left, right) => left.breakerLimitW - right.breakerLimitW);
  if (configuredGuards.length) return { ...configuredGuards[0], valid: true };
  return {
    breakerVoltage: null,
    breakerAmps: null,
    reserveAmps: null,
    breakerLimitW: Number.NaN,
    ruleId: null,
    ruleName: null,
    source: "missing",
    valid: false,
  };
}
