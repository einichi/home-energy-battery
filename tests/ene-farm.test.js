import assert from "node:assert/strict";
import {
  decodeEnum,
  decodeFuelCellCumulative,
  decodeFuelCellHotWaterLevel,
  EDT_TO_FUEL_CELL_INTERCONNECTION,
  EDT_TO_FUEL_CELL_STATUS,
  EPC,
} from "../home-energy-battery-node.js";

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

console.log("Ene-Farm protocol tests passed");
