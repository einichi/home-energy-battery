import assert from "node:assert/strict";
import http from "node:http";
import { startRuntime, stopRuntime } from "../lib/runtime.js";

const lifecycle: string[] = [];
const server = http.createServer((_request, response) => response.end("ok"));
await startRuntime({
  server,
  host: "127.0.0.1",
  port: 0,
  validateEnvironment: () => lifecycle.push("environment"),
  validateStorage: async () => { lifecycle.push("storage"); },
  initializeApplication: async () => { lifecycle.push("application"); },
  logger: { log: (message) => lifecycle.push(message) },
});
assert.deepEqual(lifecycle.slice(0, 3), ["environment", "storage", "application"]);
assert.equal(server.listening, true);

await stopRuntime({
  server,
  stopBackgroundProcesses: () => lifecycle.push("timers"),
  closeResources: async () => { lifecycle.push("resources"); },
});
assert.equal(server.listening, false);
assert.deepEqual(lifecycle.slice(-2), ["timers", "resources"]);

let initialized = false;
const rejectedServer = http.createServer();
await assert.rejects(
  startRuntime({
    server: rejectedServer,
    host: "127.0.0.1",
    port: 0,
    validateEnvironment: () => undefined,
    validateStorage: async () => { throw new Error("incompatible storage"); },
    initializeApplication: async () => { initialized = true; },
  }),
  /incompatible storage/,
);
assert.equal(initialized, false);
assert.equal(rejectedServer.listening, false);

console.log("runtime tests passed");
