// Pure, DOM-free helpers shared by the browser app and the test suite.
// Keeping them here (instead of inline in app.js) lets us unit-test the
// formatting/normalization logic without a headless browser or build step.

export const DASHBOARD_WIDGET_DEFAULTS = [
  { id: "solarPower", group: "trends", labelKey: "solarGeneration", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", labelKey: "fuelCellGeneration", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", labelKey: "houseDemand", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", labelKey: "batteryPower", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", labelKey: "stateOfCharge", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", labelKey: "gridImport", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", labelKey: "gridExport", visible: true, priority: 70 },
  { id: "batteryWorking", group: "status", labelKey: "batteryWorkingStatus", visible: true, priority: 10 },
  { id: "operationMode", group: "status", labelKey: "operationMode", visible: true, priority: 20 },
  { id: "vendorProfile", group: "status", labelKey: "chargingProfile", visible: true, priority: 30 },
  { id: "dischargeLimit", group: "status", labelKey: "dischargeLimit", visible: true, priority: 40 },
  { id: "fuelCellStatus", group: "status", labelKey: "fuelCellStatus", visible: true, priority: 50 },
  { id: "solarSavings", group: "status", labelKey: "solarSavings", visible: true, priority: 60 },
  { id: "co2Savings", group: "status", labelKey: "co2Savings", visible: true, priority: 70 },
  { id: "offPeakSavings", group: "status", labelKey: "offPeakSavings", visible: true, priority: 80 },
  { id: "powerImported", group: "status", labelKey: "powerImported", visible: true, priority: 90 },
  { id: "powerExported", group: "status", labelKey: "powerExported", visible: true, priority: 100 },
];

export function metricValue(item, fallback = "--") {
  if (!item) return fallback;
  if (item.human) return item.human;
  if (item.value !== undefined && item.value !== null && item.unit) {
    return `${item.value} ${item.unit}`;
  }
  if (item.value !== undefined && item.value !== null) return String(item.value);
  return item.raw ?? fallback;
}

export function numericValue(item) {
  if (item?.value === null || item?.value === undefined || item.value === "") return Number.NaN;
  return Number(item.value);
}

export function watts(value) {
  return Number.isFinite(value) ? `${Math.round(value)} W` : "-- W";
}

export function parseOsaifuWindow(setting) {
  // Prefer decoded fields from the server, but fall back to raw 0xSS00EE00 so
  // selectors still populate when only a raw vendor value is available.
  const decoded = setting?.decoded ?? {};
  const start = Number(
    decoded.start_hour ??
      decoded.startHour ??
      decoded.charge_start_hour ??
      decoded.discharge_start_hour,
  );
  const end = Number(
    decoded.end_hour ??
      decoded.endHour ??
      decoded.charge_end_hour ??
      decoded.discharge_end_hour,
  );
  if (Number.isInteger(start) && Number.isInteger(end)) {
    return { start, end };
  }
  const raw = setting?.raw;
  if (typeof raw === "string" && /^0x[0-9a-fA-F]{8}$/.test(raw)) {
    const hex = raw.slice(2);
    return {
      start: Number.parseInt(hex.slice(0, 2), 16),
      end: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

export function normalizeAutomationLogMessage(message) {
  return String(message)
    .replace(/^House demand/, "Grid Import")
    .replace(/\((auto|standby|rapid|charge|discharge)\)/gi, "$1")
    .replace(/battery working state/g, "operation mode");
}

export function normalizeDashboardWidgets(config = {}) {
  const inputById = new Map(
    (Array.isArray(config.dashboardWidgets) ? config.dashboardWidgets : [])
      .map((widget) => [String(widget?.id ?? ""), widget]),
  );
  return DASHBOARD_WIDGET_DEFAULTS.map((defaults) => {
    const input = inputById.get(defaults.id) ?? {};
    const priority = Number(input.priority);
    return {
      ...defaults,
      visible:
        input.visible === undefined || input.visible === null
          ? defaults.visible
          : Boolean(input.visible),
      priority: Number.isFinite(priority) ? priority : defaults.priority,
    };
  });
}
