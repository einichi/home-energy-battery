import type { AdaptiveChargeSlot } from "./adaptive-planning.js";
import type { AutomationRule } from "./automation-rules.js";

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
