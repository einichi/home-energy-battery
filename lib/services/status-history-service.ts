import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import { sampleFromStatus } from "../domain/telemetry.js";

interface StatusHistoryRepository {
  appendSample(sample: HistorySample): HistorySample | null;
  latestSample(): HistorySample | null;
  recordEvent(event: Record<string, unknown>): boolean;
}

export interface StatusHistoryDependencies {
  history: StatusHistoryRepository;
  ensureDataDirectory(): Promise<void>;
  noteAdaptiveSample(sample: HistorySample): void;
}

export function createStatusHistoryService(dependencies: StatusHistoryDependencies) {
  let previousSample: HistorySample | null = null;

  async function record(status: unknown, config: ApplicationConfig): Promise<ReturnType<typeof sampleFromStatus>> {
    const sample = sampleFromStatus(status, config, previousSample);
    const hotWaterLevel = Number.isInteger(sample.fuelCellHotWaterLevel) ? sample.fuelCellHotWaterLevel : null;
    const previousHotWaterLevel = Number.isInteger(previousSample?.fuelCellHotWaterLevel)
      ? previousSample?.fuelCellHotWaterLevel ?? null
      : null;
    if (hotWaterLevel !== null && hotWaterLevel !== previousHotWaterLevel) {
      const firstObservation = previousHotWaterLevel === null;
      dependencies.history.recordEvent({
        eventKey: `fuelCell:hot-water:${sample.timestamp}:${hotWaterLevel}`,
        at: sample.timestamp,
        category: "fuelCell",
        type: firstObservation ? "hot-water-level-observed" : "hot-water-level-transition",
        message: firstObservation
          ? `Ene-Farm hot-water level observed at ${hotWaterLevel}/5`
          : `Ene-Farm hot-water level changed from ${previousHotWaterLevel}/5 to ${hotWaterLevel}/5`,
        payload: { from: previousHotWaterLevel, to: hotWaterLevel, sourceHost: sample.fuelCellSourceHost },
      });
    }
    if (sample.fuelCellGenerationState && sample.fuelCellGenerationState !== previousSample?.fuelCellGenerationState) {
      dependencies.history.recordEvent({
        eventKey: `fuelCell:state:${sample.timestamp}:${sample.fuelCellGenerationState}`,
        at: sample.timestamp,
        category: "fuelCell",
        type: "state-transition",
        message: `Ene-Farm state changed from ${previousSample?.fuelCellGenerationState ?? "unknown"} to ${sample.fuelCellGenerationState}`,
        payload: {
          from: previousSample?.fuelCellGenerationState ?? null,
          to: sample.fuelCellGenerationState,
          sourceHost: sample.fuelCellSourceHost,
          quality: sample.fuelCellDataQuality,
        },
      });
    }
    if (sample.fuelCellCounterSourceHost !== previousSample?.fuelCellCounterSourceHost) {
      dependencies.history.recordEvent({
        eventKey: `fuelCell:counter-source:${sample.timestamp}:${sample.fuelCellCounterSourceHost ?? "unavailable"}`,
        at: sample.timestamp,
        category: "fuelCell",
        type: "counter-source-transition",
        message: sample.fuelCellCounterSourceHost
          ? `Ene-Farm exact counters are now supplied by ${sample.fuelCellCounterSourceHost}`
          : "Ene-Farm exact counters are unavailable; estimated watt integration may continue",
        payload: {
          from: previousSample?.fuelCellCounterSourceHost ?? null,
          to: sample.fuelCellCounterSourceHost ?? null,
          instantaneousSourceHost: sample.fuelCellSourceHost,
          quality: sample.fuelCellDataQuality,
        },
      });
    }
    for (const counterIssue of sample.fuelCellCounterIssues ?? []) {
      dependencies.history.recordEvent({
        eventKey: `fuelCell:counter:${counterIssue.counter}:${counterIssue.issue}:${sample.timestamp}`,
        at: sample.timestamp,
        category: "fuelCell",
        type: `counter-${counterIssue.issue}`,
        message: counterIssue.issue === "rollover"
          ? `Ene-Farm ${counterIssue.counter} counter rollover detected and validated`
          : `Ene-Farm ${counterIssue.counter} counter ${counterIssue.issue.replace("-", " ")} detected; this interval was excluded`,
        payload: { counter: counterIssue.counter, issue: counterIssue.issue, sourceHost: sample.fuelCellCounterSourceHost },
      });
    }
    await dependencies.ensureDataDirectory();
    // On a duplicate/invalid sample appendSample returns null; keep the last
    // accepted sample so the next poll still has a baseline for counter deltas.
    const appended = dependencies.history.appendSample(sample);
    if (appended) previousSample = appended;
    dependencies.noteAdaptiveSample(sample);
    return sample;
  }

  function clear(): void { previousSample = null; }
  function loadLatest(): HistorySample | null {
    previousSample = dependencies.history.latestSample();
    return previousSample;
  }

  return { clear, loadLatest, record };
}
