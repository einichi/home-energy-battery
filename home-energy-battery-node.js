#!/usr/bin/env node
import EchonetLite from "node-echonet-lite";

const ECHONET_PORT = 3610;
const STORAGE_BATTERY_EOJ = "0x027D01";
const SOLAR_EOJ = "0x027901";
const FUEL_CELL_EOJ = "0x027C01";
const POWER_METER_EOJ = "0x028701";
const DEFAULT_VENDOR_EPCS = [0xd7, 0xd9, 0xf0, 0xf4, 0xf5, 0xf6];

const EPC = {
  OPERATION_STATUS: 0x80,
  INSTANCE_LIST: 0xd6,
  GET_PROPERTY_MAP: 0x9f,
  SET_PROPERTY_MAP: 0x9e,
  AC_CHARGE_TARGET_WH: 0xaa,
  AC_DISCHARGE_TARGET_WH: 0xab,
  INSTANT_POWER_W: 0xd3,
  WORKING_STATUS: 0xcf,
  OPERATION_MODE: 0xda,
  REMAINING_PERCENT: 0xe4,
  VENDOR_PROFILE: 0xf0,
  VENDOR_OSAIFU_CHARGE_WINDOW: 0xf4,
  VENDOR_OSAIFU_DISCHARGE_WINDOW: 0xf5,
  VENDOR_DISCHARGE_LIMIT: 0xf6,
  SOLAR_INSTANT_POWER_W: 0xe0,
  FUEL_CELL_INSTANT_POWER_W: 0xc4,
  FUEL_CELL_GENERATION_STATUS: 0xcb,
  METER_CUMULATIVE_NORMAL: 0xc0,
  METER_CUMULATIVE_REVERSE: 0xc1,
  METER_CUMULATIVE_UNIT: 0xc2,
  METER_INSTANT_POWER_W: 0xc6,
  METER_INSTANT_POWER_LIST: 0xb7,
  METER_CUMULATIVE_POWER_LIST: 0xb3,
};

const ESV_SET_RES = "Set_Res";

// ECHONET Lite writes are byte buffers. These tables translate friendly command
// words into the one-byte EDT payloads observed for storage batteries.
const MODE_TO_EDT = {
  rapid: 0x41,
  rapid_charging: 0x41,
  charge: 0x42,
  charging: 0x42,
  backup: 0x42,
  discharge: 0x43,
  discharging: 0x43,
  standby: 0x44,
  auto: 0x46,
  automatic: 0x46,
};

const EDT_TO_MODE = {
  0x40: "other",
  0x41: "rapid_charging",
  0x42: "charging",
  0x43: "discharging",
  0x44: "standby",
  0x45: "test",
  0x46: "auto",
  0x47: "restart",
  0x48: "capacity_recalculation",
};

const VENDOR_PROFILE_TO_EDT = {
  osaifu: 0x02,
  eco: 0x03,
  backup: 0x20,
};

const EDT_TO_VENDOR_PROFILE = {
  0x02: "osaifu",
  0x03: "eco",
  0x20: "backup",
};

const EDT_TO_FUEL_CELL_STATUS = {
  0x40: "other",
  0x41: "generating",
  0x42: "stopped",
  0x43: "starting",
  0x44: "stopping",
};

// EOJ is the three-byte object identifier in ECHONET Lite. The first two bytes
// identify the class, and the third byte is the instance number on that device.
const EOJ_CLASS_NAMES = {
  "0279": "household_solar_power_generation",
  "027C": "fuel_cell",
  "027D": "storage_battery",
  "0287": "power_distribution_board_metering",
  "05FF": "controller",
};

function usage() {
  console.log(`Usage:
  node home-energy-battery-node.js discover [--timeout 3] [--netif 192.0.2.50]
  node home-energy-battery-node.js inspect-host --host IP [--eoj 0x027D01]
  node home-energy-battery-node.js dump-eoj --host IP [--eoj 0x027D01] [--epc EPC]
  node home-energy-battery-node.js dump-vendor --host IP [--eoj 0x027D01] [--epc EPC]
  node home-energy-battery-node.js probe --host IP [--instance 1]
  node home-energy-battery-node.js raw-get --host IP [--eoj 0x027D01] EPC
  node home-energy-battery-node.js raw-set --host IP [--eoj 0x027D01] EPC EDT [--dry-run]
  node home-energy-battery-node.js status --host IP [--instance 1]
  node home-energy-battery-node.js energy-status [--no-solar] [--no-fuel-cell]
  node home-energy-battery-node.js meter-status --host IP [--eoj 0x028701]
  node home-energy-battery-node.js set-mode --host IP MODE [--instance 1] [--dry-run]
  node home-energy-battery-node.js vendor-profile --host IP [osaifu|eco|backup] [--instance 1] [--dry-run]
  node home-energy-battery-node.js osaifu-charge-window --host IP [START_HOUR END_HOUR] [--instance 1] [--dry-run]
  node home-energy-battery-node.js osaifu-discharge-window --host IP [START_HOUR END_HOUR] [--instance 1] [--dry-run]
  node home-energy-battery-node.js discharge-limit --host IP [20|30|...|100] [--instance 1] [--dry-run]
  node home-energy-battery-node.js charge --host IP [--target-wh N] [--instance 1] [--dry-run]
  node home-energy-battery-node.js discharge --host IP [--target-wh N] [--instance 1] [--dry-run]

Notes:
  node-echonet-lite binds LAN UDP on ${ECHONET_PORT}; stop other ECHONET clients first if needed.
  This wrapper targets LAN/IPv4, not Wi-SUN Route-B.`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["debug", "dry-run", "help"].includes(key)) {
      opts[key] = true;
      continue;
    }
    if (opts[key] === undefined) {
      opts[key] = argv[i + 1];
    } else if (Array.isArray(opts[key])) {
      opts[key].push(argv[i + 1]);
    } else {
      opts[key] = [opts[key], argv[i + 1]];
    }
    i += 1;
  }
  return opts;
}

function parseByte(value) {
  const n = Number.parseInt(String(value), String(value).startsWith("0x") ? 16 : 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) {
    throw new Error(`invalid byte: ${value}`);
  }
  return n;
}

function parseEoj(value) {
  // Accept "0x027D01", "027D01", or colon/space separated bytes and normalize
  // them to the byte-array shape that node-echonet-lite expects.
  const hex = String(value).replace(/^0x/i, "").replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`EOJ must be 3 bytes, e.g. 0x027D01: ${value}`);
  }
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function eojHex(eoj) {
  return `0x${eoj.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function eojName(eoj) {
  const klass = eoj.slice(0, 2).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${EOJ_CLASS_NAMES[klass] ?? "unknown"}(${eojHex(eoj)})`;
}

function parseHexBytes(value) {
  // EDT is the raw property payload. For writes we let callers provide ordinary
  // hex, then convert it to a Buffer before sending it over UDP.
  const hex = String(value).replace(/^0x/i, "").replace(/[:\s]/g, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`invalid hex bytes: ${value}`);
  }
  return Buffer.from(hex, "hex");
}

function uint32(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) {
    throw new Error(`value must be integer 0..999999999: ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
}

function parseHour(value, label) {
  const text = String(value);
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
    throw new Error(`${label} must be an integer hour from 0 to 23`);
  }
  const n = Number.parseInt(text, text.startsWith("0x") ? 16 : 10);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error(`${label} must be an integer hour from 0 to 23`);
  }
  return n;
}

function formatHour(hour) {
  return `${hour.toString().padStart(2, "0")}:00`;
}

function rawHex(raw) {
  return raw ? `0x${Buffer.from(raw).toString("hex")}` : null;
}

function propRaw(res, epc) {
  const prop = res?.message?.prop?.find((p) => p.epc === epc);
  if (!prop) return null;
  if (Buffer.isBuffer(prop.buffer)) return prop.buffer;
  if (Buffer.isBuffer(prop.edt)) return prop.edt;
  return null;
}

function decodedOrRawData(res) {
  const data = res?.message?.data;
  if (Buffer.isBuffer(data)) return rawHex(data);
  return data ?? null;
}

function mapToHex(map) {
  if (!Array.isArray(map)) return [];
  return map.map((n) => `0x${n.toString(16).padStart(2, "0").toUpperCase()}`);
}

function decodePropertyMap(raw) {
  // Property maps have two valid ECHONET Lite encodings: a short explicit list,
  // or a 16-byte bitmap. Supporting both makes discovery output readable.
  if (!raw || raw.length === 0) return [];
  const count = raw[0];
  if (raw.length === count + 1) return Array.from(raw.slice(1)).sort((a, b) => a - b);
  if (raw.length === 17) {
    const epcs = [];
    for (let low = 0; low < 16; low += 1) {
      const bitmap = raw[low + 1];
      for (let high = 0; high < 8; high += 1) {
        if (bitmap & (1 << high)) epcs.push(0x80 + low + (high << 4));
      }
    }
    return epcs.sort((a, b) => a - b);
  }
  return Array.from(raw);
}

function metric({ host, eoj, epc, name, raw, value = undefined, unit = undefined, human = undefined }) {
  const out = { host, eoj, epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`, name, raw: rawHex(raw) };
  if (value !== undefined) out.value = value;
  if (unit !== undefined) out.unit = unit;
  if (human !== undefined) out.human = human;
  return out;
}

function decodeUnsigned({ host, eoj, epc, name, raw, unit }) {
  if (!raw) return metric({ host, eoj, epc, name, raw });
  const value = raw.readUIntBE(0, raw.length);
  return metric({ host, eoj, epc, name, raw, value, unit, human: `${value} ${unit}` });
}

function decodeSignedW({ host, eoj, epc, name, raw }) {
  if (!raw) return metric({ host, eoj, epc, name, raw });
  const value = raw.readIntBE(0, raw.length);
  return metric({ host, eoj, epc, name, raw, value, unit: "W", human: `${value} W` });
}

function cumulativeUnit(raw) {
  if (!raw || raw.length !== 1) return null;
  return {
    0x00: 1,
    0x01: 0.1,
    0x02: 0.01,
    0x03: 0.001,
    0x04: 0.0001,
    0x0a: 10,
    0x0b: 100,
    0x0c: 1000,
    0x0d: 10000,
  }[raw[0]] ?? null;
}

function decodeCumulativeKwh({ host, eoj, epc, name, raw, unit }) {
  if (!raw || raw.length !== 4) return metric({ host, eoj, epc, name, raw });
  const count = raw.readUInt32BE(0);
  const value = unit === null || unit === undefined ? count : count * unit;
  return metric({
    host,
    eoj,
    epc,
    name,
    raw,
    value,
    unit: "kWh",
    human: unit === null || unit === undefined ? `${count} counts` : `${value.toFixed(2)} kWh`,
  });
}

function decodeInstantPowerList(raw) {
  // Power distribution boards may report per-circuit instantaneous wattage as a
  // packed list. Each channel is four bytes after the start/range header.
  if (!raw || raw.length < 6 || (raw.length - 2) % 4 !== 0) return null;
  const start = raw[0] === 0xfd ? null : raw[0];
  const range = raw[1] === 0xfd ? null : raw[1];
  const channels = [];
  for (let offset = 2; offset < raw.length; offset += 4) {
    const rawValue = raw.readUInt32BE(offset);
    const value = rawValue === 0x7ffffffe ? null : raw.readInt32BE(offset);
    channels.push({
      channel: start === null ? null : start + channels.length,
      value,
      unit: "W",
      human: value === null ? "no data" : `${value} W`,
    });
  }
  return { start, range, channels };
}

function decodeCumulativePowerList(raw, unit) {
  // Per-circuit cumulative energy uses the same start/range header as the
  // instantaneous list, followed by one 32-bit counter per channel.
  if (!raw || raw.length < 6 || (raw.length - 2) % 4 !== 0) return null;
  const start = raw[0] === 0xfd ? null : raw[0];
  const range = raw[1] === 0xfd ? null : raw[1];
  const channels = [];
  for (let offset = 2; offset < raw.length; offset += 4) {
    const count = raw.readUInt32BE(offset);
    const value = count === 0xfffffffe || unit === null || unit === undefined
      ? null
      : count * unit;
    channels.push({
      channel: start === null ? null : start + channels.length,
      count: count === 0xfffffffe ? null : count,
      value,
      unit: "kWh",
      human: value === null ? "no data" : `${value.toFixed(2)} kWh`,
    });
  }
  return { start, range, channels };
}

function sumInstantPowerChannels(decoded) {
  if (!decoded?.channels) return null;
  return decoded.channels
    .map((channel) => channel.value)
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);
}

function decodeEnum({ host, eoj, epc, name, raw, mapping }) {
  if (!raw || raw.length === 0) return metric({ host, eoj, epc, name, raw });
  const value = mapping[raw[0]] ?? `0x${raw[0].toString(16).padStart(2, "0").toUpperCase()}`;
  return metric({ host, eoj, epc, name, raw, value, human: value });
}

function decodeVendorProfile(raw) {
  if (!raw || raw.length === 0) return null;
  const rawByte = raw[0];
  const mode = EDT_TO_VENDOR_PROFILE[rawByte] ?? null;
  if (mode) return { mode };
  return {
    mode: null,
    note: `unknown vendor profile 0x${rawByte.toString(16).padStart(2, "0").toUpperCase()}`,
  };
}

function decodeOsaifuWindow(raw) {
  // The observed window format is vendor-specific: byte 0 is start hour, byte 2
  // is end hour, and the unused separator bytes are zero.
  if (!raw || raw.length < 3) return null;
  const startHour = raw[0];
  const endHour = raw[2];
  const decoded = {
    start_hour: startHour,
    start_time: formatHour(startHour),
    end_hour: endHour,
    end_time: formatHour(endHour),
    human: `${formatHour(startHour)}-${formatHour(endHour)}`,
    encoding: "bytes 0 and 2 are 24-hour clock hours; bytes 1 and 3 are zero",
  };
  if (startHour > 23 || endHour > 23) {
    decoded.note = "hour byte outside 0..23";
  }
  return decoded;
}

function decodeVendorProperty(epc, raw) {
  if (!raw || raw.length === 0) return null;
  if (epc === EPC.VENDOR_PROFILE) {
    return decodeVendorProfile(raw);
  }
  if (epc === EPC.VENDOR_OSAIFU_CHARGE_WINDOW || epc === EPC.VENDOR_OSAIFU_DISCHARGE_WINDOW) {
    return decodeOsaifuWindow(raw);
  }
  if (epc === EPC.VENDOR_DISCHARGE_LIMIT) {
    return {
      percent: raw[0] * 10,
      human: `${raw[0] * 10}%`,
      encoding: "raw byte is percent / 10",
    };
  }
  return null;
}

class EchonetNode {
  constructor({ timeout = 3, netif = "", debug = false } = {}) {
    const params = { type: "lan" };
    if (netif) params.netif = netif;
    this.el = new EchonetLite(params);
    this.timeoutMs = Number(timeout) * 1000;
    this.debug = debug;
  }

  init() {
    return new Promise((resolve, reject) => {
      this.el.init((err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    return new Promise((resolve) => this.el.close(resolve));
  }

  withTimeout(work, label) {
    // node-echonet-lite uses callbacks. This wrapper gives each UDP request a
    // bounded lifetime so command-line calls cannot hang forever on silent hosts.
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`${label} timed out after ${this.timeoutMs / 1000}s`));
        }
      }, this.timeoutMs);
      work((err, res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  get(host, eoj, epc) {
    return this.withTimeout(
      (cb) => this.el.getPropertyValue(host, eoj, epc, cb),
      `${host} ${eojHex(eoj)} EPC 0x${epc.toString(16)}`
    );
  }

  set(host, eoj, epc, edt) {
    return this.withTimeout(
      (cb) => this.el.setPropertyValue(host, eoj, epc, edt, cb),
      `${host} ${eojHex(eoj)} EPC 0x${epc.toString(16)} set`
    );
  }

  maps(host, eoj) {
    return this.withTimeout((cb) => this.el.getPropertyMaps(host, eoj, cb), `${host} ${eojHex(eoj)} maps`);
  }

  discover() {
    // Passive discovery listens for devices that answer the standard instance
    // list request. Unknown EOJs are still returned because they are useful when
    // reverse-engineering a home's controller/gateway.
    return new Promise((resolve, reject) => {
      const devices = {};
      const timer = setTimeout(() => {
        this.el.stopDiscovery();
        resolve(devices);
      }, this.timeoutMs);
      this.el.startDiscovery((err, res) => {
        if (err) {
          clearTimeout(timer);
          this.el.stopDiscovery();
          reject(err);
          return;
        }
        const address = res.device.address;
        devices[address] = devices[address] ?? { all_instances: [], storage_battery_instances: [] };
        for (const eoj of res.device.eoj ?? []) {
          const hex = eojHex(eoj).slice(2).toLowerCase();
          if (!devices[address].all_instances.includes(hex)) devices[address].all_instances.push(hex);
          if (eoj[0] === 0x02 && eoj[1] === 0x7d) devices[address].storage_battery_instances.push(eoj[2]);
        }
      });
    });
  }
}

function makeClient(opts) {
  return new EchonetNode({
    timeout: opts.timeout ?? 3,
    netif: opts.netif ?? "",
    debug: opts.debug ?? false,
  });
}

async function withClient(opts, fn) {
  const client = makeClient(opts);
  await client.init();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function cmdDiscover(opts) {
  return withClient(opts, async (client) => {
    const devices = await client.discover();
    return devices;
  });
}

async function cmdInspectHost(opts) {
  const host = required(opts.host, "--host");
  return withClient(opts, async (client) => {
    let eojs = opts.eoj ? [parseEoj(opts.eoj)] : [];
    if (!eojs.length) {
      const res = await client.get(host, [0x0e, 0xf0, 0x01], EPC.INSTANCE_LIST);
      eojs = res?.message?.data?.list ?? [];
    }
    const out = {};
    for (const eoj of eojs) {
      try {
        const maps = await client.maps(host, eoj);
        out[eojHex(eoj)] = {
          name: eojName(eoj),
          inf_property_map: mapToHex(maps.message.data.inf),
          set_property_map: mapToHex(maps.message.data.set),
          get_property_map: mapToHex(maps.message.data.get),
        };
      } catch (err) {
        out[eojHex(eoj)] = { name: eojName(eoj), error: err.message };
      }
    }
    return out;
  });
}

async function cmdProbe(opts) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  return withClient(opts, async (client) => {
    const eoj = [0x02, 0x7d, instance];
    const maps = await client.maps(host, eoj);
    return {
      [eojHex(eoj)]: {
        set_property_map: mapToHex(maps.message.data.set),
        get_property_map: mapToHex(maps.message.data.get),
      },
    };
  });
}

async function cmdDumpEoj(opts) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  return withClient(opts, async (client) => {
    const epcs = [];
    let mapRaw = null;
    let mapHex = [];
    if (opts.epc !== undefined) {
      epcs.push(...values(opts.epc, []).map(parseByte));
    } else {
      const maps = await client.maps(host, eoj);
      mapHex = mapToHex(maps.message.data.get);
      epcs.push(...maps.message.data.get);
      const mapProp = maps.message.prop.find((p) => p.epc === EPC.GET_PROPERTY_MAP);
      mapRaw = mapProp?.buffer ?? null;
    }
    const out = {
      host,
      eoj: eojHex(eoj),
      name: eojName(eoj),
      get_property_map_raw: rawHex(mapRaw),
      get_property_map: mapHex.length ? mapHex : epcs.map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      properties: {},
    };
    for (const epc of epcs) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        out.properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
        };
      } catch (err) {
        out.properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = { error: err.message };
      }
    }
    return out;
  });
}

async function cmdDumpVendor(opts) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  // Vendor-specific settings are not always documented in public class specs,
  // so this command focuses on the EPCs that have proven useful and annotates
  // only the encodings we have actually observed.
  const requested = opts.epc !== undefined ? values(opts.epc, []).map(parseByte) : DEFAULT_VENDOR_EPCS;
  return withClient(opts, async (client) => {
    let writable = [];
    let readable = [];
    try {
      const maps = await client.maps(host, eoj);
      writable = maps.message.data.set ?? [];
      readable = maps.message.data.get ?? [];
    } catch {
      writable = [];
      readable = [];
    }

    const epcs = requested.filter((epc) => !readable.length || readable.includes(epc) || writable.includes(epc));
    const out = {
      host,
      eoj: eojHex(eoj),
      name: eojName(eoj),
      vendor_epcs: epcs.map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      writable_vendor_epcs: epcs
        .filter((epc) => writable.includes(epc))
        .map((epc) => `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`),
      properties: {},
    };

    for (const epc of epcs) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        out.properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
          vendor_decoded: decodeVendorProperty(epc, raw),
          writable: writable.includes(epc),
        };
      } catch (err) {
        out.properties[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          error: err.message,
          writable: writable.includes(epc),
        };
      }
    }
    return out;
  });
}

async function cmdRawGet(opts) {
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

async function cmdRawSet(opts) {
  const host = required(opts.host, "--host");
  const eoj = parseEoj(opts.eoj ?? STORAGE_BATTERY_EOJ);
  const epc = parseByte(required(opts._[1], "EPC"));
  const edt = parseHexBytes(required(opts._[2], "EDT"));
  if (opts["dry-run"]) return { host, eoj: eojHex(eoj), epc: `0x${epc.toString(16)}`, edt: rawHex(edt) };
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, epc, edt);
    return { ok: res.message.esv === ESV_SET_RES, esv: res.message.esv, raw: rawHex(propRaw(res, epc)) };
  });
}

async function cmdStatus(opts) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj = [0x02, 0x7d, instance];
  const props = [
    EPC.OPERATION_STATUS,
    EPC.INSTANT_POWER_W,
    EPC.WORKING_STATUS,
    EPC.OPERATION_MODE,
    EPC.REMAINING_PERCENT,
    EPC.VENDOR_PROFILE,
  ];
  return withClient(opts, async (client) => {
    const out = {};
    for (const epc of props) {
      try {
        const res = await client.get(host, eoj, epc);
        const raw = propRaw(res, epc);
        out[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = {
          raw: rawHex(raw),
          parsed: decodedOrRawData(res),
        };
      } catch (err) {
        out[`0x${epc.toString(16).padStart(2, "0").toUpperCase()}`] = { error: err.message };
      }
    }
    return out;
  });
}

async function cmdEnergyStatus(opts) {
  const solarEnabled = !opts["no-solar"];
  const fuelCellEnabled = !opts["no-fuel-cell"];
  const solarHost = opts["solar-host"] ?? "192.0.2.10";
  const batteryHost = opts["battery-host"] ?? "192.0.2.10";
  const fuelCellHosts = values(opts["fuel-cell-host"], ["192.0.2.30"]);
  return withClient(opts, async (client) => {
    async function read(host, eoj, epc) {
      try {
        const res = await client.get(host, parseEoj(eoj), epc);
        return propRaw(res, epc);
      } catch {
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
    const out = {
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
        remaining_percent: decodeUnsigned({
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
      fuel_cells: [],
    };
    for (const host of fuelCellEnabled ? fuelCellHosts : []) {
      const power = await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_INSTANT_POWER_W);
      const status = await read(host, FUEL_CELL_EOJ, EPC.FUEL_CELL_GENERATION_STATUS);
      out.fuel_cells.push({
        host,
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
      });
    }
    return out;
  });
}

async function cmdMeterStatus(opts) {
  const host = required(opts.host, "--host");
  const eojText = opts.eoj ?? POWER_METER_EOJ;
  const eoj = parseEoj(eojText);
  return withClient(opts, async (client) => {
    async function read(epc) {
      try {
        const res = await client.get(host, eoj, epc);
        return propRaw(res, epc);
      } catch {
        return null;
      }
    }

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
    const channelPower = decodeInstantPowerList(channelsRaw);
    const channelEnergy = decodeCumulativePowerList(cumulativeChannelsRaw, unit);
    const houseDemandWatts = sumInstantPowerChannels(channelPower);

    return {
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
        value: Number.isFinite(netGridWatts) ? Math.max(netGridWatts, 0) : undefined,
        unit: "W",
        human: Number.isFinite(netGridWatts) ? `${Math.max(netGridWatts, 0)} W` : undefined,
      }),
      grid_export_power: metric({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_W,
        name: "grid_export_power",
        raw: instantRaw,
        value: Number.isFinite(netGridWatts) ? Math.max(-netGridWatts, 0) : undefined,
        unit: "W",
        human: Number.isFinite(netGridWatts) ? `${Math.max(-netGridWatts, 0)} W` : undefined,
      }),
      house_demand_power: metric({
        host,
        eoj: eojText,
        epc: EPC.METER_INSTANT_POWER_LIST,
        name: "house_demand_power",
        raw: channelsRaw,
        value: Number.isFinite(houseDemandWatts) ? houseDemandWatts : undefined,
        unit: "W",
        human: Number.isFinite(houseDemandWatts) ? `${houseDemandWatts} W` : undefined,
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

async function setOperationMode(opts, mode) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  if (!(mode in MODE_TO_EDT)) throw new Error(`unknown mode: ${mode}`);
  const eoj = [0x02, 0x7d, instance];
  const edt = Buffer.from([MODE_TO_EDT[mode]]);
  if (opts["dry-run"]) return { host, eoj: eojHex(eoj), epc: "0xDA", edt: rawHex(edt), mode };
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, EPC.OPERATION_MODE, edt);
    return { ok: res.message.esv === ESV_SET_RES, esv: res.message.esv, mode };
  });
}

async function cmdSetMode(opts) {
  return setOperationMode(opts, required(opts._[1], "MODE"));
}

async function cmdVendorProfile(opts) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj = [0x02, 0x7d, instance];

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

  if (!(mode in VENDOR_PROFILE_TO_EDT)) throw new Error(`unknown vendor profile: ${mode}`);
  const edt = Buffer.from([VENDOR_PROFILE_TO_EDT[mode]]);
  if (opts["dry-run"]) {
    return {
      host,
      eoj: eojHex(eoj),
      epc: "0xF0",
      name: "vendor_profile",
      mode,
      edt: rawHex(edt),
      decoded: decodeVendorProfile(edt),
    };
  }
  return withClient(opts, async (client) => {
    const res = await client.set(host, eoj, EPC.VENDOR_PROFILE, edt);
    return {
      ok: res.message.esv === ESV_SET_RES,
      esv: res.message.esv,
      host,
      eoj: eojHex(eoj),
      epc: "0xF0",
      name: "vendor_profile",
      mode,
      raw: rawHex(edt),
    };
  });
}

async function cmdOsaifuWindow(opts, kind) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj = [0x02, 0x7d, instance];
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
  const out = {
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
      ok: res.message.esv === ESV_SET_RES,
      esv: res.message.esv,
      ...out,
      raw: rawHex(edt),
    };
  });
}

async function cmdDischargeLimit(opts) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj = [0x02, 0x7d, instance];
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
      ok: res.message.esv === ESV_SET_RES,
      esv: res.message.esv,
      host,
      eoj: eojHex(eoj),
      epc: "0xF6",
      percent,
      raw: rawHex(edt),
    };
  });
}

async function cmdChargeLike(opts, mode) {
  const host = required(opts.host, "--host");
  const instance = Number(opts.instance ?? 1);
  const eoj = [0x02, 0x7d, instance];
  const writes = [];
  if (opts["target-wh"] !== undefined) {
    writes.push({
      epc: mode === "discharge" ? EPC.AC_DISCHARGE_TARGET_WH : EPC.AC_CHARGE_TARGET_WH,
      edt: uint32(opts["target-wh"]),
    });
  }
  writes.push({ epc: EPC.OPERATION_MODE, edt: Buffer.from([MODE_TO_EDT[mode]]) });
  if (opts["dry-run"]) {
    return { host, eoj: eojHex(eoj), writes: writes.map((w) => ({ epc: `0x${w.epc.toString(16)}`, edt: rawHex(w.edt) })) };
  }
  return withClient(opts, async (client) => {
    const results = [];
    for (const write of writes) {
      const res = await client.set(host, eoj, write.epc, write.edt);
      results.push({ epc: `0x${write.epc.toString(16)}`, ok: res.message.esv === ESV_SET_RES, esv: res.message.esv });
    }
    return { host, eoj: eojHex(eoj), results };
  });
}

function required(value, label) {
  if (value === undefined || value === "") throw new Error(`${label} is required`);
  return value;
}

function values(value, fallback) {
  if (value === undefined) return fallback;
  return Array.isArray(value) ? value : [value];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || opts.help || cmd === "help") {
    usage();
    return;
  }
  const handlers = {
    discover: cmdDiscover,
    "inspect-host": cmdInspectHost,
    "dump-eoj": cmdDumpEoj,
    "dump-vendor": cmdDumpVendor,
    probe: cmdProbe,
    "raw-get": cmdRawGet,
    "raw-set": cmdRawSet,
    status: cmdStatus,
    "energy-status": cmdEnergyStatus,
    "meter-status": cmdMeterStatus,
    "set-mode": cmdSetMode,
    "vendor-profile": cmdVendorProfile,
    "osaifu-charge-window": (o) => cmdOsaifuWindow(o, "charge"),
    "osaifu-discharge-window": (o) => cmdOsaifuWindow(o, "discharge"),
    "discharge-limit": cmdDischargeLimit,
    charge: (o) => cmdChargeLike(o, "charge"),
    discharge: (o) => cmdChargeLike(o, "discharge"),
  };
  if (!handlers[cmd]) throw new Error(`unknown command: ${cmd}`);
  const result = await handlers[cmd](opts);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(2);
});
