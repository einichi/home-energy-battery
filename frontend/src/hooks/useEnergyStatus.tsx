import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfig, LoadingState, StatusSnapshot } from "../api/contracts";
import { getConfig, getStatus } from "../api/queries";

type EnergyStatusContextValue = {
  config: AppConfig | null;
  status: StatusSnapshot | null;
  loadingState: LoadingState;
  manualRefreshing: boolean;
  error: string | null;
  refresh: () => void;
  replaceConfig: (config: AppConfig) => void;
};

const EnergyStatusContext = createContext<EnergyStatusContextValue | null>(null);

export function EnergyStatusProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const latestRequest = useRef(0);
  const manualRefreshQueued = useRef(false);

  const refresh = useCallback(() => {
    manualRefreshQueued.current = true;
    setManualRefreshing(true);
    setRefreshSequence((sequence) => sequence + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let stopped = false;
    const load = () => {
      getConfig(controller.signal)
        .then((next) => {
          if (stopped) return;
          setConfig(next);
          setConfigError(null);
        })
        .catch((reason: unknown) => {
          if (stopped || controller.signal.aborted) return;
          setConfigError(reason instanceof Error ? reason.message : "Configuration request failed");
          timer = window.setTimeout(load, 5000);
        });
    };
    load();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let stopped = false;

    const poll = async () => {
      const isManualRefresh = manualRefreshQueued.current;
      manualRefreshQueued.current = false;
      const request = ++latestRequest.current;
      controller?.abort();
      controller = new AbortController();
      setLoadingState((current) => current === "loading" ? current : "refreshing");
      try {
        const next = await getStatus(controller.signal);
        if (stopped || request !== latestRequest.current) return;
        setStatus(next);
        setStatusError(null);
        setLoadingState("ready");
      } catch (reason) {
        if (stopped || controller.signal.aborted || request !== latestRequest.current) return;
        setStatusError(reason instanceof Error ? reason.message : "Status request failed");
        setLoadingState("error");
      } finally {
        if (isManualRefresh) setManualRefreshing(false);
        if (!stopped) {
          const interval = Math.max(5, config?.updateIntervalSeconds ?? 15) * 1000;
          timer = window.setTimeout(poll, document.hidden ? Math.max(interval, 300_000) : interval);
        }
      }
    };

    void poll();
    const handleVisibility = () => {
      if (!document.hidden) {
        if (timer) window.clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [config?.updateIntervalSeconds, refreshSequence]);

  const value = useMemo<EnergyStatusContextValue>(() => ({
    config,
    status,
    loadingState,
    manualRefreshing,
    error: statusError ?? configError,
    refresh,
    replaceConfig: setConfig,
  }), [config, status, loadingState, manualRefreshing, statusError, configError, refresh]);

  return <EnergyStatusContext.Provider value={value}>{children}</EnergyStatusContext.Provider>;
}

export function useEnergyStatus() {
  const value = useContext(EnergyStatusContext);
  if (!value) throw new Error("useEnergyStatus must be used inside EnergyStatusProvider");
  return value;
}
