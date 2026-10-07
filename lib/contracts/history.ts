export interface HistorySample {
  [key: string]: unknown;
  timestamp?: string;
  rollupStart?: string;
  rollupEnd?: string;
  startStateOfChargePercent?: number | null;
  endStateOfChargePercent?: number | null;
  minimumStateOfChargePercent?: number | null;
  rollupSampleCount?: number;
  expectedIntervalSeconds?: number;
  energyIntervalStart?: Record<string, string>;
  energyQuality?: Record<string, string>;
  coverageSeconds?: Record<string, number>;
  powerCoverageSeconds?: Record<string, number>;
  intervalAveragePowerW?: Record<string, number>;
  intervalAverageCircuitPowerW?: Record<string, number>;
  circuitPowerW?: Record<string, number | null>;
  circuitEnergyKwh?: Record<string, number | null>;
  circuitCumulativeKwh?: Record<string, number | null>;
  fuelCellCounterSourceHost?: string | null;
  fuelCellCumulativeGenerationKwh?: number | null;
  fuelCellCumulativeGasM3?: number | null;
  meterCounterSourceHost?: string | null;
  gridImportCumulativeKwh?: number | null;
  gridExportCumulativeKwh?: number | null;
  solarGenerationKwh?: number | null;
  solarPowerW?: number | null;
  gridImportKwh?: number | null;
  gridImportW?: number | null;
  gridExportKwh?: number | null;
  gridExportW?: number | null;
  houseDemandKwh?: number | null;
  houseDemandW?: number | null;
  fuelCellKwh?: number | null;
  fuelCellPowerW?: number | null;
  batteryChargeKwh?: number | null;
  batteryDischargeKwh?: number | null;
  batteryPowerW?: number | null;
  stateOfChargePercent?: number | null;
  rateYenPerKwh?: number | null;
  maximumRateYenPerKwh?: number | null;
  standardRateYenPerKwh?: number | null;
  solarSavingYen?: number | null;
  offPeakSavingYen?: number | null;
  peakHouseDemandW?: number | null;
  guardTriggerCount?: number | null;
  fuelCellGasM3?: number | null;
  fuelCellOperatingSeconds?: number | null;
  fuelCellStartCount?: number | null;
  fuelCellGenerationState?: string | null;
  fuelCellHotWaterLevel?: number | null;
  fuelCellDataQuality?: string | null;
  fuelCellSourceHost?: string | null;
  rateLabel?: string | null;
  calculationVersion?: number;
}

export interface TimeRange {
  startMs?: number;
  endMs?: number;
}

export type EnergyMetricKey =
  | "houseDemandKwh"
  | "solarGenerationKwh"
  | "gridImportKwh"
  | "gridExportKwh"
  | "fuelCellKwh"
  | "batteryChargeKwh"
  | "batteryDischargeKwh";
