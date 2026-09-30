import assert from "node:assert/strict";
import { normalizeServerEnvironment } from "../lib/config/environment.js";

assert.deepEqual(normalizeServerEnvironment({}, "/tmp/data"), {
  port: 8787,
  dataDir: "/tmp/data",
  echonetTimeoutMs: 15_000,
  scheduleCheckIntervalMs: 15_000,
  automationCheckIntervalMs: 30_000,
});
assert.equal(normalizeServerEnvironment({ PORT: "8799" }, "/tmp/data").port, 8799);
assert.throws(() => normalizeServerEnvironment({ PORT: "not-a-number" }, "/tmp/data"), /PORT/);
assert.throws(() => normalizeServerEnvironment({ PORT: 70_000 }, "/tmp/data"), /PORT/);
assert.throws(() => normalizeServerEnvironment({ DATA_DIR: "" }, "/tmp/data"), /DATA_DIR/);
assert.throws(
  () => normalizeServerEnvironment({ AUTOMATION_CHECK_INTERVAL_MS: "49" }, "/tmp/data"),
  /AUTOMATION_CHECK_INTERVAL_MS/,
);

console.log("environment normalization tests passed");
