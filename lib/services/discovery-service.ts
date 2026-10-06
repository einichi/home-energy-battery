import dgram from "node:dgram";
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
  instanceListRequest,
  ipRangeFromCidr,
  isGetResponse,
  mergeDiscoveredDevices,
  normalizeDiscoveredDevices,
  parseInstanceListResponse,
  parseTid,
  propertyRequest,
  subnetFromHost,
  type DiscoveredDeviceMap,
} from "./discovery-protocol.js";

export interface DiscoveryServiceDependencies {
  readConfig: () => Promise<ApplicationConfig>;
  cleanConfig: (value: unknown) => ApplicationConfig;
  runDeviceCommand: (command: string, args?: DeviceCommandArguments, positional?: unknown[], options?: { priority?: number; queueTimeoutMs?: number }) => Promise<unknown>;
}

interface DiscoveryNetworkHints {
  configuredSubnets: string[];
  containerSubnets: string[];
  userSubnets: string[];
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createDiscoveryService(dependencies: DiscoveryServiceDependencies) {
  let discoveryRunContext: { label: string; startedAt: string } | null = null;
  const discoveryJobs = new Map<string, DiscoveryJob>();
  const DISCOVERY_JOB_TTL_MS = 10 * 60 * 1000;


  function localNetworkHints(config: ApplicationConfig): DiscoveryNetworkHints {
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
    return {
      configuredSubnets,
      containerSubnets: [...new Set(containerSubnets)],
      userSubnets: normalizeSubnets(config.discoverySubnets),
    };
  }


  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


  async function activeScanSubnets(subnets: string[], timeoutMs: number, progress: (patch: DiscoveryProgress) => void = () => undefined): Promise<DiscoveredDeviceMap> {
    // Broadcast discovery is polite but not always reliable through controllers or
    // Docker networking, so this scan pokes each /24 address directly. It binds an
    // ephemeral source port instead of ECHONET's 3610 so it can run even if another
    // local reader has recently held the standard port.
    const socket = dgram.createSocket("udp4");
    const tidToHost = new Map<number, string>();
    const tidToDirectProbe = new Map<number, { host: string; instance: string }>();
    const found: DiscoveredDeviceMap = {};
    let tid = 1;
    const hosts = [...new Set(subnets.flatMap(ipRangeFromCidr))];
    let scanned = 0;
    const retryRounds = 3;
    const batchSize = 16;

    await new Promise<void>((resolve, reject) => {
      const bindEphemeral = () => {
        socket.removeAllListeners("error");
        socket.once("error", reject);
        socket.bind(0, "0.0.0.0", resolve);
      };
      socket.once("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          bindEphemeral();
        } else {
          reject(err);
        }
      });
      socket.bind(3610, "0.0.0.0", resolve);
    });

    socket.on("message", (msg, rinfo) => {
      const parsed = parseInstanceListResponse(msg);
      if (parsed) {
        const host = tidToHost.get(parsed.tid) ?? rinfo.address;
        for (const instance of parsed.instances) {
          addDiscoveredInstance(found, host, instance);
        }
        progress({ found: Object.keys(found).length });
        return;
      }
      const tidValue = parseTid(msg);
      const directProbe = tidValue ? tidToDirectProbe.get(tidValue) : null;
      if (directProbe && isGetResponse(msg)) {
        addDiscoveredInstance(found, directProbe.host ?? rinfo.address, directProbe.instance);
        progress({ found: Object.keys(found).length });
      }
    });

    progress({ phase: "active-scan", total: hosts.length, scanned: 0, found: 0 });
    for (let round = 0; round < retryRounds; round += 1) {
      for (let index = 0; index < hosts.length; index += 1) {
        const host = hosts[index];
        tid = (tid % 0xfffe) + 1;
        tidToHost.set(tid, host);
        socket.send(instanceListRequest(tid), 3610, host, () => {});
        if (round === 0) {
          for (const probe of KNOWN_DISCOVERY_PROBES) {
            const epc = probe.epcs[0];
            tid = (tid % 0xfffe) + 1;
            tidToDirectProbe.set(tid, {
              host,
              instance: probe.eoj.slice(2).toLowerCase(),
            });
            socket.send(propertyRequest(tid, probe.eoj, epc), 3610, host, () => {});
          }
        }
        if (round === 0) scanned += 1;
        if (
          round === 0 &&
          (scanned === hosts.length || scanned % batchSize === 0)
        ) {
          progress({ phase: "active-scan", total: hosts.length, scanned, found: Object.keys(found).length });
        }
        if ((index + 1) % batchSize === 0) await sleep(20);
      }
      await sleep(120);
    }

    progress({ phase: "waiting", total: hosts.length, scanned, found: Object.keys(found).length });
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    socket.close();
    return found;
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
      const instances: string[] = [];
      for (const probe of KNOWN_DISCOVERY_PROBES) {
        const eoj = probe.eoj;
        let detected = false;
        try {
          const result = record(await dependencies.runDeviceCommand("inspect-host", { host, eoj, timeout: 2 }));
          // inspect-host keys its output with the upper-case eojHex() form.
          const entry = record(result[eoj.toUpperCase()]);
          detected = Object.keys(entry).length > 0 && !entry.error;
        } catch {
          // Silent hosts are normal during subnet discovery.
        }
        for (const epc of probe.epcs) {
          if (detected) break;
          try {
            const result = record(await dependencies.runDeviceCommand("raw-get", { host, eoj, timeout: 2 }, [epc]));
            detected = typeof result.raw === "string" && result.raw.startsWith("0x");
          } catch {
            // Not every device exposes every role. Keep trying the remaining hints.
          }
        }
        if (detected) instances.push(eoj.slice(2).toLowerCase());
      }
      if (instances.length) {
        enriched[host] = mergeDiscoveredDevices(enriched, {
          [host]: { all_instances: instances, storage_battery_instances: [] },
        })[host];
      }
      scanned += 1;
      progress({ phase: "identifying", total: hosts.length, scanned, found: Object.keys(enriched).length });
    }
    return enriched;
  }


  function suggestedConfigFromDiscovery(devices: DiscoveredDeviceMap, currentConfig: ApplicationConfig): ApplicationConfig {
    const next: ApplicationConfig = structuredClone(currentConfig);
    const fuelCellHosts = new Set(next.fuelCellHosts);
    for (const [host, device] of Object.entries(devices)) {
      const instances = device.all_instances ?? [];
      if (instances.some((item) => item.toLowerCase().startsWith("027d"))) next.batteryHost = host;
      if (instances.some((item) => item.toLowerCase().startsWith("0279"))) {
        next.solarHost = host;
        next.solarEnabled = true;
      }
      if (instances.some((item) => item.toLowerCase().startsWith("0287"))) {
        next.meterHost = host;
        next.smartCosmoEnabled = true;
      }
      if (instances.some((item) => item.toLowerCase().startsWith("027c"))) {
        fuelCellHosts.add(host);
        next.fuelCellEnabled = true;
      }
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
    const network = localNetworkHints(config);
    const scanTimeout = Number(timeout) || 5;
    const subnets = normalizeSubnets(requestedSubnets).length
      ? normalizeSubnets(requestedSubnets)
      : network.userSubnets.length
        ? network.userSubnets
        : network.configuredSubnets.length
          ? network.configuredSubnets
          : network.containerSubnets;
    if (mode === "active") {
      const activeDevices = await activeScanSubnets(
        subnets,
        Math.max(1000, scanTimeout * 1000),
        (patch) => progress({ ...patch, network }),
      );
      const devices = await enrichDiscoveredDevices(
        activeDevices,
        config,
        (patch) => progress({ ...patch, network }),
      );
      return discoveryResult(devices, network, config);
    }

    const activeDevices = await activeScanSubnets(
      subnets,
      Math.max(1000, scanTimeout * 1000),
      (patch) => progress({ ...patch, network }),
    );
    progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(activeDevices).length, network });
    const broadcastDevices = normalizeDiscoveredDevices(await dependencies.runDeviceCommand("discover", { timeout: scanTimeout }));
    progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(mergeDiscoveredDevices(activeDevices, broadcastDevices)).length, network });
    const devices = await enrichDiscoveredDevices(
      mergeDiscoveredDevices(activeDevices, broadcastDevices),
      config,
      (patch) => progress({ ...patch, network }),
    );
    return discoveryResult(devices, network, config);
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
