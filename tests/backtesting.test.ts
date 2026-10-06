import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createHistoryStore, inspectHistoryDatabase, SCHEMA_VERSION } from "../lib/history-store.js";
import { createHistorySchema } from "../lib/persistence/history-database.js";
import { createBacktestService } from "../lib/services/backtest-service.js";
import { CURRENT_BACKTEST_MODEL, evaluateBacktestCase } from "../lib/domain/backtesting.js";
import type { AdaptivePlanSnapshot } from "../lib/contracts/backtesting.js";

const config: AdaptivePlanSnapshot["config"] = {
  rateBands: [{ start: "00:00", end: "00:00", yenPerKwh: 20, label: "Test" }],
  standardRateYenPerKwh: 20,
  batteryCapabilities: { usableCapacityKwh: 10, maximumChargeWatts: 3000 },
  adaptiveCharging: {
    enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 5,
    panelTiltDegrees: 30, panelAzimuthDegrees: 0, systemLossPercent: 14,
    targetSocPercent: 80, forecastMarginPercent: 10,
  },
};

const snapshot: AdaptivePlanSnapshot = {
  id: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  modelId: CURRENT_BACKTEST_MODEL.id,
  modelVersion: CURRENT_BACKTEST_MODEL.version,
  trigger: "test",
  config,
  plan: {
    available: true,
    slots: [{
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:30:00.000Z",
      windowEnd: "2026-01-01T01:00:00.000Z",
      targetWh: 1000,
      yenPerKwh: 20,
      label: "Test",
    }],
    targetSunset: "2026-01-01T01:00:00.000Z",
    expectedSunsetSocPercent: 55,
    predictedSolarKwh: 0.5,
    predictedDemandKwh: 2,
    predictedFuelCellKwh: 0,
  },
};

const evaluated = evaluateBacktestCase({
  snapshot,
  samples: [
    {
      rollupStart: "2026-01-01T00:00:00.000Z", rollupEnd: "2026-01-01T00:30:00.000Z",
      houseDemandKwh: 1, solarGenerationKwh: 0.25, fuelCellKwh: 0, gridImportKwh: 0.75,
      rateYenPerKwh: 20, startStateOfChargePercent: 50, endStateOfChargePercent: 50,
      minimumStateOfChargePercent: 49, coverageSeconds: { houseDemandKwh: 1800 },
    },
    {
      rollupStart: "2026-01-01T00:30:00.000Z", rollupEnd: "2026-01-01T01:00:00.000Z",
      houseDemandKwh: 1, solarGenerationKwh: 0.25, fuelCellKwh: 0, gridImportKwh: 0.75,
      rateYenPerKwh: 20, startStateOfChargePercent: 50, endStateOfChargePercent: 50,
      minimumStateOfChargePercent: 49, coverageSeconds: { houseDemandKwh: 1800 },
    },
  ],
});
assert.equal(evaluated.evaluable, true);
assert.equal(evaluated.components.demand.errorKwh, 0);
assert.equal(evaluated.asOperated?.gridCostYen, 30);
assert.ok(evaluated.modelOnly && evaluated.modelOnly.gridCostYen >= 0);

const migrationDir = await mkdtemp(path.join(os.tmpdir(), "backtest-schema-"));
try {
  const database = new DatabaseSync(path.join(migrationDir, "history.sqlite"));
  createHistorySchema(database, { schemaVersion: 7, energyCalculationVersion: 4, architectureVersion: 1 });
  database.close();
  assert.equal((await inspectHistoryDatabase(migrationDir)).state, "migratable");
  const store = createHistoryStore({ dataDir: migrationDir });
  await store.initialize();
  assert.equal((await inspectHistoryDatabase(migrationDir)).state, "current");
  assert.equal((await store.stats()).schemaVersion, SCHEMA_VERSION);
  store.close();
} finally {
  await rm(migrationDir, { recursive: true, force: true });
}

const serviceDir = await mkdtemp(path.join(os.tmpdir(), "backtest-service-"));
try {
  const store = createHistoryStore({ dataDir: serviceDir });
  await store.initialize();
  store.recordAdaptivePlanSnapshot({ ...snapshot, plan: snapshot.plan });
  store.appendSample({ timestamp: "2026-01-01T00:00:00.000Z", houseDemandW: 1000, solarPowerW: 0, fuelCellPowerW: 0, gridImportW: 1000, stateOfChargePercent: 50, rateYenPerKwh: 20 });
  store.appendSample({ timestamp: "2026-01-01T00:30:00.000Z", houseDemandW: 1000, solarPowerW: 0, fuelCellPowerW: 0, gridImportW: 1000, stateOfChargePercent: 50, rateYenPerKwh: 20 });
  store.appendSample({ timestamp: "2026-01-01T01:00:00.000Z", houseDemandW: 1000, solarPowerW: 0, fuelCellPowerW: 0, gridImportW: 1000, stateOfChargePercent: 50, rateYenPerKwh: 20 });
  const service = createBacktestService({ history: store, randomUUID: () => "run-1", now: () => new Date("2026-01-02T00:00:00.000Z") });
  const result = await service.run({ range: "all", mode: "both" });
  assert.equal(result.status, "complete");
  assert.equal(result.planCount, 1);
  assert.equal(result.exactReplayPlanCount, 1);
  assert.equal(service.list().scheduling, "manual");
  assert.equal(service.list().runs[0]?.id, "run-1");
  store.close();
} finally {
  await rm(serviceDir, { recursive: true, force: true });
}

console.log("backtesting tests passed");
