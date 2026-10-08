import { MILLISECONDS_PER_DAY } from "../../domain/time.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { billingPeriodKey } from "../../domain/ene-farm.js";
import type { ApiDependencies } from "../api.js";

type HistoryRouteDependencies = Pick<ApiDependencies,
  | "eneFarmReport"
  | "http"
  | "measuredFuelCellGasByBillingPeriod"
  | "normalizeReportBucket"
  | "readCommandReceipt"
  | "readCommandReceipts"
  | "readConfig"
  | "readEnergyReport"
  | "readHistoryRange"
  | "readHistorySamplesInRange"
  | "readHistoryStats"
  | "readHistorySummaryRange"
  | "readFuelCellTransitions"
  | "startDeviceCommand"
  | "summarizeEneFarmSamples"
>;

function rangeParamError(url: URL): string | null {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start && !Number.isFinite(new Date(start).getTime())) return "valid start date/time is required";
  if (end && !Number.isFinite(new Date(end).getTime())) return "valid end date/time is required";
  if (start && end && new Date(start).getTime() >= new Date(end).getTime()) return "start must be before end";
  return null;
}

export function createHistoryRouteHandler(dependencies: HistoryRouteDependencies) {
  const { json, readBody } = dependencies.http;
  const {
    eneFarmReport,
    measuredFuelCellGasByBillingPeriod,
    normalizeReportBucket,
    readCommandReceipt,
    readCommandReceipts,
    readConfig,
    readEnergyReport,
    readHistoryRange,
    readHistorySamplesInRange,
    readHistoryStats,
    readHistorySummaryRange,
    readFuelCellTransitions,
    startDeviceCommand,
    summarizeEneFarmSamples,
  } = dependencies;

  return async function handleHistoryRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void | false> {
    if (req.method === "GET" && url.pathname === "/api/command-receipts") {
      const before = url.searchParams.get("before");
      const beforeMs = before ? new Date(before).getTime() : Date.now();
      if (!Number.isFinite(beforeMs)) return json(res, 400, { error: "before must be an ISO date/time" });
      return json(res, 200, {
        receipts: readCommandReceipts(url.searchParams.get("limit"), beforeMs),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/device-commands") {
      const body = await readBody(req);
      return json(res, 202, await startDeviceCommand(String(body.action ?? ""), body.payload ?? {}, { source: "manual" }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/device-commands/")) {
      const commandId = decodeURIComponent(url.pathname.slice("/api/device-commands/".length));
      if (!/^[a-z0-9-]{8,}$/i.test(commandId)) return json(res, 400, { error: "invalid command id" });
      const receipt = readCommandReceipt(commandId);
      return receipt ? json(res, 200, receipt) : json(res, 404, { error: "command receipt not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const rangeError = rangeParamError(url);
      if (rangeError) return json(res, 400, { error: rangeError });
      const config = await readConfig();
      return json(res, 200, await readHistoryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
    }
    if (req.method === "GET" && url.pathname === "/api/history/summary") {
      const rangeError = rangeParamError(url);
      if (rangeError) return json(res, 400, { error: rangeError });
      const config = await readConfig();
      return json(res, 200, await readHistorySummaryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
    }
    if (req.method === "GET" && url.pathname === "/api/history/stats") {
      return json(res, 200, await readHistoryStats());
    }
    if (req.method === "GET" && url.pathname === "/api/reports/energy") {
      const bucket = url.searchParams.get("bucket");
      if (bucket !== null && bucket !== "" && bucket !== "day" && bucket !== "week" && bucket !== "month") {
        return json(res, 400, { error: "bucket must be day, week, or month" });
      }
      const rangeError = rangeParamError(url);
      if (rangeError) return json(res, 400, { error: rangeError });
      const config = await readConfig();
      return json(
        res,
        200,
        await readEnergyReport(
          url.searchParams.get("start"),
          url.searchParams.get("end"),
          url.searchParams.get("bucket"),
          config,
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/ene-farm") {
      const config = await readConfig();
      const start = url.searchParams.get("start") ?? new Date(Date.now() - MILLISECONDS_PER_DAY).toISOString();
      const end = url.searchParams.get("end") ?? new Date().toISOString();
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return json(res, 400, { error: "valid start and end are required" });
      const samples = await readHistorySamplesInRange(startMs, endMs);
      const allTransitions = readFuelCellTransitions(endMs);
      const rangeStateTransitions = allTransitions.filter((event) => {
        const atMs = new Date(event.at).getTime();
        return Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs;
      });
      const latestStateTransition = allTransitions.at(-1) ?? null;
      const lastStopTransition = allTransitions.findLast((event) => {
        const payload = event.payload !== null && typeof event.payload === "object"
          ? event.payload as Record<string, unknown>
          : {};
        return payload.to === "stopped";
      }) ?? null;
      const readingDay = config.fuelCell?.tariff?.meterReadingDay ?? 1;
      const billingPeriodUsage = await measuredFuelCellGasByBillingPeriod(start, end, readingDay);
      const summary = summarizeEneFarmSamples(samples, config, {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(start, readingDay)) ?? null,
      });
      if (latestStateTransition?.at) {
        summary.stateSince = latestStateTransition.at;
        summary.timeInStateSeconds = Math.max(0, (endMs - new Date(latestStateTransition.at).getTime()) / 1000);
      }
      if (lastStopTransition?.at) summary.lastStopAt = lastStopTransition.at;
      return json(res, 200, {
        ...summary,
        transitions: rangeStateTransitions,
        configured: config.fuelCellEnabled !== false,
        estimateNotice: "All costs and savings are estimates. Check your provider statement for accurate billing information.",
      });
    }
    if (req.method === "GET" && url.pathname === "/api/reports/ene-farm") {
      const config = await readConfig();
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const bucketParam = url.searchParams.get("bucket");
      if (!start || !end) return json(res, 400, { error: "start and end are required" });
      if (bucketParam !== null && bucketParam !== "" && bucketParam !== "day" && bucketParam !== "week" && bucketParam !== "month") {
        return json(res, 400, { error: "bucket must be day, week, or month" });
      }
      const rangeError = rangeParamError(url);
      if (rangeError) return json(res, 400, { error: rangeError });
      const bucket = normalizeReportBucket(bucketParam || "day");
      return json(res, 200, await eneFarmReport(start, end, bucket, config));
    }
    return false;
  };
}
