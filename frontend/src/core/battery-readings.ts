import type { StatusSnapshot } from "../api/contracts";

export type BatteryReading<T> = {
  value: T;
  readAt: string | undefined;
  stale: boolean;
};

type Metric<T> = {
  value?: T | null;
  acquired_at?: string | null;
  error?: string | null;
};

export type BatteryReadings = {
  host: string;
  lastDetailsAt?: string;
  lastContactAt?: string;
  soc?: BatteryReading<number>;
  socError?: string | null;
  workingStatus?: BatteryReading<string>;
  operationMode?: BatteryReading<string>;
  profile?: BatteryReading<string>;
  reserve?: BatteryReading<number>;
};

function updateReading<T>(previous: BatteryReading<T> | undefined, metric: Metric<T> | undefined, readAt: string | undefined) {
  if (metric?.value != null && !metric.error) {
    return { value: metric.value, readAt: metric.acquired_at ?? readAt, stale: false };
  }
  return previous && { ...previous, stale: true };
}

export function updateBatteryReadings(previous: BatteryReadings | null, status: StatusSnapshot, configuredHost?: string): BatteryReadings | null {
  const host = status.hosts?.battery === undefined ? configuredHost : status.hosts.battery;
  const battery = status.energy?.battery;
  if (!host || battery?.configured === false) return null;

  const readings: BatteryReadings = previous?.host === host ? previous : { host };
  const power = battery?.instant_power;
  const powerReadAt = power?.value != null && !power.error ? power.acquired_at ?? status.read_at : undefined;
  if (status.statusRefreshPaused && readings.lastDetailsAt) return readings;
  if (status.statusDetailsPending) {
    return { ...readings, lastContactAt: powerReadAt ?? readings.lastContactAt };
  }

  const mode = status.settings?.mode;
  const profileValue = mode?.decoded?.mode ?? mode?.mode;
  const profile = profileValue != null && !mode?.error ? { value: profileValue } : battery?.vendor_profile;
  const limit = status.settings?.discharge_limit;
  const reserve = { value: limit?.available === false ? null : limit?.decoded?.percent, error: limit?.error };
  const readAt = status.read_at;
  const soc = updateReading(readings.soc, battery?.remaining_percent, readAt);
  const workingStatus = updateReading(readings.workingStatus, battery?.working_status, readAt);
  const operationMode = updateReading(readings.operationMode, battery?.operation_mode, readAt);
  const chargingProfile = updateReading(readings.profile, profile, readAt);
  const reserveReading = updateReading(readings.reserve, reserve, readAt);
  const lastContactAt = [powerReadAt, readings.lastContactAt, ...[soc, workingStatus, operationMode, chargingProfile, reserveReading]
    .map((reading) => reading?.stale ? undefined : reading?.readAt)]
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()
    .at(-1);
  return {
    host,
    lastDetailsAt: readAt,
    lastContactAt,
    soc,
    socError: battery?.remaining_percent?.error,
    workingStatus,
    operationMode,
    profile: chargingProfile,
    reserve: reserveReading,
  };
}
