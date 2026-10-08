import { enrichHistorySample, interpretHistorySample } from "../../lib/history-store.js";

type HistoryCase = { name: string; run: () => unknown };

const sample = (timestamp: string, values: Record<string, unknown> = {}) => ({ timestamp, ...values });

export const historyCharacterizationCases: HistoryCase[] = [
  {
    name: "enrich: power integrates over the interval",
    run: () => enrichHistorySample(
      sample("2026-01-01T00:30:00.000Z", { branchDemandW: 1000, batteryPowerW: -500 }),
      sample("2026-01-01T00:00:00.000Z", { branchDemandW: 1000, batteryPowerW: -500 }),
    ),
  },
  {
    name: "enrich: exact counter energy with coverage",
    run: () => enrichHistorySample(
      sample("2026-01-01T00:30:00.000Z", {
        gridImportW: 2000,
        gridImportKwh: 0.7,
        coverageSeconds: { gridImportKwh: 1800 },
        energyQuality: { gridImportKwh: "counter" },
      }),
      sample("2026-01-01T00:00:00.000Z", { gridImportW: 1000 }),
    ),
  },
  {
    name: "enrich: no previous sample",
    run: () => enrichHistorySample(sample("2026-01-01T00:30:00.000Z", { branchDemandW: 1200 }), null),
  },
  {
    name: "enrich: off-peak saving against standard rate",
    run: () => enrichHistorySample(sample("2026-01-01T00:30:00.000Z", {
      batteryChargeKwh: 1,
      gridImportKwh: 1,
      rateYenPerKwh: 20,
      standardRateYenPerKwh: 30,
      maximumRateYenPerKwh: 40,
    })),
  },
  {
    name: "enrich: off-peak saving falls back to maximum rate",
    run: () => enrichHistorySample(sample("2026-01-01T00:30:00.000Z", {
      batteryChargeKwh: 1,
      gridImportKwh: 1,
      rateYenPerKwh: 20,
      maximumRateYenPerKwh: 40,
    })),
  },
  {
    name: "enrich: battery charge keeps its sign in rollups",
    run: () => enrichHistorySample(
      sample("2026-01-01T00:30:00.000Z", { batteryPowerW: 1700, batteryChargeKwh: 0.85, batteryDischargeKwh: 0 }),
      sample("2026-01-01T00:00:00.000Z", { batteryPowerW: 1700 }),
    ),
  },
  {
    name: "enrich: string, NaN, boolean, and null values are coerced",
    run: () => enrichHistorySample(
      sample("2026-01-01T00:30:00.000Z", { branchDemandW: "1200", gridImportW: Number.NaN, solarGenerationW: true, batteryPowerW: null }),
      sample("2026-01-01T00:00:00.000Z", { branchDemandW: "900", gridImportW: 500, solarGenerationW: null }),
    ),
  },
  {
    name: "enrich: metric baselines are applied",
    run: () => enrichHistorySample(
      sample("2026-01-01T00:30:00.000Z", { gridImportKwh: 5 }),
      sample("2026-01-01T00:00:00.000Z", { gridImportKwh: 4 }),
      { metricBaselines: { gridImportKwh: sample("2025-12-31T23:30:00.000Z", { gridImportKwh: 3 }) } },
    ),
  },
  {
    name: "interpret: raw counters with previous sample",
    run: () => interpretHistorySample(
      sample("2026-01-01T00:30:00.000Z", { gridImportKwh: 12.5, gridExportKwh: 3.25, solarGenerationKwh: 0.4 }),
      sample("2026-01-01T00:00:00.000Z", { gridImportKwh: 12.0, gridExportKwh: 3.0, solarGenerationKwh: 0.1 }),
    ),
  },
  {
    name: "interpret: counter reset is not treated as negative energy",
    run: () => interpretHistorySample(
      sample("2026-01-01T00:30:00.000Z", { gridImportKwh: 0.2 }),
      sample("2026-01-01T00:00:00.000Z", { gridImportKwh: 9000 }),
    ),
  },
  {
    name: "interpret: power only, no previous sample",
    run: () => interpretHistorySample(sample("2026-01-01T00:30:00.000Z", { gridImportW: 1500, batteryPowerW: 800 })),
  },
  {
    name: "interpret: state values pass through",
    run: () => interpretHistorySample(sample("2026-01-01T00:30:00.000Z", {
      stateOfChargePercent: 55,
      operationMode: "standby",
      fuelCellStatus: "generating",
    })),
  },
];
