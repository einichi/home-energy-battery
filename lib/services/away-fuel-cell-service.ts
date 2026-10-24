import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AwayPeriod } from "../contracts/away-period.js";
import type { HistorySample } from "../contracts/history.js";
import { activeAwayFuelCellEvidence, awayFuelCellDeviceKey } from "../domain/away-fuel-cell.js";
import { appendAdaptiveChargingLog, type AdaptiveChargingState } from "../domain/adaptive-state.js";
import { queueAdaptiveChargingPlanRefresh } from "../domain/adaptive-control.js";
import { awayPeriodContains } from "../domain/time.js";
import { sampleFromStatus } from "../domain/telemetry.js";
import type { AdaptiveEvaluationStatus } from "./automation-orchestrator.js";

/** Observe even while control is paused or a guard owns the battery. No device I/O. */
export async function observeAwayFuelCell(
  state: AdaptiveChargingState, config: ApplicationConfig, status: AdaptiveEvaluationStatus,
  periods: AwayPeriod[], now: Date, readHistory: (now: Date) => Promise<HistorySample[]>,
): Promise<void> {
  const previous = state.awayFuelCell;
  const enabled = awayFuelCellDeviceKey(config) !== null && periods.some((period) => awayPeriodContains(period, now.getTime()));
  const samples = enabled ? [...await readHistory(now)] : [];
  // Without a source timestamp, a cached live status cannot establish freshness.
  if (enabled && typeof status.read_at === "string") samples.push(sampleFromStatus(status, config));
  const evidence = activeAwayFuelCellEvidence(config, periods, samples, now, previous);
  state.awayFuelCell = evidence;
  const identity = (value: typeof evidence) => value
    ? [value.periodId, value.from, value.deviceKey, value.regime, value.reason].join(":") : "none";
  if (identity(evidence) !== identity(previous)) {
    const reason = evidence
      ? `Away Ene-Farm forecast: ${evidence.regime} (${evidence.reason})`
      : "Away Ene-Farm forecast returned to baseline";
    queueAdaptiveChargingPlanRefresh(state, reason, now);
    appendAdaptiveChargingLog(state, reason, "forecast", now);
  }
}
