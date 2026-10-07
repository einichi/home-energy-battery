import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import {
  applicableGasDiscount,
  applicableGasTariffBand,
  importGasTariff,
  normalizeGasTariffPayload,
} from "../gas-tariffs.js";
import {
  billingPeriodBounds,
  billingPeriodKey,
  completeBillingPeriod,
  fuelCellGasUsageByBillingPeriod,
} from "../domain/ene-farm.js";
import { aggregateEnergyReportSamples, type ReportBucketMode } from "../domain/energy-report.js";
import { samplePowerKwh } from "../domain/energy-summary.js";
import { finiteNumberOrNull } from "../domain/numbers.js";

export interface FuelCellTransition {
  at: string;
  type?: string;
  payload?: unknown;
}

export interface GasTariffSnapshotInput {
  provider: string;
  billingMonth: string;
  sourceHash: string;
  fetchedAt?: string;
  sourceUrl?: string | null;
  payload: Record<string, unknown> & { bands?: Array<Record<string, unknown> & { yenPerM3?: number }> };
}

interface EneFarmHistoryPort {
  eventsBetween(category: string, startMs: number, endMs: number): Array<{
    at: string;
    type: string;
    payload?: unknown;
  }>;
  gasTariffSnapshots(options: { provider: string; billingMonth: string }): Array<{
    provider: string;
    billingMonth: string;
    bands: Array<Record<string, unknown> & { yenPerM3?: number }>;
    sourceUrl?: unknown;
    [key: string]: unknown;
  }>;
  querySamples(startMs: number, endMs: number): HistorySample[];
  recordGasTariffSnapshot(snapshot: GasTariffSnapshotInput): Record<string, unknown>;
}

type DateInput = Date | string | number;

interface StateInterval {
  start: string | null;
  end: string | null;
  state: string;
  generatedKwh: number;
  gasM3: number;
  hasGas: boolean;
  sourceHost: string | null;
  qualities: Set<string>;
}

export interface EneFarmSummary extends Record<string, unknown> {
  onSiteKwh: number | null;
  generationCoveragePercent: number | null;
  stateSince: string | null;
  timeInStateSeconds: number | null;
  lastStopAt: string | null;
}

interface SummaryOptions {
  start?: string;
  end?: string;
  billingPeriodGasM3?: number | null;
}

interface EneFarmReportingDependencies {
  history: EneFarmHistoryPort;
  defaultConfig: ApplicationConfig;
  externalIoDisabled: boolean;
}

export function createEneFarmReportingService(dependencies: EneFarmReportingDependencies) {
  function transitionsThrough(endMs: number): FuelCellTransition[] {
    return dependencies.history.eventsBetween("fuelCell", 0, endMs)
      .filter((event) => event.type === "state-transition")
      .map((event) => ({ ...event, at: String(event.at ?? "") }));
  }

  function recordGasTariffSnapshot(snapshot: GasTariffSnapshotInput) {
    return dependencies.history.recordGasTariffSnapshot(snapshot);
  }
  function gasTariffForMonth(config: ApplicationConfig, billingMonth: string) {
    const provider = config.fuelCell?.tariff?.provider ?? "tokyo-gas";
    const snapshot = dependencies.history.gasTariffSnapshots({ provider, billingMonth })[0] ?? null;
    if (!snapshot) return null;
    return {
      ...snapshot,
      ...normalizeGasTariffPayload(snapshot),
      source: "snapshot",
      sourceUrl: typeof snapshot.sourceUrl === "string" ? snapshot.sourceUrl : null,
    };
  }

  async function measuredGasByBillingPeriod(start: DateInput, end: DateInput, readingDay: number): Promise<Map<string, number>> {
    const startMonth = billingPeriodKey(start, readingDay);
    const endMs = new Date(end).getTime();
    const finalInstant = Number.isFinite(endMs)
      ? new Date(Math.max(new Date(start).getTime(), endMs - 1))
      : end;
    const endMonth = billingPeriodKey(finalInstant, readingDay);
    const first = billingPeriodBounds(startMonth, readingDay);
    const last = billingPeriodBounds(endMonth, readingDay);
    const samples = dependencies.history.querySamples(first.start.getTime(), last.end.getTime())
      .filter((sample): sample is HistorySample & { timestamp: string } => typeof sample.timestamp === "string");
    return fuelCellGasUsageByBillingPeriod(samples, readingDay);
  }

  function estimatedGasCost(
    config: ApplicationConfig,
    gasM3: number | null,
    start: DateInput,
    end: DateInput,
    billingPeriodGasM3: number | null = gasM3,
  ): Record<string, unknown> {
    const settings = config.fuelCell?.tariff;
    const readingDay = settings?.meterReadingDay ?? 1;
    const billingMonth = billingPeriodKey(start, readingDay);
    const rangeEndMs = new Date(end).getTime();
    const finalInstant = Number.isFinite(rangeEndMs)
      ? new Date(Math.max(new Date(start).getTime(), rangeEndMs - 1))
      : end;
    const endBillingMonth = billingPeriodKey(finalInstant, readingDay);
    if (billingMonth !== endBillingMonth) {
      return {
        estimated: true,
        available: false,
        billingMonth: null,
        reason: "The selected range crosses billing periods; review the per-period estimates instead",
        methodology: "Each billing period must use its own immutable tariff snapshot",
      };
    }
    const tariff = gasTariffForMonth(config, billingMonth);
    if (!Number.isFinite(gasM3) || !tariff) {
      return {
        estimated: true,
        available: false,
        billingMonth,
        reason: !tariff
          ? "No tariff snapshot is available for this billing month"
          : "No exact Ene-Farm gas counter data is available",
        methodology: "Ene-Farm gas volume multiplied by the configured monthly gas tariff",
      };
    }
    if (!Number.isFinite(billingPeriodGasM3)) {
      return {
        estimated: true,
        available: false,
        billingMonth,
        reason: "No exact Ene-Farm gas counter data is available for this billing period",
        methodology: "Measured Ene-Farm gas is assumed to be the household's entire gas consumption",
      };
    }
    const band = applicableGasTariffBand(tariff, billingPeriodGasM3);
    const discount = applicableGasDiscount(tariff, String(settings?.equipmentDiscount ?? ""));
    const configuredRate = finiteNumberOrNull(settings?.marginalRateOverrideYenPerM3);
    const baseRate = configuredRate ?? band?.yenPerM3 ?? null;
    if (!Number.isFinite(baseRate)) {
      return {
        estimated: true,
        available: false,
        billingMonth,
        reason: "No applicable variable gas rate is configured",
        methodology: "Ene-Farm gas volume multiplied by the configured monthly gas tariff",
      };
    }
    const measuredGasM3 = Number(gasM3);
    const discountRatio = (discount?.percent ?? 0) / 100;
    const marginalRateYenPerM3 = Number(baseRate) * (1 - discountRatio);
    const variableCostYen = measuredGasM3 * Number(baseRate);
    const uncappedDiscountYen = variableCostYen * discountRatio;
    const discountYen = Math.min(uncappedDiscountYen, discount?.capYen ?? Number.POSITIVE_INFINITY);
    const marginalCostYen = variableCostYen - discountYen;
    const fullPeriod = completeBillingPeriod(start, end, readingDay);
    const standingChargeYen = band?.baseChargeYen ?? null;
    const allocatedTotalYen = fullPeriod && Number.isFinite(standingChargeYen)
      ? Number(standingChargeYen) + marginalCostYen
      : null;
    return {
      estimated: true,
      available: true,
      billingMonth,
      source: tariff.source,
      sourceUrl: tariff.sourceUrl ?? tariff.providerPlanUrl ?? null,
      methodology: "Measured Ene-Farm gas is assumed to be the household's entire gas consumption; other gas appliances are excluded",
      assumedBillingPeriodUsageM3: billingPeriodGasM3,
      assumption: "Ene-Farm is the household's only gas consumer; gas used by other appliances is not included",
      band,
      discount,
      marginalRateYenPerM3,
      marginalCostYen,
      standingChargeInclusive: {
        available: allocatedTotalYen !== null && measuredGasM3 > 0,
        reason: fullPeriod ? (measuredGasM3 > 0 ? null : "No Ene-Farm gas was measured") : "Available only for a complete configured billing period",
        standingChargeYen,
        totalYen: allocatedTotalYen,
        allocatedYenPerM3: allocatedTotalYen !== null && measuredGasM3 > 0 ? allocatedTotalYen / measuredGasM3 : null,
        methodology: "The full household standing charge is allocated to measured Ene-Farm gas under the assumption that Ene-Farm is the only gas consumer; this is not a reconstructed provider bill",
      },
    };
  }

  async function updateCurrentTariff(config: ApplicationConfig, now = new Date()) {
    if (dependencies.externalIoDisabled) return null;
    if (config.fuelCellEnabled === false || config.fuelCell?.tariff?.automaticUpdates !== true) return null;
    const provider = config.fuelCell.tariff.provider;
    if (provider !== "tokyo-gas") return null;
    const billingMonth = billingPeriodKey(now, config.fuelCell.tariff.meterReadingDay ?? 1);
    const imported = await importGasTariff(provider, {
      billingMonth,
      readingDay: config.fuelCell.tariff.meterReadingDay,
      region: config.fuelCell.tariff.region,
      plan: config.fuelCell.tariff.plan,
    });
    return dependencies.history.recordGasTariffSnapshot({ ...imported, fetchedAt: now.toISOString() });
  }

  function summarize(samples: HistorySample[], config: ApplicationConfig, options: SummaryOptions = {}): EneFarmSummary {
    let generatedKwh = 0;
    let gasM3 = 0;
    let hasGas = false;
    let onSiteKwh = 0;
    let onSiteKnown = true;
    let operatingSeconds = 0;
    let startCount = 0;
    const qualities = new Set<string>();
    const states: Record<string, number> = {};
    let previousState: string | null = null;
    let stateSince: string | null = null;
    let lastStopAt: string | null = null;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      const previous = samples[index - 1];
      const energy = samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", previous);
      generatedKwh += energy;
      const gas = finiteNumberOrNull(sample.fuelCellGasM3);
      if (gas !== null) { gasM3 += Math.max(0, gas); hasGas = true; }
      const demand = samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", previous);
      if (sample.fuelCellInterconnection === "grid_connected_reverse_flow_prohibited") onSiteKwh += energy;
      else if (Number.isFinite(demand)) onSiteKwh += Math.min(energy, Math.max(0, demand));
      else if (energy > 0) onSiteKnown = false;
      const seconds = Math.max(0, finiteNumberOrNull(sample.fuelCellOperatingSeconds) ?? 0);
      operatingSeconds += seconds;
      startCount += Math.max(0, finiteNumberOrNull(sample.fuelCellStartCount) ?? 0);
      const operatingState = previous && typeof previous.fuelCellGenerationState === "string" ? previous.fuelCellGenerationState : null;
      if (operatingState) states[operatingState] = Number(states[operatingState] ?? 0) + seconds;
      if (typeof sample.fuelCellGenerationState === "string" && sample.fuelCellGenerationState) {
        if (sample.fuelCellGenerationState !== previousState) {
          stateSince = typeof sample.timestamp === "string" ? sample.timestamp : null;
          if (sample.fuelCellGenerationState === "stopped") lastStopAt = stateSince;
          previousState = sample.fuelCellGenerationState;
        }
      }
      if (typeof sample.fuelCellDataQuality === "string") qualities.add(sample.fuelCellDataQuality);
    }
    const gasValue = hasGas ? gasM3 : null;
    const gasCo2Kg = gasValue === null ? null : gasValue * Number(config.fuelCell?.gasCo2KgPerM3 ?? 2.21);
    const onSiteValue = onSiteKnown ? onSiteKwh : null;
    const avoidedGridCo2Kg = onSiteValue === null
      ? null
      : onSiteValue * Number(config.co2TonnesPerKwh ?? dependencies.defaultConfig.co2TonnesPerKwh) * 1000;
    const rangeStart = options.start ?? samples[0]?.timestamp ?? null;
    const rangeEnd = options.end ?? samples.at(-1)?.timestamp ?? null;
    const stateIntervals: StateInterval[] = [];
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      const previous = samples[index - 1];
      // Each sample's energy covers [previous, sample], so label the interval
      // with the state active during it (the previous sample's state).
      const sampleState = (previous?.fuelCellGenerationState ?? sample.fuelCellGenerationState) ?? "unknown";
      let interval = stateIntervals.at(-1);
      if (!interval || interval.state !== sampleState || interval.sourceHost !== (sample.fuelCellSourceHost ?? null)) {
        interval = {
          start: previous?.timestamp ?? rangeStart ?? sample.timestamp ?? null,
          end: sample.timestamp ?? null,
          state: sampleState,
          generatedKwh: 0,
          gasM3: 0,
          hasGas: false,
          sourceHost: sample.fuelCellSourceHost ?? null,
          qualities: new Set<string>(),
        };
        stateIntervals.push(interval);
      }
      interval.end = sample.timestamp ?? interval.end;
      interval.generatedKwh += samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", previous);
      const intervalGas = finiteNumberOrNull(sample.fuelCellGasM3);
      if (intervalGas !== null) { interval.gasM3 += Math.max(0, intervalGas); interval.hasGas = true; }
      if (typeof sample.fuelCellDataQuality === "string") interval.qualities.add(sample.fuelCellDataQuality);
    }
    if (stateIntervals.length) stateIntervals.at(-1)!.end = rangeEnd ?? stateIntervals.at(-1)!.end;
    const ratedSample = samples.findLast((sample) => Number.isFinite(Number(sample.fuelCellRatedPowerW)));
    return {
      sampleCount: samples.length,
      start: rangeStart,
      end: rangeEnd,
      generatedKwh: samples.length ? generatedKwh : null,
      gasM3: gasValue,
      electricalYieldKwhPerM3: Number(gasValue) > 0 ? generatedKwh / Number(gasValue) : null,
      onSiteKwh: onSiteValue,
      generationCoveragePercent: null,
      operatingSeconds,
      startCount,
      averageGeneratingW: operatingSeconds > 0 ? generatedKwh / (operatingSeconds / 3600) * 1000 : null,
      ratedPowerW: ratedSample?.fuelCellRatedPowerW ?? null,
      stateDurations: states,
      currentState: samples.at(-1)?.fuelCellGenerationState ?? null,
      stateSince,
      timeInStateSeconds: stateSince && rangeEnd
        ? Math.max(0, (new Date(rangeEnd).getTime() - new Date(stateSince).getTime()) / 1000)
        : null,
      lastStopAt,
      stateIntervals: stateIntervals.map((interval) => ({
        start: interval.start,
        end: interval.end,
        state: interval.state,
        durationSeconds: interval.start && interval.end
          ? Math.max(0, (new Date(interval.end).getTime() - new Date(interval.start).getTime()) / 1000)
          : 0,
        generatedKwh: interval.generatedKwh,
        gasM3: interval.hasGas ? interval.gasM3 : null,
        sourceHost: interval.sourceHost,
        quality: interval.qualities.size > 1 ? "mixed" : interval.qualities.values().next().value ?? null,
      })),
      sourceHost: samples.at(-1)?.fuelCellSourceHost ?? null,
      counterSourceHost: samples.at(-1)?.fuelCellCounterSourceHost ?? null,
      dataQuality: qualities.size > 1 ? "mixed" : qualities.values().next().value ?? null,
      estimatedGasCost: rangeStart && rangeEnd
        ? estimatedGasCost(config, gasValue, rangeStart, rangeEnd, options.billingPeriodGasM3)
        : null,
      carbon: {
        estimated: true,
        directGasCo2Kg: gasCo2Kg,
        avoidedGridCo2Kg,
        electricityOnlyBalanceKg: gasCo2Kg === null || avoidedGridCo2Kg === null ? null : avoidedGridCo2Kg - gasCo2Kg,
        methodology: "Avoided grid emissions minus direct gas emissions; recovered heat is not measured",
      },
    };
  }

  async function report(start: string, end: string, bucket: ReportBucketMode, config: ApplicationConfig) {
    const samples = dependencies.history.querySamples(new Date(start).getTime(), new Date(end).getTime());
    const readingDay = config.fuelCell?.tariff?.meterReadingDay ?? 1;
    const billingPeriodUsage = await measuredGasByBillingPeriod(start, end, readingDay);
    const energy = aggregateEnergyReportSamples(samples, { start, end, bucket, config });
    let sampleIndex = 0;
    const buckets = energy.buckets.map((row) => {
      const rowStartMs = new Date(row.start).getTime();
      const rowEndMs = new Date(row.end).getTime();
      while (sampleIndex < samples.length && new Date(samples[sampleIndex]!.timestamp ?? "").getTime() < rowStartMs) sampleIndex += 1;
      const bucketSamples: HistorySample[] = [];
      while (sampleIndex < samples.length && new Date(samples[sampleIndex]!.timestamp ?? "").getTime() < rowEndMs) {
        bucketSamples.push(samples[sampleIndex]!);
        sampleIndex += 1;
      }
      const summary = summarize(bucketSamples, config, {
        start: row.start,
        end: row.end,
        billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(row.start, readingDay)) ?? null,
      });
      summary.generationCoveragePercent = Number.isFinite(row.houseDemandKwh)
        && Number(row.houseDemandKwh) > 0
        && Number.isFinite(summary.onSiteKwh)
        ? Number(summary.onSiteKwh) / Number(row.houseDemandKwh) * 100
        : null;
      return { key: row.key, label: row.label, ...summary };
    });
    const totals = summarize(samples, config, {
      start,
      end,
      billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(start, readingDay)) ?? null,
    });
    const totalHouseDemandKwh = energy.totals.houseDemandKwh;
    totals.generationCoveragePercent = totalHouseDemandKwh !== null
      && totalHouseDemandKwh > 0
      && Number.isFinite(totals.onSiteKwh)
      ? Number(totals.onSiteKwh) / totalHouseDemandKwh * 100
      : null;
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      bucket,
      totals,
      buckets,
      estimateNotice: "All costs and savings are estimates. Check your provider statement for accurate billing information.",
    };
  }

  return { measuredGasByBillingPeriod, recordGasTariffSnapshot, report, summarize, transitionsThrough, updateCurrentTariff };
}
