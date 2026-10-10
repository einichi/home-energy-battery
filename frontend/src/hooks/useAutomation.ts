import { useCallback, useEffect, useState } from "react";
import { getAdaptiveCharging, getAutomationRules, getAwayPeriods } from "../api/automation";
import { getCommandReceipts } from "../api/battery";
import type { AdaptiveChargingStatus, AutomationRule, AwayPeriodsView, CommandReceipt } from "../api/contracts";
import { useEnergyStatus } from "./useEnergyStatus";

const emptyAway: AwayPeriodsView = { periods: [], active: null, next: null, state: "home" };

export function useAutomation() {
  const { config } = useEnergyStatus();
  const [adaptive, setAdaptive] = useState<AdaptiveChargingStatus | null>(null);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [away, setAway] = useState<AwayPeriodsView>(emptyAway);
  const [receipts, setReceipts] = useState<CommandReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState(0);

  const refresh = useCallback(() => {
    setSequence((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const [nextAdaptive, nextRules, nextAway, nextReceipts] = await Promise.all([
          getAdaptiveCharging(controller.signal),
          getAutomationRules(controller.signal),
          getAwayPeriods(controller.signal),
          getCommandReceipts(controller.signal),
        ]);
        if (stopped) return;
        setAdaptive(nextAdaptive);
        setRules(nextRules);
        setAway(nextAway);
        setReceipts(nextReceipts.receipts);
        setError(null);
      } catch (reason) {
        if (!stopped && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Automation status request failed");
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

  return { adaptive, rules, away, receipts, error, refresh };
}
