import os from "node:os";
import path from "node:path";

const UI_DEVELOPMENT_DATA_PREFIX = "home-energy-battery-ui-dev-";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

export function externalIoDisabled(environment = process.env) {
  return enabled(environment.DISABLE_EXTERNAL_IO);
}

export function uiDevelopmentMode(environment = process.env) {
  return enabled(environment.UI_DEVELOPMENT_MODE);
}

export function assertSafeUiDevelopmentEnvironment(
  environment = process.env,
  {
    projectDir = process.cwd(),
    temporaryRoot = os.tmpdir(),
  } = {},
) {
  if (!uiDevelopmentMode(environment)) return;

  const failures = [];
  if (environment.NODE_ENV !== "test") failures.push("NODE_ENV must be test");
  if (!externalIoDisabled(environment)) failures.push("DISABLE_EXTERNAL_IO must be enabled");

  const expectedAdapter = path.resolve(projectDir, "tests/support/device-simulator.js");
  const configuredAdapter = environment.DEVICE_COMMAND_ADAPTER_MODULE
    ? path.resolve(projectDir, environment.DEVICE_COMMAND_ADAPTER_MODULE)
    : null;
  if (configuredAdapter !== expectedAdapter) {
    failures.push("DEVICE_COMMAND_ADAPTER_MODULE must be tests/support/device-simulator.js");
  }

  const configuredDataDir = environment.DATA_DIR ? path.resolve(environment.DATA_DIR) : null;
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const relativeDataDir = configuredDataDir
    ? path.relative(resolvedTemporaryRoot, configuredDataDir)
    : "..";
  const insideTemporaryRoot = configuredDataDir
    && relativeDataDir !== ""
    && !relativeDataDir.startsWith(`..${path.sep}`)
    && relativeDataDir !== ".."
    && !path.isAbsolute(relativeDataDir);
  if (!insideTemporaryRoot || !path.basename(configuredDataDir ?? "").startsWith(UI_DEVELOPMENT_DATA_PREFIX)) {
    failures.push(`DATA_DIR must be an isolated ${UI_DEVELOPMENT_DATA_PREFIX}* directory under ${resolvedTemporaryRoot}`);
  }

  if (failures.length) {
    throw new Error(`Unsafe UI development environment: ${failures.join("; ")}`);
  }
}

export { UI_DEVELOPMENT_DATA_PREFIX };
