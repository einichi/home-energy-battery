import assert from "node:assert/strict";

import { cleanConfig } from "../lib/domain/configuration.js";
import { cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { cleanBatteryLearningModel } from "../lib/domain/battery-learning.js";
import { buildFuelCellGenerationModel } from "../lib/domain/demand-forecast.js";
import { refreshAdaptivePlan } from "../lib/services/adaptive-plan-refresh.js";
import type { HistorySample } from "../lib/contracts/history.js";

const now = new Date("2026-08-10T12:00:00.000Z");
const config = cleanConfig({ fuelCellEnabled: true });
const samples: Array<HistorySample & { timestamp: string }> = [{
  timestamp: new Date(now.getTime() - 60_000).toISOString(), fuelCellHotWaterLevel: 2,
}];
const status = {
  energy: {
    battery: { remaining_percent: { value: 50 }, instant_power: { value: 0 } },
    solar: { instant_power: { value: 0 } },
    fuel_cells: [
      {
        source_role: "primary",
        instant_power: { value: null },
        generation_status: { value: null },
        hot_water_level: { value: 5 },
      },
      {
        source_role: "proxy",
        instant_power: { value: 1_200 },
        generation_status: { value: "generating" },
      },
    ],
  },
  meter: { branch_demand_power: { value: 300 } },
};
const dependencies = {
  readHistory: async () => samples,
  historicalWeather: () => [],
  solarForecastAccuracy: () => ({
    learned: false, sampleCount: 0, measuredFactor: null, factor: 1,
    meanAbsolutePercentageError: null, outcomes: [],
  }),
  refreshBatteryLearning: async () => cleanBatteryLearningModel(),
  readDemandProfileDays: async () => [],
  recordFuelCellPlanForecast: () => 0,
  appendLog: () => undefined,
};

await refreshAdaptivePlan(cleanAdaptiveChargingState(), config, status, [], {}, now, dependencies);
const live = samples.at(-1)!;
assert.equal(live.timestamp, now.toISOString());
assert.equal(live.fuelCellHotWaterLevel, 5, "the current primary tank reading should supersede older history");
assert.equal(live.fuelCellPowerW, 1_200, "proxy power should be selected when primary power and state are unavailable");
assert.equal(live.fuelCellGenerationState, "generating", "proxy generation state should accompany proxy power");

const disabledSamples: Array<HistorySample & { timestamp: string }> = [];
await refreshAdaptivePlan(cleanAdaptiveChargingState(), cleanConfig({ fuelCellEnabled: false }), status, [], {}, now, {
  ...dependencies,
  readHistory: async () => disabledSamples,
});
assert.equal(Object.hasOwn(disabledSamples[0]!, "fuelCellHotWaterLevel"), false, "disabled fuel cells must not create a synthetic live reading");

const staleSamples: Array<HistorySample & { timestamp: string }> = [];
const staleAt = new Date(now.getTime() - 46 * 60_000).toISOString();
await refreshAdaptivePlan(cleanAdaptiveChargingState(), config, { ...status, read_at: staleAt }, [], {}, now, {
  ...dependencies,
  readHistory: async () => staleSamples,
});
assert.equal(staleSamples.at(-1)?.timestamp, staleAt, "plan refresh must preserve the actual fuel-cell observation time");
assert.equal(buildFuelCellGenerationModel(config, staleSamples, now).recentHotWaterLevel, null,
  "a cached old tank reading must not be made fresh by a new plan refresh");
console.log("adaptive plan refresh tests passed");
