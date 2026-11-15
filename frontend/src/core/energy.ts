import type { EnergySample, StatusSnapshot } from "../api/contracts";
import { metricValue } from "./format";

export function liveFuelCellPower(status: StatusSnapshot | null): number | null {
  const cells = status?.energy?.fuel_cells ?? [];
  const primary = cells.find((cell) => cell.source_role === "primary") ?? cells[0];
  return metricValue(primary?.instant_power) ??
    cells.map((cell) => metricValue(cell.instant_power)).find((value) => value !== null) ?? null;
}

export function statusToEnergySample(status: StatusSnapshot | null): EnergySample | null {
  if (!status?.read_at || !Number.isFinite(new Date(status.read_at).getTime())) return null;
  const fuelCells = status.energy?.fuel_cells ?? [];
  const fuelCell = fuelCells.find((item) => item.source_role === "primary") ?? fuelCells[0];
  const circuitPowerW = Object.fromEntries(
    (status.meter?.channel_power?.decoded?.channels ?? []).map((item) => [String(item.channel), metricValue({ value: item.value })]),
  );
  return {
    timestamp: status.read_at,
    batteryPowerW: metricValue(status.energy?.battery?.instant_power),
    stateOfChargePercent: metricValue(status.energy?.battery?.remaining_percent),
    solarPowerW: metricValue(status.energy?.solar?.instant_power),
    branchDemandW: metricValue(status.meter?.branch_demand_power),
    fuelCellPowerW: liveFuelCellPower(status),
    fuelCellHotWaterLevel: metricValue(fuelCell?.hot_water_level),
    gridImportW: metricValue(status.meter?.grid_import_power),
    gridExportW: metricValue(status.meter?.grid_export_power),
    circuitPowerW,
  };
}

export function withLatestStatus(samples: EnergySample[], status: StatusSnapshot | null): EnergySample[] {
  const latest = statusToEnergySample(status);
  if (!latest) return samples;
  const existingIndex = samples.findIndex((sample) => sample.timestamp === latest.timestamp);
  if (existingIndex >= 0 && status?.statusDetailsPending) return samples;
  if (existingIndex >= 0) return samples.map((sample, index) => index === existingIndex ? { ...sample, ...latest } : sample);
  return [...samples, latest].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
