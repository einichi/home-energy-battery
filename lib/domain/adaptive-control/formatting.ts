import { PlanLike } from "./shared.js";
import { BATTERY_LEARNING_MODEL_VERSION } from "../battery-learning.js";
import type { WindowSummary } from "../adaptive-state.js";

export function adaptiveChargingClock(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function adaptiveChargingPlanLogMessage(plan: PlanLike | null | undefined, trigger: unknown, liveSoc: unknown): string {
  if (!plan?.available) return `Plan recalculated (${trigger}); adaptiveCharging unavailable: ${plan?.reason || "unknown reason"}`;
  const targets = (plan.windows ?? [])
    .map((window) => `${String((window as Record<string, unknown>).label ?? "")} ${Number(window.targetSocPercent).toFixed(0)}%/${Number(window.plannedChargeKwh).toFixed(2)} kWh`)
    .join(", ") || "none";
  const slots = (plan.slots ?? [])
    .map((slot) => `${adaptiveChargingClock(String(slot.start ?? ""))}-${adaptiveChargingClock(String(slot.end ?? ""))} ${slot.targetWh} Wh`)
    .join(", ") || "none";
  const timing = (plan.windows ?? [])
    .filter((window) => Number(window.plannedChargeKwh) > 0
      && Number.isFinite(Number(window.schedulingWatts))
      && Number.isFinite(Number(window.timingReserveMs)))
    .map((window) => {
      const details = window as Record<string, unknown>;
      const guard = details.guardDeliverability && typeof details.guardDeliverability === "object"
        ? details.guardDeliverability as Record<string, unknown>
        : null;
      const guardSummary = guard?.learned === true
        ? `/guard ${Math.round(Number(guard.deliveryFactor) * 100)}% reliable from ${Number(guard.sampleCount)} windows, ${Math.round(Number(guard.interruptionReserveMs) / 60_000)} min observed recovery reserve`
        : "";
      return `${String(details.label ?? "")} ${Math.round(Number(details.schedulingWatts))} W/${Math.round(Number(details.timingReserveMs) / 60_000)} min reserve/${String(details.schedulingSource ?? "")}${guardSummary}`;
    })
    .join(", ");
  const timingSummary = timing ? `; timing [${timing}]` : "";
  const demandHistory = plan.demandHistory;
  const awaySummary = Number(demandHistory?.awaySlotCount) > 0
    ? `; away demand ${demandHistory?.awayConfidence} (${demandHistory?.awayComparableDayCount} comparable days, ${demandHistory?.awayFallbackSlotCount} fallback slots)`
    : "";
  const model = plan.batteryModel ?? {};
  const batteryModelSummary = Number.isFinite(Number(model.charge?.whPerSocPoint))
    ? `; battery model v${model.version ?? BATTERY_LEARNING_MODEL_VERSION} [charge ${Number(model.charge?.whPerSocPoint).toFixed(1)} Wh/SOC (${model.charge?.source}), discharge ${Number(model.discharge?.whPerSocPoint).toFixed(1)} Wh/SOC (${model.discharge?.source}), power ${Math.round(Number(model.power?.effectiveWatts))} W (${model.power?.source})]`
    : "";
  const fuelCell = plan.fuelCellModel;
  const fuelCellSummary = fuelCell
    ? `; Ene-Farm ${Number(plan.predictedFuelCellKwh ?? 0).toFixed(2)} kWh median (${fuelCell.method}, ${fuelCell.influence}${fuelCell.blockers?.length ? `; ${fuelCell.blockers.join(", ")}` : ""})`
    : "";
  return `Plan recalculated (${trigger}): SOC ${Number(liveSoc).toFixed(0)}%; ${Number(plan.predictedSolarKwh).toFixed(2)} kWh solar, ${Number(plan.predictedDemandKwh).toFixed(2)} kWh demand, ${Number(plan.plannedChargeKwh).toFixed(2)} kWh discounted charging; targets [${targets}]; slots [${slots}]${timingSummary}${awaySummary}${fuelCellSummary}${batteryModelSummary}${plan.warning ? `; ${plan.warning}` : ""}`;
}

export function adaptiveChargingWindowHasShortfall(summary: Partial<WindowSummary> | null | undefined): boolean {
  return Number(summary?.unmetWh) >= 50 && summary?.socTargetReached !== true;
}
