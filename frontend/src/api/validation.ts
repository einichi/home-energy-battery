import * as v from "valibot";
import { AppConfigSchema, HistoryResponseSchema, StatusSnapshotSchema } from "../../../shared/api-schemas";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned an invalid object`);
  return value as JsonObject;
}

function optionalNumber(value: unknown, label: string) {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be a finite number`);
}

function validateHistorySummary(value: unknown) {
  const summary = object(value, "History summary");
  for (const key of ["sampleCount", "branchDemandKwh", "solarGenerationKwh", "gridImportKwh", "gridExportKwh", "guardTriggerCount"] as const) {
    optionalNumber(summary[key], `History summary ${key}`);
  }
  if (summary.energySources !== undefined) object(summary.energySources, "Energy sources");
  if (summary.circuits !== undefined && !Array.isArray(summary.circuits)) throw new Error("History summary circuits must be an array");
}

export function validateApiPayload(url: string, payload: unknown, method = "GET") {
  const pathname = new URL(url, window.location.origin).pathname;
  const schema = pathname === "/api/config"
    ? AppConfigSchema
    : pathname === "/api/status"
      ? StatusSnapshotSchema
      : pathname === "/api/history"
        ? HistoryResponseSchema
        : null;
  if (schema) {
    // Validate without replacing the original payload: unknown response fields are intentionally preserved for consumers.
    const result = v.safeParse(schema, payload);
    if (!result.success) {
      const issue = result.issues[0];
      const path = issue?.path?.map((item) => String(item.key)).join(".");
      throw new Error(`${pathname} returned an invalid payload${path ? ` at ${path}` : ""}: ${issue?.message ?? "schema mismatch"}`);
    }
    return;
  }
  if (method === "GET" && (pathname === "/api/automation-rules" || pathname === "/api/schedules")) {
    if (!Array.isArray(payload)) throw new Error(`${pathname} returned an invalid list`);
    return;
  }
  const value = object(payload, pathname);
  if (pathname === "/api/history/summary") {
    validateHistorySummary(value);
  } else if (pathname.startsWith("/api/reports/")) {
    if (!Array.isArray(value.buckets)) throw new Error("Report buckets must be an array");
    object(value.totals, "Report totals");
  } else if (pathname === "/api/ene-farm") {
    optionalNumber(value.sampleCount, "Ene-Farm sample count");
    if (value.stateIntervals !== undefined && !Array.isArray(value.stateIntervals)) throw new Error("Ene-Farm state intervals must be an array");
  } else if (pathname === "/api/command-receipts") {
    if (!Array.isArray(value.receipts)) throw new Error("Command receipts must be an array");
  }
}
