import type { RetentionConfig } from "../contracts/configuration.js";

export interface RetentionPolicy {
  rawTelemetryDays: number;
  intervalAggregatesDays: number | null;
  dailyAggregatesDays: number | null;
  adaptiveChargingHistoryDays: number | null;
  automationEventDays: number | null;
  commandReceiptDays: number | null;
  notificationDeliveryDays: number | null;
}

export function normalizeRetentionPolicy(
  policy: Partial<RetentionConfig> = {},
  legacyRawTelemetryDays: unknown = undefined,
): RetentionPolicy {
  const days = (value: unknown, fallback: number | null): number | null => {
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
  };
  return {
    rawTelemetryDays: days(policy.rawTelemetryDays ?? legacyRawTelemetryDays, 1095) ?? 1095,
    intervalAggregatesDays: days(policy.intervalAggregatesDays, null),
    dailyAggregatesDays: days(policy.dailyAggregatesDays, null),
    adaptiveChargingHistoryDays: days(policy.adaptiveChargingHistoryDays, null),
    automationEventDays: days(policy.automationEventDays, null),
    commandReceiptDays: days(policy.commandReceiptDays, 365),
    notificationDeliveryDays: days(policy.notificationDeliveryDays, 365),
  };
}
