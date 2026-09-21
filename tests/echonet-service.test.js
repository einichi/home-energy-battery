import assert from "node:assert/strict";
import {
  createEchonetCommandAdapter,
  executeEchonetCommand,
} from "../lib/echonet-service.js";

let initCalls = 0;
let closeCalls = 0;
let getCalls = 0;
let setCalls = 0;
const fakeClient = {
  async init() { initCalls += 1; },
  async close() { closeCalls += 1; },
  async get(_host, _eoj, epc) {
    getCalls += 1;
    const values = {
      0x80: Buffer.from([0x30]),
      0xd3: Buffer.from([0x00, 0x00, 0x01, 0x2c]),
      0xcf: Buffer.from([0x44]),
      0xda: Buffer.from([0x46]),
      0xe4: Buffer.from([64]),
      0xf0: Buffer.from([0x03]),
    };
    const buffer = values[epc] ?? Buffer.alloc(0);
    return { message: { data: buffer, prop: [{ epc, buffer }] } };
  },
  async set(_host, _eoj, epc, buffer) {
    setCalls += 1;
    return { message: { esv: "Set_Res", prop: [{ epc, buffer }] } };
  },
  async discover() {
    return { "192.0.2.10": { all_instances: ["027d01"], storage_battery_instances: [1] } };
  },
};

const adapter = await createEchonetCommandAdapter({ client: fakeClient });
const charging = await adapter.execute("set-mode", { host: "192.0.2.10", "dry-run": true }, ["charging"]);
const standby = await adapter.execute("set-mode", { host: "192.0.2.10", "dry-run": true }, ["standby"]);

assert.equal(initCalls, 1, "one adapter should initialize its ECHONET client only once");
assert.equal(charging.mode, "charging");
assert.equal(charging.edt, "0x42");
assert.equal(standby.mode, "standby");
assert.equal(standby.edt, "0x44");

const status = await adapter.execute("status", { host: "192.0.2.10" });
assert.equal(status["0xE4"].raw, "0x40");
assert.equal(getCalls, 6);

const acknowledged = await adapter.execute("set-mode", { host: "192.0.2.10" }, ["auto"]);
assert.equal(acknowledged.acknowledged, true);
assert.equal(acknowledged.esv, "Set_Res");
assert.equal(setCalls, 1);

const discovered = await adapter.execute("discover", { timeout: 0.01 });
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

console.log("ECHONET service tests passed");
