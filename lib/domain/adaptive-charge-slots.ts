import type { ApplicationConfig } from "../contracts/configuration.js";
import { explicitDiscountedBand } from "./tariffs.js";
import { firstLocalSlotBoundary } from "./adaptive-plan-utils.js";
import type { AdaptiveChargeSlot } from "./adaptive-planning-types.js";

export function optimizeDiscountedChargeSlots({
  config,
  start,
  end,
  requiredKwh,
  demandBySlot = new Map(),
  slotMinutes = 30,
}: {
  config: ApplicationConfig;
  start: Date | string | number;
  end: Date | string | number;
  requiredKwh: number;
  demandBySlot?: Map<number, number>;
  slotMinutes?: number;
}) {
  const maximumChargeWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const slots: Array<{
    start: string;
    end: string;
    yenPerKwh: number;
    label: string;
    demandW: number;
    capacityKwh: number;
  }> = [];
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const stepMs = slotMinutes * 60_000;
  for (let time = firstLocalSlotBoundary(startMs, slotMinutes); time < endMs; time += stepMs) {
    const date = new Date(time);
    const band = explicitDiscountedBand(config, date);
    if (!band) continue;
    const demandW = Number(demandBySlot.get(time) ?? 0);
    slots.push({
      start: date.toISOString(),
      end: new Date(Math.min(time + stepMs, endMs)).toISOString(),
      yenPerKwh: Number(band.yenPerKwh),
      label: band.label || "Discounted",
      demandW,
      capacityKwh: maximumChargeWatts * ((Math.min(time + stepMs, endMs) - time) / 3_600_000) / 1000,
    });
  }
  slots.sort((left, right) => left.yenPerKwh - right.yenPerKwh || new Date(right.start).getTime() - new Date(left.start).getTime());
  let remaining = Math.max(0, Number(requiredKwh) || 0);
  const selected: AdaptiveChargeSlot[] = [];
  for (const slot of slots) {
    if (remaining <= 0.0001) break;
    const allocatedKwh = Math.min(slot.capacityKwh, remaining);
    const durationMs = allocatedKwh * 1000 / maximumChargeWatts * 3_600_000;
    selected.push({
      ...slot,
      slotId: `optimized:${slot.end}`,
      start: new Date(new Date(slot.end).getTime() - durationMs).toISOString(),
      targetWh: Math.max(1, Math.round(allocatedKwh * 1000)),
    });
    remaining -= allocatedKwh;
  }
  return {
    slots: selected.sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime()),
    plannedChargeKwh: Math.max(0, Number(requiredKwh) || 0) - remaining,
    unmetChargeKwh: Math.max(0, remaining),
  };
}
