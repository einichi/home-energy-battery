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
launcher.stdout.on("data", (chunk) => {
  launcherOutput += chunk;
});
launcher.stderr.on("data", (chunk) => {
  launcherOutput += chunk;
});

let browser;
try {
  await waitFor(`${apiOrigin}/api/config`, launcher);
  const fiveSecondRefresh = await fetch(`${apiOrigin}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updateIntervalSeconds: 5 }),
  });
  assert(fiveSecondRefresh.ok, "Could not configure the simulator for five-second refresh QA");
  const historyEnd = new Date();
  const historyStart = new Date(historyEnd.getTime() - 24 * 60 * 60_000);
  const boundedHistoryResponse = await fetch(`${apiOrigin}/api/history?start=${encodeURIComponent(historyStart.toISOString())}&end=${encodeURIComponent(historyEnd.toISOString())}`);
  const boundedHistoryText = await boundedHistoryResponse.text();
  const boundedHistory = JSON.parse(boundedHistoryText);
  assert(boundedHistoryResponse.ok, "24-hour history response failed");
  assert(boundedHistoryText.length < 1_000_000, `24-hour history response is unexpectedly large (${boundedHistoryText.length} bytes)`);
  assert(Array.isArray(boundedHistory.samples) && boundedHistory.samples.length <= 96, `24-hour history is not bounded (${boundedHistory.samples?.length ?? "invalid"} samples)`);
  const compactSummary = await fetch(`${apiOrigin}/api/history/summary?start=${encodeURIComponent(historyStart.toISOString())}&end=${encodeURIComponent(historyEnd.toISOString())}`).then((response) => response.json());
  assert(!Object.prototype.hasOwnProperty.call(compactSummary, "samples"), "Compact history summary leaked raw sample data");
  const executablePath = await firstExecutable([
    process.env.UI_BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const eneFarmEnd = new Date();
  const eneFarmMiddle = new Date(eneFarmEnd.getTime() - 30 * 60_000);
  const eneFarmStart = new Date(eneFarmEnd.getTime() - 60 * 60_000);
  await page.route("**/api/ene-farm?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        sampleCount: 3,
        start: eneFarmStart.toISOString(),
        end: eneFarmEnd.toISOString(),
        generatedKwh: 0.5,
        gasM3: 0.22,
        electricalYieldKwhPerM3: 2.27,
        operatingSeconds: 1800,
        startCount: 1,
        averageGeneratingW: 500,
        currentState: "generating",
        timeInStateSeconds: 1800,
        lastStopAt: eneFarmMiddle.toISOString(),
        dataQuality: "counter",
        stateIntervals: [
          {
            start: eneFarmStart.toISOString(),
            end: eneFarmMiddle.toISOString(),
            state: "stopped",
            durationSeconds: 1800,
            generatedKwh: 0,
          },
          {
            start: eneFarmMiddle.toISOString(),
            end: eneFarmEnd.toISOString(),
            state: "generating",
            durationSeconds: 1800,
            generatedKwh: 0.5,
          },
        ],
      }),
    }),
  );
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
  assert((await page.getByRole("img", { name: "Last 24 hours of home energy" }).count()) === 0, "Overview still duplicates the detailed Energy history chart");
  assert(await page.getByRole("link", { name: "Full history →" }).isVisible(), "Overview does not link to detailed Energy history");
  assert(await page.getByRole("heading", { name: "Energy outcomes" }).isVisible(), "Overview daily outcomes did not render");
  assert(await page.getByRole("heading", { name: "Circuits consuming most power" }).isVisible(), "Overview top circuit demand is missing");
  assert((await page.locator(".top-circuits-panel li").count()) > 1, "Overview did not list several reporting circuits");
  assert(await page.getByRole("heading", { name: "Today at a glance" }).isVisible(), "Overview daily evidence is not grouped under one time scope");
  assert((await page.getByRole("heading", { name: "Current measurements" }).count()) === 0, "Overview still duplicates Live Power in a Snapshot section");
  assert(await page.getByRole("heading", { name: "Energy Sources" }).isVisible(), "Energy Sources composition is missing");
  assert(await page.getByRole("heading", { name: "Ene-Farm Activity" }).isVisible(), "Ene-Farm activity bar is missing");
  const activitySegment = page.locator(".ene-farm-state-strip i").first();
  await activitySegment.hover();
  assert(await page.getByRole("tooltip").isVisible(), "Ene-Farm activity interval tooltip did not render");
  assert(await page.getByRole("tooltip").getByText(/→/).isVisible(), "Ene-Farm activity tooltip is missing start and finish times");
  assert(
    await page
      .getByRole("tooltip")
      .getByText(/\d+[hms]/)
      .isVisible(),
    "Ene-Farm activity tooltip is missing its duration",
  );
  assert(await page.getByRole("heading", { name: "Estimated Off-Peak Savings" }).isVisible(), "Off-Peak Savings is missing");
  await page.getByRole("button", { name: "Grid use", exact: true }).click();
  assert((await page.getByRole("button", { name: "Grid use", exact: true }).getAttribute("aria-pressed")) === "true", "Off-Peak Savings did not switch to grid use");
  await page.getByRole("button", { name: "Battery charging", exact: true }).click();
  assert(
    (await page.getByRole("button", { name: "Battery charging", exact: true }).getAttribute("aria-pressed")) === "true",
    "Off-Peak Savings did not switch to battery charging",
  );
  const refreshLabels = [];
  for (let sample = 0; sample < 24; sample += 1) {
    refreshLabels.push(
      await page
        .getByRole("button", { name: /Refresh/ })
        .first()
        .textContent(),
    );
    await page.waitForTimeout(250);
  }
  assert(!refreshLabels.includes("Refreshing…"), "Automatic five-second polling visibly toggled the manual Refresh button");

  await page.locator(".sidebar .theme-control select").selectOption("dark");
  assert((await page.locator("html").getAttribute("data-theme")) === "dark", "Dark theme was not applied");
  assert((await page.locator('meta[name="theme-color"]').getAttribute("content")) === "#101716", "Mobile browser chrome did not adopt the dark theme color");

  await page.goto(`${apiOrigin}/ui/energy`, { waitUntil: "domcontentloaded" });
  const metricToggle = page.locator(".series-picker label").filter({ hasText: "Solar" });
  await metricToggle.waitFor();
  assert(await page.getByText("Analysis period", { exact: true }).isVisible(), "Shared Energy analysis-period control is missing");
  assert((await page.locator(".analysis-period-control .segmented-control").count()) === 1, "Analysis period control is not at workspace level");
  assert((await page.locator(".history-workspace .segmented-control").count()) === 0, "Period control is still nested inside Combined history");
  const delayHistory = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  };
  await page.route(/\/api\/history\?/, delayHistory);
  const sevenDayRequest = page.waitForRequest((request) => request.url().includes("/api/history?") && new URL(request.url()).searchParams.has("start"));
  await page.getByRole("button", { name: "7d", exact: true }).click();
  assert(await page.getByText("Loading 7d data…", { exact: true }).isVisible(), "Period change did not expose a loading state");
  assert((await page.locator(".period-results").getAttribute("aria-busy")) === "true", "Selected-period results were not marked busy");
  const sevenDayUrl = new URL((await sevenDayRequest).url());
  assert(new Date(sevenDayUrl.searchParams.get("end")).getTime() - new Date(sevenDayUrl.searchParams.get("start")).getTime() === 7 * 24 * 60 * 60_000, "7-day selection did not request a 7-day history range");
  await page.getByText("Loading 7d data…", { exact: true }).waitFor({ state: "hidden" });
  assert((await page.getByText("Selected period: 7d", { exact: true }).count()) > 2, "Selected-period cards do not identify the active range");
  await page.unroute(/\/api\/history\?/, delayHistory);
  assert(await metricToggle.isVisible(), "Visible metric controls did not render");
  assert((await page.getByLabel("Chart series").count()) === 0, "Combined history repeats the Visible Metrics legend below the chart");
  await metricToggle.hover();
  assert(await metricToggle.evaluate((element) => getComputedStyle(element).transform !== "none"), "Visible metric control has no hover affordance");
  await page.getByRole("checkbox", { name: "Solar" }).click();
  assert(!(await page.getByRole("checkbox", { name: "Solar" }).isChecked()), "Visible metric control did not hide its series");
  await page.getByRole("checkbox", { name: "Solar" }).click();
  assert(await page.getByRole("checkbox", { name: "Solar" }).isChecked(), "Visible metric control did not restore its series");
  assert(await page.getByRole("heading", { name: "Circuit history" }).isVisible(), "Smart Cosmo circuit history is missing");
  assert((await page.getByRole("button", { name: "Edit labels", exact: true }).count()) === 0, "Circuit editing is still exposed in Energy history");
  assert((await page.locator(".circuit-label-input").count()) === 0, "Circuit label fields are still exposed in Energy history");
  assert((await page.locator(".circuit-picker select").count()) === 0, "Legacy circuit dropdown is still present");
  assert(await page.locator(".circuit-history-chart svg").isVisible(), "Circuit history graph did not render");
  assert(await page.locator(".circuit-history-heading h3").isVisible(), "Selected circuit name is not prominent above the graph");
  const circuitTwoRow = page.locator(".selectable-circuit-table tbody tr").filter({ hasText: "Circuit 2" });
  await circuitTwoRow.locator("td").first().click();
  assert((await circuitTwoRow.getAttribute("aria-selected")) === "true", "Clicked circuit row was not marked selected");
  assert(await page.getByRole("heading", { name: "Circuit 2", exact: true }).isVisible(), "Selected circuit heading did not update");
  assert(await page.getByRole("img", { name: "Circuit 2 circuit power history" }).isVisible(), "Circuit selection did not update the history graph");
  await page.locator(".selectable-circuit-table thead button").filter({ hasText: "Power now" }).click();
  assert((await page.locator('.selectable-circuit-table thead th[aria-sort="ascending"]').count()) === 1, "Circuit power column did not sort numerically");
  assert(await page.getByText("Electricity generated", { exact: true }).isVisible(), "Ene-Farm generated electricity statistic is missing");
  assert(await page.getByText("Gas used", { exact: true }).isVisible(), "Ene-Farm gas statistic is missing");
  assert(await page.getByText("Last stop", { exact: true }).isVisible(), "Ene-Farm last-stop statistic is missing");

  await page.goto(`${apiOrigin}/ui/automation`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Automation", exact: true }).waitFor();
  assert(await page.getByRole("heading", { name: "Automation", exact: true }).isVisible(), "Automation control center did not render");
  const automationState = page.getByRole("heading", { name: "Needs setup" });
  await automationState.waitFor();
  assert(await automationState.isVisible(), "Automation master state did not explain the simulator's missing prerequisites");
  assert(await page.getByRole("heading", { name: "Active protections" }).isVisible(), "Automation protections summary is missing");
  assert(await page.getByRole("heading", { name: "Shared automation timeline" }).isVisible(), "Shared automation timeline is missing");
  assert(await page.getByRole("heading", { name: "Away schedule" }).isVisible(), "Away context is missing from Automation");
  assert(!(await page.getByRole("button", { name: "Recalculate plan" }).isEnabled()), "Plan recalculation should be unavailable until setup is complete");
  await page.getByRole("button", { name: "Away now" }).click();
  assert(await page.getByText(/Confirm when you expect to return/).isVisible(), "Away now did not expose its return-time review");
  await page.getByRole("button", { name: "Start Away period" }).click();
  await page.getByText(/Away period saved and plan recalculation queued/).waitFor();
  await page.getByRole("button", { name: "Back home" }).waitFor();
  await page.getByRole("button", { name: "Back home" }).click();
  await page.getByText(/Home state restored/).waitFor();
  await page.getByRole("button", { name: "Performance" }).click();
  assert(await page.getByRole("heading", { name: "Forecast and control performance" }).isVisible(), "Automation Performance view did not render");
  assert(await page.getByRole("heading", { name: "Historical model" }).isVisible(), "Demand forecast evidence is missing");
  assert(await page.getByRole("heading", { name: "Charging-window outcomes" }).isVisible(), "Battery outcome evidence is missing");
  await page.getByRole("button", { name: "Configuration" }).click();
  assert(await page.getByRole("heading", { name: "Setup checklist" }).isVisible(), "Automation Configuration checklist did not render");
  assert(
    await page
      .getByText(/ready$/)
      .first()
      .isVisible(),
    "Automation prerequisite progress is missing",
  );
  assert((await page.getByRole("link", { name: /Open rate settings/ }).getAttribute("href")) === "/ui/system/rates", "Rate prerequisite does not link to System settings");
  assert(
    (await page
      .getByRole("link", { name: /Review planning settings/ })
      .first()
      .getAttribute("href")) === "#adaptive-settings",
    "Planning prerequisite does not link to its Phase 3 form",
  );
  assert(await page.getByRole("heading", { name: "Adaptive Charging configuration" }).isVisible(), "Adaptive Charging settings did not migrate into Automation");
  assert(await page.getByRole("heading", { name: "Demand Guard configuration" }).isVisible(), "Demand Guard settings did not migrate into Automation");

  await page.goto(`${apiOrigin}/ui/insights`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Insights" }).waitFor();
  assert(await page.getByRole("heading", { name: "Insights" }).isVisible(), "Insights did not render");
  await page.getByRole("heading", { name: "Period comparison" }).waitFor();
  assert(await page.getByRole("heading", { name: "Period comparison" }).isVisible(), "Insights period comparison is missing");
  assert(await page.getByRole("heading", { name: "Estimated savings breakdown" }).isVisible(), "Insights savings detail is missing");
  await page.locator(".insight-controls label").filter({ hasText: "Period" }).locator("select").selectOption("custom");
  assert(await page.getByLabel("Start date").isVisible(), "Insights custom report start date is missing");
  assert(await page.getByLabel("End date").isVisible(), "Insights custom report end date is missing");
  await page.getByRole("button", { name: "Ene-Farm" }).click();
  await page.getByRole("heading", { name: "Ene-Farm detail" }).waitFor();
  assert(await page.getByRole("heading", { name: "Ene-Farm detail" }).isVisible(), "Ene-Farm Insights are missing");

  await page.goto(`${apiOrigin}/ui/system/equipment`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Installed equipment" }).waitFor();
  assert(await page.getByRole("heading", { name: "Installed equipment" }).isVisible(), "System equipment route did not render");
  assert((await page.getByLabel("Battery address").inputValue()) === "", "Installed battery address was pre-filled");
  assert(Boolean(await page.getByLabel("Battery address").getAttribute("placeholder")), "Installed battery address has no suggestion");
  assert(await page.getByRole("heading", { name: "Smart Cosmo circuits" }).isVisible(), "Smart Cosmo circuit administration is missing");
  await page
    .getByLabel(/Circuit \d+ label/)
    .first()
    .waitFor();
  assert(
    await page
      .getByLabel(/Circuit \d+ label/)
      .first()
      .isVisible(),
    "Detected Smart Cosmo circuits cannot be named",
  );
  await page.getByRole("button", { name: "Save equipment" }).click();
  const equipmentSaveResult = page.getByText("Equipment settings saved.");
  await equipmentSaveResult.waitFor();
  assert(await equipmentSaveResult.locator("xpath=parent::*").getByRole("button", { name: "Save equipment" }).isVisible(), "Equipment save feedback is not beside its button");
  await page.getByRole("button", { name: "Active subnet scan" }).click();
  await page.locator(".discovery-progress").waitFor();
  assert(await page.locator(".discovery-progress").isVisible(), "Discovery work has no visible progress state");
  await page.getByText("Discovery complete").waitFor();
  await page.getByRole("link", { name: /Rates & emissions/ }).click();
  await page.getByRole("heading", { name: "Electricity rates" }).waitFor();
  assert(await page.getByRole("heading", { name: "Electricity rates" }).isVisible(), "System rates route did not render");
  await page.getByRole("link", { name: /Notifications/ }).click();
  await page.getByRole("heading", { name: "Email notifications" }).waitFor();
  assert(await page.getByRole("heading", { name: "Email notifications" }).isVisible(), "System notifications route did not render");
  assert(
    await page
      .getByLabel(/cooldown/)
      .first()
      .isVisible(),
    "Notification trigger cooldown settings are missing",
  );
  const eventTriggers = page.getByRole("group", { name: "Event triggers" });
  const triggerInputStyles = await eventTriggers.locator('.input-suffix input[type="number"]').evaluateAll((inputs) => inputs.map((input) => {
    const style = getComputedStyle(input);
    return { paddingLeft: style.paddingLeft, backgroundColor: style.backgroundColor };
  }));
  assert(triggerInputStyles.length > 0, "Notification event trigger inputs are missing");
  assert(triggerInputStyles.every(({ paddingLeft }) => Number.parseFloat(paddingLeft) >= 10), "Event trigger inputs do not have enough left padding");
  assert(triggerInputStyles.every(({ backgroundColor }) => backgroundColor === "rgba(0, 0, 0, 0)"), "Event trigger inputs obscure their shared field border");
  assert(!(await page.getByRole("button", { name: "Send test email" }).isEnabled()), "Simulator allowed an external notification test");
  assert(await page.getByRole("heading", { name: "Recent deliveries" }).isVisible(), "Notification delivery history is missing");
  await page.getByRole("link", { name: /Data & backups/ }).click();
  await page.getByRole("heading", { name: "Storage health" }).waitFor();
  assert(await page.getByRole("heading", { name: "Storage health" }).isVisible(), "System data route did not render");
  await page.getByRole("button", { name: "Create backup" }).click();
  await page.getByText("Backup created and inventory refreshed.").waitFor();
  assert((await page.locator(".backup-list article").count()) > 0, "Created database backup did not appear in the refreshed inventory");
  await page.getByRole("link", { name: /Preferences/ }).click();
  await page.getByRole("heading", { name: "Application preferences" }).waitFor();
  assert(await page.getByRole("heading", { name: "Application preferences" }).isVisible(), "System preferences route did not render");
  const preferenceHeights = await page.evaluate(() => {
    const language = document.querySelector('select[name="language"]');
    const interval = document.querySelector('input[name="interval"]')?.parentElement;
    return [language?.getBoundingClientRect().height, interval?.getBoundingClientRect().height];
  });
  assert(preferenceHeights[0] === preferenceHeights[1], `Language and refresh controls have different heights: ${preferenceHeights.join(" vs ")}`);
  assert(await page.locator(".widget-visibility-grid").getByText("Energy sources", { exact: true }).isVisible(), "Overview visibility capitalization is inconsistent");

  await page.goto(`${apiOrigin}/ui/battery`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Battery", exact: true }).waitFor();
  assert(await page.getByRole("heading", { name: "Battery", exact: true }).isVisible(), "Battery workspace did not render");
  const batteryTimeline = page.getByRole("img", {
    name: /battery power and state of charge/,
  });
  await batteryTimeline.waitFor();
  assert(await batteryTimeline.isVisible(), "Battery timeline did not render");
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
  await page.goto(`${apiOrigin}/ui/automation`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Automation", exact: true }).waitFor();
  await assertOperationalBanner(page, "Manual control", "Automation did not preserve the manual override banner");
  await page.goto(`${apiOrigin}/ui/battery`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Schedules", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Battery schedules" }).isVisible(), "Battery schedules subpage is missing");
  assert(await page.getByRole("heading", { name: "Seven-day plan" }).isVisible(), "Battery schedule calendar is missing");
  await page.getByRole("link", { name: "Disaster Prep", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Disaster Prep", exact: true }).first().isVisible(), "Disaster Prep subpage is missing");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  assert(await page.getByText(/20% reserve remains unchanged/).isVisible(), "Disaster Prep did not preview reserve behavior");
  assert(await page.getByText(/Demand Guard will remain available/).isVisible(), "Disaster Prep did not preview Demand Guard ownership");
  assert(await page.getByText(/temporary changes are reversed/).isVisible(), "Disaster Prep did not preview restoration");
  await page.getByRole("button", { name: "Send command" }).click();
  await page.getByText("Command completed and device state was verified.").waitFor();
  await page.getByRole("button", { name: "Close receipt" }).click();
  await page.goto(`${apiOrigin}/ui/energy`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Energy", exact: true }).waitFor();
  await assertOperationalBanner(page, "Disaster Prep", "Disaster Prep was not persistent across the app");

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator(".mobile-navigation").isVisible(), "Mobile navigation is not visible at phone width");
  assert(!(await page.locator(".sidebar").isVisible()), "Desktop sidebar is visible at phone width");
  assert(await page.locator(".mobile-header .theme-control select").isVisible(), "Theme control is not reachable on phone");
  assert((await page.locator(".mobile-navigation a").count()) === 5, "Phone navigation must keep the planned five primary destinations");
  assert(await page.locator(".analysis-period-control").isVisible(), "Shared Energy period control is not visible at phone width");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Energy analysis workspace overflows the phone viewport");
  assert(await page.locator(".mobile-navigation").getByRole("link", { name: "More" }).isVisible(), "The phone More destination is missing");
  await page.locator(".mobile-header .theme-control select").selectOption("light");
  assert((await page.locator("html").getAttribute("data-theme")) === "light", "Phone theme control did not apply light mode");
  assert((await page.locator('meta[name="theme-color"]').getAttribute("content")) === "#f4f6f5", "Mobile browser chrome did not adopt the light theme color");

  await page.goto(`${apiOrigin}/ui/automation`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Automation", exact: true }).waitFor();
  assert(await page.getByRole("heading", { name: "Automation", exact: true }).isVisible(), "Automation did not render at phone width");
  await page.getByRole("button", { name: "Configuration" }).click();
  assert(await page.getByRole("heading", { name: "Adaptive Charging configuration" }).isVisible(), "Automation configuration is not reachable on phone");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Automation configuration overflows the phone viewport");

  await page.locator(".mobile-navigation").getByRole("link", { name: "More" }).click();
  await page.getByRole("heading", { name: "More", level: 1 }).waitFor();
  assert(await page.getByRole("link", { name: /Insights/ }).isVisible(), "Insights is not reachable from the phone More hub");
  assert(await page.getByRole("link", { name: /System/ }).isVisible(), "System is not reachable from the phone More hub");
  await page.getByRole("link", { name: /Insights/ }).click();
  await page.getByRole("heading", { name: "Insights" }).waitFor();
  assert(await page.getByRole("heading", { name: "Insights" }).isVisible(), "Insights did not render from phone navigation");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Insights overflows the phone viewport");

  await page.goto(`${apiOrigin}/ui/energy`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Energy", exact: true }).waitFor();
  assert(await page.getByRole("heading", { name: "Energy", exact: true }).isVisible(), "Production deep link did not render");
  const simulatorBanner = page.getByText("Simulated environment", {
    exact: false,
  });
  await simulatorBanner.waitFor();
  assert(await simulatorBanner.isVisible(), "Production build lost the simulator banner");
  await page.getByRole("img", { name: "24h energy history" }).waitFor();
  assert(await page.getByRole("img", { name: "24h energy history" }).isVisible(), "Combined Energy chart did not render");
  assert(await page.getByRole("heading", { name: "Circuit history" }).isVisible(), "Circuit history did not render");
  assert(await page.getByRole("checkbox", { name: "Battery SOC" }).isVisible(), "Battery SOC history selector is missing");

  await page.goto(`${apiOrigin}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Home energy overview" }).waitFor();
  assert(page.url() === `${apiOrigin}/ui/`, "Root URL did not cut over to the React application");
  assert(await page.getByRole("heading", { name: "Home energy overview" }).isVisible(), "React Overview did not render after root cutover");
  assert(unexpectedRequests.length === 0, `Unexpected network requests: ${unexpectedRequests.join(", ")}`);
  assert(failedResponses.length === 0, `Failed browser requests: ${failedResponses.join(", ")}`);
  assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join("; ")}`);

  console.log("UI browser smoke test passed: simulator boundary, React root cutover, Overview, Energy, Automation controls, Battery command lifecycle, themes, and phone layout");
} finally {
  await browser?.close();
  if (launcher.exitCode === null) {
    launcher.kill("SIGTERM");
    await new Promise((resolve) => launcher.once("exit", resolve));
  }
  if (launcher.exitCode && launcherOutput) process.stderr.write(launcherOutput);
}
