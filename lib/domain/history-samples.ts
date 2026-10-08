import { COUNTER_POLICIES, cumulativeCounterDeltaResult } from "../counter-utils.js";
import type { HistoryResolution, HistorySample } from "../contracts/history.js";
import { finiteNumberOrNull as finite } from "./numbers.js";
import { timestampMs } from "./values.js";

export const ENERGY_CALCULATION_VERSION = 4;
const DEFAULT_MAX_INTEGRATION_GAP_MS = 35 * 60_000;

const ENERGY_KEYS: string[] = [
  "branchDemandKwh",
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
  "branchDemandW",
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


export function localBucketStart(timeMs: number, resolution: HistoryResolution): number {
  const date = new Date(timeMs);
  if (resolution === "daily") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  const minute = date.getMinutes() < 30 ? 0 : 30;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), minute).getTime();
}

export function bucketEnd(startMs: number, resolution: HistoryResolution): number {
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

export function intervalEnergy(sample: HistorySample, previousSample: HistorySample | null, directKey: string, wattsKey: string, transform: (value: number) => number = (value) => Math.max(0, value)): number | null {
  return intervalEnergyDetails(sample, previousSample, directKey, wattsKey, transform)?.value ?? null;
}

function baselineForMetric(previousSample: HistorySample | null, metricBaselines: Record<string, HistorySample> | null, key: string): HistorySample | null {
  return metricBaselines?.[key] ?? previousSample;
}

export function updateMetricBaselines(metricBaselines: Record<string, HistorySample>, sample: HistorySample): Record<string, HistorySample> {
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
    ["branchDemandKwh", "branchDemandW", (value) => Math.max(0, value)],
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
  // The charge/discharge mappings both target batteryPowerW and lose the sign
  // (discharge overwrites charge), so store the signed instantaneous average
  // directly when the raw battery power is available.
  {
    const baseline = baselineForMetric(previousSample, metricBaselines, "batteryPowerW");
    const currentWatts = finite(sample?.batteryPowerW);
    const previousWatts = finite(baseline?.batteryPowerW);
    const currentMs = timestampMs(sample?.timestamp);
    const previousMs = timestampMs(baseline?.timestamp);
    const elapsedMs = currentMs === null || previousMs === null ? Number.NaN : currentMs - previousMs;
    if (currentWatts !== null && previousWatts !== null
      && Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= maximumIntegrationGapMs(sample)) {
      intervalAveragePowerW.batteryPowerW = (currentWatts + previousWatts) / 2;
      powerCoverageSeconds.batteryPowerW = elapsedMs / 1000;
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
  const exactBranchDemandKwh = Object.keys(currentCircuits).length > 0
    && Object.keys(circuitEnergyKwh).length === Object.keys(currentCircuits).length
    ? Object.values(circuitEnergyKwh).reduce((sum, value) => sum + value, 0)
    : null;

  const interpreted: HistorySample = { ...sample };
  const directMetrics: Array<[string, number | null]> = [
    ["fuelCellKwh", fuelCellElectricity.delta],
    ["fuelCellGasM3", fuelCellGas.delta],
    ["gridImportKwh", gridImport.delta],
    ["gridExportKwh", gridExport.delta],
    ["branchDemandKwh", exactBranchDemandKwh],
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

export interface AverageMetric {
  sum: number;
  count: number;
  weightedSum: number;
  weight: number;
  min: number | null;
  max: number | null;
}

export interface RollupState {
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
  peakBranchDemandW: number | null;
  rateYenPerKwh: number | null;
  rateLabel: string | null;
}

export function emptyRollupState(startMs: number, resolution: HistoryResolution): RollupState {
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
    peakBranchDemandW: null,
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

export function addRollupSample(state: RollupState, sample: HistorySample, previousFuelCellState: string | null = null): RollupState {
  state.fuelCell ??= { operatingSeconds: 0, startCount: 0, states: {}, qualities: {}, lastState: null, lastHotWaterLevel: null, sourceHosts: {} };
  state.fuelCell.lastHotWaterLevel ??= null;
  state.energyQualities ??= {};
  // Rollup state persisted before peak tracking existed has no key; seed it so
  // the Math.max below cannot produce NaN.
  state.peakBranchDemandW ??= null;
  state.count += Number(sample.rollupSampleCount ?? 1) || 1;
  state.firstTimestamp ??= sample.timestamp ?? null;
  state.lastTimestamp = sample.timestamp ?? null;
  for (const key of POWER_KEYS) {
    const weight = finite(sample.powerCoverageSeconds?.[key]) ?? 0;
    const value = finite(sample.intervalAveragePowerW?.[key]) ?? sample[key];
    addAverageMetric(state.powers, key, value, weight);
  }
  // Peak branch demand must use the instantaneous value, not the interval average.
  const peakDemand = finite(sample.peakBranchDemandW) ?? finite(sample.branchDemandW);
  if (peakDemand !== null) {
    state.peakBranchDemandW = state.peakBranchDemandW === null ? peakDemand : Math.max(state.peakBranchDemandW, peakDemand);
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
    // The seconds cover the interval ending at this sample, so they belong to the
    // state that was active during it (the previous sample's state).
    // Prefer the state recorded by the previous sample in this bucket; when this
    // is the bucket's first sample, fall back to the previous sample overall so a
    // single-sample bucket still attributes its operating seconds.
    const operatingState = typeof state.fuelCell.lastState === "string"
      ? state.fuelCell.lastState
      : previousFuelCellState;
    if (operatingState) state.fuelCell.states[operatingState] = Number(state.fuelCell.states[operatingState] ?? 0) + seconds;
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

export function rollupPayload(state: RollupState): HistorySample {
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
  if (state.peakBranchDemandW != null) payload.peakBranchDemandW = state.peakBranchDemandW;
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
