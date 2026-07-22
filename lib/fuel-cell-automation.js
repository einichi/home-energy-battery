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
      end: validTime(schedule?.end) ? schedule.end : "00:00",
      label: String(schedule?.label ?? "").trim().slice(0, 80),
    }))
    .filter((schedule) => schedule.days.length && schedule.start !== schedule.end);
  const hotWaterThreshold = value.preventStartAtOrAboveHotWaterLevel;
  return {
    enabled: booleanValue(value.enabled, false),
    defaultMode: "off",
    spoolUpMinutes: Math.round(boundedNumber(value.spoolUpMinutes, 15, 0, 180)),
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
  const endMinute = minutesOfDay(schedule.end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
  const scheduledStart = new Date(startDay);
  scheduledStart.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  const scheduledEnd = new Date(startDay);
  scheduledEnd.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
  if (endMinute <= startMinute) scheduledEnd.setDate(scheduledEnd.getDate() + 1);
  const requestStart = new Date(scheduledStart.getTime() - spoolUpMinutes * 60_000);
  return {
    scheduleIndex,
    label: schedule.label,
    days: schedule.days,
    start: scheduledStart.toISOString(),
    end: scheduledEnd.toISOString(),
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

export function activeFuelCellSchedule(automation, at = new Date(), { includeSpoolUp = true } = {}) {
  const timestamp = (at instanceof Date ? at : new Date(at)).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return fuelCellScheduleOccurrences(automation, new Date(timestamp), 1).find((occurrence) => {
    const start = new Date(includeSpoolUp ? occurrence.requestStart : occurrence.start).getTime();
    const end = new Date(occurrence.end).getTime();
    return timestamp >= start && timestamp < end;
  }) ?? null;
}

export function nextFuelCellSchedule(automation, at = new Date()) {
  const timestamp = (at instanceof Date ? at : new Date(at)).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return fuelCellScheduleOccurrences(automation, new Date(timestamp), 8)
    .find((occurrence) => new Date(occurrence.requestStart).getTime() > timestamp) ?? null;
}

function activeGenerationState(value) {
  return value === "generating" || value === "starting";
}

export function decideFuelCellAutomation({
  automation,
  now = new Date(),
  generationState = null,
  hotWaterLevel = null,
  discountedRateActive = false,
  commandCooldownUntil = null,
  offModeConfirmed = false,
  lastCommand = null,
  manualRunActive = false,
} = {}) {
  const normalized = normalizeFuelCellAutomation(automation);
  const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
  const activeSchedule = activeFuelCellSchedule(normalized, new Date(timestamp));
  const nextSchedule = nextFuelCellSchedule(normalized, new Date(timestamp));
  const view = (status, reason, action = null) => ({
    action,
    status,
    reason,
    activeSchedule,
    nextSchedule,
  });
  if (!normalized.enabled) return view("disabled", "Ene-Farm automation is disabled");
  if (!generationState) return view("unavailable", "Ene-Farm generation state is unavailable");

  const runRequested = Boolean(activeSchedule) || manualRunActive;
  const shouldRun = runRequested && !(normalized.stopDuringDiscountedRates && discountedRateActive);
  if (!shouldRun) {
    const reason = runRequested && discountedRateActive
      ? "A discounted electricity rate is active"
      : "No Ene-Farm generation schedule is active";
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
      manualRunActive && !activeSchedule
        ? "Manual one-off generation is active"
        : `Generation schedule ${activeSchedule.label || activeSchedule.start} is active`,
    );
  }
  if (generationState === "stopping") {
    return view("waiting", "Waiting for the current stop operation to complete");
  }
  if (manualRunActive && !activeSchedule) {
    return view("waiting", "Waiting for the manual one-off generation request to start");
  }
  const threshold = normalized.preventStartAtOrAboveHotWaterLevel;
  if (threshold !== null) {
    const level = Number(hotWaterLevel);
    if (!Number.isFinite(level)) {
      return view("waiting", "Hot-water level is unavailable, so scheduled generation will not start");
    }
    if (level >= threshold) {
      return view("waiting", `Hot-water level ${level}/5 is at or above the configured ${threshold}/5 start limit`);
    }
  }
  const cooldownMs = new Date(commandCooldownUntil ?? 0).getTime();
  if (Number.isFinite(cooldownMs) && cooldownMs > timestamp) {
    return view("waiting", `Waiting until ${new Date(cooldownMs).toISOString()} before retrying the start request`);
  }
  return view("starting", `Starting for schedule ${activeSchedule.label || activeSchedule.start}`, "start");
}
