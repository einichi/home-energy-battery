import { createEchonetClient } from "./adapters/echonet-transport.js";
import type { EchonetClient } from "./adapters/echonet-transport.js";
import {
  decodeEnum,
  decodeFuelCellCumulative,
  decodeFuelCellHotWaterLevel,
  EDT_TO_FUEL_CELL_INTERCONNECTION,
  EDT_TO_FUEL_CELL_STATUS,
  EPC,
} from "./adapters/echonet-codecs.js";
import { executeEchonetCommand } from "./adapters/echonet-commands.js";

function makeClient(opts: Record<string, unknown>): EchonetClient {
  return createEchonetClient({
    timeout: Number(opts.timeout ?? 3),
    netif: String(opts.netif ?? ""),
    debug: opts.debug === true,
  });
}

async function createEchonetCommandAdapter(options: Record<string, unknown> & { client?: EchonetClient } = {}) {
  const client = options.client ?? makeClient(options);
  let initialization: Promise<void> | null = null;
  let closed = false;
  return {
    async execute(command: string, args: Record<string, unknown> = {}, positional: unknown[] = []): Promise<unknown> {
      if (closed) throw new Error("ECHONET client is closed");
      initialization ??= client.init();
      await initialization;
      return executeEchonetCommand(command, args, positional, client);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (!initialization) return;
      await initialization.catch(() => {});
      await client.close();
    },
  };
}

export {
  createEchonetCommandAdapter,
  decodeFuelCellCumulative,
  decodeFuelCellHotWaterLevel,
  decodeEnum,
  executeEchonetCommand,
  EPC,
  EDT_TO_FUEL_CELL_STATUS,
  EDT_TO_FUEL_CELL_INTERCONNECTION,
};
