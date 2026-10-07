import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import { appendAdaptiveChargingLog } from "../domain/adaptive-state.js";
import {
  BATTERY_LEARNING_MODEL_VERSION,
  buildBatteryLearningModel,
  cleanBatteryLearningModel,
} from "../domain/battery-learning.js";
import { demandDayCoverage, type DemandDay } from "../domain/demand-forecast.js";
import { halfHourIndex, localDayKey } from "../domain/time.js";

interface AdaptiveHistoryEvent {
  at: string;
  message?: string | null;
}

interface AdaptiveHistoryPort {
  querySamples(startMs: number, endMs: number, options?: { resolution?: "interval" | "daily" }): HistorySample[];
  eventsBetween(category: string, startMs: number, endMs: number, types?: string[]): AdaptiveHistoryEvent[];
  isReady(): boolean;
  batteryChargeCurveSamples(sessions: Array<{ startedAt?: string; endedAt?: string }>): Array<{
    at: string;
    socPercent: number;
    batteryChargingW: number;
    sessionId: string;
    day: string;
  }>;
  recordEvent(event: Record<string, unknown>): boolean;
}

interface DemandProfileAccumulator {
  weightedSums: number[];
  coverageSeconds: number[];
}

interface DemandProfileIndex {
  days: Record<string, DemandProfileAccumulator>;
}

interface AdaptiveHistoryCache {
  loadedAt: number;
  startMs: number;
  samples: TimedHistorySample[];
}

type TimedHistorySample = HistorySample & { timestamp: string };

interface AdaptiveHistoryServiceOptions {
  cacheMs: number;
  seasonalLookbackYears: number;
}

export function createAdaptiveHistoryService(
  historyStore: AdaptiveHistoryPort,
  { cacheMs, seasonalLookbackYears }: AdaptiveHistoryServiceOptions,
) {
  let historyCache: AdaptiveHistoryCache | null = null;
  let demandProfilePromise: Promise<DemandDay[]> | null = null;

  function historySample(sample: HistorySample): TimedHistorySample | null {
    if (typeof sample.timestamp !== "string") return null;
    const compact: Record<string, unknown> = { timestamp: sample.timestamp };
    let hasMetric = false;
    for (const key of [
      "stateOfChargePercent", "batteryPowerW", "solarPowerW", "houseDemandW",
      "fuelCellPowerW", "fuelCellGenerationState", "fuelCellDataQuality",
    ] as const) {
      if (sample[key] === undefined) continue;
      compact[key] = sample[key];
      if (sample[key] !== null) hasMetric = true;
    }
    for (const key of [
      "rollupStart", "rollupEnd", "rollupResolution", "expectedIntervalSeconds",
      "intervalAveragePowerW", "powerCoverageSeconds", "coverageSeconds",
    ] as const) {
      if (sample[key] !== undefined) compact[key] = sample[key];
    }
    return hasMetric ? compact as TimedHistorySample : null;
  }

  async function readHistory(now = new Date()): Promise<TimedHistorySample[]> {
    const endMs = now.getTime();
    const startMs = endMs - 90 * 86_400_000;
    if (historyCache
      && endMs >= historyCache.loadedAt
      && endMs - historyCache.loadedAt < cacheMs
      && historyCache.startMs <= startMs) {
      return historyCache.samples.filter((sample) => {
        const time = new Date(sample.timestamp ?? "").getTime();
        return time >= startMs && time <= endMs;
      });
    }
    const samples = historyStore.querySamples(startMs, endMs)
      .map(historySample)
      .filter((sample): sample is TimedHistorySample => sample !== null);
    historyCache = { loadedAt: endMs, startMs, samples };
    return [...samples];
  }

  async function readBatteryLearningHistory(now = new Date()): Promise<HistorySample[]> {
    const endMs = now.getTime();
    const startMs = endMs - 90 * 86_400_000;
    const rollups = historyStore.querySamples(startMs, endMs, { resolution: "interval" });
    const manualActions = historyStore.eventsBetween("adaptiveCharging", startMs, endMs, ["pause"])
      .filter((event) => /^Manual\b/.test(event.message ?? ""))
      .map((event) => new Date(event.at).getTime())
      .filter(Number.isFinite);
    return rollups.map((rollup) => {
      const rollupStart = new Date(rollup.rollupStart ?? rollup.timestamp ?? "").getTime();
      const rollupEnd = new Date(rollup.rollupEnd ?? rollup.timestamp ?? "").getTime();
      return manualActions.some((time) => time >= rollupStart && time < rollupEnd)
        ? { ...rollup, manualAction: true }
        : rollup;
    });
  }

  async function refreshBatteryLearning(
    config: ApplicationConfig,
    state: AdaptiveChargingState,
    now = new Date(),
  ) {
    const rollups = await readBatteryLearningHistory(now);
    const curveSamples = historyStore.isReady()
      ? historyStore.batteryChargeCurveSamples(state.chargingPerformance?.sessions ?? [])
      : [];
    const previous = state.batteryLearning ?? cleanBatteryLearningModel();
    const model = buildBatteryLearningModel(config, rollups, {
      ...previous,
      performance: state.chargingPerformance,
    }, now, { curveSamples });
    const transitions: string[] = [];
    for (const key of ["charge", "discharge", "power"] as const) {
      if (previous[key]?.source !== model[key]?.source) {
        transitions.push(`${key} model ${model[key].source === "learned" ? "activated" : "returned to configured fallback"}`);
      }
    }
    const previousCurveSources = (previous.power?.curve ?? []).map((band) => band.source).join(":");
    const curveSources = (model.power?.curve ?? []).map((band) => band.source).join(":");
    if (previousCurveSources !== curveSources) transitions.push("charge-power curve confidence changed");
    if (transitions.length) {
      const message = `${transitions.join("; ")}; battery model version ${BATTERY_LEARNING_MODEL_VERSION}`;
      appendAdaptiveChargingLog(state, message, model.status === "degraded" ? "warning" : "learning", now);
      if (historyStore.isReady()) {
        historyStore.recordEvent({
          eventKey: `adaptiveCharging:battery-model:${now.toISOString()}:${transitions.join("|")}`,
          at: now.toISOString(),
          category: "adaptiveCharging",
          type: model.status === "degraded" ? "battery-model-demoted" : "battery-model-activated",
          message,
          payload: model,
        });
      }
    }
    if (historyStore.isReady()) {
      const snapshotKey = [
        model.charge.acceptedObservationCount,
        model.discharge.acceptedObservationCount,
        model.charge.validation.count,
        model.discharge.validation.count,
        model.charge.source,
        model.discharge.source,
        model.power.source,
        curveSources,
      ].join(":");
      historyStore.recordEvent({
        eventKey: `adaptiveCharging:battery-model-snapshot:v${BATTERY_LEARNING_MODEL_VERSION}:${snapshotKey}`,
        at: now.toISOString(),
        category: "adaptiveCharging",
        type: "battery-model-snapshot",
        message: `Battery model ${model.status}`,
        payload: model,
      });
      for (const kind of ["charge", "discharge"] as const) {
        for (const outcome of model[kind].validation.outcomes ?? []) {
          historyStore.recordEvent({
            eventKey: `adaptiveCharging:battery-model-validation:v${BATTERY_LEARNING_MODEL_VERSION}:${kind}:${outcome.id}`,
            at: now.toISOString(),
            category: "adaptiveCharging",
            type: "battery-model-validation",
            message: `${kind} model validation error ${Number(outcome.errorSoc).toFixed(2)} SOC points`,
            payload: { modelVersion: BATTERY_LEARNING_MODEL_VERSION, kind, ...outcome },
          });
        }
      }
    }
    state.batteryLearning = model;
    return model;
  }

  function emptyDemandProfileIndex(): DemandProfileIndex {
    return { days: {} };
  }

  function addDemandSample(index: DemandProfileIndex, sample: HistorySample): void {
    const demand = Number(sample.intervalAveragePowerW?.houseDemandW ?? sample.houseDemandW);
    const time = new Date(sample.timestamp ?? "");
    if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) return;
    const key = localDayKey(time);
    const bucket = halfHourIndex(time);
    const day = index.days[key] ?? { weightedSums: Array(48).fill(0), coverageSeconds: Array(48).fill(0) };
    const coverageSeconds = Math.min(1800, Math.max(0,
      Number(sample.powerCoverageSeconds?.houseDemandW
        ?? sample.coverageSeconds?.houseDemandKwh
        ?? sample.expectedIntervalSeconds
        ?? 0),
    ));
    if (coverageSeconds <= 0) return;
    const availableSeconds = Math.max(0, 1800 - Number(day.coverageSeconds[bucket] ?? 0));
    const appliedSeconds = Math.min(coverageSeconds, availableSeconds);
    if (appliedSeconds <= 0) return;
    day.weightedSums[bucket] = Number(day.weightedSums[bucket] ?? 0) + demand * appliedSeconds;
    day.coverageSeconds[bucket] = Number(day.coverageSeconds[bucket] ?? 0) + appliedSeconds;
    index.days[key] = day;
  }

  function demandProfileDays(index: DemandProfileIndex): DemandDay[] {
    return Object.entries(index.days).map(([key, day]) => {
      const values = new Map<number, number>();
      const coverageByBucket = new Map<number, number>();
      for (let bucket = 0; bucket < 48; bucket += 1) {
        const seconds = Number(day.coverageSeconds[bucket] ?? 0);
        const weightedSum = Number(day.weightedSums[bucket] ?? 0);
        if (seconds > 0 && Number.isFinite(weightedSum)) {
          values.set(bucket, weightedSum / seconds);
          coverageByBucket.set(bucket, Math.min(1800, seconds));
        }
      }
      return { key, date: new Date(`${key}T00:00:00`), ...demandDayCoverage(coverageByBucket), coverageByBucket, values };
    }).filter((day) => !Number.isNaN(day.date.getTime()));
  }

  async function refreshDemandProfile(): Promise<DemandDay[]> {
    const endMs = Date.now();
    const startMs = endMs - seasonalLookbackYears * 366 * 86_400_000;
    const index = emptyDemandProfileIndex();
    for (const sample of historyStore.querySamples(startMs, endMs, { resolution: "interval" })) addDemandSample(index, sample);
    return demandProfileDays(index);
  }

  async function readDemandProfileDays(): Promise<DemandDay[]> {
    if (!demandProfilePromise) {
      demandProfilePromise = refreshDemandProfile().finally(() => { demandProfilePromise = null; });
    }
    return demandProfilePromise;
  }

  function noteSample(sample: HistorySample): void {
    if (!historyCache) return;
    const compact = historySample(sample);
    if (!compact) return;
    historyCache.samples.push(compact);
    historyCache.samples = historyCache.samples.filter(
      (item) => new Date(item.timestamp ?? "").getTime() >= historyCache!.startMs,
    );
  }

  function invalidate(): void {
    historyCache = null;
    demandProfilePromise = null;
  }

  return {
    invalidate,
    noteSample,
    readBatteryLearningHistory,
    readDemandProfileDays,
    readHistory,
    refreshBatteryLearning,
  };
}
