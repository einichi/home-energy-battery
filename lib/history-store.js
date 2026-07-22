import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { link, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "./counter-utils.js";

export const SCHEMA_VERSION = 7;
export const ENERGY_CALCULATION_VERSION = 4;
const MAX_RAW_AUTO_SAMPLES = 10_000;
const MAX_RAW_AUTO_BYTES = 32 * 1024 * 1024;
const AUTO_RAW_DETAIL_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_INTEGRATION_GAP_MS = 35 * 60_000;
const SOLAR_FORECAST_MIN_COVERAGE_RATIO = 0.8;
const ENERGY_KEYS = [
  "houseDemandKwh",
  "solarGenerationKwh",
  "gridImportKwh",
  "gridExportKwh",
  "fuelCellKwh",
  "batteryChargeKwh",
  "batteryDischargeKwh",
  "fuelCellGasM3",
];
const POWER_KEYS = [
  "batteryPowerW",
  "solarPowerW",
  "houseDemandW",
  "fuelCellPowerW",
  "gridExportW",
  "gridImportW",
];
const DERIVED_SAMPLE_KEYS = [
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

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localBucketStart(timeMs, resolution) {
  const date = new Date(timeMs);
  if (resolution === "daily") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  const minute = date.getMinutes() < 30 ? 0 : 30;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), minute).getTime();
}

function bucketEnd(startMs, resolution) {
  if (resolution === "daily") {
    const date = new Date(startMs);
    date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return startMs + 30 * 60_000;
}

function maximumIntegrationGapMs(sample) {
  const expectedSeconds = finite(sample?.expectedIntervalSeconds);
  if (expectedSeconds === null) return DEFAULT_MAX_INTEGRATION_GAP_MS;
  return Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000));
}

function intervalEnergyDetails(sample, previousSample, directKey, wattsKey, transform = (value) => Math.max(0, value)) {
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

function intervalEnergy(sample, previousSample, directKey, wattsKey, transform = (value) => Math.max(0, value)) {
  return intervalEnergyDetails(sample, previousSample, directKey, wattsKey, transform)?.value ?? null;
}

function baselineForMetric(previousSample, metricBaselines, key) {
  return metricBaselines?.[key] ?? previousSample;
}

function updateMetricBaselines(metricBaselines, sample) {
  for (const key of POWER_KEYS) {
    if (finite(sample?.[key]) !== null) metricBaselines[key] = { timestamp: sample.timestamp, [key]: sample[key] };
  }
  for (const [channel, value] of Object.entries(sample?.circuitPowerW ?? {})) {
    if (finite(value) !== null) metricBaselines[`circuit:${channel}`] = { timestamp: sample.timestamp, circuitPowerW: { [channel]: value } };
  }
  return metricBaselines;
}

export function compactHistorySample(sample = {}) {
  const compact = { ...sample };
  for (const key of DERIVED_SAMPLE_KEYS) delete compact[key];
  return compact;
}

export function enrichHistorySample(sample, previousSample = null, { metricBaselines = null } = {}) {
  const enriched = { ...sample, calculationVersion: ENERGY_CALCULATION_VERSION };
  const mappings = [
    ["houseDemandKwh", "houseDemandW", (value) => Math.max(0, value)],
    ["solarGenerationKwh", "solarPowerW", (value) => Math.max(0, value)],
    ["gridImportKwh", "gridImportW", (value) => Math.max(0, value)],
    ["gridExportKwh", "gridExportW", (value) => Math.max(0, value)],
    ["fuelCellKwh", "fuelCellPowerW", (value) => Math.max(0, value)],
    ["batteryChargeKwh", "batteryPowerW", (value) => Math.max(0, value)],
    ["batteryDischargeKwh", "batteryPowerW", (value) => Math.max(0, -value)],
  ];
  const coverageSeconds = { ...(sample?.coverageSeconds ?? {}) };
  const energyQuality = { ...(sample?.energyQuality ?? {}) };
  const powerCoverageSeconds = { ...(sample?.powerCoverageSeconds ?? {}) };
  const intervalAveragePowerW = { ...(sample?.intervalAveragePowerW ?? {}) };
  const intervalAverageCircuitPowerW = { ...(sample?.intervalAverageCircuitPowerW ?? {}) };
  const energyIntervalStart = { ...(sample?.energyIntervalStart ?? {}) };
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
  const circuitEnergyKwh = { ...(sample?.circuitEnergyKwh ?? {}) };
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
    if (currentWatts !== null && previousWatts !== null && elapsedMs > 0 && elapsedMs <= maximumIntegrationGapMs(sample)) {
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
  const maximumRate = finite(enriched.maximumRateYenPerKwh);
  if (batteryChargeKwh !== null && maximumRate !== null && rate !== null) {
    const boughtChargeKwh = gridImportKwh === null ? batteryChargeKwh : Math.min(batteryChargeKwh, gridImportKwh);
    enriched.offPeakSavingYen = boughtChargeKwh * Math.max(0, maximumRate - rate);
  }
  return enriched;
}

export function interpretHistorySample(rawSample, previousRawSample = null, { metricBaselines = null } = {}) {
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
  const unavailableCounter = { delta: null, issue: null };
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
    .map(([channel, value]) => [channel, finite(value)])
    .filter(([, value]) => value !== null && value >= 0));
  const circuitEnergyKwh = {};
  const circuitCounterIssues = [];
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

  const interpreted = { ...sample };
  const directMetrics = [
    ["fuelCellKwh", fuelCellElectricity.delta],
    ["fuelCellGasM3", fuelCellGas.delta],
    ["gridImportKwh", gridImport.delta],
    ["gridExportKwh", gridExport.delta],
    ["houseDemandKwh", exactHouseDemandKwh],
  ];
  interpreted.coverageSeconds = {};
  interpreted.energyQuality = {};
  interpreted.energyIntervalStart = {};
  for (const [key, value] of directMetrics) {
    if (value === null) continue;
    interpreted[key] = value;
    interpreted.coverageSeconds[key] = intervalSeconds;
    interpreted.energyQuality[key] = "counter";
    if (previousRawSample?.timestamp) interpreted.energyIntervalStart[key] = previousRawSample.timestamp;
  }
  if (Object.keys(circuitEnergyKwh).length) interpreted.circuitEnergyKwh = circuitEnergyKwh;
  for (const channel of Object.keys(circuitEnergyKwh)) {
    const key = `circuit:${channel}`;
    interpreted.coverageSeconds[key] = intervalSeconds;
    interpreted.energyQuality[key] = "counter";
    if (previousRawSample?.timestamp) interpreted.energyIntervalStart[key] = previousRawSample.timestamp;
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
    && ["generating", "starting", "stopping", "idling"].includes(previousRawSample?.fuelCellGenerationState)
    ? intervalSeconds
    : 0;
  interpreted.fuelCellStartCount = sample.fuelCellGenerationState === "generating"
    && previousRawSample?.fuelCellGenerationState !== "generating"
    ? 1
    : 0;
  return enrichHistorySample(interpreted, previousRawSample, { metricBaselines });
}

function emptyRollupState(startMs, resolution) {
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

function addAverageMetric(target, key, value, weight = 1) {
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

function addRollupSample(state, sample) {
  state.fuelCell ??= { operatingSeconds: 0, startCount: 0, states: {}, qualities: {}, lastState: null, lastHotWaterLevel: null, sourceHosts: {} };
  state.fuelCell.lastHotWaterLevel ??= null;
  state.energyQualities ??= {};
  state.count += Number(sample.rollupSampleCount ?? 1) || 1;
  state.firstTimestamp ??= sample.timestamp;
  state.lastTimestamp = sample.timestamp;
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
    const qualities = state.energyQualities[key] ?? {};
    qualities[value] = Number(qualities[value] ?? 0) + 1;
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
  if (hotWaterLevel !== null) state.fuelCell.lastHotWaterLevel = hotWaterLevel;
  if (sample.fuelCellDataQuality) state.fuelCell.qualities[sample.fuelCellDataQuality] = Number(state.fuelCell.qualities[sample.fuelCellDataQuality] ?? 0) + 1;
  if (sample.fuelCellSourceHost) state.fuelCell.sourceHosts[sample.fuelCellSourceHost] = Number(state.fuelCell.sourceHosts[sample.fuelCellSourceHost] ?? 0) + 1;
  state.rateYenPerKwh = finite(sample.rateYenPerKwh) ?? state.rateYenPerKwh;
  state.rateLabel = sample.rateLabel ?? state.rateLabel;
  return state;
}

function rollupPayload(state) {
  const payload = {
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
  const powerCoverageSeconds = {};
  const intervalAveragePowerW = {};
  for (const [key, metric] of Object.entries(state.powers)) {
    if (metric.weight > 0) {
      payload[key] = metric.weightedSum / metric.weight;
      powerCoverageSeconds[key] = metric.weight;
      intervalAveragePowerW[key] = payload[key];
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
  const circuitPowerW = {};
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

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function normalizeRetentionPolicy(policy = {}, legacyRawTelemetryDays = undefined) {
  const days = (value, fallback) => {
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
  };
  return {
    rawTelemetryDays: days(policy.rawTelemetryDays ?? legacyRawTelemetryDays, 1095),
    intervalAggregatesDays: days(policy.intervalAggregatesDays, null),
    dailyAggregatesDays: days(policy.dailyAggregatesDays, null),
    adaptiveChargingHistoryDays: days(policy.adaptiveChargingHistoryDays, null),
    automationEventDays: days(policy.automationEventDays, null),
    notificationDeliveryDays: days(policy.notificationDeliveryDays, 365),
  };
}

export function createHistoryStore({
  dataDir,
  logger = console,
  maxRawAutoBytes = MAX_RAW_AUTO_BYTES,
} = {}) {
  const databaseFile = path.join(dataDir, "history.sqlite");
  const legacyHistoryFile = path.join(dataDir, "history", "samples.jsonl");
  const legacyForecastFile = path.join(dataDir, "adaptive-charging", "forecast-snapshots.jsonl");
  const legacyWeatherFile = path.join(dataDir, "adaptive-charging", "historical-weather.jsonl");
  let database = null;
  let previousSample = null;
  let metricBaselines = {};
  const rollupStates = new Map();

  const ready = () => database !== null;
  const requireDatabase = () => {
    if (!database) throw new Error("history database is not initialized");
    return database;
  };

  function metadataGet(key, fallback = null) {
    const row = requireDatabase().prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    return row ? parseJson(row.value, fallback) : fallback;
  }

  function metadataSet(key, value) {
    requireDatabase().prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  function createSchema() {
    const db = requireDatabase();
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_file TEXT,
        source_line INTEGER,
        UNIQUE(source_file, source_line)
      );
      CREATE INDEX IF NOT EXISTS samples_timestamp_idx ON samples(timestamp_ms, id);
      CREATE TABLE IF NOT EXISTS rollups (
        resolution TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        bucket_end_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY(resolution, bucket_start_ms)
      );
      CREATE INDEX IF NOT EXISTS rollups_range_idx ON rollups(resolution, bucket_start_ms, bucket_end_ms);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        timestamp_ms INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_category_time_idx ON events(category, timestamp_ms);
      CREATE TABLE IF NOT EXISTS away_periods (
        id TEXT PRIMARY KEY,
        start_ms INTEGER NOT NULL,
        start_at TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        until_at TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS away_periods_range_idx ON away_periods(start_ms, until_ms);
      CREATE TABLE IF NOT EXISTS forecasts (
        fetched_at_ms INTEGER PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weather (
        time_ms INTEGER PRIMARY KEY,
        time TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solar_forecast_daily (
        target_date TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        period_start_ms INTEGER NOT NULL,
        period_end_ms INTEGER NOT NULL,
        raw_predicted_kwh REAL NOT NULL,
        bias_factor REAL NOT NULL,
        predicted_kwh REAL NOT NULL,
        planning_kwh REAL NOT NULL,
        margin_percent REAL NOT NULL,
        calibration_json TEXT,
        actual_kwh REAL,
        actual_coverage_seconds REAL,
        completed_at TEXT,
        PRIMARY KEY(target_date, issued_at_ms)
      );
      CREATE INDEX IF NOT EXISTS solar_forecast_daily_target_idx
        ON solar_forecast_daily(target_date, issued_at_ms);
      CREATE INDEX IF NOT EXISTS solar_forecast_daily_period_idx
        ON solar_forecast_daily(period_end_ms, completed_at);
      CREATE TABLE IF NOT EXISTS gas_tariff_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        billing_month TEXT NOT NULL,
        version INTEGER NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        source_url TEXT,
        source_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(provider, billing_month, version)
      );
      CREATE INDEX IF NOT EXISTS gas_tariff_snapshots_month_idx
        ON gas_tariff_snapshots(provider, billing_month, version DESC);
      CREATE TABLE IF NOT EXISTS gas_tariff_overrides (
        provider TEXT NOT NULL,
        billing_month TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(provider, billing_month)
      );
      CREATE TABLE IF NOT EXISTS fuel_cell_forecasts (
        target_start_ms INTEGER NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        target_start TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actual_kwh REAL,
        completed_at TEXT,
        PRIMARY KEY(target_start_ms, issued_at_ms)
      );
      CREATE INDEX IF NOT EXISTS fuel_cell_forecasts_target_idx
        ON fuel_cell_forecasts(target_start_ms, issued_at_ms);
    `);
    metadataSet("schemaVersion", SCHEMA_VERSION);
    metadataSet("energyCalculationVersion", ENERGY_CALCULATION_VERSION);
  }

  function loadRollupState(resolution, startMs) {
    const key = `${resolution}:${startMs}`;
    if (rollupStates.has(key)) return rollupStates.get(key);
    const row = requireDatabase().prepare(
      "SELECT state_json FROM rollups WHERE resolution = ? AND bucket_start_ms = ?",
    ).get(resolution, startMs);
    const state = row ? parseJson(row.state_json) : emptyRollupState(startMs, resolution);
    rollupStates.set(key, state);
    return state;
  }

  function persistRollup(state) {
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

  function updateRollups(sample) {
    const timeMs = timestampMs(sample.timestamp);
    if (timeMs === null) return;
    for (const resolution of ["interval", "daily"]) {
      const startMs = localBucketStart(timeMs, resolution);
      const state = loadRollupState(resolution, startMs);
      addRollupSample(state, sample);
      persistRollup(state);
    }
  }

  function insertSample(sample, { sourceFile = null, sourceLine = null } = {}) {
    const timeMs = timestampMs(sample?.timestamp);
    if (timeMs === null) return { inserted: false, sample: null };
    const compact = compactHistorySample(sample);
    const interpreted = interpretHistorySample(compact, previousSample, { metricBaselines });
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO samples(timestamp_ms, timestamp, payload_json, source_file, source_line)
      VALUES (?, ?, ?, ?, ?)
    `).run(timeMs, compact.timestamp, JSON.stringify(compact), sourceFile, sourceLine);
    if (Number(result.changes) > 0) {
      updateRollups(interpreted);
      previousSample = compact;
      updateMetricBaselines(metricBaselines, compact);
      return { inserted: true, sample: interpreted };
    }
    return { inserted: false, sample: interpreted };
  }

  function appendSample(sample) {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = insertSample(sample);
      db.exec("COMMIT");
      return result.sample;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function latestRawSample() {
    const row = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
    ).get();
    return row ? parseJson(row.payload_json) : null;
  }

  function recentMetricBaselines() {
    const rows = requireDatabase().prepare(
      "SELECT payload_json FROM samples ORDER BY timestamp_ms DESC, id DESC LIMIT 5000",
    ).all().reverse();
    const baselines = {};
    for (const row of rows) updateMetricBaselines(baselines, parseJson(row.payload_json, {}));
    return baselines;
  }

  async function migrateJsonLines(file, metadataKey, consume) {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") return { imported: 0, skipped: 0, missing: true };
      throw error;
    }
    const marker = metadataGet(metadataKey, { line: 0, size: 0, complete: false });
    if (marker.complete && Number(marker.size) === Number(fileStat.size)) {
      return { imported: 0, skipped: 0, complete: true };
    }
    if (marker.complete && Number(fileStat.size) < Number(marker.size)) {
      logger.warn?.(`history: ${file} is smaller than its completed migration marker; leaving it untouched`);
      return { imported: 0, skipped: 0, complete: true, truncated: true };
    }
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let imported = 0;
    let skipped = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const db = requireDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of batch) {
          if (consume(item.value, item.line)) imported += 1;
        }
        metadataSet(metadataKey, { line: batch.at(-1).line, size: fileStat.size, complete: false });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      batch = [];
    };
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (lineNumber <= Number(marker.line ?? 0) || !line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch (error) {
          skipped += 1;
          if (skipped <= 20) {
            logger.warn?.(`history: failed to parse ${file}:line ${lineNumber}: ${error.message}; JSON: ${line.slice(0, 2000)}`);
          }
          continue;
        }
        if (!value || typeof value !== "object") {
          skipped += 1;
          if (skipped <= 20) logger.warn?.(`history: ignored non-object ${file}:line ${lineNumber}; JSON: ${line.slice(0, 2000)}`);
          continue;
        }
        batch.push({ line: lineNumber, value });
        if (batch.length >= 1000) flush();
      }
      flush();
      metadataSet(metadataKey, {
        line: lineNumber,
        size: fileStat.size,
        complete: true,
        completedAt: new Date().toISOString(),
      });
    } finally {
      lines.close();
      if (!stream.destroyed) stream.destroy();
    }
    return { imported, skipped, complete: true };
  }

  async function migrateLegacyHistory() {
    previousSample = latestRawSample();
    metricBaselines = recentMetricBaselines();
    const result = await migrateJsonLines(
      legacyHistoryFile,
      "migration:history-jsonl-v1",
      (sample, line) => insertSample(sample, { sourceFile: "history/samples.jsonl", sourceLine: line }).inserted,
    );
    if (result.imported || result.skipped) {
      logger.log?.(`history: imported ${result.imported} legacy samples into SQLite${result.skipped ? `; skipped ${result.skipped} invalid records` : ""}`);
    }
    previousSample = latestRawSample();
    metricBaselines = recentMetricBaselines();
    return result;
  }

  function recordForecast(forecast) {
    const fetchedAt = forecast?.fetchedAt ?? new Date().toISOString();
    const timeMs = timestampMs(fetchedAt);
    if (timeMs === null) return false;
    requireDatabase().prepare(`
      INSERT INTO forecasts(fetched_at_ms, fetched_at, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(fetched_at_ms) DO UPDATE SET payload_json = excluded.payload_json
    `).run(timeMs, fetchedAt, JSON.stringify(forecast));
    return true;
  }

  function recordSolarForecastIssues(issues = []) {
    const statement = requireDatabase().prepare(`
      INSERT INTO solar_forecast_daily(
        target_date, issued_at_ms, issued_at, period_start_ms, period_end_ms,
        raw_predicted_kwh, bias_factor, predicted_kwh, planning_kwh,
        margin_percent, calibration_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_date, issued_at_ms) DO UPDATE SET
        period_start_ms = excluded.period_start_ms,
        period_end_ms = excluded.period_end_ms,
        raw_predicted_kwh = excluded.raw_predicted_kwh,
        bias_factor = excluded.bias_factor,
        predicted_kwh = excluded.predicted_kwh,
        planning_kwh = excluded.planning_kwh,
        margin_percent = excluded.margin_percent,
        calibration_json = excluded.calibration_json
    `);
    let recorded = 0;
    for (const issue of issues) {
      const issuedAt = issue?.issuedAt;
      const issuedAtMs = timestampMs(issuedAt);
      const periodStartMs = timestampMs(issue?.periodStart);
      const periodEndMs = timestampMs(issue?.periodEnd);
      const values = [
        finite(issue?.rawPredictedKwh),
        finite(issue?.biasFactor),
        finite(issue?.predictedKwh),
        finite(issue?.planningKwh),
        finite(issue?.marginPercent),
      ];
      if (!issue?.targetDate || issuedAtMs === null || periodStartMs === null || periodEndMs === null
        || periodEndMs <= periodStartMs || values.some((value) => value === null)) continue;
      statement.run(
        issue.targetDate,
        issuedAtMs,
        issuedAt,
        periodStartMs,
        periodEndMs,
        ...values,
        issue.calibration ? JSON.stringify(issue.calibration) : null,
      );
      recorded += 1;
    }
    return recorded;
  }

  function settleSolarForecastOutcomes(now = new Date()) {
    const nowMs = now instanceof Date ? now.getTime() : timestampMs(now);
    if (!Number.isFinite(nowMs)) return 0;
    const pending = requireDatabase().prepare(`
      SELECT DISTINCT target_date, period_start_ms, period_end_ms
      FROM solar_forecast_daily
      WHERE completed_at IS NULL AND period_end_ms <= ?
      ORDER BY period_start_ms
    `).all(nowMs);
    const update = requireDatabase().prepare(`
      UPDATE solar_forecast_daily
      SET actual_kwh = ?, actual_coverage_seconds = ?, completed_at = ?
      WHERE target_date = ? AND completed_at IS NULL
    `);
    let settled = 0;
    for (const day of pending) {
      const rows = requireDatabase().prepare(`
        SELECT payload_json FROM rollups
        WHERE resolution = 'daily' AND bucket_start_ms >= ? AND bucket_end_ms <= ?
        ORDER BY bucket_start_ms
      `).all(day.period_start_ms, day.period_end_ms);
      let actualKwh = 0;
      let coverageSeconds = 0;
      let hasActual = false;
      for (const row of rows) {
        const payload = parseJson(row.payload_json, {});
        const actual = finite(payload.solarGenerationKwh);
        const coverage = finite(payload.coverageSeconds?.solarGenerationKwh);
        if (actual !== null) {
          actualKwh += actual;
          hasActual = true;
        }
        if (coverage !== null) coverageSeconds += coverage;
      }
      const requiredCoverage = (Number(day.period_end_ms) - Number(day.period_start_ms))
        / 1000 * SOLAR_FORECAST_MIN_COVERAGE_RATIO;
      if (!hasActual || coverageSeconds < requiredCoverage) continue;
      const result = update.run(
        actualKwh,
        coverageSeconds,
        (now instanceof Date ? now : new Date(nowMs)).toISOString(),
        day.target_date,
      );
      settled += Number(result.changes);
    }
    return settled;
  }

  function canonicalSolarForecastRows({ completedOnly = true } = {}) {
    const where = completedOnly ? "WHERE completed_at IS NOT NULL" : "";
    const rows = requireDatabase().prepare(`
      SELECT * FROM solar_forecast_daily ${where}
      ORDER BY target_date, issued_at_ms
    `).all();
    const grouped = new Map();
    for (const row of rows) {
      const candidates = grouped.get(row.target_date) ?? [];
      candidates.push(row);
      grouped.set(row.target_date, candidates);
    }
    return [...grouped.values()].map((candidates) => {
      const beforeStart = candidates.filter((row) => row.issued_at_ms <= row.period_start_ms);
      return beforeStart.length ? beforeStart.at(-1) : candidates[0];
    });
  }

  function solarForecastOutcomes(limit = 30) {
    const rows = canonicalSolarForecastRows();
    return rows.slice(-Math.max(1, Math.round(limit))).map((row) => {
      const predicted = Number(row.predicted_kwh);
      const actual = Number(row.actual_kwh);
      const errorKwh = actual - predicted;
      return {
        targetDate: row.target_date,
        issuedAt: row.issued_at,
        leadHours: (Number(row.period_start_ms) - Number(row.issued_at_ms)) / 3_600_000,
        forecastBasis: row.issued_at_ms <= row.period_start_ms ? "day-ahead" : "same-day",
        rawPredictedKwh: Number(row.raw_predicted_kwh),
        biasFactor: Number(row.bias_factor),
        predictedKwh: predicted,
        planningKwh: Number(row.planning_kwh),
        marginPercent: Number(row.margin_percent),
        actualKwh: actual,
        errorKwh,
        errorPercent: predicted > 0.05 ? errorKwh / predicted * 100 : null,
        actualCoverageSeconds: Number(row.actual_coverage_seconds),
        completedAt: row.completed_at,
      };
    });
  }

  function solarForecastAccuracy(limit = 30) {
    const outcomes = solarForecastOutcomes(limit);
    const ratios = outcomes
      .filter((outcome) => outcome.rawPredictedKwh > 0.05 && outcome.actualKwh >= 0)
      .map((outcome) => outcome.actualKwh / outcome.rawPredictedKwh)
      .filter(Number.isFinite);
    const measuredFactor = median(ratios);
    const learned = ratios.length >= 5 && Number.isFinite(measuredFactor);
    const errors = outcomes
      .map((outcome) => outcome.errorPercent)
      .filter(Number.isFinite)
      .map(Math.abs);
    return {
      learned,
      sampleCount: ratios.length,
      measuredFactor,
      factor: learned ? Math.max(0.5, Math.min(1.5, measuredFactor)) : 1,
      meanAbsolutePercentageError: errors.length
        ? errors.reduce((sum, value) => sum + value, 0) / errors.length
        : null,
      outcomes,
    };
  }

  function insertWeather(records = []) {
    const statement = requireDatabase().prepare(`
      INSERT INTO weather(time_ms, time, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(time_ms) DO UPDATE SET payload_json = excluded.payload_json
    `);
    let inserted = 0;
    for (const record of records) {
      const time = record.time ?? record.timestamp;
      const timeMs = timestampMs(time);
      if (timeMs === null) continue;
      statement.run(timeMs, time, JSON.stringify(record));
      inserted += 1;
    }
    return inserted;
  }

  function recordWeather(records = []) {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = insertWeather(records);
      db.exec("COMMIT");
      return inserted;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function recordFuelCellForecasts(entries = [], issuedAt = new Date().toISOString()) {
    const issuedAtMs = timestampMs(issuedAt);
    if (issuedAtMs === null) return 0;
    const statement = requireDatabase().prepare(`
      INSERT INTO fuel_cell_forecasts(target_start_ms, issued_at_ms, target_start, issued_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(target_start_ms, issued_at_ms) DO UPDATE SET payload_json = excluded.payload_json
    `);
    let recorded = 0;
    for (const entry of entries) {
      const targetStartMs = timestampMs(entry.start);
      const targetEndMs = timestampMs(entry.end);
      if (targetStartMs === null || targetEndMs === null || targetEndMs <= targetStartMs) continue;
      statement.run(targetStartMs, issuedAtMs, entry.start, issuedAt, JSON.stringify(entry));
      recorded += 1;
    }
    return recorded;
  }

  function settleFuelCellForecastOutcomes(now = new Date()) {
    const nowMs = timestampMs(now);
    if (nowMs === null) return 0;
    const rows = requireDatabase().prepare(`
      SELECT target_start_ms, issued_at_ms, payload_json FROM fuel_cell_forecasts
      WHERE completed_at IS NULL ORDER BY target_start_ms
    `).all();
    const update = requireDatabase().prepare(`
      UPDATE fuel_cell_forecasts SET actual_kwh = ?, completed_at = ?
      WHERE target_start_ms = ? AND issued_at_ms = ?
    `);
    let settled = 0;
    for (const row of rows) {
      const payload = parseJson(row.payload_json, {});
      const endMs = timestampMs(payload.end);
      if (endMs === null || endMs > nowMs) continue;
      const samples = requireDatabase().prepare(`
        SELECT payload_json FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ? ORDER BY timestamp_ms, id
      `).all(row.target_start_ms, endMs).map((sample) => parseJson(sample.payload_json, {}));
      let actualKwh = 0;
      let measured = false;
      for (let index = 0; index < samples.length; index += 1) {
        const value = intervalEnergy(samples[index], samples[index - 1], "fuelCellKwh", "fuelCellPowerW");
        if (value !== null) { actualKwh += value; measured = true; }
      }
      if (!measured) continue;
      update.run(actualKwh, (now instanceof Date ? now : new Date(nowMs)).toISOString(), row.target_start_ms, row.issued_at_ms);
      settled += 1;
    }
    return settled;
  }

  function fuelCellForecastOutcomes(limit = 100) {
    return requireDatabase().prepare(`
      SELECT target_start, issued_at, payload_json, actual_kwh, completed_at
      FROM fuel_cell_forecasts WHERE completed_at IS NOT NULL
      ORDER BY target_start_ms DESC, issued_at_ms DESC LIMIT ?
    `).all(Math.max(1, Math.round(limit))).map((row) => ({
      ...parseJson(row.payload_json, {}),
      targetStart: row.target_start,
      issuedAt: row.issued_at,
      actualKwh: finite(row.actual_kwh),
      completedAt: row.completed_at,
    }));
  }

  function gasTariffSnapshots({ provider = "tokyo-gas", billingMonth = null } = {}) {
    const rows = billingMonth
      ? requireDatabase().prepare(`
          SELECT provider, billing_month, version, fetched_at, source_url, source_hash, payload_json
          FROM gas_tariff_snapshots WHERE provider = ? AND billing_month = ? ORDER BY version DESC
        `).all(provider, billingMonth)
      : requireDatabase().prepare(`
          SELECT provider, billing_month, version, fetched_at, source_url, source_hash, payload_json
          FROM gas_tariff_snapshots WHERE provider = ? ORDER BY billing_month DESC, version DESC
        `).all(provider);
    return rows.map((row) => ({
      provider: row.provider,
      billingMonth: row.billing_month,
      version: row.version,
      fetchedAt: row.fetched_at,
      sourceUrl: row.source_url,
      sourceHash: row.source_hash,
      ...parseJson(row.payload_json, {}),
    }));
  }

  function recordGasTariffSnapshot(snapshot) {
    const existing = requireDatabase().prepare(`
      SELECT version, payload_json, fetched_at, source_url FROM gas_tariff_snapshots
      WHERE provider = ? AND billing_month = ? AND source_hash = ? ORDER BY version DESC LIMIT 1
    `).get(snapshot.provider, snapshot.billingMonth, snapshot.sourceHash);
    if (existing) {
      return { unchanged: true, provider: snapshot.provider, billingMonth: snapshot.billingMonth, version: existing.version, ...parseJson(existing.payload_json, {}) };
    }
    const versionRow = requireDatabase().prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version FROM gas_tariff_snapshots
      WHERE provider = ? AND billing_month = ?
    `).get(snapshot.provider, snapshot.billingMonth);
    const version = Number(versionRow.version);
    const fetchedAt = snapshot.fetchedAt ?? new Date().toISOString();
    requireDatabase().prepare(`
      INSERT INTO gas_tariff_snapshots(provider, billing_month, version, fetched_at_ms, fetched_at, source_url, source_hash, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.provider,
      snapshot.billingMonth,
      version,
      new Date(fetchedAt).getTime(),
      fetchedAt,
      snapshot.sourceUrl ?? null,
      snapshot.sourceHash,
      JSON.stringify(snapshot.payload),
    );
    return { ...snapshot.payload, provider: snapshot.provider, billingMonth: snapshot.billingMonth, version, fetchedAt, sourceUrl: snapshot.sourceUrl ?? null, sourceHash: snapshot.sourceHash };
  }

  function gasTariffOverride(provider = "tokyo-gas", billingMonth) {
    const row = requireDatabase().prepare(`
      SELECT updated_at, payload_json FROM gas_tariff_overrides WHERE provider = ? AND billing_month = ?
    `).get(provider, billingMonth);
    return row ? { provider, billingMonth, updatedAt: row.updated_at, ...parseJson(row.payload_json, {}) } : null;
  }

  function setGasTariffOverride(provider, billingMonth, payload) {
    const updatedAt = new Date().toISOString();
    requireDatabase().prepare(`
      INSERT INTO gas_tariff_overrides(provider, billing_month, updated_at_ms, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, billing_month) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `).run(provider, billingMonth, Date.now(), updatedAt, JSON.stringify(payload));
    return { provider, billingMonth, updatedAt, ...payload };
  }

  function deleteGasTariffOverride(provider, billingMonth) {
    return Number(requireDatabase().prepare(
      "DELETE FROM gas_tariff_overrides WHERE provider = ? AND billing_month = ?",
    ).run(provider, billingMonth).changes) > 0;
  }

  async function migrateAdaptiveChargingContext() {
    await migrateJsonLines(legacyForecastFile, "migration:forecast-jsonl-v1", (forecast) => recordForecast(forecast));
    await migrateJsonLines(legacyWeatherFile, "migration:weather-jsonl-v1", (record) => {
      return insertWeather([record]) > 0;
    });
  }

  async function initialize() {
    if (database) return;
    await mkdir(dataDir, { recursive: true });
    let existing = true;
    try {
      await stat(databaseFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      existing = false;
    }
    database = new DatabaseSync(databaseFile);
    if (!existing) {
      createSchema();
    } else {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
      const row = table ? database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() : null;
      const version = row ? parseJson(row.value) : null;
      if (version !== SCHEMA_VERSION) {
        database.close();
        database = null;
        throw new Error(`history database schema ${version ?? "unknown"} is not ready for application schema ${SCHEMA_VERSION}`);
      }
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      await rm(`${databaseFile}.schema-v6.rollback`, { force: true });
    }
    await migrateLegacyHistory();
    await migrateAdaptiveChargingContext();
    previousSample = latestRawSample();
    metricBaselines = recentMetricBaselines();
  }

  function interpretedRawPayloads(startMs, endMs) {
    const contextRows = requireDatabase().prepare(`
      SELECT payload_json FROM samples
      WHERE timestamp_ms < ?
      ORDER BY timestamp_ms DESC, id DESC LIMIT 5000
    `).all(startMs).reverse();
    const metricContext = {};
    let previousRaw = null;
    for (const row of contextRows) {
      const raw = compactHistorySample(parseJson(row.payload_json, {}));
      if (timestampMs(raw.timestamp) === null) continue;
      previousRaw = raw;
      updateMetricBaselines(metricContext, raw);
    }
    const result = [];
    for (const row of rawRows(startMs, endMs)) {
      const raw = compactHistorySample(parseJson(row.payload_json, {}));
      if (timestampMs(raw.timestamp) === null) continue;
      const baselineIsOutsideRange = previousRaw && timestampMs(previousRaw.timestamp) < startMs;
      const interpreted = interpretHistorySample(
        raw,
        baselineIsOutsideRange ? null : previousRaw,
        { metricBaselines: baselineIsOutsideRange ? null : metricContext },
      );
      result.push(interpreted);
      previousRaw = raw;
      updateMetricBaselines(metricContext, raw);
    }
    return result;
  }

  function rollupRowsToPayloads(rows) {
    return rows.map((row) => {
      const payload = parseJson(row.payload_json);
      if (!payload) return null;
      const state = parseJson(row.state_json, {});
      const powerCoverageSeconds = { ...(payload.powerCoverageSeconds ?? {}) };
      const intervalAveragePowerW = { ...(payload.intervalAveragePowerW ?? {}) };
      for (const [key, metric] of Object.entries(state.powers ?? {})) {
        const weight = finite(metric?.weight);
        const weightedSum = finite(metric?.weightedSum);
        if (weight === null || weight <= 0 || weightedSum === null) continue;
        powerCoverageSeconds[key] = weight;
        intervalAveragePowerW[key] = weightedSum / weight;
      }
      if (Object.keys(powerCoverageSeconds).length) payload.powerCoverageSeconds = powerCoverageSeconds;
      if (Object.keys(intervalAveragePowerW).length) payload.intervalAveragePowerW = intervalAveragePowerW;
      return payload;
    }).filter(Boolean);
  }

  function rawRows(startMs, endMs) {
    return requireDatabase().prepare(`
      SELECT payload_json FROM samples
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms, id
    `).all(startMs, endMs);
  }

  function rollupRows(startMs, endMs, resolution) {
    return requireDatabase().prepare(`
      SELECT payload_json, state_json FROM rollups
      WHERE resolution = ? AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms
    `).all(resolution, startMs, endMs);
  }

  function rawRangeStats(startMs, endMs) {
    const row = requireDatabase().prepare(`
      SELECT COUNT(*) AS count,
        MIN(timestamp_ms) AS earliest,
        MAX(timestamp_ms) AS latest
      FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).get(startMs, endMs);
    return {
      count: Number(row?.count ?? 0),
      earliest: finite(row?.earliest),
      latest: finite(row?.latest),
    };
  }

  function rawRangePayloadBytes(startMs, endMs) {
    const row = requireDatabase().prepare(`
      SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS payload_bytes
      FROM samples WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).get(startMs, endMs);
    return Number(row?.payload_bytes ?? 0);
  }

  function intervalRangeBounds(startMs, endMs) {
    const firstRow = requireDatabase().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms ASC LIMIT 1
    `).get(startMs, endMs);
    const lastRow = requireDatabase().prepare(`
      SELECT state_json FROM rollups
      WHERE resolution = 'interval' AND bucket_end_ms > ? AND bucket_start_ms <= ?
      ORDER BY bucket_start_ms DESC LIMIT 1
    `).get(startMs, endMs);
    if (!firstRow || !lastRow) return { earliest: null, latest: null };
    const first = parseJson(firstRow.state_json, {});
    const last = parseJson(lastRow.state_json, {});
    return {
      earliest: timestampMs(first.firstTimestamp),
      latest: timestampMs(last.lastTimestamp),
    };
  }

  function detailedAvailableRows(startMs, endMs, earliestRaw) {
    const olderRows = requireDatabase().prepare(`
      SELECT payload_json, state_json, bucket_end_ms FROM rollups
      WHERE resolution = 'interval'
        AND bucket_end_ms > ?
        AND bucket_start_ms <= ?
        AND bucket_start_ms < ?
      ORDER BY bucket_start_ms
    `).all(startMs, endMs, earliestRaw);
    const retainedRollups = [];
    for (const row of olderRows) {
      const state = parseJson(row.state_json, {});
      const lastTimestamp = timestampMs(state.lastTimestamp);
      const endsBeforeRaw = lastTimestamp !== null
        ? lastTimestamp < earliestRaw
        : Number(row.bucket_end_ms) <= earliestRaw;
      if (!endsBeforeRaw) continue;
      retainedRollups.push(row);
    }
    return [
      ...rollupRowsToPayloads(retainedRollups),
      ...interpretedRawPayloads(earliestRaw, endMs),
    ];
  }

  function querySamples(startMs, endMs, { resolution = "auto" } = {}) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
    if (resolution === "raw") return interpretedRawPayloads(startMs, endMs);
    if (resolution === "interval" || resolution === "daily") {
      return rollupRowsToPayloads(rollupRows(startMs, endMs, resolution));
    }
    const rawStats = rawRangeStats(startMs, endMs);
    if (rawStats.count === 0) {
      return rollupRowsToPayloads(rollupRows(startMs, endMs, "interval"));
    }

    const intervalBounds = intervalRangeBounds(startMs, endMs);
    const intervalCoversRaw =
      intervalBounds.earliest !== null &&
      intervalBounds.latest !== null &&
      intervalBounds.earliest <= rawStats.earliest &&
      intervalBounds.latest >= rawStats.latest;
    const rawResponseTooLarge = rawStats.count > MAX_RAW_AUTO_SAMPLES
      || rawRangePayloadBytes(startMs, endMs) > maxRawAutoBytes;
    const preserveRawDetail = endMs - startMs <= AUTO_RAW_DETAIL_WINDOW_MS;
    if (!preserveRawDetail && rawResponseTooLarge && intervalCoversRaw) {
      return rollupRowsToPayloads(rollupRows(startMs, endMs, "interval"));
    }
    return detailedAvailableRows(startMs, endMs, rawStats.earliest);
  }

  function recordEvent({ eventKey, at, category, type = "event", message = null, payload = null }) {
    const timestamp = at ?? new Date().toISOString();
    const timeMs = timestampMs(timestamp);
    if (timeMs === null || !eventKey) return false;
    const result = requireDatabase().prepare(`
      INSERT OR IGNORE INTO events(event_key, timestamp_ms, timestamp, category, type, message, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventKey, timeMs, timestamp, category, type, message, payload === null ? null : JSON.stringify(payload));
    return Number(result.changes) > 0;
  }

  function eventsBetween(category, startMs, endMs, types = []) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
    const normalizedTypes = Array.isArray(types) ? types.filter(Boolean).map(String) : [];
    const typeClause = normalizedTypes.length
      ? ` AND type IN (${normalizedTypes.map(() => "?").join(", ")})`
      : "";
    return requireDatabase().prepare(`
      SELECT timestamp, type, message, payload_json FROM events
      WHERE category = ? AND timestamp_ms >= ? AND timestamp_ms <= ?${typeClause}
      ORDER BY timestamp_ms, id
    `).all(category, startMs, endMs, ...normalizedTypes).map((row) => ({
      at: row.timestamp,
      type: row.type,
      message: row.message,
      payload: row.payload_json ? parseJson(row.payload_json) : null,
    }));
  }

  function tagEventsBefore(category, before, fields = {}) {
    const beforeMs = timestampMs(before);
    if (beforeMs === null) return 0;
    const rows = requireDatabase().prepare(`
      SELECT id, payload_json FROM events WHERE category = ? AND timestamp_ms < ?
    `).all(category, beforeMs);
    const update = requireDatabase().prepare("UPDATE events SET payload_json = ? WHERE id = ?");
    let changed = 0;
    requireDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const payload = row.payload_json ? parseJson(row.payload_json, {}) : {};
        if (Object.keys(fields).every((key) => payload?.[key] !== undefined)) continue;
        update.run(JSON.stringify({ ...payload, ...fields }), row.id);
        changed += 1;
      }
      requireDatabase().exec("COMMIT");
    } catch (error) {
      requireDatabase().exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  function awayPeriodView(row, nowMs = Date.now()) {
    if (!row) return null;
    const status = nowMs < row.start_ms
      ? "scheduled"
      : nowMs < row.until_ms
        ? "active"
        : "completed";
    return {
      id: row.id,
      from: row.start_at,
      until: row.until_at,
      source: row.source,
      status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function awayPeriod(id, nowMs = Date.now()) {
    return awayPeriodView(requireDatabase().prepare(`
      SELECT * FROM away_periods WHERE id = ?
    `).get(id), nowMs);
  }

  function awayPeriods({ includeCompleted = true, startMs = null, endMs = null, nowMs = Date.now() } = {}) {
    const rows = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? requireDatabase().prepare(`
          SELECT * FROM away_periods
          WHERE start_ms < ? AND until_ms > ?
          ORDER BY start_ms, id
        `).all(endMs, startMs)
      : requireDatabase().prepare(`
          SELECT * FROM away_periods ORDER BY start_ms, id
        `).all();
    return rows
      .map((row) => awayPeriodView(row, nowMs))
      .filter((period) => includeCompleted || period.status !== "completed");
  }

  function createAwayPeriod(period) {
    requireDatabase().prepare(`
      INSERT INTO away_periods(id, start_ms, start_at, until_ms, until_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      period.id,
      timestampMs(period.from),
      period.from,
      timestampMs(period.until),
      period.until,
      period.source,
      period.createdAt,
      period.updatedAt,
    );
    return awayPeriod(period.id);
  }

  function updateAwayPeriod(period) {
    const result = requireDatabase().prepare(`
      UPDATE away_periods
      SET start_ms = ?, start_at = ?, until_ms = ?, until_at = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      timestampMs(period.from),
      period.from,
      timestampMs(period.until),
      period.until,
      period.source,
      period.updatedAt,
      period.id,
    );
    return Number(result.changes) > 0 ? awayPeriod(period.id) : null;
  }

  function deleteAwayPeriod(id) {
    return Number(requireDatabase().prepare("DELETE FROM away_periods WHERE id = ?").run(id).changes) > 0;
  }

  function historicalWeather() {
    return requireDatabase().prepare("SELECT payload_json FROM weather ORDER BY time_ms").all()
      .map((row) => parseJson(row.payload_json)).filter(Boolean);
  }

  async function databaseFileSizes() {
    const size = async (file) => {
      try {
        return (await stat(file)).size;
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    };
    const [mainBytes, walBytes, shmBytes] = await Promise.all([
      size(databaseFile),
      size(`${databaseFile}-wal`),
      size(`${databaseFile}-shm`),
    ]);
    return { mainBytes, walBytes, shmBytes, totalBytes: mainBytes + walBytes + shmBytes };
  }

  async function stats() {
    const db = requireDatabase();
    const raw = db.prepare(`
      SELECT COUNT(*) AS sampleCount, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM samples
    `).get();
    const rollups = Object.fromEntries(db.prepare(`
      SELECT resolution, COUNT(*) AS count FROM rollups GROUP BY resolution
    `).all().map((row) => [row.resolution, Number(row.count)]));
    const events = Object.fromEntries(db.prepare(`
      SELECT category, COUNT(*) AS count FROM events GROUP BY category
    `).all().map((row) => [row.category, Number(row.count)]));
    const earliestMs = timestampMs(raw.earliest);
    const latestMs = timestampMs(raw.latest);
    const daysRecorded = earliestMs !== null && latestMs !== null
      ? Math.max(0, (latestMs - earliestMs) / 86_400_000)
      : 0;
    const payload = db.prepare(`
      SELECT COALESCE(AVG(LENGTH(payload_json)), 0) AS average_bytes
      FROM (
        SELECT payload_json FROM samples ORDER BY id DESC LIMIT 1000
      )
    `).get();
    const fileSizes = await databaseFileSizes();
    const averageSampleBytes = Number(payload.average_bytes ?? 0);
    const samplesPerDay = daysRecorded > 0 ? Number(raw.sampleCount) / daysRecorded : 0;
    return {
      sizeBytes: fileSizes.totalBytes,
      fileSizes,
      sampleCount: Number(raw.sampleCount),
      averageSampleBytes,
      estimatedDailyGrowthBytes: Math.round(averageSampleBytes * samplesPerDay),
      earliest: raw.earliest ?? null,
      latest: raw.latest ?? null,
      daysRecorded,
      rollups: {
        interval: rollups.interval ?? 0,
        daily: rollups.daily ?? 0,
      },
      events,
      forecasts: Number(db.prepare("SELECT COUNT(*) AS count FROM forecasts").get().count),
      solarForecastIssues: Number(db.prepare("SELECT COUNT(*) AS count FROM solar_forecast_daily").get().count),
      solarForecastOutcomes: Number(db.prepare("SELECT COUNT(*) AS count FROM solar_forecast_daily WHERE completed_at IS NOT NULL").get().count),
      fuelCellForecastIssues: Number(db.prepare("SELECT COUNT(*) AS count FROM fuel_cell_forecasts").get().count),
      fuelCellForecastOutcomes: Number(db.prepare("SELECT COUNT(*) AS count FROM fuel_cell_forecasts WHERE completed_at IS NOT NULL").get().count),
      gasTariffSnapshots: Number(db.prepare("SELECT COUNT(*) AS count FROM gas_tariff_snapshots").get().count),
      gasTariffOverrides: Number(db.prepare("SELECT COUNT(*) AS count FROM gas_tariff_overrides").get().count),
      weatherRecords: Number(db.prepare("SELECT COUNT(*) AS count FROM weather").get().count),
      schemaVersion: metadataGet("schemaVersion", null),
      energyCalculationVersion: metadataGet("energyCalculationVersion", null),
      lastCompaction: metadataGet("compaction:schema-v7", null),
      databaseFile,
      legacyHistoryFile,
      migration: metadataGet("migration:history-jsonl-v1", null),
      adaptiveChargingMigrations: {
        forecasts: metadataGet("migration:forecast-jsonl-v1", null),
        weather: metadataGet("migration:weather-jsonl-v1", null),
      },
    };
  }

  async function deleteInChunks(sql, parameters = []) {
    const statement = requireDatabase().prepare(sql);
    let deleted = 0;
    while (true) {
      const result = statement.run(...parameters);
      const changes = Number(result.changes);
      deleted += changes;
      if (changes < 10_000) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return deleted;
  }

  async function applyRetention(policyInput = {}, now = new Date()) {
    const policy = normalizeRetentionPolicy(policyInput);
    const before = await stats();
    const cutoff = (days) => now.getTime() - days * 86_400_000;
    const deleted = {
      rawSamples: await deleteInChunks(`
        DELETE FROM samples WHERE id IN (
          SELECT id FROM samples WHERE timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000
        )
      `, [cutoff(policy.rawTelemetryDays)]),
      intervalRollups: 0,
      dailyRollups: 0,
      adaptiveChargingEvents: 0,
      automationEvents: 0,
      notificationEvents: 0,
    };
    if (policy.intervalAggregatesDays !== null) {
      deleted.intervalRollups = await deleteInChunks(`
        DELETE FROM rollups WHERE rowid IN (
          SELECT rowid FROM rollups WHERE resolution = 'interval' AND bucket_end_ms < ? LIMIT 10000
        )
      `, [cutoff(policy.intervalAggregatesDays)]);
    }
    if (policy.dailyAggregatesDays !== null) {
      deleted.dailyRollups = await deleteInChunks(`
        DELETE FROM rollups WHERE rowid IN (
          SELECT rowid FROM rollups WHERE resolution = 'daily' AND bucket_end_ms < ? LIMIT 10000
        )
      `, [cutoff(policy.dailyAggregatesDays)]);
    }
    const eventRetention = [
      ["adaptiveCharging", policy.adaptiveChargingHistoryDays, "adaptiveChargingEvents"],
      ["automation", policy.automationEventDays, "automationEvents"],
      ["notification", policy.notificationDeliveryDays, "notificationEvents"],
    ];
    for (const [category, days, resultKey] of eventRetention) {
      if (days === null) continue;
      deleted[resultKey] = await deleteInChunks(`
        DELETE FROM events WHERE id IN (
          SELECT id FROM events WHERE category = ? AND timestamp_ms < ? ORDER BY timestamp_ms LIMIT 10000
        )
      `, [category, cutoff(days)]);
    }
    if (policy.adaptiveChargingHistoryDays !== null) {
      await deleteInChunks(`
        DELETE FROM forecasts WHERE fetched_at_ms IN (
          SELECT fetched_at_ms FROM forecasts WHERE fetched_at_ms < ? ORDER BY fetched_at_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
      await deleteInChunks(`
        DELETE FROM weather WHERE time_ms IN (
          SELECT time_ms FROM weather WHERE time_ms < ? ORDER BY time_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
      await deleteInChunks(`
        DELETE FROM solar_forecast_daily WHERE rowid IN (
          SELECT rowid FROM solar_forecast_daily WHERE period_end_ms < ? ORDER BY period_end_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
      await deleteInChunks(`
        DELETE FROM fuel_cell_forecasts WHERE rowid IN (
          SELECT rowid FROM fuel_cell_forecasts WHERE target_start_ms < ? ORDER BY target_start_ms LIMIT 10000
        )
      `, [cutoff(policy.adaptiveChargingHistoryDays)]);
    }
    requireDatabase().exec("PRAGMA wal_checkpoint(PASSIVE)");
    const after = await stats();
    return { policy, before, after, deleted };
  }

  function close() {
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
    historicalWeather,
    initialize,
    isReady: ready,
    latestSample: latestRawSample,
    querySamples,
    recordEvent,
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

export function historyDatabaseFile(dataDir) {
  return path.join(dataDir, "history.sqlite");
}

export async function inspectHistoryDatabase(dataDir) {
  const databaseFile = historyDatabaseFile(dataDir);
  try {
    const fileStat = await stat(databaseFile);
    let walBytes = 0;
    try {
      walBytes = (await stat(`${databaseFile}-wal`)).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const databaseBytes = fileStat.size + walBytes;
    if (fileStat.size === 0) return { state: "invalid", databaseFile, databaseBytes: 0, error: "Database file is empty" };
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const metadata = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
      if (!metadata) return { state: "invalid", databaseFile, databaseBytes, error: "Schema metadata is missing" };
      const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get();
      const version = row ? parseJson(row.value) : null;
      if (!Number.isInteger(version) || version < 1) {
        return { state: "invalid", databaseFile, databaseBytes, error: "Schema version is missing or invalid" };
      }
      return {
        state: version === SCHEMA_VERSION ? "current" : version < SCHEMA_VERSION ? "upgrade" : "newer",
        databaseFile,
        databaseBytes,
        version,
        targetVersion: SCHEMA_VERSION,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return { state: "new", databaseFile, databaseBytes: 0, version: null, targetVersion: SCHEMA_VERSION };
    }
    return { state: "invalid", databaseFile, databaseBytes: null, error: error.message, targetVersion: SCHEMA_VERSION };
  }
}

function rebuildDerivedEnergy(database) {
  const updateSample = database.prepare("UPDATE samples SET payload_json = ? WHERE id = ?");
  const insertRollup = database.prepare(`
    INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const rollupByKey = new Map();
  const metricBaselines = {};
  let previousRaw = null;
  database.exec("DELETE FROM rollups");

  for (const row of database.prepare("SELECT id, timestamp_ms, payload_json FROM samples ORDER BY timestamp_ms, id").iterate()) {
    const original = parseJson(row.payload_json, {});
    const hasTelemetry = POWER_KEYS.some((key) => finite(original[key]) !== null)
      || finite(original.stateOfChargePercent) !== null
      || Object.values(original.circuitPowerW ?? {}).some((value) => finite(value) !== null);
    if (!hasTelemetry) continue;

    const sample = { ...original };
    for (const key of [
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
    ]) delete sample[key];

    const elapsedSeconds = previousRaw?.timestamp
      ? Math.max(0, (row.timestamp_ms - timestampMs(previousRaw.timestamp)) / 1000)
      : 0;
    const maximumGapSeconds = maximumIntegrationGapMs(original) / 1000;
    const intervalSeconds = elapsedSeconds <= maximumGapSeconds ? elapsedSeconds : 0;
    const sameFuelCellSource = original.fuelCellCounterSourceHost
      && original.fuelCellCounterSourceHost === previousRaw?.fuelCellCounterSourceHost;
    const fuelCellElectricity = sameFuelCellSource
      ? cumulativeCounterDeltaResult(
        original.fuelCellCumulativeGenerationKwh,
        previousRaw?.fuelCellCumulativeGenerationKwh,
        COUNTER_POLICIES.fuelCellElectricity,
        elapsedSeconds,
      )
      : { delta: null, issue: null };
    const fuelCellGas = sameFuelCellSource
      ? cumulativeCounterDeltaResult(
        original.fuelCellCumulativeGasM3,
        previousRaw?.fuelCellCumulativeGasM3,
        COUNTER_POLICIES.fuelCellGas,
        elapsedSeconds,
      )
      : { delta: null, issue: null };
    const sameMeterSource = original.meterCounterSourceHost
      && original.meterCounterSourceHost === previousRaw?.meterCounterSourceHost;
    const gridImport = sameMeterSource
      ? cumulativeCounterDeltaResult(
        original.gridImportCumulativeKwh,
        previousRaw?.gridImportCumulativeKwh,
        COUNTER_POLICIES.grid,
        elapsedSeconds,
      )
      : { delta: null, issue: null };
    const gridExport = sameMeterSource
      ? cumulativeCounterDeltaResult(
        original.gridExportCumulativeKwh,
        previousRaw?.gridExportCumulativeKwh,
        COUNTER_POLICIES.grid,
        elapsedSeconds,
      )
      : { delta: null, issue: null };

    const currentCircuits = Object.fromEntries(Object.entries(original.circuitCumulativeKwh ?? {})
      .map(([channel, value]) => [channel, finite(value)])
      .filter(([, value]) => value !== null && value >= 0));
    const circuitEnergyKwh = {};
    const circuitCounterIssues = [];
    for (const [channel, current] of Object.entries(currentCircuits)) {
      const result = cumulativeCounterDeltaResult(
        current,
        previousRaw?.circuitCumulativeKwh?.[channel],
        COUNTER_POLICIES.circuit,
        elapsedSeconds,
      );
      if (result.delta !== null) circuitEnergyKwh[channel] = result.delta;
      if (result.issue) circuitCounterIssues.push({ channel: Number(channel), issue: result.issue });
    }
    const exactHouseDemandKwh = Object.keys(currentCircuits).length > 0
      && Object.keys(circuitEnergyKwh).length === Object.keys(currentCircuits).length
      ? Object.values(circuitEnergyKwh).reduce((sum, value) => sum + value, 0)
      : null;

    if (fuelCellElectricity.delta !== null) sample.fuelCellKwh = fuelCellElectricity.delta;
    if (fuelCellGas.delta !== null) sample.fuelCellGasM3 = fuelCellGas.delta;
    if (gridImport.delta !== null) sample.gridImportKwh = gridImport.delta;
    if (gridExport.delta !== null) sample.gridExportKwh = gridExport.delta;
    if (exactHouseDemandKwh !== null) sample.houseDemandKwh = exactHouseDemandKwh;
    if (Object.keys(circuitEnergyKwh).length) sample.circuitEnergyKwh = circuitEnergyKwh;
    sample.fuelCellCounterIssues = [
      ...(fuelCellElectricity.issue ? [{ counter: "electricity", issue: fuelCellElectricity.issue }] : []),
      ...(fuelCellGas.issue ? [{ counter: "gas", issue: fuelCellGas.issue }] : []),
    ];
    sample.fuelCellDataQuality = fuelCellElectricity.delta !== null
      ? "counter"
      : finite(sample.fuelCellPowerW) !== null && fuelCellGas.delta !== null
        ? "mixed"
        : finite(sample.fuelCellPowerW) !== null
          ? "integrated"
          : null;
    sample.fuelCellGasDataQuality = fuelCellGas.delta !== null ? "counter" : null;
    sample.meterCounterIssues = [
      ...(gridImport.issue ? [{ counter: "import", issue: gridImport.issue }] : []),
      ...(gridExport.issue ? [{ counter: "export", issue: gridExport.issue }] : []),
    ];
    sample.circuitCounterIssues = circuitCounterIssues;
    sample.coverageSeconds = {};
    sample.energyQuality = {};
    sample.energyIntervalStart = {};
    const directMetrics = [
      ["fuelCellKwh", fuelCellElectricity.delta],
      ["fuelCellGasM3", fuelCellGas.delta],
      ["gridImportKwh", gridImport.delta],
      ["gridExportKwh", gridExport.delta],
      ["houseDemandKwh", exactHouseDemandKwh],
    ];
    for (const [key, value] of directMetrics) {
      if (value === null) continue;
      sample.coverageSeconds[key] = intervalSeconds;
      sample.energyQuality[key] = "counter";
      if (previousRaw?.timestamp) sample.energyIntervalStart[key] = previousRaw.timestamp;
    }
    for (const channel of Object.keys(circuitEnergyKwh)) {
      const key = `circuit:${channel}`;
      sample.coverageSeconds[key] = intervalSeconds;
      sample.energyQuality[key] = "counter";
      if (previousRaw?.timestamp) sample.energyIntervalStart[key] = previousRaw.timestamp;
    }
    sample.fuelCellOperatingSeconds = intervalSeconds > 0
      && ["generating", "starting", "stopping", "idling"].includes(previousRaw?.fuelCellGenerationState)
      ? intervalSeconds
      : 0;
    sample.fuelCellStartCount = sample.fuelCellGenerationState === "generating"
      && previousRaw?.fuelCellGenerationState !== "generating"
      ? 1
      : 0;

    const enriched = enrichHistorySample(sample, previousRaw, { metricBaselines });
    updateSample.run(JSON.stringify(enriched), row.id);
    updateMetricBaselines(metricBaselines, enriched);
    for (const resolution of ["interval", "daily"]) {
      const startMs = localBucketStart(row.timestamp_ms, resolution);
      const key = `${resolution}:${startMs}`;
      const state = rollupByKey.get(key) ?? emptyRollupState(startMs, resolution);
      addRollupSample(state, enriched);
      rollupByKey.set(key, state);
    }
    previousRaw = original;
  }

  for (const state of rollupByKey.values()) {
    insertRollup.run(
      state.resolution,
      state.startMs,
      state.endMs,
      JSON.stringify(rollupPayload(state)),
      JSON.stringify(state),
    );
  }
  database.prepare(`
    INSERT INTO metadata(key, value) VALUES ('energyCalculationVersion', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(ENERGY_CALCULATION_VERSION));
}

function createSchemaClone(source, target) {
  const tables = source.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY name
  `).all();
  for (const table of tables) target.exec(table.sql);
  return source.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all();
}

function copyTable(source, target, table) {
  const columns = source.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  if (!columns.length) return 0;
  const placeholders = columns.map(() => "?").join(", ");
  const insert = target.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${placeholders})`);
  let count = 0;
  for (const row of source.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).iterate()) {
    insert.run(...columns.map((column) => row[column]));
    count += 1;
  }
  return count;
}

async function compactHistoryDatabaseV7(dataDir, { onProgress = () => {} } = {}) {
  const databaseFile = historyDatabaseFile(dataDir);
  const temporaryFile = `${databaseFile}.schema-v7.tmp`;
  const rollbackFile = `${databaseFile}.schema-v6.rollback`;
  await rm(temporaryFile, { force: true });
  await rm(`${temporaryFile}-journal`, { force: true });
  await rm(rollbackFile, { force: true });

  const sourceStat = await stat(databaseFile);
  const volume = await statfs(dataDir);
  const availableBytes = Number(volume.bavail) * Number(volume.bsize);
  const requiredBytes = sourceStat.size + 64 * 1024 * 1024;
  if (availableBytes < requiredBytes) {
    const error = new Error(`Insufficient migration space: ${requiredBytes} bytes required, ${availableBytes} bytes available`);
    error.code = "INSUFFICIENT_MIGRATION_SPACE";
    error.requiredBytes = requiredBytes;
    error.availableBytes = availableBytes;
    throw error;
  }

  const checkpoint = new DatabaseSync(databaseFile);
  try {
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    checkpoint.close();
  }

  const source = new DatabaseSync(databaseFile, { readOnly: true });
  const target = new DatabaseSync(temporaryFile);
  const startedAt = Date.now();
  let sampleCount = 0;
  let originalPayloadBytes = 0;
  let compactPayloadBytes = 0;
  let originalFuelCellForecasts = 0;
  let retainedFuelCellForecasts = 0;
  try {
    target.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF");
    const indexes = createSchemaClone(source, target);
    const metadataInsert = target.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
    for (const row of source.prepare("SELECT key, value FROM metadata ORDER BY key").iterate()) {
      if (["schemaVersion", "energyCalculationVersion", "compaction:schema-v7"].includes(row.key)) continue;
      metadataInsert.run(row.key, row.value);
    }

    for (const table of [
      "events",
      "away_periods",
      "forecasts",
      "weather",
      "solar_forecast_daily",
      "gas_tariff_snapshots",
      "gas_tariff_overrides",
    ]) copyTable(source, target, table);

    originalFuelCellForecasts = Number(source.prepare("SELECT COUNT(*) AS count FROM fuel_cell_forecasts").get().count);
    const fuelCellInsert = target.prepare(`
      INSERT INTO fuel_cell_forecasts(
        target_start_ms, issued_at_ms, target_start, issued_at, payload_json, actual_kwh, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of source.prepare(`
      SELECT target_start_ms, issued_at_ms, target_start, issued_at, payload_json, actual_kwh, completed_at
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY target_start_ms, CAST(issued_at_ms / 1800000 AS INTEGER)
          ORDER BY issued_at_ms DESC
        ) AS canonical_rank
        FROM fuel_cell_forecasts
      )
      WHERE canonical_rank = 1
      ORDER BY target_start_ms, issued_at_ms
    `).iterate()) {
      fuelCellInsert.run(
        row.target_start_ms,
        row.issued_at_ms,
        row.target_start,
        row.issued_at,
        row.payload_json,
        row.actual_kwh,
        row.completed_at,
      );
      retainedFuelCellForecasts += 1;
    }

    const totalSamples = Number(source.prepare("SELECT COUNT(*) AS count FROM samples").get().count);
    const insertSample = target.prepare(`
      INSERT INTO samples(id, timestamp_ms, timestamp, payload_json, source_file, source_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rollupByKey = new Map();
    const metricBaselines = {};
    let previousRaw = null;
    for (const row of source.prepare(`
      SELECT id, timestamp_ms, timestamp, payload_json, source_file, source_line
      FROM samples ORDER BY timestamp_ms, id
    `).iterate()) {
      const original = parseJson(row.payload_json, {});
      const compact = compactHistorySample(original);
      const payloadJson = JSON.stringify(compact);
      insertSample.run(row.id, row.timestamp_ms, row.timestamp, payloadJson, row.source_file, row.source_line);
      sampleCount += 1;
      originalPayloadBytes += Buffer.byteLength(row.payload_json);
      compactPayloadBytes += Buffer.byteLength(payloadJson);

      const hasTelemetry = POWER_KEYS.some((key) => finite(compact[key]) !== null)
        || finite(compact.stateOfChargePercent) !== null
        || Object.values(compact.circuitPowerW ?? {}).some((value) => finite(value) !== null);
      if (hasTelemetry) {
        const interpreted = interpretHistorySample(compact, previousRaw, { metricBaselines });
        for (const resolution of ["interval", "daily"]) {
          const startMs = localBucketStart(row.timestamp_ms, resolution);
          const key = `${resolution}:${startMs}`;
          const state = rollupByKey.get(key) ?? emptyRollupState(startMs, resolution);
          addRollupSample(state, interpreted);
          rollupByKey.set(key, state);
        }
        previousRaw = compact;
        updateMetricBaselines(metricBaselines, compact);
      }
      if (sampleCount % 1000 === 0 || sampleCount === totalSamples) {
        onProgress({
          fromVersion: 6,
          toVersion: 7,
          phase: "compacting",
          processed: sampleCount,
          total: totalSamples,
          percent: totalSamples ? Math.round(sampleCount / totalSamples * 100) : 100,
          unit: "samples",
        });
      }
    }

    const insertRollup = target.prepare(`
      INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const state of rollupByKey.values()) {
      insertRollup.run(
        state.resolution,
        state.startMs,
        state.endMs,
        JSON.stringify(rollupPayload(state)),
        JSON.stringify(state),
      );
    }
    metadataInsert.run("schemaVersion", JSON.stringify(7));
    metadataInsert.run("energyCalculationVersion", JSON.stringify(ENERGY_CALCULATION_VERSION));
    metadataInsert.run("compaction:schema-v7", JSON.stringify({
      completedAt: new Date().toISOString(),
      sourceBytes: sourceStat.size,
      sourceSamplePayloadBytes: originalPayloadBytes,
      compactSamplePayloadBytes: compactPayloadBytes,
      samples: sampleCount,
      fuelCellForecastRowsRemoved: originalFuelCellForecasts - retainedFuelCellForecasts,
      durationMs: Date.now() - startedAt,
    }));
    for (const index of indexes) target.exec(index.sql);

    const sourceBounds = source.prepare(`
      SELECT COUNT(*) AS count, MIN(timestamp_ms) AS earliest, MAX(timestamp_ms) AS latest FROM samples
    `).get();
    const targetBounds = target.prepare(`
      SELECT COUNT(*) AS count, MIN(timestamp_ms) AS earliest, MAX(timestamp_ms) AS latest FROM samples
    `).get();
    if (Number(sourceBounds.count) !== Number(targetBounds.count)
      || Number(sourceBounds.earliest) !== Number(targetBounds.earliest)
      || Number(sourceBounds.latest) !== Number(targetBounds.latest)) {
      throw new Error("Compacted database sample validation failed");
    }
    const check = target.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0].quick_check !== "ok") {
      throw new Error(`Compacted database integrity check failed: ${JSON.stringify(check)}`);
    }
  } catch (error) {
    target.close();
    source.close();
    await rm(temporaryFile, { force: true });
    throw error;
  }
  target.close();
  source.close();

  await rm(`${databaseFile}-wal`, { force: true });
  await rm(`${databaseFile}-shm`, { force: true });
  await link(databaseFile, rollbackFile);
  try {
    await rename(temporaryFile, databaseFile);
    const replacement = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const check = replacement.prepare("PRAGMA quick_check").get();
      const version = parseJson(replacement.prepare(
        "SELECT value FROM metadata WHERE key = 'schemaVersion'",
      ).get()?.value);
      if (check?.quick_check !== "ok" || version !== 7) throw new Error("Replacement database validation failed");
    } finally {
      replacement.close();
    }
    await rm(rollbackFile, { force: true });
  } catch (error) {
    await rm(databaseFile, { force: true });
    await rename(rollbackFile, databaseFile);
    throw error;
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

const MIGRATIONS = new Map([
  [3, (database) => database.exec(`
    CREATE TABLE gas_tariff_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      billing_month TEXT NOT NULL,
      version INTEGER NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      source_url TEXT,
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(provider, billing_month, version)
    );
    CREATE INDEX gas_tariff_snapshots_month_idx
      ON gas_tariff_snapshots(provider, billing_month, version DESC);
    CREATE TABLE gas_tariff_overrides (
      provider TEXT NOT NULL,
      billing_month TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(provider, billing_month)
    );
    CREATE TABLE fuel_cell_forecasts (
      target_start_ms INTEGER NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      target_start TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actual_kwh REAL,
      completed_at TEXT,
      PRIMARY KEY(target_start_ms, issued_at_ms)
    );
    CREATE INDEX fuel_cell_forecasts_target_idx
      ON fuel_cell_forecasts(target_start_ms, issued_at_ms);
  `)],
  [4, (database) => {
    const updateSample = database.prepare("UPDATE samples SET payload_json = ? WHERE id = ?");
    const insertEvent = database.prepare(`
      INSERT OR IGNORE INTO events(event_key, timestamp_ms, timestamp, category, type, message, payload_json)
      VALUES (?, ?, ?, 'automation', 'guard-trigger', 'Charging Demand Guard entered Standby', NULL)
    `);
    const insertRollup = database.prepare(`
      INSERT INTO rollups(resolution, bucket_start_ms, bucket_end_ms, payload_json, state_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const rollupByKey = new Map();
    const metricBaselines = {};
    const markerIds = [];
    let previousRaw = null;
    const counterDelta = (current, previous, maximumDelta) => {
      const now = finite(current);
      const before = finite(previous);
      if (now === null || before === null || now < before) return null;
      const delta = now - before;
      return delta <= maximumDelta ? delta : null;
    };
    database.exec("DELETE FROM rollups");
    for (const row of database.prepare("SELECT id, timestamp_ms, timestamp, payload_json FROM samples ORDER BY timestamp_ms, id").iterate()) {
      const original = parseJson(row.payload_json, {});
      const hasTelemetry = POWER_KEYS.some((key) => finite(original[key]) !== null)
        || finite(original.stateOfChargePercent) !== null
        || Object.values(original.circuitPowerW ?? {}).some((value) => finite(value) !== null);
      if (Number(original.guardTriggerCount) > 0) {
        insertEvent.run(`automation:guard-trigger:${original.timestamp}`, row.timestamp_ms, original.timestamp);
        if (!hasTelemetry) markerIds.push(row.id);
      }
      if (!hasTelemetry) {
        continue;
      }
      const sample = { ...original };
      for (const key of [
        ...ENERGY_KEYS,
        "offPeakSavingYen",
        "solarSavingYen",
        "coverageSeconds",
        "energyQuality",
        "powerCoverageSeconds",
        "intervalAveragePowerW",
        "intervalAverageCircuitPowerW",
        "energyIntervalStart",
        "guardTriggerCount",
      ]) delete sample[key];
      const elapsedSeconds = previousRaw?.timestamp
        ? Math.max(0, (row.timestamp_ms - timestampMs(previousRaw.timestamp)) / 1000)
        : 0;
      const fuelCellKwh = original.fuelCellCounterSourceHost
        && original.fuelCellCounterSourceHost === previousRaw?.fuelCellCounterSourceHost
        ? counterDelta(original.fuelCellCumulativeGenerationKwh, previousRaw?.fuelCellCumulativeGenerationKwh, 10)
        : null;
      const fuelCellGasM3 = original.fuelCellCounterSourceHost
        && original.fuelCellCounterSourceHost === previousRaw?.fuelCellCounterSourceHost
        ? counterDelta(original.fuelCellCumulativeGasM3, previousRaw?.fuelCellCumulativeGasM3, 5)
        : null;
      const circuitEnergyKwh = {};
      for (const [channel, current] of Object.entries(original.circuitCumulativeKwh ?? {})) {
        const delta = counterDelta(current, previousRaw?.circuitCumulativeKwh?.[channel], 100);
        if (delta !== null) circuitEnergyKwh[channel] = delta;
      }
      if (fuelCellKwh !== null) sample.fuelCellKwh = fuelCellKwh;
      if (fuelCellGasM3 !== null) sample.fuelCellGasM3 = fuelCellGasM3;
      if (Object.keys(circuitEnergyKwh).length) sample.circuitEnergyKwh = circuitEnergyKwh;
      sample.coverageSeconds = {};
      sample.energyQuality = {};
      if (fuelCellKwh !== null) {
        sample.coverageSeconds.fuelCellKwh = elapsedSeconds <= DEFAULT_MAX_INTEGRATION_GAP_MS / 1000 ? elapsedSeconds : 0;
        sample.energyQuality.fuelCellKwh = "counter";
      }
      sample.fuelCellOperatingSeconds = elapsedSeconds <= DEFAULT_MAX_INTEGRATION_GAP_MS / 1000
        && ["generating", "starting", "stopping", "idling"].includes(previousRaw?.fuelCellGenerationState)
        ? elapsedSeconds
        : 0;
      const enriched = enrichHistorySample(sample, previousRaw, { metricBaselines });
      updateSample.run(JSON.stringify(enriched), row.id);
      updateMetricBaselines(metricBaselines, enriched);
      for (const resolution of ["interval", "daily"]) {
        const startMs = localBucketStart(row.timestamp_ms, resolution);
        const key = `${resolution}:${startMs}`;
        const state = rollupByKey.get(key) ?? emptyRollupState(startMs, resolution);
        addRollupSample(state, enriched);
        rollupByKey.set(key, state);
      }
      previousRaw = original;
    }
    const deleteSample = database.prepare("DELETE FROM samples WHERE id = ?");
    for (const id of markerIds) deleteSample.run(id);
    for (const state of rollupByKey.values()) {
      insertRollup.run(
        state.resolution,
        state.startMs,
        state.endMs,
        JSON.stringify(rollupPayload(state)),
        JSON.stringify(state),
      );
    }
    database.prepare(`
      INSERT INTO metadata(key, value) VALUES ('energyCalculationVersion', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(2));
  }],
  [5, rebuildDerivedEnergy],
]);

export async function migrateHistoryDatabase(dataDir, { onProgress = () => {} } = {}) {
  const inspection = await inspectHistoryDatabase(dataDir);
  if (inspection.state === "current" || inspection.state === "new") return inspection;
  if (inspection.state !== "upgrade") throw new Error(inspection.error ?? `Cannot migrate database in ${inspection.state} state`);
  let version = inspection.version;
  if (version < 6) {
    const database = new DatabaseSync(inspection.databaseFile);
    try {
      while (version < Math.min(6, SCHEMA_VERSION)) {
        const migrate = MIGRATIONS.get(version);
        if (!migrate) throw new Error(`No database migration registered from schema version ${version}`);
        onProgress({ fromVersion: version, toVersion: version + 1 });
        database.exec("BEGIN IMMEDIATE");
        try {
          migrate(database);
          database.prepare(`
            INSERT INTO metadata(key, value) VALUES ('schemaVersion', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(JSON.stringify(version + 1));
          database.exec("COMMIT");
          version += 1;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    } finally {
      database.close();
    }
  }
  if (version === 6 && SCHEMA_VERSION >= 7) {
    onProgress({ fromVersion: 6, toVersion: 7, phase: "preparing" });
    await compactHistoryDatabaseV7(dataDir, { onProgress });
    version = 7;
  }
  while (version < SCHEMA_VERSION) {
    const database = new DatabaseSync(inspection.databaseFile);
    try {
      const migrate = MIGRATIONS.get(version);
      if (!migrate) throw new Error(`No database migration registered from schema version ${version}`);
      onProgress({ fromVersion: version, toVersion: version + 1 });
      database.exec("BEGIN IMMEDIATE");
      try {
        migrate(database);
        database.prepare(`
          INSERT INTO metadata(key, value) VALUES ('schemaVersion', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(JSON.stringify(version + 1));
        database.exec("COMMIT");
        version += 1;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }
  return inspectHistoryDatabase(dataDir);
}
