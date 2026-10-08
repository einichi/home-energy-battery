import { createEchonetClient } from "./echonet-transport.js";
import type { EchonetClient } from "./echonet-transport.js";
import {
  DEFAULT_VENDOR_EPCS,
  EDT_TO_FUEL_CELL_INTERCONNECTION,
  EDT_TO_FUEL_CELL_STATUS,
  EDT_TO_MODE,
  EDT_TO_VENDOR_PROFILE,
  EPC,
  FUEL_CELL_EOJ,
  MODE_TO_EDT,
  POWER_METER_EOJ,
  SOLAR_EOJ,
  STORAGE_BATTERY_EOJ,
  VENDOR_PROFILE_TO_EDT,
  acknowledgedSet,
  cumulativeUnit,
  decodeCumulativeKwh,
  decodeCumulativePowerList,
  decodeEnum,
  decodeFuelCellCumulative,
  decodeFuelCellHotWaterLevel,
  decodeInstantPowerList,
  decodeOsaifuWindow,
  decodePercent,
  decodeSignedW,
  decodeUnsigned,
  decodeVendorProfile,
  decodeVendorProperty,
  decodedOrRawData,
  eojHex,
  eojName,
  mapToHex,
  metric,
  numberList,
  parseByte,
  parseEoj,
  parseHexBytes,
  parseHour,
  propRaw,
  rawHex,
  responseData,
  sumInstantPowerChannels,
  uint32,
} from "./echonet-codecs.js";
import { errorMessage } from "../domain/values.js";
import { STORAGE_BATTERY_CLASS_BYTES } from "../domain/echonet-constants.js";

interface CommandOptions extends Record<string, unknown> {
  _: unknown[];
  __client?: EchonetClient;
}

type CommandHandler = (options: CommandOptions) => Promise<unknown>;

function makeClient(opts: Record<string, unknown>): EchonetClient {
  return createEchonetClient({
    timeout: Number(opts.timeout ?? 3),
    netif: String(opts.netif ?? ""),
    debug: opts.debug === true,
  });
}

// A shared persistent client carries one fixed timeout. Wrap it so each request
// uses the per-command timeout, matching the standalone-client behaviour (the
// timeout bounds a single request, not the whole multi-step command).
function withCommandTimeout(client: EchonetClient, timeoutSeconds: number): EchonetClient {
  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
  return {
    init: () => client.init(),
    close: () => client.close(),
    get: (host, eoj, epc) => client.get(host, eoj, epc, timeoutMs),
    set: (host, eoj, epc, edt) => client.set(host, eoj, epc, edt, timeoutMs),
    maps: (host, eoj) => client.maps(host, eoj, timeoutMs),
    discover: () => client.discover(timeoutMs),
  };
}

async function withClient<T>(opts: CommandOptions, fn: (client: EchonetClient) => Promise<T>): Promise<T> {
  if (opts.__client) {
    const timeoutSeconds = Number(opts.timeout);
    const client = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? withCommandTimeout(opts.__client, timeoutSeconds)
      : opts.__client;
    return fn(client);
  }
  const client = makeClient(opts);
  await client.init();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function cmdDiscover(opts: CommandOptions) {
  return withClient(opts, async (client) => {
    const devices = await client.discover();
    return devices;
  });
}

async function cmdInspectHost(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  return withClient(opts, async (client) => {
    let eojs = opts.eoj ? [parseEoj(opts.eoj)] : [];
    if (!eojs.length) {
      const res = await client.get(host, [0x0e, 0xf0, 0x01], EPC.INSTANCE_LIST);
      eojs = Array.isArray(responseData(res).list) ? responseData(res).list as number[][] : [];
    }
    const out: Record<string, unknown> = {};
    for (const eoj of eojs) {
      try {
        const maps = await client.maps(host, eoj);
        const data = responseData(maps);
        out[eojHex(eoj)] = {
          name: eojName(eoj),
          inf_property_map: mapToHex(data.inf),
          set_property_map: mapToHex(data.set),
          get_property_map: mapToHex(data.get),
        };
      } catch (error: unknown) {
        out[eojHex(eoj)] = { name: eojName(eoj), error: errorMessage(error) };
      }
    }
    return out;
  });
}

async function cmdProbe(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  return withClient(opts, async (client) => {
    const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
    const maps = await client.maps(host, eoj);
    const data = responseData(maps);
    return {
      [eojHex(eoj)]: {
        set_property_map: mapToHex(data.set),
        get_property_map: mapToHex(data.get),
      },
    };
  });
}

async function cmdDumpEoj(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  return withClient(opts, async (client) => {
    const epcs: number[] = [];
    let mapRaw: Buffer | null = null;
    let mapHex: string[] = [];
    if (opts.epc !== undefined) {
      epcs.push(...values(opts.epc, []).map(parseByte));
    } else {
      const maps = await client.maps(host, eoj);
      const data = responseData(maps);
      mapHex = mapToHex(data.get);
      epcs.push(...numberList(data.get));
      const mapProp = maps.message?.prop?.find((property) => property.epc === EPC.GET_PROPERTY_MAP);
      mapRaw = mapProp?.buffer ?? null;
    }
    const properties: Record<string, unknown> = {};
    const out = {
      host,
      eoj: eojHex(eoj),
      name: eojName(eoj),
      get_property_map_raw: rawHex(mapRaw),
      get_property_map: mapHex.length ? mapHex : epcs.map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      properties,
    };
    for (const epc of epcs) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
        };
      } catch (error: unknown) {
        properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = { error: errorMessage(error) };
      }
    }
    return out;
  });
}

async function cmdDumpVendor(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  // Vendor-specific settings are not always documented in public class specs,
  // so this command focuses on the EPCs that have proven useful and annotates
  // only the encodings we have actually observed.
  const requested: number[] = opts.epc !== undefined
    ? values(opts.epc, []).map((value: unknown) => parseByte(value))
    : DEFAULT_VENDOR_EPCS;
  return withClient(opts, async (client) => {
    let writable: number[] = [];
    let readable: number[] = [];
    try {
      const maps = await client.maps(host, eoj);
      const data = responseData(maps);
      writable = numberList(data.set);
      readable = numberList(data.get);
    } catch {
      writable = [];
      readable = [];
    }

    const epcs = requested.filter((epc) => !readable.length || readable.includes(epc) || writable.includes(epc));
    const properties: Record<string, unknown> = {};
    const out = {
      host,
      eoj: eojHex(eoj),
      name: eojName(eoj),
      vendor_epcs: epcs.map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      writable_vendor_epcs: epcs
        .filter((epc) => writable.includes(epc))
        .map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      properties,
    };

    for (const epc of epcs) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
          vendor_decoded: decodeVendorProperty(epc, raw),
          writable: writable.includes(epc),
        };
      } catch (error: unknown) {
        properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          error: errorMessage(error),
          writable: writable.includes(epc),
        };
      }
    }
    return out;
  });
}

async function cmdRawGet(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  const epc = parseByte(required(opts._[1], "EPC"));
  return withClient(opts, async (client) => {
    const res = await client.get(host, eoj, epc);
    return {
      host,
      eoj: eojHex(eoj),
      epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`,
      raw: rawHex(propRaw(res, epc)),
      parsed: decodedOrRawData(res),
    };
  });
}

async function cmdRawSet(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  const epc = parseByte(required(opts._[1], "EPC"));
  const edt = parseHexBytes(required(opts._[2], "EDT"));
  if (opts["dry-run"]) return { host, eoj: eojHex(eoj), epc: `0x${epc.toString(16)}`, edt: rawHex(edt) };
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, epc, edt);
    return { ...acknowledgedSet(res, `raw write to 0x${epc.toString(16).padStart(2, "0").toUpperCase()}`), raw: rawHex(propRaw(res, epc)) };
  });
}

async function cmdStatus(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
  const props: number[] = [
    EPC.OPERATION_STATUS,
    EPC.INSTANT_POWER_W,
    EPC.WORKING_STATUS,
    EPC.OPERATION_MODE,
    EPC.REMAINING_PERCENT,
    EPC.VENDOR_PROFILE,
  ];
  return withClient(opts, async (client) => {
    const out: Record<string, unknown> = {};
    for (const epc of props) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        out[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
        };
      } catch (error: unknown) {
        out[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = { error: errorMessage(error) };
      }
    }
    return out;
  });
}

async function cmdLivePower(opts: CommandOptions) {
  const batteryHost = String(opts["battery-host"] ?? "192.0.2.10");
  const solarEnabled = !opts["no-solar"];
  const solarHost = String(opts["solar-host"] ?? batteryHost);
  const meterEnabled = !opts["no-meter"];
  const meterHost = String(opts["meter-host"] ?? "192.0.2.20");
  const meterEojText = String(opts["meter-eoj"] ?? POWER_METER_EOJ);
  const fuelCellEnabled = !opts["no-fuel-cell"];
  const legacyFuelCellHosts = values(opts["fuel-cell-host"], []);
  const fuelCellPrimaryHost = String(opts["fuel-cell-primary-host"] ?? legacyFuelCellHosts[0] ?? "192.0.2.30");

  return withClient(opts, async (client) => {
    const startedAt = new Date().toISOString();
    const errors: Array<Record<string, unknown>> = [];
    async function read(host: string, eoj: unknown, epc: number): Promise<{ raw: Buffer | null; acquiredAt: string }> {
      try {
        const res = await client.get(host, parseEoj(eoj), epc);
        return { raw: propRaw(res, epc), acquiredAt: new Date().toISOString() };
      } catch (error: unknown) {
        const acquiredAt = new Date().toISOString();
        errors.push({
          host,
          eoj,
          epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`,
          error: errorMessage(error),
          acquired_at: acquiredAt,
        });
        return { raw: null, acquiredAt };
      }
    }
    const timestamped = (value: Record<string, unknown>, acquiredAt: string) => ({ ...value, acquired_at: acquiredAt });

    // Keep the balance-critical reads adjacent inside one queue item. Writes may
    // still run before this command, but slower settings and counter reads cannot
    // be interleaved between these measurements.
    const solarPower = solarEnabled ? await read(solarHost, SOLAR_EOJ, EPC.SOLAR_INSTANT_POWER_W) : null;
    const batteryPower = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.INSTANT_POWER_W);
    const fuelCellPower = fuelCellEnabled ? await read(fuelCellPrimaryHost, FUEL_CELL_EOJ, EPC.FUEL_CELL_INSTANT_POWER_W) : null;
    const gridPower = meterEnabled ? await read(meterHost, meterEojText, EPC.METER_INSTANT_POWER_W) : null;
    const channelPowerRaw = meterEnabled ? await read(meterHost, meterEojText, EPC.METER_INSTANT_POWER_LIST) : null;
    const netGridWatts = gridPower?.raw && gridPower.raw.length === 4 ? gridPower.raw.readInt32BE(0) : null;
    const channelPower = decodeInstantPowerList(channelPowerRaw?.raw ?? null);
    const branchDemandWatts = sumInstantPowerChannels(channelPower);
    const completedAt = new Date().toISOString();

    return {
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
      errors,
      energy: {
        solar: solarPower ? {
          instant_power: timestamped(decodeUnsigned({
            host: solarHost,
            eoj: SOLAR_EOJ,
            epc: EPC.SOLAR_INSTANT_POWER_W,
            name: "solar_instant_power",
            raw: solarPower.raw,
            unit: "W",
          }), solarPower.acquiredAt),
        } : null,
        battery: {
          instant_power: timestamped(decodeSignedW({
            host: batteryHost,
            eoj: STORAGE_BATTERY_EOJ,
            epc: EPC.INSTANT_POWER_W,
            name: "battery_instant_power",
            raw: batteryPower.raw,
          }), batteryPower.acquiredAt),
        },
        fuel_cells: fuelCellPower ? [{
          host: fuelCellPrimaryHost,
          source_role: "primary",
          instant_power: timestamped(decodeUnsigned({
            host: fuelCellPrimaryHost,
            eoj: FUEL_CELL_EOJ,
            epc: EPC.FUEL_CELL_INSTANT_POWER_W,
            name: "fuel_cell_instant_power",
            raw: fuelCellPower.raw,
            unit: "W",
          }), fuelCellPower.acquiredAt),
        }] : [],
      },
      meter: meterEnabled ? {
        grid_net_power: timestamped(decodeSignedW({
          host: meterHost,
          eoj: meterEojText,
          epc: EPC.METER_INSTANT_POWER_W,
          name: "grid_net_power",
          raw: gridPower?.raw ?? null,
        }), gridPower?.acquiredAt ?? completedAt),
        grid_import_power: timestamped(metric({
          host: meterHost,
          eoj: meterEojText,
          epc: EPC.METER_INSTANT_POWER_W,
          name: "grid_import_power",
          raw: gridPower?.raw ?? null,
          value: netGridWatts === null ? undefined : Math.max(netGridWatts, 0),
          unit: "W",
          human: netGridWatts === null ? undefined : `${Math.max(netGridWatts, 0)} W`,
        }), gridPower?.acquiredAt ?? completedAt),
        grid_export_power: timestamped(metric({
          host: meterHost,
          eoj: meterEojText,
          epc: EPC.METER_INSTANT_POWER_W,
          name: "grid_export_power",
          raw: gridPower?.raw ?? null,
          value: netGridWatts === null ? undefined : Math.max(-netGridWatts, 0),
          unit: "W",
          human: netGridWatts === null ? undefined : `${Math.max(-netGridWatts, 0)} W`,
        }), gridPower?.acquiredAt ?? completedAt),
        branch_demand_power: timestamped(metric({
          host: meterHost,
          eoj: meterEojText,
          epc: EPC.METER_INSTANT_POWER_LIST,
          name: "branch_demand_power",
          raw: channelPowerRaw?.raw ?? null,
          value: branchDemandWatts ?? undefined,
          unit: "W",
          human: branchDemandWatts === null ? undefined : `${branchDemandWatts} W`,
        }), channelPowerRaw?.acquiredAt ?? completedAt),
        channel_power: {
          host: meterHost,
          eoj: meterEojText,
          epc: "0xB7",
          name: "channel_instant_power",
          raw: rawHex(channelPowerRaw?.raw ?? null),
          acquired_at: channelPowerRaw?.acquiredAt ?? completedAt,
          decoded: channelPower,
        },
      } : { configured: false },
    };
  });
}

async function cmdEnergyStatus(opts: CommandOptions) {
  const solarEnabled = !opts["no-solar"];
  const fuelCellEnabled = !opts["no-fuel-cell"];
  const solarHost = String(opts["solar-host"] ?? "192.0.2.10");
  const batteryHost = String(opts["battery-host"] ?? "192.0.2.10");
  const legacyFuelCellHosts = values(opts["fuel-cell-host"], []);
  const fuelCellPrimaryHost = String(opts["fuel-cell-primary-host"] ?? legacyFuelCellHosts[0] ?? "192.0.2.30");
  const fuelCellProxyHosts: unknown[] = values(opts["fuel-cell-proxy-host"], legacyFuelCellHosts.slice(1));
  return withClient(opts, async (client) => {
    const errors: Array<Record<string, unknown>> = [];
    async function read(host: string, eoj: unknown, epc: number): Promise<Buffer | null> {
      try {
        const res = await client.get(host, parseEoj(eoj), epc);
        return propRaw(res, epc);
      } catch (error: unknown) {
        errors.push({
          host,
          eoj,
          epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`,
          error: errorMessage(error),
        });
        return null;
      }
    }
    const solarPower = solarEnabled ? await read(solarHost, SOLAR_EOJ, EPC.SOLAR_INSTANT_POWER_W) : null;
    const batteryPower = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.INSTANT_POWER_W);
    const batteryPercent = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.REMAINING_PERCENT);
    const batteryOperationStatus = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.OPERATION_STATUS);
    const batteryOperationMode = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.OPERATION_MODE);
    const batteryWorking = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.WORKING_STATUS);
    const batteryVendorProfile = await read(batteryHost, STORAGE_BATTERY_EOJ, EPC.VENDOR_PROFILE);
    const fuelCells: Array<Record<string, unknown>> = [];
    const out = {
      errors,
      solar: solarEnabled ? {
        instant_power: decodeUnsigned({
          host: solarHost,
          eoj: SOLAR_EOJ,
          epc: EPC.SOLAR_INSTANT_POWER_W,
          name: "solar_instant_power",
          raw: solarPower,
          unit: "W",
        }),
      } : null,
      battery: {
        instant_power: decodeSignedW({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.INSTANT_POWER_W,
          name: "battery_instant_power",
          raw: batteryPower,
        }),
        remaining_percent: decodePercent({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.REMAINING_PERCENT,
          name: "battery_remaining_percent",
          raw: batteryPercent,
          unit: "%",
        }),
        operation_status: decodeEnum({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.OPERATION_STATUS,
          name: "battery_operation_status",
          raw: batteryOperationStatus,
          mapping: {
            0x30: "on",
            0x31: "off",
          },
        }),
        operation_mode: decodeEnum({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.OPERATION_MODE,
          name: "battery_operation_mode",
          raw: batteryOperationMode,
          mapping: EDT_TO_MODE,
        }),
        working_status: decodeEnum({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.WORKING_STATUS,
          name: "battery_working_status",
          raw: batteryWorking,
          mapping: EDT_TO_MODE,
        }),
        vendor_profile: decodeEnum({
          host: batteryHost,
          eoj: STORAGE_BATTERY_EOJ,
          epc: EPC.VENDOR_PROFILE,
          name: "battery_vendor_profile",
          raw: batteryVendorProfile,
          mapping: EDT_TO_VENDOR_PROFILE,
        }),
      },
      fuel_cells: fuelCells,
    };
    const fuelCellSources = fuelCellEnabled
      ? [
          ...(fuelCellPrimaryHost ? [{ host: fuelCellPrimaryHost, role: "primary" }] : []),
          ...fuelCellProxyHosts.map(String).filter((host) => host !== fuelCellPrimaryHost).map((host) => ({ host, role: "proxy" })),
        ]
      : [];
    for (const { host, role } of fuelCellSources) {
      const power = await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_INSTANT_POWER_W);
      const status = await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_GENERATION_STATUS);
      const ratedPower = role === "primary" ? await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_RATED_POWER_W) : null;
      const cumulativeGeneration = role === "primary" ? await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_CUMULATIVE_GENERATION) : null;
      const cumulativeGas = role === "primary" ? await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_CUMULATIVE_GAS) : null;
      const interconnection = role === "primary" ? await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_INTERCONNECTION_STATUS) : null;
      const hotWaterLevel = role === "primary" ? await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_HOT_WATER_LEVEL) : null;
      fuelCells.push({
        host,
        source_role: role,
        instant_power: decodeUnsigned({
          host,
          eoj: FUEL_CELL_EOJ,
          epc: EPC.FUEL_CELL_INSTANT_POWER_W,
          name: "fuel_cell_instant_power",
          raw: power,
          unit: "W",
        }),
        generation_status: decodeEnum({
          host,
          eoj: FUEL_CELL_EOJ,
          epc: EPC.FUEL_CELL_GENERATION_STATUS,
          name: "fuel_cell_generation_status",
          raw: status,
          mapping: EDT_TO_FUEL_CELL_STATUS,
        }),
        ...(role === "primary" ? {
          rated_power: decodeUnsigned({
            host,
            eoj: FUEL_CELL_EOJ,
            epc: EPC.FUEL_CELL_RATED_POWER_W,
            name: "fuel_cell_rated_power",
            raw: ratedPower,
            unit: "W",
          }),
          cumulative_generation: decodeFuelCellCumulative({
            host,
            epc: EPC.FUEL_CELL_CUMULATIVE_GENERATION,
            name: "fuel_cell_cumulative_generation",
            raw: cumulativeGeneration,
            unit: "kWh",
          }),
          cumulative_gas: decodeFuelCellCumulative({
            host,
            epc: EPC.FUEL_CELL_CUMULATIVE_GAS,
            name: "fuel_cell_cumulative_gas",
            raw: cumulativeGas,
            unit: "m3",
          }),
          interconnection_status: decodeEnum({
            host,
            eoj: FUEL_CELL_EOJ,
            epc: EPC.FUEL_CELL_INTERCONNECTION_STATUS,
            name: "fuel_cell_interconnection_status",
            raw: interconnection,
            mapping: EDT_TO_FUEL_CELL_INTERCONNECTION,
          }),
          hot_water_level: decodeFuelCellHotWaterLevel({
            host,
            raw: hotWaterLevel,
          }),
        } : {}),
      });
    }
    return out;
  });
}

async function cmdMeterStatus(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const eojText = String(opts.eoj ?? POWER_METER_EOJ);
  const eoj = parseEoj(eojText);
  return withClient(opts, async (client) => {
    async function read(epc: number): Promise<Buffer | null> {
      try {
        const res = await client.get(host, eoj, epc);
        return propRaw(res, epc);
      } catch (error: unknown) {
        errors.push({
          host,
          eoj: eojText,
          epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`,
          error: errorMessage(error),
        });
        return null;
      }
    }

    const errors: Array<Record<string, unknown>> = [];

    // Some controller/meters expose both long-term import/export counters and
    // instantaneous values. The dashboard cares mostly about the instantaneous
    // net grid power and per-channel demand list.
    const normalRaw = await read(EPC.METER_CUMULATIVE_NORMAL);
    const reverseRaw = await read(EPC.METER_CUMULATIVE_REVERSE);
    const unitRaw = await read(EPC.METER_CUMULATIVE_UNIT);
    const instantRaw = await read(EPC.METER_INSTANT_POWER_W);
    const channelsRaw = await read(EPC.METER_INSTANT_POWER_LIST);
    const cumulativeChannelsRaw = await read(EPC.METER_CUMULATIVE_POWER_LIST);
    const unit = cumulativeUnit(unitRaw);
    const netGridWatts = instantRaw && instantRaw.length === 4 ? instantRaw.readInt32BE(0) : null;
    const finiteNetGridWatts = netGridWatts ?? Number.NaN;
    const channelPower = decodeInstantPowerList(channelsRaw);
    const channelEnergy = decodeCumulativePowerList(cumulativeChannelsRaw, unit);
    const branchDemandWatts = sumInstantPowerChannels(channelPower);

    return {
      errors,
      host,
      eoj: eojHex(eoj),
      grid_net_power: decodeSignedW({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_W,
        name: "grid_net_power",
        raw: instantRaw,
      }),
      grid_import_power: metric({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_W,
        name: "grid_import_power",
        raw: instantRaw,
        value: Number.isFinite(finiteNetGridWatts) ? Math.max(finiteNetGridWatts, 0) : undefined,
        unit: "W",
        human: Number.isFinite(finiteNetGridWatts) ? `${Math.max(finiteNetGridWatts, 0)} W` : undefined,
      }),
      grid_export_power: metric({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_W,
        name: "grid_export_power",
        raw: instantRaw,
        value: Number.isFinite(finiteNetGridWatts) ? Math.max(-finiteNetGridWatts, 0) : undefined,
        unit: "W",
        human: Number.isFinite(finiteNetGridWatts) ? `${Math.max(-finiteNetGridWatts, 0)} W` : undefined,
      }),
      branch_demand_power: metric({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_LIST,
        name: "branch_demand_power",
        raw: channelsRaw,
        value: Number.isFinite(branchDemandWatts) ? branchDemandWatts : undefined,
        unit: "W",
        human: Number.isFinite(branchDemandWatts) ? `${branchDemandWatts} W` : undefined,
      }),
      cumulative_bought: decodeCumulativeKwh({
        host,
        eoj: eojText,
        epc: EPC.METER_CUMULATIVE_NORMAL,
        name: "electricity_bought",
        raw: normalRaw,
        unit,
      }),
      cumulative_sold: decodeCumulativeKwh({
        host,
        eoj: eojText,
        epc: EPC.METER_CUMULATIVE_REVERSE,
        name: "electricity_sold",
        raw: reverseRaw,
        unit,
      }),
      cumulative_unit: {
        host,
        eoj: eojText,
        epc: "0xC2",
        name: "cumulative_energy_unit",
        raw: rawHex(unitRaw),
        value: unit,
        unit: "kWh",
        human: unit === null || unit === undefined ? null : `${unit} kWh/count`,
      },
      channel_power: {
        host,
        eoj: eojText,
        epc: "0xB7",
        name: "channel_instant_power",
        raw: rawHex(channelsRaw),
        decoded: channelPower,
      },
      channel_energy: {
        host,
        eoj: eojText,
        epc: "0xB3",
        name: "channel_cumulative_energy",
        raw: rawHex(cumulativeChannelsRaw),
        decoded: channelEnergy,
      },
    };
  });
}

async function setOperationMode(opts: CommandOptions, mode: string) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  if (!(mode in MODE_TO_EDT)) throw new Error(`unknown mode: ${mode}`);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
  const edt = Buffer.from([MODE_TO_EDT[mode]]);
  if (opts["dry-run"]) return { host, eoj: eojHex(eoj), epc: "0xDA", edt: rawHex(edt), mode };
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, EPC.OPERATION_MODE, edt);
    return { ...acknowledgedSet(res, `operation mode ${mode} request`), mode };
  });
}

async function cmdSetMode(opts: CommandOptions) {
  return setOperationMode(opts, required(opts._[1], "MODE"));
}

async function cmdVendorProfile(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];

  const mode = opts._[1];
  if (mode === undefined) {
    return withClient(opts, async (client) => {
      const res = await client.get(host, eoj, EPC.VENDOR_PROFILE);
      const raw = propRaw(res, EPC.VENDOR_PROFILE);
      return {
        host,
        eoj: eojHex(eoj),
        epc: "0xF0",
        name: "vendor_profile",
        raw: rawHex(raw),
        decoded: decodeVendorProfile(raw),
      };
    });
  }

  const modeName = String(mode);
  if (!(modeName in VENDOR_PROFILE_TO_EDT)) throw new Error(`unknown vendor profile: ${modeName}`);
  const edt = Buffer.from([VENDOR_PROFILE_TO_EDT[modeName]]);
  if (opts["dry-run"]) {
    return {
      host,
      eoj: eojHex(eoj),
      epc: "0xF0",
      name: "vendor_profile",
      mode: modeName,
      edt: rawHex(edt),
      decoded: decodeVendorProfile(edt),
    };
  }
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, EPC.VENDOR_PROFILE, edt);
    return {
      ...acknowledgedSet(res, `charging profile ${modeName} request`),
      host,
      eoj: eojHex(eoj),
      epc: "0xF0",
      name: "vendor_profile",
      mode: modeName,
      raw: rawHex(edt),
    };
  });
}

async function cmdOsaifuWindow(opts: CommandOptions, kind: "charge" | "discharge") {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
  const epc = kind === "charge" ? EPC.VENDOR_OSAIFU_CHARGE_WINDOW : EPC.VENDOR_OSAIFU_DISCHARGE_WINDOW;
  const epcHex = kind === "charge" ? "0xF4" : "0xF5";
  const name = kind === "charge" ? "osaifu_charge_window" : "osaifu_discharge_window";
  const startArg = opts.start ?? opts["start-hour"] ?? opts._[1];
  const endArg = opts.end ?? opts["end-hour"] ?? opts._[2];

  if (startArg === undefined && endArg === undefined) {
    return withClient(opts, async (client) => {
      const res = await client.get(host, eoj, epc);
      const raw = propRaw(res, epc);
      return {
        host,
        eoj: eojHex(eoj),
        epc: epcHex,
        name,
        raw: rawHex(raw),
        decoded: decodeOsaifuWindow(raw),
      };
    });
  }

  if (startArg === undefined || endArg === undefined) {
    throw new Error(`${name} requires both START_HOUR and END_HOUR`);
  }

  const startHour = parseHour(startArg, "START_HOUR");
  const endHour = parseHour(endArg, "END_HOUR");
  // Observed encoding: 02:00-04:00 is 0x02000400. The middle bytes have stayed
  // zero in observed reads/writes, so they are preserved as zero here.
  const edt = Buffer.from([startHour, 0x00, endHour, 0x00]);
  const out: Record<string, unknown> = {
    host,
    eoj: eojHex(eoj),
    epc: epcHex,
    name,
    start_hour: startHour,
    end_hour: endHour,
    edt: rawHex(edt),
    decoded: decodeOsaifuWindow(edt),
  };
  if (opts["dry-run"]) return out;

  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, epc, edt);
    return {
      ...acknowledgedSet(res, `${name} request`),
      ...out,
      raw: rawHex(edt),
    };
  });
}

async function cmdDischargeLimit(opts: CommandOptions) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
  const requestedPercent = opts._[1];

  if (requestedPercent === undefined) {
    return withClient(opts, async (client) => {
      const res = await client.get(host, eoj, EPC.VENDOR_DISCHARGE_LIMIT);
      const raw = propRaw(res, EPC.VENDOR_DISCHARGE_LIMIT);
      return {
        host,
        eoj: eojHex(eoj),
        epc: "0xF6",
        name: "discharge_limit",
        raw: rawHex(raw),
        decoded: decodeVendorProperty(EPC.VENDOR_DISCHARGE_LIMIT, raw),
      };
    });
  }

  const percent = Number(requestedPercent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || percent % 10 !== 0) {
    throw new Error("discharge limit must be a whole percent from 0 to 100 in 10% steps");
  }
  // Observed encoding: 20% is 0x02, 30% is 0x03, etc.
  const edt = Buffer.from([percent / 10]);
  if (opts["dry-run"]) {
    return {
      host,
      eoj: eojHex(eoj),
      epc: "0xF6",
      name: "discharge_limit",
      percent,
      edt: rawHex(edt),
      encoding: "raw byte is percent / 10",
    };
  }

  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, EPC.VENDOR_DISCHARGE_LIMIT, edt);
    return {
      ...acknowledgedSet(res, `discharge limit ${percent}% request`),
      host,
      eoj: eojHex(eoj),
      epc: "0xF6",
      percent,
      raw: rawHex(edt),
    };
  });
}

async function cmdChargeLike(opts: CommandOptions, mode: "charge" | "discharge") {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj: number[] = [...STORAGE_BATTERY_CLASS_BYTES, instance];
  const writes: Array<{ epc: number; edt: Buffer }> = [];
  if (opts["target-wh"] !== undefined) {
    writes.push({
      epc: mode === "discharge" ? EPC.AC_DISCHARGE_TARGET_WH : EPC.AC_CHARGE_TARGET_WH,
      edt: uint32(opts["target-wh"]),
    });
  }
  writes.push({ epc: EPC.OPERATION_MODE, edt: Buffer.from([MODE_TO_EDT[mode]]) });
  if (opts["dry-run"]) {
    return { host, eoj: eojHex(eoj), writes: writes.map((write) => ({ epc: `0x${write.epc.toString(16)}`, edt: rawHex(write.edt) })) };
  }
  return withClient(opts, async (client) => {
    const results: Array<Record<string, unknown>> = [];
    for (const write of writes) {
      const res = await client.set(host, eoj, write.epc, write.edt);
      const epc = `0x${write.epc.toString(16).padStart(2, "0").toUpperCase()}`;
      results.push({ epc, ...acknowledgedSet(res, `${mode} write ${epc}`) });
    }
    return { ok: true, acknowledged: true, host, eoj: eojHex(eoj), results };
  });
}

function required(value: unknown, label: string): string {
  if (value === undefined || value === "") throw new Error(`${label} is required`);
  return String(value);
}

function values(value: unknown, fallback: unknown[]): unknown[] {
  if (value === undefined) return fallback;
  return Array.isArray(value) ? value : [value];
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  discover: cmdDiscover,
  "inspect-host": cmdInspectHost,
  "dump-eoj": cmdDumpEoj,
  "dump-vendor": cmdDumpVendor,
  probe: cmdProbe,
  "raw-get": cmdRawGet,
  "raw-set": cmdRawSet,
  status: cmdStatus,
  "live-power": cmdLivePower,
  "energy-status": cmdEnergyStatus,
  "meter-status": cmdMeterStatus,
  "set-mode": cmdSetMode,
  "vendor-profile": cmdVendorProfile,
  "osaifu-charge-window": (opts) => cmdOsaifuWindow(opts, "charge"),
  "osaifu-discharge-window": (opts) => cmdOsaifuWindow(opts, "discharge"),
  "discharge-limit": cmdDischargeLimit,
  charge: (opts) => cmdChargeLike(opts, "charge"),
  discharge: (opts) => cmdChargeLike(opts, "discharge"),
};

async function executeEchonetCommand(command: string, args: Record<string, unknown> = {}, positional: unknown[] = [], client: EchonetClient | null = null): Promise<unknown> {
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`unknown command: ${command}`);
  return handler({
    ...args,
    _: [command, ...positional.map(String)],
    ...(client ? { __client: client } : {}),
  });
}

export { executeEchonetCommand };
