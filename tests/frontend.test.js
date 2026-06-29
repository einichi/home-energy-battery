import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DASHBOARD_WIDGET_DEFAULTS,
  metricValue,
  normalizeAutomationLogMessage,
  normalizeDashboardWidgets,
  numericValue,
  parseOsaifuWindow,
  watts,
} from "../public/lib.js";

test("metricValue prefers human, then value+unit, then raw", () => {
  assert.equal(metricValue({ human: "1.2 kW", value: 1200, unit: "W" }), "1.2 kW");
  assert.equal(metricValue({ value: 1200, unit: "W" }), "1200 W");
  assert.equal(metricValue({ value: 0 }), "0");
  assert.equal(metricValue({ raw: "0x1f" }), "0x1f");
  assert.equal(metricValue(null), "--");
  assert.equal(metricValue(undefined, "n/a"), "n/a");
  assert.equal(metricValue({}), "--");
});

test("numericValue coerces values and rejects empty/missing", () => {
  assert.equal(numericValue({ value: 42 }), 42);
  assert.equal(numericValue({ value: "100" }), 100);
  assert.ok(Number.isNaN(numericValue({ value: null })));
  assert.ok(Number.isNaN(numericValue({ value: "" })));
  assert.ok(Number.isNaN(numericValue(undefined)));
});

test("watts rounds finite values and falls back for non-finite", () => {
  assert.equal(watts(1234.6), "1235 W");
  assert.equal(watts(0), "0 W");
  assert.equal(watts(Number.NaN), "-- W");
  assert.equal(watts(Infinity), "-- W");
});

test("parseOsaifuWindow reads decoded hours then falls back to raw bytes", () => {
  assert.deepEqual(parseOsaifuWindow({ decoded: { start_hour: 2, end_hour: 6 } }), { start: 2, end: 6 });
  assert.deepEqual(parseOsaifuWindow({ decoded: { startHour: 23, endHour: 7 } }), { start: 23, end: 7 });
  assert.deepEqual(parseOsaifuWindow({ raw: "0x02000600" }), { start: 2, end: 6 });
  assert.equal(parseOsaifuWindow({ raw: "0x12" }), null);
  assert.equal(parseOsaifuWindow({}), null);
  assert.equal(parseOsaifuWindow(null), null);
});

test("normalizeAutomationLogMessage rewrites legacy phrasing", () => {
  assert.equal(
    normalizeAutomationLogMessage("House demand (3200 W) still exceeds limit"),
    "Grid Import (3200 W) still exceeds limit",
  );
  assert.equal(
    normalizeAutomationLogMessage("set battery working state to (standby)"),
    "set operation mode to standby",
  );
  assert.equal(normalizeAutomationLogMessage(42), "42");
});

test("normalizeDashboardWidgets merges overrides onto defaults and ignores unknowns", () => {
  const widgets = normalizeDashboardWidgets({
    dashboardWidgets: [
      { id: "solarPower", visible: false, priority: 99 },
      { id: "houseDemandPower", visible: true, priority: "bad" },
      { id: "unknownWidget", visible: true, priority: 1 },
    ],
  });
  assert.equal(widgets.length, DASHBOARD_WIDGET_DEFAULTS.length);
  const solar = widgets.find((widget) => widget.id === "solarPower");
  assert.equal(solar.visible, false);
  assert.equal(solar.priority, 99);
  assert.equal(solar.labelKey, "solarGeneration");
  const houseDemand = widgets.find((widget) => widget.id === "houseDemandPower");
  assert.equal(houseDemand.priority, 30);
  assert.equal(widgets.some((widget) => widget.id === "unknownWidget"), false);
});

test("normalizeDashboardWidgets returns defaults for empty/invalid input", () => {
  const defaults = normalizeDashboardWidgets();
  assert.equal(defaults.length, DASHBOARD_WIDGET_DEFAULTS.length);
  assert.deepEqual(defaults[0], DASHBOARD_WIDGET_DEFAULTS[0]);
});
