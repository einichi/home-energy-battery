#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = 8803;
const uiPort = 5184;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;

async function browserExecutable() {
  for (const candidate of [process.env.UI_BROWSER_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* try the next local browser */ }
  }
  throw new Error("No Chromium browser found for accessibility checks");
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
  browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
  const cases = [
    { path: "/ui/", width: 390, height: 844 },
    { path: "/ui/reports", width: 1440, height: 1000 },
    { path: "/ui/reports", width: 390, height: 844 },
    { path: "/ui/battery", width: 390, height: 844 },
    { path: "/ui/automation", width: 1440, height: 1000 },
    { path: "/ui/system/equipment", width: 768, height: 1024 },
    { path: "/ui/", width: 390, height: 844, theme: "dark" },
    { path: "/ui/system/equipment", width: 1440, height: 1000, theme: "dark" },
  ];
  const failures = [];
  for (const testCase of cases) {
    const context = await browser.newContext({ viewport: { width: testCase.width, height: testCase.height }, colorScheme: testCase.theme ?? "light" });
    const page = await context.newPage();
    if (testCase.theme) await page.addInitScript((theme) => localStorage.setItem("home-energy-theme", theme), testCase.theme);
    await page.goto(`${uiOrigin}${testCase.path}`, { waitUntil: "networkidle" });
    await page.locator("main h1").waitFor();
    const issues = await page.evaluate(() => {
      const issueList = [];
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      };
      const accessibleName = (element) => element.getAttribute("aria-label")?.trim()
        || element.getAttribute("title")?.trim()
        || (element.labels ? [...element.labels].map((label) => label.textContent).join(" ").trim() : "")
        || element.textContent?.trim()
        || (element instanceof HTMLInputElement ? element.placeholder.trim() : "");
      if (document.documentElement.lang !== "en" && document.documentElement.lang !== "ja") issueList.push("html lang is missing or unsupported");
      if (document.querySelectorAll("main").length !== 1) issueList.push("page must contain exactly one main landmark");
      if (!document.querySelector("nav")) issueList.push("page has no navigation landmark");
      if (document.querySelectorAll("h1").length !== 1) issueList.push("page must contain exactly one h1");
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id).filter(Boolean);
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      if (duplicates.length) issueList.push(`duplicate ids: ${duplicates.join(", ")}`);
      for (const element of document.querySelectorAll("button,a[href],input,select,textarea,[tabindex='0']")) {
        if (visible(element) && !accessibleName(element)) issueList.push(`unnamed control: ${element.outerHTML.slice(0, 100)}`);
      }
      for (const image of document.querySelectorAll("img")) {
        if (!image.hasAttribute("alt")) issueList.push(`image without alt: ${image.outerHTML.slice(0, 100)}`);
      }
      for (const input of document.querySelectorAll("input,select,textarea")) {
        if (visible(input) && !input.labels?.length && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby")) issueList.push(`unlabelled field: ${input.outerHTML.slice(0, 100)}`);
      }
      return issueList;
    });
    if (issues.length) failures.push(`${testCase.path} (${testCase.width}px):\n  - ${issues.join("\n  - ")}`);
    const axe = await new AxeBuilder({ page }).analyze();
    const violations = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
    if (violations.length) failures.push(`${testCase.path} (${testCase.width}px) axe:\n  - ${violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})\n    ${violation.nodes.map((node) => `${node.target.join(" ")}: ${node.failureSummary ?? ""}`).join("\n    ")}`).join("\n  - ")}`);
    const skip = page.locator(".skip-link");
    await page.keyboard.press("Tab");
    if (!(await skip.evaluate((element) => element === document.activeElement))) failures.push(`${testCase.path}: skip link is not the first keyboard target`);
    await context.close();
  }
  if (failures.length) throw new Error(`Accessibility checks failed:\n${failures.join("\n")}`);
  console.log(`Accessibility checks passed (${cases.length} page/viewport combinations)`);
} finally {
  await browser?.close();
  if (launcher.exitCode === null) {
    launcher.kill("SIGTERM");
    await new Promise((resolve) => launcher.once("exit", resolve));
  }
  if (launcher.exitCode && output) process.stderr.write(output);
}
