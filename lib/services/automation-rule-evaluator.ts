import {
  appendAutomationLog,
  automationDemandLabel,
  automationDemandWatts,
  batteryChargingWatts,
  batteryOperationMode,
  formatWatts,
  cleanAutomationRule,
  shouldTriggerDemandGuard,
  type AutomationStatus,
} from "../domain/automation-rules.js";
import type { ApplicationConfig } from "../contracts/configuration.js";

type ExecuteAction = (action: string, payload?: unknown) => Promise<unknown>;
type AutomationRule = ReturnType<typeof cleanAutomationRule>;

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
    coordination: { execute?: ExecuteAction; holdStandbyForAdaptiveCharging?: boolean } = {},
  ) {
    onPhase("evaluating conditions");
    const execute = coordination.execute ?? defaultExecute;
    if (!rule.enabled) return { changed: false, result: { skipped: "disabled" } };
    if (rule.type !== "backup-demand-guard") return { changed: false, result: { skipped: "unknown rule type" } };

    const operationMode = batteryOperationMode(status);
    const demandW = automationDemandWatts(status, rule.conditions.source);
    if (!Number.isFinite(demandW)) return { changed: false, result: { skipped: "demand unavailable" } };
    const breakerLimitW = Math.max(0, (rule.conditions.breakerAmps - rule.conditions.reserveAmps) * rule.conditions.breakerVoltage);
    const batteryChargingW = batteryChargingWatts(status);
    const actualDemandWithChargingW = batteryChargingW !== null && Number.isFinite(batteryChargingW) ? demandW + batteryChargingW : null;
    const guardDemandW = rule.conditions.source === "gridImportW" ? demandW : actualDemandWithChargingW;
    const maximumChargeWatts = Number(config?.batteryCapabilities?.maximumChargeWatts);
    const maximumChargeWattsAvailable = Number.isFinite(maximumChargeWatts) && maximumChargeWatts > 0;
    const estimatedRestoredDemandW = maximumChargeWattsAvailable ? demandW + maximumChargeWatts : null;
    const restoreLimitW = rule.conditions.restoreBelowAmps * rule.conditions.breakerVoltage;
    const demandLabel = automationDemandLabel(rule.conditions.source);

    if (!rule.state?.awaitingRestore && shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW })) {
      onPhase("executing Standby guard action");
      const result = await execute(rule.action, rule.payload);
      appendAutomationLog(rule, `${demandLabel} (${formatWatts(guardDemandW)}) exceeds Charge Demand Guard limit (${formatWatts(breakerLimitW)}), setting operation mode from ${operationMode} to Standby`, now, "guard");
      await recordGuardTrigger(now);
      notify({ type: "guardActivated", severity: "warning", title: "Charging Demand Guard activated", message: `${demandLabel} (${formatWatts(guardDemandW)}) exceeded the guard limit (${formatWatts(breakerLimitW)}). Operation mode was changed from ${operationMode} to Standby.`, occurredAt: now.toISOString(), dedupeKey: "charging-demand-guard:active" });
      rule.state = { ...rule.state, awaitingRestore: true, restoreSince: null, previousMode: operationMode };
      rule.lastResult = { ok: true, at: now.toISOString(), kind: "guard", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, breakerLimitW, result };
      return { changed: true, result: rule.lastResult };
    }

    if (rule.state?.awaitingRestore && operationMode && String(operationMode).toLowerCase() !== "standby") {
      onPhase("reasserting Standby guard action");
      const result = await execute(rule.action, rule.payload);
      appendAutomationLog(rule, `Charging Demand Guard restore is pending; operation mode changed to ${operationMode}, returning it to Standby`, now, "maintain");
      rule.state = { ...rule.state, restoreSince: null };
      rule.lastResult = { ok: true, at: now.toISOString(), kind: "maintain", operationMode, demandW, breakerLimitW, result };
      return { changed: true, result: rule.lastResult };
    }

    if (rule.state?.awaitingRestore && demandW <= restoreLimitW) {
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
      if ((now.getTime() - restoreSince) / 1000 >= rule.conditions.restoreDelaySeconds) {
        if (coordination.holdStandbyForAdaptiveCharging === true) {
          return { changed: true, result: { skipped: "adaptiveCharging waiting to resume charging", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
        }
        onPhase("executing Auto restore action");
        const result = await execute(rule.restoreAction, rule.restorePayload);
        appendAutomationLog(rule, `${demandLabel} (${formatWatts(demandW)}) now below Guard restore limit (${formatWatts(restoreLimitW)}), setting operation mode to Auto`, now, "restore");
        notify({ type: "guardRestored", severity: "info", title: "Charging Demand Guard restored", message: `${demandLabel} (${formatWatts(demandW)}) remained below the restore limit (${formatWatts(restoreLimitW)}). Operation mode was returned to Auto.`, occurredAt: now.toISOString(), dedupeKey: "charging-demand-guard:restored" });
        rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
        rule.lastResult = { ok: true, at: now.toISOString(), kind: "restore", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW, result };
        return { changed: true, result: rule.lastResult };
      }
      return { changed: true, result: { skipped: "waiting for restore delay", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
    }

    if (rule.state?.awaitingRestore && demandW > restoreLimitW) {
      appendAutomationLog(rule, `${demandLabel} (${formatWatts(demandW)}) still exceeds Guard restore limit (${formatWatts(restoreLimitW)}), maintaining Standby operation mode`, now, "maintain");
      rule.state = { ...rule.state, restoreSince: null };
      return { changed: true, result: { skipped: "restore demand still high", demandW, restoreLimitW } };
    }
    return { changed: false, result: { skipped: "conditions not met", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, estimatedRestoredDemandW, breakerLimitW } };
  };
}
