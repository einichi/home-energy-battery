import { randomUUID } from "node:crypto";
import os from "node:os";
import { normalizeSubnets } from "../domain/configuration.js";
import { invalidDiscoverySubnets, isPrivateDiscoverySubnet } from "../domain/discovery-subnets.js";
import type { ApplicationConfig } from "../contracts/configuration.js";
import { isDocumentationHost } from "../domain/status-alerts.js";
import type { DeviceCommandArguments } from "./device-command-queue.js";
import {
  KNOWN_DISCOVERY_PROBES,
  addDiscoveredInstance,
  inferDevice,
  ipRangeFromCidr,
  mergeDiscoveredDevices,
  normalizeDiscoveredDevices,
  subnetFromHost,
  type DiscoveredDeviceMap,
} from "../domain/discovery-protocol.js";
import { asRecord } from "../domain/values.js";

export interface DiscoveryServiceDependencies {
  readConfig: () => Promise<ApplicationConfig>;
  cleanConfig: (value: unknown) => ApplicationConfig;
  runDeviceCommand: (command: string, args?: DeviceCommandArguments, positional?: unknown[], options?: { priority?: number; queueTimeoutMs?: number }) => Promise<unknown>;
}

interface DiscoveryNetworkHints {
  configuredSubnets: string[];
  containerSubnets: string[];
  userSubnets: string[];
  scanSubnets: string[];
}

interface DiscoveryProgress {
  phase?: string;
  total?: number;
  scanned?: number;
  found?: number;
  network?: DiscoveryNetworkHints;
}

interface DiscoveryResult {
  discovered: Array<{ host: string; roles: string[]; instances: string[] }>;
  network: DiscoveryNetworkHints;
  suggestedConfig: ApplicationConfig;
  broadcastUnavailable?: boolean;
}

interface DiscoveryJob extends Required<Omit<DiscoveryProgress, "network">> {
  id: string;
  status: "running" | "complete" | "failed";
  network: DiscoveryNetworkHints | null;
  result: DiscoveryResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createDiscoveryService(dependencies: DiscoveryServiceDependencies) {
  let discoveryRunContext: { label: string; startedAt: string } | null = null;
  const discoveryJobs = new Map<string, DiscoveryJob>();
  const DISCOVERY_JOB_TTL_MS = 10 * 60 * 1000;


  function localNetworkHints(config: ApplicationConfig, requestedSubnets: unknown): DiscoveryNetworkHints {
    const hosts = [
      config.batteryHost,
      config.meterHost,
      config.solarHost,
      ...config.fuelCellHosts,
    ].filter(Boolean);
    const configuredSubnets = [...new Set(hosts.map(subnetFromHost).filter((subnet): subnet is string => Boolean(subnet)))];
    const containerSubnets: string[] = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal) {
          const subnet = `${entry.address.split(".").slice(0, 3).join(".")}.0/24`;
          if (isPrivateDiscoverySubnet(subnet)) containerSubnets.push(subnet);
        }
      }
    }
    const requested = normalizeSubnets(requestedSubnets);
    const userSubnets = normalizeSubnets(config.discoverySubnets);
    const localSubnets = [...new Set(containerSubnets)];
    const scanSubnets = [requested, userSubnets, configuredSubnets, localSubnets].find((subnets) => subnets.length) ?? [];
    return { configuredSubnets, containerSubnets: localSubnets, userSubnets, scanSubnets };
  }


  async function activeScanSubnets(subnets: string[], timeout: number, progress: (patch: DiscoveryProgress) => void): Promise<DiscoveredDeviceMap> {
    const hosts = [...new Set(subnets.flatMap(ipRangeFromCidr))];
    progress({ phase: "active-scan", total: hosts.length, scanned: 0, found: 0 });
    if (!hosts.length) return {};
    const result = await dependencies.runDeviceCommand("discover", {
      hosts,
      timeout,
      onProgress: (scanned: number, found: number) => progress({ scanned, found }),
    }, [], { priority: 6, queueTimeoutMs: 180_000 });
    return normalizeDiscoveredDevices(result);
  }


  function configuredDiscoveryHosts(config: ApplicationConfig): string[] {
    return [
      config.batteryHost,
      config.smartCosmoEnabled ? config.meterHost : null,
      config.solarEnabled ? config.solarHost : null,
      ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
    ].filter((host): host is string => Boolean(host && !isDocumentationHost(host)));
  }


  async function enrichDiscoveredDevices(devices: DiscoveredDeviceMap, config: ApplicationConfig, progress: (patch: DiscoveryProgress) => void = () => undefined): Promise<DiscoveredDeviceMap> {
    const hosts = [...new Set([...Object.keys(devices), ...configuredDiscoveryHosts(config)])];
    if (!hosts.length) return devices;
    const enriched = mergeDiscoveredDevices(devices);
    let scanned = 0;
    progress({ phase: "identifying", total: hosts.length, scanned: 0, found: Object.keys(enriched).length });
    for (const host of hosts) {
      for (const probe of KNOWN_DISCOVERY_PROBES) {
        const eoj = probe.eoj;
        const instance = eoj.slice(2).toLowerCase();
        if (enriched[host]?.all_instances.some((entry) => entry.startsWith(instance.slice(0, 4)))) continue;
        let detected = false;
        try {
          const result = asRecord(await dependencies.runDeviceCommand("inspect-host", { host, eoj, timeout: 2 }));
          // inspect-host keys its output with eojHex(): lowercase "0x" + upper-case hex.
          const entry = asRecord(result[`0x${eoj.replace(/^0x/i, "").toUpperCase()}`]);
          detected = ["inf_property_map", "set_property_map", "get_property_map"]
            .some((key) => Array.isArray(entry[key]) && entry[key].length > 0);
        } catch {
          // Silent hosts are normal during subnet discovery.
        }
        for (const epc of probe.epcs) {
          if (detected) break;
          try {
            const result = asRecord(await dependencies.runDeviceCommand("raw-get", { host, eoj, timeout: 2 }, [epc]));
            detected = typeof result.raw === "string" && result.raw.length > 2 && result.raw.startsWith("0x");
          } catch {
            // Not every device exposes every role. Keep trying the remaining hints.
          }
        }
        if (detected) addDiscoveredInstance(enriched, host, instance);
      }
      scanned += 1;
      progress({ phase: "identifying", total: hosts.length, scanned, found: Object.keys(enriched).length });
    }
    return enriched;
  }


  function suggestedConfigFromDiscovery(devices: DiscoveredDeviceMap, currentConfig: ApplicationConfig): ApplicationConfig {
    const next: ApplicationConfig = structuredClone(currentConfig);
    const hostsWithClass = (classCode: string) => Object.keys(devices)
      .filter((host) => devices[host]?.all_instances.some((instance) => instance.startsWith(classCode)));
    const matchingHost = (classCode: string, current: string) => {
      const candidates = hostsWithClass(classCode);
      return candidates.includes(current) ? current : candidates.length === 1 ? candidates[0] : undefined;
    };
    next.batteryHost = matchingHost("027d", next.batteryHost) ?? next.batteryHost;
    const solar = matchingHost("0279", next.solarHost);
    if (solar) {
      next.solarHost = solar;
      next.solarEnabled = true;
    }
    const meter = matchingHost("0287", next.meterHost);
    if (meter) {
      next.meterHost = meter;
      next.smartCosmoEnabled = true;
    }
    const fuelCellHosts = new Set(next.fuelCellHosts);
    const discoveredFuelCells = hostsWithClass("027c");
    for (const host of discoveredFuelCells) {
      fuelCellHosts.add(host);
      next.fuelCellEnabled = true;
    }
    const primaryCandidates = discoveredFuelCells.filter((host) => host !== currentConfig.meterHost &&
      !next.fuelCellProxyHosts.includes(host) && !devices[host]?.all_instances.some((instance) => instance.startsWith("0287")));
    if (!discoveredFuelCells.includes(next.fuelCellPrimaryHost) && primaryCandidates.length === 1) {
      fuelCellHosts.delete(next.fuelCellPrimaryHost);
      next.fuelCellPrimaryHost = primaryCandidates[0]!;
    }
    next.fuelCellHosts = [...fuelCellHosts];
    return dependencies.cleanConfig(next);
  }


  function discoveryResult(devices: DiscoveredDeviceMap, network: DiscoveryNetworkHints, config: ApplicationConfig): DiscoveryResult {
    const discovered = Object.entries(devices).map(([host, device]) => ({
      host,
      roles: inferDevice(device.all_instances ?? []),
      instances: device.all_instances ?? [],
    }));
    return {
      discovered,
      network,
      suggestedConfig: suggestedConfigFromDiscovery(devices, config),
    };
  }


  async function discoverDevices(timeout: unknown = 5, mode: string = "broadcast", progress: (patch: DiscoveryProgress) => void = () => undefined, requestedSubnets: unknown = []): Promise<DiscoveryResult> {
    const config = await dependencies.readConfig();
    const network = localNetworkHints(config, requestedSubnets);
    const scanTimeout = Math.max(1, Number(timeout) || 5);
    let devices = await activeScanSubnets(
      network.scanSubnets,
      scanTimeout,
      (patch) => progress({ ...patch, network }),
    );
    let broadcastUnavailable = false;
    if (mode === "broadcast") {
      progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(devices).length, network });
      try {
        const broadcastDevices = await dependencies.runDeviceCommand("discover", { timeout: scanTimeout });
        devices = mergeDiscoveredDevices(devices, normalizeDiscoveredDevices(broadcastDevices));
      } catch {
        broadcastUnavailable = true;
      }
    }
    const enriched = await enrichDiscoveredDevices(devices, config, (patch) => progress({ ...patch, network }));
    const result = discoveryResult(enriched, network, config);
    return broadcastUnavailable ? { ...result, broadcastUnavailable } : result;
  }


  function discoveryJobView(job: DiscoveryJob): DiscoveryJob {
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      total: job.total,
      scanned: job.scanned,
      found: job.found,
      network: job.network,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }


  function cleanupDiscoveryJobs(): void {
    const cutoff = Date.now() - DISCOVERY_JOB_TTL_MS;
    for (const [id, job] of discoveryJobs) {
      if (new Date(job.updatedAt).getTime() < cutoff) discoveryJobs.delete(id);
    }
  }


  function updateDiscoveryJob(job: DiscoveryJob, patch: Partial<DiscoveryJob>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }


  function discoveryInProgress(): boolean {
    return discoveryRunContext !== null;
  }


  async function withDiscoveryRun<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (discoveryRunContext) {
      throw new Error(`discovery already running (${discoveryRunContext.label})`);
    }
    discoveryRunContext = {
      label,
      startedAt: new Date().toISOString(),
    };
    try {
      return await fn();
    } finally {
      discoveryRunContext = null;
    }
  }


  function startDiscoveryJob(timeout: unknown, mode: string = "broadcast", subnets: unknown = []): DiscoveryJob {
    cleanupDiscoveryJobs();
    const invalidSubnets = invalidDiscoverySubnets(subnets);
    if (invalidSubnets.length) {
      const error = new Error(`Discovery subnets must be RFC1918 /24 networks: ${invalidSubnets.join(", ")}`) as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const job: DiscoveryJob = {
      id: randomUUID(),
      status: "running",
      phase: "starting",
      total: 0,
      scanned: 0,
      found: 0,
      network: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    discoveryJobs.set(job.id, job);
    withDiscoveryRun(`${mode} discovery`, () =>
      discoverDevices(timeout, mode, (patch) => updateDiscoveryJob(job, patch), subnets),
    )
      .then((result) => {
        updateDiscoveryJob(job, {
          status: "complete",
          phase: "complete",
          found: result.discovered.length,
          result,
        });
      })
      .catch((error: unknown) => {
        updateDiscoveryJob(job, {
          status: "failed",
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return discoveryJobView(job);
  }

  return {
    cleanupJobs: cleanupDiscoveryJobs,
    getJob: (id: string) => discoveryJobs.get(id),
    inProgress: discoveryInProgress,
    jobView: discoveryJobView,
    label: () => discoveryRunContext?.label ?? null,
    startJob: startDiscoveryJob,
  };
}
