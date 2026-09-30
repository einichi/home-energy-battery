import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AdaptiveChargingState } from "../domain/adaptive-state.js";
import { appendAdaptiveChargingLog, finalizeAdaptiveChargingWindowExecution } from "../domain/adaptive-state.js";
import { adaptiveChargingConfiguredActive, queueAdaptiveChargingPlanRefresh } from "../domain/adaptive-control.js";
import { backupPreparationBlocksActions, type OperationalOverridesState } from "../domain/operational-overrides.js";

export interface ConfigurationCommitDependencies {
  normalize(config: ApplicationConfig): ApplicationConfig;
  ensureDataDirectory(): Promise<void>;
  readAdaptiveState(): Promise<AdaptiveChargingState>;
  writeAdaptiveState(state: AdaptiveChargingState): Promise<AdaptiveChargingState>;
  readOperationalOverrides(): Promise<OperationalOverridesState>;
  releaseAdaptiveCharge(state: AdaptiveChargingState, reason: string, now: Date, host?: string | null): Promise<unknown>;
  executeAction(action: string, payload: Record<string, unknown>): Promise<unknown>;
  writeConfigDocument(config: ApplicationConfig): unknown;
  clearStatusHistory(): void;
  invalidateStatus(): void;
}

export function createConfigurationCommitService(dependencies: ConfigurationCommitDependencies) {
  return async function commit(previous: ApplicationConfig, config: ApplicationConfig): Promise<ApplicationConfig> {
    const cleaned = dependencies.normalize(config);
    await dependencies.ensureDataDirectory();
    const hostKeys: (keyof ApplicationConfig)[] = ["batteryHost", "meterHost", "meterEoj", "solarHost"];
    const hostChanged = hostKeys.some((key) => previous[key] !== cleaned[key])
      || JSON.stringify(previous.fuelCellHosts) !== JSON.stringify(cleaned.fuelCellHosts);
    const adaptiveChargingInputsChanged = JSON.stringify({
      batteryHost: previous.batteryHost,
      meterHost: previous.meterHost,
      meterEoj: previous.meterEoj,
      solarHost: previous.solarHost,
      solarEnabled: previous.solarEnabled,
      smartCosmoEnabled: previous.smartCosmoEnabled,
      rateMode: previous.rateMode,
      rateBands: previous.rateBands,
      standardRateYenPerKwh: previous.standardRateYenPerKwh,
      batteryCapabilities: previous.batteryCapabilities,
      adaptiveCharging: previous.adaptiveCharging,
      fuelCellEnabled: previous.fuelCellEnabled,
      fuelCellForecastInfluence: previous.fuelCell?.includeInAdaptiveCharging,
    }) !== JSON.stringify({
      batteryHost: cleaned.batteryHost,
      meterHost: cleaned.meterHost,
      meterEoj: cleaned.meterEoj,
      solarHost: cleaned.solarHost,
      solarEnabled: cleaned.solarEnabled,
      smartCosmoEnabled: cleaned.smartCosmoEnabled,
      rateMode: cleaned.rateMode,
      rateBands: cleaned.rateBands,
      standardRateYenPerKwh: cleaned.standardRateYenPerKwh,
      batteryCapabilities: cleaned.batteryCapabilities,
      adaptiveCharging: cleaned.adaptiveCharging,
      fuelCellEnabled: cleaned.fuelCellEnabled,
      fuelCellForecastInfluence: cleaned.fuelCell?.includeInAdaptiveCharging,
    });
    if (adaptiveChargingInputsChanged) {
      const state = await dependencies.readAdaptiveState();
      const backupPreparationActive = backupPreparationBlocksActions(await dependencies.readOperationalOverrides());
      const changedAt = new Date();
      state.plan = null;
      state.interruptedCharge = null;
      state.breakerRecovery = null;
      state.lastPlanEventKey = null;
      queueAdaptiveChargingPlanRefresh(state, "configuration changed", changedAt);
      const forecastInputsChanged = JSON.stringify({
        latitude: previous.adaptiveCharging.latitude,
        longitude: previous.adaptiveCharging.longitude,
        tilt: previous.adaptiveCharging.panelTiltDegrees,
        azimuth: previous.adaptiveCharging.panelAzimuthDegrees,
      }) !== JSON.stringify({
        latitude: cleaned.adaptiveCharging.latitude,
        longitude: cleaned.adaptiveCharging.longitude,
        tilt: cleaned.adaptiveCharging.panelTiltDegrees,
        azimuth: cleaned.adaptiveCharging.panelAzimuthDegrees,
      });
      if (forecastInputsChanged) {
        state.forecast = null;
        state.historicalWeatherFetchedAt = null;
      }
      if (backupPreparationActive) {
        state.owner = null;
        state.activeSlot = null;
        state.activePlanCreatedAt = null;
        state.activeChargedKwh = 0;
        state.activeLastCheckedAt = null;
        state.activeChargeSession = null;
        state.interruptedCharge = null;
        state.breakerRecovery = null;
        state.standbyHoldUntil = null;
        appendAdaptiveChargingLog(state, "Adaptive Charging configuration changed while Backup Preparation retained battery control", "pause", changedAt);
      } else if (state.owner === "adaptiveCharging") {
        const reason = adaptiveChargingConfiguredActive(cleaned)
          ? "Adaptive Charging configuration changed"
          : "Adaptive Charging was disabled";
        await dependencies.releaseAdaptiveCharge(state, reason, changedAt, previous.batteryHost);
      } else if (state.standbyHoldUntil) {
        await dependencies.executeAction("set-mode", { mode: "auto", host: previous.batteryHost });
        appendAdaptiveChargingLog(state, "Adaptive Charging configuration changed; releasing Standby hold and restoring operation mode to Auto", "stop", changedAt);
        state.standbyHoldUntil = null;
      }
      if (state.activeWindowExecution) {
        finalizeAdaptiveChargingWindowExecution(state, state.activeWindowExecution.latestSocPercent, changedAt, "adaptive charging configuration changed");
      }
      await dependencies.writeAdaptiveState(state);
    }
    dependencies.writeConfigDocument(cleaned);
    if (hostChanged) {
      dependencies.clearStatusHistory();
      dependencies.invalidateStatus();
    }
    return cleaned;
  };
}
