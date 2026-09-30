import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  UI_DEVELOPMENT_DATA_PREFIX,
  assertSafeUiDevelopmentEnvironment,
  externalIoDisabled,
  uiDevelopmentMode,
} from "../lib/development-safety.js";

const projectDir = path.resolve("/workspace/home-energy-battery");
const dataDir = path.join(os.tmpdir(), `${UI_DEVELOPMENT_DATA_PREFIX}test`);
const safeEnvironment: Record<string, any> = {
  NODE_ENV: "test",
  UI_DEVELOPMENT_MODE: "1",
  DISABLE_EXTERNAL_IO: "1",
  DATA_DIR: dataDir,
  DEVICE_COMMAND_ADAPTER_MODULE: path.join(projectDir, "tests/support/device-simulator.js"),
};

test("ordinary server starts are not subject to UI development assertions", () => {
  assert.doesNotThrow(() => assertSafeUiDevelopmentEnvironment({}, { projectDir }));
});

test("the complete simulator-only UI environment is accepted", () => {
  const environment: Record<string, any> = {
    ...safeEnvironment,
    DEVICE_COMMAND_ADAPTER_MODULE: path.join(projectDir, "tests/support/device-simulator.js"),
  };
  assert.doesNotThrow(() => assertSafeUiDevelopmentEnvironment(environment, { projectDir }));
  assert.equal(uiDevelopmentMode(environment), true);
  assert.equal(externalIoDisabled(environment), true);
});

for (const [label, patch] of [
  ["non-test NODE_ENV", { NODE_ENV: "development" }],
  ["external I/O enabled", { DISABLE_EXTERNAL_IO: "0" }],
  ["missing simulator", { DEVICE_COMMAND_ADAPTER_MODULE: "" }],
  ["different adapter", { DEVICE_COMMAND_ADAPTER_MODULE: "./lib/echonet-service.js" }],
  ["production data directory", { DATA_DIR: path.join(projectDir, "data") }],
]) {
  test(`UI development rejects ${label}`, () => {
    assert.throws(
      () => assertSafeUiDevelopmentEnvironment({ ...safeEnvironment, ...(patch as object) }, { projectDir }),
      /Unsafe UI development environment/,
    );
  });
}
