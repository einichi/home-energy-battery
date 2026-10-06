import assert from "node:assert/strict";

import {
  guardDeliverabilityForWindow,
  type GuardWindowOutcome,
} from "../lib/domain/guard-deliverability.js";
import { planChronologicalDiscountedCharging } from "../lib/domain/adaptive-planning.js";

const windowStartMs = Date.parse("2026-10-10T02:00:00.000Z");
const windowEndMs = windowStartMs + 2 * 3_600_000;

function outcome(
  day: number,
  {
    deliveredWh = 2_000,
    interruptionCount = 0,
    guardInterruptedMs = 0,
    solarHeadroomInterruptionCount = 0,
  }: Partial<GuardWindowOutcome> = {},
): GuardWindowOutcome {
  const start = Date.parse(`2026-10-${String(day).padStart(2, "0")}T02:00:00.000Z`);
  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + 2 * 3_600_000).toISOString(),
    label: "Daytime discount",
    plannedWh: 2_000,
    deliveredWh,
    estimatedDeliveryWh: 0,
    interruptionCount,
    guardInterruptedMs,
    solarHeadroomInterruptionCount,
    socTargetReached: false,
    completedAt: new Date(start + 2 * 3_600_000).toISOString(),
  };
}

const history = [
  outcome(6),
  outcome(7),
  outcome(8, { deliveredWh: 1_500, interruptionCount: 1, guardInterruptedMs: 10 * 60_000 }),
  outcome(9, { deliveredWh: 1_000, interruptionCount: 1, guardInterruptedMs: 30 * 60_000 }),
];

const learned = guardDeliverabilityForWindow(history, {
  start: windowStartMs,
  end: windowEndMs,
  label: "Daytime discount",
});

assert.equal(learned.learned, true);
assert.equal(learned.sampleCount, 4);
assert.equal(learned.interruptedSampleCount, 2);
assert.equal(learned.distinctDays, 4);
assert.equal(learned.observedDeliveryRatio, 0.5);
assert.equal(learned.interruptionReserveMs, 30 * 60_000);
assert.equal(learned.deliveryFactor, 0.5);
assert.deepEqual(learned.blockers, []);

const sparse = guardDeliverabilityForWindow(history.slice(0, 3), {
  start: windowStartMs,
  end: windowEndMs,
  label: "Daytime discount",
});

assert.equal(sparse.learned, false);
assert.equal(sparse.deliveryFactor, 1);
assert.match(sparse.blockers.join("; "), /comparable charging windows required/);

const solarInterrupted = guardDeliverabilityForWindow([
  ...history,
  outcome(5, {
    deliveredWh: 0,
    interruptionCount: 1,
    guardInterruptedMs: 2 * 3_600_000,
    solarHeadroomInterruptionCount: 1,
  }),
], {
  start: windowStartMs,
  end: windowEndMs,
  label: "Daytime discount",
});

assert.equal(solarInterrupted.sampleCount, 4);
assert.equal(solarInterrupted.deliveryFactor, learned.deliveryFactor);

const timeline = Array.from({ length: 4 }, (_, index) => ({
  startMs: windowStartMs + index * 30 * 60_000,
  endMs: windowStartMs + (index + 1) * 30 * 60_000,
  netKwh: 0,
  highSolarNetKwh: 0,
  chargeCapacityKwh: 1,
  band: { label: "Daytime discount", yenPerKwh: 12 },
  rateWindowStartMs: windowStartMs,
  rateWindowEndMs: windowEndMs,
}));

const baselinePlan = planChronologicalDiscountedCharging({
  timeline,
  currentStoredKwh: 0,
  capacityKwh: 2,
  dischargeFloorKwh: 0,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2_000,
});

const guardedPlan = planChronologicalDiscountedCharging({
  timeline,
  currentStoredKwh: 0,
  capacityKwh: 2,
  dischargeFloorKwh: 0,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2_000,
  windowSummaries: history,
});

assert.equal(baselinePlan.windows[0]?.guardDeliverability.learned, false);
assert.equal(guardedPlan.windows[0]?.guardDeliverability.learned, true);
assert.equal(guardedPlan.windows[0]?.schedulingSource, "configured+guard-history");
assert.equal(guardedPlan.windows[0]?.schedulingWatts, 1_000);
assert.ok(new Date(guardedPlan.slots[0]!.start).getTime() < new Date(baselinePlan.slots[0]!.start).getTime());
assert.equal(new Date(guardedPlan.slots[0]!.start).getTime(), windowStartMs);

const backfillBaseMs = Date.parse("2026-10-10T00:00:00.000Z");
const earlierWindowEndMs = backfillBaseMs + 2 * 3_600_000;
const laterWindowStartMs = backfillBaseMs + 3 * 3_600_000;
const laterWindowEndMs = backfillBaseMs + 4 * 3_600_000;
const backfillTimeline = [
  ...Array.from({ length: 4 }, (_, index) => ({
    startMs: backfillBaseMs + index * 30 * 60_000,
    endMs: backfillBaseMs + (index + 1) * 30 * 60_000,
    netKwh: 0,
    chargeCapacityKwh: 1,
    band: { label: "Earlier discount", yenPerKwh: 20 },
    rateWindowStartMs: backfillBaseMs,
    rateWindowEndMs: earlierWindowEndMs,
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    startMs: earlierWindowEndMs + index * 30 * 60_000,
    endMs: earlierWindowEndMs + (index + 1) * 30 * 60_000,
    netKwh: 0,
    chargeCapacityKwh: 0,
    band: null,
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    startMs: laterWindowStartMs + index * 30 * 60_000,
    endMs: laterWindowStartMs + (index + 1) * 30 * 60_000,
    netKwh: 0,
    chargeCapacityKwh: 1,
    band: { label: "Cheapest discount", yenPerKwh: 10 },
    rateWindowStartMs: laterWindowStartMs,
    rateWindowEndMs: laterWindowEndMs,
  })),
];
const laterWindowHistory = [6, 7, 8, 9].map((day, index): GuardWindowOutcome => {
  const start = Date.parse(`2026-10-${String(day).padStart(2, "0")}T03:00:00.000Z`);
  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + 3_600_000).toISOString(),
    completedAt: new Date(start + 3_600_000).toISOString(),
    label: "Cheapest discount",
    plannedWh: 2_000,
    deliveredWh: index < 2 ? 2_000 : 1_000,
    interruptionCount: index < 2 ? 0 : 1,
    guardInterruptedMs: index < 2 ? 0 : 15 * 60_000,
    solarHeadroomInterruptionCount: 0,
    socTargetReached: false,
  };
});

const baselineBackfill = planChronologicalDiscountedCharging({
  timeline: backfillTimeline,
  currentStoredKwh: 0.5,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2_000,
});
const guardedBackfill = planChronologicalDiscountedCharging({
  timeline: backfillTimeline,
  currentStoredKwh: 0.5,
  capacityKwh: 5,
  dischargeFloorKwh: 0.5,
  maximumTargetPercent: 100,
  maximumChargeWatts: 2_000,
  windowSummaries: laterWindowHistory,
});

assert.ok(guardedBackfill.windows[0]!.backfillForLaterKwh > baselineBackfill.windows[0]!.backfillForLaterKwh);
assert.equal(guardedBackfill.windows[1]!.guardDeliverability.learned, true);
assert.equal(guardedBackfill.windows[1]!.schedulingWatts, 1_000);
assert.ok(guardedBackfill.unmetChargeKwh < 0.0001);
