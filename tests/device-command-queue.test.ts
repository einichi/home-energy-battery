import assert from "node:assert/strict";
import { DeviceCommandQueue, deviceCommandPriority } from "../lib/services/device-command-queue.js";

assert.equal(deviceCommandPriority("set-mode"), 0);
assert.equal(deviceCommandPriority("live-power"), 5);
assert.equal(deviceCommandPriority("energy-status"), 10);
assert.equal(deviceCommandPriority("raw-get"), 20);

let releaseBlockedCommand: ((value: unknown) => void) | undefined;
const queue = new DeviceCommandQueue({
  queueTimeoutMs: 1_000,
  starvationMs: 1_000,
  executor: async (command) => {
    if (command === "inspect-host") {
      return new Promise((resolve) => { releaseBlockedCommand = resolve; });
    }
    return { ok: true };
  },
});

const blocked = queue.run("inspect-host", { host: "192.0.2.10" }, [], { queueTimeoutMs: 1_000 });
await assert.rejects(
  queue.run("probe", { host: "192.0.2.11" }, [], { queueTimeoutMs: 5 }),
  /timed out after waiting 5ms in the device command queue/,
);
assert.equal(queue.activeContext?.command, "inspect-host");
releaseBlockedCommand?.({ ok: true });
await blocked;
assert.equal(queue.recentTimings.at(-1)?.host, "192.0.2.10");

console.log("device command queue tests passed");
