import assert from "node:assert/strict";
import {
  decodeEnum,
  decodeFuelCellCumulative,
  decodeFuelCellHotWaterLevel,
  EDT_TO_FUEL_CELL_INTERCONNECTION,
  EDT_TO_FUEL_CELL_STATUS,
  EPC,
} from "../home-energy-battery-node.js";
import {
  decideFuelCellAutomation,
  dueFuelCellSchedule,
  fuelCellScheduledStartBlockReason,
  nextFuelCellSchedule,
  normalizeFuelCellAutomation,
} from "../lib/fuel-cell-automation.js";

const generation = decodeFuelCellCumulative({
  host: "192.0.2.30",
  epc: EPC.FUEL_CELL_CUMULATIVE_GENERATION,
  name: "fuel_cell_cumulative_generation",
  raw: Buffer.from([0, 0, 0x04, 0xd2]),
  unit: "kWh",
});
assert.equal(generation.value, 1.234);
assert.equal(generation.unit, "kWh");

const gas = decodeFuelCellCumulative({
  host: "192.0.2.30",
  epc: EPC.FUEL_CELL_CUMULATIVE_GAS,
  name: "fuel_cell_cumulative_gas",
  raw: Buffer.from([0, 0, 0, 250]),
  unit: "m3",
});
assert.equal(gas.value, 0.25);

const hotWater = decodeFuelCellHotWaterLevel({
  host: "192.0.2.30",
  raw: Buffer.from([4]),
});
assert.equal(hotWater.value, 4);
assert.equal(hotWater.human, "4 / 5");
assert.equal(decodeFuelCellHotWaterLevel({ host: "192.0.2.30", raw: Buffer.from([6]) }).value, undefined);

for (const [edt, expected] of [[0x41, "generating"], [0x42, "stopped"], [0x43, "starting"], [0x44, "stopping"], [0x45, "idling"]]) {
  const decoded = decodeEnum({ host: "192.0.2.30", eoj: "0x027C01", epc: EPC.FUEL_CELL_GENERATION_STATUS, name: "status", raw: Buffer.from([edt]), mapping: EDT_TO_FUEL_CELL_STATUS });
  assert.equal(decoded.human, expected);
}

for (const [edt, expected] of [[0x00, "grid_connected_reverse_flow_allowed"], [0x01, "independent"], [0x02, "grid_connected_reverse_flow_prohibited"]]) {
  const decoded = decodeEnum({ host: "192.0.2.30", eoj: "0x027C01", epc: EPC.FUEL_CELL_INTERCONNECTION_STATUS, name: "interconnection", raw: Buffer.from([edt]), mapping: EDT_TO_FUEL_CELL_INTERCONNECTION });
  assert.equal(decoded.human, expected);
}

const automation = normalizeFuelCellAutomation({
  enabled: true,
  spoolUpMinutes: 20,
  stopDuringDiscountedRates: true,
  preventStartAtOrAboveHotWaterLevel: 4,
  includeInAdaptiveCharging: true,
  schedules: [{ label: "Morning", days: [1], start: "08:00" }],
});
assert.equal(normalizeFuelCellAutomation().spoolUpMinutes, 40);
const mondayBeforeStart = new Date(2026, 6, 20, 7, 45);
const dueSchedule = dueFuelCellSchedule(automation, mondayBeforeStart, {
  lastEvaluatedAt: new Date(2026, 6, 20, 7, 39),
});
assert.equal(dueSchedule?.label, "Morning");
assert.equal(dueFuelCellSchedule(automation, mondayBeforeStart, {
  lastEvaluatedAt: new Date(2026, 6, 20, 7, 39),
  lastHandledKey: dueSchedule.key,
}), null);
assert.equal(nextFuelCellSchedule(automation, new Date(2026, 6, 20, 6, 0))?.label, "Morning");

const offDecision = decideFuelCellAutomation({
  automation,
  now: new Date(2026, 6, 20, 6, 0),
  generationState: "stopped",
  offModeConfirmed: false,
});
assert.equal(offDecision.action, "stop");
assert.match(offDecision.reason, /お出かけ停止/);

const hotWaterBlocked = fuelCellScheduledStartBlockReason({
  automation,
  hotWaterLevel: 4,
});
assert.match(hotWaterBlocked, /4\/5/);

const scheduledStart = decideFuelCellAutomation({
  automation,
  now: mondayBeforeStart,
  generationState: "stopped",
  offModeConfirmed: true,
  scheduledRunActive: true,
  scheduledOccurrence: dueSchedule,
});
assert.equal(scheduledStart.action, "start");

const discountedStop = decideFuelCellAutomation({
  automation,
  now: new Date(2026, 6, 20, 8, 30),
  generationState: "generating",
  discountedRateActive: true,
  offModeConfirmed: false,
  scheduledRunActive: true,
  scheduledOccurrence: dueSchedule,
});
assert.equal(discountedStop.action, "stop");

const manualRun = decideFuelCellAutomation({
  automation: { enabled: true, schedules: [] },
  now: new Date(2026, 6, 20, 12, 0),
  generationState: "generating",
  manualRunActive: true,
});
assert.equal(manualRun.action, null);
assert.equal(manualRun.status, "running");
assert.match(manualRun.reason, /Manual one-off/);

const discountedManualStop = decideFuelCellAutomation({
  automation: { enabled: true, stopDuringDiscountedRates: true, schedules: [] },
  now: new Date(2026, 6, 20, 12, 0),
  generationState: "generating",
  discountedRateActive: true,
  manualRunActive: true,
});
assert.equal(discountedManualStop.action, "stop");
assert.match(discountedManualStop.reason, /discounted electricity rate/);

const migratedLegacy = normalizeFuelCellAutomation({}, {
  plannerInfluence: "active",
  fixedWindows: [{ days: [1], start: "08:00", end: "10:00" }],
});
assert.equal(migratedLegacy.enabled, false);
assert.equal(migratedLegacy.includeInAdaptiveCharging, true);
assert.equal(migratedLegacy.schedules.length, 1);
assert.equal("end" in migratedLegacy.schedules[0], false);

console.log("Ene-Farm protocol tests passed");
