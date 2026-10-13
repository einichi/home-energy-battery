import assert from "node:assert/strict";

import { createAdaptiveHistoryService } from "../lib/services/adaptive-history-service.js";
import type { HistorySample } from "../lib/contracts/history.js";

const now = new Date("2026-08-10T12:00:00.000Z");
const source: HistorySample[] = [
  { timestamp: "2026-08-10T11:00:00.000Z", stateOfChargePercent: 50, fuelCellHotWaterLevel: 0 },
  { timestamp: "2026-08-10T11:05:00.000Z", batteryPowerW: 10, fuelCellHotWaterLevel: 5 },
  { timestamp: "2026-08-10T11:10:00.000Z", branchDemandW: 20, fuelCellHotWaterLevel: null },
];
let queryCount = 0;
const history = createAdaptiveHistoryService({
  querySamples: () => { queryCount += 1; return source; },
  eventsBetween: () => [],
  isReady: () => false,
  batteryChargeCurveSamples: () => [],
  recordEvent: () => true,
}, { cacheMs: 60_000, seasonalLookbackYears: 2 });

const first = await history.readHistory(now);
assert.deepEqual(first.map((sample) => sample.fuelCellHotWaterLevel), [0, 5, null]);
assert.deepEqual((await history.readHistory(new Date(now.getTime() + 1_000)))
  .map((sample) => sample.fuelCellHotWaterLevel), [0, 5, null]);
assert.equal(queryCount, 1, "cached compact samples should retain all hot-water readings, including null");

history.noteSample({ timestamp: "2026-08-10T11:59:00.000Z", stateOfChargePercent: 60, fuelCellHotWaterLevel: 0 });
assert.equal((await history.readHistory(new Date(now.getTime() + 2_000))).at(-1)?.fuelCellHotWaterLevel, 0);

let demandQueries = 0;
const demandHistory = createAdaptiveHistoryService({
  querySamples: (_start, _end, options) => {
    if (options?.resolution === "interval") demandQueries += 1;
    return [];
  },
  eventsBetween: () => [], isReady: () => false, batteryChargeCurveSamples: () => [], recordEvent: () => true,
}, { cacheMs: 60_000, seasonalLookbackYears: 10 });
await demandHistory.readDemandProfileDays();
await demandHistory.readDemandProfileDays();
await demandHistory.readDemandProfileDays();
assert.equal(demandQueries, 1, "sequential replans should reuse the bounded demand profile cache");
await demandHistory.readDemandProfileDays();
assert.equal(demandQueries, 1);
demandHistory.invalidate();
await demandHistory.readDemandProfileDays();
assert.equal(demandQueries, 2, "retention/restore invalidation must force a fresh demand profile");

const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12, 10, 0, 0);
const incremental = createAdaptiveHistoryService({
  querySamples: () => [{ timestamp: yesterday.toISOString(), branchDemandW: 500, powerCoverageSeconds: { branchDemandW: 600 } }],
  eventsBetween: () => [], isReady: () => false, batteryChargeCurveSamples: () => [], recordEvent: () => true,
}, { cacheMs: 60_000, seasonalLookbackYears: 10 });
const unchangedDay = (await incremental.readDemandProfileDays())[0];
const newSample = new Date(Date.now() + 1_000);
incremental.noteSample({ timestamp: newSample.toISOString(), branchDemandW: 1_000, powerCoverageSeconds: { branchDemandW: 30 } });
const updatedDays = await incremental.readDemandProfileDays();
assert.equal(updatedDays.length, 2);
assert.equal(updatedDays[0], unchangedDay, "an incremental update must not reconstruct unrelated years of history");
console.log("adaptive history service tests passed");
