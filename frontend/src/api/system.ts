import { getJson, sendJson } from "./client";
import type { DatabaseBackupsView, DiscoveryJob, HistoryStats, NotificationView } from "./contracts";

export const getNotifications = (signal?: AbortSignal) => getJson<NotificationView>("/api/notifications", signal);
export const saveNotifications = (body: unknown) => sendJson<NotificationView>("/api/notifications", "PUT", body);
export const testNotifications = () => sendJson<NotificationView>("/api/notifications/test", "POST", {});
export const getHistoryStats = (signal?: AbortSignal) => getJson<HistoryStats>("/api/history/stats", signal);
export const trimHistory = (retention: unknown) => sendJson<HistoryStats>("/api/history/trim", "POST", { retention });
export const getDatabaseBackups = (signal?: AbortSignal) => getJson<DatabaseBackupsView>("/api/database-backups", signal);
export const createDatabaseBackup = () => sendJson<DatabaseBackupsView>("/api/database-backups", "POST", {});
export const deleteDatabaseBackup = (filename: string) => sendJson<DatabaseBackupsView>(`/api/database-backups/${encodeURIComponent(filename)}`, "DELETE");
export const restoreDatabaseBackup = (filename: string) => sendJson<DatabaseBackupsView>(`/api/database-backups/${encodeURIComponent(filename)}/restore`, "POST", {});
export const startDiscovery = (mode: "broadcast" | "active") => sendJson<DiscoveryJob>("/api/discovery/jobs", "POST", { mode });
export const getDiscoveryJob = (id: string, signal?: AbortSignal) => getJson<DiscoveryJob>(`/api/discovery/jobs/${encodeURIComponent(id)}`, signal);
export const importGasTariff = (billingMonth: string) => sendJson<{ billingMonth: string; version?: number }>("/api/gas-tariffs/import", "POST", { provider: "tokyo-gas", billingMonth });
