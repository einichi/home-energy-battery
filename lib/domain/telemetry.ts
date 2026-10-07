import { COUNTER_POLICIES, cumulativeCounterDeltaResult } from "../counter-utils.js";
import { circuitChannelMap, circuitCumulativeMap } from "./circuits.js";
import { maxDailyRate, rateForTimestamp } from "./tariffs.js";
import { finiteNumberOrNull } from "./numbers.js";
import type { RateBand } from "../contracts/configuration.js";
import type { HistorySample } from "../contracts/history.js";

interface Metric {
  value?: unknown;
  human?: unknown;
  decoded?: { channels?: Array<{ channel?: unknown; value?: unknown }> };
}

interface TelemetryConfig {
  solarEnabled?: boolean;
  fuelCellEnabled?: boolean;
  smartCosmoEnabled?: boolean;
  meterHost?: string;
  rateBands?: RateBand[];
  standardRateYenPerKwh?: number;
  updateIntervalSeconds?: number;
}

interface FuelCellStatus {
  source_role?: string;
  host?: string;
  instant_power?: Metric;
  generation_status?: Metric;
  rated_power?: Metric;
  cumulative_generation?: Metric;
  cumulative_gas?: Metric;
  hot_water_level?: Metric;
  interconnection_status?: Metric;
}

interface LiveStatus {
  read_at?: string;
  energy?: {
    battery?: { instant_power?: Metric; remaining_percent?: Metric };
    solar?: { instant_power?: Metric };
    fuel_cells?: FuelCellStatus[];
  };
  meter?: {
    house_demand_power?: Metric;
    grid_import_power?: Metric;
    grid_export_power?: Metric;
    cumulative_bought?: Metric;
    cumulative_sold?: Metric;
    channel_power?: Metric;
    channel_energy?: Metric;
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metric(value: unknown): Metric {
  const source = objectRecord(value);
  const decoded = objectRecord(source.decoded);
  const channels = Array.isArray(decoded.channels)
    ? decoded.channels.map((channel) => objectRecord(channel))
    : undefined;
  return {
    value: source.value,
    human: source.human,
    ...(channels ? { decoded: { channels } } : {}),
  };
}

function fuelCellStatus(value: unknown): FuelCellStatus {
  const source = objectRecord(value);
  return {
    source_role: typeof source.source_role === "string" ? source.source_role : undefined,
    host: typeof source.host === "string" ? source.host : undefined,
    instant_power: metric(source.instant_power),
    generation_status: metric(source.generation_status),
    rated_power: metric(source.rated_power),
    cumulative_generation: metric(source.cumulative_generation),
    cumulative_gas: metric(source.cumulative_gas),
    hot_water_level: metric(source.hot_water_level),
    interconnection_status: metric(source.interconnection_status),
  };
}

function liveStatus(value: unknown): LiveStatus {
  const source = objectRecord(value);
  const energy = objectRecord(source.energy);
  const battery = objectRecord(energy.battery);
  const solar = objectRecord(energy.solar);
  const meter = objectRecord(source.meter);
  return {
    read_at: typeof source.read_at === "string" ? source.read_at : undefined,
    energy: {
      battery: { instant_power: metric(battery.instant_power), remaining_percent: metric(battery.remaining_percent) },
      solar: { instant_power: metric(solar.instant_power) },
      fuel_cells: Array.isArray(energy.fuel_cells) ? energy.fuel_cells.map(fuelCellStatus) : [],
    },
    meter: {
      house_demand_power: metric(meter.house_demand_power),
      grid_import_power: metric(meter.grid_import_power),
      grid_export_power: metric(meter.grid_export_power),
      cumulative_bought: metric(meter.cumulative_bought),
      cumulative_sold: metric(meter.cumulative_sold),
      channel_power: metric(meter.channel_power),
      channel_energy: metric(meter.channel_energy),
    },
  };
}

export interface TelemetryHistorySample extends HistorySample {
  timestamp: string;
  circuitPowerW: Record<string, number>;
  circuitCumulativeKwh: Record<string, number>;
  circuitEnergyKwh: Record<string, number>;
  fuelCellCounterIssues: Array<{ counter: string; issue: string }>;
  circuitCounterIssues: Array<{ channel: number; issue: unknown }>;
}

export function numericMetric(item: Metric | null | undefined): number | null {
  if (item?.value === null || item?.value === undefined || item.value === "" || typeof item.value === "boolean") return null;
  const value = Number(item?.value);
  return Number.isFinite(value) ? value : null;
}


export function primaryFuelCell(fuelCells: FuelCellStatus[] = []): FuelCellStatus | null {
  return fuelCells.find((cell) => cell.source_role === "primary") ?? null;
}


export function selectedFuelCellReading(fuelCells: FuelCellStatus[] = []): FuelCellStatus | null {
  const primary = primaryFuelCell(fuelCells);
  if (numericMetric(primary?.instant_power) !== null || primary?.generation_status?.value) return primary;
  return fuelCells.find((cell) => cell.source_role === "proxy" && (numericMetric(cell.instant_power) !== null || cell.generation_status?.value)) ?? primary;
}


export function sampleFromStatus(
  input: unknown,
  config: TelemetryConfig,
  previousSample: Partial<HistorySample> | null = null,
): TelemetryHistorySample {
  const status = liveStatus(input);
  // Convert the large live status payload into one compact time-series sample.
  // We store only normalized values that graphs and savings calculations need.
  const timestamp = status.read_at ?? new Date().toISOString();
  const previousTimestamp = previousSample?.timestamp ?? null;
  const elapsedSeconds = previousTimestamp
    ? Math.max(0, (new Date(timestamp).getTime() - new Date(previousTimestamp).getTime()) / 1000)
    : 0;
  const batteryPowerW = numericMetric(status.energy?.battery?.instant_power);
  const solarPowerW = config.solarEnabled === false ? null : numericMetric(status.energy?.solar?.instant_power);
  const fuelCells = config.fuelCellEnabled === false ? [] : (status.energy?.fuel_cells ?? []);
  const fuelCellReading = selectedFuelCellReading(fuelCells);
  const fuelCellPrimary = primaryFuelCell(fuelCells);
  const fuelCellPowerW = numericMetric(fuelCellReading?.instant_power);
  const fuelCellGenerationStateValue = fuelCellReading?.generation_status?.value;
  const fuelCellGenerationState = typeof fuelCellGenerationStateValue === "string" ? fuelCellGenerationStateValue : null;
  const fuelCellRatedPowerW = numericMetric(fuelCellPrimary?.rated_power);
  const fuelCellCumulativeGenerationKwh = numericMetric(fuelCellPrimary?.cumulative_generation);
  const fuelCellCumulativeGasM3 = numericMetric(fuelCellPrimary?.cumulative_gas);
  const fuelCellHotWaterLevel = numericMetric(fuelCellPrimary?.hot_water_level);
  const counterSourceHost = fuelCellCumulativeGenerationKwh !== null || fuelCellCumulativeGasM3 !== null
    ? fuelCellPrimary?.host ?? null
    : null;
  const sameCounterSource = counterSourceHost && counterSourceHost === previousSample?.fuelCellCounterSourceHost;
  const electricityCounter = sameCounterSource
    ? cumulativeCounterDeltaResult(
      fuelCellCumulativeGenerationKwh,
      previousSample?.fuelCellCumulativeGenerationKwh,
      COUNTER_POLICIES.fuelCellElectricity,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const gasCounter = sameCounterSource
    ? cumulativeCounterDeltaResult(
      fuelCellCumulativeGasM3,
      previousSample?.fuelCellCumulativeGasM3,
      COUNTER_POLICIES.fuelCellGas,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const fuelCellKwh = electricityCounter.delta;
  const fuelCellGasM3 = gasCounter.delta;
  const fuelCellInterconnectionValue = fuelCellPrimary?.interconnection_status?.value;
  const fuelCellInterconnection = typeof fuelCellInterconnectionValue === "string" ? fuelCellInterconnectionValue : null;
  const houseDemandW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.house_demand_power);
  const gridImportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_import_power);
  const gridExportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_export_power);
  const gridImportCumulativeKwh = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.cumulative_bought);
  const gridExportCumulativeKwh = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.cumulative_sold);
  const meterCounterSourceHost = gridImportCumulativeKwh !== null || gridExportCumulativeKwh !== null
    ? config.meterHost
    : null;
  const sameMeterCounterSource = meterCounterSourceHost
    && meterCounterSourceHost === previousSample?.meterCounterSourceHost;
  const gridImportCounter = sameMeterCounterSource
    ? cumulativeCounterDeltaResult(
      gridImportCumulativeKwh,
      previousSample?.gridImportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const gridExportCounter = sameMeterCounterSource
    ? cumulativeCounterDeltaResult(
      gridExportCumulativeKwh,
      previousSample?.gridExportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const stateOfChargePercent = numericMetric(status.energy?.battery?.remaining_percent);
  const circuitPowerW = config.smartCosmoEnabled === false
    ? {}
    : circuitChannelMap(status.meter?.channel_power?.decoded?.channels);
  const circuitCumulativeKwh = config.smartCosmoEnabled === false
    ? {}
    : circuitCumulativeMap(status.meter?.channel_energy?.decoded?.channels);
  const circuitEnergyKwh: Record<string, number> = {};
  const circuitCounterIssues: Array<{ channel: number; issue: unknown }> = [];
  for (const id of Object.keys({ ...circuitPowerW, ...circuitCumulativeKwh })) {
    const result = cumulativeCounterDeltaResult(
      circuitCumulativeKwh[id],
      previousSample?.circuitCumulativeKwh?.[id],
      COUNTER_POLICIES.circuit,
      elapsedSeconds,
    );
    if (result.delta !== null) circuitEnergyKwh[id] = result.delta;
    if (result.issue) circuitCounterIssues.push({ channel: Number(id), issue: result.issue });
  }
  const rateBand = rateForTimestamp(config.rateBands ?? [], timestamp, config.standardRateYenPerKwh ?? 0);
  const activeRate = rateBand.yenPerKwh;
  const highestRate = maxDailyRate(config.rateBands ?? [], config.standardRateYenPerKwh ?? 0);
  const maximumGapSeconds = Math.max(90, Number(config.updateIntervalSeconds ?? 5) * 2.5);
  const intervalSeconds = elapsedSeconds <= maximumGapSeconds ? elapsedSeconds : 0;
  const fuelCellOperatingSeconds = typeof previousSample?.fuelCellGenerationState === "string"
    && ["generating", "starting", "stopping", "idling"].includes(previousSample.fuelCellGenerationState)
    ? intervalSeconds
    : 0;
  const fuelCellStartCount = fuelCellGenerationState === "generating" && previousSample?.fuelCellGenerationState !== "generating" ? 1 : 0;
  const exactCircuitValues = Object.values(circuitEnergyKwh).filter(Number.isFinite);
  const exactHouseDemandKwh = exactCircuitValues.length > 0
    && exactCircuitValues.length === Object.values(circuitCumulativeKwh).filter(Number.isFinite).length
    ? exactCircuitValues.reduce((sum, value) => sum + value, 0)
    : null;
  const coverageSeconds: Record<string, number> = {};
  const energyQuality: Record<string, string> = {};
  const energyIntervalStart: Record<string, string> = {};
  if (gridImportCounter.delta !== null) {
    coverageSeconds.gridImportKwh = intervalSeconds;
    energyQuality.gridImportKwh = "counter";
    if (previousTimestamp) energyIntervalStart.gridImportKwh = previousTimestamp;
  }
  if (gridExportCounter.delta !== null) {
    coverageSeconds.gridExportKwh = intervalSeconds;
    energyQuality.gridExportKwh = "counter";
    if (previousTimestamp) energyIntervalStart.gridExportKwh = previousTimestamp;
  }
  if (exactHouseDemandKwh !== null) {
    coverageSeconds.houseDemandKwh = intervalSeconds;
    energyQuality.houseDemandKwh = "counter";
    if (previousTimestamp) energyIntervalStart.houseDemandKwh = previousTimestamp;
  }
  if (fuelCellKwh !== null) {
    coverageSeconds.fuelCellKwh = intervalSeconds;
    energyQuality.fuelCellKwh = "counter";
    if (previousTimestamp) energyIntervalStart.fuelCellKwh = previousTimestamp;
  }
  for (const id of Object.keys(circuitEnergyKwh)) {
    const key = `circuit:${id}`;
    coverageSeconds[key] = intervalSeconds;
    energyQuality[key] = "counter";
    if (previousTimestamp) energyIntervalStart[key] = previousTimestamp;
  }
  return {
    timestamp,
    batteryPowerW,
    stateOfChargePercent,
    solarPowerW,
    houseDemandW,
    fuelCellPowerW,
    fuelCellRatedPowerW,
    ...(fuelCellKwh !== null ? { fuelCellKwh } : {}),
    ...(fuelCellGasM3 !== null ? { fuelCellGasM3 } : {}),
    fuelCellCumulativeGenerationKwh,
    fuelCellCumulativeGasM3,
    fuelCellGenerationState,
    fuelCellHotWaterLevel,
    fuelCellInterconnection,
    fuelCellSourceHost: fuelCellReading?.host ?? null,
    fuelCellCounterSourceHost: counterSourceHost,
    fuelCellDataQuality: fuelCellKwh !== null
      ? "counter"
      : fuelCellPowerW !== null && fuelCellGasM3 !== null
        ? "mixed"
        : fuelCellPowerW !== null
          ? "integrated"
          : null,
    fuelCellGasDataQuality: fuelCellGasM3 !== null ? "counter" : null,
    fuelCellCounterIssues: [
      ...(electricityCounter.issue ? [{ counter: "electricity", issue: electricityCounter.issue }] : []),
      ...(gasCounter.issue ? [{ counter: "gas", issue: gasCounter.issue }] : []),
    ],
    fuelCellOperatingSeconds,
    fuelCellStartCount,
    gridExportW,
    gridImportW,
    gridImportCumulativeKwh,
    gridExportCumulativeKwh,
    meterCounterSourceHost,
    meterCounterIssues: [
      ...(gridImportCounter.issue ? [{ counter: "import", issue: gridImportCounter.issue }] : []),
      ...(gridExportCounter.issue ? [{ counter: "export", issue: gridExportCounter.issue }] : []),
    ],
    circuitPowerW,
    circuitCumulativeKwh,
    circuitEnergyKwh,
    circuitCounterIssues,
    ...(gridImportCounter.delta !== null ? { gridImportKwh: gridImportCounter.delta } : {}),
    ...(gridExportCounter.delta !== null ? { gridExportKwh: gridExportCounter.delta } : {}),
    ...(exactHouseDemandKwh !== null ? { houseDemandKwh: exactHouseDemandKwh } : {}),
    coverageSeconds,
    energyQuality,
    energyIntervalStart,
    expectedIntervalSeconds: Number(config.updateIntervalSeconds ?? 5),
    rateYenPerKwh: activeRate,
    maximumRateYenPerKwh: highestRate,
    standardRateYenPerKwh: finiteNumberOrNull(config.standardRateYenPerKwh),
    rateLabel: rateBand.label || null,
  };
}
