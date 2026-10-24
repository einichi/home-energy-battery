import { useCallback, useEffect, useState } from "react";
import { getAwayReserve, setAwayReserve } from "../api/away-reserve";
import type { AwayReserveStatus } from "../api/contracts";

export function useAwayReserve(refreshKey?: string) {
  const [reserve, setReserve] = useState<AwayReserveStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sequence, setSequence] = useState(0);
  const refresh = useCallback(() => setSequence((current) => current + 1), []);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      controller = new AbortController();
      try {
        const result = await getAwayReserve(controller.signal);
        if (!stopped) { setReserve(result); setReadError(null); }
      } catch (reason) {
        if (!stopped) setReadError(reason instanceof Error ? reason.message : "Away reserve status is unavailable");
      } finally {
        if (!stopped) timer = window.setTimeout(load, 15_000);
      }
    };
    void load();
    return () => { stopped = true; controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [sequence, refreshKey]);
  const save = async (enabled: boolean) => {
    setSaving(true); setSaveError(null);
    try { setReserve(await setAwayReserve(enabled)); }
    catch (reason) { setSaveError(reason instanceof Error ? reason.message : "Away reserve could not be saved"); }
    finally { setSaving(false); refresh(); }
  };
  return { reserve, error: saveError ?? readError, saving, save, refresh };
}
