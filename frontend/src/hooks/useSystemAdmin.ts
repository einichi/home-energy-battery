import { useCallback, useEffect, useState } from "react";
import type { DatabaseBackupsView, HistoryStats, NotificationView } from "../api/contracts";
import { getDatabaseBackups, getHistoryStats, getNotifications } from "../api/system";

export function useSystemAdmin() {
  const [notifications, setNotifications] = useState<NotificationView | null>(null);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [backups, setBackups] = useState<DatabaseBackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState(0);
  const refresh = useCallback(() => setSequence((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([getNotifications(controller.signal), getHistoryStats(controller.signal), getDatabaseBackups(controller.signal)]).then(([notificationResult, statsResult, backupsResult]) => {
      if (controller.signal.aborted) return;
      if (notificationResult.status === "fulfilled") setNotifications(notificationResult.value);
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      if (backupsResult.status === "fulfilled") setBackups(backupsResult.value);
      const errors = [notificationResult, statsResult, backupsResult].filter((item) => item.status === "rejected") as PromiseRejectedResult[];
      setError(errors.length ? errors.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)).join("; ") : null);
    });
    return () => controller.abort();
  }, [sequence]);
  useEffect(() => {
    if (!backups?.operation?.busy) return;
    const timer = window.setInterval(() => setSequence((value) => value + 1), 750);
    return () => window.clearInterval(timer);
  }, [backups?.operation?.busy]);
  return { notifications, setNotifications, stats, setStats, backups, setBackups, error, refresh };
}
