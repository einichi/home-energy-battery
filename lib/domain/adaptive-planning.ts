import { effectiveBatteryLearningModel } from "./battery-learning.js";
import { buildFuelCellGenerationModel, predictAwayDemand, predictBranchDemand } from "./demand-forecast.js";
import { finiteNumberOrNull } from "./numbers.js";
import { applySolarForecastBias, forecastHourForInterval, learnedSolarFactor, nextPlanningBoundary, planningSunsetWithDiscountedWindow, solarCalibrationGroup, solarPowerFromIrradiance, temperatureByDayFromWeather } from "./solar-forecast.js";
import { discountedBandOccurrence, discountedHorizonEndMs, explicitDiscountedBand } from "./tariffs.js";
import { AWAY_RETURN_BUFFER_MS, halfHourIndex, isAwayAt, localDayKey, MILLISECONDS_PER_DAY } from "./time.js";
import { latestFiniteSocPercent, planningHorizon } from "./adaptive-plan-utils.js";
import { adaptiveChargingBaseAvailability, forecastIsFresh } from "./adaptive-availability.js";
import { buildAdaptiveChargingTimelineView } from "./adaptive-timeline.js";
import { discountedPlanStatus, planChronologicalDiscountedCharging } from "./chronological-charging.js";
import type { AdaptiveTimelineSlot, PlanningInput } from "./adaptive-planning-types.js";

export type { AdaptiveChargeSlot, AdaptiveTimelineSlot } from "./adaptive-planning-types.js";
export { optimizeDiscountedChargeSlots } from "./adaptive-charge-slots.js";
export { applyAdaptiveChargingTimelineSlot, applyPredictedBatteryFlow, buildAdaptiveChargingTimelineView, cumulativeRangeNeeds } from "./adaptive-timeline.js";
export { discountedPlanStatus, planChronologicalDiscountedCharging } from "./chronological-charging.js";
export {
  adaptiveChargingBreakerSettings,
  mergeAdaptiveChargingSlots,
} from "./adaptive-plan-utils.js";
export {
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  forecastIsFresh,
} from "./adaptive-availability.js";

const LOOK_AHEAD_MS = 30 * 60 * 60_000;

export function buildAdaptiveChargingPlan({
  config,
  state,
  samples,
  historicalDemandDays = [],
  awayPeriods = [],
  now = new Date(),
}: PlanningInput) {
  const unavailable = (reason: string | null) => ({
    available: false,
    reason,
    createdAt: now.toISOString(),
    forecastFetchedAt: state.forecast?.fetchedAt ?? null,
    slots: [],
    timeline: [],
  });
  const baseAvailability = adaptiveChargingBaseAvailability(config);
  if (!baseAvailability.available) return unavailable(baseAvailability.reason);
  if (!forecastIsFresh(state.forecast, now)) return unavailable("solar forecast is stale or unavailable");
  const forecast = state.forecast;
  if (!forecast) return unavailable("solar forecast is stale or unavailable");
  const sunset = planningSunsetWithDiscountedWindow(config, forecast, now);
  if (!sunset) return unavailable("no discounted window is available before the forecast horizon ends");
  // Plan ahead of the sunset so the optimizer can defer to a cheaper window on
  // the next day, but never past the last forecast hour and never shorter than
  // the sunset's spanning discounted window.
  const lastForecastHourMs = new Date(forecast.hours.at(-1)?.timestamp ?? "").getTime();
  const { endMs: horizonEndMs, truncated: horizonTruncated } = planningHorizon(
    now.getTime(),
    lastForecastHourMs,
    discountedHorizonEndMs(config, sunset.timestamp),
    LOOK_AHEAD_MS,
  );
  const historicalWeather = state.historicalWeather ?? [];
  const temperatures = temperatureByDayFromWeather([...historicalWeather, ...forecast.hours]);
  const soc = latestFiniteSocPercent(samples);
  if (soc === null) return unavailable("battery state of charge is unavailable");
  const batteryModel = effectiveBatteryLearningModel(config, state);
  const capacityKwh = Number(batteryModel.capacityKwh);
  const cachedDischargeLimit = config.settingCache?.discharge_limit;
  const dischargeLimit = Number(cachedDischargeLimit?.lastKnown?.decoded?.percent);
  const dischargeLimitReadAt = new Date(String(cachedDischargeLimit?.lastReadAt ?? "")).getTime();
  if (!Number.isFinite(dischargeLimit)) return unavailable("battery discharge limit is unavailable");
  if (!Number.isFinite(dischargeLimitReadAt) || now.getTime() - dischargeLimitReadAt > MILLISECONDS_PER_DAY) {
    return unavailable("battery discharge limit has not been read successfully in the last 24 hours");
  }
  const initialStoredKwh = capacityKwh * soc / 100;
  const dischargeFloorKwh = capacityKwh * Math.max(0, dischargeLimit) / 100;
  const calibration = learnedSolarFactor(samples, historicalWeather, config);
  const forecastAccuracy = state.solarForecastAccuracy ?? {
    learned: false,
    sampleCount: 0,
    factor: 1,
  };
  const forecastBiasFactor = forecastAccuracy.learned
    && Number.isFinite(Number(forecastAccuracy.factor))
    ? Number(forecastAccuracy.factor)
    : 1;
  const chargePerformance = batteryModel.power;
  const maximumChargeWatts = chargePerformance.effectiveWatts;
  const startMs = now.getTime();
  type HousePrediction = ReturnType<typeof predictBranchDemand>;
  type AwayPrediction = ReturnType<typeof predictAwayDemand>;
  const demandByDay = new Map<string, { home: HousePrediction; away: AwayPrediction }>();
  const fuelCellModel = buildFuelCellGenerationModel(config, samples, now, {
    temperatureByDay: temperatures,
    awayPeriods,
  });
  const timeline: AdaptiveTimelineSlot[] = [];
  let predictedSolarKwh = 0;
  let forecastSolarKwh = 0;
  let predictedDemandKwh = 0;
  let predictedSurplusKwh = 0;
  let predictedFuelCellKwh = 0;
  let awaySlotCount = 0;
  let awayLearnedSlotCount = 0;
  let awayFallbackSlotCount = 0;
  const awayComparableDays = new Set<string>();
  for (let time = startMs; time < horizonEndMs;) {
    const date = new Date(time);
    const dayKey = localDayKey(date);
    if (!demandByDay.has(dayKey)) {
      const home = predictBranchDemand(samples, date, temperatures, {
        historicalDays: historicalDemandDays,
        awayPeriods,
        occupancy: "home",
      });
      if (!home.available) return unavailable(home.reason);
      const away = predictAwayDemand(samples, date, temperatures, {
        historicalDays: historicalDemandDays,
        awayPeriods,
        normalPrediction: home,
      });
      demandByDay.set(dayKey, { home, away });
    }
    const demand = demandByDay.get(dayKey)!;
    const slotEndMs = nextPlanningBoundary(time, horizonEndMs);
    const hour = forecastHourForInterval(forecast, time, slotEndMs);
    const factor = calibration.groupFactors?.[solarCalibrationGroup(date)] ?? calibration.factor;
    const uncorrectedSolarW = solarPowerFromIrradiance(hour?.tiltedIrradianceWm2, config, factor);
    const rawSolarW = applySolarForecastBias(
      uncorrectedSolarW,
      Number(config.adaptiveCharging.arrayPeakKw) * 1000,
      forecastAccuracy,
    );
    const margin = Number(config.adaptiveCharging.forecastMarginPercent) / 100;
    const solarW = rawSolarW * (1 - margin);
    const highSolarW = Math.min(Number(config.adaptiveCharging.arrayPeakKw) * 1000, rawSolarW * (1 + margin));
    const bucket = halfHourIndex(date);
    const away = isAwayAt((time + slotEndMs) / 2, awayPeriods, { forecast: true });
    const awayLearned = away && demand.away.learnedBuckets.has(bucket);
    const slotDemandW = Number((away ? demand.away.profile : demand.home.profile).get(bucket) ?? 0);
    if (away) {
      awaySlotCount += 1;
      if (awayLearned) awayLearnedSlotCount += 1;
      else awayFallbackSlotCount += 1;
      for (const key of demand.away.comparableDays) awayComparableDays.add(key);
    }
    const durationHours = (slotEndMs - time) / 3_600_000;
    const solarKwh = solarW * durationHours / 1000;
    forecastSolarKwh += rawSolarW * durationHours / 1000;
    const highSolarKwh = highSolarW * durationHours / 1000;
    const demandKwh = slotDemandW * durationHours / 1000;
    const fuelCellForecast = fuelCellModel.forecastAt(date);
    const fuelCellActive = fuelCellModel.influence === "active";
    const fuelCellPlanningKwh = fuelCellActive ? fuelCellForecast.p20W * durationHours / 1000 : 0;
    const highFuelCellKwh = fuelCellActive ? fuelCellForecast.p80W * durationHours / 1000 : 0;
    const medianFuelCellForecastKwh = fuelCellForecast.medianW * durationHours / 1000;
    const medianFuelCellKwh = fuelCellActive ? medianFuelCellForecastKwh : 0;
    predictedSolarKwh += solarKwh;
    predictedDemandKwh += demandKwh;
    predictedFuelCellKwh += medianFuelCellKwh;
    predictedSurplusKwh += Math.max(0, solarKwh + medianFuelCellKwh - demandKwh);
    const band = explicitDiscountedBand(config, date);
    const bandOccurrence = band ? discountedBandOccurrence(config, date) : null;
    timeline.push({
      startMs: time,
      endMs: slotEndMs,
      demandW: slotDemandW,
      solarKwh,
      fuelCellP20Kwh: fuelCellForecast.p20W * durationHours / 1000,
      fuelCellMedianKwh: medianFuelCellForecastKwh,
      fuelCellP80Kwh: fuelCellForecast.p80W * durationHours / 1000,
      fuelCellSampleCount: fuelCellForecast.sampleCount,
      demandKwh,
      netKwh: solarKwh + fuelCellPlanningKwh - demandKwh,
      highSolarNetKwh: highSolarKwh + highFuelCellKwh - demandKwh,
      band,
      rateWindowStartMs: bandOccurrence ? new Date(bandOccurrence.start).getTime() : null,
      rateWindowEndMs: bandOccurrence ? new Date(bandOccurrence.end).getTime() : null,
      chargeCapacityKwh: band
        ? maximumChargeWatts * durationHours / 1000
        : 0,
      away,
      awayDemandConfidence: away ? (awayLearned ? "learned" : "low") : null,
    });
    time = slotEndMs;
  }
  const demandPredictions = [...demandByDay.values()].map((prediction) => prediction.home);
  const standbyWindowEnd = state.standbyHoldUntil
    ?? (state.owner === "adaptiveCharging" ? state.activeSlot?.windowEnd : null);
  const optimized = planChronologicalDiscountedCharging({
    timeline,
    currentStoredKwh: initialStoredKwh,
    capacityKwh,
    dischargeFloorKwh,
    maximumTargetPercent: Number(config.adaptiveCharging.targetSocPercent),
    maximumChargeWatts,
    chargePowerCurve: chargePerformance.curve,
    chargeWhPerSocPoint: batteryModel.charge.whPerSocPoint,
    chargeToStoredRatio: batteryModel.chargeToStoredRatio,
    roundTripEfficiency: Number(config.batteryCapabilities?.roundTripEfficiency) || 1,
    displacedRateYenPerKwh: Number(config.standardRateYenPerKwh),
    standbyWindowEnd,
    windowSummaries: state.windowSummaries,
  });
  const timelineView = buildAdaptiveChargingTimelineView({
    timeline,
    slots: optimized.slots,
    initialStoredKwh,
    floorKwh: dischargeFloorKwh,
    capacityKwh,
    chargeToStoredRatio: batteryModel.chargeToStoredRatio,
    standbyWindowEnd,
    config,
  });
  const planStatus = discountedPlanStatus(optimized);
  // Keep "expected sunset SOC" meaning the SOC at the sunset, not the (now
  // longer) plan horizon end.
  const sunsetSegment = timelineView.find((segment) =>
    new Date(segment.start).getTime() <= sunset.timestamp && sunset.timestamp < new Date(segment.end).getTime());
  const expectedSunsetSocPercent = sunsetSegment?.predictedEndSocPercent
    ?? (capacityKwh ? Math.min(100, optimized.expectedEndStoredKwh / capacityKwh * 100) : null);
  return {
    ...planStatus,
    createdAt: now.toISOString(),
    targetDate: sunset.date,
    targetSunset: new Date(sunset.timestamp).toISOString(),
    forecastFetchedAt: state.forecast?.fetchedAt ?? null,
    currentSocPercent: soc,
    dischargeLimitPercent: dischargeLimit,
    dischargeLimitReadAt: new Date(dischargeLimitReadAt).toISOString(),
    targetSocPercent: Number(config.adaptiveCharging.targetSocPercent),
    expectedSunsetSocPercent,
    horizonEnd: new Date(horizonEndMs).toISOString(),
    forecastLastHour: Number.isFinite(lastForecastHourMs) ? new Date(lastForecastHourMs).toISOString() : null,
    horizonTruncated,
    predictedSolarKwh,
    forecastSolarKwh,
    predictedDemandKwh,
    predictedFuelCellKwh,
    predictedSurplusKwh,
    fuelCellModel: {
      method: fuelCellModel.method,
      requestedInfluence: fuelCellModel.requestedInfluence,
      influence: fuelCellModel.influence,
      ready: fuelCellModel.ready,
      blockers: fuelCellModel.blockers,
      validObservationDays: fuelCellModel.validObservationDays,
      comparableDays: fuelCellModel.comparableDays,
    },
    chargePerformance,
    batteryModel,
    ...optimized,
    comparableDemandDays: [...new Set(demandPredictions.flatMap((prediction) => prediction.comparableDays))],
    demandHistory: {
      recordedDayCount: Math.max(...demandPredictions.map((prediction) => prediction.recordedDayCount)),
      validDayCount: Math.max(...demandPredictions.map((prediction) => prediction.validDayCount)),
      sameDayTypeDayCount: Math.max(...demandPredictions.map((prediction) => prediction.sameDayTypeDays.length)),
      usedDayTypeFallback: demandPredictions.some((prediction) => prediction.usedDayTypeFallback),
      recentComparableDayCount: Math.max(...demandPredictions.map((prediction) => prediction.recentComparableDays.length)),
      seasonalComparableDayCount: Math.max(...demandPredictions.map((prediction) => prediction.seasonalComparableDays.length)),
      seasonalYears: [...new Set(demandPredictions.flatMap((prediction) => prediction.seasonalYears))]
        .sort((left, right) => right - left),
      seasonalBlendPercent: Math.round(Math.max(
        ...demandPredictions.map((prediction) => prediction.seasonalBlendWeight * 100),
      )),
      awayComparableDayCount: awayComparableDays.size,
      awaySlotCount,
      awayLearnedSlotCount,
      awayFallbackSlotCount,
      awayConfidence: awaySlotCount === 0
        ? "not-scheduled"
        : awayFallbackSlotCount === 0
          ? "learned"
          : awayLearnedSlotCount > 0
            ? "mixed"
            : "low",
      awayReturnBufferMinutes: AWAY_RETURN_BUFFER_MS / 60_000,
    },
    solarCalibration: calibration,
    solarForecastBias: {
      learned: forecastAccuracy.learned === true,
      sampleCount: Number(forecastAccuracy.sampleCount) || 0,
      factor: forecastBiasFactor,
      measuredFactor: finiteNumberOrNull(forecastAccuracy.measuredFactor),
    },
    slots: optimized.slots,
    timeline: timelineView,
  };
}
