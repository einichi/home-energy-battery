import assert from "node:assert/strict";
import { createDeviceCommandService } from "../lib/services/device-command-service.js";

type Runner = (command: string, args?: Record<string, unknown>, positional?: unknown[]) => Promise<unknown>;

function makeService(runner: Runner) {
  return createDeviceCommandService({
    assertActionAllowed: async () => {},
    pauseAdaptiveCharging: async () => null,
    readConfig: async () => ({ batteryHost: "10.0.0.152" }) as any,
    runDeviceCommand: runner as any,
    invalidateStatus: () => {},
    history: { isReady: () => false, recordEvent: () => null },
    createHttpError: (status: number, message: string) => Object.assign(new Error(message), { status }),
    operationModeVerifyAttempts: 2,
    operationModeVerifyDelayMs: 0,
  });
}

const isEpc = (value: unknown, expected: string) => String(value ?? "").toLowerCase() === expected;

// charge: mode 0xDA and target 0xAA are both read back and matched.
const chargeReads: string[] = [];
const chargeService = makeService(async (command, _args, positional) => {
  if (command === "charge") return { ok: true, acknowledged: true, esv: "Set_Res" };
  if (command === "raw-get") {
    const epc = String(positional?.[0] ?? "");
    chargeReads.push(epc.toLowerCase());
    if (isEpc(epc, "0xda")) return { raw: "0x42" }; // charging
    if (isEpc(epc, "0xaa")) return { raw: "0x000001f4" }; // 500 Wh
  }
  throw new Error(`unexpected ${command} ${JSON.stringify(positional)}`);
});
const chargeVerified = await chargeService.execute("charge", { targetWh: 500 });
assert.equal((chargeVerified as any).readBack.operationMode, "charging");
assert.equal((chargeVerified as any).readBack.targetWh, 500);
assert.ok(chargeReads.includes("0xaa"), "charge must read back the target EPC 0xAA");

// discharge: mode 0xDA and target 0xAB are both read back and matched.
const dischargeReads: string[] = [];
const dischargeService = makeService(async (command, _args, positional) => {
  if (command === "discharge") return { ok: true, acknowledged: true, esv: "Set_Res" };
  if (command === "raw-get") {
    const epc = String(positional?.[0] ?? "");
    dischargeReads.push(epc.toLowerCase());
    if (isEpc(epc, "0xda")) return { raw: "0x43" }; // discharging
    if (isEpc(epc, "0xab")) return { raw: "0x00000190" }; // 400 Wh
  }
  throw new Error(`unexpected ${command} ${JSON.stringify(positional)}`);
});
const dischargeVerified = await dischargeService.execute("discharge", { targetWh: 400 });
assert.equal((dischargeVerified as any).readBack.targetWh, 400);
assert.ok(dischargeReads.includes("0xab"), "discharge must read back the target EPC 0xAB");

// A silently ignored target must fail verification instead of reporting success.
const ignoredTargetService = makeService(async (command, _args, positional) => {
  if (command === "charge") return { ok: true, acknowledged: true, esv: "Set_Res" };
  if (command === "raw-get") {
    const epc = String(positional?.[0] ?? "");
    if (isEpc(epc, "0xda")) return { raw: "0x42" };
    if (isEpc(epc, "0xaa")) return { raw: "0x00000000" };
  }
  throw new Error(`unexpected ${command} ${JSON.stringify(positional)}`);
});
await assert.rejects(
  ignoredTargetService.execute("charge", { targetWh: 500 }),
  /target verification mismatch: expected 500, observed 0/,
);

// A charge without a target still verifies the mode only (no target read).
const modeOnlyReads: string[] = [];
const modeOnlyService = makeService(async (command, _args, positional) => {
  if (command === "charge") return { ok: true, acknowledged: true, esv: "Set_Res" };
  if (command === "raw-get") {
    const epc = String(positional?.[0] ?? "");
    modeOnlyReads.push(epc.toLowerCase());
    if (isEpc(epc, "0xda")) return { raw: "0x42" };
  }
  throw new Error(`unexpected ${command} ${JSON.stringify(positional)}`);
});
const modeOnlyVerified = await modeOnlyService.execute("charge", {});
assert.equal((modeOnlyVerified as any).readBack.operationMode, "charging");
assert.ok(!modeOnlyReads.includes("0xaa"), "no target read when no target was requested");

console.log("device command verification tests passed");
