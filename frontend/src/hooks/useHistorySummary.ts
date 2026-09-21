import { useCallback, useEffect, useState } from "react";
import type { HistorySummary } from "../api/contracts";
import { getHistorySummary } from "../api/queries";

export function useHistorySummary(milliseconds: number, fixedStart?: string) {
  const [summary, setSummary] = useState<HistorySummary>({});
  const [error, setError] = useState<string | null>(null);
  const [settledRequest, setSettledRequest] = useState("");
  const [sequence, setSequence] = useState(0);
  const requestKey = `${milliseconds}:${fixedStart ?? ""}:${sequence}`;

  useEffect(() => {
    const controller = new AbortController();
    const end = new Date();
    const start = fixedStart ? new Date(fixedStart) : new Date(end.getTime() - milliseconds);
    getHistorySummary(start, end, controller.signal)
      .then((next) => {
        setSummary(next ?? {});
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "History summary request failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettledRequest(requestKey);
      });
    return () => controller.abort();
  }, [milliseconds, fixedStart, requestKey]);

  return {
    summary,
    loading: settledRequest !== requestKey,
    error,
    refresh: useCallback(() => setSequence((value) => value + 1), []),
  };
}
