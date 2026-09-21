type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned an invalid object`);
  return value as JsonObject;
}

function optionalString(value: unknown, label: string) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function optionalNumber(value: unknown, label: string) {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be a finite number`);
}

function validateHistorySummary(value: unknown) {
  const summary = object(value, "History summary");
  for (const key of ["sampleCount", "houseDemandKwh", "solarGenerationKwh", "gridImportKwh", "gridExportKwh", "guardTriggerCount"] as const) {
    optionalNumber(summary[key], `History summary ${key}`);
  }
  if (summary.energySources !== undefined) object(summary.energySources, "Energy sources");
  if (summary.circuits !== undefined && !Array.isArray(summary.circuits)) throw new Error("History summary circuits must be an array");
}

export function validateApiPayload(url: string, payload: unknown, method = "GET") {
  const pathname = new URL(url, window.location.origin).pathname;
  if (method === "GET" && (pathname === "/api/automation-rules" || pathname === "/api/schedules")) {
    if (!Array.isArray(payload)) throw new Error(`${pathname} returned an invalid list`);
    return;
  }
  const value = object(payload, pathname);
  if (pathname === "/api/config") {
    optionalNumber(value.updateIntervalSeconds, "Refresh interval");
    optionalString(value.language, "Language");
    if (value.dashboardWidgets !== undefined && !Array.isArray(value.dashboardWidgets)) throw new Error("Dashboard widgets must be an array");
  } else if (pathname === "/api/status") {
    optionalString(value.read_at, "Status timestamp");
    if (value.energy !== undefined) object(value.energy, "Energy status");
    if (value.meter !== undefined) object(value.meter, "Meter status");
    if (value.alerts !== undefined) {
      if (!Array.isArray(value.alerts)) throw new Error("System alerts must be an array");
      value.alerts.forEach((entry, index) => {
        const alert = object(entry, `System alert ${index + 1}`);
        optionalString(alert.id, `System alert ${index + 1} id`);
        optionalString(alert.source, `System alert ${index + 1} source`);
        optionalString(alert.severity, `System alert ${index + 1} severity`);
        optionalString(alert.title, `System alert ${index + 1} title`);
        optionalString(alert.startedAt, `System alert ${index + 1} start time`);
        optionalString(alert.impact, `System alert ${index + 1} impact`);
        optionalString(alert.suggestedAction, `System alert ${index + 1} suggested action`);
        optionalString(alert.resolution, `System alert ${index + 1} resolution`);
      });
    }
  } else if (pathname === "/api/history") {
    if (!Array.isArray(value.samples)) throw new Error("History samples must be an array");
    validateHistorySummary(value.summary);
  } else if (pathname === "/api/history/summary") {
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
