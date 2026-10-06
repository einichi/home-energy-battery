import type { EchonetResponse } from "./echonet-transport.js";


const STORAGE_BATTERY_EOJ = "0x027D01";
const SOLAR_EOJ = "0x027901";
const FUEL_CELL_EOJ = "0x027C01";
const POWER_METER_EOJ = "0x028701";
const DEFAULT_VENDOR_EPCS: number[] = [0xd7, 0xd9, 0xf0, 0xf4, 0xf5, 0xf6];

const EPC: Record<string, number> = {
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
  FUEL_CELL_RATED_POWER_W: 0xc2,
  FUEL_CELL_CUMULATIVE_GENERATION: 0xc5,
  FUEL_CELL_CUMULATIVE_GAS: 0xc8,
  FUEL_CELL_GENERATION_STATUS: 0xcb,
  FUEL_CELL_INTERCONNECTION_STATUS: 0xd0,
  // Vendor EPC, verified against the real hardware in this project. The ECHONET
  // standard fuel-cell class (0x027C) defines "measured remaining hot water
  // amount" as 0xE1, but this Panasonic Ene-Farm does not implement 0xE1 (a Get
  // returns Get_SNA) and reports the level through 0xF4 instead (a 1-byte 0-5
  // value). EPCs are scoped per device class, so this 0xF4 does NOT collide with
  // the storage battery's vendor osaifu window (0xF4 on class 0x027D).
  // Do not "correct" this to 0xE1 without re-probing the device; a genuinely
  // standards-compliant fuel cell would need 0xE1 AND a different value encoding.
  FUEL_CELL_HOT_WATER_LEVEL: 0xf4,
  METER_CUMULATIVE_NORMAL: 0xc0,
  METER_CUMULATIVE_REVERSE: 0xc1,
  METER_CUMULATIVE_UNIT: 0xc2,
  METER_INSTANT_POWER_W: 0xc6,
  METER_INSTANT_POWER_LIST: 0xb7,
  METER_CUMULATIVE_POWER_LIST: 0xb3,
};

const ESV_SET_RES = "Set_Res";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ECHONET Lite writes are byte buffers. These tables translate friendly command
// words into the one-byte EDT payloads observed for storage batteries.
const MODE_TO_EDT: Record<string, number> = {
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

const EDT_TO_MODE: Record<number, string> = {
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

const VENDOR_PROFILE_TO_EDT: Record<string, number> = {
  osaifu: 0x02,
  eco: 0x03,
  backup: 0x20,
};

const EDT_TO_VENDOR_PROFILE: Record<number, string> = {
  0x02: "osaifu",
  0x03: "eco",
  0x20: "backup",
};

const EDT_TO_FUEL_CELL_STATUS: Record<number, string> = {
  0x40: "other",
  0x41: "generating",
  0x42: "stopped",
  0x43: "starting",
  0x44: "stopping",
  0x45: "idling",
};

const EDT_TO_FUEL_CELL_INTERCONNECTION: Record<number, string> = {
  0x00: "grid_connected_reverse_flow_allowed",
  0x01: "independent",
  0x02: "grid_connected_reverse_flow_prohibited",
};

// EOJ is the three-byte object identifier in ECHONET Lite. The first two bytes
// identify the class, and the third byte is the instance number on that device.
const EOJ_CLASS_NAMES: Record<string, string> = {
  "0279": "household_solar_power_generation",
  "027C": "fuel_cell",
  "027D": "storage_battery",
  "0287": "power_distribution_board_metering",
  "05FF": "controller",
};

function parseByte(value: unknown): number {
  const n = Number.parseInt(String(value), String(value).startsWith("0x") ? 16 : 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) {
    throw new Error(`invalid byte: ${value}`);
  }
  return n;
}

function parseEoj(value: unknown): number[] {
  // Accept "0x027D01", "027D01", or colon/space separated bytes and normalize
  // them to the byte-array shape that node-echonet-lite expects.
  const hex = String(value).replace(/^0x/i, "").replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`EOJ must be 3 bytes, e.g. 0x027D01: ${value}`);
  }
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function eojHex(eoj: number[]): string {
  return `0x${eoj.map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function eojName(eoj: number[]): string {
  const klass = eoj.slice(0, 2).map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${EOJ_CLASS_NAMES[klass] ?? "unknown"}(${eojHex(eoj)})`;
}

function parseHexBytes(value: unknown): Buffer {
  // EDT is the raw property payload. For writes we let callers provide ordinary
  // hex, then convert it to a Buffer before sending it over UDP.
  const hex = String(value).replace(/^0x/i, "").replace(/[:\s]/g, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`invalid hex bytes: ${value}`);
  }
  return Buffer.from(hex, "hex");
}

function uint32(value: unknown): Buffer {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) {
    throw new Error(`value must be integer 0..999999999: ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
}

function parseHour(value: unknown, label: string): number {
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

function formatHour(hour: number): string {
  return `${hour.toString().padStart(2, "0")}:00`;
}

function rawHex(raw: Uint8Array | null | undefined): string | null {
  return raw ? `0x${Buffer.from(raw).toString("hex")}` : null;
}

function propRaw(res: EchonetResponse, epc: number): Buffer | null {
  const prop = res?.message?.prop?.find((item) => item.epc === epc);
  if (!prop) return null;
  if (Buffer.isBuffer(prop.buffer)) return prop.buffer;
  if (Buffer.isBuffer(prop.edt)) return prop.edt;
  return null;
}

function acknowledgedSet(res: EchonetResponse, description: string) {
  const esv = res?.message?.esv ?? "unknown ESV";
  if (esv !== ESV_SET_RES) {
    throw new Error(`${description} was rejected by the device (${esv})`);
  }
  return { ok: true, acknowledged: true, esv };
}

function decodedOrRawData(res: EchonetResponse): unknown {
  const data = res?.message?.data;
  if (Buffer.isBuffer(data)) return rawHex(data);
  return data ?? null;
}

function responseData(response: EchonetResponse): Record<string, unknown> {
  const data = response.message?.data;
  return data !== null && typeof data === "object" && !Array.isArray(data) && !Buffer.isBuffer(data)
    ? data as Record<string, unknown>
    : {};
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function mapToHex(map: unknown): string[] {
  if (!Array.isArray(map)) return [];
  return map.map((value) => `0x${Number(value).toString(16).padStart(2, "0").toUpperCase()}`);
}

interface MetricInput {
  host: string;
  eoj: string;
  epc: number;
  name: string;
  raw: Buffer | null;
  value?: unknown;
  unit?: string;
  human?: string;
  error?: string;
}

function metric({ host, eoj, epc, name, raw, value, unit, human, error }: MetricInput): Record<string, unknown> {
  const out: Record<string, unknown> = { host, eoj, epc: `0x${epc.toString(16).padStart(2, "0").toUpperCase()}`, name, raw: rawHex(raw) };
  if (value !== undefined) out.value = value;
  if (unit !== undefined) out.unit = unit;
  if (human !== undefined) out.human = human;
  if (error !== undefined) out.error = error;
  return out;
}

function decodeUnsigned({ host, eoj, epc, name, raw, unit }: MetricInput): Record<string, unknown> {
  if (!raw) return metric({ host, eoj, epc, name, raw });
  const value = raw.readUIntBE(0, raw.length);
  return metric({ host, eoj, epc, name, raw, value, unit, human: `${value} ${unit}` });
}

function decodePercent({ host, eoj, epc, name, raw, unit }: MetricInput): Record<string, unknown> {
  if (!raw) return metric({ host, eoj, epc, name, raw });
  const value = raw.readUIntBE(0, raw.length);
  // A percentage must be 0-100. Some devices use a wider scale; treat anything
  // outside the range as an error instead of feeding it to charging decisions.
  if (value > 100) {
    return metric({ host, eoj, epc, name, raw, error: `out-of-range ${value}${unit ?? ""} (expected 0-100)` });
  }
  return metric({ host, eoj, epc, name, raw, value, unit, human: `${value} ${unit}` });
}

function decodeSignedW({ host, eoj, epc, name, raw }: MetricInput): Record<string, unknown> {
  if (!raw) return metric({ host, eoj, epc, name, raw });
  const value = raw.readIntBE(0, raw.length);
  return metric({ host, eoj, epc, name, raw, value, unit: "W", human: `${value} W` });
}

function cumulativeUnit(raw: Buffer | null): number | null {
  if (!raw || raw.length !== 1) return null;
  const units: Record<number, number> = {
    0x00: 1,
    0x01: 0.1,
    0x02: 0.01,
    0x03: 0.001,
    0x04: 0.0001,
    0x0a: 10,
    0x0b: 100,
    0x0c: 1000,
    0x0d: 10000,
  };
  return units[raw[0]] ?? null;
}

function decodeCumulativeKwh({ host, eoj, epc, name, raw, unit }: Omit<MetricInput, "unit"> & { unit: number | null }): Record<string, unknown> {
  if (!raw || raw.length !== 4) return metric({ host, eoj, epc, name, raw });
  const count = raw.readUInt32BE(0);
  if (unit === null || unit === undefined) {
    // Without the cumulative-unit coefficient (EPC 0xC2) the raw counter cannot
    // be converted to kWh. Leave value undefined so callers do not treat
    // unscaled counts as energy.
    return metric({ host, eoj, epc, name, raw, human: `${count} counts (unit unknown)` });
  }
  const value = count * unit;
  return metric({
    host,
    eoj,
    epc,
    name,
    raw,
    value,
    unit: "kWh",
    human: `${value.toFixed(2)} kWh`,
  });
}

function decodeFuelCellCumulative({ host, epc, name, raw, unit }: Omit<MetricInput, "eoj">): Record<string, unknown> {
  if (!raw || raw.length !== 4) return metric({ host, eoj: FUEL_CELL_EOJ, epc, name, raw });
  const count = raw.readUInt32BE(0);
  const value = count * 0.001;
  return metric({
    host,
    eoj: FUEL_CELL_EOJ,
    epc,
    name,
    raw,
    value,
    unit,
    human: `${value.toFixed(3)} ${unit}`,
  });
}

function decodeFuelCellHotWaterLevel({ host, raw }: { host: string; raw: Buffer | null }): Record<string, unknown> {
  const epc = EPC.FUEL_CELL_HOT_WATER_LEVEL;
  if (!raw || raw.length !== 1 || raw[0] > 5) {
    return metric({ host, eoj: FUEL_CELL_EOJ, epc, name: "fuel_cell_hot_water_level", raw });
  }
  const value = raw[0];
  return metric({
    host,
    eoj: FUEL_CELL_EOJ,
    epc,
    name: "fuel_cell_hot_water_level",
    raw,
    value,
    unit: "level",
    human: `${value} / 5`,
  });
}

interface DecodedChannel { channel: number | null; value: number | null; unit: string; human: string; count?: number | null }
interface DecodedChannelList { start: number | null; range: number | null; channels: DecodedChannel[] }

function decodeInstantPowerList(raw: Buffer | null): DecodedChannelList | null {
  // Power distribution boards may report per-circuit instantaneous wattage as a
  // packed list. Each channel is four bytes after the start/range header.
  if (!raw || raw.length < 6 || (raw.length - 2) % 4 !== 0) return null;
  const start = raw[0] === 0xfd ? null : raw[0];
  const range = raw[1] === 0xfd ? null : raw[1];
  const channels: DecodedChannel[] = [];
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

function decodeCumulativePowerList(raw: Buffer | null, unit: number | null): DecodedChannelList | null {
  // Per-circuit cumulative energy uses the same start/range header as the
  // instantaneous list, followed by one 32-bit counter per channel.
  if (!raw || raw.length < 6 || (raw.length - 2) % 4 !== 0) return null;
  const start = raw[0] === 0xfd ? null : raw[0];
  const range = raw[1] === 0xfd ? null : raw[1];
  const channels: DecodedChannel[] = [];
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

function sumInstantPowerChannels(decoded: DecodedChannelList | null): number | null {
  if (!decoded?.channels) return null;
  return decoded.channels
    .map((channel) => channel.value)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);
}

function decodeEnum({ host, eoj, epc, name, raw, mapping }: MetricInput & { mapping: Record<number, string> }): Record<string, unknown> {
  if (!raw || raw.length === 0) return metric({ host, eoj, epc, name, raw });
  const value = mapping[raw[0]] ?? `0x${raw[0].toString(16).padStart(2, "0").toUpperCase()}`;
  return metric({ host, eoj, epc, name, raw, value, human: value });
}

function decodeVendorProfile(raw: Buffer | null): { mode: string | null; note?: string } | null {
  if (!raw || raw.length === 0) return null;
  const rawByte = raw[0];
  const mode = EDT_TO_VENDOR_PROFILE[rawByte] ?? null;
  if (mode) return { mode };
  return {
    mode: null,
    note: `unknown vendor profile 0x${rawByte.toString(16).padStart(2, "0").toUpperCase()}`,
  };
}

function decodeOsaifuWindow(raw: Buffer | null): Record<string, unknown> | null {
  // The observed window format is vendor-specific: byte 0 is start hour, byte 2
  // is end hour, and the unused separator bytes are zero.
  if (!raw || raw.length < 3) return null;
  const startHour = raw[0];
  const endHour = raw[2];
  const decoded: Record<string, unknown> = {
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

function decodeVendorProperty(epc: number, raw: Buffer | null): Record<string, unknown> | null {
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

export {
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
  errorMessage,
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
};
