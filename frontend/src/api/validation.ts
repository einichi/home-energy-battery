import * as v from "valibot";
import {
  AppConfigSchema,
  AutomationRulesResponseSchema,
  CommandReceiptsResponseSchema,
  EneFarmReportSchema,
  EneFarmSummarySchema,
  EnergyReportSchema,
  HistoryResponseSchema,
  HistorySummarySchema,
  SchedulesResponseSchema,
  StatusSnapshotSchema,
} from "../../../shared/api-schemas";

function assertValid(schema: v.GenericSchema, pathname: string, payload: unknown) {
  const result = v.safeParse(schema, payload);
  if (!result.success) {
    const issue = result.issues[0];
    const path = issue?.path?.map((item) => String(item.key)).join(".");
    throw new Error(`${pathname} returned an invalid payload${path ? ` at ${path}` : ""}: ${issue?.message ?? "schema mismatch"}`);
  }
}

export function validateApiPayload(url: string, payload: unknown, method = "GET") {
  const pathname = new URL(url, window.location.origin).pathname;
  const schema = pathname === "/api/config"
    ? AppConfigSchema
    : pathname === "/api/status"
      ? StatusSnapshotSchema
      : pathname === "/api/history"
      ? HistoryResponseSchema
        : pathname === "/api/history/summary"
          ? HistorySummarySchema
          : pathname === "/api/reports/energy"
            ? EnergyReportSchema
            : pathname === "/api/reports/ene-farm"
              ? EneFarmReportSchema
              : pathname === "/api/ene-farm"
                ? EneFarmSummarySchema
                : pathname.startsWith("/api/command-receipts")
                  ? CommandReceiptsResponseSchema
                  : method === "GET" && pathname === "/api/automation-rules"
                    ? AutomationRulesResponseSchema
                    : method === "GET" && pathname === "/api/schedules"
                      ? SchedulesResponseSchema
                      : null;
  if (schema) {
    // Validate without replacing the original payload: unknown response fields are intentionally preserved for consumers.
    assertValid(schema, pathname, payload);
  }
}
