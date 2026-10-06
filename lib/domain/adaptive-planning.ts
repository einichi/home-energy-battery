import { adaptiveChargingTimingProfile, effectiveBatteryLearningModel } from "./battery-learning.js";
import type { BatteryChargePowerBand } from "./battery-learning.js";
import { buildFuelCellGenerationModel, predictAwayDemand, predictHouseDemand } from "./demand-forecast.js";
import type { DemandDay, DemandSample } from "./demand-forecast.js";
import { finiteNumberOrNull } from "./numbers.js";
import { applySolarForecastBias, forecastHourForInterval, learnedSolarFactor, nextPlanningBoundary, planningSunsetWithDiscountedWindow, solarCalibrationGroup, solarPowerFromIrradiance, temperatureByDayFromWeather } from "./solar-forecast.js";
import type { SolarForecast, SolarForecastAccuracy, SolarForecastHour } from "./solar-forecast.js";
import { discountedBandOccurrence, explicitDiscountedBand, rateForTimestamp } from "./tariffs.js";
import { halfHourIndex, isAwayAt, localDayKey } from "./time.js";
import type { AwayPeriod } from "./time.js";
import { applyGuardDeliverabilityToTiming, guardDeliverabilityForWindow } from "./guard-deliverability.js";
import type { GuardDeliverabilityModel, GuardWindowOutcome } from "./guard-deliverability.js";
import type { ApplicationConfig, RateBand } from "../contracts/configuration.js";
import {
  mergeAdaptiveChargingSlots,
} from "./adaptive-plan-utils.js";
import {
  adaptiveChargingBaseAvailability,
  forecastIsFresh,
} from "./adaptive-availability.js";

export {
  adaptiveChargingBreakerSettings,
  mergeAdaptiveChargingSlots,
} from "./adaptive-plan-utils.js";
export {
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  forecastIsFresh,
} from "./adaptive-availability.js";

const AWAY_RETURN_BUFFER_MS = 30 * 60_000;

export interface AdaptiveTimelineSlot {
  startMs: number;
  endMs: number;
  demandW?: number;
  solarKwh?: number;
  fuelCellP20Kwh?: number;
  fuelCellMedianKwh?: number;
  fuelCellP80Kwh?: number;
  fuelCellSampleCount?: number;
  demandKwh?: number;
  netKwh: number;
  highSolarNetKwh?: number;
  band: (Pick<RateBand, "label" | "yenPerKwh"> & Partial<RateBand>) | null;
  rateWindowStartMs?: number | null;
  rateWindowEndMs?: number | null;
  chargeCapacityKwh: number;
  away?: boolean;
  awayDemandConfidence?: string | null;
}

export interface AdaptiveChargeSlot {
  [key: string]: unknown;
  slotId?: string;
  start: string;
  end: string;
  yenPerKwh?: number;
  label?: string;
  demandW?: number;
  targetWh: number;
  windowStart?: string;
  windowEnd?: string;
  targetSocPercent?: number;
  modeledDurationMs?: number;
  timingReserveMs?: number;
  schedulingWatts?: number;
  schedulingSource?: string;
  unvalidatedTaper?: boolean;
  continuousWindowCharge?: boolean;
}

interface DiscountedTimelineWindow {
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

interface AdaptiveWindowPlan {
  start: string;
  end: string;
  planningStart: string;
  planningEnd: string;
  label: string;
  yenPerKwh: number;
  storedAtStartKwh: number;
  predictedStartSocPercent: number | null;
  predictedEndStoredKwh: number;
  predictedEndSocPercent: number | null;
  baseTargetStoredKwh: number;
  maximumTargetStoredKwh: number;
  targetStoredKwh: number;
  targetSocPercent: number | null;
  solarHeadroomKwh: number;
  bridgeToCheaperWindow: boolean;
  backfillForLaterKwh: number;
  requestedChargeKwh: number;
  availableChargeKwh: number;
  plannedChargeKwh: number;
  plannedStoredChargeKwh: number;
  unmetChargeKwh: number;
  unmetStoredChargeKwh: number;
  modeledChargeDurationMs: number;
  timingReserveMs: number;
  schedulingWatts: number;
  schedulingSource: string;
  unvalidatedTaper: boolean;
  timeConstrainedWh: number;
  guardDeliverability: GuardDeliverabilityModel;
}

interface ChronologicalPlan {
  slots: AdaptiveChargeSlot[];
  windows: AdaptiveWindowPlan[];
  plannedChargeKwh: number;
  plannedStoredChargeKwh: number;
  requiredGridChargeKwh: number;
  unmetChargeKwh: number;
  unmetStoredChargeKwh: number;
  timeConstrainedWh: number;
  expectedEndStoredKwh: number;
}

interface AdaptivePlanningState {
  forecast: SolarForecast | null;
  historicalWeather?: SolarForecastHour[];
  solarForecastAccuracy?: SolarForecastAccuracy & { sampleCount?: number; measuredFactor?: unknown };
  standbyHoldUntil?: string | null;
  windowSummaries?: GuardWindowOutcome[];
  owner?: string | null;
  activeSlot?: { windowEnd?: string } | null;
  batteryLearning?: NonNullable<Parameters<typeof effectiveBatteryLearningModel>[1]>["batteryLearning"];
  chargingPerformance?: NonNullable<Parameters<typeof effectiveBatteryLearningModel>[1]>["chargingPerformance"];
}

interface AdaptiveTimelineViewEntry {
  start: string;
  end: string;
  solarW: number;
  fuelCellP20W: number;
  fuelCellMedianW: number;
  fuelCellP80W: number;
  fuelCellSampleCount: number;
  demandW: number;
  predictedStartSocPercent: number | null;
  predictedEndSocPercent: number | null;
  predictedSocPercent: number | null;
  discounted: boolean;
  rateLabel: string | null;
  yenPerKwh: number | null;
  plannedChargeWh: number;
  predictedStoredChargeWh: number;
  away: boolean;
  awayDemandConfidence: string | null;
}

interface PlanningInput {
  config: ApplicationConfig;
  state: AdaptivePlanningState;
  samples: DemandSample[];
  historicalDemandDays?: DemandDay[];
  awayPeriods?: AwayPeriod[];
  now?: Date;
}


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
  for (let time = Math.ceil(startMs / stepMs) * stepMs; time < endMs; time += stepMs) {
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


export function discountedTimelineWindows(timeline: AdaptiveTimelineSlot[] = []): DiscountedTimelineWindow[] {
  const windows: DiscountedTimelineWindow[] = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const slot = timeline[index];
    if (!slot.band) continue;
    const previous = windows.at(-1);
    const hasConfiguredOccurrence = Number.isFinite(Number(slot.rateWindowStartMs))
      && Number.isFinite(Number(slot.rateWindowEndMs));
    const configuredStartMs = hasConfiguredOccurrence
      ? Number(slot.rateWindowStartMs)
      : slot.startMs;
    const configuredEndMs = hasConfiguredOccurrence
      ? Number(slot.rateWindowEndMs)
      : slot.endMs;
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
      const controlled = segmentStartMs < new Date(standbyWindowEnd ?? "").getTime()
        || normalizedSlots.some((slot) => slot.continuousWindowCharge
          && segmentStartMs >= slot.startMs && segmentStartMs < new Date(slot.windowEnd ?? slot.end).getTime());
      if (controlled) segment.netKwh = 0;
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


export function planChronologicalDiscountedCharging({
  timeline = [],
  currentStoredKwh,
  capacityKwh,
  dischargeFloorKwh,
  maximumTargetPercent = 100,
  maximumChargeWatts,
  chargePowerCurve = [],
  chargeWhPerSocPoint,
  chargeToStoredRatio = 1,
  standbyWindowEnd = null,
  windowSummaries = [],
}: {
  timeline?: AdaptiveTimelineSlot[];
  currentStoredKwh: number;
  capacityKwh: number;
  dischargeFloorKwh: number;
  maximumTargetPercent?: number;
  maximumChargeWatts: number;
  chargePowerCurve?: BatteryChargePowerBand[];
  chargeWhPerSocPoint?: number;
  chargeToStoredRatio?: number;
  standbyWindowEnd?: string | null;
  windowSummaries?: readonly GuardWindowOutcome[];
}): ChronologicalPlan {
  const chargeConversion = Math.min(1.5, Math.max(0.5, Number(chargeToStoredRatio) || 1));
  const windows = discountedTimelineWindows(timeline);
  const maximumTargetKwh = capacityKwh * Number(maximumTargetPercent) / 100;
  const initialStoredKwh = Math.max(dischargeFloorKwh, Math.min(capacityKwh, Number(currentStoredKwh)));

  const buildPlan = (targetBoosts: number[] = []): ChronologicalPlan => {
    let storedKwh = initialStoredKwh;
    let cursor = 0;
    const selectedSlots: AdaptiveChargeSlot[] = [];
    const windowPlans: AdaptiveWindowPlan[] = [];

    const simulate = (startIndex: number, endIndex: number, chargeByIndex: Map<number, number> = new Map()) => {
      for (let index = startIndex; index < endIndex; index += 1) {
        storedKwh = applyAdaptiveChargingTimelineSlot(
          storedKwh,
          timeline[index],
          chargeByIndex.get(index),
          dischargeFloorKwh,
          capacityKwh,
          chargeConversion,
        );
      }
    };

    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const window = windows[windowIndex];
      simulate(cursor, window.startIndex);
      const storedAtStartKwh = storedKwh;
      let windowSchedulingWatts = maximumChargeWatts;
      const simulateWindow = (chargeByIndex: Map<number, number> = new Map()) => {
        let projectedStoredKwh = storedKwh;
        let chargingStarted = window.startMs < new Date(standbyWindowEnd ?? "").getTime();
        for (let index = window.startIndex; index < window.endIndex; index += 1) {
          const allocated = chargeByIndex.get(index) ?? 0;
          // After charging starts, execution charges continuously then holds
          // Standby. Only the time before its start can discharge in Auto.
          const slot = timeline[index];
          projectedStoredKwh = applyAdaptiveChargingTimelineSlot(
            projectedStoredKwh,
            {
              ...slot,
              netKwh: chargingStarted ? 0 : slot.netKwh,
              chargeCapacityKwh: windowSchedulingWatts * (slot.endMs - slot.startMs) / 3_600_000 / 1000,
            },
            allocated,
            dischargeFloorKwh,
            capacityKwh,
            chargeConversion,
          );
          if (allocated > 0) chargingStarted = true;
        }
        return projectedStoredKwh;
      };
      const noGridStoredKwh = simulateWindow();
      const nextWindow = windows[windowIndex + 1] ?? null;
      const boundaryIndex = nextWindow?.startIndex ?? timeline.length;
      const rangeNeeds = cumulativeRangeNeeds(timeline, window.endIndex, boundaryIndex, chargeConversion);
      const solarHeadroomKwh = Math.min(
        Math.max(0, maximumTargetKwh - dischargeFloorKwh),
        rangeNeeds.maximumSurplusKwh,
      );
      const headroomTargetKwh = Math.max(dischargeFloorKwh, maximumTargetKwh - solarHeadroomKwh);
      const cheaperWindowAhead = Boolean(nextWindow && nextWindow.yenPerKwh < window.yenPerKwh);
      const bridgeTargetKwh = Math.min(
        headroomTargetKwh,
        dischargeFloorKwh + rangeNeeds.maximumDeficitKwh,
      );
      const baseTargetStoredKwh = cheaperWindowAhead ? bridgeTargetKwh : headroomTargetKwh;
      const targetStoredKwh = Math.min(
        headroomTargetKwh,
        baseTargetStoredKwh + Math.max(0, Number(targetBoosts[windowIndex]) || 0),
      );
      const requiredChargeWh = Math.max(0, targetStoredKwh - noGridStoredKwh) * 1000 / chargeConversion;
      const windowDurationMs = Math.max(0, window.endMs - window.startMs);
      const guardDeliverability = guardDeliverabilityForWindow(windowSummaries, {
        start: window.configuredStartMs,
        end: window.configuredEndMs,
        label: window.label,
      });
      const baseTiming = chargePowerCurve.length && Number.isFinite(Number(chargeWhPerSocPoint))
        ? adaptiveChargingTimingProfile({
            requiredWh: requiredChargeWh,
            startSocPercent: capacityKwh ? storedAtStartKwh / capacityKwh * 100 : 0,
            whPerSocPoint: chargeWhPerSocPoint,
            powerCurve: chargePowerCurve,
            fallbackWatts: maximumChargeWatts,
            windowDurationMs,
          })
        : {
            modeledDurationMs: requiredChargeWh / maximumChargeWatts * 3_600_000,
            timingReserveMs: 0,
            scheduledDurationMs: requiredChargeWh / maximumChargeWatts * 3_600_000,
            schedulingWatts: maximumChargeWatts,
            unvalidatedTaper: false,
            physicallyDeliverableWh: maximumChargeWatts * windowDurationMs / 3_600_000,
            timeConstrainedWh: 0,
            source: "configured",
          };
      const timing = applyGuardDeliverabilityToTiming(
        baseTiming,
        guardDeliverability,
        requiredChargeWh,
        windowDurationMs,
      );
      windowSchedulingWatts = timing.schedulingWatts;
      const chargeByIndex = new Map<number, number>();
      let projectedEndKwh = noGridStoredKwh;
      for (let index = window.endIndex - 1; index >= window.startIndex && projectedEndKwh < targetStoredKwh - 0.0001; index -= 1) {
        const slot = timeline[index];
        const slotDurationHours = Math.max(0, slot.endMs - slot.startMs) / 3_600_000;
        const slotCapacityKwh = Math.max(0, windowSchedulingWatts * slotDurationHours / 1000);
        if (!slotCapacityKwh) continue;
        chargeByIndex.set(index, slotCapacityKwh);
        const fullSlotEndKwh = simulateWindow(chargeByIndex);
        if (fullSlotEndKwh <= projectedEndKwh + 0.0001) {
          chargeByIndex.delete(index);
          continue;
        }
        if (fullSlotEndKwh >= targetStoredKwh - 0.0001) {
          let low = 0;
          let high = slotCapacityKwh;
          for (let iteration = 0; iteration < 24; iteration += 1) {
            const candidate = (low + high) / 2;
            chargeByIndex.set(index, candidate);
            if (simulateWindow(chargeByIndex) >= targetStoredKwh) high = candidate;
            else low = candidate;
          }
          chargeByIndex.set(index, high);
        }
        projectedEndKwh = simulateWindow(chargeByIndex);
      }

      for (const [index, allocatedKwh] of chargeByIndex) {
        const slot = timeline[index];
        const durationMs = allocatedKwh * 1000 / windowSchedulingWatts * 3_600_000;
        selectedSlots.push({
          slotId: `${window.configuredStartMs}:${window.configuredEndMs}:${slot.endMs}`,
          start: new Date(slot.endMs - durationMs).toISOString(),
          end: new Date(slot.endMs).toISOString(),
          yenPerKwh: window.yenPerKwh,
          label: window.label,
          demandW: slot.demandW,
          targetWh: Math.max(1, Math.round(allocatedKwh * 1000)),
          modeledDurationMs: timing.modeledDurationMs,
          timingReserveMs: timing.timingReserveMs,
          schedulingWatts: windowSchedulingWatts,
          schedulingSource: timing.source,
          unvalidatedTaper: timing.unvalidatedTaper,
          targetSocPercent: capacityKwh ? targetStoredKwh / capacityKwh * 100 : maximumTargetPercent,
          windowStart: new Date(window.configuredStartMs).toISOString(),
          windowEnd: new Date(window.configuredEndMs).toISOString(),
        });
      }

      storedKwh = simulateWindow(chargeByIndex);
      const predictedEndStoredKwh = storedKwh;
      const windowUnmetStoredKwh = Math.max(0, targetStoredKwh - predictedEndStoredKwh);
      const windowUnmetChargeKwh = windowUnmetStoredKwh / chargeConversion;
      const plannedWindowChargeKwh = [...chargeByIndex.values()].reduce((sum, value) => sum + value, 0);
      const selectedWindowSlots = selectedSlots.filter(
        (slot) => new Date(slot.windowEnd ?? "").getTime() === window.configuredEndMs,
      );
      if (selectedWindowSlots.length) {
        const roundedWindowWh = Math.round(plannedWindowChargeKwh * 1000);
        const roundedSlotWh = selectedWindowSlots.reduce((sum, slot) => sum + slot.targetWh, 0);
        selectedWindowSlots.at(-1)!.targetWh += roundedWindowWh - roundedSlotWh;
      }
      const plannedWindowStoredChargeKwh = plannedWindowChargeKwh * chargeConversion;
      const requestedKwh = plannedWindowChargeKwh + windowUnmetChargeKwh;
      const availableChargeKwh = windowSchedulingWatts * windowDurationMs / 3_600_000 / 1000;
      windowPlans.push({
        start: new Date(window.configuredStartMs).toISOString(),
        end: new Date(window.configuredEndMs).toISOString(),
        planningStart: new Date(window.startMs).toISOString(),
        planningEnd: new Date(window.endMs).toISOString(),
        label: window.label,
        yenPerKwh: window.yenPerKwh,
        storedAtStartKwh,
        predictedStartSocPercent: capacityKwh ? storedAtStartKwh / capacityKwh * 100 : null,
        predictedEndStoredKwh,
        predictedEndSocPercent: capacityKwh ? predictedEndStoredKwh / capacityKwh * 100 : null,
        baseTargetStoredKwh,
        maximumTargetStoredKwh: headroomTargetKwh,
        targetStoredKwh,
        targetSocPercent: capacityKwh ? targetStoredKwh / capacityKwh * 100 : null,
        solarHeadroomKwh,
        bridgeToCheaperWindow: cheaperWindowAhead,
        backfillForLaterKwh: Math.max(0, Number(targetBoosts[windowIndex]) || 0),
        requestedChargeKwh: requestedKwh,
        availableChargeKwh,
        plannedChargeKwh: plannedWindowChargeKwh,
        plannedStoredChargeKwh: plannedWindowStoredChargeKwh,
        unmetChargeKwh: windowUnmetChargeKwh,
        unmetStoredChargeKwh: windowUnmetStoredKwh,
        modeledChargeDurationMs: timing.modeledDurationMs,
        timingReserveMs: timing.timingReserveMs,
        schedulingWatts: windowSchedulingWatts,
        schedulingSource: timing.source,
        unvalidatedTaper: timing.unvalidatedTaper,
        timeConstrainedWh: Math.round(timing.timeConstrainedWh),
        guardDeliverability,
      });
      cursor = window.endIndex;
    }
    simulate(cursor, timeline.length);
    const plannedChargeKwh = selectedSlots.reduce((sum, slot) => sum + slot.targetWh / 1000, 0);
    const unmetChargeKwh = windowPlans.reduce((sum, window) => sum + window.unmetChargeKwh, 0);
    const unmetStoredChargeKwh = windowPlans.reduce(
      (sum, window) => sum + window.unmetStoredChargeKwh,
      0,
    );
    return {
      slots: mergeAdaptiveChargingSlots(selectedSlots),
      windows: windowPlans,
      plannedChargeKwh,
      plannedStoredChargeKwh: plannedChargeKwh * chargeConversion,
      requiredGridChargeKwh: plannedChargeKwh + unmetChargeKwh,
      unmetChargeKwh,
      unmetStoredChargeKwh,
      timeConstrainedWh: windowPlans.reduce((sum, window) => sum + Number(window.timeConstrainedWh || 0), 0),
      expectedEndStoredKwh: storedKwh,
    };
  };

  const targetBoosts = windows.map(() => 0);
  let plan = buildPlan(targetBoosts);
  const maxBackfillIterations = Math.max(1, windows.length * windows.length * 4);
  for (let iteration = 0; iteration < maxBackfillIterations; iteration += 1) {
    const constrainedIndex = plan.windows.findIndex(
      (window, index) => index > 0 && window.unmetStoredChargeKwh > 0.0001,
    );
    if (constrainedIndex < 0) break;
    const constrained = plan.windows[constrainedIndex];
    const candidates = plan.windows
      .map((window, index) => ({ window, index }))
      .filter(({ window, index }) => index < constrainedIndex
        && window.maximumTargetStoredKwh - window.targetStoredKwh > 0.0001)
      .sort((left, right) => left.window.yenPerKwh - right.window.yenPerKwh || right.index - left.index);
    let improved = false;
    for (const candidate of candidates) {
      const roomKwh = candidate.window.maximumTargetStoredKwh - candidate.window.targetStoredKwh;
      const addedKwh = Math.min(constrained.unmetStoredChargeKwh, roomKwh);
      if (addedKwh <= 0.0001) continue;
      const previousBoost = targetBoosts[candidate.index];
      targetBoosts[candidate.index] += addedKwh;
      const trial = buildPlan(targetBoosts);
      if (trial.unmetChargeKwh < plan.unmetChargeKwh - 0.0001) {
        plan = trial;
        improved = true;
        break;
      }
      targetBoosts[candidate.index] = previousBoost;
    }
    if (!improved) break;
  }
  return plan;
}


export function discountedPlanStatus(plan: Partial<ChronologicalPlan> = {}) {
  const unmetChargeKwh = Math.max(0, Number(plan.unmetChargeKwh) || 0);
  if (unmetChargeKwh <= 0.0001) return { available: true, reason: null, warning: null };
  const plannedChargeKwh = Math.max(0, Number(plan.plannedChargeKwh) || 0);
  if (plannedChargeKwh <= 0.0001) {
    return {
      available: false,
      reason: "no discounted charging capacity remains before the planned targets",
      warning: null,
    };
  }
  const requestedChargeKwh = Number.isFinite(Number(plan.requiredGridChargeKwh))
    ? Number(plan.requiredGridChargeKwh)
    : plannedChargeKwh + unmetChargeKwh;
  return {
    available: true,
    reason: null,
    warning: `Plan schedules ${plannedChargeKwh.toFixed(2)} kWh of ${requestedChargeKwh.toFixed(2)} kWh requested; a ${unmetChargeKwh.toFixed(2)} kWh shortfall remains after using feasible discounted capacity`,
  };
}


export function latestFiniteSocPercent(samples: readonly DemandSample[]): number | null {
  // A trailing sample whose SOC is null/undefined/"" must not be coerced to 0 by
  // Number(); skip those and fall back to the most recent genuinely finite value.
  const sample = samples.findLast((item) => finiteNumberOrNull(item.stateOfChargePercent) !== null);
  return finiteNumberOrNull(sample?.stateOfChargePercent);
}


export function buildAdaptiveChargingPlan({
  config,
  state,
  samples,
  historicalDemandDays = [],
  awayPeriods = [],
  now = new Date(),
}: PlanningInput) {
  const unavailable = (reason: string | null) => ({
    available: false,
    reason,
    createdAt: now.toISOString(),
    forecastFetchedAt: state.forecast?.fetchedAt ?? null,
    slots: [],
    timeline: [],
  });
  const baseAvailability = adaptiveChargingBaseAvailability(config);
  if (!baseAvailability.available) return unavailable(baseAvailability.reason);
  if (!forecastIsFresh(state.forecast, now)) return unavailable("solar forecast is stale or unavailable");
  const forecast = state.forecast;
  if (!forecast) return unavailable("solar forecast is stale or unavailable");
  const sunset = planningSunsetWithDiscountedWindow(config, forecast, now);
  if (!sunset) return unavailable("no discounted window is available before the forecast horizon ends");
  const historicalWeather = state.historicalWeather ?? [];
  const temperatures = temperatureByDayFromWeather([...historicalWeather, ...forecast.hours]);
  const soc = latestFiniteSocPercent(samples);
  if (soc === null) return unavailable("battery state of charge is unavailable");
  const batteryModel = effectiveBatteryLearningModel(config, state);
  const capacityKwh = Number(batteryModel.capacityKwh);
  const cachedDischargeLimit = config.settingCache?.discharge_limit;
  const dischargeLimit = Number(cachedDischargeLimit?.lastKnown?.decoded?.percent);
  const dischargeLimitReadAt = new Date(String(cachedDischargeLimit?.lastReadAt ?? "")).getTime();
  if (!Number.isFinite(dischargeLimit)) return unavailable("battery discharge limit is unavailable");
  if (!Number.isFinite(dischargeLimitReadAt) || now.getTime() - dischargeLimitReadAt > 24 * 60 * 60_000) {
    return unavailable("battery discharge limit has not been read successfully in the last 24 hours");
  }
  const initialStoredKwh = capacityKwh * soc / 100;
  const dischargeFloorKwh = capacityKwh * Math.max(0, dischargeLimit) / 100;
  const calibration = learnedSolarFactor(samples, historicalWeather, config);
  const forecastAccuracy = state.solarForecastAccuracy ?? {
    learned: false,
    sampleCount: 0,
    factor: 1,
  };
  const forecastBiasFactor = forecastAccuracy.learned
    && Number.isFinite(Number(forecastAccuracy.factor))
    ? Number(forecastAccuracy.factor)
    : 1;
  const chargePerformance = batteryModel.power;
  const maximumChargeWatts = chargePerformance.effectiveWatts;
  const startMs = now.getTime();
  type HousePrediction = ReturnType<typeof predictHouseDemand>;
  type AwayPrediction = ReturnType<typeof predictAwayDemand>;
  const demandByDay = new Map<string, { home: HousePrediction; away: AwayPrediction }>();
  const fuelCellModel = buildFuelCellGenerationModel(config, samples, now, {
    temperatureByDay: temperatures,
    awayPeriods,
  });
  const timeline: AdaptiveTimelineSlot[] = [];
  let predictedSolarKwh = 0;
  let forecastSolarKwh = 0;
  let predictedDemandKwh = 0;
  let predictedSurplusKwh = 0;
  let predictedFuelCellKwh = 0;
  let awaySlotCount = 0;
  let awayLearnedSlotCount = 0;
  let awayFallbackSlotCount = 0;
  const awayComparableDays = new Set<string>();
  for (let time = startMs; time < sunset.timestamp;) {
    const date = new Date(time);
    const dayKey = localDayKey(date);
    if (!demandByDay.has(dayKey)) {
      const home = predictHouseDemand(samples, date, temperatures, {
        historicalDays: historicalDemandDays,
        awayPeriods,
        occupancy: "home",
      });
      if (!home.available) return unavailable(home.reason);
      const away = predictAwayDemand(samples, date, temperatures, {
        historicalDays: historicalDemandDays,
        awayPeriods,
        normalPrediction: home,
      });
      demandByDay.set(dayKey, { home, away });
    }
    const demand = demandByDay.get(dayKey)!;
    const slotEndMs = nextPlanningBoundary(time, sunset.timestamp);
    const hour = forecastHourForInterval(forecast, time, slotEndMs);
    const factor = calibration.groupFactors?.[solarCalibrationGroup(date)] ?? calibration.factor;
    const uncorrectedSolarW = solarPowerFromIrradiance(hour?.tiltedIrradianceWm2, config, factor);
    const rawSolarW = applySolarForecastBias(
      uncorrectedSolarW,
      Number(config.adaptiveCharging.arrayPeakKw) * 1000,
      forecastAccuracy,
    );
    const margin = Number(config.adaptiveCharging.forecastMarginPercent) / 100;
    const solarW = rawSolarW * (1 - margin);
    const highSolarW = Math.min(Number(config.adaptiveCharging.arrayPeakKw) * 1000, rawSolarW * (1 + margin));
    const bucket = halfHourIndex(date);
    const away = isAwayAt((time + slotEndMs) / 2, awayPeriods, { forecast: true });
    const awayLearned = away && demand.away.learnedBuckets.has(bucket);
    const slotDemandW = Number((away ? demand.away.profile : demand.home.profile).get(bucket) ?? 0);
    if (away) {
      awaySlotCount += 1;
      if (awayLearned) awayLearnedSlotCount += 1;
      else awayFallbackSlotCount += 1;
      for (const key of demand.away.comparableDays) awayComparableDays.add(key);
    }
    const durationHours = (slotEndMs - time) / 3_600_000;
    const solarKwh = solarW * durationHours / 1000;
    forecastSolarKwh += rawSolarW * durationHours / 1000;
    const highSolarKwh = highSolarW * durationHours / 1000;
    const demandKwh = slotDemandW * durationHours / 1000;
    const fuelCellForecast = fuelCellModel.forecastAt(date);
    const fuelCellPlanningKwh = fuelCellModel.influence === "active"
      ? fuelCellForecast.p20W * durationHours / 1000
      : 0;
    const highFuelCellKwh = fuelCellModel.influence === "active"
      ? fuelCellForecast.p80W * durationHours / 1000
      : 0;
    const medianFuelCellKwh = fuelCellForecast.medianW * durationHours / 1000;
    predictedSolarKwh += solarKwh;
    predictedDemandKwh += demandKwh;
    predictedFuelCellKwh += medianFuelCellKwh;
    predictedSurplusKwh += Math.max(0, solarKwh + medianFuelCellKwh - demandKwh);
    const band = explicitDiscountedBand(config, date);
    const bandOccurrence = band ? discountedBandOccurrence(config, date) : null;
    timeline.push({
      startMs: time,
      endMs: slotEndMs,
      demandW: slotDemandW,
      solarKwh,
      fuelCellP20Kwh: fuelCellForecast.p20W * durationHours / 1000,
      fuelCellMedianKwh: medianFuelCellKwh,
      fuelCellP80Kwh: fuelCellForecast.p80W * durationHours / 1000,
      fuelCellSampleCount: fuelCellForecast.sampleCount,
      demandKwh,
      netKwh: solarKwh + fuelCellPlanningKwh - demandKwh,
      highSolarNetKwh: highSolarKwh + highFuelCellKwh - demandKwh,
      band,
      rateWindowStartMs: bandOccurrence ? new Date(bandOccurrence.start).getTime() : null,
      rateWindowEndMs: bandOccurrence ? new Date(bandOccurrence.end).getTime() : null,
      chargeCapacityKwh: band
        ? maximumChargeWatts * durationHours / 1000
        : 0,
      away,
      awayDemandConfidence: away ? (awayLearned ? "learned" : "low") : null,
    });
    time = slotEndMs;
  }
  const demandPredictions = [...demandByDay.values()].map((prediction) => prediction.home);
  const standbyWindowEnd = state.standbyHoldUntil
    ?? (state.owner === "adaptiveCharging" ? state.activeSlot?.windowEnd : null);
  const optimized = planChronologicalDiscountedCharging({
    timeline,
    currentStoredKwh: initialStoredKwh,
    capacityKwh,
    dischargeFloorKwh,
    maximumTargetPercent: Number(config.adaptiveCharging.targetSocPercent),
    maximumChargeWatts,
    chargePowerCurve: chargePerformance.curve,
    chargeWhPerSocPoint: batteryModel.charge.whPerSocPoint,
    chargeToStoredRatio: batteryModel.chargeToStoredRatio,
    standbyWindowEnd,
    windowSummaries: state.windowSummaries,
  });
  const timelineView = buildAdaptiveChargingTimelineView({
    timeline,
    slots: optimized.slots,
    initialStoredKwh,
    floorKwh: dischargeFloorKwh,
    capacityKwh,
    chargeToStoredRatio: batteryModel.chargeToStoredRatio,
    standbyWindowEnd,
    config,
  });
  const planStatus = discountedPlanStatus(optimized);
  return {
    ...planStatus,
    createdAt: now.toISOString(),
    targetDate: sunset.date,
    targetSunset: new Date(sunset.timestamp).toISOString(),
    forecastFetchedAt: state.forecast?.fetchedAt ?? null,
    currentSocPercent: soc,
    dischargeLimitPercent: dischargeLimit,
    dischargeLimitReadAt: new Date(dischargeLimitReadAt).toISOString(),
    targetSocPercent: Number(config.adaptiveCharging.targetSocPercent),
    expectedSunsetSocPercent: capacityKwh ? Math.min(100, optimized.expectedEndStoredKwh / capacityKwh * 100) : null,
    predictedSolarKwh,
    forecastSolarKwh,
    predictedDemandKwh,
    predictedFuelCellKwh,
    predictedSurplusKwh,
    fuelCellModel: {
      method: fuelCellModel.method,
      requestedInfluence: fuelCellModel.requestedInfluence,
      influence: fuelCellModel.influence,
      ready: fuelCellModel.ready,
      blockers: fuelCellModel.blockers,
      validObservationDays: fuelCellModel.validObservationDays,
      comparableDays: fuelCellModel.comparableDays,
    },
    chargePerformance,
    batteryModel,
    ...optimized,
    comparableDemandDays: [...new Set(demandPredictions.flatMap((prediction) => prediction.comparableDays))],
    demandHistory: {
      recordedDayCount: Math.max(...demandPredictions.map((prediction) => prediction.recordedDayCount)),
      validDayCount: Math.max(...demandPredictions.map((prediction) => prediction.validDayCount)),
      sameDayTypeDayCount: Math.max(...demandPredictions.map((prediction) => prediction.sameDayTypeDays.length)),
      usedDayTypeFallback: demandPredictions.some((prediction) => prediction.usedDayTypeFallback),
      recentComparableDayCount: Math.max(...demandPredictions.map((prediction) => prediction.recentComparableDays.length)),
      seasonalComparableDayCount: Math.max(...demandPredictions.map((prediction) => prediction.seasonalComparableDays.length)),
      seasonalYears: [...new Set(demandPredictions.flatMap((prediction) => prediction.seasonalYears))]
        .sort((left, right) => right - left),
      seasonalBlendPercent: Math.round(Math.max(
        ...demandPredictions.map((prediction) => prediction.seasonalBlendWeight * 100),
      )),
      awayComparableDayCount: awayComparableDays.size,
      awaySlotCount,
      awayLearnedSlotCount,
      awayFallbackSlotCount,
      awayConfidence: awaySlotCount === 0
        ? "not-scheduled"
        : awayFallbackSlotCount === 0
          ? "learned"
          : awayLearnedSlotCount > 0
            ? "mixed"
            : "low",
      awayReturnBufferMinutes: AWAY_RETURN_BUFFER_MS / 60_000,
    },
    solarCalibration: calibration,
    solarForecastBias: {
      learned: forecastAccuracy.learned === true,
      sampleCount: Number(forecastAccuracy.sampleCount) || 0,
      factor: forecastBiasFactor,
      measuredFactor: finiteNumberOrNull(forecastAccuracy.measuredFactor),
    },
    slots: optimized.slots,
    timeline: timelineView,
  };
}
