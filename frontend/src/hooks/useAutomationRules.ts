import { useCallback, useEffect, useRef, useState } from "react";
import { getAutomationRules } from "../api/automation";
import type { AutomationRule } from "../api/contracts";
import { useEnergyStatus } from "./useEnergyStatus";

/** Rules-only polling hook: keeps the last good rules on failure and exposes the error. */
export function useAutomationRules() {
  const { config } = useEnergyStatus();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState(0);
  const rulesRevision = useRef(0);

  const refresh = useCallback(() => {
    setSequence((value) => value + 1);
  }, []);

  const replaceRules = useCallback((nextRules: AutomationRule[]) => {
    rulesRevision.current += 1;
    setRules(nextRules);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      const revision = rulesRevision.current;
      try {
        const nextRules = await getAutomationRules(controller.signal);
        if (stopped || revision !== rulesRevision.current) return;
        setRules(nextRules);
        setError(null);
      } catch (reason) {
        if (!stopped && !controller.signal.aborted && revision === rulesRevision.current) setError(reason instanceof Error ? reason.message : "Automation rules request failed");
      } finally {
        if (!stopped) {
          const interval = Math.max(5, config?.updateIntervalSeconds ?? 15) * 1000;
          timer = window.setTimeout(poll, document.hidden ? Math.max(interval, 300_000) : interval);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [config?.updateIntervalSeconds, sequence]);

  return { rules, error, refresh, replaceRules };
}
