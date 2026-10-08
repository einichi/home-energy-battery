import { cleanConfig } from "../../lib/domain/configuration.js";
import { buildAdaptiveChargingPlan, planChronologicalDiscountedCharging } from "../../lib/domain/adaptive-planning.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const windowStart = now.getTime();
const windowEnd = windowStart + 90 * 60_000;

export const adaptivePlanningCharacterizationCases = {
  unavailablePlan: () => {
    const plan = buildAdaptiveChargingPlan({ config: cleanConfig(), state: { forecast: null }, samples: [], now });
    return {
      available: plan.available,
      reason: plan.reason,
      createdAt: plan.createdAt,
      forecastFetchedAt: plan.forecastFetchedAt,
      slots: plan.slots,
      timeline: plan.timeline,
    };
  },
  forecastDrivenPlan: () => {
    const config = cleanConfig({
      solarEnabled: true,
      smartCosmoEnabled: true,
      rateMode: "multi",
      standardRateYenPerKwh: 30,
      rateBands: [
        { start: "00:00", end: "12:00", yenPerKwh: 12, label: "Night" },
        { start: "12:00", end: "23:59", yenPerKwh: 30, label: "Standard" },
      ],
      batteryCapabilities: { usableCapacityKwh: 5.4, maximumChargeWatts: 2000 },
      adaptiveCharging: { enabled: true, latitude: 35, longitude: 139, arrayPeakKw: 5 },
      settingCache: { discharge_limit: { lastKnown: { decoded: { percent: 10 } }, lastReadAt: new Date(now.getTime() - 60_000).toISOString() } },
    });
    const historicalDemandDays = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(now);
      date.setDate(date.getDate() - index - 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return {
        key,
        date,
        values: new Map(Array.from({ length: 48 }, (_unused, bucket) => [bucket, 500 + bucket % 6 * 20])),
        coverage: 1,
        daytimeCoverage: 1,
      };
    });
    const forecast = {
      fetchedAt: now.toISOString(),
      timezone: "UTC",
      utcOffsetSeconds: 0,
      latitude: 35,
      longitude: 139,
      hours: Array.from({ length: 48 }, (_, index) => ({
        timestamp: new Date(now.getTime() + index * 3_600_000).toISOString(),
        tiltedIrradianceWm2: index % 24 >= 6 && index % 24 <= 18 ? 300 : 0,
        temperatureC: 20,
      })),
      days: [
        { date: "2026-07-11", sunrise: "2026-07-11T04:00:00.000Z", sunset: "2026-07-11T12:00:00.000Z" },
        { date: "2026-07-12", sunrise: "2026-07-12T04:00:00.000Z", sunset: "2026-07-12T12:00:00.000Z" },
      ],
    };
    const plan = buildAdaptiveChargingPlan({
      config,
      state: { forecast, solarForecastAccuracy: { learned: false, factor: 1, sampleCount: 0 } },
      samples: [{ timestamp: now.toISOString(), stateOfChargePercent: 50, branchDemandW: 500, solarPowerW: 0 }],
      historicalDemandDays,
      now,
    });
    const summary = {
      available: plan.available,
      reason: plan.reason,
      createdAt: plan.createdAt,
      forecastFetchedAt: plan.forecastFetchedAt,
      slots: plan.slots.map((slot) => ({ start: slot.start, end: slot.end, targetWh: slot.targetWh, label: slot.label, yenPerKwh: slot.yenPerKwh })),
      timelineLength: plan.timeline.length,
    };
    if (!("demandHistory" in plan)) return summary;
    return {
      ...summary,
      currentSocPercent: plan.currentSocPercent,
      targetSocPercent: plan.targetSocPercent,
      expectedSunsetSocPercent: plan.expectedSunsetSocPercent,
      predictedSolarKwh: plan.predictedSolarKwh,
      predictedDemandKwh: plan.predictedDemandKwh,
      predictedSurplusKwh: plan.predictedSurplusKwh,
      plannedChargeKwh: plan.plannedChargeKwh,
      demandHistory: plan.demandHistory,
    };
  },
  chronologicalCharging: () => {
    const timeline = Array.from({ length: 3 }, (_, index) => ({
      startMs: windowStart + index * 30 * 60_000,
      endMs: windowStart + (index + 1) * 30 * 60_000,
      netKwh: index === 1 ? 0.2 : 0,
      highSolarNetKwh: 0,
      chargeCapacityKwh: 0.9,
      band: { label: "Night", yenPerKwh: 12 },
      rateWindowStartMs: windowStart,
      rateWindowEndMs: windowEnd,
    }));
    const plan = planChronologicalDiscountedCharging({
      timeline,
      currentStoredKwh: 1.5,
      capacityKwh: 5,
      dischargeFloorKwh: 0.5,
      maximumTargetPercent: 90,
      maximumChargeWatts: 1800,
      chargeToStoredRatio: 1.1,
      roundTripEfficiency: 0.9,
      displacedRateYenPerKwh: 30,
    });
    return {
      plannedChargeKwh: plan.plannedChargeKwh,
      plannedStoredChargeKwh: plan.plannedStoredChargeKwh,
      requiredGridChargeKwh: plan.requiredGridChargeKwh,
      unmetChargeKwh: plan.unmetChargeKwh,
      unmetStoredChargeKwh: plan.unmetStoredChargeKwh,
      timeConstrainedWh: plan.timeConstrainedWh,
      expectedEndStoredKwh: plan.expectedEndStoredKwh,
      slots: plan.slots.map((slot) => ({ start: slot.start, end: slot.end, targetWh: slot.targetWh, label: slot.label, yenPerKwh: slot.yenPerKwh })),
      windows: plan.windows.map((window) => ({ start: window.start, end: window.end, plannedChargeKwh: window.plannedChargeKwh, unmetChargeKwh: window.unmetChargeKwh })),
    };
  },
};
