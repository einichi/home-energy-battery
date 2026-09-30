import { randomUUID } from "node:crypto";
import type { ApplicationConfig } from "../contracts/configuration.js";
import type { BatteryAction } from "../../shared/api-contracts.js";
import type { DeviceCommandArguments } from "./device-command-queue.js";
import {
  assertDeviceCommandResult,
  commandFailureType,
  commandRequestPayload,
  commandResultSummary,
  verifyBatteryOperationMode,
  verifyBatterySetting,
} from "./command-verification.js";

type UnknownRecord = Record<string, unknown>;
type ActionSource = string;

export const DEVICE_ACTION_NAMES = [
  "vendor-profile",
  "discharge-limit",
  "osaifu-charge-window",
  "osaifu-discharge-window",
  "set-mode",
  "charge",
  "discharge",
] as const satisfies readonly BatteryAction[];

export const DEVICE_ACTIONS: ReadonlySet<string> = new Set(DEVICE_ACTION_NAMES);

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberInRange(value: unknown, label: string, min: number, max: number, step = 1): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max || number % step !== 0) {
    throw new Error(`${label} must be an integer from ${min} to ${max}${step > 1 ? ` in ${step} steps` : ""}`);
  }
  return number;
}

export interface DeviceCommandServiceDependencies {
  assertActionAllowed(source: string, action: string): Promise<void>;
  pauseAdaptiveCharging(action: string): Promise<unknown>;
  readConfig(): Promise<ApplicationConfig>;
  runDeviceCommand(command: string, args?: DeviceCommandArguments, positional?: unknown[], options?: { priority?: number; queueTimeoutMs?: number }): Promise<unknown>;
  invalidateStatus(): void;
  history: {
    isReady(): boolean;
    recordEvent(event: UnknownRecord): unknown;
  };
  createHttpError(status: number, message: string): Error;
  operationModeVerifyAttempts?: number;
  operationModeVerifyDelayMs?: number;
}

export function createDeviceCommandService(dependencies: DeviceCommandServiceDependencies) {
  const activeCommands = new Set<Promise<unknown>>();

  function hostFrom(payload: UnknownRecord, config: ApplicationConfig): string {
    return String(payload.host || config.batteryHost);
  }

  function recordLifecycle(commandId: string, type: string, details: UnknownRecord): unknown {
    if (!dependencies.history.isReady()) return false;
    const at = new Date().toISOString();
    return dependencies.history.recordEvent({
      eventKey: `command:${commandId}:${type}`,
      at,
      category: "command",
      type,
      message: details.message,
      payload: { commandId, ...details, at },
    });
  }

  async function executeCore(action: string, payload: UnknownRecord = {}, { source = "manual" }: { source?: ActionSource } = {}): Promise<unknown> {
    await dependencies.assertActionAllowed(source, action);
    if (source === "manual") await dependencies.pauseAdaptiveCharging(action);
    const config = await dependencies.readConfig();
    const host = hostFrom(payload, config);
    switch (action) {
      case "vendor-profile":
        if (!payload.mode) throw new Error("mode is required");
        return assertDeviceCommandResult(await dependencies.runDeviceCommand("vendor-profile", { host }, [payload.mode]), `charging profile ${payload.mode}`, dependencies.invalidateStatus);
      case "discharge-limit":
        return assertDeviceCommandResult(await dependencies.runDeviceCommand("discharge-limit", { host }, [numberInRange(payload.percent, "percent", 0, 100, 10)]), "discharge limit", dependencies.invalidateStatus);
      case "osaifu-charge-window":
      case "osaifu-discharge-window": {
        const startHour = numberInRange(payload.startHour, "startHour", 0, 23);
        const endHour = numberInRange(payload.endHour, "endHour", 0, 23);
        return assertDeviceCommandResult(await dependencies.runDeviceCommand(action, { host }, [startHour, endHour]), action === "osaifu-charge-window" ? "osaifu charge window" : "osaifu discharge window", dependencies.invalidateStatus);
      }
      case "set-mode":
        if (!payload.mode) throw new Error("mode is required");
        return assertDeviceCommandResult(await dependencies.runDeviceCommand("set-mode", { host }, [payload.mode]), `operation mode ${payload.mode}`, dependencies.invalidateStatus);
      case "charge":
      case "discharge": {
        const args: DeviceCommandArguments = { host };
        if (payload.targetWh !== undefined && payload.targetWh !== "") args["target-wh"] = numberInRange(payload.targetWh, "targetWh", 0, 999999999);
        return assertDeviceCommandResult(await dependencies.runDeviceCommand(action, args), `${action} request`, dependencies.invalidateStatus);
      }
      default:
        throw dependencies.createHttpError(404, `unknown action: ${action}`);
    }
  }

  async function verifySetting(result: unknown, host: string, command: string, expected: unknown, readObserved: (readback: unknown) => unknown) {
    return verifyBatterySetting(result, host, command, expected, readObserved, {
      attempts: dependencies.operationModeVerifyAttempts,
      delayMs: dependencies.operationModeVerifyDelayMs,
      run: (nextCommand, args) => dependencies.runDeviceCommand(nextCommand, args, [], { priority: 0 }),
    });
  }

  async function verifyMode(result: unknown, host: string, expectedMode: unknown) {
    return verifyBatteryOperationMode(result, host, expectedMode, {
      attempts: dependencies.operationModeVerifyAttempts,
      delayMs: dependencies.operationModeVerifyDelayMs,
      readStatus: () => dependencies.runDeviceCommand("raw-get", { host, eoj: "0x027D01", timeout: 3 }, ["0xDA"], { priority: 0 }),
    });
  }

  async function verifyAction(action: string, payload: UnknownRecord, result: unknown, host: string) {
    const acknowledged = record(result);
    const decoded = record(acknowledged.decoded);
    switch (action) {
      case "set-mode": return verifyMode(result, host, payload.mode);
      case "charge": return verifyMode(result, host, "charging");
      case "discharge": return verifyMode(result, host, "discharging");
      case "vendor-profile": return verifySetting(result, host, "vendor-profile", String(payload.mode), (readback) => {
        const value = record(readback);
        return record(value.decoded).mode ?? value.mode ?? null;
      });
      case "discharge-limit": return verifySetting(result, host, "discharge-limit", Number(acknowledged.percent ?? payload.percent), (readback) => Number(record(record(readback).decoded).percent));
      case "osaifu-charge-window": return verifySetting(result, host, "osaifu-charge-window", [Number(decoded.start_hour ?? payload.startHour), Number(decoded.end_hour ?? payload.endHour)], (readback) => {
        const readDecoded = record(record(readback).decoded);
        return [Number(readDecoded.start_hour), Number(readDecoded.end_hour)];
      });
      case "osaifu-discharge-window": return verifySetting(result, host, "osaifu-discharge-window", [Number(decoded.start_hour ?? payload.startHour), Number(decoded.end_hour ?? payload.endHour)], (readback) => {
        const readDecoded = record(record(readback).decoded);
        return [Number(readDecoded.start_hour), Number(readDecoded.end_hour)];
      });
      default: throw new Error(`No readback verifier is defined for ${action}`);
    }
  }

  async function execute(action: string, payloadValue: unknown = {}, options: {
    source?: ActionSource;
    commandId?: string;
    requestedRecorded?: boolean;
  } = {}) {
    const payload = record(payloadValue);
    const source = options.source ?? "manual";
    const commandId = options.commandId ?? randomUUID();
    const startedAtMs = Date.now();
    const host = hostFrom(payload, await dependencies.readConfig());
    const request = commandRequestPayload(payload);
    if (!options.requestedRecorded) recordLifecycle(commandId, "requested", { action, source, target: { kind: "battery", host }, request, message: `${source} requested ${action}` });
    recordLifecycle(commandId, "sending", { action, source, target: { kind: "battery", host }, request, message: `Sending ${action} to the device` });
    try {
      const acknowledged = await executeCore(action, payload, { source });
      recordLifecycle(commandId, "acknowledged", { action, source, target: { kind: "battery", host }, request, acknowledgement: commandResultSummary(acknowledged), message: `${action} was acknowledged by the device` });
      recordLifecycle(commandId, "verifying", { action, source, target: { kind: "battery", host }, request, message: `Reading back ${action}` });
      const verified = await verifyAction(action, payload, acknowledged, host);
      const completedAt = new Date().toISOString();
      recordLifecycle(commandId, "succeeded", { action, source, target: { kind: "battery", host }, request, verification: verified.readBack ?? null, durationMs: Date.now() - startedAtMs, message: `${action} was verified` });
      return { ...verified, commandId, commandState: "succeeded", completedAt };
    } catch (error: unknown) {
      const type = commandFailureType(error);
      const detail = errorMessage(error);
      recordLifecycle(commandId, type, { action, source, target: { kind: "battery", host }, request, error: detail, durationMs: Date.now() - startedAtMs, message: `${action} ${type.replace("-", " ")}: ${detail}` });
      if (error instanceof Error) {
        Object.assign(error, { commandId, commandState: type });
      }
      throw error;
    }
  }

  async function start(action: string, payloadValue: unknown = {}, { source = "manual" }: { source?: ActionSource } = {}) {
    if (!DEVICE_ACTIONS.has(action)) throw dependencies.createHttpError(404, `unknown action: ${action}`);
    const payload = record(payloadValue);
    const commandId = randomUUID();
    const host = hostFrom(payload, await dependencies.readConfig());
    recordLifecycle(commandId, "requested", { action, source, target: { kind: "battery", host }, request: commandRequestPayload(payload), message: `${source} requested ${action}` });
    const operation = execute(action, payload, { source, commandId, requestedRecorded: true })
      .catch(() => null)
      .finally(() => activeCommands.delete(operation));
    activeCommands.add(operation);
    return { commandId, commandState: "requested" as const };
  }

  return {
    activeCount: () => activeCommands.size,
    execute,
    start,
  };
}
