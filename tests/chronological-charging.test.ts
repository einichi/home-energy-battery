import assert from "node:assert/strict";
import test from "node:test";
import { discountedPlanStatus, planChronologicalDiscountedCharging } from "../lib/domain/chronological-charging.js";
import type { AdaptiveTimelineSlot } from "../lib/domain/adaptive-planning-types.js";

const hour = 3_600_000;
const start = Date.parse("2026-10-26T02:00:00Z"); // 11am JST
function timeline(): AdaptiveTimelineSlot[] {
  return Array.from({ length: 18 }, (_, index) => ({
    startMs: start + index * hour, endMs: start + (index + 1) * hour,
    demandW: 300, solarKwh: 0, demandKwh: 0.3,
    netKwh: -0.3,
    // A quiet Away trip can still retain this upper estimate while provisional.
    highSolarNetKwh: 0.7 - 0.3,
    band: index < 2 ? { start: "11:00", end: "13:00", yenPerKwh: 12.6, label: "Day" }
      : index >= 14 ? { start: "01:00", end: "05:00", yenPerKwh: 14.6, label: "Night" } : null,
    chargeCapacityKwh: index < 2 || index >= 14 ? 2.192 : 0,
  }));
}
const input = { currentStoredKwh: 0, capacityKwh: 5.4, dischargeFloorKwh: 0,
  maximumChargeWatts: 2192, roundTripEfficiency: 0.9, displacedRateYenPerKwh: 25.77 };

test("speculative ENE-FARM headroom cannot leave a deficit before the next charging window", () => {
  for (const nextRate of [10, 14.6]) {
    const slots = timeline();
    for (const slot of slots.slice(14)) slot.band = { ...slot.band!, yenPerKwh: nextRate };
    const plan = planChronologicalDiscountedCharging({ ...input, timeline: slots });
    const day = plan.windows[0]!;
    assert.ok(day.targetStoredKwh >= 3.6 - 0.0001, "12 hours of 300 W demand must take priority over speculative headroom");
    assert.ok(day.predictedEndStoredKwh >= 3.6 - 0.0001);
    assert.ok(plan.windows[1]!.storedAtStartKwh >= -0.0001);
    assert.ok(Math.abs(day.solarHeadroomKwh + day.maximumTargetStoredKwh - 5.4) < 0.0001);
  }
});

test("the bridge includes the reserve floor and respects the configured maximum SOC", () => {
  const plan = planChronologicalDiscountedCharging({ ...input, timeline: timeline(), dischargeFloorKwh: 0.54 });
  assert.ok(plan.windows[0]!.targetStoredKwh >= 4.14 - 0.0001);
  assert.ok(plan.windows[1]!.storedAtStartKwh >= 0.54 - 0.0001);
  const capped = planChronologicalDiscountedCharging({ ...input, timeline: timeline(), maximumTargetPercent: 50 });
  assert.ok(Math.abs(capped.windows[0]!.targetStoredKwh - 2.7) < 0.0001);
});

test("insufficient charging power reports the bridge shortfall instead of hiding it behind headroom", () => {
  const plan = planChronologicalDiscountedCharging({ ...input, timeline: timeline(), maximumChargeWatts: 500 });
  assert.ok(plan.windows[0]!.unmetStoredChargeKwh >= 2.6 - 0.0001);
  assert.match(discountedPlanStatus(plan).warning!, /shortfall remains/);
});

test("supported surplus still reserves headroom when the bridge is covered", () => {
  const slots = timeline();
  // 1 kWh of real early surplus followed by 1.1 kWh demand; a 4.4 kWh
  // charge target leaves space for that surplus and covers the later demand.
  for (const slot of slots.slice(2, 14)) {
    slot.netKwh = -0.1;
    slot.highSolarNetKwh = -0.1;
  }
  slots[2]!.netKwh = 1;
  slots[2]!.highSolarNetKwh = 1;
  slots[2]!.solarKwh = 1.3;
  const plan = planChronologicalDiscountedCharging({ ...input, timeline: slots, currentStoredKwh: 1 });
  assert.ok(Math.abs(plan.windows[0]!.solarHeadroomKwh - 1) < 0.0001);
  assert.ok(Math.abs(plan.windows[0]!.targetStoredKwh - 4.4) < 0.0001);
});
