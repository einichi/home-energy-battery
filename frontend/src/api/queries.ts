import { getJson, sendJson } from "./client";
import type { AppConfig, EneFarmReport, EneFarmSummary, EnergyReport, HistoryResponse, StatusSnapshot } from "./contracts";

export function getConfig(signal?: AbortSignal) {
  return getJson<AppConfig>("/api/config", signal);
}

export function updateConfig(config: Partial<AppConfig>) {
  return sendJson<AppConfig>("/api/config", "PUT", config);
}

export function getStatus(signal?: AbortSignal) {
  return getJson<StatusSnapshot>("/api/status", signal);
}

export function getHistory(start: Date, end: Date, signal?: AbortSignal) {
  const search = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  return getJson<HistoryResponse>(`/api/history?${search}`, signal);
}

export function getEneFarm(start: Date, end: Date, signal?: AbortSignal) {
  const search = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  return getJson<EneFarmSummary>(`/api/ene-farm?${search}`, signal);
}

export function getEnergyReport(start: Date, end: Date, bucket: "day" | "week" | "month", signal?: AbortSignal) {
  const search = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), bucket });
  return getJson<EnergyReport>(`/api/reports/energy?${search}`, signal);
}

export function getEneFarmReport(start: Date, end: Date, bucket: "day" | "week" | "month", signal?: AbortSignal) {
  const search = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), bucket });
  return getJson<EneFarmReport>(`/api/reports/ene-farm?${search}`, signal);
}
