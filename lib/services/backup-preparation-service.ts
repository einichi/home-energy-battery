import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import { appendAdaptiveChargingLog } from "../domain/adaptive-state.js";
import type { AutomationRule } from "../domain/automation-rules.js";
import { appendAutomationLog } from "../domain/automation-rules.js";
import type { BatteryProfile, OperationalOverridesState } from "../domain/operational-overrides.js";
import {
  BATTERY_PROFILES,
  appendBackupPreparationLog,
  backupPreparationBlocksActions,
  backupPreparationView,
} from "../domain/operational-overrides.js";
import { queueAdaptiveChargingPlanRefresh } from "../domain/adaptive-control.js";
import { isDocumentationHost } from "../domain/status-alerts.js";

type ExecuteAction = (
  action: string,
  payload: Record<string, unknown>,
  options: { source: string },
) => Promise<unknown>;

export interface BackupPreparationDependencies {
  readConfig(): Promise<ApplicationConfig>;
  readAdaptiveChargingState(): Promise<AdaptiveChargingState>;
  writeAdaptiveChargingState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  readAutomationRules(): Promise<AutomationRule[]>;
  writeAutomationRuleStates(rules: AutomationRule[]): Promise<unknown>;
  readOperationalOverridesState(): Promise<OperationalOverridesState>;
  writeOperationalOverridesState(state: OperationalOverridesState): Promise<OperationalOverridesState>;
  withOperationalOverrideMutation<T>(mutation: () => Promise<T>): Promise<T>;
  runDeviceCommandQueued(action: string, payload: Record<string, unknown>): Promise<unknown>;
  executeAction: ExecuteAction;
  releaseAdaptiveCharge(
    state: AdaptiveChargingState,
    reason: string,
    now: Date,
    slot: null,
    execute: (action: string, payload?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown>;
  invalidateStatus(): void;
  requestError(status: number, message: string): Error;
  logError(label: string, error: unknown): void;
  sleep(milliseconds: number): Promise<void>;
  verifyAttempts: number;
  verifyDelayMs: number;
}

export function createBackupPreparationService(dependencies: BackupPreparationDependencies) {
  async function readBatteryChargingProfile(host: string): Promise<BatteryProfile> {
    const value = await dependencies.runDeviceCommandQueued("vendor-profile", { host });
    const result = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const decoded = result.decoded !== null && typeof result.decoded === "object"
      ? result.decoded as Record<string, unknown>
      : {};
    const profile = decoded.mode ?? result.mode;
    if (typeof profile !== "string" || !BATTERY_PROFILES.has(profile)) {
      throw new Error(`Unable to verify battery charging profile${result.error ? `: ${result.error}` : ""}`);
    }
    return profile as BatteryProfile;
  }

  async function setAndVerifyBatteryChargingProfile(profile: BatteryProfile, host: string) {
    if (!BATTERY_PROFILES.has(profile)) throw new Error(`Unsupported battery charging profile: ${profile}`);
    const result = await dependencies.executeAction(
      "vendor-profile",
      { mode: profile, host },
      { source: "backup-preparation" },
    );
    let observed: BatteryProfile | null = null;
    for (let attempt = 0; attempt < dependencies.verifyAttempts; attempt += 1) {
      if (attempt > 0) await dependencies.sleep(dependencies.verifyDelayMs);
      try {
        observed = await readBatteryChargingProfile(host);
        if (observed === profile) return { result, profile: observed };
      } catch (error: unknown) {
        if (attempt === dependencies.verifyAttempts - 1) throw error;
      }
    }
    throw new Error(`Battery charging profile verification failed: expected ${profile}, observed ${observed ?? "unavailable"}`);
  }

  async function prepareAdaptiveCharging(now: Date): Promise<AdaptiveChargingState> {
    const state = await dependencies.readAdaptiveChargingState();
    const guardActive = (await dependencies.readAutomationRules()).some(
      (rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
    );
    const execute = (action: string, payload: Record<string, unknown> = {}) =>
      dependencies.executeAction(action, payload, { source: "backup-preparation" });
    if (state.owner === "adaptiveCharging") {
      await dependencies.releaseAdaptiveCharge(state, "Backup Preparation activated", now, null, execute);
    } else if (state.standbyHoldUntil && !guardActive) {
      await execute("set-mode", { mode: "auto" });
      appendAdaptiveChargingLog(state, "Backup Preparation activated; releasing Adaptive Charging Standby hold", "stop", now);
    }
    state.owner = null;
    state.activeSlot = null;
    state.activePlanCreatedAt = null;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = null;
    state.activeChargeSession = null;
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.standbyHoldUntil = null;
    state.lastPlanEventKey = null;
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "Backup Preparation active" };
    appendAdaptiveChargingLog(state, "Backup Preparation activated; battery control is suspended until the override is ended", "pause", now);
    return dependencies.writeAdaptiveChargingState(state);
  }

  async function releaseDemandGuard(now: Date): Promise<boolean> {
    const rules = await dependencies.readAutomationRules();
    let changed = false;
    for (const rule of rules) {
      if (rule.type !== "backup-demand-guard" || !rule.state?.awaitingRestore) continue;
      rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
      rule.lastResult = { ok: true, at: now.toISOString(), skipped: "Released because Backup Preparation disabled Demand Guard intervention" };
      rule.stateUpdatedAt = now.toISOString();
      appendAutomationLog(rule, "Backup Preparation disabled Charging Demand Guard intervention; releasing Standby ownership", now, "release");
      changed = true;
    }
    if (changed) {
      await dependencies.writeAutomationRuleStates(rules);
      await dependencies.executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
    }
    return changed;
  }

  async function queueAdaptiveCharging(now: Date): Promise<AdaptiveChargingState> {
    const state = await dependencies.readAdaptiveChargingState();
    state.plan = null;
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.standbyHoldUntil = null;
    state.lastPlanEventKey = null;
    queueAdaptiveChargingPlanRefresh(state, "Backup Preparation ended", now);
    appendAdaptiveChargingLog(state, "Backup Preparation ended; Adaptive Charging will recalculate before resuming control", "resume", now);
    return dependencies.writeAdaptiveChargingState(state);
  }

  async function start({ allowDemandGuard = true }: { allowDemandGuard?: boolean } = {}, now: Date = new Date()) {
    return dependencies.withOperationalOverrideMutation(async () => {
      let state = await dependencies.readOperationalOverridesState();
      if (backupPreparationBlocksActions(state)) return backupPreparationView(state);
      const config = await dependencies.readConfig();
      if (!config.batteryHost || isDocumentationHost(config.batteryHost)) {
        throw dependencies.requestError(409, "A battery address must be configured before Backup Preparation can start");
      }
      const previousProfile = await readBatteryChargingProfile(config.batteryHost);
      state.backupPreparation = {
        active: true, phase: "starting", allowDemandGuard: allowDemandGuard !== false,
        previousProfile, currentProfile: previousProfile, startedAt: now.toISOString(), endedAt: null,
        updatedAt: now.toISOString(), lastResult: null,
      };
      appendBackupPreparationLog(state, `Starting Backup Preparation from ${previousProfile} profile`, "start", now);
      state = await dependencies.writeOperationalOverridesState(state);
      try {
        if (!state.backupPreparation.allowDemandGuard) await releaseDemandGuard(now);
        await prepareAdaptiveCharging(now);
        const profileResult = await setAndVerifyBatteryChargingProfile("backup", config.batteryHost);
        const guardActive = state.backupPreparation.allowDemandGuard && (await dependencies.readAutomationRules()).some(
          (rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
        );
        if (!guardActive) await dependencies.executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
        const completedAt = new Date();
        state.backupPreparation = {
          ...state.backupPreparation, active: true, phase: "active", currentProfile: profileResult.profile,
          updatedAt: completedAt.toISOString(), lastResult: { ok: true, at: completedAt.toISOString() },
        };
        appendBackupPreparationLog(
          state,
          `Backup Preparation active; backup profile verified${state.backupPreparation.allowDemandGuard ? "; Charging Demand Guard remains enabled" : "; Charging Demand Guard intervention is disabled"}`,
          "active", completedAt,
        );
        dependencies.invalidateStatus();
        return backupPreparationView(await dependencies.writeOperationalOverridesState(state));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error : new Error(String(error));
        const failedAt = new Date();
        try {
          if (previousProfile !== "backup") await setAndVerifyBatteryChargingProfile(previousProfile, config.batteryHost);
        } catch (restoreError: unknown) {
          const restoreDetail = restoreError instanceof Error ? restoreError : new Error(String(restoreError));
          detail.message = `${detail.message}; failed to restore ${previousProfile} profile: ${restoreDetail.message}`;
        }
        state.backupPreparation = {
          ...state.backupPreparation, active: false, phase: "inactive", currentProfile: previousProfile,
          endedAt: failedAt.toISOString(), updatedAt: failedAt.toISOString(),
          lastResult: { ok: false, at: failedAt.toISOString(), error: detail.message },
        };
        appendBackupPreparationLog(state, `Backup Preparation failed: ${detail.message}`, "error", failedAt);
        await dependencies.writeOperationalOverridesState(state);
        await queueAdaptiveCharging(failedAt).catch((resumeError: unknown) => dependencies.logError("backup-preparation-resume-after-failure", resumeError));
        throw detail;
      }
    });
  }

  async function end(now: Date = new Date()) {
    return dependencies.withOperationalOverrideMutation(async () => {
      let state = await dependencies.readOperationalOverridesState();
      if (!backupPreparationBlocksActions(state)) return backupPreparationView(state);
      const config = await dependencies.readConfig();
      const previousProfile = state.backupPreparation.previousProfile;
      state.backupPreparation.phase = "ending";
      state.backupPreparation.updatedAt = now.toISOString();
      appendBackupPreparationLog(state, "Ending Backup Preparation", "stop", now);
      state = await dependencies.writeOperationalOverridesState(state);
      try {
        let currentProfile: BatteryProfile = "backup";
        if (previousProfile) currentProfile = (await setAndVerifyBatteryChargingProfile(previousProfile, config.batteryHost)).profile;
        const guardActive = (await dependencies.readAutomationRules()).some(
          (rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
        );
        if (!guardActive) await dependencies.executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
        await queueAdaptiveCharging(now);
        const completedAt = new Date();
        state.backupPreparation = {
          ...state.backupPreparation, active: false, phase: "inactive", currentProfile,
          endedAt: completedAt.toISOString(), updatedAt: completedAt.toISOString(),
          lastResult: { ok: true, at: completedAt.toISOString(), guardRetainedStandby: guardActive },
        };
        appendBackupPreparationLog(
          state,
          guardActive
            ? `Backup Preparation ended; restored ${currentProfile} profile and left Standby under Charging Demand Guard control`
            : `Backup Preparation ended; restored ${currentProfile} profile and Auto operation mode`,
          "complete", completedAt,
        );
        dependencies.invalidateStatus();
        return backupPreparationView(await dependencies.writeOperationalOverridesState(state));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error : new Error(String(error));
        const failedAt = new Date();
        let currentProfile = state.backupPreparation.currentProfile;
        try {
          currentProfile = (await setAndVerifyBatteryChargingProfile("backup", config.batteryHost)).profile;
        } catch (preserveError: unknown) {
          const preserveDetail = preserveError instanceof Error ? preserveError : new Error(String(preserveError));
          detail.message = `${detail.message}; could not reassert backup profile: ${preserveDetail.message}`;
        }
        state.backupPreparation = {
          ...state.backupPreparation, active: true, phase: "active", currentProfile,
          updatedAt: failedAt.toISOString(), lastResult: { ok: false, at: failedAt.toISOString(), error: detail.message },
        };
        appendBackupPreparationLog(state, `Could not end Backup Preparation safely: ${detail.message}; override remains active`, "error", failedAt);
        await dependencies.writeOperationalOverridesState(state);
        throw detail;
      }
    });
  }

  async function reconcileOnStartup(now: Date = new Date()) {
    return dependencies.withOperationalOverrideMutation(async () => {
      const state = await dependencies.readOperationalOverridesState();
      if (!backupPreparationBlocksActions(state)) return backupPreparationView(state);
      const config = await dependencies.readConfig();
      try {
        if (!state.backupPreparation.allowDemandGuard) await releaseDemandGuard(now);
        await prepareAdaptiveCharging(now);
        const profile = (await setAndVerifyBatteryChargingProfile("backup", config.batteryHost)).profile;
        const completedAt = new Date();
        state.backupPreparation = {
          ...state.backupPreparation, active: true, phase: "active", currentProfile: profile,
          updatedAt: completedAt.toISOString(), lastResult: { ok: true, at: completedAt.toISOString(), recoveredAtStartup: true },
        };
        appendBackupPreparationLog(state, "Server restarted during Backup Preparation; backup profile was reverified before automation resumed", "active", completedAt);
        dependencies.invalidateStatus();
        return backupPreparationView(await dependencies.writeOperationalOverridesState(state));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error : new Error(String(error));
        const failedAt = new Date();
        state.backupPreparation = {
          ...state.backupPreparation, active: true, phase: "active", updatedAt: failedAt.toISOString(),
          lastResult: { ok: false, at: failedAt.toISOString(), error: detail.message },
        };
        appendBackupPreparationLog(state, `Could not reverify Backup Preparation after restart: ${detail.message}; battery actions remain blocked`, "error", failedAt);
        await dependencies.writeOperationalOverridesState(state);
        return backupPreparationView(state);
      }
    });
  }

  return { end, reconcileOnStartup, start };
}
