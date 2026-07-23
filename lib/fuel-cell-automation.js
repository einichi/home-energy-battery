function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function booleanValue(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value ?? ""))) return false;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function minutesOfDay(value) {
  if (!validTime(value)) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export function normalizeFuelCellAutomation(value = {}, legacy = {}) {
  const sourceSchedules = Array.isArray(value.schedules)
    ? value.schedules
    : Array.isArray(legacy.fixedWindows)
      ? legacy.fixedWindows
      : [];
  const schedules = sourceSchedules
    .map((schedule) => ({
      days: [...new Set((Array.isArray(schedule?.days) ? schedule.days : [])
        .map(Number)
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort(),
      start: validTime(schedule?.start) ? schedule.start : "00:00",
      label: String(schedule?.label ?? "").trim().slice(0, 80),
    }))
    .filter((schedule) => schedule.days.length);
  const hotWaterThreshold = value.preventStartAtOrAboveHotWaterLevel;
  return {
    enabled: booleanValue(value.enabled, false),
    defaultMode: "off",
    spoolUpMinutes: Math.round(boundedNumber(value.spoolUpMinutes, 40, 0, 180)),
    stopDuringDiscountedRates: booleanValue(value.stopDuringDiscountedRates, false),
    preventStartAtOrAboveHotWaterLevel: hotWaterThreshold === null
      || hotWaterThreshold === undefined
      || hotWaterThreshold === ""
      ? null
      : Math.round(boundedNumber(hotWaterThreshold, 4, 1, 5)),
    includeInAdaptiveCharging: booleanValue(
      value.includeInAdaptiveCharging ?? value.includeScheduleInAdaptiveCharging,
      legacy.plannerInfluence === "active",
    ),
    schedules,
  };
}

function occurrenceForStartDay(schedule, startDay, spoolUpMinutes, scheduleIndex) {
  const startMinute = minutesOfDay(schedule.start);
  if (startMinute === null) return null;
  const scheduledStart = new Date(startDay);
  scheduledStart.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  const requestStart = new Date(scheduledStart.getTime() - spoolUpMinutes * 60_000);
  return {
    key: `${scheduleIndex}:${scheduledStart.toISOString()}`,
    scheduleIndex,
    label: schedule.label,
    days: schedule.days,
    start: scheduledStart.toISOString(),
    requestStart: requestStart.toISOString(),
  };
}

export function fuelCellScheduleOccurrences(automation, from = new Date(), horizonDays = 8) {
  const normalized = normalizeFuelCellAutomation(automation);
  const fromDate = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(fromDate.getTime())) return [];
  const midnight = new Date(fromDate);
  midnight.setHours(0, 0, 0, 0);
  const occurrences = [];
  for (let dayOffset = -1; dayOffset <= horizonDays; dayOffset += 1) {
    const startDay = new Date(midnight);
    startDay.setDate(startDay.getDate() + dayOffset);
    for (const [scheduleIndex, schedule] of normalized.schedules.entries()) {
      if (!schedule.days.includes(startDay.getDay())) continue;
      const occurrence = occurrenceForStartDay(schedule, startDay, normalized.spoolUpMinutes, scheduleIndex);
      if (occurrence) occurrences.push(occurrence);
    }
  }
  return occurrences.sort((left, right) => new Date(left.requestStart) - new Date(right.requestStart));
}

export function nextFuelCellSchedule(automation, at = new Date()) {
  const timestamp = (at instanceof Date ? at : new Date(at)).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return fuelCellScheduleOccurrences(automation, new Date(timestamp), 8)
    .find((occurrence) => new Date(occurrence.requestStart).getTime() > timestamp) ?? null;
}

export function fuelCellScheduledStartAllowedDuringDiscount(
  occurrence,
  discountedRateEnd,
  toleranceMs = 5 * 60_000,
) {
  const scheduledStartMs = new Date(occurrence?.start ?? 0).getTime();
  const discountedEndMs = new Date(discountedRateEnd ?? 0).getTime();
  const tolerance = Math.max(0, Number(toleranceMs) || 0);
  return Number.isFinite(scheduledStartMs)
    && scheduledStartMs > 0
    && Number.isFinite(discountedEndMs)
    && discountedEndMs > 0
    && scheduledStartMs >= discountedEndMs - tolerance;
}

export function dueFuelCellSchedule(automation, at = new Date(), {
  lastEvaluatedAt = null,
  lastHandledKey = null,
  graceMs = 5 * 60_000,
} = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) return null;
  const previous = new Date(lastEvaluatedAt ?? 0).getTime();
  const since = Number.isFinite(previous) && previous <= timestamp && timestamp - previous <= 6 * 60 * 60_000
    ? previous
    : timestamp - graceMs;
  return fuelCellScheduleOccurrences(automation, new Date(since), 1)
    .filter((occurrence) => {
      const requestStart = new Date(occurrence.requestStart).getTime();
      return requestStart > since && requestStart <= timestamp && occurrence.key !== lastHandledKey;
    })
    .at(-1) ?? null;
}

export function fuelCellScheduledStartBlockReason({
  automation,
  hotWaterLevel = null,
  discountedRateActive = false,
  scheduledStartAllowedDuringDiscount = false,
} = {}) {
  const normalized = normalizeFuelCellAutomation(automation);
  if (normalized.stopDuringDiscountedRates
    && discountedRateActive
    && !scheduledStartAllowedDuringDiscount) {
    return "Scheduled generation start is blocked because a discounted electricity rate is active";
  }
  const threshold = normalized.preventStartAtOrAboveHotWaterLevel;
  if (threshold === null) return null;
  const level = Number(hotWaterLevel);
  if (!Number.isFinite(level)) {
    return "Scheduled generation start skipped because the hot-water level is unavailable";
  }
  return level >= threshold
    ? `Scheduled generation start skipped because hot-water level ${level}/5 is at or above the configured ${threshold}/5 limit`
    : null;
}

function activeGenerationState(value) {
  return value === "generating" || value === "starting";
}

export function decideFuelCellAutomation({
  automation,
  now = new Date(),
  generationState = null,
  discountedRateActive = false,
  commandCooldownUntil = null,
  offModeConfirmed = false,
  lastCommand = null,
  manualRunActive = false,
  scheduledRunActive = false,
  scheduledOccurrence = null,
  scheduledRunCommandedAt = null,
  scheduledStartAllowedDuringDiscount = false,
} = {}) {
  const normalized = normalizeFuelCellAutomation(automation);
  const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
  const nextSchedule = nextFuelCellSchedule(normalized, new Date(timestamp));
  const view = (status, reason, action = null) => ({
    action,
    status,
    reason,
    activeSchedule: scheduledRunActive ? scheduledOccurrence : null,
    nextSchedule,
  });
  if (!normalized.enabled) return view("disabled", "Ene-Farm automation is disabled");
  if (!generationState) return view("unavailable", "Ene-Farm generation state is unavailable");

  const runRequested = scheduledRunActive || manualRunActive;
  const discountedRateBlocksRun = normalized.stopDuringDiscountedRates
    && discountedRateActive
    && !(scheduledRunActive && scheduledStartAllowedDuringDiscount);
  const shouldRun = runRequested && !discountedRateBlocksRun;
  if (!shouldRun) {
    const reason = runRequested && discountedRateActive
      ? "A discounted electricity rate is active"
      : "No scheduled or manual Ene-Farm run is active";
    if (!activeGenerationState(generationState) && offModeConfirmed) {
      return view("off", `${reason}; maintaining お出かけ停止`);
    }
    const cooldownMs = new Date(commandCooldownUntil ?? 0).getTime();
    if (lastCommand === "stop" && Number.isFinite(cooldownMs) && cooldownMs > timestamp) {
      return view("waiting", `${reason}; waiting before retrying お出かけ停止`);
    }
    return view("stopping", `${reason}; requesting お出かけ停止`, "stop");
  }

  if (activeGenerationState(generationState)) {
    return view(
      "running",
      manualRunActive && !scheduledRunActive
        ? "Manual one-off generation is active"
        : `Scheduled generation ${scheduledOccurrence?.label || scheduledOccurrence?.start || "run"} is active`,
    );
  }
  if (generationState === "stopping") {
    return view("waiting", "Waiting for the current stop operation to complete");
  }
  if (manualRunActive && !scheduledRunActive) {
    return view("waiting", "Waiting for the manual one-off generation request to start");
  }
  const expectedStartMs = new Date(scheduledOccurrence?.start ?? 0).getTime();
  const commandedAtMs = new Date(scheduledRunCommandedAt ?? 0).getTime();
  if (scheduledRunActive && Number.isFinite(commandedAtMs) && commandedAtMs > 0
    && Number.isFinite(expectedStartMs) && timestamp < expectedStartMs + 10 * 60_000) {
    return view("waiting", `Waiting for scheduled generation startup after the request at ${new Date(commandedAtMs).toISOString()}`);
  }
  const cooldownMs = new Date(commandCooldownUntil ?? 0).getTime();
  if (Number.isFinite(cooldownMs) && cooldownMs > timestamp) {
    return view("waiting", `Waiting until ${new Date(cooldownMs).toISOString()} before retrying the start request`);
  }
  return view("starting", `Starting scheduled generation ${scheduledOccurrence?.label || scheduledOccurrence?.start || "run"}`, "start");
}
