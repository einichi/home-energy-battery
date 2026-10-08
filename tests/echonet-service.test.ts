import assert from "node:assert/strict";
import {
  createEchonetCommandAdapter,
  executeEchonetCommand,
} from "../lib/echonet-service.js";
import { decodePercent } from "../lib/adapters/echonet-codecs.js";
import type { EchonetClient } from "../lib/adapters/echonet-transport.js";

let initCalls = 0;
let closeCalls = 0;
let getCalls = 0;
let setCalls = 0;
const getRequests: Array<{ host: string; epc: number }> = [];
const fakeClient: Record<string, any> = {
  async init(): Promise<any> { initCalls += 1; },
  async close(): Promise<any> { closeCalls += 1; },
  async get(host: any, _eoj: any, epc: any): Promise<any> {
    getCalls += 1;
    getRequests.push({ host: String(host), epc: Number(epc) });
    const values: Record<string, any> = {
      0x80: Buffer.from([0x30]),
      0xd3: Buffer.from([0x00, 0x00, 0x01, 0x2c]),
      0xcf: Buffer.from([0x44]),
      0xda: Buffer.from([0x46]),
      0xe4: Buffer.from([64]),
      0xf0: Buffer.from([0x03]),
      0xe0: Buffer.from([0x03, 0x52]),
      0xc4: Buffer.from([0x02, 0x8a]),
      0xc6: Buffer.from([0x00, 0x00, 0x03, 0x98]),
      0xb7: Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x40, 0x00, 0x00, 0x01, 0xe0]),
    };
    const buffer = values[epc] ?? Buffer.alloc(0);
    return { message: { data: buffer, prop: [{ epc, buffer }] } };
  },
  async set(_host: any, _eoj: any, epc: any, buffer: any): Promise<any> {
    setCalls += 1;
    return { message: { esv: "Set_Res", prop: [{ epc, buffer }] } };
  },
  async discover(): Promise<any> {
    return { "192.0.2.10": { all_instances: ["027d01"], storage_battery_instances: [1] } };
  },
};

const adapter = await createEchonetCommandAdapter({ client: fakeClient as unknown as EchonetClient });
const charging = await adapter.execute("set-mode", { host: "192.0.2.10", "dry-run": true }, ["charging"]) as Record<string, any>;
const standby = await adapter.execute("set-mode", { host: "192.0.2.10", "dry-run": true }, ["standby"]) as Record<string, any>;

assert.equal(initCalls, 1, "one adapter should initialize its ECHONET client only once");
assert.equal(charging.mode, "charging");
assert.equal(charging.edt, "0x42");
assert.equal(standby.mode, "standby");
assert.equal(standby.edt, "0x44");

const status = await adapter.execute("status", { host: "192.0.2.10" }) as Record<string, any>;
assert.equal(status["0xE4"].raw, "0x40");
assert.equal(getCalls, 6);

getRequests.length = 0;
const livePower = await adapter.execute("live-power", {
  "battery-host": "192.0.2.10",
  "solar-host": "192.0.2.10",
  "fuel-cell-primary-host": "192.0.2.30",
  "meter-host": "192.0.2.20",
  "meter-eoj": "0x028701",
}) as Record<string, any>;
assert.deepEqual(getRequests, [
  { host: "192.0.2.10", epc: 0xe0 },
  { host: "192.0.2.10", epc: 0xd3 },
  { host: "192.0.2.30", epc: 0xc4 },
  { host: "192.0.2.20", epc: 0xc6 },
  { host: "192.0.2.20", epc: 0xb7 },
]);
assert.equal(livePower.energy.solar.instant_power.value, 850);
assert.equal(livePower.energy.battery.instant_power.value, 300);
assert.equal(livePower.energy.fuel_cells[0].instant_power.value, 650);
assert.equal(livePower.meter.grid_import_power.value, 920);
assert.equal(livePower.meter.branch_demand_power.value, 800);
assert.equal(typeof livePower.energy.battery.instant_power.acquired_at, "string");
assert.equal(typeof livePower.completed_at, "string");

const acknowledged = await adapter.execute("set-mode", { host: "192.0.2.10" }, ["auto"]) as Record<string, any>;
assert.equal(acknowledged.acknowledged, true);
assert.equal(acknowledged.esv, "Set_Res");
assert.equal(setCalls, 1);

const discovered = await adapter.execute("discover", { timeout: 0.01 }) as Record<string, any>;
assert.deepEqual(discovered["192.0.2.10"].storage_battery_instances, [1]);
assert.equal(initCalls, 1, "reads, writes, and discovery should reuse the initialized client");

const rawWrite = await executeEchonetCommand(
  "raw-set",
  { host: "192.0.2.10", eoj: "0x027D01", "dry-run": true },
  ["0xF6", "0x02"],
);
assert.deepEqual(rawWrite, {
  host: "192.0.2.10",
  eoj: "0x027D01",
  epc: "0xf6",
  edt: "0x02",
});

await adapter.close();
await adapter.close();
assert.equal(closeCalls, 1, "closing an adapter should close the persistent client once");
await assert.rejects(
  adapter.execute("set-mode", { host: "192.0.2.10", "dry-run": true }, ["auto"]),
  /ECHONET client is closed/,
);

const inRange = decodePercent({ host: "h", eoj: "0x027D01", epc: 0xe4, name: "battery_remaining_percent", raw: Buffer.from([64]), unit: "%" });
assert.deepEqual(inRange, { host: "h", eoj: "0x027D01", epc: "0xE4", name: "battery_remaining_percent", raw: "0x40", value: 64, unit: "%", human: "64 %" });
const outOfRange = decodePercent({ host: "h", eoj: "0x027D01", epc: 0xe4, name: "battery_remaining_percent", raw: Buffer.from([150]), unit: "%" });
assert.equal(outOfRange.value, undefined);
assert.match(String(outOfRange.error), /out-of-range 150/);

console.log("ECHONET service tests passed");
