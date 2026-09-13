import { useCallback, useEffect, useState } from "react";
import type { EneFarmSummary } from "../api/contracts";
import { getEneFarm } from "../api/queries";

export function useEneFarm(milliseconds: number, fixedStart?: string) {
  const [summary, setSummary] = useState<EneFarmSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settledRequest, setSettledRequest] = useState("");
  const [sequence, setSequence] = useState(0);
  const requestKey = `${milliseconds}:${fixedStart ?? ""}:${sequence}`;

  useEffect(() => {
    const controller = new AbortController();
    const end = new Date();
    const start = fixedStart ? new Date(fixedStart) : new Date(end.getTime() - milliseconds);
    getEneFarm(start, end, controller.signal)
      .then((next) => { setSummary(next); setError(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Ene-Farm data could not be loaded"); })
      .finally(() => { if (!controller.signal.aborted) setSettledRequest(requestKey); });
    return () => controller.abort();
  }, [milliseconds, fixedStart, requestKey]);

  return { summary, error, loading: settledRequest !== requestKey, refresh: useCallback(() => setSequence((value) => value + 1), []) };
}
