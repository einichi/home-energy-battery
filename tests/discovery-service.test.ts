import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { EchonetClient } from "../lib/adapters/echonet-transport.js";
import { cleanConfig } from "../lib/domain/configuration.js";
import { createEchonetCommandAdapter } from "../lib/echonet-service.js";
import { createDiscoveryService } from "../lib/services/discovery-service.js";

test("active discovery uses the initialized ECHONET client and suggests an unambiguous new Ene-Farm address", async (t) => {
  const oldPrimary = "10.250.0.150";
  const newPrimary = "10.250.0.250";
  const proxy = "10.250.0.135";
  const config = cleanConfig({
    batteryHost: "10.250.0.152",
    solarHost: "10.250.0.152",
    meterHost: proxy,
    fuelCellPrimaryHost: oldPrimary,
    fuelCellProxyHosts: [proxy],
    discoverySubnets: ["10.250.0.0/24"],
  });
  let initCalls = 0;
  let replyAsAnotherPrimary = false;
  const client: EchonetClient = {
    async init() { initCalls += 1; },
    async close() {},
    async get(host, eoj, epc) {
      const fuelCellObject = [0x02, 0x7c, 0x01];
      if (host === proxy && epc === 0xd6) {
        return {
          device: { address: host },
          message: {
            esv: "Get_Res",
            seoj: eoj,
            data: { list: [[0x02, 0x87, 0x01], fuelCellObject] },
            prop: [{ epc, buffer: Buffer.from([2, 2, 0x87, 1, 2, 0x7c, 1]) }],
          },
        };
      }
      if (replyAsAnotherPrimary && epc === 0xd6 && [newPrimary, "10.250.0.251"].includes(host)) {
        return {
          device: { address: host },
          message: {
            esv: "Get_Res",
            seoj: eoj,
            data: { list: [[0x02, 0x7d, 0x01], [0x02, 0x79, 0x01]] },
            prop: [{ epc, buffer: Buffer.from([2, 2, 0x7d, 1, 2, 0x79, 1]) }],
          },
        };
      }
      if (epc === 0xc4 && [newPrimary, "10.250.0.251"].includes(host)) {
        return {
          device: { address: replyAsAnotherPrimary ? host : newPrimary },
          message: { esv: "Get_Res", seoj: fuelCellObject, prop: [{ epc, buffer: Buffer.from([0, 0]) }] },
        };
      }
      return { device: { address: host }, message: { esv: "Get_SNA", seoj: eoj } };
    },
    async set() { throw new Error("unexpected device write"); },
    async maps() { return { message: { esv: "Get_SNA" } }; },
    async discover() { throw new Error("simulated multicast failure"); },
  };
  const adapter = await createEchonetCommandAdapter({ client });
  t.after(() => adapter.close());
  await adapter.execute("raw-get", { host: newPrimary, eoj: "0x027C01" }, ["0xC4"]);

  const service = createDiscoveryService({
    readConfig: async () => config,
    cleanConfig,
    runDeviceCommand: adapter.execute,
  });
  async function runScan(mode: "active" | "broadcast") {
    const { id } = service.startJob(1, mode);
    while (service.getJob(id)?.status === "running") await delay(10);
    const job = service.getJob(id);
    assert.equal(job?.status, "complete", job?.error ?? undefined);
    assert.ok(job?.result);
    return job.result;
  }

  const result = await runScan("active");
  assert.equal(initCalls, 1);
  assert.deepEqual(result.discovered.map(({ host }) => host).sort(), [proxy, newPrimary].sort());
  assert.equal(result.suggestedConfig.fuelCellPrimaryHost, newPrimary);
  assert.deepEqual(result.suggestedConfig.fuelCellProxyHosts, [proxy]);
  assert.deepEqual(result.suggestedConfig.fuelCellHosts, [newPrimary, proxy]);
  assert.equal(config.fuelCellPrimaryHost, oldPrimary);

  const partialResult = await runScan("broadcast");
  assert.equal(partialResult.broadcastUnavailable, true);
  assert.deepEqual(partialResult.discovered, result.discovered);
  assert.deepEqual(partialResult.network.scanSubnets, ["10.250.0.0/24"]);

  replyAsAnotherPrimary = true;
  const ambiguousResult = await runScan("active");
  assert.equal(ambiguousResult.suggestedConfig.fuelCellPrimaryHost, oldPrimary);
  assert.equal(ambiguousResult.suggestedConfig.batteryHost, config.batteryHost);
  assert.equal(ambiguousResult.suggestedConfig.solarHost, config.solarHost);
});
