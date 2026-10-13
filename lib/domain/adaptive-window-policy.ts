import type { AdaptiveTimelineSlot } from "./adaptive-planning-types.js";

export const MIN_WINDOW_SOLAR_WH = 100;
export const MIN_WINDOW_SURPLUS_WH = 50;
export const MIN_WINDOW_SURPLUS_W = 200;

export function discountedWindowSolarOpportunity(slots: readonly AdaptiveTimelineSlot[]) {
  let solarWh = 0;
  let surplusWh = 0;
  let peakSurplusW = 0;
  for (const slot of slots) {
    const hours = Math.max(0, slot.endMs - slot.startMs) / 3_600_000;
    if (!hours) continue;
    // netKwh already excludes observe-only generation.
    const surplusKwh = Math.max(0, slot.netKwh);
    solarWh += Math.max(0, slot.solarKwh ?? surplusKwh) * 1000;
    surplusWh += surplusKwh * 1000;
    peakSurplusW = Math.max(peakSurplusW, surplusKwh * 1000 / hours);
  }
  return solarWh >= MIN_WINDOW_SOLAR_WH
    && surplusWh >= MIN_WINDOW_SURPLUS_WH
    && peakSurplusW >= MIN_WINDOW_SURPLUS_W;
}
