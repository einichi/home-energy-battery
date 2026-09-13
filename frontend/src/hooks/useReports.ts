import { useCallback, useEffect, useState } from "react";
import type { EneFarmReport, EnergyReport } from "../api/contracts";
import { getEneFarmReport, getEnergyReport } from "../api/queries";

export type ReportBucket = "day" | "week" | "month";

export function useReports(start: Date, end: Date, bucket: ReportBucket) {
  const [energy, setEnergy] = useState<EnergyReport | null>(null);
  const [eneFarm, setEneFarm] = useState<EneFarmReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(0);
  const [sequence, setSequence] = useState(0);
  const key = `${start.toISOString()}:${end.toISOString()}:${bucket}:${sequence}`;

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      getEnergyReport(start, end, bucket, controller.signal),
      getEneFarmReport(start, end, bucket, controller.signal),
    ]).then(([energyResult, eneFarmResult]) => {
      if (controller.signal.aborted) return;
      if (energyResult.status === "fulfilled") setEnergy(energyResult.value);
      if (eneFarmResult.status === "fulfilled") setEneFarm(eneFarmResult.value);
      const failures = [energyResult, eneFarmResult].filter((item) => item.status === "rejected") as PromiseRejectedResult[];
      setError(failures.length ? failures.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)).join("; ") : null);
      setSettled(sequence + 1);
    });
    return () => controller.abort();
  }, [key, start, end, bucket, sequence]);

  return { energy, eneFarm, error, loading: settled !== sequence + 1, refresh: useCallback(() => setSequence((value) => value + 1), []) };
}
