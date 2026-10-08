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
import { asRecord, errorMessage } from "../domain/values.js";

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

function numberInRange(value: unknown, label: string, min: number, max: number, step = 1): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max || number % step !== 0) {
    throw Object.assign(new Error(`${label} must be an integer from ${min} to ${max}${step > 1 ? ` in ${step} steps` : ""}`), { statusCode: 400 });
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
        if (!payload.mode) throw dependencies.createHttpError(400, "mode is required");
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
        if (!payload.mode) throw dependencies.createHttpError(400, "mode is required");
        return assertDeviceCommandResult(await dependencies.runDeviceCommand("set-mode", { host }, [payload.mode]), `operation mode ${payload.mode}`, dependencies.invalidateStatus);
      case "charge":
      case "discharge": {
        const args: DeviceCommandArguments = { host };
        if (payload.targetWh !== undefined && payload.targetWh !== null && payload.targetWh !== "") args["target-wh"] = numberInRange(payload.targetWh, "targetWh", 0, 999999999);
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

  function parseTargetWhFromRaw(readback: unknown): number | null {
    const raw = asRecord(readback).raw;
    if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) return null;
    const value = Number.parseInt(raw.slice(2), 16);
    return Number.isFinite(value) ? value : null;
  }

  async function verifyChargeTarget(result: unknown, host: string, expectedWh: number, targetEpc: string) {
    const attempts = dependencies.operationModeVerifyAttempts ?? 4;
    const delayMs = dependencies.operationModeVerifyDelayMs ?? 750;
    let observed: number | null = null;
    let sawReadable = false;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const readback = await dependencies.runDeviceCommand("raw-get", { host, eoj: "0x027D01", timeout: 3 }, [targetEpc], { priority: 0 });
        observed = parseTargetWhFromRaw(readback);
        lastError = null;
        if (observed !== null) sawReadable = true;
        if (observed === expectedWh) return { verified: true as const, targetWh: observed, attempts: attempt, unreadable: false };
      } catch (error: unknown) {
        lastError = error;
      }
    }
    if (lastError) throw new Error(`charge target was acknowledged but verification failed: ${errorMessage(lastError)}`, { cause: lastError });
    // A device that does not expose the target EPC (Get_SNA -> null raw) cannot be
    // checked; fall back to the mode verification rather than failing a real write.
    if (!sawReadable) return { verified: true as const, targetWh: null, attempts, unreadable: true };
    throw new Error(`charge target verification mismatch: expected ${expectedWh}, observed ${observed}`);
  }

  async function verifyAction(action: string, payload: UnknownRecord, result: unknown, host: string) {
    const acknowledged = asRecord(result);
    const decoded = asRecord(acknowledged.decoded);
    switch (action) {
      case "set-mode": return verifyMode(result, host, payload.mode);
      case "charge":
      case "discharge": {
        const verifiedMode = await verifyMode(result, host, action === "charge" ? "charging" : "discharging");
        const requestedTarget = payload.targetWh;
        if (requestedTarget === undefined || requestedTarget === null || requestedTarget === "") return verifiedMode;
        const expectedWh = Number(requestedTarget);
        if (!Number.isFinite(expectedWh)) return verifiedMode;
        const target = await verifyChargeTarget(result, host, expectedWh, action === "charge" ? "0xAA" : "0xAB");
        return target.unreadable
          ? verifiedMode
          : { ...verifiedMode, readBack: { ...asRecord(verifiedMode.readBack), targetWh: target.targetWh } };
      }
      case "vendor-profile": return verifySetting(result, host, "vendor-profile", String(payload.mode), (readback) => {
        const value = asRecord(readback);
        return asRecord(value.decoded).mode ?? value.mode ?? null;
      });
      case "discharge-limit": return verifySetting(result, host, "discharge-limit", Number(acknowledged.percent ?? payload.percent), (readback) => Number(asRecord(asRecord(readback).decoded).percent));
      case "osaifu-charge-window": return verifySetting(result, host, "osaifu-charge-window", [Number(decoded.start_hour ?? payload.startHour), Number(decoded.end_hour ?? payload.endHour)], (readback) => {
        const readDecoded = asRecord(asRecord(readback).decoded);
        return [Number(readDecoded.start_hour), Number(readDecoded.end_hour)];
      });
      case "osaifu-discharge-window": return verifySetting(result, host, "osaifu-discharge-window", [Number(decoded.start_hour ?? payload.startHour), Number(decoded.end_hour ?? payload.endHour)], (readback) => {
        const readDecoded = asRecord(asRecord(readback).decoded);
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
    const payload = asRecord(payloadValue);
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
    const payload = asRecord(payloadValue);
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
