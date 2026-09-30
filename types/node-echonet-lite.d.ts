declare module "node-echonet-lite" {
  type EchonetCallback<T = unknown> = (error: Error | null | undefined, response: T) => void;

  interface EchonetDiscoveryResponse {
    device: {
      address: string;
      eoj?: number[][];
    };
  }

  class EchonetLite {
    constructor(options?: { type?: string; netif?: string });
    init(callback: (error?: Error | null) => void): void;
    close(callback: () => void): void;
    getPropertyValue(host: string, eoj: number[], epc: number, callback: EchonetCallback): void;
    setPropertyValue(host: string, eoj: number[], epc: number, edt: Buffer, callback: EchonetCallback): void;
    getPropertyMaps(host: string, eoj: number[], callback: EchonetCallback): void;
    startDiscovery(callback: EchonetCallback<EchonetDiscoveryResponse>): void;
    stopDiscovery(): void;
  }
  export default EchonetLite;
}
