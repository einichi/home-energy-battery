import { DatabaseSync } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "./counter-utils.js";
import { ARCHITECTURE_VERSION } from "./application-store.js";
import {
  createHistorySchema,
  migrateHistorySchema,
  inspectHistoryDatabase as inspectHistoryDatabaseFile,
} from "./persistence/history-database.js";
import { createEventRepository } from "./persistence/event-repository.js";
import { createAwayPeriodRepository } from "./persistence/away-period-repository.js";
import {
  createGasTariffRepository,
} from "./persistence/gas-tariff-repository.js";
import { createForecastRepository } from "./persistence/forecast-repository.js";
import { createHistoryStatisticsRepository } from "./persistence/history-statistics-repository.js";
import { createBacktestRepository } from "./persistence/backtest-repository.js";
import { createRetentionRepository } from "./persistence/retention-repository.js";
import {
  createHistoryQueryRepository,
  type HistoryResolution,
} from "./persistence/history-query-repository.js";
import type { HistorySample } from "./contracts/history.js";

export { historyDatabaseFile } from "./persistence/history-database.js";

export const SCHEMA_VERSION = 8;
export const ENERGY_CALCULATION_VERSION = 4;
const MAX_RAW_AUTO_SAMPLES = 10_000;
const MAX_RAW_AUTO_BYTES = 32 * 1024 * 1024;
const AUTO_RAW_DETAIL_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_INTEGRATION_GAP_MS = 35 * 60_000;
const SOLAR_FORECAST_MIN_COVERAGE_RATIO = 0.8;
const ENERGY_KEYS: string[] = [
  "houseDemandKwh",
  "solarGenerationKwh",
  "gridImportKwh",
  "gridExportKwh",
  "fuelCellKwh",
  "batteryChargeKwh",
  "batteryDischargeKwh",
  "fuelCellGasM3",
];
const POWER_KEYS: string[] = [
  "batteryPowerW",
  "solarPowerW",
  "houseDemandW",
  "fuelCellPowerW",
  "gridExportW",
  "gridImportW",
];
const DERIVED_SAMPLE_KEYS: string[] = [
  ...ENERGY_KEYS,
  "circuitEnergyKwh",
  "offPeakSavingYen",
  "solarSavingYen",
  "coverageSeconds",
  "energyQuality",
  "powerCoverageSeconds",
  "intervalAveragePowerW",
  "intervalAverageCircuitPowerW",
  "energyIntervalStart",
  "fuelCellCounterIssues",
  "fuelCellDataQuality",
  "fuelCellGasDataQuality",
  "meterCounterIssues",
  "circuitCounterIssues",
  "fuelCellOperatingSeconds",
  "fuelCellStartCount",
  "guardTriggerCount",
  "calculationVersion",
];


function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value: unknown): number | null {
  const time = new Date(String(value ?? "")).getTime();
  return Number.isFinite(time) ? time : null;
}

function localBucketStart(timeMs: number, resolution: HistoryResolution): number {
  const date = new Date(timeMs);
  if (resolution === "daily") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  const minute = date.getMinutes() < 30 ? 0 : 30;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), minute).getTime();
}

function bucketEnd(startMs: number, resolution: HistoryResolution): number {
  if (resolution === "daily") {
    const date = new Date(startMs);
    date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return startMs + 30 * 60_000;
}

function maximumIntegrationGapMs(sample: HistorySample): number {
  const expectedSeconds = finite(sample?.expectedIntervalSeconds);
  if (expectedSeconds === null) return DEFAULT_MAX_INTEGRATION_GAP_MS;
  return Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000));
}

interface IntervalEnergyDetails {
  value: number;
  seconds: number;
  quality: string;
  averageWatts: number | null;
  startMs: number | null;
  endMs: number | null;
}

function intervalEnergyDetails(
  sample: HistorySample,
  previousSample: HistorySample | null,
  directKey: string,
  wattsKey: string,
  transform: (value: number) => number = (value) => Math.max(0, value),
): IntervalEnergyDetails | null {
  const direct = finite(sample?.[directKey]);
  if (direct !== null) {
    const endMs = timestampMs(sample?.timestamp);
    const startMs = timestampMs(sample?.energyIntervalStart?.[directKey] ?? previousSample?.timestamp);
    return {
      value: direct,
      seconds: Math.max(0, finite(sample?.coverageSeconds?.[directKey]) ?? 0),
      quality: sample?.energyQuality?.[directKey] ?? "counter",
      averageWatts: null,
      startMs,
      endMs,
    };
  }
  const currentWatts = finite(sample?.[wattsKey]);
  const previousWatts = finite(previousSample?.[wattsKey]);
  const currentMs = timestampMs(sample?.timestamp);
  const previousMs = timestampMs(previousSample?.timestamp);
  const elapsedMs = currentMs === null || previousMs === null ? Number.NaN : currentMs - previousMs;
  if (currentWatts === null
    || previousWatts === null
    || !Number.isFinite(elapsedMs)
    || elapsedMs <= 0
    || elapsedMs > maximumIntegrationGapMs(sample)) return null;
  const current = transform(currentWatts);
  const previous = transform(previousWatts);
  const averageWatts = (current + previous) / 2;
  return {
    value: elapsedMs / 3_600_000 * averageWatts / 1000,
    seconds: elapsedMs / 1000,
    quality: "integrated",
    averageWatts,
    startMs: previousMs,
    endMs: currentMs,
  };
}

function intervalEnergy(sample: HistorySample, previousSample: HistorySample | null, directKey: string, wattsKey: string, transform: (value: number) => number = (value) => Math.max(0, value)): number | null {
  return intervalEnergyDetails(sample, previousSample, directKey, wattsKey, transform)?.value ?? null;
}

function baselineForMetric(previousSample: HistorySample | null, metricBaselines: Record<string, HistorySample> | null, key: string): HistorySample | null {
  return metricBaselines?.[key] ?? previousSample;
}

function updateMetricBaselines(metricBaselines: Record<string, HistorySample>, sample: HistorySample): Record<string, HistorySample> {
  for (const key of POWER_KEYS) {
    if (finite(sample?.[key]) !== null) metricBaselines[key] = { timestamp: sample.timestamp, [key]: sample[key] };
  }
  for (const [channel, value] of Object.entries(sample?.circuitPowerW ?? {})) {
    if (finite(value) !== null) metricBaselines[`circuit:${channel}`] = { timestamp: sample.timestamp, circuitPowerW: { [channel]: value } };
  }
  return metricBaselines;
}

export function compactHistorySample(sample: HistorySample = {}): HistorySample {
  const compact: HistorySample = { ...sample };
  for (const key of DERIVED_SAMPLE_KEYS) delete compact[key];
  return compact;
}

export function enrichHistorySample(sample: HistorySample, previousSample: HistorySample | null = null, { metricBaselines = null }: { metricBaselines?: Record<string, HistorySample> | null } = {}): HistorySample {
  const enriched: HistorySample = { ...sample, calculationVersion: ENERGY_CALCULATION_VERSION };
  const mappings: Array<[string, string, (value: number) => number]> = [
    ["houseDemandKwh", "houseDemandW", (value) => Math.max(0, value)],
    ["solarGenerationKwh", "solarPowerW", (value) => Math.max(0, value)],
    ["gridImportKwh", "gridImportW", (value) => Math.max(0, value)],
    ["gridExportKwh", "gridExportW", (value) => Math.max(0, value)],
    ["fuelCellKwh", "fuelCellPowerW", (value) => Math.max(0, value)],
    ["batteryChargeKwh", "batteryPowerW", (value) => Math.max(0, value)],
    ["batteryDischargeKwh", "batteryPowerW", (value) => Math.max(0, -value)],
  ];
  const coverageSeconds: Record<string, number> = { ...(sample.coverageSeconds ?? {}) };
  const energyQuality: Record<string, string> = { ...(sample.energyQuality ?? {}) };
  const powerCoverageSeconds: Record<string, number> = { ...(sample.powerCoverageSeconds ?? {}) };
  const intervalAveragePowerW: Record<string, number> = { ...(sample.intervalAveragePowerW ?? {}) };
  const intervalAverageCircuitPowerW: Record<string, number> = { ...(sample.intervalAverageCircuitPowerW ?? {}) };
  const energyIntervalStart: Record<string, string> = { ...(sample.energyIntervalStart ?? {}) };
  for (const [directKey, wattsKey, transform] of mappings) {
    const baseline = baselineForMetric(previousSample, metricBaselines, wattsKey);
    const details = intervalEnergyDetails(sample, baseline, directKey, wattsKey, transform);
    if (details) {
      enriched[directKey] = details.value;
      coverageSeconds[directKey] = Math.max(Number(coverageSeconds[directKey] ?? 0), details.seconds);
      energyQuality[directKey] = details.quality;
      let averageWatts = details.averageWatts;
      let powerSeconds = details.seconds;
      if (averageWatts === null) {
        const currentWatts = finite(sample?.[wattsKey]);
        const previousWatts = finite(baseline?.[wattsKey]);
        const currentMs = timestampMs(sample?.timestamp);
        const previousMs = timestampMs(baseline?.timestamp);
        const elapsedMs = currentMs === null || previousMs === null ? Number.NaN : currentMs - previousMs;
        if (currentWatts !== null
          && previousWatts !== null
          && elapsedMs > 0
          && elapsedMs <= maximumIntegrationGapMs(sample)) {
          averageWatts = (transform(currentWatts) + transform(previousWatts)) / 2;
          powerSeconds = elapsedMs / 1000;
        }
      }
      if (averageWatts !== null) {
        powerCoverageSeconds[wattsKey] = powerSeconds;
        intervalAveragePowerW[wattsKey] = averageWatts;
      }
      if (details.startMs !== null) energyIntervalStart[directKey] = new Date(details.startMs).toISOString();
    }
  }
  const circuitEnergyKwh: Record<string, number | null> = { ...(sample.circuitEnergyKwh ?? {}) };
  for (const [channel, watts] of Object.entries(sample?.circuitPowerW ?? {})) {
    const circuitKey = `circuit:${channel}`;
    if (finite(circuitEnergyKwh[channel]) !== null) {
      const startMs = timestampMs(sample?.energyIntervalStart?.[circuitKey] ?? previousSample?.timestamp);
      const endMs = timestampMs(sample?.timestamp);
      const seconds = Math.max(0, finite(sample?.coverageSeconds?.[circuitKey])
        ?? (startMs !== null && endMs !== null ? (endMs - startMs) / 1000 : 0));
      coverageSeconds[circuitKey] = seconds;
      energyQuality[circuitKey] = sample?.energyQuality?.[circuitKey] ?? "counter";
      if (startMs !== null) energyIntervalStart[circuitKey] = new Date(startMs).toISOString();
      const baseline = metricBaselines?.[circuitKey] ?? previousSample;
      const previousWatts = finite(baseline?.circuitPowerW?.[channel]);
      const currentWatts = finite(watts);
      const previousMs = timestampMs(baseline?.timestamp);
      const elapsedMs = endMs === null || previousMs === null ? Number.NaN : endMs - previousMs;
      if (currentWatts !== null
        && previousWatts !== null
        && elapsedMs > 0
        && elapsedMs <= maximumIntegrationGapMs(sample)) {
        powerCoverageSeconds[circuitKey] = elapsedMs / 1000;
        intervalAverageCircuitPowerW[channel] = (Math.max(0, currentWatts) + Math.max(0, previousWatts)) / 2;
      }
      continue;
    }
    const baseline = metricBaselines?.[`circuit:${channel}`] ?? previousSample;
    const currentMs = timestampMs(sample.timestamp);
    const previousMs = timestampMs(baseline?.timestamp);
    const previousWatts = finite(baseline?.circuitPowerW?.[channel]);
    const currentWatts = finite(watts);
    const elapsedMs = currentMs === null || previousMs === null ? Number.NaN : currentMs - previousMs;
    if (currentWatts !== null && previousWatts !== null && previousMs !== null && elapsedMs > 0 && elapsedMs <= maximumIntegrationGapMs(sample)) {
      const averageWatts = (Math.max(0, currentWatts) + Math.max(0, previousWatts)) / 2;
      circuitEnergyKwh[channel] = elapsedMs / 3_600_000 * averageWatts / 1000;
      coverageSeconds[circuitKey] = elapsedMs / 1000;
      energyQuality[circuitKey] = "integrated";
      powerCoverageSeconds[circuitKey] = elapsedMs / 1000;
      intervalAverageCircuitPowerW[channel] = averageWatts;
      energyIntervalStart[circuitKey] = new Date(previousMs).toISOString();
    }
  }
  if (Object.keys(circuitEnergyKwh).length) enriched.circuitEnergyKwh = circuitEnergyKwh;
  if (Object.keys(coverageSeconds).length) enriched.coverageSeconds = coverageSeconds;
  if (Object.keys(energyQuality).length) enriched.energyQuality = energyQuality;
  if (Object.keys(powerCoverageSeconds).length) enriched.powerCoverageSeconds = powerCoverageSeconds;
  if (Object.keys(intervalAveragePowerW).length) enriched.intervalAveragePowerW = intervalAveragePowerW;
  if (Object.keys(intervalAverageCircuitPowerW).length) enriched.intervalAverageCircuitPowerW = intervalAverageCircuitPowerW;
  if (Object.keys(energyIntervalStart).length) enriched.energyIntervalStart = energyIntervalStart;
  const solarKwh = finite(enriched.solarGenerationKwh);
  const exportedKwh = finite(enriched.gridExportKwh);
  const rate = finite(enriched.rateYenPerKwh);
  if (solarKwh !== null && rate !== null) {
    enriched.solarSavingYen = Math.max(0, solarKwh - Math.max(0, exportedKwh ?? 0)) * rate;
  }
  const batteryChargeKwh = finite(enriched.batteryChargeKwh);
  const gridImportKwh = finite(enriched.gridImportKwh);
  const referenceRate = finite(enriched.standardRateYenPerKwh) ?? finite(enriched.maximumRateYenPerKwh);
  if (batteryChargeKwh !== null && referenceRate !== null && rate !== null) {
    const boughtChargeKwh = gridImportKwh === null ? batteryChargeKwh : Math.min(batteryChargeKwh, gridImportKwh);
    enriched.offPeakSavingYen = boughtChargeKwh * Math.max(0, referenceRate - rate);
  }
  return enriched;
}

export function interpretHistorySample(rawSample: HistorySample, previousRawSample: HistorySample | null = null, { metricBaselines = null }: { metricBaselines?: Record<string, HistorySample> | null } = {}): HistorySample {
  const sample = compactHistorySample(rawSample);
  const currentMs = timestampMs(sample.timestamp);
  const previousMs = timestampMs(previousRawSample?.timestamp);
  const elapsedSeconds = currentMs !== null && previousMs !== null
    ? Math.max(0, (currentMs - previousMs) / 1000)
    : 0;
  const maximumGapSeconds = maximumIntegrationGapMs(sample) / 1000;
  const intervalSeconds = elapsedSeconds > 0 && elapsedSeconds <= maximumGapSeconds ? elapsedSeconds : 0;
  const sameFuelCellSource = Boolean(sample.fuelCellCounterSourceHost)
    && sample.fuelCellCounterSourceHost === previousRawSample?.fuelCellCounterSourceHost;
  const sameMeterSource = Boolean(sample.meterCounterSourceHost)
    && sample.meterCounterSourceHost === previousRawSample?.meterCounterSourceHost;
  const unavailableCounter: { delta: null; issue: null } = { delta: null, issue: null };
  const fuelCellElectricity = sameFuelCellSource
    ? cumulativeCounterDeltaResult(
      sample.fuelCellCumulativeGenerationKwh,
      previousRawSample?.fuelCellCumulativeGenerationKwh,
      COUNTER_POLICIES.fuelCellElectricity,
      elapsedSeconds,
    )
    : unavailableCounter;
  const fuelCellGas = sameFuelCellSource
    ? cumulativeCounterDeltaResult(
      sample.fuelCellCumulativeGasM3,
      previousRawSample?.fuelCellCumulativeGasM3,
      COUNTER_POLICIES.fuelCellGas,
      elapsedSeconds,
    )
    : unavailableCounter;
  const gridImport = sameMeterSource
    ? cumulativeCounterDeltaResult(
      sample.gridImportCumulativeKwh,
      previousRawSample?.gridImportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : unavailableCounter;
  const gridExport = sameMeterSource
    ? cumulativeCounterDeltaResult(
      sample.gridExportCumulativeKwh,
      previousRawSample?.gridExportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : unavailableCounter;

  const currentCircuits = Object.fromEntries(Object.entries(sample.circuitCumulativeKwh ?? {})
    .map(([channel, value]) => [channel, finite(value)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null && entry[1] >= 0));
  const circuitEnergyKwh: Record<string, number> = {};
  const circuitCounterIssues: Array<{ channel: number; issue: string }> = [];
  if (sameMeterSource) {
    for (const [channel, current] of Object.entries(currentCircuits)) {
      const result = cumulativeCounterDeltaResult(
        current,
        previousRawSample?.circuitCumulativeKwh?.[channel],
        COUNTER_POLICIES.circuit,
        elapsedSeconds,
      );
      if (result.delta !== null) circuitEnergyKwh[channel] = result.delta;
      if (result.issue) circuitCounterIssues.push({ channel: Number(channel), issue: result.issue });
    }
  }
  const exactHouseDemandKwh = Object.keys(currentCircuits).length > 0
    && Object.keys(circuitEnergyKwh).length === Object.keys(currentCircuits).length
    ? Object.values(circuitEnergyKwh).reduce((sum, value) => sum + value, 0)
    : null;

  const interpreted: HistorySample = { ...sample };
  const directMetrics: Array<[string, number | null]> = [
    ["fuelCellKwh", fuelCellElectricity.delta],
    ["fuelCellGasM3", fuelCellGas.delta],
    ["gridImportKwh", gridImport.delta],
    ["gridExportKwh", gridExport.delta],
    ["houseDemandKwh", exactHouseDemandKwh],
  ];
  const coverageSeconds: Record<string, number> = {};
  const energyQuality: Record<string, string> = {};
  const energyIntervalStart: Record<string, string> = {};
  interpreted.coverageSeconds = coverageSeconds;
  interpreted.energyQuality = energyQuality;
  interpreted.energyIntervalStart = energyIntervalStart;
  for (const [key, value] of directMetrics) {
    if (value === null) continue;
    interpreted[key] = value;
    coverageSeconds[key] = intervalSeconds;
    energyQuality[key] = "counter";
    if (previousRawSample?.timestamp) energyIntervalStart[key] = previousRawSample.timestamp;
  }
  if (Object.keys(circuitEnergyKwh).length) interpreted.circuitEnergyKwh = circuitEnergyKwh;
  for (const channel of Object.keys(circuitEnergyKwh)) {
    const key = `circuit:${channel}`;
    coverageSeconds[key] = intervalSeconds;
    energyQuality[key] = "counter";
    if (previousRawSample?.timestamp) energyIntervalStart[key] = previousRawSample.timestamp;
  }
  interpreted.fuelCellCounterIssues = [
    ...(fuelCellElectricity.issue ? [{ counter: "electricity", issue: fuelCellElectricity.issue }] : []),
    ...(fuelCellGas.issue ? [{ counter: "gas", issue: fuelCellGas.issue }] : []),
  ];
  interpreted.meterCounterIssues = [
    ...(gridImport.issue ? [{ counter: "import", issue: gridImport.issue }] : []),
    ...(gridExport.issue ? [{ counter: "export", issue: gridExport.issue }] : []),
  ];
  interpreted.circuitCounterIssues = circuitCounterIssues;
  interpreted.fuelCellDataQuality = fuelCellElectricity.delta !== null
    ? "counter"
    : finite(sample.fuelCellPowerW) !== null && fuelCellGas.delta !== null
      ? "mixed"
      : finite(sample.fuelCellPowerW) !== null
        ? "integrated"
        : null;
  interpreted.fuelCellGasDataQuality = fuelCellGas.delta !== null ? "counter" : null;
  interpreted.fuelCellOperatingSeconds = intervalSeconds > 0
    && ["generating", "starting", "stopping", "idling"].includes(String(previousRawSample?.fuelCellGenerationState ?? ""))
    ? intervalSeconds
    : 0;
  interpreted.fuelCellStartCount = sample.fuelCellGenerationState === "generating"
    && previousRawSample?.fuelCellGenerationState !== "generating"
    ? 1
    : 0;
  return enrichHistorySample(interpreted, previousRawSample, { metricBaselines });
}

interface AverageMetric {
  sum: number;
  count: number;
  weightedSum: number;
  weight: number;
  min: number | null;
  max: number | null;
}

interface RollupState {
  resolution: HistoryResolution;
  startMs: number;
  endMs: number;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  powers: Record<string, AverageMetric>;
  soc: { sum: number; count: number; min: number | null; max: number | null; first: number | null; last: number | null };
  energy: Record<string, { sum: number; count: number }>;
  coverageSeconds: Record<string, number>;
  energyQualities: Record<string, Record<string, number>>;
  savings: { offPeakSavingYen: number; solarSavingYen: number };
  circuits: { power: Record<string, AverageMetric>; energy: Record<string, number>; cumulative: Record<string, number> };
  fuelCell: {
    operatingSeconds: number;
    startCount: number;
    states: Record<string, number>;
    qualities: Record<string, number>;
    lastState: string | null;
    lastHotWaterLevel: number | null;
    sourceHosts: Record<string, number>;
  };
  guardTriggerCount: number;
  rateYenPerKwh: number | null;
  rateLabel: string | null;
}

function emptyRollupState(startMs: number, resolution: HistoryResolution): RollupState {
  return {
    resolution,
    startMs,
    endMs: bucketEnd(startMs, resolution),
    count: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    powers: {},
    soc: { sum: 0, count: 0, min: null, max: null, first: null, last: null },
    energy: {},
    coverageSeconds: {},
    energyQualities: {},
    savings: { offPeakSavingYen: 0, solarSavingYen: 0 },
    circuits: { power: {}, energy: {}, cumulative: {} },
    fuelCell: { operatingSeconds: 0, startCount: 0, states: {}, qualities: {}, lastState: null, lastHotWaterLevel: null, sourceHosts: {} },
    guardTriggerCount: 0,
    rateYenPerKwh: null,
    rateLabel: null,
  };
}

function addAverageMetric(target: Record<string, AverageMetric>, key: string, value: unknown, weight: unknown = 1): void {
  const number = finite(value);
  const normalizedWeight = Math.max(0, finite(weight) ?? 0);
  if (number === null || normalizedWeight <= 0) return;
  const metric = target[key] ?? { sum: 0, count: 0, weightedSum: 0, weight: 0, min: null, max: null };
  metric.sum += number;
  metric.count += 1;
  metric.weightedSum = Number(metric.weightedSum ?? 0) + number * normalizedWeight;
  metric.weight = Number(metric.weight ?? 0) + normalizedWeight;
  metric.min = metric.min === null ? number : Math.min(metric.min, number);
  metric.max = metric.max === null ? number : Math.max(metric.max, number);
  target[key] = metric;
}

function addRollupSample(state: RollupState, sample: HistorySample): RollupState {
  state.fuelCell ??= { operatingSeconds: 0, startCount: 0, states: {}, qualities: {}, lastState: null, lastHotWaterLevel: null, sourceHosts: {} };
  state.fuelCell.lastHotWaterLevel ??= null;
  state.energyQualities ??= {};
  state.count += Number(sample.rollupSampleCount ?? 1) || 1;
  state.firstTimestamp ??= sample.timestamp ?? null;
  state.lastTimestamp = sample.timestamp ?? null;
  for (const key of POWER_KEYS) {
    const weight = finite(sample.powerCoverageSeconds?.[key]) ?? 0;
    const value = finite(sample.intervalAveragePowerW?.[key]) ?? sample[key];
    addAverageMetric(state.powers, key, value, weight);
  }
  const soc = finite(sample.stateOfChargePercent);
  if (soc !== null) {
    state.soc.sum += soc;
    state.soc.count += 1;
    state.soc.min = state.soc.min === null ? soc : Math.min(state.soc.min, soc);
    state.soc.max = state.soc.max === null ? soc : Math.max(state.soc.max, soc);
    state.soc.first ??= soc;
    state.soc.last = soc;
  }
  for (const key of ENERGY_KEYS) {
    const value = finite(sample[key]);
    if (value === null) continue;
    const energy = state.energy[key] ?? { sum: 0, count: 0 };
    energy.sum += value;
    energy.count += 1;
    state.energy[key] = energy;
  }
  for (const [key, value] of Object.entries(sample.coverageSeconds ?? {})) {
    const seconds = finite(value);
    if (seconds !== null) state.coverageSeconds[key] = Number(state.coverageSeconds[key] ?? 0) + seconds;
  }
  for (const [key, value] of Object.entries(sample.energyQuality ?? {})) {
    if (!value) continue;
    const qualities: Record<string, number> = state.energyQualities[key] ?? {};
    const quality = String(value);
    qualities[quality] = Number(qualities[quality] ?? 0) + 1;
    state.energyQualities[key] = qualities;
  }
  state.savings.offPeakSavingYen += finite(sample.offPeakSavingYen) ?? 0;
  state.savings.solarSavingYen += finite(sample.solarSavingYen) ?? 0;
  for (const [channel, value] of Object.entries(sample.circuitPowerW ?? {})) {
    addAverageMetric(
      state.circuits.power,
      channel,
      finite(sample.intervalAverageCircuitPowerW?.[channel]) ?? value,
      finite(sample.powerCoverageSeconds?.[`circuit:${channel}`]) ?? 0,
    );
  }
  for (const [channel, value] of Object.entries(sample.circuitEnergyKwh ?? {})) {
    const energy = finite(value);
    if (energy !== null) state.circuits.energy[channel] = Number(state.circuits.energy[channel] ?? 0) + energy;
  }
  for (const [channel, value] of Object.entries(sample.circuitCumulativeKwh ?? {})) {
    const cumulative = finite(value);
    if (cumulative !== null) state.circuits.cumulative[channel] = cumulative;
  }
  state.guardTriggerCount += Math.max(0, finite(sample.guardTriggerCount) ?? 0);
  state.fuelCell.operatingSeconds += Math.max(0, finite(sample.fuelCellOperatingSeconds) ?? 0);
  state.fuelCell.startCount += Math.max(0, finite(sample.fuelCellStartCount) ?? 0);
  if (sample.fuelCellGenerationState) {
    const seconds = Math.max(0, finite(sample.fuelCellOperatingSeconds) ?? 0);
    state.fuelCell.states[sample.fuelCellGenerationState] = Number(state.fuelCell.states[sample.fuelCellGenerationState] ?? 0) + seconds;
    state.fuelCell.lastState = sample.fuelCellGenerationState;
  }
  const hotWaterLevel = finite(sample.fuelCellHotWaterLevel);
  if (Object.prototype.hasOwnProperty.call(sample, "fuelCellHotWaterLevel")) {
    state.fuelCell.lastHotWaterLevel = hotWaterLevel;
  }
  if (sample.fuelCellDataQuality) state.fuelCell.qualities[sample.fuelCellDataQuality] = Number(state.fuelCell.qualities[sample.fuelCellDataQuality] ?? 0) + 1;
  if (sample.fuelCellSourceHost) state.fuelCell.sourceHosts[sample.fuelCellSourceHost] = Number(state.fuelCell.sourceHosts[sample.fuelCellSourceHost] ?? 0) + 1;
  state.rateYenPerKwh = finite(sample.rateYenPerKwh) ?? state.rateYenPerKwh;
  state.rateLabel = sample.rateLabel ?? state.rateLabel;
  return state;
}

function rollupPayload(state: RollupState): HistorySample {
  const payload: HistorySample = {
    timestamp: state.lastTimestamp ?? new Date(Math.max(state.startMs, state.endMs - 1)).toISOString(),
    rollupResolution: state.resolution,
    rollupStart: new Date(state.startMs).toISOString(),
    rollupEnd: new Date(state.endMs).toISOString(),
    rollupSampleCount: state.count,
    coverageSeconds: state.coverageSeconds,
    energyQuality: Object.fromEntries(Object.entries(state.energyQualities ?? {}).map(([key, counts]) => {
      const qualities = Object.keys(counts).filter((quality) => Number(counts[quality]) > 0);
      return [key, qualities.length === 1 ? qualities[0] : "mixed"];
    })),
    offPeakSavingYen: state.savings.offPeakSavingYen,
    solarSavingYen: state.savings.solarSavingYen,
    guardTriggerCount: state.guardTriggerCount,
    fuelCellOperatingSeconds: state.fuelCell.operatingSeconds,
    fuelCellStartCount: state.fuelCell.startCount,
    fuelCellStateDurations: state.fuelCell.states,
    fuelCellGenerationState: state.fuelCell.lastState,
    fuelCellHotWaterLevel: state.fuelCell.lastHotWaterLevel,
    fuelCellDataQualities: state.fuelCell.qualities,
    fuelCellSourceHosts: state.fuelCell.sourceHosts,
  };
  const powerCoverageSeconds: Record<string, number> = {};
  const intervalAveragePowerW: Record<string, number> = {};
  for (const [key, metric] of Object.entries(state.powers)) {
    if (metric.weight > 0) {
      payload[key] = metric.weightedSum / metric.weight;
      powerCoverageSeconds[key] = metric.weight;
      intervalAveragePowerW[key] = Number(payload[key]);
    } else if (metric.count > 0) {
      payload[key] = metric.sum / metric.count;
    }
  }
  if (Object.keys(powerCoverageSeconds).length) payload.powerCoverageSeconds = powerCoverageSeconds;
  if (Object.keys(intervalAveragePowerW).length) payload.intervalAveragePowerW = intervalAveragePowerW;
  if (state.powers.houseDemandW?.max != null) payload.peakHouseDemandW = state.powers.houseDemandW.max;
  if (state.soc.count > 0) {
    payload.stateOfChargePercent = state.soc.sum / state.soc.count;
    payload.startStateOfChargePercent = state.soc.first;
    payload.endStateOfChargePercent = state.soc.last;
    payload.minimumStateOfChargePercent = state.soc.min;
    payload.maximumStateOfChargePercent = state.soc.max;
  }
  for (const [key, energy] of Object.entries(state.energy)) {
    if (energy.count > 0) payload[key] = energy.sum;
  }
  const circuitPowerW: Record<string, number> = {};
  for (const [channel, metric] of Object.entries(state.circuits.power)) {
    if (metric.weight > 0) circuitPowerW[channel] = metric.weightedSum / metric.weight;
    else if (metric.count > 0) circuitPowerW[channel] = metric.sum / metric.count;
  }
  if (Object.keys(circuitPowerW).length) payload.circuitPowerW = circuitPowerW;
  if (Object.keys(state.circuits.energy).length) payload.circuitEnergyKwh = state.circuits.energy;
  if (Object.keys(state.circuits.cumulative).length) payload.circuitCumulativeKwh = state.circuits.cumulative;
  if (state.rateYenPerKwh !== null) payload.rateYenPerKwh = state.rateYenPerKwh;
  if (state.rateLabel !== null) payload.rateLabel = state.rateLabel;
  return payload;
}

function parseJson<T = Record<string, unknown> | null>(text: unknown, fallback: T = null as T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function createHistoryStore({
  dataDir,
  maxRawAutoBytes = MAX_RAW_AUTO_BYTES,
}: { dataDir: string; logger?: Pick<Console, "log" | "warn">; maxRawAutoBytes?: number }) {
  const databaseFile = path.join(dataDir, "history.sqlite");
  let database: DatabaseSync | null = null;
  let previousSample: HistorySample | null = null;
  let metricBaselines: Record<string, HistorySample> = {};
  const rollupStates = new Map<string, RollupState>();
  // Bound the in-memory rollup cache; older buckets are re-read from SQLite if
  // ever touched again, so an unbounded map is unnecessary.
  const ROLLUP_STATE_CACHE_LIMIT = 512;

  const ready = () => database !== null;
  const requireDatabase = () => {
    if (!database) throw new Error("history database is not initialized");
    return database;
  };
  const eventRepository = createEventRepository({
    database: requireDatabase,
    timestampMs,
    parseJson: (value) => parseJson(value),
  });
  const awayPeriodRepository = createAwayPeriodRepository({ database: requireDatabase, timestampMs });
  const gasTariffRepository = createGasTariffRepository({ database: requireDatabase });
  const forecastRepository = createForecastRepository({
    database: requireDatabase,
    intervalEnergy,
    solarForecastMinimumCoverageRatio: SOLAR_FORECAST_MIN_COVERAGE_RATIO,
  });
  const backtestRepository = createBacktestRepository(requireDatabase);
  const statisticsRepository = createHistoryStatisticsRepository({ database: requireDatabase, databaseFile, metadataGet });
  const retentionRepository = createRetentionRepository({ database: requireDatabase, stats: statisticsRepository.stats });
  const queryRepository = createHistoryQueryRepository({
    database: requireDatabase,
    compactHistorySample,
    interpretHistorySample,
    updateMetricBaselines,
    maxRawAutoBytes,
    maxRawAutoSamples: MAX_RAW_AUTO_SAMPLES,
    autoRawDetailWindowMs: AUTO_RAW_DETAIL_WINDOW_MS,
  });
  const stats = statisticsRepository.stats;
  const applyRetention = retentionRepository.applyRetention;
  const { batteryChargeCurveSamples, historicalWeather, querySamples } = queryRepository;
  const { eventsBetween, eventsByKeyPrefix, recentEvents, tagEventsBefore } = eventRepository;
  const { awayPeriod, awayPeriods, createAwayPeriod, deleteAwayPeriod, updateAwayPeriod } = awayPeriodRepository;
  const {
    deleteOverride: deleteGasTariffOverride,
    override: gasTariffOverride,
    recordSnapshot: recordGasTariffSnapshot,
    setOverride: setGasTariffOverride,
    snapshots: gasTariffSnapshots,
  } = gasTariffRepository;
  const {
    fuelCellForecastOutcomes,
    recordForecast,
    recordFuelCellForecasts,
    recordSolarForecastIssues,
    recordWeather,
    settleFuelCellForecastOutcomes,
    settleSolarForecastOutcomes,
    solarForecastAccuracy,
    solarForecastOutcomes,
  } = forecastRepository;

  function recordEvent(event: Record<string, unknown>): boolean {
    return eventRepository.recordEvent({
      eventKey: String(event.eventKey ?? ""),
      category: String(event.category ?? ""),
      ...(typeof event.at === "string" ? { at: event.at } : {}),
      ...(typeof event.type === "string" ? { type: event.type } : {}),
      message: event.message === null || event.message === undefined ? null : String(event.message),
      payload: event.payload ?? null,
    });
  }

  function metadataGet<T>(key: string, fallback: T): T {
    const row = requireDatabase().prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return row ? parseJson(row.value, fallback) : fallback;
  }

  function loadRollupState(resolution: HistoryResolution, startMs: number): RollupState {
    const key = `${resolution}:${startMs}`;
    const cached = rollupStates.get(key);
    if (cached) return cached;
    const row = requireDatabase().prepare(
      "SELECT state_json FROM rollups WHERE resolution = ? AND bucket_start_ms = ?",
    ).get(resolution, startMs) as { state_json?: unknown } | undefined;
    const state = row ? parseJson(row.state_json, emptyRollupState(startMs, resolution)) : emptyRollupState(startMs, resolution);
    rollupStates.set(key, state);
    if (rollupStates.size > ROLLUP_STATE_CACHE_LIMIT) {
      const oldest = rollupStates.keys().next().value;
      if (oldest !== undefined && oldest !== key) rollupStates.delete(oldest);
    }
    return state;
  }

  function persistRollup(state: RollupState): void {
    const payload = rollupPayload(state);
    requireDatabase().prepare(`
      INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resolution, bucket_start_ms) DO UPDATE SET
        bucket_end_ms = excluded.bucket_end_ms,
        payload_json = excluded.payload_json,
        state_json = excluded.state_json
    `).run(state.resolution, state.startMs, state.endMs, JSON.stringify(payload), JSON.stringify(state));
  }

  function updateRollups(sample: HistorySample): void {
    const timeMs = timestampMs(sample.timestamp);
    if (timeMs === null) return;
    for (const resolution of ["interval", "daily"] as HistoryResolution[]) {
      const startMs = localBucketStart(timeMs, resolution);
      const state = loadRollupState(resolution, startMs);
      addRollupSample(state, sample);
      persistRollup(state);
    }
  }

  function insertSample(sample: HistorySample, { sourceFile = null, sourceLine = null }: { sourceFile?: string | null; sourceLine?: number | null } = {}) {
    const timeMs = timestampMs(sample?.timestamp);
    if (timeMs === null) return { inserted: false, sample: null };
    const compact = compactHistorySample(sample);
    // Runtime samples carry no source info, so the (source_file, source_line)
    // unique constraint never fires. Dedupe explicitly by timestamp so a
    // restart-adjacent duplicate cannot be integrated into rollups twice.
    const duplicate = requireDatabase().prepare("SELECT 1 AS present FROM samples WHERE timestamp_ms = ? LIMIT 1").get(timeMs);
    if (duplicate) return { inserted: false, sample: null };
    const interpreted = interpretHistorySample(compact, previousSample, { metricBaselines });
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO samples(timestamp_ms, timestamp, payload_json, source_file, source_line)
      VALUES (?, ?, ?, ?, ?)
    `).run(timeMs, String(compact.timestamp), JSON.stringify(compact), sourceFile, sourceLine);
    if (Number(result.changes) > 0) {
      updateRollups(interpreted);
      previousSample = compact;
      updateMetricBaselines(metricBaselines, compact);
      return { inserted: true, sample: interpreted };
    }
    return { inserted: false, sample: interpreted };
  }

  function appendSample(sample: HistorySample): HistorySample | null {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = insertSample(sample);
      db.exec("COMMIT");
      return result.sample;
    } catch (error: unknown) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function latestRawSample(): HistorySample | null {
    const row = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
    ).get();
    return row ? parseJson((row as { payload_json?: unknown }).payload_json, null as HistorySample | null) : null;
  }

  function recentMetricBaselines(): Record<string, HistorySample> {
    const rows = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 5000",
    ).all().reverse();
    const baselines: Record<string, HistorySample> = {};
    for (const row of rows as Array<{ payload_json?: unknown }>) updateMetricBaselines(baselines, parseJson(row.payload_json, {} as HistorySample));
    return baselines;
  }

  async function initialize(): Promise<void> {
    if (database) return;
    await mkdir(dataDir, { recursive: true });
    let existing = true;
    try {
      await stat(databaseFile);
    } catch (error: unknown) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      existing = false;
    }
    database = new DatabaseSync(databaseFile);
    if (!existing) {
      createHistorySchema(database, {
        schemaVersion: SCHEMA_VERSION,
        energyCalculationVersion: ENERGY_CALCULATION_VERSION,
        architectureVersion: ARCHITECTURE_VERSION,
      });
    } else {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
      const row = table ? database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as { value?: unknown } | undefined : null;
      const version = row ? parseJson(row.value, null as number | null) : null;
      if (version === 7 && SCHEMA_VERSION === 8) {
        migrateHistorySchema(database, {
          schemaVersion: SCHEMA_VERSION,
          energyCalculationVersion: ENERGY_CALCULATION_VERSION,
          architectureVersion: ARCHITECTURE_VERSION,
        });
      } else if (version !== SCHEMA_VERSION) {
        database.close();
        database = null;
        throw new Error(`history database schema ${version ?? "unknown"} is not ready for application schema ${SCHEMA_VERSION}`);
      }
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    }
    previousSample = latestRawSample();
    metricBaselines = recentMetricBaselines();
  }

  function close(): void {
    if (!database) return;
    database.close();
    database = null;
    previousSample = null;
    rollupStates.clear();
  }

  return {
    appendSample,
    applyRetention,
    awayPeriod,
    awayPeriods,
    close,
    createAwayPeriod,
    databaseFile,
    deleteAwayPeriod,
    enrichHistorySample,
    eventsBetween,
    eventsByKeyPrefix,
    historicalWeather,
    initialize,
    isReady: ready,
    latestSample: latestRawSample,
    batteryChargeCurveSamples,
    adaptivePlanSnapshots: backtestRepository.planSnapshots,
    backtestOutcomes: backtestRepository.outcomes,
    backtestRuns: backtestRepository.listRuns,
    completeBacktestRun: backtestRepository.completeRun,
    createBacktestRun: backtestRepository.createRun,
    querySamples,
    recordAdaptivePlanSnapshot: backtestRepository.recordPlanSnapshot,
    saveBacktestOutcome: backtestRepository.saveOutcome,
    recordEvent,
    recentEvents,
    recordGasTariffSnapshot,
    recordForecast,
    recordFuelCellForecasts,
    recordSolarForecastIssues,
    recordWeather,
    settleSolarForecastOutcomes,
    settleFuelCellForecastOutcomes,
    fuelCellForecastOutcomes,
    solarForecastAccuracy,
    solarForecastOutcomes,
    gasTariffOverride,
    gasTariffSnapshots,
    setGasTariffOverride,
    deleteGasTariffOverride,
    stats,
    tagEventsBefore,
    updateAwayPeriod,
  };
}

export async function inspectHistoryDatabase(dataDir: string) {
  return inspectHistoryDatabaseFile(dataDir, SCHEMA_VERSION);
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
