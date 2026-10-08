import { PlanLike, StateLike, CommandExecutor } from "./shared.js";

export async function updateActiveAdaptiveChargingObjective(
  state: StateLike,
  plan: PlanLike | null,
  now: Date,
  execute: CommandExecutor,
  soc: number | null = null,
): Promise<boolean> {
  if (state.owner !== "adaptiveCharging") return false;
  const active = state.activeSlot;
  if (!active || now.getTime() >= new Date(String(active.end ?? "")).getTime()) return false;
  const planChanged = state.activePlanCreatedAt !== plan?.createdAt;
  if (!planChanged && Number.isFinite(active?.deviceTargetWh)) return false;
  const replacement = (plan?.slots ?? []).find((slot) => slot.windowStart === active?.windowStart
    && slot.windowEnd === active?.windowEnd && slot.yenPerKwh === active?.yenPerKwh
    && slot.label === active?.label && new Date(String(slot.end ?? "")) > now);
  if (!replacement || !active?.continuousWindowCharge) return false;
  const deliveredWh = Math.max(0, Number(state.activeChargedKwh) * 1000);
  const remainingWh = Math.max(0, Math.round(Number(replacement.targetWh) || 0));
  if (!remainingWh) return false;
  const targetWh = planChanged ? Math.round(deliveredWh + remainingWh) : Number(active.targetWh);
  if (!Number.isFinite(targetWh) || targetWh <= 0) return false;
  const socReached = soc !== null && Number.isFinite(soc) && soc >= Number(replacement.targetSocPercent);
  let deviceTargetWh = active.deviceTargetWh;
  if (!socReached && targetWh !== deviceTargetWh) {
    await execute("charge", { targetWh });
    deviceTargetWh = targetWh;
  }
  state.activeSlot = { ...replacement, start: active.start, targetWh, deviceTargetWh, continuousWindowCharge: true };
  state.activePlanCreatedAt = plan?.createdAt ?? null;
  if (state.activeChargeSession) {
    state.activeChargeSession.requestedWh = targetWh;
    state.activeChargeSession.slotEnd = replacement.end;
  }
  return true;
}
