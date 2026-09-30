import { useCallback, useEffect, useState } from "react";
import type { EneFarmSummary } from "../api/contracts";
import { getEneFarm } from "../api/queries";

export function useEneFarm(milliseconds: number, fixedStart?: string, fixedEnd?: string, refreshKey?: string) {
  const [summary, setSummary] = useState<EneFarmSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settledRequest, setSettledRequest] = useState("");
  const [settledRange, setSettledRange] = useState("");
  const [sequence, setSequence] = useState(0);
  const rangeKey = `${milliseconds}:${fixedStart ?? ""}:${fixedEnd ?? ""}`;
  const requestKey = `${rangeKey}:${refreshKey ?? ""}:${sequence}`;

  useEffect(() => {
    const controller = new AbortController();
    const end = fixedEnd ? new Date(fixedEnd) : new Date();
    const start = fixedStart ? new Date(fixedStart) : new Date(end.getTime() - milliseconds);
    getEneFarm(start, end, controller.signal)
      .then((next) => { setSummary(next); setError(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setSummary(null); setError(reason instanceof Error ? reason.message : "Ene-Farm data could not be loaded"); } })
      .finally(() => { if (!controller.signal.aborted) { setSettledRequest(requestKey); setSettledRange(rangeKey); } });
    return () => controller.abort();
  }, [milliseconds, fixedStart, fixedEnd, rangeKey, requestKey]);

  return { summary, error: settledRequest === requestKey ? error : null, loading: settledRequest !== requestKey, rangeLoading: settledRange !== rangeKey, refresh: useCallback(() => setSequence((value) => value + 1), []) };
}
