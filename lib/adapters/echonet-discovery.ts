import { setTimeout as delay } from "node:timers/promises";
import { addDiscoveredInstance, KNOWN_DISCOVERY_PROBES, type DiscoveredDeviceMap } from "../domain/discovery-protocol.js";
import { EPC, eojHex, parseByte, parseEoj, propRaw, responseData } from "./echonet-codecs.js";
import type { EchonetClient } from "./echonet-transport.js";

export async function discoverHosts(
  client: EchonetClient,
  hosts: string[],
  onProgress?: (scanned: number, found: number) => void,
): Promise<DiscoveredDeviceMap> {
  const found: DiscoveredDeviceMap = {};
  const batchSize = 16;
  const probes = [
    { eoj: [0x0e, 0xf0, 0x01], epc: EPC.INSTANCE_LIST },
    ...KNOWN_DISCOVERY_PROBES.map(({ eoj, epcs }) => ({ eoj: parseEoj(eoj), epc: parseByte(epcs[0]) })),
  ];
  let scanned = 0;
  const probeHost = async (host: string) => {
    await Promise.all(probes.map(async ({ eoj, epc }) => {
      const response = await client.get(host, eoj, epc).catch(() => null);
      const source = response?.message?.seoj;
      if (response?.device?.address !== host || response.message?.esv !== "Get_Res" || !source ||
          eojHex(source) !== eojHex(eoj) || !propRaw(response, epc)?.length) return;
      const instances = epc === EPC.INSTANCE_LIST ? responseData(response).list : [source];
      if (!Array.isArray(instances)) return;
      for (const instance of instances) {
        addDiscoveredInstance(found, host, eojHex(instance).slice(2).toLowerCase());
      }
    }));
    scanned += 1;
    onProgress?.(scanned, Object.keys(found).length);
  };

  // ECHONET replies target UDP 3610 even when the request came from another port.
  // Send and receive through the initialized client that already owns that port.
  const pending: Promise<void>[] = [];
  for (let index = 0; index < hosts.length; index += batchSize) {
    pending.push(...hosts.slice(index, index + batchSize).map(probeHost));
    if (index + batchSize < hosts.length) await delay(20);
  }
  await Promise.all(pending);
  return found;
}
