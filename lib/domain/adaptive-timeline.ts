import { finiteNumberOrNull } from "./numbers.js";
import { rateForTimestamp } from "./tariffs.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargeSlot, AdaptiveTimelineSlot, AdaptiveTimelineViewEntry } from "./adaptive-planning-types.js";

export function cumulativeRangeNeeds(
  timeline: readonly AdaptiveTimelineSlot[],
  startIndex: number,
  endIndex: number,
  chargeToStoredRatio = 1,
) {
  let lowCumulative = 0;
  let highCumulative = 0;
  let maximumDeficitKwh = 0;
  let maximumSurplusKwh = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const lowNet = Number(timeline[index]?.netKwh ?? 0);
    const highNet = Number(timeline[index]?.highSolarNetKwh ?? timeline[index]?.netKwh ?? 0);
    lowCumulative += lowNet > 0 ? lowNet * chargeToStoredRatio : lowNet;
    highCumulative += highNet > 0 ? highNet * chargeToStoredRatio : highNet;
    maximumDeficitKwh = Math.max(maximumDeficitKwh, -lowCumulative);
    maximumSurplusKwh = Math.max(maximumSurplusKwh, highCumulative);
  }
  return { maximumDeficitKwh, maximumSurplusKwh };
}


export function applyPredictedBatteryFlow(
  storedKwh: number,
  netKwh: unknown,
  floorKwh: number,
  capacityKwh: number,
  chargeToStoredRatio = 1,
): number {
  const net = Number(netKwh || 0);
  const converted = net > 0 ? net * chargeToStoredRatio : net;
  return Math.max(floorKwh, Math.min(capacityKwh, storedKwh + converted));
}


export function applyAdaptiveChargingTimelineSlot(
  storedKwh: number,
  slot: Pick<AdaptiveTimelineSlot, "chargeCapacityKwh" | "netKwh">,
  chargeKwh: unknown,
  floorKwh: number,
  capacityKwh: number,
  chargeToStoredRatio = 1,
): number {
  const allocatedChargeKwh = Math.max(0, Number(chargeKwh) || 0);
  const conversion = Math.min(1.5, Math.max(0.5, Number(chargeToStoredRatio) || 1));
  const slotChargeCapacityKwh = Math.max(0, Number(slot?.chargeCapacityKwh) || 0);
  const forcedChargeFraction = slotChargeCapacityKwh > 0
    ? Math.min(1, allocatedChargeKwh / slotChargeCapacityKwh)
    : 0;
  const autoNetKwh = Number(slot?.netKwh || 0) * (1 - forcedChargeFraction);
  const afterAuto = applyPredictedBatteryFlow(storedKwh, autoNetKwh, floorKwh, capacityKwh, conversion);
  return Math.min(capacityKwh, afterAuto + allocatedChargeKwh * conversion);
}


export function buildAdaptiveChargingTimelineView({
  timeline = [],
  slots = [],
  initialStoredKwh,
  floorKwh,
  capacityKwh,
  chargeToStoredRatio = 1,
  config,
  standbyWindowEnd = null,
}: {
  timeline?: AdaptiveTimelineSlot[];
  slots?: AdaptiveChargeSlot[];
  initialStoredKwh: number;
  floorKwh: number;
  capacityKwh: number;
  chargeToStoredRatio?: number;
  config: Pick<ApplicationConfig, "rateBands" | "standardRateYenPerKwh">;
  standbyWindowEnd?: string | null;
}) {
  let storedKwh = Math.max(floorKwh, Math.min(capacityKwh, Number(initialStoredKwh)));
  const normalizedSlots = slots.map((slot) => ({
    ...slot,
    startMs: new Date(slot.start).getTime(),
    endMs: new Date(slot.end).getTime(),
    targetKwh: Math.max(0, Number(slot.targetWh) || 0) / 1000,
  })).filter((slot) => Number.isFinite(slot.startMs)
    && Number.isFinite(slot.endMs)
    && slot.endMs > slot.startMs);
  const view: AdaptiveTimelineViewEntry[] = [];

  for (const interval of timeline) {
    const intervalDurationMs = Math.max(0, interval.endMs - interval.startMs);
    if (!(intervalDurationMs > 0)) continue;
    const intervalSlots = normalizedSlots.filter(
      (slot) => slot.startMs < interval.endMs && slot.endMs > interval.startMs,
    );
    const boundaries = [...new Set([
      interval.startMs,
      interval.endMs,
      ...intervalSlots.flatMap((slot) => [
        Math.max(interval.startMs, slot.startMs),
        Math.min(interval.endMs, slot.endMs),
      ]),
    ])].sort((left, right) => left - right);

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const segmentStartMs = boundaries[index];
      const segmentEndMs = boundaries[index + 1];
      const segmentDurationMs = segmentEndMs - segmentStartMs;
      if (!(segmentDurationMs > 0)) continue;
      const intervalFraction = segmentDurationMs / intervalDurationMs;
      const plannedChargeKwh = intervalSlots.reduce((sum, slot) => {
        const overlapMs = Math.max(
          0,
          Math.min(segmentEndMs, slot.endMs) - Math.max(segmentStartMs, slot.startMs),
        );
        return sum + slot.targetKwh * overlapMs / (slot.endMs - slot.startMs);
      }, 0);
      const segment: AdaptiveTimelineSlot = {
        ...interval,
        startMs: segmentStartMs,
        endMs: segmentEndMs,
        solarKwh: Number(interval.solarKwh || 0) * intervalFraction,
        fuelCellP20Kwh: Number(interval.fuelCellP20Kwh || 0) * intervalFraction,
        fuelCellMedianKwh: Number(interval.fuelCellMedianKwh || 0) * intervalFraction,
        fuelCellP80Kwh: Number(interval.fuelCellP80Kwh || 0) * intervalFraction,
        netKwh: Number(interval.netKwh || 0) * intervalFraction,
        chargeCapacityKwh: Number(interval.chargeCapacityKwh || 0) * intervalFraction,
      };
      const standbyHold = segmentStartMs < new Date(standbyWindowEnd ?? "").getTime();
      const chargingSegment = normalizedSlots.some((slot) => slot.continuousWindowCharge
        && segmentStartMs >= slot.startMs && segmentStartMs < new Date(slot.windowEnd ?? slot.end).getTime());
      if (standbyHold) segment.netKwh = 0;
      else if (chargingSegment) segment.netKwh = Math.max(0, Number(segment.netKwh || 0));
      const startingStoredKwh = storedKwh;
      storedKwh = applyAdaptiveChargingTimelineSlot(
        storedKwh,
        segment,
        plannedChargeKwh,
        floorKwh,
        capacityKwh,
        chargeToStoredRatio,
      );
      const durationHours = segmentDurationMs / 3_600_000;
      const rate = interval.band ?? rateForTimestamp(
        config.rateBands,
        new Date(segmentStartMs),
        config.standardRateYenPerKwh,
      );
      view.push({
        start: new Date(segmentStartMs).toISOString(),
        end: new Date(segmentEndMs).toISOString(),
        solarW: durationHours > 0 ? Number(segment.solarKwh || 0) * 1000 / durationHours : 0,
        fuelCellP20W: durationHours > 0 ? Number(segment.fuelCellP20Kwh || 0) * 1000 / durationHours : 0,
        fuelCellMedianW: durationHours > 0 ? Number(segment.fuelCellMedianKwh || 0) * 1000 / durationHours : 0,
        fuelCellP80W: durationHours > 0 ? Number(segment.fuelCellP80Kwh || 0) * 1000 / durationHours : 0,
        fuelCellSampleCount: interval.fuelCellSampleCount ?? 0,
        demandW: Number(interval.demandW) || 0,
        predictedStartSocPercent: capacityKwh > 0 ? startingStoredKwh / capacityKwh * 100 : null,
        predictedEndSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        predictedSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        discounted: Boolean(interval.band),
        rateLabel: rate?.label ?? null,
        yenPerKwh: finiteNumberOrNull(rate?.yenPerKwh),
        plannedChargeWh: Math.round(plannedChargeKwh * 1000),
        predictedStoredChargeWh: Math.round(plannedChargeKwh * chargeToStoredRatio * 1000),
        away: interval.away === true,
        awayDemandConfidence: interval.awayDemandConfidence ?? null,
      });
    }
  }
  return view;
}
