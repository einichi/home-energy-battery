import assert from "node:assert/strict";
import { normalizeServerEnvironment } from "../lib/config/environment.js";

assert.deepEqual(normalizeServerEnvironment({}, "/tmp/data"), {
  host: "0.0.0.0",
  port: 8787,
  httpPort: 8787,
  httpsPort: 443,
  dataDir: "/tmp/data",
  echonetTimeoutMs: 15_000,
  scheduleCheckIntervalMs: 15_000,
  automationCheckIntervalMs: 30_000,
});
assert.equal(normalizeServerEnvironment({ PORT: "8799" }, "/tmp/data").httpPort, 8799);
assert.equal(normalizeServerEnvironment({ PORT: "8799" }, "/tmp/data").port, 8799);
assert.equal(normalizeServerEnvironment({ HTTP_PORT: "8080" }, "/tmp/data").httpPort, 8080);
assert.equal(normalizeServerEnvironment({ HTTPS_PORT: "8443" }, "/tmp/data").httpsPort, 8443);
assert.equal(normalizeServerEnvironment({ HOST: "127.0.0.1" }, "/tmp/data").host, "127.0.0.1");
// HTTP_PORT takes precedence over the legacy PORT alias.
assert.equal(normalizeServerEnvironment({ PORT: "8799", HTTP_PORT: "8080" }, "/tmp/data").httpPort, 8080);
assert.throws(() => normalizeServerEnvironment({ PORT: "not-a-number" }, "/tmp/data"), /HTTP_PORT/);
assert.throws(() => normalizeServerEnvironment({ PORT: 70_000 }, "/tmp/data"), /HTTP_PORT/);
assert.throws(() => normalizeServerEnvironment({ HTTPS_PORT: "0" }, "/tmp/data"), /HTTPS_PORT/);
assert.throws(() => normalizeServerEnvironment({ DATA_DIR: "" }, "/tmp/data"), /DATA_DIR/);
assert.throws(
  () => normalizeServerEnvironment({ AUTOMATION_CHECK_INTERVAL_MS: "49" }, "/tmp/data"),
  /AUTOMATION_CHECK_INTERVAL_MS/,
);

console.log("environment normalization tests passed");
