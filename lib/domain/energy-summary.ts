import { intervalOverlapFraction, summarizeCircuits } from "./circuits.js";
import { DEFAULT_CONFIG, configNumber } from "./configuration.js";
import { finiteNumberOrNull } from "./numbers.js";
import { rateForTimestamp } from "./tariffs.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { EnergyMetricKey, HistorySample, TimeRange } from "../contracts/history.js";

type EnergyConfig = Partial<ApplicationConfig>;

export interface EnergyMetricQuality {
  quality: string;
  coverageSeconds: number;
  coveragePercent: number | null;
}

export interface DiscountSavings {
  totalYen: number;
  batteryYen: number;
  gridYen: number;
}

export interface EnergySummaryExtras extends TimeRange {
  guardTriggerCount?: number;
}

export interface SavingsRange {
  startMs: number;
  endMs: number;
}

type SavingsSummary = Record<string, unknown> & {
  solarSavingYen?: number | null;
  co2SavingKg?: number | null;
  offPeakSavingYen?: number | null;
  totalOffPeakSavingYen?: number | null;
  batteryOffPeakSavingYen?: number | null;
  gridOffPeakSavingYen?: number | null;
};


export function sampleSolarGenerationKwh(
  sample: HistorySample,
  previousSample: HistorySample | null = null,
  range: TimeRange = {},
): number {
  // Integrate instantaneous solar power when the pre-computed kWh value is
  // missing, so a power-only sample is not counted as valid but contributing 0.
  return samplePowerKwh(sample, "solarGenerationKwh", "solarPowerW", previousSample, range);
}


export function samplePowerKwh(
  sample: HistorySample,
  directKey: EnergyMetricKey,
  wattsKey: string,
  previousSample: HistorySample | null | undefined,
  range: TimeRange = {},
): number {
  const direct = finiteNumberOrNull(sample[directKey]);
  if (Number.isFinite(direct)) return Number(direct) * intervalOverlapFraction(sample, directKey, previousSample ?? undefined, range, false);
  if (!previousSample?.timestamp || !sample?.timestamp) return 0;
  const watts = finiteNumberOrNull(sample[wattsKey]);
  const previousWatts = finiteNumberOrNull(previousSample[wattsKey]);
  if (!Number.isFinite(watts) || !Number.isFinite(previousWatts)) return 0;
  const elapsedMs = new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime();
  const expectedSeconds = Number(sample.expectedIntervalSeconds);
  const maximumGapMs = Number.isFinite(expectedSeconds)
    ? Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000))
    : 35 * 60_000;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > maximumGapMs) return 0;
  const averageWatts = (Math.max(0, Number(watts)) + Math.max(0, Number(previousWatts))) / 2;
  return elapsedMs / 3_600_000 * averageWatts / 1000
    * intervalOverlapFraction(sample, directKey, previousSample ?? undefined, range);
}


export function hasPowerSample(
  sample: HistorySample,
  directKey: EnergyMetricKey,
  wattsKey: string,
  previousSample: HistorySample | null | undefined,
): boolean {
  if (Number.isFinite(finiteNumberOrNull(sample?.[directKey]))) return true;
  if (!previousSample?.timestamp || !sample?.timestamp) return false;
  if (!Number.isFinite(finiteNumberOrNull(sample?.[wattsKey]))
    || !Number.isFinite(finiteNumberOrNull(previousSample?.[wattsKey]))) return false;
  const elapsedMs = new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime();
  const expectedSeconds = Number(sample.expectedIntervalSeconds);
  const maximumGapMs = Number.isFinite(expectedSeconds)
    ? Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000))
    : 35 * 60_000;
  return Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= maximumGapMs;
}


export function energyMetricQuality(
  samples: readonly HistorySample[],
  key: EnergyMetricKey,
  range: TimeRange = {},
): EnergyMetricQuality {
  const qualities = new Set<string>();
  let coverageSeconds = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    const fraction = intervalOverlapFraction(sample, key, previous, range, false);
    const seconds = Number(sample.coverageSeconds?.[key]);
    if (Number.isFinite(seconds)) coverageSeconds += Math.max(0, seconds) * fraction;
    const quality = sample.energyQuality?.[key];
    if (quality) qualities.add(quality);
  }
  const rangeStartMs = Number(range.startMs);
  const rangeEndMs = Number(range.endMs);
  const requestedSeconds = Number.isFinite(rangeStartMs) && Number.isFinite(rangeEndMs)
    ? Math.max(0, (rangeEndMs - rangeStartMs) / 1000)
    : null;
  return {
    quality: qualities.size === 1 ? [...qualities][0] : qualities.size > 1 ? "mixed" : "unavailable",
    coverageSeconds,
    coveragePercent: Number(requestedSeconds) > 0 ? Math.min(100, coverageSeconds / Number(requestedSeconds) * 100) : null,
  };
}


export function sampleDiscountSavings(
  sample: HistorySample,
  previousSample: HistorySample | null | undefined,
  config: EnergyConfig = DEFAULT_CONFIG,
  range: TimeRange = {},
): DiscountSavings {
  const standardRate = configNumber(
    config.standardRateYenPerKwh,
    DEFAULT_CONFIG.standardRateYenPerKwh,
    0,
    1000,
  );
  const recordedRate = finiteNumberOrNull(sample.rateYenPerKwh);
  const activeRate = recordedRate ?? rateForTimestamp(
    config.rateBands,
    sample.timestamp,
    standardRate,
  ).yenPerKwh;
  const savingPerKwh = Math.max(0, standardRate - activeRate);
  if (savingPerKwh === 0) {
    return { totalYen: 0, batteryYen: 0, gridYen: 0 };
  }

  const hasGridImport = hasPowerSample(sample, "gridImportKwh", "gridImportW", previousSample);
  const hasBatteryCharge = hasPowerSample(sample, "batteryChargeKwh", "batteryPowerW", previousSample);
  const gridImportKwh = hasGridImport
    ? samplePowerKwh(sample, "gridImportKwh", "gridImportW", previousSample, range)
    : null;
  const batteryChargeKwh = hasBatteryCharge
    ? samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", previousSample, range)
    : 0;
  const gridFundedBatteryKwh = gridImportKwh === null
    ? batteryChargeKwh
    : Math.min(batteryChargeKwh, gridImportKwh);
  const totalDiscountedKwh = gridImportKwh ?? gridFundedBatteryKwh;
  const batteryYen = gridFundedBatteryKwh * savingPerKwh;
  const totalYen = totalDiscountedKwh * savingPerKwh;
  return {
    totalYen,
    batteryYen,
    gridYen: Math.max(0, totalYen - batteryYen),
  };
}


export function summarizeEnergySources(
  samples: readonly HistorySample[],
  config: EnergyConfig,
  solarGenerationKwh: number,
  gridExportKwh: number,
  fuelCellKwh: number,
  range: TimeRange = {},
) {
  const standardRate = configNumber(
    config.standardRateYenPerKwh,
    DEFAULT_CONFIG.standardRateYenPerKwh,
    0,
    1000,
  );
  const grid = samples.reduce<{ peakGridKwh: number; offPeakGridKwh: number }>(
    (totals, sample, index) => {
      const importedKwh = samplePowerKwh(
        sample,
        "gridImportKwh",
        "gridImportW",
        samples[index - 1],
        range,
      );
      const recordedRate = Number(sample.rateYenPerKwh);
      const activeRate = Number.isFinite(recordedRate)
        ? recordedRate
        : rateForTimestamp(config.rateBands, sample.timestamp, standardRate).yenPerKwh;
      if (activeRate < standardRate) totals.offPeakGridKwh += importedKwh;
      else totals.peakGridKwh += importedKwh;
      return totals;
    },
    { peakGridKwh: 0, offPeakGridKwh: 0 },
  );
  const solarUsedKwh = config.solarEnabled === false
    ? 0
    : Math.max(0, solarGenerationKwh - gridExportKwh);
  const fuelCellContributionKwh = config.fuelCellEnabled === false
    ? 0
    : Math.max(0, Number(fuelCellKwh) || 0);
  const totalKwh = grid.peakGridKwh + grid.offPeakGridKwh + solarUsedKwh + fuelCellContributionKwh;
  const percent = (value: number) => totalKwh > 0 ? (value / totalKwh) * 100 : 0;
  return {
    ...grid,
    solarUsedKwh,
    fuelCellContributionKwh,
    totalKwh,
    peakGridPercent: percent(grid.peakGridKwh),
    offPeakGridPercent: percent(grid.offPeakGridKwh),
    solarUsedPercent: percent(solarUsedKwh),
    fuelCellContributionPercent: percent(fuelCellContributionKwh),
  };
}


export function summarizeSamples(
  samples: HistorySample[],
  config: EnergyConfig = DEFAULT_CONFIG,
  extras: EnergySummaryExtras = {},
) {
  const range: TimeRange = { startMs: extras.startMs, endMs: extras.endMs };
  const solarGenerationKwh = samples.reduce(
    (sum, sample, index) => sum + sampleSolarGenerationKwh(sample, samples[index - 1], range),
    0,
  );
  const gridImportKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "gridImportKwh", "gridImportW", samples[index - 1], range),
    0,
  );
  const gridExportKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "gridExportKwh", "gridExportW", samples[index - 1], range),
    0,
  );
  const branchDemandKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "branchDemandKwh", "branchDemandW", samples[index - 1], range),
    0,
  );
  const fuelCellKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", samples[index - 1], range),
    0,
  );
  const circuits = summarizeCircuits(samples, config, range);
  const battery = samples.reduce<{ chargedKwh: number; dischargedKwh: number }>(
    (acc, sample, index) => {
      const charged = samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", samples[index - 1], range);
      const dischargeSample: HistorySample = { ...sample, batteryPowerW: -Number(sample.batteryPowerW) };
      const previous = samples[index - 1];
      const previousDischargeSample = previous
        ? { ...previous, batteryPowerW: -Number(previous.batteryPowerW) }
        : null;
      const discharged = samplePowerKwh(
        dischargeSample,
        "batteryDischargeKwh",
        "batteryPowerW",
        previousDischargeSample,
        range,
      );
      acc.chargedKwh += charged;
      acc.dischargedKwh += discharged;
      return acc;
    },
    { chargedKwh: 0, dischargedKwh: 0 },
  );
  const socSamples = samples
    .map((sample) => finiteNumberOrNull(sample.stateOfChargePercent))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const averageStateOfChargePercent = socSamples.length
    ? socSamples.reduce((sum, value) => sum + value, 0) / socSamples.length
    : null;
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const guardTriggerCount = samples.reduce(
    (sum, sample) => sum + Math.max(0, Number(sample.guardTriggerCount ?? 0) || 0),
    0,
  ) + Math.max(0, Number(extras.guardTriggerCount ?? 0) || 0);
  const energySources = summarizeEnergySources(
    samples,
    config,
    solarGenerationKwh,
    gridExportKwh,
    fuelCellKwh,
    range,
  );
  const dataQuality = Object.fromEntries([
    "branchDemandKwh",
    "solarGenerationKwh",
    "gridImportKwh",
    "gridExportKwh",
    "fuelCellKwh",
    "batteryChargeKwh",
    "batteryDischargeKwh",
  ].map((key) => [key, energyMetricQuality(samples, key as EnergyMetricKey, range)]));
  const solarSavingYen = samples.reduce((sum, sample, index) => (
    sum + Number(sample.solarSavingYen ?? 0)
      * intervalOverlapFraction(sample, "solarGenerationKwh", samples[index - 1], range, false)
  ), 0);
  const offPeakSavingYen = samples.reduce((sum, sample, index) => (
    sum + Number(sample.offPeakSavingYen ?? 0)
      * intervalOverlapFraction(sample, "batteryChargeKwh", samples[index - 1], range, false)
  ), 0);
  const discountedSavings = samples.reduce<{
    totalOffPeakSavingYen: number;
    batteryOffPeakSavingYen: number;
    gridOffPeakSavingYen: number;
  }>(
    (totals, sample, index) => {
      const savings = sampleDiscountSavings(sample, samples[index - 1], config, range);
      totals.totalOffPeakSavingYen += savings.totalYen;
      totals.batteryOffPeakSavingYen += savings.batteryYen;
      totals.gridOffPeakSavingYen += savings.gridYen;
      return totals;
    },
    { totalOffPeakSavingYen: 0, batteryOffPeakSavingYen: 0, gridOffPeakSavingYen: 0 },
  );
  return {
    sampleCount: samples.length,
    start: samples[0]?.timestamp ?? null,
    end: samples[samples.length - 1]?.timestamp ?? null,
    offPeakSavingYen,
    ...discountedSavings,
    solarSavingYen,
    solarGenerationKwh,
    gridImportKwh,
    gridExportKwh,
    branchDemandKwh,
    fuelCellKwh,
    circuits,
    circuitTotalKwh: circuits.reduce((sum, circuit) => sum + Number(circuit.totalKwh ?? 0), 0),
    batteryChargedKwh: battery.chargedKwh,
    batteryDischargedKwh: battery.dischargedKwh,
    batteryNetKwh: battery.chargedKwh - battery.dischargedKwh,
    averageStateOfChargePercent,
    co2SavingKg: solarGenerationKwh * co2TonnesPerKwh * 1000,
    guardTriggerCount,
    energySources,
    dataQuality,
  };
}


export function calendarSavingsRanges(end: Date | string | number = new Date()): Record<string, SavingsRange> {
  const rangeEnd = new Date(end);
  if (!Number.isFinite(rangeEnd.getTime())) throw new Error("a valid savings period end is required");
  const today = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  const thisMonth = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
  const lastMonth = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth() - 1, 1);
  return {
    today: { startMs: today.getTime(), endMs: rangeEnd.getTime() },
    lastMonth: { startMs: lastMonth.getTime(), endMs: thisMonth.getTime() },
    month: {
      startMs: thisMonth.getTime(),
      endMs: rangeEnd.getTime(),
    },
    year: {
      startMs: new Date(rangeEnd.getFullYear(), 0, 1).getTime(),
      endMs: rangeEnd.getTime(),
    },
  };
}


export function compactSavingsSummary(summary: SavingsSummary | null | undefined, range: SavingsRange) {
  return {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
    solarSavingYen: Number(summary?.solarSavingYen ?? 0),
    co2SavingKg: Number(summary?.co2SavingKg ?? 0),
    offPeakSavingYen: Number(summary?.offPeakSavingYen ?? 0),
    totalOffPeakSavingYen: Number(summary?.totalOffPeakSavingYen ?? 0),
    batteryOffPeakSavingYen: Number(summary?.batteryOffPeakSavingYen ?? 0),
    gridOffPeakSavingYen: Number(summary?.gridOffPeakSavingYen ?? 0),
  };
}


export function summarizeCalendarSavings(
  samples: HistorySample[],
  config: EnergyConfig = DEFAULT_CONFIG,
  end: Date | string | number = new Date(),
  todaySummary: SavingsSummary | null = null,
) {
  const ranges = calendarSavingsRanges(end);
  return Object.fromEntries(Object.entries(ranges).map(([period, range]) => {
    const summary = period === "today" && todaySummary
      ? todaySummary
      : summarizeSamples(samples, config, range);
    return [period, compactSavingsSummary(summary, range)];
  }));
}
