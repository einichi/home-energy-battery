import type { AppConfig, LoadingState, StatusSnapshot } from "../api/contracts";

export type HealthSeverity = "healthy" | "attention" | "critical";
export type SystemHealth = { severity: HealthSeverity; label: string; detail: string };

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
    return { severity: "critical", label: "Service unavailable", detail: "Live status could not be refreshed" };
  }
  if (!status?.read_at) {
    return { severity: "attention", label: "Connecting", detail: "Waiting for equipment readings" };
  }
  if (status.energy?.battery?.configured === false) {
    return { severity: "attention", label: "Battery not configured", detail: "Configure equipment in System" };
  }
  const ageMs = now - new Date(status.read_at).getTime();
  const staleAfterMs = Math.max(30, (config?.updateIntervalSeconds ?? 15) * 3) * 1000;
  if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) {
    return { severity: "attention", label: "Readings stale", detail: "The last equipment update is older than expected" };
  }
  const errors = statusErrors(status);
  if (errors.length) {
    return {
      severity: "attention",
      label: `${errors.length} equipment issue${errors.length === 1 ? "" : "s"}`,
      detail: errors[0],
    };
  }
  return { severity: "healthy", label: "System normal", detail: "All configured equipment is reporting" };
}
