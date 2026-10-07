import EchonetLite from "node-echonet-lite";

export type EchonetObject = [number, number, number] | number[];

export interface EchonetProperty {
  epc: number;
  buffer?: Buffer;
  edt?: Buffer;
}

export interface EchonetResponse {
  message?: {
    esv?: string;
    data?: {
      list?: number[][];
      inf?: number[];
      set?: number[];
      get?: number[];
      [key: string]: unknown;
    } | Buffer | unknown;
    prop?: EchonetProperty[];
  };
}

export interface DiscoveredDevice {
  all_instances: string[];
  storage_battery_instances: number[];
}

export type DiscoveredDevices = Record<string, DiscoveredDevice>;

export interface EchonetClient {
  init(): Promise<void>;
  close(): Promise<void>;
  get(host: string, eoj: number[], epc: number, timeoutMs?: number): Promise<EchonetResponse>;
  set(host: string, eoj: number[], epc: number, edt: Buffer, timeoutMs?: number): Promise<EchonetResponse>;
  maps(host: string, eoj: number[], timeoutMs?: number): Promise<EchonetResponse>;
  discover(timeoutMs?: number): Promise<DiscoveredDevices>;
}

export interface EchonetTransportOptions {
  timeout?: number;
  netif?: string;
  debug?: boolean;
}

type NodeCallback<T> = (error: Error | null | undefined, response: T) => void;

function eojHex(eoj: number[]): string {
  return `0x${eoj.map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function normalizeResponse(value: unknown): EchonetResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as EchonetResponse;
}

export class EchonetNode implements EchonetClient {
  private readonly el: EchonetLite;
  private readonly timeoutMs: number;
  readonly debug: boolean;

  constructor({ timeout = 3, netif = "", debug = false }: EchonetTransportOptions = {}) {
    const params: { type: string; netif?: string } = { type: "lan" };
    if (netif) params.netif = netif;
    this.el = new EchonetLite(params);
    this.timeoutMs = Number(timeout) * 1000;
    this.debug = debug;
  }

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.el.init((error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.el.close(resolve));
  }

  private withTimeout<T>(work: (callback: NodeCallback<T>) => void, label: string, timeoutMs: number = this.timeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);
      work((error, response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  get(host: string, eoj: number[], epc: number, timeoutMs?: number): Promise<EchonetResponse> {
    return this.withTimeout(
      (callback) => this.el.getPropertyValue(host, eoj, epc, (error, response) => callback(error, normalizeResponse(response))),
      `${host} ${eojHex(eoj)} EPC 0x${epc.toString(16)}`,
      timeoutMs,
    );
  }

  set(host: string, eoj: number[], epc: number, edt: Buffer, timeoutMs?: number): Promise<EchonetResponse> {
    return this.withTimeout(
      (callback) => this.el.setPropertyValue(host, eoj, epc, edt, (error, response) => callback(error, normalizeResponse(response))),
      `${host} ${eojHex(eoj)} EPC 0x${epc.toString(16)} set`,
      timeoutMs,
    );
  }

  maps(host: string, eoj: number[], timeoutMs?: number): Promise<EchonetResponse> {
    return this.withTimeout(
      (callback) => this.el.getPropertyMaps(host, eoj, (error, response) => callback(error, normalizeResponse(response))),
      `${host} ${eojHex(eoj)} maps`,
      timeoutMs,
    );
  }

  discover(timeoutMs: number = this.timeoutMs): Promise<DiscoveredDevices> {
    return new Promise((resolve, reject) => {
      const devices: DiscoveredDevices = {};
      const timer = setTimeout(() => {
        this.el.stopDiscovery();
        resolve(devices);
      }, timeoutMs);
      this.el.startDiscovery((error, response) => {
        if (error) {
          clearTimeout(timer);
          this.el.stopDiscovery();
          reject(error);
          return;
        }
        const address = response.device.address;
        devices[address] ??= { all_instances: [], storage_battery_instances: [] };
        for (const eoj of response.device.eoj ?? []) {
          const hex = eojHex(eoj).slice(2).toLowerCase();
          if (!devices[address].all_instances.includes(hex)) devices[address].all_instances.push(hex);
          if (eoj[0] === 0x02 && eoj[1] === 0x7d && eoj[2] !== undefined) {
            devices[address].storage_battery_instances.push(eoj[2]);
          }
        }
      });
    });
  }
}

export function createEchonetClient(options: EchonetTransportOptions = {}): EchonetClient {
  return new EchonetNode(options);
}
