export interface BatteryLearningRollupOptions {
  startSoc?: number;
  endSoc?: number;
  energyWh?: number;
  coverageSeconds?: number;
  manualAction?: boolean;
}

export function batteryLearningRollup(
  day: number,
  kind: "charge" | "discharge",
  {
    startSoc = kind === "charge" ? 10 : 40,
    endSoc = kind === "charge" ? 30 : 20,
    energyWh = 1000,
    coverageSeconds = 1800,
    manualAction = false,
  }: BatteryLearningRollupOptions = {},
) {
  const start = new Date(`2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 1_800_000);
  return {
    rollupStart: start.toISOString(),
    rollupEnd: end.toISOString(),
    startStateOfChargePercent: startSoc,
    endStateOfChargePercent: endSoc,
    batteryChargeKwh: kind === "charge" ? energyWh / 1000 : 0,
    batteryDischargeKwh: kind === "discharge" ? energyWh / 1000 : 0,
    coverageSeconds: {
      [kind === "charge" ? "batteryChargeKwh" : "batteryDischargeKwh"]: coverageSeconds,
    },
    manualAction,
  };
}

export function chronologicalSlot(
  hour: number,
  band: (Pick<RateBand, "label" | "yenPerKwh"> & Partial<RateBand>) | null,
  netKwh = 0,
  highSolarNetKwh = netKwh,
) {
  const startMs = Date.parse("2026-07-12T00:00:00.000Z") + hour * 3_600_000;
  return {
    startMs,
    endMs: startMs + 30 * 60_000,
    band,
    demandW: 1000,
    netKwh,
    highSolarNetKwh,
    chargeCapacityKwh: band ? 1 : 0,
  };
}
import type { RateBand } from "../../lib/contracts/configuration.js";
