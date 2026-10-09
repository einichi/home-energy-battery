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

const INIT_RETRY_COOLDOWN_MS = 30_000;

function makeClient(opts: Record<string, unknown>): EchonetClient {
  return createEchonetClient({
    timeout: Number(opts.timeout ?? 3),
    netif: String(opts.netif ?? ""),
    debug: opts.debug === true,
  });
}

async function createEchonetCommandAdapter(options: Record<string, unknown> & { client?: EchonetClient; now?: () => number } = {}) {
  const client = options.client ?? makeClient(options);
  const now = options.now ?? Date.now;
  let initialization: Promise<void> | null = null;
  let initializationFailedAt: number | null = null;
  let closed = false;
  const initialize = () => {
    if (initialization && (initializationFailedAt === null || now() - initializationFailedAt < INIT_RETRY_COOLDOWN_MS)) {
      return initialization;
    }
    initializationFailedAt = null;
    initialization = Promise.resolve()
      .then(() => client.init())
      .catch((error: unknown) => {
        initializationFailedAt = now();
        throw error;
      });
    return initialization;
  };
  return {
    async execute(command: string, args: Record<string, unknown> = {}, positional: unknown[] = []): Promise<unknown> {
      if (closed) throw new Error("ECHONET client is closed");
      await initialize();
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
