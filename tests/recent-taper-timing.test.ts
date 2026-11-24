import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBatteryChargePowerCurve, cleanBatteryLearningPower, type BatteryChargePowerBand,
} from "../lib/domain/battery-learning.js";
import { planChronologicalDiscountedCharging } from "../lib/domain/chronological-charging.js";

const windowEnd = Date.parse("2026-11-24T05:00:00+09:00");
const windowStart = windowEnd - 4 * 3_600_000;
const baseline = [2192, 2192, 1945, 1938, 1218];
const learned = buildBatteryChargePowerCurve([], 2192).map((band, i) => ({
  ...band, source: "learned" as const, activeWatts: baseline[i]!,
}));

function session(daysAgo: number, watts = [1458, 977, 741, 741, 507, 507, 507, 507]) {
  return watts.map((batteryChargingW, i) => ({
    sessionId: String(daysAgo),
    at: new Date(windowStart - daysAgo * 86_400_000 + i * 60_000).toISOString(),
    socPercent: [90, 92, 93, 94, 95, 95, 95, 95][i],
    batteryChargingW,
  }));
}

function rebuild(samples: ReturnType<typeof session>, previous: BatteryChargePowerBand[] = learned) {
  const curve = buildBatteryChargePowerCurve(samples, 2192, {}, previous, new Date(windowStart));
  return cleanBatteryLearningPower({ curve }).curve;
}

function plan(curve: BatteryChargePowerBand[], target = 100, startMs = windowStart) {
  return planChronologicalDiscountedCharging({
    timeline: [{
      startMs, endMs: windowEnd, rateWindowStartMs: windowStart, rateWindowEndMs: windowEnd,
      band: { label: "EVナイトタイム", yenPerKwh: 14.6 }, netKwh: 0, chargeCapacityKwh: 8.768,
    }],
    currentStoredKwh: 5.4 * 0.73, capacityKwh: 5.4, dischargeFloorKwh: 0.54,
    maximumChargeWatts: 2192, maximumTargetPercent: target, chargePowerCurve: curve, chargeWhPerSocPoint: 54,
  });
}

test("repeated high-SOC taper brings the charge forward inside the discounted window", () => {
  const curve = rebuild([...session(1), ...session(2)].reverse());
  assert.deepEqual(curve.map(band => band.activeWatts), baseline);
  assert.equal(curve[4]!.recentSessionWatts, 507);
  const original = plan(learned);
  const adjusted = plan(curve);
  const slot = adjusted.slots[0]!;
  assert.equal(slot.schedulingSource, "soc-curve+recent-taper");
  assert.ok(Date.parse(slot.start) < Date.parse(original.slots[0]!.start) - 15 * 60_000);
  assert.ok(Date.parse(slot.start) >= windowStart);
  assert.equal(Date.parse(slot.end), windowEnd);
  assert.equal(slot.targetWh, original.slots[0]!.targetWh);
  assert.deepEqual(plan(curve, 90), plan(learned, 90));

  const lateStart = windowEnd - 30 * 60_000;
  const constrained = plan(curve, 100, lateStart);
  assert.ok(Date.parse(constrained.slots[0]!.start) >= lateStart);
  assert.ok(constrained.plannedChargeKwh < plan(learned, 100, lateStart).plannedChargeKwh);
});

test("a single slow session, expired readings, or a recovery cannot sustain the timing adjustment", () => {
  const slow = [...session(2), ...session(3)];
  const adjusted = rebuild(slow);
  const recovered = session(1, [1938, 1938, 1938, 1938, 1218, 1218, 1218, 1218]);
  const sparse = session(1).filter((_, i) => i === 0 || i === 3 || i === 4 || i === 7);
  for (const samples of [session(1), [...session(1), ...session(16)], [...slow, ...recovered],
    [...session(2), ...sparse], [...session(1), ...session(-1)]]) {
    const curve = rebuild(samples, adjusted);
    assert.deepEqual(plan(curve), plan(learned));
  }
});
