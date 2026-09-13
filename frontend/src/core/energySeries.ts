import type { EnergySample } from "../api/contracts";
import { formatPower } from "./format";

export type EnergySeriesKey =
  | "houseDemandW"
  | "solarPowerW"
  | "fuelCellPowerW"
  | "gridImportW"
  | "gridExportW"
  | "batteryPowerW"
  | "stateOfChargePercent"
  | "fuelCellHotWaterLevel";

export type SeriesDefinition = {
  label: string;
  color: string;
  axis: "power" | "percent";
  value: (sample: EnergySample) => number | null;
  display: (value: number) => string;
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

export const energySeries: Record<EnergySeriesKey, SeriesDefinition> = {
  houseDemandW: { label: "Demand", color: "var(--chart-demand)", axis: "power", value: (sample) => finite(sample.houseDemandW), display: formatPower },
  solarPowerW: { label: "Solar", color: "var(--solar)", axis: "power", value: (sample) => finite(sample.solarPowerW), display: formatPower },
  fuelCellPowerW: { label: "Ene-Farm", color: "var(--fuel-cell)", axis: "power", value: (sample) => finite(sample.fuelCellPowerW), display: formatPower },
  gridImportW: { label: "Grid import", color: "var(--grid)", axis: "power", value: (sample) => finite(sample.gridImportW), display: formatPower },
  gridExportW: { label: "Grid export", color: "var(--chart-export)", axis: "power", value: (sample) => finite(sample.gridExportW), display: formatPower },
  batteryPowerW: { label: "Battery", color: "var(--battery)", axis: "power", value: (sample) => finite(sample.batteryPowerW), display: formatPower },
  stateOfChargePercent: { label: "Battery SOC", color: "var(--chart-soc)", axis: "percent", value: (sample) => finite(sample.stateOfChargePercent), display: (value) => `${Math.round(value)}%` },
  fuelCellHotWaterLevel: {
    label: "Hot water",
    color: "var(--chart-hot-water)",
    axis: "percent",
    value: (sample) => {
      const value = finite(sample.fuelCellHotWaterLevel);
      return value === null ? null : value * 20;
    },
    display: (value) => `${Math.round(value / 20)}/5`,
  },
};
