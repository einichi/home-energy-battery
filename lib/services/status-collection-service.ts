import type { ApplicationConfig } from "../contracts/configuration.js";
import { isDocumentationHost, deviceStatusFailures, fuelCellHotWaterEmptyNotificationActive } from "../domain/status-alerts.js";
import { numericMetric, primaryFuelCell } from "../domain/telemetry.js";
import type { DeviceCommandArguments } from "./device-command-queue.js";

type DeviceCommandOptions = { priority?: number; queueTimeoutMs?: number };

type UnknownRecord = Record<string, unknown>;
type ProbeProgress = (result: { label: string; durationMs: number }) => void;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasMetricValue(value: unknown): boolean {
  const item = record(value);
  return item.value !== null && item.value !== undefined;
}

function hasDecodedChannels(value: unknown): boolean {
  const item = record(value);
  return Array.isArray(record(item.decoded).channels);
}

export interface StatusCollectionDependencies {
  readConfig(): Promise<ApplicationConfig>;
  updateConfig(mutator: (config: ApplicationConfig) => ApplicationConfig | Promise<ApplicationConfig>): Promise<ApplicationConfig>;
  runDeviceCommand(command: string, args?: DeviceCommandArguments, positional?: unknown[], options?: DeviceCommandOptions): Promise<unknown>;
  recordStatusSample(status: UnknownRecord, config: ApplicationConfig): Promise<unknown>;
  readHistoryRange(start: string, end: string, config: ApplicationConfig): Promise<unknown>;
  readCalendarSavings(end: string, config: ApplicationConfig, todaySummary: unknown): unknown;
  observeNotification(input: {
    key: string;
    active: boolean;
    activateAfter?: number;
    recoverAfter?: number;
    activeEvent?: unknown;
    recoveryEvent?: unknown;
  }): Promise<unknown>;
}

export function createStatusCollectionService(dependencies: StatusCollectionDependencies) {
  let latestSnapshot: UnknownRecord | null = null;
  let refreshPromise: Promise<UnknownRecord> | null = null;

  function fuelCellArgs(config: ApplicationConfig): DeviceCommandArguments {
    return {
      ...(config.fuelCellPrimaryHost ? { "fuel-cell-primary-host": config.fuelCellPrimaryHost } : {}),
      ...(config.fuelCellProxyHosts.length ? { "fuel-cell-proxy-host": config.fuelCellProxyHosts } : {}),
    };
  }

  async function safeCommand(command: string, args: DeviceCommandArguments = {}, positional: unknown[] = [], options: DeviceCommandOptions = {}): Promise<UnknownRecord> {
    try {
      return record(await dependencies.runDeviceCommand(command, args, positional, options));
    } catch (error: unknown) {
      return { error: message(error) };
    }
  }

  async function readMeterStatus(config: ApplicationConfig): Promise<UnknownRecord> {
    if (!config.smartCosmoEnabled || !config.meterHost || isDocumentationHost(config.meterHost)) {
      return { configured: false, host: null };
    }
    try {
      return {
        configured: true,
        ...record(await dependencies.runDeviceCommand("meter-status", { host: config.meterHost, eoj: config.meterEoj })),
      };
    } catch (error: unknown) {
      return { configured: true, host: config.meterHost, eoj: config.meterEoj, error: message(error) };
    }
  }

  async function settingWithCache(
    config: ApplicationConfig,
    key: string,
    reader: () => Promise<UnknownRecord>,
  ): Promise<UnknownRecord> {
    const cached = config.settingCache[key] ?? null;
    const data = await reader();
    if (!data.error && (data.raw || data.decoded)) {
      await dependencies.updateConfig((current) => ({
        ...current,
        settingCache: {
          ...current.settingCache,
          [key]: { lastKnown: data as ApplicationConfig["settingCache"][string]["lastKnown"], lastReadAt: new Date().toISOString() },
        },
      }));
      return { ...data, available: true };
    }
    return {
      ...data,
      available: false,
      lastKnown: cached?.lastKnown ?? null,
      lastReadAt: cached?.lastReadAt ?? null,
      error: data.error ?? "setting unavailable in current device mode",
    };
  }

  async function readAll(onProbeComplete: ProbeProgress = () => undefined): Promise<UnknownRecord> {
    const config = await dependencies.readConfig();
    const energyArgs: DeviceCommandArguments = {
      "battery-host": config.batteryHost,
      ...(config.solarEnabled ? { "solar-host": config.solarHost } : { "no-solar": true }),
      ...(config.fuelCellEnabled ? fuelCellArgs(config) : { "no-fuel-cell": true }),
    };
    const batteryConfigured = Boolean(config.batteryHost && !isDocumentationHost(config.batteryHost));
    const skippedSetting: UnknownRecord = { available: false, error: "battery host is not configured", lastKnown: null, lastReadAt: null };
    const probe = async <T>(label: string, reader: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await reader();
      } finally {
        onProbeComplete({ label, durationMs: Date.now() - startedAt });
      }
    };
    const [energy, meter, mode, dischargeLimit, chargeWindow, dischargeWindow, vendor] = await Promise.all([
      probe("energy status", () => batteryConfigured ? safeCommand("energy-status", energyArgs) : Promise.resolve({ battery: { configured: false } })),
      probe("home power meter status", () => readMeterStatus(config)),
      probe("charging profile", () => batteryConfigured ? safeCommand("vendor-profile", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" })),
      probe("discharge limit", () => batteryConfigured ? settingWithCache(config, "discharge_limit", () => safeCommand("discharge-limit", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
      probe("osaifu charge window", () => batteryConfigured ? settingWithCache(config, "osaifu_charge_window", () => safeCommand("osaifu-charge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
      probe("osaifu discharge window", () => batteryConfigured ? settingWithCache(config, "osaifu_discharge_window", () => safeCommand("osaifu-discharge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
      probe("vendor properties", () => batteryConfigured ? safeCommand("dump-vendor", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" })),
    ]);

    const hydrateWindowRaw = async (windowData: UnknownRecord, epcHex: string): Promise<UnknownRecord> => {
      if (!batteryConfigured || windowData.raw) return windowData;
      const rawRead = await safeCommand("raw-get", { host: config.batteryHost, eoj: "0x027D01" }, [epcHex]);
      return rawRead.raw ? { ...windowData, raw: rawRead.raw } : windowData;
    };
    const chargeWindowRead = await probe("osaifu charge window raw fallback", () => hydrateWindowRaw(chargeWindow, "0xF4"));
    const dischargeWindowRead = await probe("osaifu discharge window raw fallback", () => hydrateWindowRaw(dischargeWindow, "0xF5"));
    const livePowerArgs: DeviceCommandArguments = {
      "battery-host": config.batteryHost,
      ...(config.solarEnabled ? { "solar-host": config.solarHost } : { "no-solar": true }),
      ...(config.smartCosmoEnabled && config.meterHost
        ? { "meter-host": config.meterHost, "meter-eoj": config.meterEoj }
        : { "no-meter": true }),
      ...(config.fuelCellEnabled ? fuelCellArgs(config) : { "no-fuel-cell": true }),
    };
    const livePower = await probe("live power", () => batteryConfigured
      ? safeCommand("live-power", livePowerArgs, [], { priority: 5 })
      : Promise.resolve({ error: "battery host is not configured" }));
    const liveEnergy = record(livePower.energy);
    const liveBattery = record(liveEnergy.battery);
    const liveSolar = record(liveEnergy.solar);
    const liveMeter = record(livePower.meter);
    const detailBattery = record(energy.battery);
    const detailSolar = record(energy.solar);
    const detailFuelCells = Array.isArray(energy.fuel_cells) ? energy.fuel_cells.map(record) : [];
    const liveFuelCells = Array.isArray(liveEnergy.fuel_cells) ? liveEnergy.fuel_cells.map(record) : [];
    const livePrimaryFuelCell = liveFuelCells.find((cell) => cell.source_role === "primary") ?? liveFuelCells[0];
    const mergedFuelCells = livePrimaryFuelCell
      ? detailFuelCells.some((cell) => cell.source_role === "primary")
        ? detailFuelCells.map((cell) => cell.source_role === "primary"
          ? {
              ...cell,
              ...(hasMetricValue(livePrimaryFuelCell.instant_power) ? { instant_power: livePrimaryFuelCell.instant_power } : {}),
            }
          : cell)
        : hasMetricValue(livePrimaryFuelCell.instant_power) ? [...detailFuelCells, livePrimaryFuelCell] : detailFuelCells
      : detailFuelCells;
    const mergedEnergy: UnknownRecord = {
      ...energy,
      battery: { ...detailBattery, ...(hasMetricValue(liveBattery.instant_power) ? { instant_power: liveBattery.instant_power } : {}) },
      ...(config.solarEnabled ? { solar: { ...detailSolar, ...(hasMetricValue(liveSolar.instant_power) ? { instant_power: liveSolar.instant_power } : {}) } } : {}),
      fuel_cells: mergedFuelCells,
    };
    const liveMeterKeys = ["grid_net_power", "grid_import_power", "grid_export_power", "house_demand_power"]
      .filter((key) => hasMetricValue(liveMeter[key]));
    if (hasDecodedChannels(liveMeter.channel_power)) liveMeterKeys.push("channel_power");
    const mergedMeter: UnknownRecord = {
      ...meter,
      ...Object.fromEntries(
        liveMeterKeys.map((key) => [key, liveMeter[key]]),
      ),
    };
    const readAt = typeof livePower.completed_at === "string" ? livePower.completed_at : new Date().toISOString();
    const status: UnknownRecord = {
      hosts: {
        battery: config.batteryHost,
        meter: config.smartCosmoEnabled ? config.meterHost || null : null,
        solar: config.solarEnabled ? config.solarHost : null,
        fuel_cells: config.fuelCellEnabled ? config.fuelCellHosts : [],
        fuel_cell_primary: config.fuelCellEnabled ? config.fuelCellPrimaryHost : null,
        fuel_cell_proxies: config.fuelCellEnabled ? config.fuelCellProxyHosts : [],
      },
      features: {
        smartCosmoEnabled: config.smartCosmoEnabled,
        solarEnabled: config.solarEnabled,
        fuelCellEnabled: config.fuelCellEnabled,
        rateMode: config.rateMode,
        offPeakSavingsEnabled: config.offPeakSavingsEnabled,
      },
      energy: mergedEnergy,
      meter: mergedMeter,
      live_power: {
        started_at: typeof livePower.started_at === "string" ? livePower.started_at : null,
        completed_at: typeof livePower.completed_at === "string" ? livePower.completed_at : null,
        duration_ms: Number.isFinite(Number(livePower.duration_ms)) ? Number(livePower.duration_ms) : null,
        errors: Array.isArray(livePower.errors) ? livePower.errors : [],
        ...(typeof livePower.error === "string" ? { error: livePower.error } : {}),
      },
      settings: { mode, discharge_limit: dischargeLimit, osaifu_charge_window: chargeWindowRead, osaifu_discharge_window: dischargeWindowRead, vendor },
      read_at: readAt,
      rates: {
        rateMode: config.rateMode,
        standardRateYenPerKwh: config.standardRateYenPerKwh,
        offPeakRateYenPerKwh: config.offPeakRateYenPerKwh,
        offPeakSavingsEnabled: config.offPeakSavingsEnabled,
        rateBands: config.rateBands,
      },
    };
    status.sample = await dependencies.recordStatusSample(status, config);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const history = record(await dependencies.readHistoryRange(today.toISOString(), readAt, config));
    status.savings = history.summary;
    status.savingsPeriods = dependencies.readCalendarSavings(readAt, config, history.summary);
    return status;
  }

  function snapshotAgeMs(now = Date.now()): number {
    const readAt = new Date(String(latestSnapshot?.read_at ?? "")).getTime();
    return Number.isFinite(readAt) ? Math.max(0, now - readAt) : Number.POSITIVE_INFINITY;
  }

  async function refresh(onProbeComplete: ProbeProgress = () => undefined): Promise<UnknownRecord> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = readAll(onProbeComplete)
      .then((status) => {
        latestSnapshot = status;
        return status;
      })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function get(options: { maxAgeMs?: number; force?: boolean; onProbeComplete?: ProbeProgress } = {}): Promise<UnknownRecord> {
    const { maxAgeMs = 0, force = false, onProbeComplete = () => undefined } = options;
    if (!force && latestSnapshot && snapshotAgeMs() <= Math.max(0, Number(maxAgeMs) || 0)) return latestSnapshot;
    return refresh(onProbeComplete);
  }

  function invalidate(): void {
    latestSnapshot = null;
  }

  function observeDevice(statusValue: unknown, config: ApplicationConfig): void {
    const status = record(statusValue);
    const failures = deviceStatusFailures(status as Parameters<typeof deviceStatusFailures>[0], config);
    void dependencies.observeNotification({
      key: "device-health",
      active: failures.length > 0,
      activateAfter: 3,
      recoverAfter: 2,
      activeEvent: { type: "deviceOffline", severity: "error", title: "Energy device unavailable", message: `Three consecutive background polls reported device errors:\n${failures.join("\n")}`, dedupeKey: "device-health:offline" },
      recoveryEvent: { type: "deviceRecovered", severity: "info", title: "Energy devices recovered", message: "Configured energy devices responded successfully to two consecutive background polls.", dedupeKey: "device-health:recovered" },
    });
  }

  function observeBattery(statusValue: unknown, config: ApplicationConfig): void {
    const status = record(statusValue);
    const lowBattery = config.notifications.triggers.lowBattery;
    const energy = record(status.energy);
    const battery = record(energy.battery);
    const stateOfCharge = numericMetric(record(battery.remaining_percent));
    const thresholdPercent = Number(lowBattery?.thresholdPercent ?? 20);
    if (!config.notifications.enabled) {
      void dependencies.observeNotification({ key: "low-battery-soc", active: false });
      return;
    }
    if (stateOfCharge === null || !Number.isFinite(stateOfCharge)) return;
    if (stateOfCharge > thresholdPercent && stateOfCharge < thresholdPercent + 5) return;
    void dependencies.observeNotification({
      key: "low-battery-soc",
      active: stateOfCharge <= thresholdPercent,
      activateAfter: 2,
      recoverAfter: 2,
      activeEvent: { type: "lowBattery", severity: "warning", title: "Battery state of charge is low", message: `Battery state of charge remained at or below ${thresholdPercent}% for two background polls. Current SOC: ${stateOfCharge}%.`, dedupeKey: "battery-soc:low" },
    });
  }

  function observeFuelCell(statusValue: unknown, config: ApplicationConfig): void {
    const status = record(statusValue);
    if (!config.fuelCellEnabled || !config.fuelCellPrimaryHost) {
      void dependencies.observeNotification({ key: "fuel-cell-hot-water-empty", active: false });
      return;
    }
    const energy = record(status.energy);
    const cells = Array.isArray(energy.fuel_cells) ? energy.fuel_cells : Array.isArray(energy.fuelCells) ? energy.fuelCells : [];
    const primary = primaryFuelCell(cells as Parameters<typeof primaryFuelCell>[0]);
    const active = fuelCellHotWaterEmptyNotificationActive(primary);
    if (active === null) return;
    void dependencies.observeNotification({
      key: "fuel-cell-hot-water-empty",
      active,
      activateAfter: 2,
      recoverAfter: 2,
      activeEvent: { type: "fuelCellHotWaterEmpty", severity: "warning", title: "Ene-Farm hot-water tank is empty", message: "The Ene-Farm hot-water level remained at 0/5 for two background polls.", dedupeKey: "fuel-cell-hot-water:empty" },
    });
  }

  return {
    get,
    getLatest: () => latestSnapshot,
    hasActiveRefresh: () => refreshPromise !== null,
    invalidate,
    observeBattery,
    observeDevice,
    observeFuelCell,
  };
}
