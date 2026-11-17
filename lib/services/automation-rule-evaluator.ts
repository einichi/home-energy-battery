import {
  appendAutomationLog,
  automationDemandLabel,
  automationDemandWatts,
  batteryChargingWatts,
  batteryOperationMode,
  formatWatts,
  cleanAutomationRule,
  MIN_DEMAND_RECOVERY_SECONDS,
  shouldTriggerDemandGuard,
  type AutomationStatus,
} from "../domain/automation-rules.js";
import type { ApplicationConfig } from "../contracts/configuration.js";

type ExecuteAction = (action: string, payload?: unknown) => Promise<unknown>;
type AutomationRule = ReturnType<typeof cleanAutomationRule>;

export interface AutomationRuleCoordination {
  execute?: ExecuteAction;
  holdStandbyForAdaptiveCharging?: boolean;
  adaptiveChargingEnabled?: boolean;
  adaptiveChargeActive?: boolean;
}

export interface AutomationRuleEvaluatorDependencies {
  execute: ExecuteAction;
  recordGuardTrigger(at: Date): Promise<unknown>;
  notify(notification: Record<string, unknown>): unknown;
}

export function createAutomationRuleEvaluator({
  execute: defaultExecute,
  recordGuardTrigger,
  notify,
}: AutomationRuleEvaluatorDependencies) {
  return async function evaluateAutomationRule(
    rule: AutomationRule,
    status: AutomationStatus,
    now: Date = new Date(),
    onPhase: (phase: string) => void = () => undefined,
    config: Partial<Pick<ApplicationConfig, "batteryCapabilities">> | null = null,
    coordination: AutomationRuleCoordination = {},
  ): Promise<{ changed: boolean; result: Record<string, unknown> }> {
    onPhase("evaluating conditions");
    const execute = coordination.execute ?? defaultExecute;
    if (!rule.enabled) return { changed: false, result: { skipped: "disabled" } };
    if (rule.type !== "backup-demand-guard") return { changed: false, result: { skipped: "unknown rule type" } };

    const operationMode = batteryOperationMode(status);
    const mode = operationMode?.toLowerCase();
    const awaitingRestore = rule.state.awaitingRestore === true;
    const demandW = automationDemandWatts(status, rule.conditions.source);
    const breakerLimitW = Math.max(0, (rule.conditions.breakerAmps - rule.conditions.reserveAmps) * rule.conditions.breakerVoltage);
    const batteryChargingW = batteryChargingWatts(status);
    const charging = mode === "charging" || (batteryChargingW ?? 0) > 0;
    const chargingKnown = charging || mode === "standby" || mode === "discharging" || (Boolean(mode) && batteryChargingW !== null);
    const lastKnownCharging = rule.state.lastKnownCharging === true;
    const chargingStateChanged = chargingKnown && charging !== lastKnownCharging;
    if (chargingStateChanged) rule.state.lastKnownCharging = charging;
    const otherDemandSource = rule.conditions.source === "gridImportW" ? "branchDemandW" : "gridImportW";
    const missingDemandSource = !Number.isFinite(demandW) ? rule.conditions.source
      : coordination.adaptiveChargingEnabled && !Number.isFinite(automationDemandWatts(status, otherDemandSource)) ? otherDemandSource
        : null;
    const demandUnavailable = missingDemandSource !== null;
    const demandRecoveryRequired = awaitingRestore && demandUnavailable && rule.state.minimumRestoreDelaySeconds !== MIN_DEMAND_RECOVERY_SECONDS;
    if (demandRecoveryRequired) rule.state.minimumRestoreDelaySeconds = MIN_DEMAND_RECOVERY_SECONDS;
    const actualDemandWithChargingW = Number.isFinite(demandW) && batteryChargingW !== null ? demandW + batteryChargingW : null;
    const guardDemandW = rule.conditions.source === "gridImportW" ? demandW : actualDemandWithChargingW;
    const maximumChargeWatts = Number(config?.batteryCapabilities?.maximumChargeWatts);
    const maximumChargeWattsAvailable = Number.isFinite(maximumChargeWatts) && maximumChargeWatts > 0;
    const estimatedRestoredDemandW = maximumChargeWattsAvailable ? demandW + maximumChargeWatts : null;
    const restoreLimitW = rule.conditions.restoreBelowAmps * rule.conditions.breakerVoltage;
    const demandLabel = automationDemandLabel(rule.conditions.source);

    const overload = Number.isFinite(demandW) && shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW });
    const telemetryPause = !overload && mode !== "standby" && demandUnavailable
      && (charging || (!chargingKnown && lastKnownCharging) || coordination.adaptiveChargeActive);
    if (!awaitingRestore && (telemetryPause || overload)) {
      onPhase("executing Standby guard action");
      const trigger = telemetryPause ? "demand-unavailable" : "guard";
      const reason = telemetryPause && missingDemandSource
        ? `${automationDemandLabel(missingDemandSource)} unavailable`
        : `${demandLabel} (${formatWatts(guardDemandW)}) exceeds Charge Demand Guard limit (${formatWatts(breakerLimitW)})`;
      rule.state = {
        ...rule.state, awaitingRestore: true, restoreSince: null, previousMode: operationMode, trigger,
        minimumRestoreDelaySeconds: demandUnavailable ? MIN_DEMAND_RECOVERY_SECONDS : 0,
        standbyUnconfirmed: true,
      };
      if (telemetryPause) appendAutomationLog(rule, `${reason}; requesting Standby to pause charging`, now, trigger);
      const result = await execute(rule.action, rule.payload);
      rule.state.standbyUnconfirmed = false;
      rule.state.lastKnownCharging = false;
      appendAutomationLog(rule, `${reason}; operation mode was set to Standby`, now, trigger);
      if (overload) {
        await recordGuardTrigger(now);
        notify({ type: "guardActivated", severity: "warning", title: "Charging Demand Guard activated", message: `${reason}. Operation mode was set to Standby.`, occurredAt: now.toISOString(), dedupeKey: "charging-demand-guard:active" });
      }
      rule.lastResult = { ok: true, at: now.toISOString(), kind: trigger, operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, breakerLimitW, result };
      return { changed: true, result: rule.lastResult };
    }

    if (awaitingRestore && mode !== "standby" && (mode || rule.state.standbyUnconfirmed)) {
      onPhase("reasserting Standby guard action");
      rule.state = { ...rule.state, restoreSince: null, standbyUnconfirmed: true };
      const result = await execute(rule.action, rule.payload);
      appendAutomationLog(rule, operationMode
        ? `Charging Demand Guard restore is pending; operation mode changed to ${operationMode}, returning it to Standby`
        : "Charging Demand Guard confirmed Standby after retrying the battery command", now, "maintain");
      rule.state.standbyUnconfirmed = false;
      rule.state.lastKnownCharging = false;
      rule.lastResult = { ok: true, at: now.toISOString(), kind: "maintain", operationMode, demandW, breakerLimitW, result };
      return { changed: true, result: rule.lastResult };
    }

    const standbyConfirmed = awaitingRestore && mode === "standby" && rule.state.standbyUnconfirmed === true;
    if (standbyConfirmed) rule.state.standbyUnconfirmed = false;
    if (demandUnavailable || (awaitingRestore && !mode)) {
      const resetRestoreTimer = Boolean(rule.state.restoreSince);
      rule.state.restoreSince = null;
      return {
        changed: chargingStateChanged || standbyConfirmed || resetRestoreTimer || demandRecoveryRequired,
        result: { skipped: demandUnavailable ? "demand unavailable" : "Standby status unavailable" },
      };
    }

    if (awaitingRestore && demandW <= restoreLimitW) {
      if (!maximumChargeWattsAvailable) {
        const changed = Boolean(rule.state.restoreSince);
        rule.state = { ...rule.state, restoreSince: null };
        return { changed, result: { skipped: "maximum battery charge watts unavailable; remaining in Standby", demandW, breakerLimitW } };
      }
      if (estimatedRestoredDemandW !== null && estimatedRestoredDemandW > breakerLimitW) {
        rule.state = { ...rule.state, restoreSince: null };
        return { changed: true, result: { skipped: "restore would exceed breaker reserve", demandW, estimatedRestoredDemandW, breakerLimitW } };
      }
      const restoreSince = rule.state.restoreSince ? new Date(String(rule.state.restoreSince)).getTime() : now.getTime();
      rule.state.restoreSince = new Date(restoreSince).toISOString();
      const restoreDelaySeconds = Math.max(rule.conditions.restoreDelaySeconds, Number(rule.state.minimumRestoreDelaySeconds) || 0);
      if ((now.getTime() - restoreSince) / 1000 >= restoreDelaySeconds) {
        if (coordination.holdStandbyForAdaptiveCharging === true) {
          return { changed: true, result: { skipped: "adaptiveCharging waiting to resume charging", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
        }
        onPhase("executing Auto restore action");
        const result = await execute(rule.restoreAction, rule.restorePayload);
        appendAutomationLog(rule, `${demandLabel} (${formatWatts(demandW)}) now below Guard restore limit (${formatWatts(restoreLimitW)}), setting operation mode to Auto`, now, "restore");
        if (rule.state.trigger !== "demand-unavailable") {
          notify({ type: "guardRestored", severity: "info", title: "Charging Demand Guard restored", message: `${demandLabel} (${formatWatts(demandW)}) remained below the restore limit (${formatWatts(restoreLimitW)}). Operation mode was returned to Auto.`, occurredAt: now.toISOString(), dedupeKey: "charging-demand-guard:restored" });
        }
        rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null, standbyUnconfirmed: false, trigger: null, minimumRestoreDelaySeconds: 0 };
        rule.lastResult = { ok: true, at: now.toISOString(), kind: "restore", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW, result };
        return { changed: true, result: rule.lastResult };
      }
      return { changed: true, result: { skipped: "waiting for restore delay", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
    }

    if (awaitingRestore && demandW > restoreLimitW) {
      appendAutomationLog(rule, `${demandLabel} (${formatWatts(demandW)}) still exceeds Guard restore limit (${formatWatts(restoreLimitW)}), maintaining Standby operation mode`, now, "maintain");
      rule.state = { ...rule.state, restoreSince: null };
      return { changed: true, result: { skipped: "restore demand still high", demandW, restoreLimitW } };
    }
    return { changed: chargingStateChanged, result: { skipped: "conditions not met", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, estimatedRestoredDemandW, breakerLimitW } };
  };
}
