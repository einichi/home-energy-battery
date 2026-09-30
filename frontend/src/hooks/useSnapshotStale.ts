import { useEffect, useState } from "react";

export function useSnapshotStale(timestamp?: string | null, intervalSeconds = 15) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), Math.max(5, intervalSeconds) * 1000);
    return () => window.clearInterval(timer);
  }, [intervalSeconds]);
  const observedAt = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  return Number.isFinite(observedAt) && now - observedAt > Math.max(30, intervalSeconds * 3) * 1000;
}
