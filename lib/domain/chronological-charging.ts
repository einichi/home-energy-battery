import { adaptiveChargingTimingProfile } from "./battery-learning.js";
import type { BatteryChargePowerBand } from "./battery-learning.js";
import { applyGuardDeliverabilityToTiming, guardDeliverabilityForWindow } from "./guard-deliverability.js";
import type { GuardWindowOutcome } from "./guard-deliverability.js";
import { discountedTimelineWindows, mergeAdaptiveChargingSlots } from "./adaptive-plan-utils.js";
import { applyAdaptiveChargingTimelineSlot, cumulativeRangeNeeds } from "./adaptive-timeline.js";
import type { AdaptiveChargeSlot, AdaptiveTimelineSlot, AdaptiveWindowPlan, ChronologicalPlan } from "./adaptive-planning-types.js";

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
  roundTripEfficiency = 1,
  displacedRateYenPerKwh = Number.POSITIVE_INFINITY,
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
  roundTripEfficiency?: number;
  displacedRateYenPerKwh?: number;
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
          // While charging, the controller interrupts grid charging to capture
          // solar surplus, so keep surplus (clamped >= 0) instead of dropping it;
          // demand deficits are served by the grid while in charging mode.
          const slot = timeline[index];
          const netKwh = chargingStarted ? Math.max(0, Number(slot.netKwh || 0)) : slot.netKwh;
          projectedStoredKwh = applyAdaptiveChargingTimelineSlot(
            projectedStoredKwh,
            {
              ...slot,
              netKwh,
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
      // Only grid-charge when the discounted price, adjusted for round-trip
      // efficiency, beats the price the stored energy displaces.
      const economic = !Number.isFinite(displacedRateYenPerKwh)
        || window.yenPerKwh / roundTripEfficiency < displacedRateYenPerKwh;
      const targetStoredKwh = economic
        ? Math.min(
            headroomTargetKwh,
            baseTargetStoredKwh + Math.max(0, Number(targetBoosts[windowIndex]) || 0),
          )
        : noGridStoredKwh;
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
        economic,
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
        && window.economic !== false
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
