import { MILLISECONDS_PER_DAY } from "../domain/time.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import { countGuardTriggersForRange } from "../domain/automation-rules.js";
import { aggregateEnergyReportSamples, normalizeReportBucket } from "../domain/energy-report.js";
import { calendarSavingsRanges, summarizeCalendarSavings, summarizeSamples } from "../domain/energy-summary.js";

interface ReportingHistoryPort {
  eventsBetween(category: string, startMs: number, endMs: number, types?: string[]): Array<{ at: string }>;
  querySamples(startMs: number, endMs: number, options?: { resolution?: "interval" | "daily" }): HistorySample[];
  stats(): unknown;
}

interface HistoryReportingDependencies {
  history: ReportingHistoryPort;
  ensureReady(): Promise<void>;
  readAutomationRules(): Promise<AutomationRule[]>;
  defaultConfig: ApplicationConfig;
}

function rangeMilliseconds(start: string | null | undefined, end: string | null | undefined, fallbackMs: number) {
  const startMs = start ? new Date(start).getTime() : Date.now() - fallbackMs;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  return { startMs, endMs };
}

export function createHistoryReportingService(dependencies: HistoryReportingDependencies) {
  async function guardTriggerCount(samples: HistorySample[], startMs: number, endMs: number): Promise<number> {
    const sampleTimes = new Set<string>(
      samples
        .filter((sample) => Number(sample.guardTriggerCount ?? 0) > 0 && typeof sample.timestamp === "string")
        .map((sample) => sample.timestamp!),
    );
    const events = dependencies.history.eventsBetween("automation", startMs, endMs, ["guard-trigger"]);
    const eventTimes = new Set(events.map((event) => event.at));
    return countGuardTriggersForRange(
      await dependencies.readAutomationRules(),
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
      { excludeTimes: new Set([...sampleTimes, ...eventTimes]) },
    ) + events.length;
  }

  async function readRange(
    start?: string | null,
    end?: string | null,
    config: ApplicationConfig = dependencies.defaultConfig,
  ) {
    await dependencies.ensureReady();
    const { startMs, endMs } = rangeMilliseconds(start, end, 30 * 60_000);
    const samples = endMs - startMs > 2 * 60 * 60_000
      ? dependencies.history.querySamples(startMs, endMs, { resolution: "interval" })
      : dependencies.history.querySamples(startMs, endMs);
    const summarySamples = dependencies.history.querySamples(startMs, endMs, { resolution: "interval" });
    return {
      samples,
      summary: summarizeSamples(summarySamples, config, {
        guardTriggerCount: await guardTriggerCount(samples, startMs, endMs),
        startMs,
        endMs,
      }),
    };
  }

  async function readSummaryRange(
    start?: string | null,
    end?: string | null,
    config: ApplicationConfig = dependencies.defaultConfig,
  ) {
    await dependencies.ensureReady();
    const { startMs, endMs } = rangeMilliseconds(start, end, 30 * 60_000);
    const samples = dependencies.history.querySamples(startMs, endMs, { resolution: "interval" });
    return summarizeSamples(samples, config, {
      guardTriggerCount: await guardTriggerCount(samples, startMs, endMs),
      startMs,
      endMs,
    });
  }

  function readCalendarSavings(
    end: Date | string | number,
    config: ApplicationConfig = dependencies.defaultConfig,
    todaySummary: Record<string, unknown> | null = null,
  ) {
    const ranges = calendarSavingsRanges(end);
    const completedDayEndMs = ranges.today!.startMs - 1;
    const earliestDailyStartMs = Math.min(ranges.lastMonth!.startMs, ranges.year!.startMs);
    const samples = [
      ...(completedDayEndMs >= earliestDailyStartMs
        ? dependencies.history.querySamples(earliestDailyStartMs, completedDayEndMs, { resolution: "interval" })
        : []),
      ...dependencies.history.querySamples(ranges.today!.startMs, ranges.today!.endMs, { resolution: "interval" }),
    ];
    return summarizeCalendarSavings(samples, config, end, todaySummary);
  }

  async function readEnergyReport(
    start?: string | null,
    end?: string | null,
    bucket?: string | null,
    config: ApplicationConfig = dependencies.defaultConfig,
  ) {
    await dependencies.ensureReady();
    const bucketMode = normalizeReportBucket(bucket ?? "day");
    const { startMs, endMs } = rangeMilliseconds(start, end, 30 * MILLISECONDS_PER_DAY);
    const samples = dependencies.history.querySamples(startMs, endMs, { resolution: "interval" });
    return {
      ...aggregateEnergyReportSamples(samples, {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        bucket: bucketMode,
        config,
      }),
      meta: {
        recordsRead: samples.length,
        recordsIncluded: samples.length,
        invalidRecords: 0,
        resolution: "30-minute",
      },
    };
  }

  return {
    readCalendarSavings,
    readEnergyReport,
    readRange,
    readStats: () => dependencies.history.stats(),
    readSummaryRange,
  };
}
