import { isPrivateDiscoverySubnet } from "./discovery-subnets.js";
import { STORAGE_BATTERY_EOJ } from "./echonet-constants.js";

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
  { eoj: STORAGE_BATTERY_EOJ, epcs: ["0xE4", "0xDA"] },
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
