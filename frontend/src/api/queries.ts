import { getJson } from "./client";
import type { AppConfig, HistoryResponse, StatusSnapshot } from "./contracts";

export function getConfig(signal?: AbortSignal) {
  return getJson<AppConfig>("/api/config", signal);
}

export function getStatus(signal?: AbortSignal) {
  return getJson<StatusSnapshot>("/api/status", signal);
}

export function getHistory(start: Date, end: Date, signal?: AbortSignal) {
  const search = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  return getJson<HistoryResponse>(`/api/history?${search}`, signal);
}
