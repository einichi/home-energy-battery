import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DeviceCommandExecutor } from "./device-command-queue.js";

export interface DeviceAdapter {
  execute: DeviceCommandExecutor;
  close?(): Promise<void> | void;
}

type AdapterFactory = (options: Record<string, unknown>) => Promise<DeviceAdapter | DeviceCommandExecutor>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeAdapter(value: unknown): DeviceAdapter {
  if (typeof value === "function") return { execute: value as DeviceCommandExecutor };
  if (!isRecord(value) || typeof value.execute !== "function") {
    throw new Error("Device adapter must be a function or an object with execute()");
  }
  return {
    execute: (value.execute as DeviceCommandExecutor).bind(value),
    ...(typeof value.close === "function" ? { close: (value.close as () => Promise<void> | void).bind(value) } : {}),
  };
}

export interface LoadDeviceAdapterOptions {
  environment: NodeJS.ProcessEnv;
  moduleBaseDirectory: string;
  createDefaultAdapter: AdapterFactory;
  defaultOptions: Record<string, unknown>;
}

export async function loadDeviceAdapter({
  environment,
  moduleBaseDirectory,
  createDefaultAdapter,
  defaultOptions,
}: LoadDeviceAdapterOptions): Promise<DeviceAdapter> {
  const modulePath = environment.DEVICE_COMMAND_ADAPTER_MODULE;
  if (!modulePath) return normalizeAdapter(await createDefaultAdapter(defaultOptions));
  if (environment.NODE_ENV !== "test") {
    throw new Error("DEVICE_COMMAND_ADAPTER_MODULE may only be used when NODE_ENV=test");
  }
  const resolvedPath = path.isAbsolute(modulePath) ? modulePath : path.resolve(moduleBaseDirectory, modulePath);
  const imported: unknown = await import(pathToFileURL(resolvedPath).href);
  if (!isRecord(imported) || typeof imported.createDeviceCommandAdapter !== "function") {
    throw new Error(`${resolvedPath} must export createDeviceCommandAdapter()`);
  }
  const createAdapter = imported.createDeviceCommandAdapter as AdapterFactory;
  return normalizeAdapter(await createAdapter({ environment }));
}
