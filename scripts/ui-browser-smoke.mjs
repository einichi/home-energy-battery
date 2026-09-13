#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = 8799;
const uiPort = 5180;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known locally installed browser.
    }
  }
  throw new Error("No Chromium browser found. Set UI_BROWSER_EXECUTABLE to a Chrome or Chromium executable.");
}

async function waitFor(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Safe development launcher exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertOperationalBanner(page, title, message) {
  const bannerTitle = page.locator(".operational-banner").getByText(title, { exact: true });
  try {
    await bannerTitle.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    const strategy = await page.evaluate(async () => (await fetch("/api/status")).json().then((status) => status.batteryStrategy));
    throw new Error(`${message}; observed strategy: ${JSON.stringify(strategy)}`);
  }
}

const launcher = spawn(process.execPath, [path.join(projectDir, "scripts/dev-ui-safe.mjs")], {
  cwd: projectDir,
  env: {
    ...process.env,
    UI_DEV_API_PORT: String(apiPort),
    UI_DEV_PORT: String(uiPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let launcherOutput = "";
launcher.stdout.on("data", (chunk) => { launcherOutput += chunk; });
launcher.stderr.on("data", (chunk) => { launcherOutput += chunk; });

let browser;
try {
  await waitFor(`${apiOrigin}/api/config`, launcher);
  const fiveSecondRefresh = await fetch(`${apiOrigin}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updateIntervalSeconds: 5 }),
  });
  assert(fiveSecondRefresh.ok, "Could not configure the simulator for five-second refresh QA");
  const executablePath = await firstExecutable([
    process.env.UI_BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const unexpectedRequests = [];
  const browserErrors = [];
  const failedResponses = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (![uiOrigin, apiOrigin].includes(url.origin) && !["data:", "blob:"].includes(url.protocol)) {
      unexpectedRequests.push(request.url());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== "/favicon.ico") {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`${uiOrigin}/ui/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Simulated environment", { exact: false }).waitFor();
  await page.getByText("62%", { exact: true }).first().waitFor();
  assert(await page.getByText("62%", { exact: true }).first().isVisible(), "Expected simulator battery SOC");
  assert(await page.getByText("850 W", { exact: true }).first().isVisible(), "Expected simulator solar power");
  const overviewChart = page.getByRole("img", { name: "Last 24 hours of home energy" });
  assert(await overviewChart.isVisible(), "Overview history chart did not render");
  assert(await page.getByLabel("Chart series").getByText("Demand", { exact: true }).isVisible(), "Chart series legend did not render");
  await overviewChart.hover({ position: { x: 420, y: 150 } });
  assert(await page.locator(".chart-tooltip").isVisible(), "Chart hover details did not render");
  assert(await page.getByRole("heading", { name: "Energy outcomes" }).isVisible(), "Overview daily outcomes did not render");
  assert(await page.getByRole("heading", { name: "Current measurements" }).count() === 0, "Overview still duplicates Live Power in a Snapshot section");
  const refreshLabels = [];
  for (let sample = 0; sample < 24; sample += 1) {
    refreshLabels.push(await page.getByRole("button", { name: /Refresh/ }).first().textContent());
    await page.waitForTimeout(250);
  }
  assert(!refreshLabels.includes("Refreshing…"), "Automatic five-second polling visibly toggled the manual Refresh button");

  await page.locator(".sidebar .theme-control select").selectOption("dark");
  assert(await page.locator("html").getAttribute("data-theme") === "dark", "Dark theme was not applied");

  await page.goto(`${apiOrigin}/ui/battery`, { waitUntil: "domcontentloaded" });
  assert(await page.getByRole("heading", { name: "Battery", exact: true }).isVisible(), "Battery workspace did not render");
  assert(await page.getByRole("img", { name: /battery power and state of charge/ }).isVisible(), "Battery timeline did not render");
  assert(await page.getByText("Direct operation", { exact: true }).isVisible(), "Manual controls are not persistently visible");
  await page.getByRole("button", { name: "Charge", exact: true }).click();
  assert(await page.getByRole("dialog", { name: "Start manual charging" }).isVisible(), "Physical command review did not open");
  await page.getByRole("button", { name: "Send command" }).click();
  await page.getByText("Command completed and device state was verified.").waitFor();
  await page.getByText("Manual charge", { exact: true }).waitFor();
  assert(await page.getByText("Manual charge", { exact: true }).isVisible(), "Durable command receipt did not render");
  await page.getByRole("button", { name: "Close receipt" }).click();
  await assertOperationalBanner(page, "Manual control", "Manual override was not made globally visible");
  await page.goto(`${apiOrigin}/ui/`, { waitUntil: "domcontentloaded" });
  await assertOperationalBanner(page, "Manual control", "Overview did not preserve the manual override banner");
  await page.goto(`${apiOrigin}/ui/automation`, { waitUntil: "domcontentloaded" });
  await assertOperationalBanner(page, "Manual control", "Automation did not preserve the manual override banner");
  await page.goto(`${apiOrigin}/ui/battery`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Schedules", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Battery schedules" }).isVisible(), "Battery schedules subpage is missing");
  assert(await page.getByRole("heading", { name: "Seven-day plan" }).isVisible(), "Battery schedule calendar is missing");
  await page.getByRole("link", { name: "Disaster Prep / 停電対策", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Disaster Prep / 停電対策", exact: true }).first().isVisible(), "Disaster Prep subpage is missing");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  assert(await page.getByText(/20% reserve remains unchanged/).isVisible(), "Disaster Prep did not preview reserve behavior");
  assert(await page.getByText(/Demand Guard will remain available/).isVisible(), "Disaster Prep did not preview Demand Guard ownership");
  assert(await page.getByText(/temporary changes are reversed/).isVisible(), "Disaster Prep did not preview restoration");
  await page.getByRole("button", { name: "Send command" }).click();
  await page.getByText("Command completed and device state was verified.").waitFor();
  await page.getByRole("button", { name: "Close receipt" }).click();
  await page.goto(`${apiOrigin}/ui/energy`, { waitUntil: "domcontentloaded" });
  await assertOperationalBanner(page, "Disaster Prep / 停電対策", "Disaster Prep was not persistent across the app");

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator(".mobile-navigation").isVisible(), "Mobile navigation is not visible at phone width");
  assert(!await page.locator(".sidebar").isVisible(), "Desktop sidebar is visible at phone width");
  assert(await page.locator(".mobile-header .theme-control select").isVisible(), "Theme control is not reachable on phone");
  await page.locator(".mobile-header .theme-control select").selectOption("light");
  assert(await page.locator("html").getAttribute("data-theme") === "light", "Phone theme control did not apply light mode");

  await page.goto(`${apiOrigin}/ui/energy`, { waitUntil: "domcontentloaded" });
  assert(await page.getByRole("heading", { name: "Energy", exact: true }).isVisible(), "Production deep link did not render");
  assert(await page.getByText("Simulated environment", { exact: false }).isVisible(), "Production build lost the simulator banner");
  assert(await page.getByRole("img", { name: "24h energy history" }).isVisible(), "Combined Energy chart did not render");
  assert(await page.getByRole("heading", { name: "Circuits" }).isVisible(), "Circuit history did not render");
  assert(await page.getByRole("checkbox", { name: "Battery SOC" }).isVisible(), "Battery SOC history selector is missing");

  await page.goto(`${apiOrigin}/ui/graphs/solarPower`, { waitUntil: "domcontentloaded" });
  assert(await page.getByRole("checkbox", { name: "Solar" }).isChecked(), "Legacy solar graph did not redirect to its Energy metric");
  assert(!await page.getByRole("checkbox", { name: "Demand" }).isChecked(), "Legacy graph redirect did not focus the requested metric");
  assert(unexpectedRequests.length === 0, `Unexpected network requests: ${unexpectedRequests.join(", ")}`);
  assert(failedResponses.length === 0, `Failed browser requests: ${failedResponses.join(", ")}`);
  assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join("; ")}`);

  console.log("UI browser smoke test passed: simulator boundary, Overview, Energy, Battery command lifecycle, themes, phone layout, and legacy redirects");
} finally {
  await browser?.close();
  if (launcher.exitCode === null) {
    launcher.kill("SIGTERM");
    await new Promise((resolve) => launcher.once("exit", resolve));
  }
  if (launcher.exitCode && launcherOutput) process.stderr.write(launcherOutput);
}
