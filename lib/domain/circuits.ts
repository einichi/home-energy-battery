import { COUNTER_POLICIES, cumulativeCounterDeltaResult, finiteCounterMap } from "../counter-utils.js";

export type CircuitLabels = Record<string, string>;

type CircuitSample = {
  timestamp?: string;
  rollupStart?: string;
  rollupEnd?: string;
  expectedIntervalSeconds?: number;
  energyIntervalStart?: Record<string, string>;
  circuitPowerW?: Record<string, number | null>;
  circuitEnergyKwh?: Record<string, number | null>;
  circuitCumulativeKwh?: Record<string, number | null>;
};

type TimeRange = { startMs?: number; endMs?: number };

function circuitLabelFor(channel: string, labels: CircuitLabels): string {
  const label = String(labels[channel] ?? "").trim();
  return label || `Circuit ${channel}`;
}

export function normalizeCircuitLabels(value: unknown = {}): CircuitLabels {
  const output: CircuitLabels = {};
  const entries: Array<[unknown, unknown]> = Array.isArray(value)
    ? value.map((item: unknown) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return [record.channel, record.label];
    })
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];
  for (const [channelValue, labelValue] of entries) {
    const channel = Number(channelValue);
    const label = String(labelValue ?? "").trim();
    if (!Number.isInteger(channel) || channel < 1 || channel > 252 || !label) continue;
    output[String(channel)] = label.slice(0, 80);
  }
  return output;
}

export function intervalOverlapFraction(
  sample: CircuitSample,
  directKey: string,
  previousSample: CircuitSample | undefined,
  range: TimeRange,
  usePrevious = true,
): number {
  const explicitStart = sample.rollupStart ?? sample.energyIntervalStart?.[directKey];
  if (!explicitStart && !usePrevious) return 1;
  const intervalStartMs = new Date(explicitStart ?? previousSample?.timestamp ?? "").getTime();
  const intervalEndMs = new Date(sample.rollupEnd ?? sample.timestamp ?? "").getTime();
  if (!Number.isFinite(intervalStartMs) || !Number.isFinite(intervalEndMs) || intervalEndMs <= intervalStartMs) return 1;
  const startMs = Number.isFinite(range.startMs) ? range.startMs! : intervalStartMs;
  const endMs = Number.isFinite(range.endMs) ? range.endMs! : intervalEndMs;
  const overlapMs = Math.max(0, Math.min(intervalEndMs, endMs) - Math.max(intervalStartMs, startMs));
  return overlapMs / (intervalEndMs - intervalStartMs);
}

function circuitEnergyDeltaKwh(current: unknown, previous: unknown, elapsedSeconds: number | null): number | null {
  return cumulativeCounterDeltaResult(current, previous, COUNTER_POLICIES.circuit, elapsedSeconds).delta;
}

function circuitKwhForSample(
  sample: CircuitSample,
  channel: string,
  previousSample: CircuitSample | undefined,
  range: TimeRange,
): number {
  const direct = Number(sample.circuitEnergyKwh?.[channel]);
  if (Number.isFinite(direct)) return direct * intervalOverlapFraction(sample, `circuit:${channel}`, previousSample, range, false);
  const elapsedSeconds = previousSample?.timestamp && sample.timestamp
    ? Math.max(0, (new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 1000)
    : null;
  const cumulative = circuitEnergyDeltaKwh(
    sample.circuitCumulativeKwh?.[channel],
    previousSample?.circuitCumulativeKwh?.[channel],
    elapsedSeconds,
  );
  if (cumulative !== null) return cumulative * intervalOverlapFraction(sample, `circuit:${channel}`, previousSample, range, false);
  if (!previousSample?.timestamp || !sample.timestamp) return 0;
  const watts = Number(sample.circuitPowerW?.[channel]);
  const previousWatts = Number(previousSample.circuitPowerW?.[channel]);
  if (!Number.isFinite(watts) || !Number.isFinite(previousWatts)) return 0;
  const elapsedMs = new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime();
  const expectedSeconds = Number(sample.expectedIntervalSeconds);
  const maximumGapMs = Number.isFinite(expectedSeconds)
    ? Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000))
    : 35 * 60_000;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > maximumGapMs) return 0;
  const averageWatts = (Math.max(0, watts) + Math.max(0, previousWatts)) / 2;
  return elapsedMs / 3_600_000 * averageWatts / 1000
    * intervalOverlapFraction(sample, `circuit:${channel}`, previousSample, range);
}

export function summarizeCircuits(
  samples: CircuitSample[],
  config: { circuitLabels?: CircuitLabels } = {},
  range: TimeRange = {},
) {
  const ids = new Set<string>();
  for (const sample of samples) {
    for (const key of Object.keys(sample.circuitPowerW ?? {})) ids.add(key);
    for (const key of Object.keys(sample.circuitCumulativeKwh ?? {})) ids.add(key);
    for (const key of Object.keys(sample.circuitEnergyKwh ?? {})) ids.add(key);
  }
  return [...ids]
    .map((id) => {
      const channel = Number(id);
      const totalKwh = samples.reduce(
        (sum, sample, index) => sum + circuitKwhForSample(sample, id, samples[index - 1], range),
        0,
      );
      const latestWatts = [...samples]
        .reverse()
        .map((sample) => sample.circuitPowerW?.[id])
        .find((value) => value !== null && value !== undefined);
      return {
        channel,
        id,
        label: circuitLabelFor(id, config.circuitLabels ?? {}),
        totalKwh,
        latestWatts: Number.isFinite(Number(latestWatts)) ? Number(latestWatts) : null,
      };
    })
    .filter((item) => Number.isInteger(item.channel))
    .sort((left, right) => left.channel - right.channel);
}

export const circuitChannelMap = finiteCounterMap;
export const circuitCumulativeMap = finiteCounterMap;
