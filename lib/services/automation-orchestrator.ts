import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import type { AutomationRule, AutomationStatus } from "../domain/automation-rules.js";
import { automationRuleLabel, automationRuleList } from "../domain/automation-rules.js";
import { adaptiveChargingConfiguredActive, adaptiveChargingWindowHasShortfall, shouldHoldGuardStandbyForAdaptiveCharging } from "../domain/adaptive-control.js";
import { adaptiveChargingAvailability, adaptiveChargingBaseAvailability } from "../domain/adaptive-planning.js";
import type { OperationalOverridesState } from "../domain/operational-overrides.js";

export interface AutomationRunContext {
  startedAt?: string;
  enabledRules?: string[];
  phase?: string;
  statusProbeCompletionLatency?: string[];
}

export interface AdaptiveEvaluationStatus extends AutomationStatus, Record<string, unknown> {
  energy?: AutomationStatus["energy"] & {
    battery?: { remaining_percent?: { value?: unknown }; instant_power?: { value?: unknown } };
    solar?: { instant_power?: { value?: unknown } };
  };
  meter?: AutomationStatus["meter"] & {
    branch_demand_power?: { value?: unknown };
    grid_import_power?: { value?: unknown };
    grid_export_power?: { value?: unknown };
  };
}

function evaluationStatus(value: unknown): AdaptiveEvaluationStatus {
  const source = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const energy = source.energy !== null && typeof source.energy === "object" ? source.energy as Record<string, unknown> : {};
  const battery = energy.battery !== null && typeof energy.battery === "object" ? energy.battery as Record<string, unknown> : {};
  const solar = energy.solar !== null && typeof energy.solar === "object" ? energy.solar as Record<string, unknown> : {};
  const meter = source.meter !== null && typeof source.meter === "object" ? source.meter as Record<string, unknown> : {};
  return {
    ...source,
    energy: { ...energy, battery, solar } as AdaptiveEvaluationStatus["energy"],
    meter: meter as AdaptiveEvaluationStatus["meter"],
  };
}

interface DeviceTiming { sequence: number; command: string; host?: string | null; durationMs: number }
interface NotificationPort {
  observeCondition(condition: Record<string, unknown>): unknown;
  enqueue(notification: Record<string, unknown>): unknown;
}

export interface AutomationOrchestratorDependencies {
  intervalMs: number;
  forecastRefreshMs: number;
  readConfig(): Promise<ApplicationConfig>;
  readAutomationRules(): Promise<AutomationRule[]>;
  writeAutomationRuleStates(rules: AutomationRule[]): Promise<unknown>;
  readOperationalOverridesState(): Promise<OperationalOverridesState>;
  readAdaptiveChargingState(): Promise<AdaptiveChargingState>;
  refreshAdaptiveChargingForecast(config: ApplicationConfig, options: { now: Date }): Promise<AdaptiveChargingState>;
  getStatusSnapshot(options: { maxAgeMs: number; onProbeComplete(probe: { label: string; durationMs: number }): void }): Promise<unknown>;
  deviceTimings(): readonly DeviceTiming[];
  evaluateAutomationRule: (
    rule: AutomationRule,
    status: AutomationStatus,
    now: Date,
    onPhase: (phase: string) => void,
    config: ApplicationConfig,
    coordination: { execute(action: string, payload?: unknown): Promise<unknown>; holdStandbyForAdaptiveCharging: boolean },
  ) => Promise<{ changed: boolean; result?: Record<string, unknown> }>;
  executeAction(action: string, payload: Record<string, unknown>, options: { source: string }): Promise<unknown>;
  evaluateAdaptiveCharging(config: ApplicationConfig, status: AdaptiveEvaluationStatus, rules: AutomationRule[], now: Date): Promise<AdaptiveChargingState>;
  notifications: NotificationPort;
  warn(message: string): void;
}

export function createAutomationOrchestrator(dependencies: AutomationOrchestratorDependencies) {
  function observeAdaptiveCharging(config: ApplicationConfig, state: AdaptiveChargingState): void {
    if (!adaptiveChargingConfiguredActive(config)) return;
    const paused = state.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now();
    if (!paused) {
      const reason = state.lastForecastError?.error
        ?? (state.plan?.available === false ? state.plan.reason : null)
        ?? (!state.plan ? state.lastResult?.skipped : null);
      dependencies.notifications.observeCondition({
        key: "adaptive-charging-availability", active: Boolean(reason), activateAfter: 2, recoverAfter: 1,
        activeEvent: { type: "adaptiveChargingUnavailable", severity: "warning", title: "Adaptive Charging unavailable", message: `Adaptive Charging remained unavailable for two checks: ${reason || "unknown reason"}`, dedupeKey: "adaptive-charging:unavailable" },
        recoveryEvent: { type: "adaptiveChargingRecovered", severity: "info", title: "Adaptive Charging recovered", message: "Adaptive Charging is available again and can evaluate discounted charging windows.", dedupeKey: "adaptive-charging:recovered" },
      });
    }
    const summary = state.windowSummaries?.at(-1);
    if (summary && adaptiveChargingWindowHasShortfall(summary)) {
      const estimatedDeliveryText = summary.estimatedDeliveryWh > 0
        ? ` ${summary.estimatedDeliveryWh} Wh of delivery was estimated between the final sample and exact charge boundaries.`
        : "";
      dependencies.notifications.enqueue({
        type: "adaptiveChargingWindowShortfall", severity: "warning", title: "Discounted charging window ended with a shortfall",
        message: `${summary.label || "Discounted window"} planned ${summary.plannedWh} Wh and delivered ${summary.deliveredWh} Wh, leaving ${summary.unmetWh} Wh unmet.${estimatedDeliveryText} Breaker interruptions: ${summary.interruptionCount}. Solar-headroom pauses: ${summary.solarHeadroomInterruptionCount ?? 0}. SOC: ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%.`,
        occurredAt: summary.completedAt, dedupeKey: `adaptive-charging-window:${summary.key}`, once: true,
      });
    }
  }

  async function run(context: AutomationRunContext = {}): Promise<void> {
    const startedAt = new Date();
    context.startedAt = startedAt.toISOString();
    context.phase = "loading automation rules";
    const config = await dependencies.readConfig();
    const rules = await dependencies.readAutomationRules();
    const backupPreparation = (await dependencies.readOperationalOverridesState()).backupPreparation;
    const enabledRules = rules.filter((rule) => rule.enabled && !(
      backupPreparation.active && backupPreparation.allowDemandGuard === false && rule.type === "backup-demand-guard"
    ));
    const adaptiveChargingRequested = adaptiveChargingConfiguredActive(config);
    const adaptiveStateBeforeStatus = adaptiveChargingRequested ? await dependencies.readAdaptiveChargingState() : null;
    const adaptiveChargingEnabled = adaptiveChargingRequested
      && (adaptiveChargingBaseAvailability(config).available || adaptiveStateBeforeStatus?.owner === "adaptiveCharging");
    context.enabledRules = [...enabledRules.map(automationRuleLabel), ...(adaptiveChargingEnabled ? ["Adaptive Charging"] : [])];
    if (!enabledRules.length && !adaptiveChargingEnabled) {
      if (adaptiveChargingRequested) {
        const state = await dependencies.evaluateAdaptiveCharging(config, {}, rules, startedAt);
        observeAdaptiveCharging(config, state);
      }
      context.phase = "complete; no enabled rules";
      return;
    }
    context.phase = `reading device status for ${automationRuleList(enabledRules)}`;
    const statusReadStartedAt = Date.now();
    const sequenceStart = dependencies.deviceTimings().at(-1)?.sequence ?? 0;
    const probeTimings: Array<{ label: string; durationMs: number }> = [];
    const status = evaluationStatus(await dependencies.getStatusSnapshot({
      maxAgeMs: Math.min(5_000, Math.max(0, Number(config.updateIntervalSeconds) * 1000 || 0)),
      onProbeComplete: (probe) => {
        probeTimings.push(probe);
        context.statusProbeCompletionLatency = probeTimings.map(({ label, durationMs }) => `${label}=${durationMs}ms`);
      },
    }));
    const statusReadDurationMs = Date.now() - statusReadStartedAt;
    if (statusReadDurationMs > dependencies.intervalMs) {
      const probes = dependencies.deviceTimings().filter(({ sequence }) => sequence > sequenceStart)
        .map(({ command, host, durationMs }) => `${command}${host ? ` on ${host}` : ""}=${durationMs}ms`).join(", ");
      dependencies.warn(`automation: device status read for ${automationRuleList(enabledRules)} took ${statusReadDurationMs}ms, longer than ${dependencies.intervalMs}ms interval; ECHONET operation durations: ${probes || "none"}`);
    }
    let changed = false;
    const coordinationState = adaptiveChargingEnabled ? await dependencies.readAdaptiveChargingState() : null;
    for (const rule of rules) {
      const now = new Date();
      const label = automationRuleLabel(rule);
      const ruleStartedAt = Date.now();
      let ruleChanged: boolean;
      try {
        if (backupPreparation.active && backupPreparation.allowDemandGuard === false && rule.enabled && rule.type === "backup-demand-guard") {
          const skipped = "Backup Preparation has Demand Guard intervention disabled";
          if (rule.lastResult?.skipped !== skipped) {
            rule.lastResult = { ok: true, at: now.toISOString(), skipped };
            rule.stateUpdatedAt = now.toISOString();
            changed = true;
          }
          continue;
        }
        const result = await dependencies.evaluateAutomationRule(rule, status, now, (phase) => {
          context.phase = `${phase} for ${label}`;
        }, config, {
          execute: (action, payload) => dependencies.executeAction(
            action,
            payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {},
            { source: "charging-demand-guard" },
          ),
          holdStandbyForAdaptiveCharging: adaptiveChargingEnabled
            && shouldHoldGuardStandbyForAdaptiveCharging(coordinationState, now),
        });
        const finishedAt = new Date();
        const checkMeta = {
          checkStartedAt: startedAt.toISOString(), checkFinishedAt: finishedAt.toISOString(),
          checkDurationMs: finishedAt.getTime() - startedAt.getTime(), ruleDurationMs: finishedAt.getTime() - ruleStartedAt,
        };
        ruleChanged = result.changed;
        if (result.result?.skipped) {
          rule.lastResult = { ok: true, at: now.toISOString(), ...result.result, ...checkMeta };
          ruleChanged = true;
        } else if (result.changed && rule.lastResult) rule.lastResult = { ...rule.lastResult, ...checkMeta };
      } catch (error: unknown) {
        const finishedAt = new Date();
        rule.lastResult = {
          ok: false, at: now.toISOString(), error: error instanceof Error ? error.message : String(error),
          checkStartedAt: startedAt.toISOString(), checkFinishedAt: finishedAt.toISOString(),
          checkDurationMs: finishedAt.getTime() - startedAt.getTime(), ruleDurationMs: finishedAt.getTime() - ruleStartedAt,
        };
        ruleChanged = true;
      }
      const durationMs = Date.now() - ruleStartedAt;
      if (durationMs > dependencies.intervalMs) dependencies.warn(`automation: rule ${label} took ${durationMs}ms, longer than ${dependencies.intervalMs}ms interval; last phase: ${context.phase}`);
      if (ruleChanged) {
        changed = true;
        rule.stateUpdatedAt = now.toISOString();
      }
    }
    if (changed) {
      context.phase = `persisting state for ${automationRuleList(enabledRules)}`;
      await dependencies.writeAutomationRuleStates(rules);
    }
    if (adaptiveChargingEnabled) {
      context.phase = "evaluating adaptive charging";
      const state = await dependencies.readAdaptiveChargingState();
      const forecastAge = startedAt.getTime() - new Date(state.forecast?.fetchedAt ?? 0).getTime();
      if (adaptiveChargingAvailability(config, rules).available
        && (!Number.isFinite(forecastAge) || forecastAge >= dependencies.forecastRefreshMs)) {
        context.phase = "refreshing Open-Meteo forecast";
        await dependencies.refreshAdaptiveChargingForecast(config, { now: startedAt });
      }
      observeAdaptiveCharging(config, await dependencies.evaluateAdaptiveCharging(config, status, rules, new Date()));
    }
    context.phase = "complete";
    const totalDurationMs = Date.now() - startedAt.getTime();
    if (totalDurationMs > dependencies.intervalMs) dependencies.warn(`automation: complete check for ${automationRuleList(enabledRules)} took ${totalDurationMs}ms, longer than ${dependencies.intervalMs}ms interval`);
  }

  return { run };
}
