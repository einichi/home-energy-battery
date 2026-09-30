import { useCallback, useEffect, useState } from "react";
import type { HistoryResponse } from "../api/contracts";
import { getHistory } from "../api/queries";

const emptyHistory: HistoryResponse = { samples: [], summary: {} };

export function useHistoryRange(milliseconds: number, refreshKey?: string, fixedStart?: string, fixedEnd?: string) {
  const [history, setHistory] = useState<HistoryResponse>(emptyHistory);
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
    getHistory(start, end, controller.signal)
      .then((next) => {
        setHistory({ samples: Array.isArray(next.samples) ? next.samples : [], summary: next.summary ?? {} });
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setHistory(emptyHistory);
          setError(reason instanceof Error ? reason.message : "History request failed");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSettledRequest(requestKey);
          setSettledRange(rangeKey);
        }
      });
    return () => controller.abort();
  }, [milliseconds, refreshKey, sequence, fixedStart, fixedEnd, rangeKey, requestKey]);

  return {
    history,
    loading: settledRequest !== requestKey,
    rangeLoading: settledRange !== rangeKey,
    error: settledRequest === requestKey ? error : null,
    refresh: useCallback(() => setSequence((value) => value + 1), []),
  };
}
