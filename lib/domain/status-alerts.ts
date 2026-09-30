import { numericMetric } from "./telemetry.js";
import type { ApplicationConfig } from "../contracts/configuration.js";

interface StatusError {
  host?: string;
  epc?: string;
  error?: string;
}

interface DeviceStatus {
  energy?: {
    error?: string;
    errors?: StatusError[];
    battery?: { error?: string };
    solar?: { error?: string };
    fuel_cells?: Array<{ error?: string }>;
    fuelCells?: Array<{ error?: string }>;
  };
  meter?: { error?: string; errors?: StatusError[] };
}

interface FuelCellNotificationStatus {
  hot_water_level?: { value?: unknown };
  generation_status?: { value?: unknown };
}


export function isDocumentationHost(host: unknown): boolean {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(String(host ?? ""));
}


export function deviceStatusFailures(
  status: DeviceStatus,
  config: Pick<ApplicationConfig, "batteryHost" | "smartCosmoEnabled" | "meterHost" | "solarEnabled" | "solarHost" | "fuelCellEnabled" | "fuelCellHosts">,
): string[] {
  const failures: string[] = [];
  const energyError = status.energy?.error;
  const propertyErrors = Array.isArray(status.energy?.errors) ? status.energy.errors : [];
  const errorsForHost = (host: string) => propertyErrors
    .filter((item) => item?.host === host && item?.error)
    .map((item) => `${item.epc ?? "property"}: ${item.error}`);
  if (config.batteryHost && !isDocumentationHost(config.batteryHost)) {
    const errors = [energyError ?? status.energy?.battery?.error, ...errorsForHost(config.batteryHost)].filter(Boolean);
    if (errors.length) failures.push(`Battery: ${errors.join(", ")}`);
  }
  if (config.smartCosmoEnabled && config.meterHost && !isDocumentationHost(config.meterHost)) {
    const errors = [
      status.meter?.error,
      ...(Array.isArray(status.meter?.errors) ? status.meter.errors.map((item) => `${item.epc ?? "property"}: ${item.error}`) : []),
    ].filter(Boolean);
    if (errors.length) failures.push(`Smart Cosmo: ${errors.join(", ")}`);
  }
  if (config.solarEnabled && config.solarHost && !isDocumentationHost(config.solarHost)) {
    const errors = [energyError ?? status.energy?.solar?.error, ...errorsForHost(config.solarHost)].filter(Boolean);
    if (errors.length) failures.push(`Solar: ${errors.join(", ")}`);
  }
  if (config.fuelCellEnabled && config.fuelCellHosts.some((host) => !isDocumentationHost(host))) {
    const fuelCellErrors = (status.energy?.fuel_cells ?? status.energy?.fuelCells ?? [])
      .map((item) => item?.error)
      .filter(Boolean);
    const configuredHosts = new Set(config.fuelCellHosts);
    const propertyFuelCellErrors = propertyErrors
      .filter((item) => Boolean(item.host && configuredHosts.has(item.host) && item.error))
      .map((item) => `${item.host} ${item.epc ?? "property"}: ${item.error}`);
    if (energyError) failures.push(`Ene-Farm: ${energyError}`);
    else if (fuelCellErrors.length || propertyFuelCellErrors.length) {
      failures.push(`Ene-Farm: ${[...fuelCellErrors, ...propertyFuelCellErrors].join(", ")}`);
    }
  }
  return [...new Set(failures)];
}


export function fuelCellHotWaterEmptyNotificationActive(primary: FuelCellNotificationStatus | null | undefined): boolean | null {
  const hotWaterLevel = numericMetric(primary?.hot_water_level);
  const generationState = typeof primary?.generation_status?.value === "string" ? primary.generation_status.value : null;
  if (!Number.isFinite(hotWaterLevel) || !generationState) return null;
  return hotWaterLevel !== null && hotWaterLevel <= 0 && generationState !== "generating";
}
