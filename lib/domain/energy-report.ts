import { intervalOverlapFraction } from "./circuits.js";
import { DEFAULT_CONFIG, configNumber } from "./configuration.js";
import { hasPowerSample, sampleDiscountSavings, samplePowerKwh, sampleSolarGenerationKwh } from "./energy-summary.js";
import { finiteNumberOrNull } from "./numbers.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample, TimeRange } from "../contracts/history.js";

export type ReportBucketMode = "day" | "week" | "month";
type ReportEnergyKey =
  | "houseDemandKwh"
  | "solarGenerationKwh"
  | "gridImportKwh"
  | "gridExportKwh"
  | "fuelCellKwh"
  | "batteryChargedKwh"
  | "batteryDischargedKwh";

const REPORT_ENERGY_KEYS: ReportEnergyKey[] = [
  "houseDemandKwh",
  "solarGenerationKwh",
  "gridImportKwh",
  "gridExportKwh",
  "fuelCellKwh",
  "batteryChargedKwh",
  "batteryDischargedKwh",
];

type ReportConfig = Partial<ApplicationConfig>;

interface InternalReportBucket extends Record<ReportEnergyKey, number> {
  key: string;
  label: string;
  start: string;
  end: string;
  sampleCount: number;
  solarSavingYen: number;
  offPeakSavingYen: number;
  totalOffPeakSavingYen: number;
  batteryOffPeakSavingYen: number;
  gridOffPeakSavingYen: number;
  co2SavingKg: number;
  peakDemandW: number | null;
  _valid: Record<ReportEnergyKey, number>;
  _coverageSeconds: Partial<Record<string, number>>;
  _qualities: Partial<Record<string, string[]>>;
}

export interface FinalReportBucket extends Omit<InternalReportBucket, "_valid" | "_coverageSeconds" | "_qualities"> {
  houseDemandKwh: number;
  previousHouseDemandKwh: number | null;
  houseDemandDeltaKwh: number | null;
  houseDemandDeltaPercent: number | null;
  dataQuality: Record<string, { quality: string; coverageSeconds: number; coveragePercent: number | null }>;
  [key: string]: unknown;
}

export interface EnergyReportAccumulator {
  process(sample: HistorySample): "skipped" | "before" | "after" | "included";
  finish(): {
    start: string;
    end: string;
    bucket: ReportBucketMode;
    buckets: FinalReportBucket[];
    totals: ReturnType<typeof summarizeReportBuckets>;
    features: { solarEnabled: boolean; smartCosmoEnabled: boolean; fuelCellEnabled: boolean };
  };
}

export interface EnergyReportOptions {
  start: Date | string | number;
  end: Date | string | number;
  bucket?: unknown;
  config?: ReportConfig;
  previousSample?: HistorySample | null;
}


export function normalizeReportBucket(value: unknown): ReportBucketMode {
  if (value === "day" || value === "week" || value === "month") return value;
  throw new Error("bucket must be day, week, or month");
}


export function startOfReportBucket(date: Date | string | number, bucket: ReportBucketMode): Date {
  const local = new Date(date);
  if (bucket === "month") return new Date(local.getFullYear(), local.getMonth(), 1);
  if (bucket === "week") {
    const start = new Date(local.getFullYear(), local.getMonth(), local.getDate());
    const dayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dayOffset);
    return start;
  }
  return new Date(local.getFullYear(), local.getMonth(), local.getDate());
}


export function endOfReportBucket(start: Date, bucket: ReportBucketMode): Date {
  const end = new Date(start);
  if (bucket === "month") end.setMonth(end.getMonth() + 1);
  else if (bucket === "week") end.setDate(end.getDate() + 7);
  else end.setDate(end.getDate() + 1);
  return end;
}


export function reportBucketKey(start: Date, bucket: ReportBucketMode): string {
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const day = String(start.getDate()).padStart(2, "0");
  if (bucket === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}


export function reportBucketLabel(start: Date, bucket: ReportBucketMode): string {
  if (bucket === "month") {
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  }
  if (bucket === "week") {
    const end = new Date(endOfReportBucket(start, bucket).getTime() - 1);
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")} - ${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  }
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}


export function emptyReportBucket(start: Date, bucket: ReportBucketMode): InternalReportBucket {
  const end = endOfReportBucket(start, bucket);
  return {
    key: reportBucketKey(start, bucket),
    label: reportBucketLabel(start, bucket),
    start: start.toISOString(),
    end: end.toISOString(),
    sampleCount: 0,
    houseDemandKwh: 0,
    solarGenerationKwh: 0,
    gridImportKwh: 0,
    gridExportKwh: 0,
    fuelCellKwh: 0,
    batteryChargedKwh: 0,
    batteryDischargedKwh: 0,
    solarSavingYen: 0,
    offPeakSavingYen: 0,
    totalOffPeakSavingYen: 0,
    batteryOffPeakSavingYen: 0,
    gridOffPeakSavingYen: 0,
    co2SavingKg: 0,
    peakDemandW: null,
    _valid: {
      houseDemandKwh: 0,
      solarGenerationKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      fuelCellKwh: 0,
      batteryChargedKwh: 0,
      batteryDischargedKwh: 0,
    },
    _coverageSeconds: {},
    _qualities: {},
  };
}


export function addReportEnergy(bucket: InternalReportBucket, key: ReportEnergyKey, value: unknown, valid: boolean): void {
  if (!valid) return;
  bucket[key] += Number(value) || 0;
  bucket._valid[key] += 1;
}


export function addReportQuality(
  bucket: InternalReportBucket,
  key: string,
  sample: HistorySample,
  previousSample: HistorySample | null,
  range: TimeRange,
  bucketKey: string = key,
): void {
  const fraction = intervalOverlapFraction(sample, key, previousSample ?? undefined, range, false);
  const seconds = Number(sample.coverageSeconds?.[key]);
  if (Number.isFinite(seconds)) {
    bucket._coverageSeconds[bucketKey] = Number(bucket._coverageSeconds[bucketKey] ?? 0) + Math.max(0, seconds) * fraction;
  }
  const quality = sample.energyQuality?.[key];
  if (quality) bucket._qualities[bucketKey] = [...new Set([...(bucket._qualities[bucketKey] ?? []), quality])];
}


export function finalizeReportBucket(
  bucket: InternalReportBucket,
  previousBucket: FinalReportBucket | undefined,
  selectedRange: TimeRange = {},
): FinalReportBucket {
  const out: Record<string, unknown> = { ...bucket };
  delete out._valid;
  delete out._coverageSeconds;
  delete out._qualities;
  for (const key of REPORT_ENERGY_KEYS) {
    if (!bucket._valid[key]) out[key] = null;
  }
  const houseDemandKwh = finiteNumberOrNull(out.houseDemandKwh);
  const previousHouseDemandKwh = previousBucket?.houseDemandKwh ?? null;
  out.previousHouseDemandKwh = previousHouseDemandKwh;
  out.houseDemandDeltaKwh =
    houseDemandKwh !== null && previousHouseDemandKwh !== null
      ? houseDemandKwh - previousHouseDemandKwh
      : null;
  const houseDemandDeltaKwh = finiteNumberOrNull(out.houseDemandDeltaKwh);
  out.houseDemandDeltaPercent =
    houseDemandDeltaKwh !== null && previousHouseDemandKwh !== null && previousHouseDemandKwh !== 0
      ? (houseDemandDeltaKwh / previousHouseDemandKwh) * 100
      : null;
  const bucketStartMs = new Date(bucket.start).getTime();
  const bucketEndMs = new Date(bucket.end).getTime();
  const rangeStartMs = Number(selectedRange.startMs);
  const rangeEndMs = Number(selectedRange.endMs);
  const selectedStartMs = Number.isFinite(rangeStartMs)
    ? Math.max(bucketStartMs, rangeStartMs)
    : bucketStartMs;
  const selectedEndMs = Number.isFinite(rangeEndMs)
    ? Math.min(bucketEndMs, rangeEndMs)
    : bucketEndMs;
  const bucketSeconds = Math.max(0, (selectedEndMs - selectedStartMs) / 1000);
  out.dataQuality = Object.fromEntries(Object.keys(bucket._valid).map((key) => {
    const qualities = bucket._qualities[key] ?? [];
    const coverageSeconds = Number(bucket._coverageSeconds[key] ?? 0);
    return [key, {
      quality: qualities.length === 1 ? qualities[0] : qualities.length > 1 ? "mixed" : "unavailable",
      coverageSeconds,
      coveragePercent: bucketSeconds > 0 ? Math.min(100, coverageSeconds / bucketSeconds * 100) : null,
    }];
  }));
  return out as FinalReportBucket;
}


export function summarizeReportBuckets(buckets: readonly FinalReportBucket[]) {
  const sum = (key: ReportEnergyKey): number | null => {
    const values = buckets
      .map((bucket) => bucket[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const peaks = buckets
    .map((bucket) => finiteNumberOrNull(bucket.peakDemandW))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const houseDemandKwh = sum("houseDemandKwh");
  const solarGenerationKwh = sum("solarGenerationKwh");
  return {
    houseDemandKwh,
    solarGenerationKwh,
    gridImportKwh: sum("gridImportKwh"),
    gridExportKwh: sum("gridExportKwh"),
    fuelCellKwh: sum("fuelCellKwh"),
    batteryChargedKwh: sum("batteryChargedKwh"),
    batteryDischargedKwh: sum("batteryDischargedKwh"),
    solarSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.solarSavingYen ?? 0), 0),
    offPeakSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.offPeakSavingYen ?? 0), 0),
    totalOffPeakSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.totalOffPeakSavingYen ?? 0), 0),
    batteryOffPeakSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.batteryOffPeakSavingYen ?? 0), 0),
    gridOffPeakSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.gridOffPeakSavingYen ?? 0), 0),
    co2SavingKg: buckets.reduce((total, bucket) => total + Number(bucket.co2SavingKg ?? 0), 0),
    peakDemandW: peaks.length ? Math.max(...peaks) : null,
    solarCoveragePercent:
      houseDemandKwh !== null && houseDemandKwh > 0 && solarGenerationKwh !== null
        ? (solarGenerationKwh / houseDemandKwh) * 100
        : null,
    sampleCount: buckets.reduce((total, bucket) => total + Number(bucket.sampleCount ?? 0), 0),
  };
}


export function createEnergyReportAccumulator({
  start,
  end,
  bucket = "day",
  config = DEFAULT_CONFIG,
  previousSample = null,
}: EnergyReportOptions): EnergyReportAccumulator {
  const bucketMode = normalizeReportBucket(bucket);
  const startMs = start ? new Date(start).getTime() : Number.NaN;
  const endMs = end ? new Date(end).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const byKey = new Map<string, InternalReportBucket>();
  let prev = previousSample;

  return {
    process(sample: HistorySample) {
      const time = new Date(sample.timestamp ?? "").getTime();
      if (!Number.isFinite(time)) {
        prev = sample;
        return "skipped";
      }
      if (time < startMs) {
        prev = sample;
        return "before";
      }
      const intervalStartMs = new Date(
        sample.rollupStart
          ?? Object.values(sample.energyIntervalStart ?? {}).sort()[0]
          ?? prev?.timestamp,
      ).getTime();
      if (time >= endMs && (!Number.isFinite(intervalStartMs) || intervalStartMs >= endMs)) return "after";
      const bucketStart = startOfReportBucket(new Date(Math.max(startMs, time - 1)), bucketMode);
      const key = reportBucketKey(bucketStart, bucketMode);
      if (!byKey.has(key)) byKey.set(key, emptyReportBucket(bucketStart, bucketMode));
      const row = byKey.get(key)!;
      row.sampleCount += Number(sample.rollupSampleCount ?? 1) || 1;
      const reportRange: TimeRange = {
        startMs: Math.max(startMs, bucketStart.getTime()),
        endMs: Math.min(endMs, endOfReportBucket(bucketStart, bucketMode).getTime()),
      };
      addReportEnergy(
        row,
        "houseDemandKwh",
        samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", prev, reportRange),
        hasPowerSample(sample, "houseDemandKwh", "houseDemandW", prev),
      );
      addReportQuality(row, "houseDemandKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "gridImportKwh",
        samplePowerKwh(sample, "gridImportKwh", "gridImportW", prev, reportRange),
        hasPowerSample(sample, "gridImportKwh", "gridImportW", prev),
      );
      addReportQuality(row, "gridImportKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "gridExportKwh",
        samplePowerKwh(sample, "gridExportKwh", "gridExportW", prev, reportRange),
        hasPowerSample(sample, "gridExportKwh", "gridExportW", prev),
      );
      addReportQuality(row, "gridExportKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "fuelCellKwh",
        samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", prev, reportRange),
        hasPowerSample(sample, "fuelCellKwh", "fuelCellPowerW", prev),
      );
      addReportQuality(row, "fuelCellKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "batteryChargedKwh",
        samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", prev, reportRange),
        hasPowerSample(sample, "batteryChargeKwh", "batteryPowerW", prev),
      );
      addReportQuality(row, "batteryChargeKwh", sample, prev, reportRange, "batteryChargedKwh");
      addReportEnergy(
        row,
        "batteryDischargedKwh",
        samplePowerKwh(
          { ...sample, batteryPowerW: -Number(sample.batteryPowerW) },
          "batteryDischargeKwh",
          "batteryPowerW",
          prev ? { ...prev, batteryPowerW: -Number(prev.batteryPowerW) } : null,
          reportRange,
        ),
        hasPowerSample(sample, "batteryDischargeKwh", "batteryPowerW", prev),
      );
      addReportQuality(row, "batteryDischargeKwh", sample, prev, reportRange, "batteryDischargedKwh");
      const solarGenerationKwh = sampleSolarGenerationKwh(sample, prev, reportRange);
      addReportEnergy(
        row,
        "solarGenerationKwh",
        solarGenerationKwh,
        Number.isFinite(finiteNumberOrNull(sample.solarGenerationKwh))
          || hasPowerSample(sample, "solarGenerationKwh", "solarPowerW", prev),
      );
      addReportQuality(row, "solarGenerationKwh", sample, prev, reportRange);
      row.solarSavingYen += (Number(sample.solarSavingYen ?? 0) || 0)
        * intervalOverlapFraction(sample, "solarGenerationKwh", prev ?? undefined, reportRange, false);
      row.offPeakSavingYen += (Number(sample.offPeakSavingYen ?? 0) || 0)
        * intervalOverlapFraction(sample, "batteryChargeKwh", prev ?? undefined, reportRange, false);
      const discountedSavings = sampleDiscountSavings(sample, prev, config, reportRange);
      row.totalOffPeakSavingYen += discountedSavings.totalYen;
      row.batteryOffPeakSavingYen += discountedSavings.batteryYen;
      row.gridOffPeakSavingYen += discountedSavings.gridYen;
      row.co2SavingKg += solarGenerationKwh * co2TonnesPerKwh * 1000;
      const demand = Number(sample.peakHouseDemandW ?? sample.houseDemandW);
      if (Number.isFinite(demand)) row.peakDemandW = Math.max(row.peakDemandW ?? demand, demand);
      prev = sample;
      return "included";
    },
    finish() {
      const buckets: FinalReportBucket[] = [];
      let cursor = startOfReportBucket(new Date(startMs), bucketMode);
      while (cursor.getTime() < endMs) {
        const key = reportBucketKey(cursor, bucketMode);
        const raw = byKey.get(key) ?? emptyReportBucket(cursor, bucketMode);
        buckets.push(finalizeReportBucket(raw, buckets.at(-1), { startMs, endMs }));
        cursor = endOfReportBucket(cursor, bucketMode);
      }
      return {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        bucket: bucketMode,
        buckets,
        totals: summarizeReportBuckets(buckets),
        features: {
          solarEnabled: config.solarEnabled !== false,
          smartCosmoEnabled: config.smartCosmoEnabled !== false,
          fuelCellEnabled: config.fuelCellEnabled !== false,
        },
      };
    },
  };
}


export function aggregateEnergyReportSamples(samples: readonly HistorySample[], options: EnergyReportOptions) {
  const accumulator = createEnergyReportAccumulator(options);
  for (const sample of samples) {
    const result = accumulator.process(sample);
    if (result === "after") break;
  }
  return accumulator.finish();
}
