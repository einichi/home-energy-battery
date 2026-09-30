export interface DiscoveredDevice {
  all_instances: string[];
  storage_battery_instances: number[];
}

export type DiscoveredDeviceMap = Record<string, DiscoveredDevice>;

export function normalizeDiscoveredDevices(value: unknown): DiscoveredDeviceMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: DiscoveredDeviceMap = {};
  for (const [host, candidate] of Object.entries(value)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const device = candidate as Record<string, unknown>;
    const instances = Array.isArray(device.all_instances) ? device.all_instances : [];
    for (const instance of instances) addDiscoveredInstance(normalized, host, instance);
  }
  return normalized;
}

export const KNOWN_DISCOVERY_PROBES: ReadonlyArray<{ eoj: string; epcs: readonly string[] }> = [
  { eoj: "0x027D01", epcs: ["0xE4", "0xDA"] },
  { eoj: "0x027901", epcs: ["0xE0"] },
  { eoj: "0x028701", epcs: ["0xC6", "0xB7"] },
  { eoj: "0x027C01", epcs: ["0xC4", "0xCB"] },
];

export function inferDevice(instances: readonly unknown[]): string[] {
  const set = new Set(instances.map((item) => String(item).toLowerCase().slice(0, 4)));
  const roles: string[] = [];
  if (set.has("027d")) roles.push("Battery");
  if (set.has("0279")) roles.push("Solar generation");
  if (set.has("0287")) roles.push("Smart Cosmo / home power meter");
  if (set.has("027c")) roles.push("Ene-Farm");
  if (set.has("0272")) roles.push("Water heater");
  if ([...set].some((item) => item.startsWith("0f"))) roles.push("Controller");
  return roles.length ? roles : ["Unknown energy device"];
}

export function subnetFromHost(host: unknown): string | null {
  const value = String(host ?? "");
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  if (value.split(".").some((part) => Number(part) > 255)) return null;
  const subnet = `${match[1]}.${match[2]}.${match[3]}.0/24`;
  return isPrivateDiscoverySubnet(subnet) ? subnet : null;
}

export function ipRangeFromCidr(cidr: unknown): string[] {
  if (!isPrivateDiscoverySubnet(cidr)) return [];
  const match = String(cidr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  if (!match) return [];
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  return Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
}

export function instanceListRequest(tid: number): Buffer {
  return Buffer.from([
    0x10, 0x81,
    (tid >> 8) & 0xff, tid & 0xff,
    0x05, 0xff, 0x01,
    0x0e, 0xf0, 0x01,
    0x62,
    0x01,
    0xd6, 0x00,
  ]);
}

export function propertyRequest(tid: number, eojHexText: string, epcHexText: string): Buffer {
  const eoj = Buffer.from(eojHexText.replace(/^0x/i, ""), "hex");
  const epc = Number.parseInt(epcHexText.replace(/^0x/i, ""), 16);
  return Buffer.from([
    0x10, 0x81,
    (tid >> 8) & 0xff, tid & 0xff,
    0x05, 0xff, 0x01,
    eoj[0]!, eoj[1]!, eoj[2]!,
    0x62,
    0x01,
    epc, 0x00,
  ]);
}

export function parseInstanceListResponse(message: Buffer): { tid: number; instances: string[] } | null {
  if (message.length < 14 || message[0] !== 0x10 || message[1] !== 0x81) return null;
  const tid = message.readUInt16BE(2);
  const esv = message[10];
  if (esv === undefined || ![0x72, 0x52].includes(esv)) return null;
  const opc = message[11] ?? 0;
  let offset = 12;
  for (let index = 0; index < opc && offset + 2 <= message.length; index += 1) {
    const epc = message[offset];
    const pdc = message[offset + 1] ?? 0;
    const edt = message.subarray(offset + 2, offset + 2 + pdc);
    offset += 2 + pdc;
    if (epc !== 0xd6 || edt.length < 1) continue;
    const count = edt[0] ?? 0;
    const instances: string[] = [];
    for (let position = 1; position + 2 < edt.length && instances.length < count; position += 3) {
      instances.push(edt.subarray(position, position + 3).toString("hex"));
    }
    return { tid, instances };
  }
  return null;
}

export function parseTid(message: Buffer): number | null {
  return message.length >= 4 && message[0] === 0x10 && message[1] === 0x81
    ? message.readUInt16BE(2)
    : null;
}

export function isGetResponse(message: Buffer): boolean {
  return message.length >= 14 && message[0] === 0x10 && message[1] === 0x81 && message[10] === 0x72;
}

export function addDiscoveredInstance(found: DiscoveredDeviceMap, host: string, instance: unknown): void {
  const normalized = String(instance).toLowerCase();
  const device = found[host] ??= { all_instances: [], storage_battery_instances: [] };
  if (!device.all_instances.includes(normalized)) device.all_instances.push(normalized);
  if (normalized.startsWith("027d")) {
    const batteryInstance = Number.parseInt(normalized.slice(4, 6), 16);
    if (!device.storage_battery_instances.includes(batteryInstance)) device.storage_battery_instances.push(batteryInstance);
  }
}

export function mergeDiscoveredDevices(...deviceSets: ReadonlyArray<DiscoveredDeviceMap | null | undefined>): DiscoveredDeviceMap {
  const merged: DiscoveredDeviceMap = {};
  for (const devices of deviceSets) {
    for (const [host, device] of Object.entries(devices ?? {})) {
      for (const instance of device.all_instances ?? []) addDiscoveredInstance(merged, host, instance);
    }
  }
  return merged;
}
import { isPrivateDiscoverySubnet } from "../domain/discovery-subnets.js";
