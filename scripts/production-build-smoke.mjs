import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`compiled server exited ${child.exitCode}\n${output.value}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`compiled server did not become ready\n${output.value}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "home-energy-battery-ui-dev-build-smoke-"));
const port = await availablePort();
const output = { value: "" };
const child = spawn(process.execPath, [path.resolve("dist/server.js")], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DATA_DIR: dataDir,
    UI_DEVELOPMENT_MODE: "1",
    DISABLE_EXTERNAL_IO: "1",
    DEVICE_COMMAND_ADAPTER_MODULE: path.resolve("dist/tests/support/device-simulator.js"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output.value += chunk; });
child.stderr.on("data", (chunk) => { output.value += chunk; });

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  const ui = await waitFor(`${baseUrl}/ui/`, child, output);
  assert.match(await ui.text(), /<div id="root"><\/div>/);
  const status = await fetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);
  assert.match(status.headers.get("content-type") ?? "", /application\/json/);
  console.log("production build smoke test passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(dataDir, { recursive: true, force: true });
}
