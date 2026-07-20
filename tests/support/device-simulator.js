import { readFile } from "node:fs/promises";

const BATTERY_EOJ = "0x027D01";
const SOLAR_EOJ = "0x027901";
const FUEL_CELL_EOJ = "0x027C01";
const METER_EOJ = "0x028701";

const DEFAULT_DEVICE_STATE = Object.freeze({
  battery: {
    host: "10.250.0.10",
    stateOfChargePercent: 62,
    usableCapacityKwh: 5.4,
    instantPowerW: 0,
    chargePowerWatts: 2192,
    operationStatus: "on",
    operationMode: "auto",
    workingStatus: "auto",
    vendorProfile: "eco",
    dischargeLimitPercent: 20,
    chargeWindow: { startHour: 1, endHour: 5 },
    dischargeWindow: { startHour: 7, endHour: 23 },
    targetWh: null,
  },
  solar: {
    host: "10.250.0.10",
    instantPowerW: 850,
  },
  meter: {
    host: "10.250.0.20",
    eoj: METER_EOJ,
    gridNetPowerW: 920,
    cumulativeBoughtKwh: 1234.5,
    cumulativeSoldKwh: 67.8,
    cumulativeUnitKwh: 0.1,
    circuits: [
      { channel: 1, instantPowerW: 320, cumulativeKwh: 125.4 },
      { channel: 2, instantPowerW: 480, cumulativeKwh: 234.5 },
      { channel: 3, instantPowerW: 610, cumulativeKwh: 345.6 },
    ],
  },
  fuelCell: {
    primaryHost: "10.250.0.30",
    proxyHosts: ["10.250.0.20"],
    ratedPowerW: 700,
    instantPowerW: 650,
    cumulativeGenerationKwh: 4321.234,
    cumulativeGasM3: 987.654,
    generationStatus: "generating",
    interconnectionStatus: "grid_connected_reverse_flow_allowed",
    hotWaterLevel: 4,
  },
  unavailableHosts: [],
  pollAdvanceMs: 0,
});

const DEVICE_SCENARIOS = Object.freeze({
  normal: {},
  "high-demand": {
    meter: {
      gridNetPowerW: 4700,
      circuits: [
        { channel: 1, instantPowerW: 1800, cumulativeKwh: 125.4 },
        { channel: 2, instantPowerW: 1500, cumulativeKwh: 234.5 },
        { channel: 3, instantPowerW: 1400, cumulativeKwh: 345.6 },
      ],
    },
  },
  "solar-export": {
    solar: { instantPowerW: 2400 },
    meter: { gridNetPowerW: -650 },
  },
  "ene-farm-stopped": {
    fuelCell: { instantPowerW: 0, generationStatus: "stopped" },
  },
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function merge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return clone(source);
  const out = { ...(target ?? {}) };
  for (const [key, value] of Object.entries(source)) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(out[key], value)
      : clone(value);
  }
  return out;
}

function hexByte(value) {
  return Number(value).toString(16).padStart(2, "0").toUpperCase();
}

function rawUnsigned(value, bytes = 4) {
  if (!Number.isFinite(Number(value))) return null;
  return `0x${Math.max(0, Math.round(Number(value))).toString(16).padStart(bytes * 2, "0").toUpperCase()}`;
}

function metric({ host, eoj, epc, name, value, unit = null, raw = null }) {
  return {
    host,
    eoj,
    epc,
    name,
    raw,
    value: value ?? null,
    ...(unit ? { unit } : {}),
    human: value === null || value === undefined ? null : `${value}${unit ? ` ${unit}` : ""}`,
  };
}

function enumMetric({ host, eoj, epc, name, value, raw = "0x00" }) {
  return metric({ host, eoj, epc, name, value, raw });
}

function normalizedHostList(value) {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function profileRaw(profile) {
  return `0x${hexByte({ osaifu: 0x02, eco: 0x03, backup: 0x20 }[profile] ?? 0xff)}`;
}

function modeRaw(mode) {
  return `0x${hexByte({ rapid_charging: 0x41, charging: 0x42, charge: 0x42, discharging: 0x43, discharge: 0x43, standby: 0x44, auto: 0x46 }[mode] ?? 0x40)}`;
}

function windowRaw(window) {
  return `0x${hexByte(window.startHour)}00${hexByte(window.endHour)}00`;
}

function decodeWindow(window) {
  const start = String(window.startHour).padStart(2, "0");
  const end = String(window.endHour).padStart(2, "0");
  return {
    start_hour: window.startHour,
    start_time: `${start}:00`,
    end_hour: window.endHour,
    end_time: `${end}:00`,
    human: `${start}:00-${end}:00`,
    encoding: "bytes 0 and 2 are 24-hour clock hours; bytes 1 and 3 are zero",
  };
}

function simulatedFuelCellMetric(host, role, fuelCell, available) {
  const value = (item) => available ? item : null;
  const base = {
    host,
    source_role: role,
    instant_power: metric({
      host,
      eoj: FUEL_CELL_EOJ,
      epc: "0xC4",
      name: "fuel_cell_instant_power",
      value: value(fuelCell.instantPowerW),
      unit: "W",
      raw: value(rawUnsigned(fuelCell.instantPowerW, 2)),
    }),
    generation_status: enumMetric({
      host,
      eoj: FUEL_CELL_EOJ,
      epc: "0xCB",
      name: "fuel_cell_generation_status",
      value: value(fuelCell.generationStatus),
      raw: value("0x41"),
    }),
  };
  if (role !== "primary") return base;
  return {
    ...base,
    rated_power: metric({ host, eoj: FUEL_CELL_EOJ, epc: "0xC2", name: "fuel_cell_rated_power", value: value(fuelCell.ratedPowerW), unit: "W", raw: value(rawUnsigned(fuelCell.ratedPowerW, 2)) }),
    cumulative_generation: metric({ host, eoj: FUEL_CELL_EOJ, epc: "0xC5", name: "fuel_cell_cumulative_generation", value: value(fuelCell.cumulativeGenerationKwh), unit: "kWh", raw: value(rawUnsigned(fuelCell.cumulativeGenerationKwh * 1000)) }),
    cumulative_gas: metric({ host, eoj: FUEL_CELL_EOJ, epc: "0xC8", name: "fuel_cell_cumulative_gas", value: value(fuelCell.cumulativeGasM3), unit: "m3", raw: value(rawUnsigned(fuelCell.cumulativeGasM3 * 1000)) }),
    interconnection_status: enumMetric({ host, eoj: FUEL_CELL_EOJ, epc: "0xD0", name: "fuel_cell_interconnection_status", value: value(fuelCell.interconnectionStatus), raw: value("0x00") }),
    hot_water_level: metric({ host, eoj: FUEL_CELL_EOJ, epc: "0xF4", name: "fuel_cell_hot_water_level", value: value(fuelCell.hotWaterLevel), unit: "level", raw: value(rawUnsigned(fuelCell.hotWaterLevel, 1)) }),
  };
}

export function createDeviceSimulator(options = {}) {
  const preset = typeof options.scenario === "string" ? DEVICE_SCENARIOS[options.scenario] : options.scenario;
  if (typeof options.scenario === "string" && !preset) throw new Error(`unknown device simulator scenario: ${options.scenario}`);
  let state = merge(merge(DEFAULT_DEVICE_STATE, preset ?? {}), options.state ?? {});
  const calls = [];
  const faults = [];

  function hostAvailable(host) {
    return host && !state.unavailableHosts.includes(host);
  }

  function failNext(command, { host = null, message = `${command} simulated failure`, times = 1 } = {}) {
    faults.push({ command, host, message, kind: "throw", remaining: Math.max(1, Number(times) || 1) });
  }

  function rejectNext(command, { host = null, esv = "SetC_SNA", times = 1 } = {}) {
    faults.push({ command, host, esv, kind: "reject", remaining: Math.max(1, Number(times) || 1) });
  }

  function setState(patch) {
    state = merge(state, patch);
    return snapshot();
  }

  function setHostAvailable(host, available) {
    const hosts = new Set(state.unavailableHosts);
    if (available) hosts.delete(host);
    else hosts.add(host);
    state.unavailableHosts = [...hosts];
  }

  function advance(milliseconds) {
    const hours = Math.max(0, Number(milliseconds) || 0) / 3_600_000;
    const batteryWh = state.battery.instantPowerW * hours;
    if (Number.isFinite(batteryWh) && state.battery.usableCapacityKwh > 0) {
      state.battery.stateOfChargePercent = Math.max(
        state.battery.dischargeLimitPercent,
        Math.min(100, state.battery.stateOfChargePercent + batteryWh / (state.battery.usableCapacityKwh * 10)),
      );
      if (Number.isFinite(state.battery.targetWh)) {
        state.battery.targetWh = Math.max(0, state.battery.targetWh - Math.max(0, batteryWh));
        if (state.battery.targetWh === 0) {
          state.battery.operationMode = "auto";
          state.battery.workingStatus = "auto";
          state.battery.instantPowerW = 0;
        }
      }
    }
    state.meter.cumulativeBoughtKwh += Math.max(0, state.meter.gridNetPowerW) * hours / 1000;
    state.meter.cumulativeSoldKwh += Math.max(0, -state.meter.gridNetPowerW) * hours / 1000;
    state.fuelCell.cumulativeGenerationKwh += Math.max(0, state.fuelCell.instantPowerW) * hours / 1000;
    return snapshot();
  }

  function batterySetting(command, positional) {
    const battery = state.battery;
    if (command === "vendor-profile") {
      if (positional[0] !== undefined) battery.vendorProfile = String(positional[0]);
      return {
        ...(positional[0] !== undefined ? { ok: true, esv: "Set_Res", mode: battery.vendorProfile } : {}),
        host: battery.host,
        eoj: BATTERY_EOJ,
        epc: "0xF0",
        name: "vendor_profile",
        raw: profileRaw(battery.vendorProfile),
        decoded: { mode: battery.vendorProfile },
      };
    }
    if (command === "discharge-limit") {
      if (positional[0] !== undefined) battery.dischargeLimitPercent = Number(positional[0]);
      return {
        ...(positional[0] !== undefined ? { ok: true, esv: "Set_Res", percent: battery.dischargeLimitPercent } : {}),
        host: battery.host,
        eoj: BATTERY_EOJ,
        epc: "0xF6",
        name: "discharge_limit",
        raw: `0x${hexByte(battery.dischargeLimitPercent / 10)}`,
        decoded: { percent: battery.dischargeLimitPercent, human: `${battery.dischargeLimitPercent}%`, encoding: "raw byte is percent / 10" },
      };
    }
    const kind = command === "osaifu-charge-window" ? "chargeWindow" : "dischargeWindow";
    if (positional.length) state.battery[kind] = { startHour: Number(positional[0]), endHour: Number(positional[1]) };
    const window = state.battery[kind];
    return {
      ...(positional.length ? { ok: true, esv: "Set_Res" } : {}),
      host: battery.host,
      eoj: BATTERY_EOJ,
      epc: command === "osaifu-charge-window" ? "0xF4" : "0xF5",
      name: command.replaceAll("-", "_"),
      raw: windowRaw(window),
      decoded: decodeWindow(window),
    };
  }

  function energyStatus(args) {
    if (state.pollAdvanceMs) advance(state.pollAdvanceMs);
    const batteryHost = String(args["battery-host"] ?? state.battery.host);
    const solarHost = String(args["solar-host"] ?? state.solar.host);
    const batteryAvailable = hostAvailable(batteryHost);
    const batteryValue = (value) => batteryAvailable ? value : null;
    const solarEnabled = args["no-solar"] !== true;
    const solarAvailable = solarEnabled && hostAvailable(solarHost);
    const primaryHost = String(args["fuel-cell-primary-host"] ?? state.fuelCell.primaryHost);
    const proxyHosts = normalizedHostList(args["fuel-cell-proxy-host"] ?? state.fuelCell.proxyHosts)
      .filter((host) => host !== primaryHost);
    const errors = [];
    const addUnavailableErrors = (host, eoj, epcs) => {
      for (const epc of epcs) errors.push({ host, eoj, epc, error: `${host} simulated timeout` });
    };
    if (!batteryAvailable) {
      addUnavailableErrors(batteryHost, BATTERY_EOJ, ["0xD3", "0xE4", "0x80", "0xDA", "0xCF", "0xF0"]);
    }
    if (solarEnabled && !solarAvailable) addUnavailableErrors(solarHost, SOLAR_EOJ, ["0xE0"]);
    if (!hostAvailable(primaryHost)) {
      addUnavailableErrors(primaryHost, FUEL_CELL_EOJ, ["0xC4", "0xCB", "0xC2", "0xC5", "0xC8", "0xD0", "0xF4"]);
    }
    for (const host of proxyHosts) {
      if (!hostAvailable(host)) addUnavailableErrors(host, FUEL_CELL_EOJ, ["0xC4", "0xCB"]);
    }
    return {
      errors,
      solar: solarEnabled ? {
        instant_power: metric({ host: solarHost, eoj: SOLAR_EOJ, epc: "0xE0", name: "solar_instant_power", value: solarAvailable ? state.solar.instantPowerW : null, unit: "W", raw: solarAvailable ? rawUnsigned(state.solar.instantPowerW, 2) : null }),
      } : null,
      battery: {
        instant_power: metric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0xD3", name: "battery_instant_power", value: batteryValue(state.battery.instantPowerW), unit: "W", raw: batteryValue(rawUnsigned(Math.abs(state.battery.instantPowerW), 4)) }),
        remaining_percent: metric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0xE4", name: "battery_remaining_percent", value: batteryValue(Math.round(state.battery.stateOfChargePercent)), unit: "%", raw: batteryValue(rawUnsigned(state.battery.stateOfChargePercent, 1)) }),
        operation_status: enumMetric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0x80", name: "battery_operation_status", value: batteryValue(state.battery.operationStatus), raw: batteryValue("0x30") }),
        operation_mode: enumMetric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0xDA", name: "battery_operation_mode", value: batteryValue(state.battery.operationMode), raw: batteryValue(modeRaw(state.battery.operationMode)) }),
        working_status: enumMetric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0xCF", name: "battery_working_status", value: batteryValue(state.battery.workingStatus), raw: batteryValue(modeRaw(state.battery.workingStatus)) }),
        vendor_profile: enumMetric({ host: batteryHost, eoj: BATTERY_EOJ, epc: "0xF0", name: "battery_vendor_profile", value: batteryValue(state.battery.vendorProfile), raw: batteryValue(profileRaw(state.battery.vendorProfile)) }),
      },
      fuel_cells: args["no-fuel-cell"] === true ? [] : [
        simulatedFuelCellMetric(primaryHost, "primary", state.fuelCell, hostAvailable(primaryHost)),
        ...proxyHosts.map((host) => simulatedFuelCellMetric(host, "proxy", state.fuelCell, hostAvailable(host))),
      ],
    };
  }

  function meterStatus(args) {
    const host = String(args.host ?? state.meter.host);
    if (!hostAvailable(host)) throw new Error(`${host} simulated timeout`);
    const circuits = state.meter.circuits;
    const houseDemandW = circuits
      .map((circuit) => circuit.instantPowerW)
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + Math.max(0, value), 0);
    const net = state.meter.gridNetPowerW + Math.max(0, state.battery.instantPowerW);
    return {
      host,
      eoj: String(args.eoj ?? state.meter.eoj),
      grid_net_power: metric({ host, eoj: METER_EOJ, epc: "0xC6", name: "grid_net_power", value: net, unit: "W", raw: rawUnsigned(Math.abs(net)) }),
      grid_import_power: metric({ host, eoj: METER_EOJ, epc: "0xC6", name: "grid_import_power", value: Math.max(net, 0), unit: "W", raw: rawUnsigned(Math.abs(net)) }),
      grid_export_power: metric({ host, eoj: METER_EOJ, epc: "0xC6", name: "grid_export_power", value: Math.max(-net, 0), unit: "W", raw: rawUnsigned(Math.abs(net)) }),
      house_demand_power: metric({ host, eoj: METER_EOJ, epc: "0xB7", name: "house_demand_power", value: houseDemandW, unit: "W", raw: "0x00" }),
      cumulative_bought: metric({ host, eoj: METER_EOJ, epc: "0xC0", name: "electricity_bought", value: state.meter.cumulativeBoughtKwh, unit: "kWh", raw: rawUnsigned(state.meter.cumulativeBoughtKwh / state.meter.cumulativeUnitKwh) }),
      cumulative_sold: metric({ host, eoj: METER_EOJ, epc: "0xC1", name: "electricity_sold", value: state.meter.cumulativeSoldKwh, unit: "kWh", raw: rawUnsigned(state.meter.cumulativeSoldKwh / state.meter.cumulativeUnitKwh) }),
      cumulative_unit: metric({ host, eoj: METER_EOJ, epc: "0xC2", name: "cumulative_energy_unit", value: state.meter.cumulativeUnitKwh, unit: "kWh", raw: "0x01" }),
      channel_power: { host, eoj: METER_EOJ, epc: "0xB7", name: "channel_instant_power", raw: "0x00", decoded: { start: circuits[0]?.channel ?? null, range: circuits.length, channels: circuits.map((circuit) => ({ channel: circuit.channel, value: circuit.instantPowerW, unit: "W", human: `${circuit.instantPowerW} W` })) } },
      channel_energy: { host, eoj: METER_EOJ, epc: "0xB3", name: "channel_cumulative_energy", raw: "0x00", decoded: { start: circuits[0]?.channel ?? null, range: circuits.length, channels: circuits.map((circuit) => ({ channel: circuit.channel, count: Math.round(circuit.cumulativeKwh / state.meter.cumulativeUnitKwh), value: circuit.cumulativeKwh, unit: "kWh", human: `${circuit.cumulativeKwh.toFixed(2)} kWh` })) } },
    };
  }

  function rawGet(args, positional) {
    const epc = String(positional[0] ?? "").toUpperCase();
    const properties = {
      "0XF0": profileRaw(state.battery.vendorProfile),
      "0XF4": windowRaw(state.battery.chargeWindow),
      "0XF5": windowRaw(state.battery.dischargeWindow),
      "0XF6": `0x${hexByte(state.battery.dischargeLimitPercent / 10)}`,
      "0XDA": modeRaw(state.battery.operationMode),
    };
    if (!properties[epc]) throw new Error(`unsupported simulated raw-get EPC ${positional[0]}`);
    return { host: args.host, eoj: args.eoj ?? BATTERY_EOJ, epc: epc.replace("X", "x"), raw: properties[epc], parsed: null };
  }

  function discoveryResult() {
    return {
      [state.battery.host]: { all_instances: ["027d01", "027901"], storage_battery_instances: [1] },
      [state.meter.host]: { all_instances: ["028701", "027c01"], storage_battery_instances: [] },
      [state.fuelCell.primaryHost]: { all_instances: ["027c01"], storage_battery_instances: [] },
    };
  }

  async function execute(command, args = {}, positional = []) {
    const call = { command, args: clone(args), positional: clone(positional), at: new Date().toISOString() };
    calls.push(call);
    const fault = faults.find((item) => item.remaining > 0 && item.command === command && (!item.host || item.host === args.host));
    if (fault) {
      fault.remaining -= 1;
      if (fault.kind === "reject") return { ok: false, acknowledged: false, esv: fault.esv };
      throw new Error(fault.message);
    }

    switch (command) {
      case "energy-status": return clone(energyStatus(args));
      case "meter-status": return clone(meterStatus(args));
      case "vendor-profile":
      case "discharge-limit":
      case "osaifu-charge-window":
      case "osaifu-discharge-window":
        return clone(batterySetting(command, positional));
      case "set-mode": {
        const mode = String(positional[0]);
        state.battery.operationMode = mode;
        state.battery.workingStatus = mode;
        state.battery.instantPowerW = mode === "standby" || mode === "auto" ? 0 : state.battery.instantPowerW;
        return { ok: true, esv: "Set_Res", mode, host: args.host ?? state.battery.host, eoj: BATTERY_EOJ, epc: "0xDA", raw: modeRaw(mode) };
      }
      case "charge":
      case "discharge": {
        const charging = command === "charge";
        state.battery.operationMode = charging ? "charging" : "discharging";
        state.battery.workingStatus = state.battery.operationMode;
        state.battery.instantPowerW = (charging ? 1 : -1) * state.battery.chargePowerWatts;
        state.battery.targetWh = args["target-wh"] === undefined ? null : Number(args["target-wh"]);
        return { host: args.host ?? state.battery.host, eoj: BATTERY_EOJ, results: [{ epc: charging ? "0xD8" : "0xD6", ok: true, esv: "Set_Res" }, { epc: "0xDA", ok: true, esv: "Set_Res" }] };
      }
      case "fuel-cell-generation": {
        const requested = String(positional[0]);
        state.fuelCell.generationStatus = requested === "on" ? "starting" : "stopping";
        state.fuelCell.instantPowerW = 0;
        return {
          ok: true,
          esv: "Set_Res",
          host: args.host ?? state.fuelCell.primaryHost,
          eoj: FUEL_CELL_EOJ,
          epc: "0xCA",
          requested,
          edt: requested === "on" ? "0x41" : "0x42",
        };
      }
      case "raw-get": return clone(rawGet(args, positional));
      case "raw-set": return { ok: true, esv: "Set_Res", host: args.host, eoj: args.eoj ?? BATTERY_EOJ, epc: positional[0], raw: positional[1] };
      case "discover": return clone(discoveryResult());
      case "inspect-host": {
        const eoj = String(args.eoj ?? (args.host === state.meter.host ? METER_EOJ : args.host === state.fuelCell.primaryHost ? FUEL_CELL_EOJ : BATTERY_EOJ));
        return { [eoj]: { name: "simulated_device", inf_property_map: [], set_property_map: ["0xDA"], get_property_map: ["0x80", "0xD3", "0xDA"] } };
      }
      case "probe": return { [BATTERY_EOJ]: { set_property_map: ["0xDA"], get_property_map: ["0x80", "0xD3", "0xDA"] } };
      case "status": return {
        "0x80": { raw: "0x30", parsed: state.battery.operationStatus },
        "0xD3": { raw: rawUnsigned(Math.abs(state.battery.instantPowerW)), parsed: state.battery.instantPowerW },
        "0xCF": { raw: modeRaw(state.battery.workingStatus), parsed: state.battery.workingStatus },
        "0xDA": { raw: modeRaw(state.battery.operationMode), parsed: state.battery.operationMode },
        "0xE4": { raw: rawUnsigned(state.battery.stateOfChargePercent, 1), parsed: state.battery.stateOfChargePercent },
        "0xF0": { raw: profileRaw(state.battery.vendorProfile), parsed: state.battery.vendorProfile },
      };
      case "dump-eoj": return { host: args.host, eoj: args.eoj ?? BATTERY_EOJ, name: "simulated_device", get_property_map_raw: "0x00", get_property_map: [], properties: {} };
      case "dump-vendor": return {
        host: args.host ?? state.battery.host,
        eoj: BATTERY_EOJ,
        name: "storage_battery",
        vendor_epcs: ["0xF0", "0xF4", "0xF5", "0xF6"],
        writable_vendor_epcs: ["0xF0", "0xF4", "0xF5", "0xF6"],
        properties: {
          "0xF0": { raw: profileRaw(state.battery.vendorProfile), vendor_decoded: { mode: state.battery.vendorProfile }, writable: true },
          "0xF4": { raw: windowRaw(state.battery.chargeWindow), vendor_decoded: decodeWindow(state.battery.chargeWindow), writable: true },
          "0xF5": { raw: windowRaw(state.battery.dischargeWindow), vendor_decoded: decodeWindow(state.battery.dischargeWindow), writable: true },
          "0xF6": { raw: `0x${hexByte(state.battery.dischargeLimitPercent / 10)}`, vendor_decoded: { percent: state.battery.dischargeLimitPercent }, writable: true },
        },
      };
      default: throw new Error(`unsupported simulated device command: ${command}`);
    }
  }

  function snapshot() {
    return clone(state);
  }

  return {
    execute,
    snapshot,
    setState,
    setHostAvailable,
    failNext,
    rejectNext,
    advance,
    calls,
  };
}

export async function createDeviceCommandAdapter({ environment = process.env } = {}) {
  let state = {};
  if (environment.DEVICE_SIMULATOR_STATE_JSON) state = JSON.parse(environment.DEVICE_SIMULATOR_STATE_JSON);
  if (environment.DEVICE_SIMULATOR_STATE_FILE) {
    state = merge(state, JSON.parse(await readFile(environment.DEVICE_SIMULATOR_STATE_FILE, "utf8")));
  }
  return createDeviceSimulator({
    scenario: environment.DEVICE_SIMULATOR_SCENARIO || "normal",
    state,
  });
}

export { DEFAULT_DEVICE_STATE, DEVICE_SCENARIOS };
