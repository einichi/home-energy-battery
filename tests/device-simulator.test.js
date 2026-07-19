import assert from "node:assert/strict";
import { createDeviceSimulator, DEVICE_SCENARIOS } from "./support/device-simulator.js";

assert.ok(DEVICE_SCENARIOS.normal);
assert.ok(DEVICE_SCENARIOS["high-demand"]);
assert.ok(DEVICE_SCENARIOS["solar-export"]);

const simulator = createDeviceSimulator();
const energy = await simulator.execute("energy-status", {
  "battery-host": "10.250.0.10",
  "solar-host": "10.250.0.10",
  "fuel-cell-primary-host": "10.250.0.30",
  "fuel-cell-proxy-host": ["10.250.0.20"],
});
assert.equal(energy.battery.remaining_percent.value, 62);
assert.equal(energy.battery.operation_mode.value, "auto");
assert.equal(energy.solar.instant_power.value, 850);
assert.equal(energy.fuel_cells[0].source_role, "primary");
assert.equal(energy.fuel_cells[0].cumulative_generation.value, 4321.234);
assert.equal(energy.fuel_cells[0].cumulative_gas.value, 987.654);
assert.equal(energy.fuel_cells[0].hot_water_level.value, 4);
assert.equal(energy.fuel_cells[1].source_role, "proxy");
assert.equal("cumulative_generation" in energy.fuel_cells[1], false);
assert.equal("hot_water_level" in energy.fuel_cells[1], false);

const meter = await simulator.execute("meter-status", { host: "10.250.0.20" });
assert.equal(meter.grid_import_power.value, 920);
assert.equal(meter.grid_export_power.value, 0);
assert.equal(meter.house_demand_power.value, 1410);
assert.deepEqual(meter.channel_power.decoded.channels.map((item) => item.value), [320, 480, 610]);
assert.deepEqual(meter.channel_energy.decoded.channels.map((item) => item.value), [125.4, 234.5, 345.6]);

assert.equal((await simulator.execute("vendor-profile", { host: "10.250.0.10" })).decoded.mode, "eco");
await simulator.execute("vendor-profile", { host: "10.250.0.10" }, ["osaifu"]);
assert.equal((await simulator.execute("vendor-profile", { host: "10.250.0.10" })).decoded.mode, "osaifu");

await simulator.execute("discharge-limit", { host: "10.250.0.10" }, [30]);
assert.equal((await simulator.execute("discharge-limit", { host: "10.250.0.10" })).decoded.percent, 30);
await simulator.execute("osaifu-charge-window", { host: "10.250.0.10" }, [2, 6]);
assert.equal((await simulator.execute("osaifu-charge-window", { host: "10.250.0.10" })).decoded.human, "02:00-06:00");
await simulator.execute("osaifu-discharge-window", { host: "10.250.0.10" }, [7, 22]);
assert.equal((await simulator.execute("osaifu-discharge-window", { host: "10.250.0.10" })).decoded.human, "07:00-22:00");

await simulator.execute("set-mode", { host: "10.250.0.10" }, ["standby"]);
assert.equal((await simulator.execute("energy-status", { "no-solar": true, "no-fuel-cell": true })).battery.operation_mode.value, "standby");
await simulator.execute("charge", { host: "10.250.0.10", "target-wh": 1096 });
assert.equal(simulator.snapshot().battery.instantPowerW, 2192);
assert.equal(simulator.snapshot().battery.targetWh, 1096);
simulator.advance(30 * 60_000);
assert.equal(simulator.snapshot().battery.stateOfChargePercent, 82.2962962962963);
assert.equal(simulator.snapshot().battery.operationMode, "auto");
assert.equal(simulator.snapshot().battery.targetWh, 0);

await simulator.execute("discharge", { host: "10.250.0.10", "target-wh": 540 });
assert.equal(simulator.snapshot().battery.instantPowerW, -2192);
await simulator.execute("set-mode", { host: "10.250.0.10" }, ["auto"]);
assert.equal(simulator.snapshot().battery.operationMode, "auto");

const rawWindow = await simulator.execute("raw-get", { host: "10.250.0.10", eoj: "0x027D01" }, ["0xF4"]);
assert.equal(rawWindow.raw, "0x02000600");
assert.ok((await simulator.execute("dump-vendor", { host: "10.250.0.10" })).properties["0xF6"]);
assert.ok((await simulator.execute("discover"))["10.250.0.30"]);
assert.ok((await simulator.execute("inspect-host", { host: "10.250.0.20", eoj: "0x028701" }))["0x028701"]);

simulator.setHostAvailable("10.250.0.30", false);
const unavailablePrimary = await simulator.execute("energy-status", {
  "fuel-cell-primary-host": "10.250.0.30",
  "fuel-cell-proxy-host": ["10.250.0.20"],
});
assert.equal(unavailablePrimary.fuel_cells[0].cumulative_generation.value, null);
assert.equal(unavailablePrimary.fuel_cells[1].instant_power.value, 650);

simulator.failNext("meter-status", { message: "simulated meter timeout" });
await assert.rejects(() => simulator.execute("meter-status", { host: "10.250.0.20" }), /simulated meter timeout/);
assert.equal((await simulator.execute("meter-status", { host: "10.250.0.20" })).grid_import_power.value, 920);
assert.ok(simulator.calls.some((call) => call.command === "charge" && call.args["target-wh"] === 1096));

const exportSimulator = createDeviceSimulator({ scenario: "solar-export" });
const exportMeter = await exportSimulator.execute("meter-status", { host: "10.250.0.20" });
assert.equal(exportMeter.grid_import_power.value, 0);
assert.equal(exportMeter.grid_export_power.value, 650);

const demandSimulator = createDeviceSimulator({ scenario: "high-demand" });
assert.equal((await demandSimulator.execute("meter-status", { host: "10.250.0.20" })).house_demand_power.value, 4700);

console.log("device simulator tests passed");
