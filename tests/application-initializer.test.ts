import assert from "node:assert/strict";

import { createApplicationInitializer } from "../lib/services/application-initializer.js";

const lifecycle: string[] = [];
const initializer = createApplicationInitializer({
  initializeHistory: async () => { lifecycle.push("history"); },
  initializeDocuments: async () => { lifecycle.push("documents"); },
  configureDeviceAdapter: async () => { lifecycle.push("adapter"); },
  initializeState: async () => { lifecycle.push("state"); },
  startBackgroundProcesses: () => { lifecycle.push("background"); },
});

await Promise.all([initializer.initialize(), initializer.initialize()]);
assert.deepEqual(lifecycle, ["history", "documents", "adapter", "state", "background"]);
assert.equal(initializer.isInitialized(), true);
await initializer.initialize();
assert.equal(lifecycle.length, 5, "completed initialization must be idempotent");

let adapterConstructed = false;
const incompatibleHistory = createApplicationInitializer({
  initializeHistory: async () => { throw new Error("incompatible history schema"); },
  initializeDocuments: async () => undefined,
  configureDeviceAdapter: async () => { adapterConstructed = true; },
  initializeState: async () => undefined,
  startBackgroundProcesses: () => undefined,
});
await assert.rejects(incompatibleHistory.initialize(), /incompatible history schema/);
assert.equal(adapterConstructed, false, "device adapter must not be constructed after history validation fails");

const incompatibleDocuments = createApplicationInitializer({
  initializeHistory: async () => undefined,
  initializeDocuments: async () => { throw new Error("incompatible application architecture"); },
  configureDeviceAdapter: async () => { adapterConstructed = true; },
  initializeState: async () => undefined,
  startBackgroundProcesses: () => undefined,
});
await assert.rejects(incompatibleDocuments.initialize(), /incompatible application architecture/);
assert.equal(adapterConstructed, false, "device adapter must not be constructed after document validation fails");

console.log("application initializer tests passed");
