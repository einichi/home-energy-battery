import type { AutomationRule } from "../domain/automation-rules.js";
import { appendAutomationLog } from "../domain/automation-rules.js";
import type { OperationalOverridesState } from "../domain/operational-overrides.js";

export interface DemandGuardServiceDependencies {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readAutomationRules(): Promise<AutomationRule[]>;
  writeAutomationRuleStates(rules: AutomationRule[]): Promise<unknown>;
  readOperationalOverridesState(): Promise<OperationalOverridesState>;
  executeAction(action: string, payload: Record<string, unknown>, options: { source: string }): Promise<unknown>;
  notify(event: Record<string, unknown>): unknown;
  requestError(status: number, message: string): Error;
}

const MANUAL_RESTORE_LOG = "Charging Demand Guard restored manually; setting operation mode to Auto without waiting for the restore threshold or delay";

export function createDemandGuardService(dependencies: DemandGuardServiceDependencies) {
  async function restore(now: Date = new Date()): Promise<AutomationRule[]> {
    return dependencies.exclusive(async () => {
      const rules = await dependencies.readAutomationRules();
      const pending = rules.filter((rule) => rule.type === "backup-demand-guard" && rule.state.awaitingRestore === true);
      if (pending.length === 0) {
        throw dependencies.requestError(409, "Charging Demand Guard is not awaiting restore");
      }
      const overrides = await dependencies.readOperationalOverridesState();
      if (overrides.backupPreparation.active && overrides.backupPreparation.allowDemandGuard === false) {
        throw dependencies.requestError(409, "Backup Preparation has Demand Guard intervention disabled");
      }
      const result = await dependencies.executeAction(
        "set-mode",
        { mode: "auto" },
        { source: "charging-demand-guard" },
      );
      const at = now.toISOString();
      for (const rule of pending) {
        rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
        rule.stateUpdatedAt = at;
        rule.lastResult = { ok: true, at, kind: "restore", manual: true, result };
        appendAutomationLog(rule, MANUAL_RESTORE_LOG, now, "restore");
      }
      await dependencies.writeAutomationRuleStates(rules);
      await dependencies.notify({
        type: "guardRestored",
        severity: "info",
        title: "Charging Demand Guard restored manually",
        message: "Operation mode was returned to Auto manually. Demand Guard settings are unchanged and protection may intervene again.",
        occurredAt: at,
        dedupeKey: "charging-demand-guard:restored",
      });
      return rules;
    });
  }

  return { restore };
}
