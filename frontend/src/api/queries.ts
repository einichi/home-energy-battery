import { getJson, sendJson } from "./client";
import type { AppConfig, EneFarmSummary, HistoryResponse, StatusSnapshot } from "./contracts";

export function getConfig(signal?: AbortSignal) {
  return getJson<AppConfig>("/api/config", signal);
}

export function updateConfig(config: AppConfig) {
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
