#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = 8804;
const uiPort = 5185;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;

async function executable() {
  for (const candidate of [process.env.UI_BROWSER_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  throw new Error("No Chromium browser found for lifecycle checks");
}

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Safe simulator launcher exited with ${child.exitCode}`);
    try { if ((await fetch(`${apiOrigin}/api/config`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the safe simulator");
}

const launcher = spawn(process.execPath, [path.join(projectDir, "scripts/dev-ui-safe.mjs")], {
  cwd: projectDir,
  env: { ...process.env, UI_DEV_API_PORT: String(apiPort), UI_DEV_PORT: String(uiPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
launcher.stdout.on("data", (chunk) => { output += chunk; });
launcher.stderr.on("data", (chunk) => { output += chunk; });

let browser;
try {
  await waitForServer(launcher);
  await fetch(`${apiOrigin}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ updateIntervalSeconds: 5 }) });
  browser = await chromium.launch({ executablePath: await executable(), headless: true, args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let statusRequests = 0;
  const errors = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/status") statusRequests += 1; });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${uiOrigin}/ui/`, { waitUntil: "networkidle" });
  const heap = async () => {
    await page.evaluate(() => globalThis.gc?.());
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    const metrics = await session.send("Performance.getMetrics");
    await session.detach();
    return metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
  };
  const startHeap = await heap();
  const destinations = [
    ["/ui/energy", "Energy"],
    ["/ui/energy/ene-farm", "Ene-Farm"],
    ["/ui/battery", "Battery"],
    ["/ui/automation", "Automation"],
    ["/ui/insights", "Insights"],
    ["/ui/system/equipment", "System"],
    ["/ui/more", "More"],
    ["/ui/", "Home energy overview"],
  ];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (const [route, heading] of destinations) {
      await page.evaluate((nextRoute) => {
        history.pushState({}, "", nextRoute);
        dispatchEvent(new PopStateEvent("popstate"));
      }, route);
      await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
    }
  }
  await page.waitForTimeout(6_000);
  const endHeap = await heap();
  const growthMb = (endHeap - startHeap) / 1024 / 1024;
  if (errors.length) throw new Error(`Browser errors during lifecycle test: ${errors.join("; ")}`);
  if (growthMb > 35) throw new Error(`Heap grew by ${growthMb.toFixed(1)} MiB across repeated navigation`);
  if (statusRequests > 8) throw new Error(`Observed ${statusRequests} status requests; polling may be leaking across client-side route lifecycles`);
  console.log(`Lifecycle checks passed (heap growth ${growthMb.toFixed(1)} MiB, ${statusRequests} status requests)`);
} finally {
  await browser?.close();
  if (launcher.exitCode === null) {
    launcher.kill("SIGTERM");
    await new Promise((resolve) => launcher.once("exit", resolve));
  }
  if (launcher.exitCode && output) process.stderr.write(output);
}
