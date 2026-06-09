import assert from "node:assert/strict";
import {
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  cleanConfig,
  evaluateAutomationRule,
  normalizeDashboardWidgets,
  normalizeRateBands,
  normalizeSubnets,
  parseJsonWithContext,
  rateForTimestamp,
  recoverConcatenatedJsonValue,
  sampleFromStatus,
  summarizeSamples,
} from "../server.js";

const migrated = cleanConfig({
  standardRateYenPerKwh: 36,
  offPeakRateYenPerKwh: 18,
  offPeakSavingsEnabled: true,
  settingCache: {
    discharge_limit: {
      lastKnown: { decoded: { percent: 30 } },
      lastReadAt: "2026-05-31T00:00:00.000Z",
    },
  },
});
assert.equal(migrated.rateMode, "offPeak");
assert.equal(migrated.rateBands.length, 2);
assert.equal(migrated.offPeakSavingsEnabled, true);
assert.equal(Math.max(...migrated.rateBands.map((band) => band.yenPerKwh)), 36);
assert.equal(migrated.settingCache.discharge_limit.lastKnown.decoded.percent, 30);

const simple = cleanConfig({ standardRateYenPerKwh: 42 });
assert.equal(simple.rateMode, "simple");
assert.equal(simple.offPeakSavingsEnabled, false);
assert.equal(simple.rateBands.length, 1);
assert.equal(simple.historyRetentionDays, 1095);
assert.equal(simple.updateIntervalSeconds, 15);
assert.equal(simple.co2TonnesPerKwh, 0.000423);
assert.equal(rateForTimestamp(simple.rateBands, "2026-05-31T23:30:00+09:00").yenPerKwh, 42);
assert.equal(simple.dashboardWidgets.length, 15);
assert.equal(simple.dashboardWidgets[0].id, "solarPower");

assert.equal(cleanConfig({ updateIntervalSeconds: 2 }).updateIntervalSeconds, 5);
assert.equal(cleanConfig({ updateIntervalSeconds: 30 }).updateIntervalSeconds, 30);
assert.equal(cleanConfig({ co2TonnesPerKwh: 0.0005 }).co2TonnesPerKwh, 0.0005);

const normalizedWidgets = normalizeDashboardWidgets([
  { id: "solarPower", visible: false, priority: 90 },
  { id: "houseDemandPower", visible: true, priority: "bad" },
  { id: "unknownWidget", visible: true, priority: 1 },
]);
assert.equal(normalizedWidgets.length, 15);
assert.deepEqual(normalizedWidgets.find((widget) => widget.id === "solarPower"), {
  id: "solarPower",
  group: "trends",
  visible: false,
  priority: 90,
});
assert.deepEqual(normalizedWidgets.find((widget) => widget.id === "houseDemandPower"), {
  id: "houseDemandPower",
  group: "trends",
  visible: true,
  priority: 30,
});
assert.equal(normalizedWidgets.some((widget) => widget.id === "unknownWidget"), false);
assert.equal(normalizedWidgets.some((widget) => widget.id === "fuelCellPower"), true);

assert.throws(
  () => parseJsonWithContext("[1]\n[2]", "test.json"),
  /test\.json at line 2, column 1, position 4/,
);
const recoveredState = recoverConcatenatedJsonValue(
  '{"old":{"lastResult":{"ok":false}}}\n{"new":{"lastResult":{"ok":true}}}',
  (value) => value && typeof value === "object" && !Array.isArray(value),
);
assert.equal(recoveredState.documentCount, 2);
assert.deepEqual(recoveredState.value, { new: { lastResult: { ok: true } } });
assert.equal(
  recoverConcatenatedJsonValue(
    '[{"id":"old"}]\n[{"id":"new"}]',
    (value) => value && typeof value === "object" && !Array.isArray(value),
  ),
  null,
);

assert.deepEqual(normalizeSubnets(["192.168.1.0/24", "bad", "192.168.1.0/24"]), ["192.168.1.0/24"]);

const bands = normalizeRateBands({
  rateBands: [
    { start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" },
    { start: "07:00", end: "23:00", yenPerKwh: 40, label: "Day" },
  ],
});
assert.equal(rateForTimestamp(bands, "2026-05-31T23:30:00+09:00").yenPerKwh, 20);
assert.equal(rateForTimestamp(bands, "2026-05-31T12:00:00+09:00").yenPerKwh, 40);

const partialBands = normalizeRateBands({
  rateMode: "multi",
  rateBands: [{ start: "23:00", end: "07:00", yenPerKwh: 20, label: "Night" }],
});
assert.equal(rateForTimestamp(partialBands, "2026-05-31T12:00:00+09:00", 40).yenPerKwh, 40);

const sample = sampleFromStatus({
  read_at: "2026-05-31T12:15:00+09:00",
  energy: {
    battery: { instant_power: { value: 500 }, remaining_percent: { value: 60 } },
    solar: { instant_power: { value: 1200 } },
    fuel_cells: [{ instant_power: { value: 300 } }],
  },
  meter: {
    house_demand_power: { value: 1800 },
    grid_import_power: { value: 200 },
    grid_export_power: { value: 100 },
  },
}, { ...migrated, rateBands: bands }, { timestamp: "2026-05-31T11:45:00+09:00" });
assert.equal(sample.rateYenPerKwh, 40);
assert.equal(sample.solarSavingYen, 24);
assert.equal(sample.solarGenerationKwh, 0.6);

const summary = summarizeSamples([
  { solarSavingYen: 1, offPeakSavingYen: 2, solarGenerationKwh: 0.25 },
  { solarSavingYen: 3, offPeakSavingYen: 4, solarGenerationKwh: 0.75 },
], { co2TonnesPerKwh: 0.000423 });
assert.equal(summary.solarSavingYen, 4);
assert.equal(summary.offPeakSavingYen, 6);
assert.equal(summary.solarGenerationKwh, 1);
assert.equal(summary.co2SavingKg, 0.423);

const rule = cleanAutomationRule({ enabled: true, conditions: { breakerAmps: 40, reserveAmps: 5, source: "houseDemandW" } });
assert.equal(rule.action, "set-mode");
assert.equal(rule.payload.mode, "standby");
assert.equal(rule.restoreAction, "set-mode");
assert.equal(rule.restorePayload.mode, "auto");
assert.equal(cleanAutomationRule({}).conditions.source, "gridImportW");
const mergedRule = cleanAutomationRule({
  updatedAt: "2026-05-31T00:00:00.000Z",
  stateUpdatedAt: "2026-05-31T00:01:00.000Z",
});
assert.equal(mergedRule.updatedAt, "2026-05-31T00:00:00.000Z");
assert.equal(mergedRule.stateUpdatedAt, "2026-05-31T00:01:00.000Z");
const ruleConfig = cleanAutomationRuleConfig({
  id: "rule-1",
  enabled: true,
  state: { awaitingRestore: true },
  lastResult: { ok: true },
  log: [{ message: "state only" }],
});
assert.equal(ruleConfig.id, "rule-1");
assert.equal("state" in ruleConfig, false);
assert.equal("lastResult" in ruleConfig, false);
assert.equal("log" in ruleConfig, false);
const skipped = await evaluateAutomationRule(rule, {
  settings: { mode: { decoded: { mode: "eco" } } },
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 0 } } },
  meter: { house_demand_power: { value: 1000 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(skipped.result.skipped, "conditions not met");

const actualChargingSafe = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  conditions: { source: "houseDemandW", breakerAmps: 40, reserveAmps: 5, batteryChargingEstimateW: 1000 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { house_demand_power: { value: 2800 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(actualChargingSafe.result.skipped, "conditions not met");
assert.equal(actualChargingSafe.result.actualDemandWithChargingW, 3400);

const gridImportDoesNotDoubleCountCharging = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  conditions: { source: "gridImportW", breakerAmps: 40, reserveAmps: 5, batteryChargingEstimateW: 1000 },
}), {
  energy: { battery: { operation_mode: { value: "auto" }, instant_power: { value: 600 } } },
  meter: { grid_import_power: { value: 3400 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(gridImportDoesNotDoubleCountCharging.result.skipped, "conditions not met");
assert.equal(gridImportDoesNotDoubleCountCharging.result.guardDemandW, 3400);


const restoreWouldTrip = await evaluateAutomationRule(cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  conditions: {
    breakerAmps: 40,
    source: "houseDemandW",
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
  },
}), {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { house_demand_power: { value: 2600 } },
}, new Date("2026-05-31T00:00:00.000Z"));
assert.equal(restoreWouldTrip.result.skipped, "restore would exceed breaker reserve");
assert.equal(restoreWouldTrip.result.estimatedRestoredDemandW, 3600);

const repeatedRestoreLogRule = cleanAutomationRule({
  enabled: true,
  state: { awaitingRestore: true },
  lastResult: { ok: true, at: "2026-05-31T00:00:00.000Z", skipped: "restore demand still high" },
  conditions: {
    source: "gridImportW",
    breakerAmps: 40,
    reserveAmps: 5,
    batteryChargingEstimateW: 1000,
    restoreBelowAmps: 30,
  },
});
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3200 } },
}, new Date("2026-05-31T00:01:00.000Z"));
await evaluateAutomationRule(repeatedRestoreLogRule, {
  energy: { battery: { operation_mode: { value: "standby" }, instant_power: { value: 0 } } },
  meter: { grid_import_power: { value: 3100 } },
}, new Date("2026-05-31T00:02:00.000Z"));
assert.equal(repeatedRestoreLogRule.log.length, 2);
assert.match(repeatedRestoreLogRule.log[0].message, /Grid Import \(3200 W\) still exceeds/);
assert.match(repeatedRestoreLogRule.log[1].message, /Grid Import \(3100 W\) still exceeds/);

console.log("helper tests passed");
