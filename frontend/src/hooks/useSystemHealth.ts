import { useMemo } from "react";
import { deriveSystemHealth } from "../core/health";
import { useEnergyStatus } from "./useEnergyStatus";

export function useSystemHealth() {
  const { status, config, loadingState } = useEnergyStatus();
  return useMemo(
    () => deriveSystemHealth(status, config, loadingState),
    [status, config, loadingState],
  );
}
