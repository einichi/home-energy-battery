import { randomUUID } from "node:crypto";
import { configNumber } from "./configuration.js";

const DEFAULT_GUARD_CONDITIONS = {
  breakerVoltage: 100,
  breakerAmps: 40,
  reserveAmps: 5,
};

type DemandSource = "houseDemandW" | "gridImportW";
type UnknownRecord = Record<string, unknown>;

export interface AutomationRuleConfig {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  dashboardWarningEnabled: boolean;
  conditions: {
    source: DemandSource;
    breakerAmps: number;
    breakerVoltage: number;
    reserveAmps: number;
    restoreBelowAmps: number;
    restoreDelaySeconds: number;
  };
  action: string;
  payload: UnknownRecord;
  restoreAction: string;
  restorePayload: UnknownRecord;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRuleState {
  lastResult: UnknownRecord | null;
  state: UnknownRecord;
  log: Array<{ at: string; message: string; kind?: string }>;
  stateUpdatedAt: string;
}

export type AutomationRule = AutomationRuleConfig & AutomationRuleState;

export interface AutomationStatus {
  [key: string]: unknown;
  meter?: { grid_import_power?: { value?: unknown }; house_demand_power?: { value?: unknown } };
  energy?: { battery?: { operation_mode?: { value?: unknown; human?: unknown }; instant_power?: { value?: unknown } } };
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}


export function cleanAutomationRuleConfig(value: unknown = {}): AutomationRuleConfig {
  const input = record(value);
  const conditions = record(input.conditions);
  const source = String(conditions.source ?? "");
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || "Charging demand guard"),
    type: String(input.type || "backup-demand-guard"),
    enabled: input.enabled === true,
    dashboardWarningEnabled: input.dashboardWarningEnabled !== false,
    conditions: {
      source: source === "houseDemandW" || source === "gridImportW" ? source : "gridImportW",
      breakerAmps: configNumber(conditions.breakerAmps, DEFAULT_GUARD_CONDITIONS.breakerAmps, 1, 400),
      breakerVoltage: configNumber(conditions.breakerVoltage, DEFAULT_GUARD_CONDITIONS.breakerVoltage, 1, 1000),
      reserveAmps: configNumber(conditions.reserveAmps, DEFAULT_GUARD_CONDITIONS.reserveAmps, 0, 200),
      restoreBelowAmps: configNumber(conditions.restoreBelowAmps, Math.max(1, DEFAULT_GUARD_CONDITIONS.breakerAmps - 10), 1, 400),
      restoreDelaySeconds: configNumber(conditions.restoreDelaySeconds, 300, 0, 86400),
    },
    action: "set-mode",
    payload: { mode: "standby" },
    restoreAction: "set-mode",
    restorePayload: { mode: "auto" },
    cooldownSeconds: configNumber(input.cooldownSeconds, 300, 0, 86400),
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: String(input.updatedAt || new Date().toISOString()),
  };
}


export function cleanAutomationRuleState(value: unknown = {}): AutomationRuleState {
  const input = record(value);
  return {
    lastResult: input.lastResult && typeof input.lastResult === "object" ? record(input.lastResult) : null,
    state: record(input.state),
    log: (Array.isArray(input.log) ? input.log : []).map((entry) => {
      const item = record(entry);
      return { at: String(item.at ?? ""), message: String(item.message ?? ""), ...(item.kind ? { kind: String(item.kind) } : {}) };
    }).slice(-100),
    stateUpdatedAt: String(input.stateUpdatedAt || input.updatedAt || new Date().toISOString()),
  };
}


export function mergeAutomationRule(config: unknown, state: unknown = {}): AutomationRule {
  return {
    ...cleanAutomationRuleConfig(config),
    ...cleanAutomationRuleState(state),
  };
}


export function cleanAutomationRule(input: unknown = {}): AutomationRule {
  return mergeAutomationRule(input, input);
}


export function automationDemandWatts(status: AutomationStatus, source: DemandSource): number {
  const raw = source === "gridImportW"
    ? status.meter?.grid_import_power?.value
    : status.meter?.house_demand_power?.value;
  if (raw === null || raw === undefined || raw === "") return Number.NaN;
  return Number(raw);
}


export function batteryOperationMode(status: AutomationStatus): string | null {
  const value = status.energy?.battery?.operation_mode?.value
    ?? status.energy?.battery?.operation_mode?.human;
  return value === null || value === undefined ? null : String(value);
}


export function batteryChargingWatts(status: AutomationStatus): number | null {
  const raw = status.energy?.battery?.instant_power?.value;
  if (raw === null || raw === undefined || raw === "") return null;
  const watts = Number(raw);
  if (!Number.isFinite(watts)) return null;
  return Math.max(0, watts);
}


export function shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW }: {
  operationMode: unknown;
  batteryChargingW: unknown;
  guardDemandW: unknown;
  breakerLimitW: unknown;
}): boolean {
  const mode = String(operationMode ?? "").toLowerCase();
  return mode !== "standby"
    && Number(batteryChargingW) > 0
    && Number.isFinite(Number(guardDemandW))
    && Number(guardDemandW) >= Number(breakerLimitW);
}


export function canRunAutomation(rule: AutomationRule, now: Date): boolean {
  if (rule.lastResult?.skipped) return true;
  const lastAt = rule.lastResult?.at ? new Date(String(rule.lastResult.at)).getTime() : 0;
  return !lastAt || (now.getTime() - lastAt) / 1000 >= rule.cooldownSeconds;
}


export function formatWatts(value: unknown): string {
  return `${Math.round(Number(value) || 0)} W`;
}


export function appendAutomationLog(rule: AutomationRule, message: string, at: Date = new Date(), kind: string | null = null): void {
  rule.log = [
    ...(Array.isArray(rule.log) ? rule.log : []),
    { at: at.toISOString(), message, ...(kind ? { kind } : {}) },
  ].slice(-100);
}


export function automationDemandLabel(source: DemandSource): string {
  return source === "gridImportW" ? "Grid Import" : "House demand";
}


export function automationRuleLabel(rule: Partial<AutomationRule>): string {
  return `${rule.name || rule.type || "unnamed rule"} [${rule.id || "unknown id"}]`;
}


export function automationRuleList(rules: Array<Partial<AutomationRule>>): string {
  return rules.map(automationRuleLabel).join(", ") || "none";
}


export function activeEchonetLabel(context: { command: string; host?: string | null; startedAt: string } | null | undefined): string {
  if (!context) return "none";
  const elapsedMs = Date.now() - new Date(context.startedAt).getTime();
  return `${context.command}${context.host ? ` on ${context.host}` : ""} (${elapsedMs}ms)`;
}

export function countGuardTriggersForRange(
  rules: Array<Partial<AutomationRule>>,
  start: string | number | Date | null,
  end: string | number | Date | null,
  options: { excludeTimes?: ReadonlySet<string> } = {},
): number {
  const startMs = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
  const endMs = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  const excludeTimes = options.excludeTimes ?? new Set();
  return rules
    .filter((rule) => rule.type === "backup-demand-guard")
    .flatMap((rule) => Array.isArray(rule.log) ? rule.log : [])
    .filter((entry) => {
      const guardEntry = entry?.kind === "guard"
        || String(entry?.message ?? "").includes("exceeds Charge Demand Guard limit");
      if (!guardEntry) return false;
      const atMs = new Date(entry.at).getTime();
      if (excludeTimes.has(entry.at)) return false;
      return Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs;
    })
    .length;
}
