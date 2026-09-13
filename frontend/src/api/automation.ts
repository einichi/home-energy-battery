import { getJson, sendJson } from "./client";
import type { AdaptiveChargingStatus, AutomationRule, AwayPeriod, AwayPeriodsView } from "./contracts";

export function getAdaptiveCharging(signal?: AbortSignal) {
  return getJson<AdaptiveChargingStatus>("/api/adaptive-charging", signal);
}

export function getAutomationRules(signal?: AbortSignal) {
  return getJson<AutomationRule[]>("/api/automation-rules", signal);
}

export function getAwayPeriods(signal?: AbortSignal) {
  return getJson<AwayPeriodsView>("/api/away-periods", signal);
}

export function recalculateAdaptiveCharging() {
  return sendJson<AdaptiveChargingStatus>("/api/adaptive-charging/recalculate", "POST", {});
}

export function resumeAdaptiveCharging() {
  return sendJson<AdaptiveChargingStatus>("/api/adaptive-charging/resume", "POST", {});
}

export function saveAutomationRule(rule: AutomationRule) {
  if (rule.id) {
    return sendJson<AutomationRule>(`/api/automation-rules/${encodeURIComponent(rule.id)}`, "PATCH", rule);
  }
  return sendJson<AutomationRule>("/api/automation-rules", "POST", rule);
}

export function createAwayPeriod(period: Pick<AwayPeriod, "from" | "until" | "source">) {
  return sendJson<AwayPeriodsView & { period: AwayPeriod }>("/api/away-periods", "POST", period);
}

export function updateAwayPeriod(id: string, period: Pick<AwayPeriod, "from" | "until">) {
  return sendJson<AwayPeriodsView>(`/api/away-periods/${encodeURIComponent(id)}`, "PATCH", period);
}

export function deleteAwayPeriod(id: string) {
  return sendJson<AwayPeriodsView>(`/api/away-periods/${encodeURIComponent(id)}`, "DELETE");
}

export function extendAwayPeriod(id: string, until: string) {
  return sendJson<AwayPeriodsView>(`/api/away-periods/${encodeURIComponent(id)}/extend`, "POST", { until });
}

export function endAwayPeriod(id: string) {
  return sendJson<AwayPeriodsView>(`/api/away-periods/${encodeURIComponent(id)}/back-home`, "POST", {});
}
