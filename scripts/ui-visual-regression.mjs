#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = 8801;
const uiPort = 5182;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const fixtures = JSON.parse(await readFile(path.join(projectDir, "tests/visual/ui-fixtures.json"), "utf8"));
const outputDir = path.join(projectDir, "test-results/ui-visual");

async function executable() {
  for (const candidate of [process.env.UI_BROWSER_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  throw new Error("No Chromium browser found for simulator visual fixtures");
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

function assert(condition, message) { if (!condition) throw new Error(message); }

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
  await mkdir(outputDir, { recursive: true });
  browser = await chromium.launch({ executablePath: await executable(), headless: true });
  const results = [];
  for (const fixture of fixtures) {
    const response = await fetch(`${apiOrigin}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: fixture.language }),
    });
    assert(response.ok, `${fixture.name}: could not set simulator locale`);
    const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height }, colorScheme: fixture.theme });
    await page.addInitScript((theme) => localStorage.setItem("home-energy-theme", theme), fixture.theme);
    await page.goto(`${uiOrigin}${fixture.path}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: fixture.heading, level: 1 }).waitFor();
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important} time,.freshness{visibility:hidden!important}" });
    const state = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      language: document.documentElement.lang,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      main: Boolean(document.querySelector("main")),
      nav: Boolean(document.querySelector("nav")),
      canvas: getComputedStyle(document.body).backgroundColor,
    }));
    assert(state.theme === fixture.theme, `${fixture.name}: expected ${fixture.theme} theme, got ${state.theme}`);
    assert(state.language === fixture.language, `${fixture.name}: expected ${fixture.language} locale, got ${state.language}`);
    assert(!state.overflow, `${fixture.name}: page horizontally overflows its viewport`);
    assert(state.main && state.nav, `${fixture.name}: required landmarks are missing`);
    const screenshot = path.join(outputDir, `${fixture.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    results.push({ ...fixture, canvas: state.canvas, screenshot: path.relative(projectDir, screenshot) });
    await page.close();
  }
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Visual fixtures passed (${results.length} responsive/theme/locale states); screenshots: ${path.relative(projectDir, outputDir)}`);
} finally {
  await browser?.close();
  if (launcher.exitCode === null) {
    launcher.kill("SIGTERM");
    await new Promise((resolve) => launcher.once("exit", resolve));
  }
  if (launcher.exitCode && output) process.stderr.write(output);
}
