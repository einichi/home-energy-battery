import type { AppConfig, LoadingState, StatusSnapshot, SystemAlert } from "../api/contracts";

export type HealthSeverity = "healthy" | "attention" | "critical";
export type SystemHealth = { severity: HealthSeverity; label: string; detail: string; alerts: SystemAlert[] };

function statusErrors(status: StatusSnapshot | null): string[] {
  if (!status) return [];
  return [
    status.energy?.error,
    status.energy?.battery?.error,
    status.energy?.solar?.error,
    ...(status.energy?.fuel_cells ?? []).map((item) => item.error),
    ...(status.energy?.errors ?? []).map((item) => item.error),
    status.meter?.error,
    ...(status.meter?.errors ?? []).map((item) => item.error),
  ].filter((value): value is string => Boolean(value));
}

export function deriveSystemHealth(
  status: StatusSnapshot | null,
  config: AppConfig | null,
  loadingState: LoadingState,
  now = Date.now(),
): SystemHealth {
  if (loadingState === "error") {
    return { severity: "critical", label: "Service unavailable", detail: "Live status could not be refreshed", alerts: [{ id: "application-status", source: "Application", severity: "critical", title: "Live status unavailable", startedAt: new Date(now).toISOString(), impact: "The application could not refresh its local status API. Previously loaded values remain visible.", suggestedAction: "Check the application service and local network connection.", resolution: "active" }] };
  }
  if (!status?.read_at) {
    return { severity: "attention", label: "Connecting", detail: "Waiting for equipment readings", alerts: [] };
  }
  const activeAlerts = (status.alerts ?? []).filter((alert) => alert.resolution !== "resolved");
  if (activeAlerts.length) {
    const critical = activeAlerts.some((alert) => alert.severity === "critical");
    return {
      severity: critical ? "critical" : "attention",
      label: `${activeAlerts.length} active alert${activeAlerts.length === 1 ? "" : "s"}`,
      detail: activeAlerts[0].title,
      alerts: activeAlerts,
    };
  }
  if (status.energy?.battery?.configured === false) {
    return { severity: "attention", label: "Battery not configured", detail: "Configure equipment in System", alerts: [] };
  }
  const ageMs = now - new Date(status.read_at).getTime();
  const staleAfterMs = Math.max(30, (config?.updateIntervalSeconds ?? 15) * 3) * 1000;
  if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) {
    return { severity: "attention", label: "Readings stale", detail: "The last equipment update is older than expected", alerts: [{ id: "stale-readings", source: "Device", severity: "warning", title: "Equipment readings are stale", startedAt: status.read_at, impact: "Displayed measurements are last-known values and may no longer represent current conditions.", suggestedAction: "Review equipment connectivity and the application service.", href: "/system/equipment", resolution: "active" }] };
  }
  const errors = statusErrors(status);
  if (errors.length) {
    return {
      severity: "attention",
      label: `${errors.length} equipment issue${errors.length === 1 ? "" : "s"}`,
      detail: errors[0],
      alerts: [],
    };
  }
  return { severity: "healthy", label: "System normal", detail: "All configured equipment is reporting", alerts: [] };
}
