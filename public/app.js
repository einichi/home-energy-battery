import {
  decimateTimeSeries,
  nextHalfHourBoundary,
  pruneTrendPoints,
  trendAxisLabelOptions,
  trendAxisTicks,
  trendSamplePoints,
} from "./chart-utils.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const ACTIVE_REFRESH_MS = 15_000;
const INACTIVE_REFRESH_MS = 5 * 60_000;
const POWER_TREND_MS = 30 * 60_000;
const SOC_TREND_MS = POWER_TREND_MS;
const HISTORY_BATCH_SIZE = 400;
const HISTORY_PREVIEW_RECORD_INTERVAL = 10_000;
const DASHBOARD_LAYOUT_CACHE_KEY = "hemsDashboardWidgets";
const PAGE_LOAD_TIME_MS = Date.now();

// Frontend state is intentionally kept in one small object. The app has no build
// step, so avoiding framework state makes it easier to inspect in a browser.
const state = {
  status: null,
  schedules: [],
  refreshTimer: null,
  lastLivePollAt: 0,
  liveWindowEndMs: PAGE_LOAD_TIME_MS,
  controlsInitialized: false,
  config: null,
  language: "en",
  currentPage: "dashboard",
  settingsLoadedForView: false,
  lastDiscovery: null,
  discoveryPollTimer: null,
  trendHistory: {},
  trendHover: {},
  historyMode: false,
  historyHorizonMs: null,
  activeGraph: "solarPower",
  activeCircuit: "1",
  graphPoints: [],
  graphRecordCount: 0,
  graphHover: null,
  graphHistoryHorizonMs: POWER_TREND_MS,
  graphLoadToken: 0,
  historyLoadToken: 0,
  reportData: null,
  reportBucket: "day",
  reportDomain: "energy",
  fuelCellSummary: null,
  automationRules: [],
  adaptiveChargingStatus: null,
  adaptiveChargingRecalculating: false,
  adaptiveChargingTimelineHover: null,
  awayPeriodsView: null,
  awayFromSetByNow: false,
  notifications: null,
  databaseBackups: null,
  isComposing: false,
  discoveryInProgress: false,
  staticCircuitOrderKey: null,
  staticCircuitOrder: [],
};

const TREND_LABEL_KEYS = {
  batteryPower: "batteryPower",
  batterySoc: "stateOfCharge",
  solarPower: "solarGeneration",
  houseDemandPower: "houseDemand",
  fuelCellPower: "fuelCellGeneration",
  gridExportPower: "gridExport",
  gridImportPower: "gridImport",
};

const CIRCUIT_GRAPH_PREFIX = "circuit:";
const REPORT_PRESETS = {
  day: [
    { key: "last7Days", amount: 7, unit: "day" },
    { key: "last30Days", amount: 30, unit: "day" },
  ],
  week: [
    { key: "last8Weeks", amount: 8, unit: "week" },
    { key: "last26Weeks", amount: 26, unit: "week" },
  ],
  month: [
    { key: "last6Months", amount: 6, unit: "month" },
    { key: "last12Months", amount: 12, unit: "month" },
  ],
};

const NOTIFICATION_TRIGGER_DEFINITIONS = [
  { id: "guardActivated", labelKey: "triggerGuardActivated" },
  { id: "guardRestored", labelKey: "triggerGuardRestored" },
  { id: "scheduleFailed", labelKey: "triggerScheduleFailed" },
  { id: "deviceOffline", labelKey: "triggerDeviceOffline" },
  { id: "deviceRecovered", labelKey: "triggerDeviceRecovered" },
  { id: "adaptiveChargingUnavailable", labelKey: "triggerAdaptiveChargingUnavailable" },
  { id: "adaptiveChargingRecovered", labelKey: "triggerAdaptiveChargingRecovered" },
  { id: "adaptiveChargingWindowShortfall", labelKey: "triggerAdaptiveChargingWindowShortfall" },
  { id: "lowBattery", labelKey: "triggerLowBattery", threshold: true },
];

const DASHBOARD_WIDGET_DEFAULTS = [
  { id: "solarPower", group: "trends", labelKey: "solarGeneration", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", labelKey: "fuelCellGeneration", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", labelKey: "houseDemand", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", labelKey: "batteryPower", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", labelKey: "stateOfCharge", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", labelKey: "gridImport", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", labelKey: "gridExport", visible: true, priority: 70 },
  { id: "adaptiveCharging", group: "status", labelKey: "adaptiveCharging", visible: true, priority: 5 },
  { id: "awayStatus", group: "status", labelKey: "awayStatus", visible: true, priority: 7 },
  { id: "batteryWorking", group: "status", labelKey: "batteryWorkingStatus", visible: true, priority: 10 },
  { id: "operationMode", group: "status", labelKey: "operationMode", visible: true, priority: 20 },
  { id: "vendorProfile", group: "status", labelKey: "chargingProfile", visible: true, priority: 30 },
  { id: "dischargeLimit", group: "status", labelKey: "dischargeLimit", visible: true, priority: 40 },
  { id: "fuelCellStatus", group: "status", labelKey: "fuelCellStatus", visible: true, priority: 50 },
  { id: "fuelCellStateTimeline", group: "status", labelKey: "fuelCellStateTimeline", visible: true, priority: 55 },
  { id: "fuelCellHotWater", group: "status", labelKey: "fuelCellHotWater", visible: true, priority: 57 },
  { id: "solarSavings", group: "status", labelKey: "solarSavings", visible: true, priority: 60 },
  { id: "co2Savings", group: "status", labelKey: "co2Savings", visible: true, priority: 70 },
  { id: "offPeakSavings", group: "status", labelKey: "offPeakSavings", visible: true, priority: 80 },
  { id: "powerImported", group: "status", labelKey: "powerImported", visible: true, priority: 90 },
  { id: "powerExported", group: "status", labelKey: "powerExported", visible: true, priority: 100 },
  { id: "guardTriggerCount", group: "status", labelKey: "guardTriggerCount", visible: true, priority: 110 },
  { id: "energySources", group: "status", labelKey: "energySources", visible: true, priority: 120 },
];

const DASHBOARD_WIDGET_FEATURES = {
  adaptiveCharging: "solar",
  solarPower: "solar",
  fuelCellPower: "fuel-cell",
  houseDemandPower: "smart-cosmo",
  gridImportPower: "smart-cosmo",
  gridExportPower: "smart-cosmo",
  fuelCellStatus: "fuel-cell",
  fuelCellStateTimeline: "fuel-cell",
  fuelCellHotWater: "fuel-cell",
  solarSavings: "solar",
  co2Savings: "solar",
  offPeakSavings: "off-peak-savings",
  powerImported: "smart-cosmo",
  powerExported: "smart-cosmo",
  energySources: "energy-sources",
};

const TREND_CONFIG = {
  // Each graph declares its own horizon and scaling preferences. Power readings
  // are short-lived, while state of charge changes slowly and gets a longer view.
  batteryPower: {
    canvas: "#batteryPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.14)",
    includeZero: true,
    signed: true,
  },
  batterySoc: {
    canvas: "#batterySocTrend",
    horizonMs: SOC_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.12)",
    min: 0,
    max: 100,
  },
  solarPower: {
    canvas: "#solarPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#d8872c",
    fill: "rgba(216, 135, 44, 0.14)",
    includeZero: true,
  },
  houseDemandPower: {
    canvas: "#houseDemandPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.13)",
    includeZero: true,
  },
  fuelCellPower: {
    canvas: "#fuelCellPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#7c3aed",
    fill: "rgba(124, 58, 237, 0.13)",
    includeZero: true,
    max: 800,
  },
  gridExportPower: {
    canvas: "#gridExportPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#16a34a",
    fill: "rgba(22, 163, 74, 0.13)",
    includeZero: true,
  },
  gridImportPower: {
    canvas: "#gridImportPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#dc2626",
    fill: "rgba(220, 38, 38, 0.13)",
    includeZero: true,
  },
};

const I18N = {
  // All visible copy lives here so the language switch can re-render the UI
  // without loading another bundle.
  en: {
    brand: "HOME ENERGY <strong>& BATTERY</strong>",
    navDashboard: "Dashboard",
    navGraphs: "Graphs",
    navAdaptiveCharging: "Adaptive Charging",
    navAdaptiveChargingShort: "Charging",
    navReports: "Reports",
    navSettings: "Settings",
    liveDashboard: "Live dashboard",
    homeEnergyFlow: "Home energy flow",
    from: "From",
    to: "To",
    showRange: "Show Range",
    live: "Live",
    graphAnalysis: "Graph Analysis",
    loadGraphRange: "Load Graph",
    loadingGraphData: "Loading graph data",
    fetchingGraphRecords: "Fetching records...",
    parsedGraphRecords: "Parsed {parsed} / {total} records",
    loadingReportData: "Loading report data",
    fetchingReportRecords: "Aggregating report records...",
    parsedReportRecords: "Scanned {parsed} records",
    graphRecordCount: "{count} records",
    last1Hour: "Last 1 hour",
    last8Hours: "Last 8 hours",
    last24Hours: "Last 24 Hours",
    last3Days: "Last 3 Days",
    last7Days: "Last 7 days",
    last30Days: "Last 30 days",
    last3Months: "Last 3 months",
    last6Months: "Last 6 months",
    lastYear: "Last year",
    energyReports: "Energy Reports",
    exactUsageReports: "Energy Usage",
    reportsHelp: "Compare recorded energy totals by day, week, or month.",
    reportMode: "Report mode",
    dailyReport: "Daily",
    weeklyReport: "Weekly",
    monthlyReport: "Monthly",
    last8Weeks: "Last 8 weeks",
    last26Weeks: "Last 26 weeks",
    last12Months: "Last 12 months",
    loadReport: "Load Report",
    usageKwh: "Usage",
    usageKwhHelp: "House demand",
    gridImportHelp: "Bought from grid",
    solarCoverage: "Solar coverage",
    sentToGrid: "Sent to grid",
    peakDemand: "Peak Demand",
    usageTrend: "Usage Trend",
    exactKwhTable: "Energy by Period",
    period: "Period",
    change: "Change",
    noReportData: "No report data loaded yet.",
    reportBucketCount: "{count} periods",
    trendWidgets: "Power Trends",
    statusWidgets: "Status & Statistics",
    circuitWidgets: "Smart Cosmo Circuits",
    circuitPower: "Circuits",
    circuit: "Circuit",
    circuitSettings: "Smart Cosmo Circuits",
    circuitSettingsHelp: "Sort by current demand in watts or accumulated energy in kWh.",
    circuitSort: "Circuit sorting",
    circuitSortByNumber: "Circuit number",
    circuitSortByCurrent: "Current demand (highest first)",
    circuitSortByAccumulated: "Accumulated energy (highest first)",
    saveCircuitSettings: "Save Circuit Settings",
    circuitSettingsSaved: "Circuit settings saved",
    noCircuitData: "No circuit data available yet.",
    smartCosmoMeter: "Smart Cosmo / home power meter",
    smartCosmoEnabled: "Show Smart Cosmo / home power meter",
    batteryPower: "Battery Power",
    stateOfCharge: "State of Charge",
    batteryWorkingStatus: "Battery Working Status",
    operationMode: "Operation Mode",
    chargingProfile: "Charging Profile",
    profile: "Profile",
    mode: "Mode",
    dischargeLimit: "Discharge Limit",
    solarGeneration: "Solar Generation",
    solarSavings: "Estimated Solar Savings",
    co2Savings: "CO2 Savings",
    offPeakSavings: "Estimated Off-Peak Charge Savings",
    powerImported: "Power Imported",
    powerExported: "Power Exported",
    guardTriggerCount: "Demand Guard Triggers",
    energySources: "Energy Sources",
    fuelCellStateTimeline: "Ene-Farm Activity Today",
    fuelCellContribution: "Ene-Farm contribution",
    fuelCellStateGenerating: "Generating",
    fuelCellStateStarting: "Starting",
    fuelCellStateStopping: "Stopping",
    fuelCellStateIdling: "Idle",
    fuelCellStateStopped: "Stopped",
    peakGridEnergy: "Peak grid",
    offPeakGridEnergy: "Off-peak grid",
    solarUsedOnSite: "Solar contribution",
    includesBatteryCharging: "Includes battery charging",
    houseDemand: "House Demand",
    gridImport: "Grid Import",
    gridExport: "Grid Export",
    fuelCellGeneration: "Ene-Farm Generation",
    fuelCellStatus: "Ene-Farm Status",
    fuelCellOperation: "Ene-Farm Operation",
    fuelCellHotWater: "Ene-Farm Hot Water",
    hotWaterLevel: "Hot water level",
    hotWaterPercent: "{percent}% full (approx)",
    hotWaterLevelHelp: "Water at approximately 45°C or hotter",
    startManualFuelCellGeneration: "Start Manual Generation",
    confirmManualFuelCellGeneration: "Start manual Ene-Farm generation? Startup may take approximately 40 minutes and will consume gas.",
    manualFuelCellGenerationRequested: "Manual Ene-Farm generation requested",
    electricityToday: "Electricity today",
    gasToday: "Gas today",
    operatingTime: "Operating time",
    starts: "Starts",
    timeInState: "Time in state",
    lastStop: "Last stop",
    reportType: "Report type",
    energyUsage: "Energy Usage",
    eneFarmReports: "Ene-Farm Performance",
    eneFarmReportsHelp: "Compare generation, gas use, operating time, estimated cost, and carbon by period.",
    generatedElectricity: "Generated electricity",
    gasConsumed: "Gas consumed",
    exactCounterOnly: "Exact counter data only",
    electricalYield: "Electrical yield",
    generationCoverage: "Generation coverage",
    estimatedMarginalGasCost: "Estimated marginal gas cost",
    allocatedGasCost: "Estimated allocated gas cost",
    verifyProviderBill: "Verify with your provider",
    standingChargeScenario: "Includes allocated standing charge for complete billing periods",
    electricityCarbonBalance: "Electricity-only carbon balance",
    heatNotMeasured: "Recovered heat is not measured",
    eneFarmByPeriod: "Ene-Farm by Period",
    estimateNotice: "All costs and savings are estimates. Check your provider statement for accurate billing information.",
    carbonBalance: "Carbon balance",
    batterySettings: "Battery Settings",
    chargingProfileHelp:
      "Choose the battery behavior profile used by the controller.",
    dischargeLimitHelp: "Minimum charge to keep available for later use.",
    chargeWindow: "osaifu Charge Window",
    chargeWindowHelp:
      "Hours when the battery is allowed to charge in osaifu mode.",
    dischargeWindow: "osaifu Discharge Window",
    dischargeWindowHelp:
      "Hours when the battery is allowed to discharge in osaifu mode.",
    directAction: "Direct Action",
    directActionHelp:
      "Send an immediate battery command. Energy target is optional for charge and discharge.",
    set: "Set",
    run: "Run",
    targetWh: "target Wh",
    deviceAddresses: "Device Addresses",
    preferences: "Preferences",
    preferencesRates: "Preferences & Rates",
    dashboardLayout: "Dashboard Layout",
    saveDashboardLayout: "Save Dashboard Layout",
    resetDashboardLayout: "Reset Dashboard Layout",
    dashboardLayoutSaved: "Dashboard layout saved",
    dashboardLayoutReset: "Dashboard layout reset",
    visible: "Visible",
    priority: "Priority",
    dataDiscovery: "Data & Discovery",
    dataRetention: "Data Retention",
    language: "Language",
    updateInterval: "Update interval (seconds)",
    savePreferences: "Save Preferences",
    preferencesSaved: "Preferences saved",
    notifications: "Notifications",
    notificationsHelp: "Send important system and automation events by email.",
    enableNotifications: "Enable notifications",
    smtpEmail: "Email (SMTP)",
    smtpHost: "SMTP server",
    smtpPort: "Port",
    smtpSecurity: "Security",
    smtpStarttls: "STARTTLS",
    smtpTls: "TLS",
    smtpNone: "None (trusted local server)",
    smtpUsername: "Username",
    smtpPassword: "Password",
    smtpPasswordPlaceholder: "Unchanged if blank",
    smtpFrom: "From address",
    smtpRecipients: "Recipients (comma separated)",
    smtpClearPassword: "Remove saved password",
    notificationTriggers: "Notification Triggers",
    notificationCooldown: "Cooldown (minutes)",
    triggerGuardActivated: "Demand Guard activated",
    triggerGuardRestored: "Demand Guard restored",
    triggerScheduleFailed: "Schedule failed",
    triggerDeviceOffline: "Device unavailable",
    triggerDeviceRecovered: "Device recovered",
    triggerAdaptiveChargingUnavailable: "Adaptive Charging unavailable",
    triggerAdaptiveChargingRecovered: "Adaptive Charging recovered",
    triggerAdaptiveChargingWindowShortfall: "Charging-window shortfall",
    triggerLowBattery: "Low battery SOC",
    notificationSocThreshold: "SOC threshold (%)",
    saveNotifications: "Save Notifications",
    notificationsSaved: "Notification settings saved",
    sendTestNotification: "Send Test Email",
    testNotificationSent: "Test email sent",
    notificationDeliveryLog: "Recent deliveries",
    noNotificationDeliveries: "No notification deliveries yet.",
    notificationSuccess: "Sent",
    notificationFailure: "Failed",
    passwordConfigured: "A password is saved.",
    passwordNotConfigured: "No password is saved.",
    electricityRates: "Electricity Rates",
    batteryCapabilities: "Battery Capabilities",
    usableBatteryCapacity: "Usable battery capacity (kWh)",
    maximumBatteryChargeWatts: "Maximum battery charge watts",
    saveBatteryCapabilities: "Save Battery Capabilities",
    batteryCapabilitiesSaved: "Battery capabilities saved",
    adaptiveCharging: "Adaptive Charging",
    awayStatus: "Away Status",
    awayPeriods: "Away Periods",
    awaySchedule: "Away Schedule",
    awayScheduleHelp: "Scheduled absences improve demand forecasts while keeping completed periods available for future learning.",
    away: "Away",
    home: "Home",
    now: "Now",
    until: "Until",
    scheduleAway: "Schedule Away",
    saveAwayChanges: "Save Changes",
    saveAwayExtension: "Save Extension",
    cancel: "Cancel",
    status: "Status",
    scheduled: "Scheduled",
    observed: "Observed behaviour",
    active: "Active",
    edit: "Edit",
    delete: "Delete",
    backHome: "Back Home",
    extend: "Extend",
    noAwaySchedules: "No upcoming or active Away periods.",
    homeNoAway: "Home · no Away period scheduled",
    awayUntil: "Away until {time}",
    nextAway: "Next Away period {from}–{until}",
    awayPeriodSaved: "Away period scheduled",
    awayPeriodUpdated: "Away period updated",
    awayPeriodDeleted: "Away period deleted",
    awayPeriodEnded: "Welcome home. Away period ended.",
    awayPeriodExtended: "Away period extended",
    confirmDeleteAway: "Delete this scheduled Away period?",
    awayDemandModel: "Away demand model",
    awayDemandNotScheduled: "No Away period in this plan",
    awayDemandLearned: "Learned from {days} comparable Away days",
    awayDemandMixed: "Mixed estimate · {days} comparable Away days",
    awayDemandLow: "Low-confidence estimate · normal low-demand fallback",
    awayTimelineDetail: "Away ({confidence})",
    chargingAutomation: "Charging Automation",
    adaptiveChargingHelp: "Automatically plans discounted charging using demand history, solar forecasts, battery state, electricity rates, and live safety limits.",
    adaptiveChargingSettingsHelp: "Configure the forecasts and limits used by charging automation.",
    enableAdaptiveCharging: "Enable adaptive charging",
    latitude: "Latitude",
    longitude: "Longitude",
    arrayPeakCapacity: "Array peak capacity (kW)",
    panelTilt: "Panel tilt (degrees)",
    panelAzimuth: "Panel azimuth (0 south, -90 east, 90 west)",
    systemLoss: "Initial system loss (%)",
    sunsetSocTarget: "Maximum off-peak SOC target (%)",
    forecastMargin: "Forecast confidence margin (%)",
    saveAdaptiveCharging: "Save Adaptive Charging",
    adaptiveChargingSaved: "Adaptive Charging settings saved",
    openAdaptiveCharging: "Open Adaptive Charging",
    recalculatePlan: "Recalculate",
    recalculatingPlan: "Recalculating...",
    resumeAdaptiveCharging: "Resume Adaptive Charging",
    configure: "Configure",
    nextAction: "Next action",
    currentSoc: "Current SOC",
    nextTargetSoc: "Next target SOC",
    planHorizon: "Plan horizon",
    planInputs: "Plan inputs",
    forecastThrough: "Forecast totals through {time}",
    forecastHorizonUnavailable: "Forecast horizon will appear after a plan is calculated.",
    forecastAge: "Forecast age",
    predictedSolar: "Predicted solar",
    predictedFuelCell: "Predicted Ene-Farm",
    fuelCellForecastModel: "Ene-Farm forecast model",
    predictedDemand: "Predicted demand",
    predictedSurplus: "Predicted surplus",
    plannedGridCharge: "Planned grid charge",
    expectedStoredCharge: "Expected battery storage",
    expectedSunsetSoc: "Expected sunset SOC",
    batteryModelStatus: "Battery model",
    batteryModelDetails: "Battery model details",
    batteryModelCandidateNote: "Candidate values remain informational until validation is complete.",
    chargeEnergyModel: "Charge energy model",
    dischargeEnergyModel: "Discharge energy model",
    chargePowerModel: "Charge power model",
    batteryModelLearning: "Learning",
    batteryModelValidating: "Validating",
    batteryModelActive: "Learned model active",
    batteryModelDegraded: "Configured fallback after drift",
    configuredModelValue: "Configured {value}",
    activeConfiguredModelValue: "Active configured {value}",
    learnedModelValue: "Active learned {value}",
    candidateModelValue: "candidate {value} (not used)",
    validatedCandidateModelValue: "validated candidate {value}",
    batteryModelProgress: "{count} observations · {days} days · {points} SOC points",
    batteryModelValidation: "validation MAE {value} SOC points",
    batteryModelActivatedAt: "activated {value}",
    batteryModelDemotedAt: "demoted {value}",
    postMigrationChargeSamples: "{count} post-migration samples",
    batteryBlockerObservations: "{count} more eligible observations required",
    batteryBlockerDays: "{count} more distinct days required",
    batteryBlockerSocPoints: "{count} more SOC points required",
    batteryBlockerDispersion: "dispersion {value}% exceeds {limit}%",
    batteryBlockerStability: "rolling stability must be within {limit}%",
    batteryBlockerAcceptance: "valid observation acceptance {value}% is below 60%",
    batteryBlockerValidations: "{count} more forward validations required",
    batteryBlockerMeanError: "validation mean error exceeds 3 SOC points",
    batteryBlockerBias: "validation bias exceeds 2 SOC points",
    batteryBlockerMaximumError: "validation maximum error exceeds 6 SOC points",
    batteryBlockerPowerSamples: "{count} more post-migration steady samples required",
    batteryBlockerPowerSessions: "{count} more charging sessions required",
    batteryBlockerPowerDays: "{count} more distinct days required",
    batteryBlockerPowerDispersion: "charge-power dispersion must be within 3%",
    demandHistoryModel: "Demand history model",
    recentAndSeasonalHistory: "{days} recent days + {years} seasonal years ({percent}% seasonal)",
    recentHistoryOnly: "{days} recent days",
    adaptiveChargingWaitingForHeadroom: "Waiting for breaker headroom ({current} W; must be at or below {threshold} W before charging)",
    adaptiveChargingState: "Adaptive Charging state",
    adaptiveChargingConfidence: "Forecast confidence",
    calibratedForecast: "calibrated",
    initialForecastModel: "initial model",
    solarForecastAccuracy: "Solar Forecast Accuracy",
    solarForecastAccuracyHelp: "Compare each issued solar forecast with recorded generation. The planning estimate includes the configured confidence margin.",
    forecastBiasCorrection: "Forecast bias correction",
    completedForecastDays: "Completed forecast days",
    meanAbsoluteForecastError: "Mean absolute error",
    date: "Date",
    issuedForecast: "Issued forecast",
    planningEstimate: "Planning estimate",
    actualGeneration: "Actual generation",
    forecastError: "Error",
    forecastBiasLearning: "Learning · {count}/5 valid days",
    forecastBiasApplied: "{value}% correction · {count} valid days",
    forecastAccuracyEarly: "Early estimate based on {count}/5 valid days. Percentage accuracy is withheld until calibration has enough observations.",
    forecastAccuracyEstablished: "Accuracy is based on {count} valid days and now informs forecast calibration.",
    noSolarForecastOutcomes: "Completed forecast outcomes will appear after a full day of well-covered solar data.",
    fuelCellForecastAccuracy: "Ene-Farm Forecast Outcomes",
    fuelCellForecastAccuracyHelp: "Compare completed 30-minute forecasts with recorded generation. Observe-mode forecasts remain informational and never change charging plans.",
    completedForecastIntervals: "Completed forecast intervals",
    forecastBias: "Forecast bias",
    forecastRange: "Forecast range",
    medianForecast: "Median forecast",
    plannerInfluence: "Planner influence",
    noFuelCellForecastOutcomes: "Completed Ene-Farm forecast outcomes will appear after recorded generation covers a forecast interval.",
    onSiteGeneration: "On-site generation",
    selectedRateWindows: "Discounted window plan",
    windowTarget: "target",
    solarHeadroom: "solar headroom",
    bridgeCharge: "bridge to cheaper period",
    laterWindowBackfill: "extra charge carried into a later window",
    predictedStartSoc: "Predicted start SOC",
    predictedEndSoc: "Predicted end SOC",
    requiredCharge: "Required charge",
    availableCharge: "Available charge",
    plannedCharge: "Planned charge",
    plannedChargingRange: "Planned charging",
    noChargingPlanned: "No charging planned",
    remainingShortfall: "Remaining shortfall",
    recentWindowResults: "Recent window results",
    deliveredCharge: "Delivered charge",
    breakerInterruptions: "Breaker interruptions",
    startingSoc: "Starting SOC",
    endingSoc: "Ending SOC",
    inProgress: "In progress",
    noWindowResults: "No completed discounted windows yet.",
    chargeSamples: "{count} samples",
    estimatedEfficiency: "estimated storage {value}%",
    demandImpact: "demand effect {value} W/kW",
    decisionLog: "Decision log",
    forecastDataAttribution: "Weather forecasts:",
    schedulesDisabledByAdaptiveCharging: "Schedules are preserved but disabled while adaptive charging is enabled.",
    noPlannedWindows: "No discounted charging windows selected.",
    noAdaptiveChargingLog: "No Adaptive Charging decisions yet.",
    adaptiveChargingNeedsRates: "Off-Peak or Multi-Rate pricing is required.",
    adaptiveChargingNeedsSolar: "Solar generation must be enabled.",
    adaptiveChargingNeedsDemand: "Overall house demand must be enabled.",
    adaptiveChargingNeedsLocation: "Latitude and longitude are required.",
    adaptiveChargingNeedsArray: "Array peak capacity is required.",
    adaptiveChargingNeedsBattery: "Usable battery capacity and maximum charge watts are required.",
    adaptiveChargingCharging: "Charging",
    adaptiveChargingReady: "Ready",
    adaptiveChargingReadyPartial: "Ready - charging as much as discounted windows allow",
    adaptiveChargingDisabled: "Disabled",
    adaptiveChargingUnavailable: "Unavailable",
    nextAdaptiveCharge: "Next charge {time} · {energy} Wh",
    chargingUntil: "Charging until {time}",
    chargingTimeline: "Charging Timeline",
    chargingTimelineHelp: "Forecast demand, solar generation, battery state, rates, and planned charging.",
    plannedCharging: "Planned charging",
    noChargingTimeline: "A timeline will appear after a charging plan is calculated.",
    rateMode: "Rate Mode",
    rateModeSimple: "Simple",
    rateModeOffPeak: "Off-Peak",
    rateModeMulti: "Multi-Rate",
    simpleRate: "Rate (yen/kWh)",
    standardRate: "Standard rate (yen/kWh)",
    offPeakRate: "Off-peak rate (yen/kWh)",
    offPeakSavingsEnabled: "Calculate off-peak battery charging savings",
    addRateBand: "Add rate band",
    removeRateBand: "Remove",
    rateBandLabel: "Label",
    rateBandStart: "Start",
    rateBandEnd: "End",
    rateBandPrice: "Yen/kWh",
    saveRates: "Save Rates",
    co2Release: "CO2 Release",
    co2ReleaseFactor: "Average CO2 emitted (t-CO2/kWh)",
    dataSource: "Data Source",
    saveCo2Release: "Save CO2 Release",
    co2ReleaseSaved: "CO2 release saved",
    historyRetention: "History Retention",
    rawTelemetryRetention: "Raw telemetry (days)",
    intervalRetention: "30-minute aggregates (days)",
    dailyRetention: "Daily aggregates (days)",
    adaptiveChargingRetention: "Adaptive Charging history (days)",
    automationRetention: "Automation history (days)",
    notificationRetention: "Notification deliveries (days)",
    keepIndefinitely: "Keep indefinitely",
    automaticMaintenance: "Run retention maintenance automatically",
    intervalAggregates: "30-minute aggregates",
    dailyAggregates: "Daily aggregates",
    storedEvents: "Stored events",
    saveRetention: "Save Retention",
    trimHistoryNow: "Trim history now",
    historyTrimmed: "History trimmed",
    databaseBackups: "Database Backups",
    databaseBackupsHelp: "Create, restore, or delete local compressed database backups.",
    createDatabaseBackup: "Create Backup",
    databaseRestoreSafetyHelp: "Restoring automatically creates a safety backup of the current database first. Only backups matching this application database version can be restored.",
    currentDatabaseVersion: "Current application DB version",
    backupCreated: "Created",
    backupType: "Type",
    backupVersion: "DB Version",
    backupSize: "Size",
    actions: "Actions",
    restoreBackup: "Restore",
    deleteBackup: "Delete",
    noDatabaseBackups: "No database backups have been created.",
    backupTypeManual: "Manual",
    backupTypePreUpgrade: "Before upgrade",
    backupTypePreRestore: "Before restore",
    backupTypeUnknown: "Unknown",
    incompatibleBackup: "Backup DB version v{version} does not match current application DB version v{currentVersion}",
    unknownBackupVersion: "Backup DB version is unknown",
    confirmRestoreDatabase: "Restore {filename}? The current database will be backed up first and briefly unavailable.",
    confirmDeleteDatabaseBackup: "Permanently delete {filename}?",
    databaseBackupCreated: "Database backup created",
    databaseBackupDeleted: "Database backup deleted",
    databaseBackupRestored: "Database restored",
    databaseOperationPreparing: "Preparing",
    databaseOperationCopying: "Copying database",
    databaseOperationValidating: "Validating backup",
    databaseOperationCompressing: "Compressing backup",
    databaseOperationDecompressing: "Decompressing backup",
    databaseOperationSafetyBackup: "Backing up current database",
    databaseOperationStopping: "Pausing application",
    databaseOperationRestoring: "Restoring database",
    databaseOperationRestarting: "Restarting application",
    databaseOperationDeleting: "Deleting backup",
    databaseOperationComplete: "Complete",
    databaseOperationFailed: "Failed",
    installedEquipment: "Installed Equipment",
    solarEnabled: "Show solar generation",
    fuelCellEnabled: "Show Ene-Farm generation and status",
    fuelCellPrimaryHost: "Ene-Farm primary device",
    fuelCellProxyHosts: "Smart Cosmo fallback proxies",
    fuelCellSettings: "Ene-Farm",
    fuelCellSettingsHelp: "Configure generation automation, reporting, and gas estimates.",
    fuelCellAutomation: "Ene-Farm Automation",
    enableFuelCellAutomation: "Enable Ene-Farm automation",
    fuelCellAutomationHelp: "Outside scheduled windows, generation is kept off using お出かけ停止. Adaptive Charging can use the schedule as a forecast input but never controls the Ene-Farm.",
    spoolUpOffset: "Start request offset (minutes)",
    fuelCellSpoolUpHelp: "The start request is sent this many minutes before the displayed generation window. The stop request remains at the window end.",
    hotWaterStartLimit: "Prevent start at or above hot-water level",
    stopFuelCellDuringOffPeak: "Stop generation during discounted electricity rate periods",
    includeFuelCellInAdaptiveCharging: "Include predicted Ene-Farm generation in Adaptive Charging",
    fuelCellGenerationWindows: "Generation windows",
    fuelCellAutomationDisabled: "Ene-Farm automation is disabled.",
    fuelCellAutomationWaiting: "Waiting for the next automation check.",
    noFuelCellAutomationLog: "No Ene-Farm automation decisions have been recorded.",
    plannerInfluence: "Planner influence",
    active: "Active",
    off: "Off",
    gasCo2Factor: "City gas emissions (kg-CO2/m³)",
    gasProvider: "Gas provider",
    gasRegion: "Gas region",
    gasPlan: "Gas plan",
    meterReadingDay: "Meter reading day",
    equipmentDiscount: "Optional equipment discount",
    tokyoGasTokyoRegion: "Tokyo district and surrounding areas",
    tokyoGasGunmaRegion: "Gunma district",
    tokyoGasEneFarmPlan: "Ene-Farm generation eco plan",
    noOptionalDiscount: "No optional discount",
    eneFarmBathDiscount: "Ene-Farm + Bath heating discount",
    eneFarmFloorDiscount: "Ene-Farm + Floor heating discount (winter only)",
    eneFarmCombinedDiscount: "Ene-Farm + Combined bath/floor discount",
    eneFarmOnlyGasAssumption: "Cost estimates treat recorded Ene-Farm gas as the household's total gas use for the billing period. Gas used by cooktops, heaters, boilers, or other appliances is not included.",
    gasSeasonAutomaticHelp: "Tokyo Gas winter rates are selected automatically for December through April billing months.",
    marginalRateOverride: "Marginal rate override (yen/m³)",
    automaticTariffUpdates: "Automatically import monthly Tokyo Gas tariffs",
    addWindow: "Add Window",
    saveFuelCellSettings: "Save Ene-Farm Settings",
    gasTariffData: "Gas Tariff Data",
    billingMonth: "Billing month",
    season: "Season",
    otherSeason: "Other season",
    winter: "Winter",
    importPublishedTariff: "Import Published Tariff",
    tokyoGasTariffSource: "Tokyo Gas tariff source",
    exactCounter: "Exact counter",
    integratedEstimate: "Integrated estimate",
    mixedQuality: "Mixed exact and estimated data",
    battery: "Battery",
    homePowerMeter: "Home power meter",
    solar: "Solar",
    fuelCell: "Ene-Farm",
    discoverySubnets: "Discovery subnets",
    optional: "optional",
    saveAddresses: "Save Addresses",
    autoDiscovery: "Auto-Discovery",
    scanNetwork: "Scan Network",
    broadcastDiscovery: "Broadcast Discovery",
    activeSubnetScan: "Active Subnet Scan",
    scanning: "Scanning...",
    scanningNearby: "Scanning nearby devices...",
    discoveryStarting: "Starting discovery",
    discoveryBroadcast: "Listening for device announcements",
    discoveryActiveScan: "Scanning subnet addresses",
    discoveryWaiting: "Waiting for device replies",
    discoveryIdentifying: "Identifying device roles",
    discoveryComplete: "Discovery complete",
    discoveryFailed: "Discovery failed",
    discoveryProgressCount: "{scanned} of {total} addresses checked",
    discoveryFoundCount: "{count} devices found",
    discoveryElapsed: "{seconds}s elapsed",
    noDevicesFound: "No devices found.",
    likelyRole: "Likely role",
    services: "Services",
    address: "Address",
    useSuggestedAddresses: "Use Suggested Addresses",
    schedules: "Schedules",
    action: "Action",
    repeat: "Repeat",
    once: "Once",
    daily: "Daily",
    days: "Days",
    daySun: "Sun",
    dayMon: "Mon",
    dayTue: "Tue",
    dayWed: "Wed",
    dayThu: "Thu",
    dayFri: "Fri",
    daySat: "Sat",
    time: "Time",
    createSchedule: "Create Schedule",
    when: "When",
    details: "Details",
    status: "Status",
    everyDay: "Every day",
    noSchedules: "No schedules yet.",
    waiting: "Waiting",
    running: "Running",
    disabled: "Disabled",
    paused: "Paused",
    pause: "Pause",
    resume: "Resume",
    lastRan: "Last ran",
    savedAddresses: "Saved device addresses",
    suggestedLoaded: "Suggested addresses loaded. Save to apply them.",
    chooseProfile: "Choose a charging profile first.",
    chooseScheduleTime: "Choose a schedule time.",
    scheduleCreated: "Schedule created",
    serviceOnline: "Service online",
    historicalData: "Historical data",
    backgroundRefresh: "Background refresh",
    readFailed: "Read failed",
    readingDevices: "Reading devices",
    unavailable: "Unavailable",
    today: "Today",
    selectedRange: "Selected range",
    notSet: "Not set",
    rangeTotal: "Total over range",
    rangeAverage: "Average over range",
    batteryChargedLabel: "Charged",
    batteryDischargedLabel: "Discharged",
    databaseSize: "Database size",
    daysRecorded: "Days recorded",
    samplesRecorded: "Samples recorded",
    now: "Now",
    minAgo: "30m ago",
    timeAxis: "Time",
    wattsAxis: "Power (W)",
    percentAxis: "Charge (%)",
    profileOsaifu: "osaifu",
    profileEco: "eco",
    profileBackup: "backup",
    operationAuto: "auto",
    operationStandby: "standby",
    operationRapid: "rapid charge",
    operationCharge: "charging",
    operationDischarge: "discharging",
    startHour: "Start hour",
    endHour: "End hour",
    percent: "Percent",
    charging: "charging",
    discharging: "discharging",
    standby: "standby",
    auto: "auto",
    generating: "generating",
    stopped: "stopped",
    starting: "starting",
    stopping: "stopping",
    rapid_charging: "rapid charging",
    on: "on",
    off: "off",
    chargeAction: "Charge with optional target Wh",
    dischargeAction: "Discharge with optional target Wh",
    setAutoAction: "Set operation auto",
    setStandbyAction: "Set operation standby",
    setRapidAction: "Set operation rapid charge",
    setChargeAction: "Set operation charging",
    setDischargeAction: "Set operation discharging",
    setProfileAction: "Set charging profile",
    setLimitAction: "Set discharge limit",
    setChargeWindowAction: "Set charge window",
    setDischargeWindowAction: "Set discharge window",
    setOperationModeAction: "Set operation mode",
    automationRules: "Automation Rules",
    backupDemandGuard: "Charging Demand Guard",
    backupGuardEnabled: "Enable charging demand guard",
    breakerAmps: "Breaker amps",
    reserveAmps: "Reserve amps",
    batteryChargeEstimate: "Maximum battery charge watts",
    restoreBelowAmps: "Restore below amps",
    restoreDelay: "Restore delay seconds",
    saveAutomation: "Save Automation",
    automationSaved: "Automation saved",
    automationNoRules: "No automation rules saved.",
    automationNoLog: "No guard events logged yet.",
    guardLog: "Guard log",
  },
  ja: {
    brand: "ホームエネルギー <strong>& バッテリー</strong>",
    navDashboard: "ダッシュボード",
    navGraphs: "グラフ",
    navAdaptiveCharging: "適応充電",
    navAdaptiveChargingShort: "充電",
    navReports: "レポート",
    navSettings: "設定",
    liveDashboard: "ライブ表示",
    homeEnergyFlow: "家庭内の電力フロー",
    from: "開始",
    to: "終了",
    showRange: "範囲を表示",
    live: "ライブ",
    graphAnalysis: "グラフ分析",
    loadGraphRange: "グラフを読み込む",
    loadingGraphData: "グラフデータを読み込み中",
    fetchingGraphRecords: "レコードを取得中...",
    parsedGraphRecords: "{parsed} / {total} レコード解析済み",
    loadingReportData: "レポートデータを読み込み中",
    fetchingReportRecords: "レポートレコードを集計中...",
    parsedReportRecords: "{parsed} レコードを読み取り済み",
    graphRecordCount: "{count} レコード",
    last1Hour: "直近1時間",
    last8Hours: "直近8時間",
    last24Hours: "直近24時間",
    last3Days: "直近3日",
    last7Days: "直近7日",
    last30Days: "直近30日",
    last3Months: "直近3か月",
    last6Months: "直近6か月",
    lastYear: "直近1年",
    energyReports: "エネルギーレポート",
    exactUsageReports: "電力使用量",
    reportsHelp: "日・週・月ごとの正確な使用量合計を比較します。",
    reportMode: "レポート単位",
    dailyReport: "日別",
    weeklyReport: "週別",
    monthlyReport: "月別",
    last8Weeks: "直近8週",
    last26Weeks: "直近26週",
    last12Months: "直近12か月",
    loadReport: "レポートを読み込む",
    usageKwh: "使用量",
    usageKwhHelp: "家庭内消費",
    gridImportHelp: "買電量",
    solarCoverage: "太陽光カバー率",
    sentToGrid: "送電量",
    peakDemand: "最大需要",
    usageTrend: "使用量トレンド",
    exactKwhTable: "期間別エネルギー",
    period: "期間",
    change: "増減",
    noReportData: "レポートデータはまだ読み込まれていません。",
    reportBucketCount: "{count} 期間",
    trendWidgets: "電力トレンド",
    statusWidgets: "状態と統計",
    circuitWidgets: "スマートコスモ回路",
    circuitPower: "回路",
    circuit: "回路",
    circuitSettings: "スマートコスモ回路",
    circuitSettingsHelp: "現在の需要（W）または累積使用電力量（kWh）で並べ替えます。",
    circuitSort: "回路の並び替え",
    circuitSortByNumber: "回路番号",
    circuitSortByCurrent: "現在の需要（多い順）",
    circuitSortByAccumulated: "累積使用電力量（多い順）",
    saveCircuitSettings: "回路設定を保存",
    circuitSettingsSaved: "回路設定を保存しました",
    noCircuitData: "回路データはまだありません。",
    smartCosmoMeter: "スマートコスモ / 家庭内電力メーター",
    smartCosmoEnabled: "スマートコスモ / 家庭内電力メーターを表示",
    batteryPower: "蓄電池の電力",
    stateOfCharge: "蓄電池残量",
    batteryWorkingStatus: "蓄電池の動作状態",
    operationMode: "運転モード",
    chargingProfile: "充電プロファイル",
    profile: "プロファイル",
    mode: "モード",
    dischargeLimit: "放電下限",
    solarGeneration: "太陽光発電",
    solarSavings: "太陽光の推定節約額",
    co2Savings: "CO2削減量",
    offPeakSavings: "夜間充電の推定節約額",
    powerImported: "買電量",
    powerExported: "売電量",
    guardTriggerCount: "ブレーカー落ちガード作動回数",
    energySources: "エネルギー供給内訳",
    fuelCellStateTimeline: "本日のエネファーム運転履歴",
    fuelCellContribution: "エネファームの供給分",
    fuelCellStateGenerating: "発電中",
    fuelCellStateStarting: "起動中",
    fuelCellStateStopping: "停止処理中",
    fuelCellStateIdling: "待機中",
    fuelCellStateStopped: "停止中",
    peakGridEnergy: "通常・ピーク時間帯の買電",
    offPeakGridEnergy: "割安時間帯の買電",
    solarUsedOnSite: "太陽光の供給分",
    includesBatteryCharging: "蓄電池充電を含む",
    houseDemand: "家庭内消費",
    gridImport: "買電",
    gridExport: "売電",
    fuelCellGeneration: "エネファーム発電",
    fuelCellStatus: "エネファーム状態",
    fuelCellOperation: "エネファーム運転状況",
    fuelCellHotWater: "エネファーム残湯量",
    hotWaterLevel: "残湯量",
    hotWaterPercent: "{percent}%（目安）",
    hotWaterLevelHelp: "約45℃以上のお湯の目安",
    startManualFuelCellGeneration: "手動発電を開始",
    confirmManualFuelCellGeneration: "エネファームの手動発電を開始しますか？ 起動には約40分かかる場合があり、ガスを使用します。",
    manualFuelCellGenerationRequested: "エネファームの手動発電を要求しました",
    electricityToday: "本日の発電量",
    gasToday: "本日のガス使用量",
    operatingTime: "運転時間",
    starts: "起動回数",
    timeInState: "現在状態の継続時間",
    lastStop: "最終停止",
    reportType: "レポート種類",
    energyUsage: "電力使用量",
    eneFarmReports: "エネファーム実績",
    eneFarmReportsHelp: "期間ごとの発電、ガス使用、運転時間、推定コスト、CO2を比較します。",
    generatedElectricity: "発電電力量",
    gasConsumed: "ガス使用量",
    exactCounterOnly: "積算値データのみ",
    electricalYield: "発電効率",
    generationCoverage: "需要に対する発電割合",
    estimatedMarginalGasCost: "推定ガス従量料金",
    allocatedGasCost: "推定基本料金配賦後コスト",
    verifyProviderBill: "正確な料金はガス会社の請求書をご確認ください",
    standingChargeScenario: "完全な検針期間では基本料金を配賦",
    electricityCarbonBalance: "発電のみのCO2収支",
    heatNotMeasured: "排熱利用は計測されていません",
    eneFarmByPeriod: "期間別エネファーム",
    estimateNotice: "料金と節約額はすべて推定値です。正確な請求額は契約先にご確認ください。",
    carbonBalance: "CO2収支",
    batterySettings: "蓄電池設定",
    chargingProfileHelp:
      "コントローラーが使う蓄電池の動作プロファイルを選びます。",
    dischargeLimitHelp: "あとで使うために残しておく最低残量です。",
    chargeWindow: "おサイフ充電時間帯",
    chargeWindowHelp: "おサイフモードで充電を許可する時間帯です。",
    dischargeWindow: "おサイフ放電時間帯",
    dischargeWindowHelp: "おサイフモードで放電を許可する時間帯です。",
    directAction: "即時操作",
    directActionHelp:
      "蓄電池にすぐ実行する指示を送ります。充電・放電では目標電力量を任意で指定できます。",
    set: "設定",
    run: "実行",
    targetWh: "目標Wh",
    deviceAddresses: "機器アドレス",
    preferences: "表示設定",
    preferencesRates: "表示・料金設定",
    dashboardLayout: "ダッシュボード配置",
    saveDashboardLayout: "ダッシュボード配置を保存",
    resetDashboardLayout: "ダッシュボード配置をリセット",
    dashboardLayoutSaved: "ダッシュボード配置を保存しました",
    dashboardLayoutReset: "ダッシュボード配置をリセットしました",
    visible: "表示",
    priority: "優先順位",
    dataDiscovery: "データと自動検出",
    dataRetention: "保存期間",
    language: "言語",
    updateInterval: "更新間隔（秒）",
    savePreferences: "表示設定を保存",
    preferencesSaved: "表示設定を保存しました",
    notifications: "通知",
    notificationsHelp: "重要なシステム・自動化イベントをメールで送信します。",
    enableNotifications: "通知を有効にする",
    smtpEmail: "メール (SMTP)",
    smtpHost: "SMTPサーバー",
    smtpPort: "ポート",
    smtpSecurity: "セキュリティ",
    smtpStarttls: "STARTTLS",
    smtpTls: "TLS",
    smtpNone: "なし（信頼できるローカルサーバー）",
    smtpUsername: "ユーザー名",
    smtpPassword: "パスワード",
    smtpPasswordPlaceholder: "空欄なら変更なし",
    smtpFrom: "送信元アドレス",
    smtpRecipients: "宛先（カンマ区切り）",
    smtpClearPassword: "保存済みパスワードを削除",
    notificationTriggers: "通知条件",
    notificationCooldown: "再通知間隔（分）",
    triggerGuardActivated: "デマンドガード作動",
    triggerGuardRestored: "デマンドガード復旧",
    triggerScheduleFailed: "スケジュール失敗",
    triggerDeviceOffline: "機器応答なし",
    triggerDeviceRecovered: "機器復旧",
    triggerAdaptiveChargingUnavailable: "適応充電が利用不可",
    triggerAdaptiveChargingRecovered: "適応充電が復旧",
    triggerAdaptiveChargingWindowShortfall: "充電時間帯の不足",
    triggerLowBattery: "蓄電池残量低下",
    notificationSocThreshold: "充電率しきい値 (%)",
    saveNotifications: "通知設定を保存",
    notificationsSaved: "通知設定を保存しました",
    sendTestNotification: "テストメールを送信",
    testNotificationSent: "テストメールを送信しました",
    notificationDeliveryLog: "最近の送信履歴",
    noNotificationDeliveries: "通知送信履歴はまだありません。",
    notificationSuccess: "送信済み",
    notificationFailure: "失敗",
    passwordConfigured: "パスワードは保存済みです。",
    passwordNotConfigured: "パスワードは保存されていません。",
    electricityRates: "電気料金",
    batteryCapabilities: "蓄電池性能",
    usableBatteryCapacity: "使用可能な蓄電容量 (kWh)",
    maximumBatteryChargeWatts: "最大蓄電池充電電力 (W)",
    saveBatteryCapabilities: "蓄電池性能を保存",
    batteryCapabilitiesSaved: "蓄電池性能を保存しました",
    adaptiveCharging: "適応充電",
    awayStatus: "外出状況",
    awayPeriods: "外出期間",
    awaySchedule: "外出予定",
    awayScheduleHelp: "外出予定を需要予測に反映し、完了した期間は今後の学習に利用します。",
    away: "外出中",
    home: "在宅",
    now: "現在",
    until: "帰宅予定",
    scheduleAway: "外出予定を追加",
    saveAwayChanges: "変更を保存",
    saveAwayExtension: "延長を保存",
    cancel: "キャンセル",
    status: "状態",
    scheduled: "予定",
    observed: "実績ベース",
    active: "外出中",
    edit: "編集",
    delete: "削除",
    backHome: "帰宅",
    extend: "延長",
    noAwaySchedules: "予定中または実行中の外出はありません。",
    homeNoAway: "在宅 · 外出予定なし",
    awayUntil: "{time}まで外出中",
    nextAway: "次の外出 {from}～{until}",
    awayPeriodSaved: "外出予定を追加しました",
    awayPeriodUpdated: "外出予定を更新しました",
    awayPeriodDeleted: "外出予定を削除しました",
    awayPeriodEnded: "帰宅しました。外出期間を終了しました。",
    awayPeriodExtended: "外出期間を延長しました",
    confirmDeleteAway: "この外出予定を削除しますか？",
    awayDemandModel: "外出時需要モデル",
    awayDemandNotScheduled: "この計画に外出期間はありません",
    awayDemandLearned: "比較可能な外出日{days}日から学習",
    awayDemandMixed: "混合予測 · 比較可能な外出日{days}日",
    awayDemandLow: "低信頼予測 · 通常時の低需要値を使用",
    awayTimelineDetail: "外出中 ({confidence})",
    chargingAutomation: "充電自動化",
    adaptiveChargingHelp: "需要履歴、太陽光予報、蓄電池状態、電気料金、リアルタイムの安全制限を使って割安な充電を自動計画します。",
    adaptiveChargingSettingsHelp: "充電自動化で使用する予報と制限を設定します。",
    enableAdaptiveCharging: "適応充電を有効にする",
    latitude: "緯度",
    longitude: "経度",
    arrayPeakCapacity: "太陽光パネル最大容量 (kW)",
    panelTilt: "パネル傾斜角 (度)",
    panelAzimuth: "パネル方位角 (南0、東-90、西90)",
    systemLoss: "初期システム損失 (%)",
    sunsetSocTarget: "割安時間帯の最大充電率目標 (%)",
    forecastMargin: "予測信頼余裕 (%)",
    saveAdaptiveCharging: "適応充電設定を保存",
    adaptiveChargingSaved: "適応充電設定を保存しました",
    openAdaptiveCharging: "適応充電を開く",
    recalculatePlan: "再計算",
    recalculatingPlan: "再計算中...",
    resumeAdaptiveCharging: "適応充電を再開",
    configure: "設定",
    nextAction: "次の動作",
    currentSoc: "現在の充電率",
    nextTargetSoc: "次の目標充電率",
    planHorizon: "計画期間",
    planInputs: "計画入力",
    forecastThrough: "{time}までの予測合計",
    forecastHorizonUnavailable: "計画が計算されると予測期間が表示されます。",
    forecastAge: "予報の経過時間",
    predictedSolar: "予測太陽光発電量",
    predictedFuelCell: "予測エネファーム発電",
    fuelCellForecastModel: "エネファーム予測モデル",
    predictedDemand: "予測使用電力量",
    predictedSurplus: "予測余剰電力量",
    plannedGridCharge: "予定買電充電量",
    expectedStoredCharge: "蓄電池への予測蓄電量",
    expectedSunsetSoc: "予測日没時充電率",
    batteryModelStatus: "蓄電池モデル",
    batteryModelDetails: "蓄電池モデルの詳細",
    batteryModelCandidateNote: "候補値は検証が完了するまで情報表示のみで、計画には使用されません。",
    chargeEnergyModel: "充電エネルギーモデル",
    dischargeEnergyModel: "放電エネルギーモデル",
    chargePowerModel: "充電電力モデル",
    batteryModelLearning: "学習中",
    batteryModelValidating: "検証中",
    batteryModelActive: "学習済みモデルを使用中",
    batteryModelDegraded: "精度低下のため設定値に復帰",
    configuredModelValue: "設定値 {value}",
    activeConfiguredModelValue: "使用中の設定値 {value}",
    learnedModelValue: "使用中の学習値 {value}",
    candidateModelValue: "候補 {value} (計画には未使用)",
    validatedCandidateModelValue: "検証済み候補 {value}",
    batteryModelProgress: "観測{count}件 · {days}日 · SOC変化{points}ポイント",
    batteryModelValidation: "検証MAE {value} SOCポイント",
    batteryModelActivatedAt: "有効化 {value}",
    batteryModelDemotedAt: "設定値へ復帰 {value}",
    postMigrationChargeSamples: "移行後{count}件の測定",
    batteryBlockerObservations: "有効な観測があと{count}件必要",
    batteryBlockerDays: "異なる日付の観測があと{count}日必要",
    batteryBlockerSocPoints: "SOC変化があと{count}ポイント必要",
    batteryBlockerDispersion: "ばらつき{value}%が上限{limit}%を超過",
    batteryBlockerStability: "直近の安定性を{limit}%以内にする必要あり",
    batteryBlockerAcceptance: "有効観測率{value}%が60%未満",
    batteryBlockerValidations: "将来データによる検証があと{count}件必要",
    batteryBlockerMeanError: "検証平均誤差がSOC 3ポイントを超過",
    batteryBlockerBias: "検証バイアスがSOC 2ポイントを超過",
    batteryBlockerMaximumError: "検証最大誤差がSOC 6ポイントを超過",
    batteryBlockerPowerSamples: "移行後の安定測定があと{count}件必要",
    batteryBlockerPowerSessions: "充電セッションがあと{count}回必要",
    batteryBlockerPowerDays: "異なる日付の測定があと{count}日必要",
    batteryBlockerPowerDispersion: "充電電力のばらつきを3%以内にする必要あり",
    demandHistoryModel: "需要履歴モデル",
    recentAndSeasonalHistory: "直近{days}日 + 過去年同時期{years}年分 (季節データ{percent}%)",
    recentHistoryOnly: "直近{days}日",
    adaptiveChargingWaitingForHeadroom: "ブレーカー容量待機中 ({current} W、充電開始前に{threshold} W以下が必要)",
    adaptiveChargingState: "適応充電状態",
    adaptiveChargingConfidence: "予測信頼度",
    calibratedForecast: "学習済み",
    initialForecastModel: "初期モデル",
    solarForecastAccuracy: "太陽光発電予測の精度",
    solarForecastAccuracyHelp: "発行時の太陽光発電予測と実際の発電量を比較します。計画値には設定した予測信頼余裕が含まれます。",
    forecastBiasCorrection: "予測偏差の補正",
    completedForecastDays: "完了した予測日数",
    meanAbsoluteForecastError: "平均絶対誤差",
    date: "日付",
    issuedForecast: "発行時予測",
    planningEstimate: "計画用予測",
    actualGeneration: "実際の発電量",
    forecastError: "誤差",
    forecastBiasLearning: "学習中 · 有効日数 {count}/5日",
    forecastBiasApplied: "{value}%補正 · 有効日数 {count}日",
    forecastAccuracyEarly: "初期推定です。有効日数は{count}/5日で、十分な観測が集まるまで精度の割合は表示しません。",
    forecastAccuracyEstablished: "有効日数{count}日に基づく精度で、予測補正に反映されています。",
    noSolarForecastOutcomes: "十分な太陽光データが一日分記録されると、完了した予測実績が表示されます。",
    fuelCellForecastAccuracy: "エネファーム予測結果",
    fuelCellForecastAccuracyHelp: "完了した30分予測と実測発電量を比較します。観察モードの予測は情報表示のみで、充電計画には影響しません。",
    completedForecastIntervals: "完了した予測区間",
    forecastBias: "予測バイアス",
    forecastRange: "予測範囲",
    medianForecast: "中央値予測",
    plannerInfluence: "計画への反映",
    noFuelCellForecastOutcomes: "予測区間を実測発電データがカバーすると、エネファーム予測結果が表示されます。",
    onSiteGeneration: "自家消費発電量",
    selectedRateWindows: "割安料金帯の充電計画",
    windowTarget: "目標",
    solarHeadroom: "太陽光用空き容量",
    bridgeCharge: "より安い時間帯までのつなぎ充電",
    laterWindowBackfill: "後続時間帯の不足を補う追加充電",
    predictedStartSoc: "予測開始時充電率",
    predictedEndSoc: "予測終了時充電率",
    requiredCharge: "必要充電量",
    availableCharge: "充電可能量",
    plannedCharge: "予定充電量",
    plannedChargingRange: "予定充電時間",
    noChargingPlanned: "充電予定なし",
    remainingShortfall: "残り不足量",
    recentWindowResults: "最近の時間帯実績",
    deliveredCharge: "実績充電量",
    breakerInterruptions: "ブレーカー中断回数",
    startingSoc: "開始時充電率",
    endingSoc: "終了時充電率",
    inProgress: "実行中",
    noWindowResults: "完了した割安時間帯はまだありません。",
    chargeSamples: "{count}件の測定",
    estimatedEfficiency: "推定蓄電効率 {value}%",
    demandImpact: "需要影響 {value} W/kW",
    decisionLog: "判断ログ",
    forecastDataAttribution: "天気予報:",
    schedulesDisabledByAdaptiveCharging: "適応充電が有効な間、スケジュールは保存されたまま実行されません。",
    noPlannedWindows: "割安な充電時間帯は選択されていません。",
    noAdaptiveChargingLog: "適応充電の判断履歴はまだありません。",
    adaptiveChargingNeedsRates: "夜間料金または複数料金の設定が必要です。",
    adaptiveChargingNeedsSolar: "太陽光発電を有効にしてください。",
    adaptiveChargingNeedsDemand: "家庭全体の使用電力を有効にしてください。",
    adaptiveChargingNeedsLocation: "緯度と経度を入力してください。",
    adaptiveChargingNeedsArray: "太陽光パネル最大容量を入力してください。",
    adaptiveChargingNeedsBattery: "使用可能な蓄電容量と最大充電電力を入力してください。",
    adaptiveChargingCharging: "充電中",
    adaptiveChargingReady: "準備完了",
    adaptiveChargingReadyPartial: "準備完了 - 割引時間帯で可能な量を充電します",
    adaptiveChargingDisabled: "無効",
    adaptiveChargingUnavailable: "利用不可",
    nextAdaptiveCharge: "次回充電 {time} · {energy} Wh",
    chargingUntil: "{time}まで充電中",
    chargingTimeline: "充電タイムライン",
    chargingTimelineHelp: "予測需要、太陽光発電、蓄電池残量、料金帯、予定充電を表示します。",
    plannedCharging: "予定充電",
    noChargingTimeline: "充電計画が計算されるとタイムラインが表示されます。",
    rateMode: "料金モード",
    rateModeSimple: "シンプル",
    rateModeOffPeak: "夜間料金",
    rateModeMulti: "複数料金",
    simpleRate: "料金 (円/kWh)",
    standardRate: "通常料金 (円/kWh)",
    offPeakRate: "夜間料金 (円/kWh)",
    offPeakSavingsEnabled: "夜間充電の節約額を計算する",
    addRateBand: "料金帯を追加",
    removeRateBand: "削除",
    rateBandLabel: "ラベル",
    rateBandStart: "開始",
    rateBandEnd: "終了",
    rateBandPrice: "円/kWh",
    saveRates: "料金を保存",
    co2Release: "CO2排出係数",
    co2ReleaseFactor: "平均CO2排出量 (t-CO2/kWh)",
    dataSource: "データソース",
    saveCo2Release: "CO2排出係数を保存",
    co2ReleaseSaved: "CO2排出係数を保存しました",
    historyRetention: "電力使用データの保存期間",
    rawTelemetryRetention: "生テレメトリ (日)",
    intervalRetention: "30分集計 (日)",
    dailyRetention: "日次集計 (日)",
    adaptiveChargingRetention: "適応充電履歴 (日)",
    automationRetention: "自動化履歴 (日)",
    notificationRetention: "通知配信履歴 (日)",
    keepIndefinitely: "無期限に保存",
    automaticMaintenance: "保存期間のメンテナンスを自動実行",
    intervalAggregates: "30分集計",
    dailyAggregates: "日次集計",
    storedEvents: "保存イベント",
    saveRetention: "保存期間設定を保存",
    trimHistoryNow: "データを今すぐトリム",
    historyTrimmed: "履歴をトリムしました",
    databaseBackups: "データベースバックアップ",
    databaseBackupsHelp: "ローカルの圧縮データベースバックアップを作成、復元、削除します。",
    createDatabaseBackup: "バックアップを作成",
    databaseRestoreSafetyHelp: "復元前に現在のデータベースを自動的に安全バックアップします。このアプリと同じデータベースバージョンのバックアップのみ復元できます。",
    currentDatabaseVersion: "現在のアプリDBバージョン",
    backupCreated: "作成日時",
    backupType: "種類",
    backupVersion: "DBバージョン",
    backupSize: "サイズ",
    actions: "操作",
    restoreBackup: "復元",
    deleteBackup: "削除",
    noDatabaseBackups: "データベースバックアップはありません。",
    backupTypeManual: "手動",
    backupTypePreUpgrade: "アップグレード前",
    backupTypePreRestore: "復元前",
    backupTypeUnknown: "不明",
    incompatibleBackup: "バックアップのDBバージョンv{version}は現在のアプリDBバージョンv{currentVersion}と一致しません",
    unknownBackupVersion: "バックアップのDBバージョンが不明です",
    confirmRestoreDatabase: "{filename}を復元しますか？ 現在のデータベースを先にバックアップし、一時的に利用できなくなります。",
    confirmDeleteDatabaseBackup: "{filename}を完全に削除しますか？",
    databaseBackupCreated: "データベースバックアップを作成しました",
    databaseBackupDeleted: "データベースバックアップを削除しました",
    databaseBackupRestored: "データベースを復元しました",
    databaseOperationPreparing: "準備中",
    databaseOperationCopying: "データベースをコピー中",
    databaseOperationValidating: "バックアップを検証中",
    databaseOperationCompressing: "バックアップを圧縮中",
    databaseOperationDecompressing: "バックアップを展開中",
    databaseOperationSafetyBackup: "現在のデータベースをバックアップ中",
    databaseOperationStopping: "アプリケーションを一時停止中",
    databaseOperationRestoring: "データベースを復元中",
    databaseOperationRestarting: "アプリケーションを再開中",
    databaseOperationDeleting: "バックアップを削除中",
    databaseOperationComplete: "完了",
    databaseOperationFailed: "失敗",
    installedEquipment: "設置済み設備",
    solarEnabled: "太陽光発電を表示",
    fuelCellEnabled: "エネファーム発電・状態を表示",
    fuelCellPrimaryHost: "エネファーム本体",
    fuelCellProxyHosts: "スマートコスモのフォールバック",
    fuelCellSettings: "エネファーム",
    fuelCellSettingsHelp: "発電自動化、レポート、ガス料金推定を設定します。",
    fuelCellAutomation: "エネファーム自動化",
    enableFuelCellAutomation: "エネファーム自動化を有効にする",
    fuelCellAutomationHelp: "設定した時間帯以外は「お出かけ停止」を維持します。アダプティブ充電は予定を予測入力として利用できますが、エネファームを操作しません。",
    spoolUpOffset: "起動要求の先行時間（分）",
    fuelCellSpoolUpHelp: "表示する発電時間帯より、この分数だけ早く起動要求を送信します。停止要求は時間帯の終了時刻に送信します。",
    hotWaterStartLimit: "発電開始を抑止する残湯量（以上）",
    stopFuelCellDuringOffPeak: "電気料金の割引時間帯は発電を停止する",
    includeFuelCellInAdaptiveCharging: "エネファーム発電予測をアダプティブ充電に反映する",
    fuelCellGenerationWindows: "発電時間帯",
    fuelCellAutomationDisabled: "エネファーム自動化は無効です。",
    fuelCellAutomationWaiting: "次の自動化チェックを待っています。",
    noFuelCellAutomationLog: "エネファーム自動化の判断履歴はありません。",
    plannerInfluence: "充電計画への反映",
    active: "有効",
    off: "無効",
    gasCo2Factor: "都市ガス排出係数 (kg-CO2/m³)",
    gasProvider: "ガス会社",
    gasRegion: "供給地域",
    gasPlan: "ガス料金プラン",
    meterReadingDay: "検針日",
    equipmentDiscount: "追加機器割引",
    tokyoGasTokyoRegion: "東京地区等",
    tokyoGasGunmaRegion: "群馬地区",
    tokyoGasEneFarmPlan: "エネファームで発電エコぷらん",
    noOptionalDiscount: "追加割引なし",
    eneFarmBathDiscount: "エネファーム + バス暖割",
    eneFarmFloorDiscount: "エネファーム + 床暖割（冬期のみ）",
    eneFarmCombinedDiscount: "エネファーム + セット割",
    eneFarmOnlyGasAssumption: "料金推定では、請求期間中に記録したエネファームのガス使用量を家庭全体の使用量として扱います。ガスコンロ、暖房、給湯器など他の機器が使用するガスは含まれません。",
    gasSeasonAutomaticHelp: "東京ガスの冬期料金は12月〜4月検針分に自動適用されます。",
    marginalRateOverride: "従量単価の上書き (円/m³)",
    automaticTariffUpdates: "東京ガスの月別料金を自動取得",
    addWindow: "時間帯を追加",
    saveFuelCellSettings: "エネファーム設定を保存",
    gasTariffData: "ガス料金データ",
    billingMonth: "請求月",
    season: "季節",
    otherSeason: "その他期",
    winter: "冬期",
    importPublishedTariff: "公開料金を取得",
    tokyoGasTariffSource: "東京ガス料金データ",
    exactCounter: "積算値",
    integratedEstimate: "積算推定",
    mixedQuality: "積算値と推定値の混在",
    battery: "蓄電池",
    homePowerMeter: "家庭内電力メーター",
    solar: "太陽光",
    fuelCell: "エネファーム",
    discoverySubnets: "検出サブネット",
    optional: "任意",
    saveAddresses: "アドレスを保存",
    autoDiscovery: "自動検出",
    scanNetwork: "ネットワークをスキャン",
    broadcastDiscovery: "ブロードキャスト検出",
    activeSubnetScan: "サブネット能動スキャン",
    scanning: "スキャン中...",
    scanningNearby: "近くの機器をスキャン中...",
    discoveryStarting: "自動検出を開始中",
    discoveryBroadcast: "機器からの応答を待機中",
    discoveryActiveScan: "サブネット内のアドレスをスキャン中",
    discoveryWaiting: "機器からの返信を待機中",
    discoveryIdentifying: "機器の種類を識別中",
    discoveryComplete: "自動検出が完了しました",
    discoveryFailed: "自動検出に失敗しました",
    discoveryProgressCount: "{scanned} / {total} アドレス確認済み",
    discoveryFoundCount: "{count} 台検出",
    discoveryElapsed: "{seconds}秒経過",
    noDevicesFound: "機器が見つかりませんでした。",
    likelyRole: "推定される役割",
    services: "サービス数",
    address: "アドレス",
    useSuggestedAddresses: "推奨アドレスを使う",
    schedules: "スケジュール",
    action: "操作",
    repeat: "繰り返し",
    once: "1回のみ",
    daily: "毎日",
    days: "曜日",
    daySun: "日",
    dayMon: "月",
    dayTue: "火",
    dayWed: "水",
    dayThu: "木",
    dayFri: "金",
    daySat: "土",
    time: "時刻",
    createSchedule: "スケジュール作成",
    when: "実行日時",
    details: "詳細",
    status: "状態",
    everyDay: "毎日",
    noSchedules: "スケジュールはまだありません。",
    waiting: "待機中",
    running: "実行中",
    disabled: "無効",
    paused: "一時停止中",
    pause: "一時停止",
    resume: "再開",
    lastRan: "前回実行",
    savedAddresses: "機器アドレスを保存しました",
    suggestedLoaded: "推奨アドレスを読み込みました。保存すると反映されます。",
    chooseProfile: "充電プロファイルを選んでください。",
    chooseScheduleTime: "スケジュール時刻を選んでください。",
    scheduleCreated: "スケジュールを作成しました",
    serviceOnline: "サービス稼働中",
    historicalData: "履歴データ",
    backgroundRefresh: "バックグラウンド更新",
    readFailed: "読み取り失敗",
    readingDevices: "機器を読み取り中",
    unavailable: "取得不可",
    today: "今日",
    selectedRange: "選択範囲",
    notSet: "未設定",
    rangeTotal: "期間合計",
    rangeAverage: "期間平均",
    batteryChargedLabel: "充電",
    batteryDischargedLabel: "放電",
    databaseSize: "データベースサイズ",
    daysRecorded: "記録日数",
    samplesRecorded: "記録サンプル数",
    now: "現在",
    minAgo: "30分前",
    timeAxis: "時間",
    wattsAxis: "電力 (W)",
    percentAxis: "充電率 (%)",
    profileOsaifu: "おサイフ",
    profileEco: "eco",
    profileBackup: "バックアップ",
    operationAuto: "自動",
    operationStandby: "待機",
    operationRapid: "急速充電",
    operationCharge: "充電",
    operationDischarge: "放電",
    startHour: "開始時刻",
    endHour: "終了時刻",
    percent: "パーセント",
    charging: "充電中",
    discharging: "放電中",
    standby: "待機中",
    auto: "自動",
    generating: "発電中",
    stopped: "停止中",
    starting: "起動中",
    stopping: "停止処理中",
    rapid_charging: "急速充電中",
    on: "オン",
    off: "オフ",
    chargeAction: "目標Whを指定して充電",
    dischargeAction: "目標Whを指定して放電",
    setAutoAction: "運転モードを自動にする",
    setStandbyAction: "運転モードを待機にする",
    setRapidAction: "運転モードを急速充電にする",
    setChargeAction: "運転モードを充電にする",
    setDischargeAction: "運転モードを放電にする",
    setProfileAction: "充電プロファイルを設定",
    setLimitAction: "放電下限を設定",
    setChargeWindowAction: "充電時間帯を設定",
    setDischargeWindowAction: "放電時間帯を設定",
    setOperationModeAction: "運転モードを設定",
    automationRules: "自動化ルール",
    backupDemandGuard: "ブレーカー落ちガード",
    backupGuardEnabled: "ブレーカー落ちガードを有効化",
    breakerAmps: "ブレーカー容量(A)",
    reserveAmps: "余裕(A)",
    batteryChargeEstimate: "蓄電池の最大充電電力(W)",
    restoreBelowAmps: "復帰しきい値(A)",
    restoreDelay: "復帰待機秒数",
    saveAutomation: "自動化を保存",
    automationSaved: "自動化を保存しました",
    automationNoRules: "自動化ルールはありません。",
    automationNoLog: "ガードイベントはまだ記録されていません。",
    guardLog: "ガードログ",
  },
};
const DAY_KEYS = [
  "daySun",
  "dayMon",
  "dayTue",
  "dayWed",
  "dayThu",
  "dayFri",
  "daySat",
];

function t(key) {
  return I18N[state.language]?.[key] ?? I18N.en[key] ?? key;
}

function template(key, values) {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function setLanguage(language) {
  // Swap text in-place. Controls are regenerated where option labels depend on
  // the active language, but device values are left untouched.
  state.language = ["en", "ja"].includes(language) ? language : "en";
  document.documentElement.lang = state.language;
  document.title =
    state.language === "ja"
      ? "ホームエネルギー & バッテリー"
      : "HOME ENERGY & BATTERY";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const value = t(el.dataset.i18n);
    if (value.includes("<")) el.innerHTML = value;
    else el.textContent = value;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-mode-label]").forEach((el) => {
    const value = el.dataset.modeLabel;
    const key = value
      ? `profile${value.replace(/^./, (c) => c.toUpperCase())}`
      : "";
    el.textContent = key ? t(key) : "";
  });
  $("#languageSelect").value = state.language;
  populateActionOptions();
  schedulePayloadFields($("#scheduleAction")?.value ?? "vendor-profile");
  if (state.schedules.length) renderSchedules(state.schedules);
  const serviceKey = $("#serviceState")?.dataset.stateKey;
  if (serviceKey) setServiceState(serviceKey);
  if (state.status) renderDashboard(state.status, { recordTrend: false });
  renderReportQuickRanges(reportBucket());
  if (state.reportData) renderReport(state.reportData);
  drawAllTrends();
  drawGraphAnalysis();
  renderDashboardWidgetControls(state.config ?? {});
  if (state.notifications) renderNotificationView(state.notifications);
  if (state.databaseBackups) renderDatabaseBackups(state.databaseBackups);
  if (state.adaptiveChargingStatus) renderAdaptiveChargingStatus(state.adaptiveChargingStatus);
  else if (state.awayPeriodsView) renderAwayPeriods(state.awayPeriodsView);
  setPage(state.currentPage);
  if (state.config) updateAdaptiveChargingAvailability(state.config);
}

function displayValue(value) {
  return t(value) || value;
}

function setServiceState(key) {
  const el = $("#serviceState");
  if (!el) return;
  el.dataset.stateKey = key;
  el.textContent = t(key);
}

function actionLabel(action) {
  return (
    {
      "vendor-profile": t("setProfileAction"),
      "discharge-limit": t("setLimitAction"),
      "osaifu-charge-window": t("setChargeWindowAction"),
      "osaifu-discharge-window": t("setDischargeWindowAction"),
      charge: t("chargeAction"),
      discharge: t("dischargeAction"),
      "set-mode": t("setOperationModeAction"),
    }[action] ?? action
  );
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  // Small JSON helper used by every form and polling loop.
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setText(selector, value) {
  $(selector).textContent = value ?? "--";
}

function metricValue(item, fallback = "--") {
  if (!item) return fallback;
  if (item.human) return item.human;
  if (item.value !== undefined && item.value !== null && item.unit)
    return `${item.value} ${item.unit}`;
  if (item.value !== undefined && item.value !== null) return String(item.value);
  return item.raw ?? fallback;
}

function numericValue(item) {
  if (item?.value === null || item?.value === undefined || item.value === "") return Number.NaN;
  return Number(item.value);
}

function watts(value) {
  return Number.isFinite(value) ? `${Math.round(value)} W` : "-- W";
}

function energyKwh(value) {
  if (!Number.isFinite(value)) return "--";
  return `${new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value)} kWh`;
}

function gasM3(value) {
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 1 : 3)} m³` : "--";
}

function optionalNumber(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function durationText(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function fuelCellQualityLabel(quality) {
  if (quality === "counter") return t("exactCounter");
  if (quality === "integrated") return t("integratedEstimate");
  if (quality === "mixed") return t("mixedQuality");
  return t("unavailable");
}

function renderFuelCellStateStrip(selector, transitions = [], start, end, intervals = []) {
  const root = $(selector);
  if (!root) return;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  root.replaceChildren();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
  if (intervals.length) {
    for (const interval of intervals) {
      const intervalStart = Math.max(startMs, new Date(interval.start).getTime());
      const intervalEnd = Math.min(endMs, new Date(interval.end).getTime());
      if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) continue;
      const segment = document.createElement("i");
      segment.dataset.state = interval.state ?? "unknown";
      segment.style.width = `${(intervalEnd - intervalStart) / (endMs - startMs) * 100}%`;
      const gas = interval.gasM3 == null ? "--" : gasM3(Number(interval.gasM3));
      segment.title = `${displayValue(interval.state)} · ${durationText((intervalEnd - intervalStart) / 1000)} · ${energyKwh(Number(interval.generatedKwh))} · ${gas}${interval.sourceHost ? ` · ${interval.sourceHost}` : ""}${interval.quality ? ` · ${fuelCellQualityLabel(interval.quality)}` : ""}`;
      root.append(segment);
    }
    return;
  }
  const ordered = transitions
    .map((event) => ({ at: new Date(event.at).getTime(), state: event.payload?.to ?? event.payload?.state ?? event.type }))
    .filter((event) => Number.isFinite(event.at) && event.at <= endMs)
    .sort((a, b) => a.at - b.at);
  let stateName = ordered.filter((event) => event.at <= startMs).at(-1)?.state ?? "stopped";
  let cursor = startMs;
  for (const event of ordered.filter((item) => item.at > startMs)) {
    const segment = document.createElement("i");
    segment.dataset.state = stateName;
    segment.style.width = `${Math.max(0, event.at - cursor) / (endMs - startMs) * 100}%`;
    segment.title = `${displayValue(stateName)} · ${durationText((event.at - cursor) / 1000)}`;
    root.append(segment);
    cursor = event.at;
    stateName = event.state;
  }
  const segment = document.createElement("i");
  segment.dataset.state = stateName;
  segment.style.width = `${Math.max(0, endMs - cursor) / (endMs - startMs) * 100}%`;
  segment.title = `${displayValue(stateName)} · ${durationText((endMs - cursor) / 1000)}`;
  root.append(segment);
}

function renderFuelCellStateAxis(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const valid = Number.isFinite(startDate.getTime())
    && Number.isFinite(endDate.getTime())
    && endDate > startDate;
  const middleDate = valid
    ? new Date(startDate.getTime() + (endDate.getTime() - startDate.getTime()) / 2)
    : null;
  const timeLabel = (date) => date
    ? date.toLocaleTimeString(state.language === "ja" ? "ja-JP" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    : "--:--";
  setText("#fuelCellStateAxisStart", valid ? timeLabel(startDate) : "--:--");
  setText("#fuelCellStateAxisMiddle", timeLabel(middleDate));
  setText("#fuelCellStateAxisEnd", valid ? timeLabel(endDate) : "--:--");
}

function yen(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function yenPerM3(value) {
  return Number.isFinite(value) ? `${yen(value)}/m³` : "--";
}

function co2Saved(valueKg) {
  if (!Number.isFinite(valueKg)) return "--";
  if (valueKg >= 1000) {
    return `${new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
      maximumFractionDigits: valueKg >= 10_000 ? 0 : 1,
    }).format(valueKg / 1000)} t`;
  }
  return `${new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: valueKg >= 100 ? 0 : 2,
  }).format(valueKg)} kg`;
}

function percentage(value) {
  if (!Number.isFinite(value)) return "--";
  return `${new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1,
  }).format(value)}%`;
}

function localDateTimeValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function rangeLabel(summary, fallbackKey) {
  if (!summary?.start || !summary?.end) return t(fallbackKey);
  return `${new Date(summary.start).toLocaleString()} - ${new Date(summary.end).toLocaleString()}`;
}

function resetTrendHistory() {
  state.trendHistory = {};
}

function trendLabel(name) {
  if (isCircuitGraph(name)) {
    return circuitLabel(circuitGraphChannel(name));
  }
  return t(TREND_LABEL_KEYS[name] ?? name);
}

function isCircuitGraph(name) {
  return String(name ?? "").startsWith(CIRCUIT_GRAPH_PREFIX);
}

function circuitGraphName(channel) {
  return `${CIRCUIT_GRAPH_PREFIX}${channel}`;
}

function circuitGraphChannel(name) {
  return String(name ?? "").slice(CIRCUIT_GRAPH_PREFIX.length);
}

function circuitLabel(channel) {
  const id = String(channel);
  const label = String(state.config?.circuitLabels?.[id] ?? "").trim();
  return label || `${t("circuit")} ${id}`;
}

function circuitIdsFromStatus(data = state.status) {
  const ids = new Set();
  for (const channel of data?.meter?.channel_power?.decoded?.channels ?? []) {
    if (Number.isInteger(Number(channel.channel))) ids.add(String(channel.channel));
  }
  for (const channel of data?.meter?.channel_energy?.decoded?.channels ?? []) {
    if (Number.isInteger(Number(channel.channel))) ids.add(String(channel.channel));
  }
  for (const circuit of data?.savings?.circuits ?? []) ids.add(String(circuit.channel));
  return [...ids].filter((id) => Number.isInteger(Number(id))).sort((a, b) => Number(a) - Number(b));
}

function circuitSortMode(config = state.config ?? {}) {
  if (config.circuitSortMode === "energy") return "current";
  return ["current", "accumulated"].includes(config.circuitSortMode)
    ? config.circuitSortMode
    : "number";
}

function sortCircuitIds(ids, summaries = {}, config = state.config ?? {}) {
  const sorted = [...ids].filter((id) => Number.isInteger(Number(id)));
  if (circuitSortMode(config) !== "accumulated") {
    return sorted.sort((a, b) => Number(a) - Number(b));
  }
  return sorted.sort((a, b) => {
    const energyDiff = Number(summaries[b]?.totalKwh ?? 0) - Number(summaries[a]?.totalKwh ?? 0);
    return energyDiff || Number(a) - Number(b);
  });
}

function sortCircuitIdsByCurrentPower(ids, wattsByChannel = {}) {
  return [...ids]
    .filter((id) => Number.isInteger(Number(id)))
    .sort((left, right) => {
      const leftRaw = wattsByChannel[left];
      const rightRaw = wattsByChannel[right];
      const leftWatts = Number(leftRaw);
      const rightWatts = Number(rightRaw);
      const leftAvailable = leftRaw !== null && leftRaw !== undefined && leftRaw !== "" && Number.isFinite(leftWatts);
      const rightAvailable = rightRaw !== null && rightRaw !== undefined && rightRaw !== "" && Number.isFinite(rightWatts);
      if (leftAvailable !== rightAvailable) return rightAvailable - leftAvailable;
      if (leftAvailable && leftWatts !== rightWatts) return rightWatts - leftWatts;
      return Number(left) - Number(right);
    });
}

function staticCircuitDatasetKey(data = state.status) {
  const summary = data?.savings ?? {};
  const totals = (summary.circuits ?? [])
    .map((circuit) => [String(circuit.channel), Number(circuit.totalKwh ?? 0)])
    .sort(([left], [right]) => Number(left) - Number(right));
  return JSON.stringify({
    start: summary.start ?? null,
    end: summary.end ?? null,
    sampleCount: Number(summary.sampleCount ?? 0),
    totals,
    watts: Object.entries(circuitWattsFromStatus(data))
      .sort(([left], [right]) => Number(left) - Number(right)),
  });
}

function circuitOrderForData(data = state.status, ids = circuitIdsFromStatus(data)) {
  const summaries = circuitSummaryMap(data?.savings ?? {});
  const sortMode = circuitSortMode();
  const sortedForMode = () => sortMode === "current"
    ? sortCircuitIdsByCurrentPower(ids, circuitWattsFromStatus(data))
    : sortCircuitIds(ids, summaries);
  if (!state.historyMode) {
    // Both current demand and today's accumulated totals can change with every
    // live payload, so always derive the order again.
    return sortedForMode();
  }

  const datasetIds = [...ids].sort((left, right) => Number(left) - Number(right));
  const key = `${sortMode}|${JSON.stringify(datasetIds)}|${staticCircuitDatasetKey(data)}`;
  if (state.staticCircuitOrderKey !== key) {
    state.staticCircuitOrderKey = key;
    state.staticCircuitOrder = sortedForMode();
  }
  return [...state.staticCircuitOrder];
}

function circuitWattsFromStatus(data = state.status) {
  const out = {};
  for (const channel of data?.meter?.channel_power?.decoded?.channels ?? []) {
    if (Number.isInteger(Number(channel.channel))) {
      out[String(channel.channel)] = Number.isFinite(Number(channel.value)) ? Number(channel.value) : null;
    }
  }
  return out;
}

function circuitSummaryMap(summary = {}) {
  const out = {};
  for (const circuit of summary.circuits ?? []) {
    out[String(circuit.channel)] = circuit;
  }
  return out;
}

function ensureCircuitTrendConfig(channel) {
  const id = String(channel);
  const name = circuitGraphName(id);
  if (!TREND_CONFIG[name]) {
    TREND_CONFIG[name] = {
      canvas: `#circuitTrend-${id}`,
      horizonMs: POWER_TREND_MS,
      color: "#2563eb",
      fill: "rgba(37, 99, 235, 0.12)",
      includeZero: true,
    };
  }
  return TREND_CONFIG[name];
}

function setLiveModeButton() {
  $("#liveBtn")?.classList.toggle("is-live", !state.historyMode);
}

function historyParams(start, end) {
  return new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
  });
}

function sampleValueForTrend(name, sample) {
  if (isCircuitGraph(name)) {
    const raw = sample.circuitPowerW?.[circuitGraphChannel(name)];
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  const raw = {
    batteryPower: sample.batteryPowerW,
    batterySoc: sample.stateOfChargePercent,
    solarPower: sample.solarPowerW,
    houseDemandPower: sample.houseDemandW,
    gridExportPower: sample.gridExportW,
    gridImportPower: sample.gridImportW,
    fuelCellPower: sample.fuelCellPowerW,
  }[name];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function ensureCircuitTrendConfigsForSamples(samples = []) {
  for (const sample of samples) {
    for (const channel of Object.keys(sample.circuitPowerW ?? {})) {
      ensureCircuitTrendConfig(channel);
    }
  }
}

function appendSampleToTrendBuffers(sample, rangeStartMs, rangeEndMs) {
  const plottingPoints = trendSamplePoints(sample, rangeStartMs, rangeEndMs);
  if (!plottingPoints.length) return false;
  for (const name of Object.keys(TREND_CONFIG)) {
    const value = sampleValueForTrend(name, sample);
    for (const point of plottingPoints) {
      (state.trendHistory[name] ??= []).push({ ...point, value });
    }
  }
  return true;
}

function setHistoryRange(durationMs, end = new Date()) {
  $("#historyEnd").value = localDateTimeValue(end);
  $("#historyStart").value = localDateTimeValue(new Date(end.getTime() - durationMs));
}

function setGraphHistoryRange(durationMs, end = new Date()) {
  $("#graphHistoryEnd").value = localDateTimeValue(end);
  $("#graphHistoryStart").value = localDateTimeValue(new Date(end.getTime() - durationMs));
}

function setLoadProgress(prefix, parsed = 0, total = 0, visible = true) {
  const container = $(`#${prefix}LoadProgress`);
  const detail = $(`#${prefix}LoadDetail`);
  const fill = $(`#${prefix}LoadFill`);
  const bar = fill?.parentElement;
  if (!container || !detail || !fill || !bar) return;
  container.classList.toggle("hidden", !visible);
  const percent = total ? Math.round((parsed / total) * 100) : 0;
  const isReport = prefix === "report";
  detail.textContent = total
    ? template(isReport ? "parsedReportRecords" : "parsedGraphRecords", {
        parsed: parsed.toLocaleString(),
        total: total.toLocaleString(),
      })
    : t(isReport ? "fetchingReportRecords" : "fetchingGraphRecords");
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  bar.setAttribute("aria-valuenow", String(percent));
  bar.classList.toggle("indeterminate", visible && !total);
}

function finishLoadProgress(prefix, parsed, total) {
  setLoadProgress(prefix, parsed, total, true);
  window.setTimeout(() => setLoadProgress(prefix, parsed, total, false), 700);
}

function nextFrame() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function historyHorizonForSamples(samples, rangeStartMs, rangeEndMs) {
  if (samples.length) {
    const first = trendSamplePoints(samples[0], rangeStartMs, rangeEndMs)[0];
    const last = trendSamplePoints(samples[samples.length - 1], rangeStartMs, rangeEndMs).at(-1);
    if (!first || !last) return POWER_TREND_MS;
    return Math.max(
      60_000,
      last.time - first.time,
    );
  }
  return POWER_TREND_MS;
}

async function loadHistorySamplesAsync(
  history,
  {
    target = "dashboard",
    graphName = state.activeGraph,
    rangeStartMs,
    rangeEndMs,
  } = {},
) {
  const samples = history.samples ?? [];
  const total = samples.length;
  const prefix = target === "graph" ? "graph" : "history";
  const tokenKey = target === "graph" ? "graphLoadToken" : "historyLoadToken";
  const token = (state[tokenKey] += 1);
  setLoadProgress(prefix, 0, total, true);
  if (target === "dashboard") {
    resetTrendHistory();
    ensureCircuitTrendConfigsForSamples(samples);
    state.historyHorizonMs = historyHorizonForSamples(samples, rangeStartMs, rangeEndMs);
  } else {
    state.graphPoints = [];
    state.graphRecordCount = total;
    state.graphHover = null;
    state.graphHistoryHorizonMs = historyHorizonForSamples(samples, rangeStartMs, rangeEndMs);
  }
  let nextPreviewAt = HISTORY_PREVIEW_RECORD_INTERVAL;
  for (let index = 0; index < samples.length; index += HISTORY_BATCH_SIZE) {
    if (token !== state[tokenKey]) return false;
    const batch = samples.slice(index, index + HISTORY_BATCH_SIZE);
    for (const sample of batch) {
      const plottingPoints = trendSamplePoints(sample, rangeStartMs, rangeEndMs);
      if (!plottingPoints.length) continue;
      if (target === "dashboard") {
        appendSampleToTrendBuffers(sample, rangeStartMs, rangeEndMs);
      } else {
        const value = sampleValueForTrend(graphName, sample);
        for (const point of plottingPoints) state.graphPoints.push({ ...point, value });
      }
    }
    const parsed = Math.min(index + batch.length, total);
    setLoadProgress(prefix, parsed, total, true);
    if (parsed < total && parsed >= nextPreviewAt) {
      if (target === "dashboard") drawAllTrends();
      else drawGraphAnalysis({ decimate: true });
      while (nextPreviewAt <= parsed) {
        nextPreviewAt += HISTORY_PREVIEW_RECORD_INTERVAL;
      }
    }
    await nextFrame();
  }
  if (target === "dashboard") drawAllTrends();
  else drawGraphAnalysis();
  finishLoadProgress(prefix, total, total);
  return true;
}

async function loadLiveTrendHistory(endMs = Date.now()) {
  const end = new Date(endMs);
  const start = new Date(end.getTime() - POWER_TREND_MS);
  const previousMode = state.historyMode;
  state.historyMode = false;
  state.historyHorizonMs = null;
  state.liveWindowEndMs = endMs;
  setLoadProgress("history", 0, 0, true);
  const history = await api(`/api/history?${historyParams(start, end)}`);
  await loadHistorySamplesAsync(history, {
    target: "dashboard",
    rangeStartMs: start.getTime(),
    rangeEndMs: end.getTime(),
  });
  advanceLiveTrendWindow(endMs, { draw: false });
  state.historyMode = previousMode;
  state.lastLivePollAt = Date.now();
  setLiveModeButton();
  return history;
}

function parseOsaifuWindow(setting) {
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

function populateActionOptions() {
  const actionOptions = [
    ["vendor-profile", "setProfileAction"],
    ["discharge-limit", "setLimitAction"],
    ["osaifu-charge-window", "setChargeWindowAction"],
    ["osaifu-discharge-window", "setDischargeWindowAction"],
    ["charge", "chargeAction"],
    ["discharge", "dischargeAction"],
    ["set-mode", "setOperationModeAction"],
  ];
  const directOptions = [
    ["charge", "chargeAction"],
    ["discharge", "dischargeAction"],
    ["set-mode:auto", "setAutoAction"],
    ["set-mode:standby", "setStandbyAction"],
    ["set-mode:rapid", "setRapidAction"],
    ["set-mode:charge", "setChargeAction"],
    ["set-mode:discharge", "setDischargeAction"],
  ];
  const fill = (selector, options) => {
    const select = $(selector);
    if (!select) return;
    const selected = select.value || options[0][0];
    select.innerHTML = options
      .map(([value, key]) => `<option value="${value}">${t(key)}</option>`)
      .join("");
    if (options.some(([value]) => value === selected)) select.value = selected;
  };
  fill("#scheduleAction", actionOptions);
  fill("#directAction", directOptions);
}

function pushTrend(name, value, time = Date.now(), options = {}) {
  // Trends are kept client-side for live mode. Historical mode repopulates this
  // same structure from samples loaded from disk.
  const config = TREND_CONFIG[name];
  if (!config || !Number.isFinite(time)) return;
  const history = state.trendHistory[name] ?? [];
  history.push({ time, value: Number.isFinite(value) ? value : null });
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config.horizonMs;
  const windowEndMs = state.historyMode ? time : state.liveWindowEndMs;
  state.trendHistory[name] = pruneTrendPoints(history, windowEndMs - horizonMs);
  if (options.draw !== false) drawTrend(name);
}

function advanceLiveTrendWindow(endMs = Date.now(), options = {}) {
  if (state.historyMode || !Number.isFinite(endMs)) return;
  state.liveWindowEndMs = endMs;
  for (const [name, points] of Object.entries(state.trendHistory)) {
    const horizonMs = TREND_CONFIG[name]?.horizonMs ?? POWER_TREND_MS;
    state.trendHistory[name] = pruneTrendPoints(points, endMs - horizonMs);
  }
  if (options.draw !== false) drawAllTrends();
}

function drawAllTrends() {
  Object.keys(TREND_CONFIG).forEach((name) => drawTrend(name));
}

function drawTrend(name) {
  const config = TREND_CONFIG[name];
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config?.horizonMs;
  const liveWindowEndMs = state.historyMode ? null : state.liveWindowEndMs;
  drawTrendCanvas(
    name,
    config ? $(config.canvas) : null,
    state.trendHistory[name] ?? [],
    state.trendHover[name],
    horizonMs,
    {
      decimate: true,
      windowStartMs: Number.isFinite(liveWindowEndMs)
        ? liveWindowEndMs - horizonMs
        : null,
      windowEndMs: liveWindowEndMs,
    },
  );
}

function drawTrendCanvas(name, canvas, points, hover, horizonMs, options = {}) {
  // Canvas keeps the UI dependency-free. The chart is deliberately simple:
  // gridlines, min/max labels, a time axis, filled area, and current point.
  const config = TREND_CONFIG[name];
  if (!config || !canvas) return;
  horizonMs = horizonMs || config.horizonMs;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = Math.max(1, height - pad.top - pad.bottom);
  const unit = name === "batterySoc" ? "%" : "W";

  const configuredIntervalMs = Math.max(
    5,
    Number(state.config?.updateIntervalSeconds ?? ACTIVE_REFRESH_MS / 1000),
  ) * 1000;
  let intervalTotal = 0;
  let intervalCount = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].continuousFromPrevious) continue;
    const interval = points[index].time - points[index - 1].time;
    if (!Number.isFinite(interval) || interval <= 0) continue;
    intervalTotal += interval;
    intervalCount += 1;
  }
  const typicalIntervalMs = intervalCount
    ? intervalTotal / intervalCount
    : configuredIntervalMs;
  const gapThresholdMs = Math.max(configuredIntervalMs, typicalIntervalMs) * 3;
  const renderedPoints = options.decimate
    ? decimateTimeSeries(points, Math.ceil(chartWidth), gapThresholdMs)
    : points;
  const wasDecimated = renderedPoints !== points;

  ctx.strokeStyle = "#dbe5ef";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i += 1) {
    const y = pad.top + (chartHeight * i) / 2;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  let validCount = 0;
  let observedMin = Infinity;
  let observedMax = -Infinity;
  for (const point of renderedPoints) {
    if (!Number.isFinite(point.value)) continue;
    validCount += 1;
    observedMin = Math.min(observedMin, point.value);
    observedMax = Math.max(observedMax, point.value);
  }
  let min = config.min ?? (validCount ? observedMin : 0);
  let max =
    config.max ??
    (validCount ? observedMax : config.signed ? 1000 : 100);
  if (config.includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (config.signed) {
    const abs = Math.max(Math.abs(min), Math.abs(max), 1);
    min = -abs;
    max = abs;
  }
  if (min === max) {
    const padValue = Math.max(1, Math.abs(max) * 0.1);
    min -= padValue;
    max += padValue;
  }

  ctx.fillStyle = "#64748b";
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(max)}${unit}`, pad.left - 5, pad.top);
  ctx.fillText(
    `${Math.round(min)}${unit}`,
    pad.left - 5,
    pad.top + chartHeight,
  );

  ctx.save();
  ctx.translate(9, pad.top + chartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(unit === "%" ? t("percentAxis") : t("wattsAxis"), 0, 0);
  ctx.restore();

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const windowEndMs = Number.isFinite(options.windowEndMs)
    ? options.windowEndMs
    : points[points.length - 1]?.time;
  const windowStartMs = Number.isFinite(options.windowStartMs)
    ? options.windowStartMs
    : Number.isFinite(windowEndMs)
      ? windowEndMs - horizonMs
      : null;
  const axisTicks = trendAxisTicks(windowStartMs, windowEndMs, chartWidth);
  const axisLabelOptions = trendAxisLabelOptions(horizonMs);
  if (axisTicks.length) {
    axisTicks.forEach((timestamp, index) => {
      const ratio = index / (axisTicks.length - 1);
      if (index === 0) ctx.textAlign = "left";
      else if (index === axisTicks.length - 1) ctx.textAlign = "right";
      else ctx.textAlign = "center";
      ctx.fillText(
        new Date(timestamp).toLocaleString([], axisLabelOptions),
        pad.left + chartWidth * ratio,
        height - 14,
      );
    });
  } else {
    ctx.fillText(state.historyMode ? t("selectedRange") : t("minAgo"), pad.left, height - 14);
    ctx.textAlign = "right";
    ctx.fillText(t("now"), width - pad.right, height - 14);
  }
  ctx.textAlign = "center";
  ctx.fillText(t("timeAxis"), pad.left + chartWidth / 2, height - 3);

  if (!points.length || !validCount) return;

  const start = windowStartMs;
  const visibleHorizonMs = Math.max(1, windowEndMs - start);
  const range = max - min;
  const xFor = (time) =>
    pad.left + ((time - start) / visibleHorizonMs) * chartWidth;
  const yFor = (value) =>
    pad.top + chartHeight - ((value - min) / range) * chartHeight;

  if (min < 0 && max > 0) {
    const zeroY = yFor(0);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.28)";
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();
  }

  const segments = [];
  let segment = [];
  for (const point of renderedPoints) {
    const previous = segment[segment.length - 1];
    const startsGap =
      !Number.isFinite(point.value) ||
      (!wasDecimated &&
        !point.continuousFromPrevious &&
        previous &&
        point.time - previous.time > gapThresholdMs);
    if (startsGap) {
      if (segment.length) segments.push(segment);
      segment = [];
      if (!Number.isFinite(point.value)) continue;
    }
    segment.push({ time: point.time, x: xFor(point.time), y: yFor(point.value) });
  }
  if (segment.length) segments.push(segment);

  for (const plotted of segments) {
    if (plotted.length > 1) {
      ctx.beginPath();
      ctx.moveTo(plotted[0].x, height - pad.bottom);
      for (const point of plotted) ctx.lineTo(point.x, point.y);
      ctx.lineTo(plotted[plotted.length - 1].x, height - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = config.fill;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(plotted[0].x, plotted[0].y);
      for (const point of plotted.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = config.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }

    if (plotted.length === 1) {
      ctx.fillStyle = config.color;
      ctx.beginPath();
      ctx.arc(plotted[0].x, plotted[0].y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const lastPoint = points[points.length - 1];
  if (Number.isFinite(lastPoint.value)) {
    ctx.fillStyle = config.color;
    ctx.beginPath();
    ctx.arc(xFor(lastPoint.time), yFor(lastPoint.value), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (hover && Number.isFinite(hover.time) && Number.isFinite(hover.value)) {
    const hoverX = xFor(hover.time);
    const hoverY = yFor(hover.value);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX, pad.top);
    ctx.lineTo(hoverX, height - pad.bottom);
    ctx.stroke();
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(hoverX, hoverY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ensureTrendTooltip() {
  let tooltip = $("#trendTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "trendTooltip";
    tooltip.className = "trend-tooltip hidden";
    document.body.append(tooltip);
  }
  return tooltip;
}

function handleTrendPointer(name, event) {
  const config = TREND_CONFIG[name];
  const canvas = $(config.canvas);
  const allPoints = state.trendHistory[name] ?? [];
  const points = allPoints.filter((point) => Number.isFinite(point.value));
  if (!canvas || !points.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const chartWidth = Math.max(1, rect.width - pad.left - pad.right);
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config.horizonMs;
  const windowEndMs = state.historyMode
    ? allPoints[allPoints.length - 1].time
    : state.liveWindowEndMs;
  const start = windowEndMs - horizonMs;
  const x = Math.max(
    pad.left,
    Math.min(rect.width - pad.right, event.clientX - rect.left),
  );
  const targetTime = start + ((x - pad.left) / chartWidth) * horizonMs;
  const nearest = points.reduce(
    (best, point) =>
      Math.abs(point.time - targetTime) < Math.abs(best.time - targetTime)
        ? point
        : best,
    points[0],
  );
  state.trendHover[name] = nearest;
  drawTrend(name);
  const tooltip = ensureTrendTooltip();
  const unit = name === "batterySoc" ? "%" : "W";
  tooltip.textContent = `${new Date(nearest.time).toLocaleString()} · ${Math.round(nearest.value)} ${unit}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 260, event.clientX + 12)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY + 12)}px`;
  tooltip.classList.remove("hidden");
}

function clearTrendPointer(name) {
  delete state.trendHover[name];
  drawTrend(name);
  $("#trendTooltip")?.classList.add("hidden");
}

function drawGraphAnalysis(options = {}) {
  const graphName = state.activeGraph;
  $("#graphTitle").textContent = trendLabel(graphName);
  $("#graphMeta").textContent = template("graphRecordCount", {
    count: state.graphRecordCount.toLocaleString(),
  });
  drawTrendCanvas(
    graphName,
    $("#graphAnalysisTrend"),
    state.graphPoints,
    state.graphHover,
    state.graphHistoryHorizonMs,
    options,
  );
}

function handleGraphPointer(event) {
  const graphName = state.activeGraph;
  const canvas = $("#graphAnalysisTrend");
  const allPoints = state.graphPoints;
  const points = allPoints.filter((point) => Number.isFinite(point.value));
  if (!canvas || !points.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const chartWidth = Math.max(1, rect.width - pad.left - pad.right);
  const now = allPoints[allPoints.length - 1].time;
  const start = now - state.graphHistoryHorizonMs;
  const x = Math.max(
    pad.left,
    Math.min(rect.width - pad.right, event.clientX - rect.left),
  );
  const targetTime = start + ((x - pad.left) / chartWidth) * state.graphHistoryHorizonMs;
  const nearest = points.reduce(
    (best, point) =>
      Math.abs(point.time - targetTime) < Math.abs(best.time - targetTime)
        ? point
        : best,
    points[0],
  );
  state.graphHover = nearest;
  drawGraphAnalysis();
  const tooltip = ensureTrendTooltip();
  const unit = graphName === "batterySoc" ? "%" : "W";
  tooltip.textContent = `${new Date(nearest.time).toLocaleString()} · ${Math.round(nearest.value)} ${unit}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 260, event.clientX + 12)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY + 12)}px`;
  tooltip.classList.remove("hidden");
}

function clearGraphPointer() {
  state.graphHover = null;
  drawGraphAnalysis();
  $("#trendTooltip")?.classList.add("hidden");
}

function setBar(selector, percent) {
  const el = $(selector);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function selectHourOptions(select) {
  select.innerHTML = "";
  const current = document.createElement("option");
  current.value = "";
  current.textContent = "--";
  select.append(current);
  for (let i = 0; i < 24; i += 1) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `${String(i).padStart(2, "0")}:00`;
    select.append(option);
  }
}

function hourOptions() {
  return Array.from(
    { length: 24 },
    (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}:00</option>`,
  ).join("");
}

function operationModeOptions() {
  return `
    <option value="auto">${t("operationAuto")}</option>
    <option value="standby">${t("operationStandby")}</option>
    <option value="rapid">${t("operationRapid")}</option>
    <option value="charge">${t("operationCharge")}</option>
    <option value="discharge">${t("operationDischarge")}</option>
  `;
}

function rateBandRow(band = {}, index = 0) {
  return `
    <div class="rate-band-row" data-rate-band="${index}">
      <label><span>${t("rateBandLabel")}</span><input data-rate-field="label" value="${escapeHtml(band.label ?? "")}" /></label>
      <label><span>${t("rateBandPrice")}</span><input data-rate-field="yenPerKwh" type="number" min="0" step="0.01" value="${band.yenPerKwh ?? ""}" /></label>
      <label><span>${t("rateBandStart")}</span><input data-rate-field="start" type="time" value="${band.start ?? "00:00"}" /></label>
      <label><span>${t("rateBandEnd")}</span><input data-rate-field="end" type="time" value="${band.end ?? "00:00"}" /></label>
      <button class="ghost remove-rate-band" type="button">${t("removeRateBand")}</button>
    </div>
  `;
}

function renderRateBands(bands = []) {
  const el = $("#rateBands");
  if (!el) return;
  const source = bands.length
    ? bands
    : [
        {
          start: "00:00",
          end: "07:00",
          yenPerKwh: $("#offPeakRate")?.value || 25,
          label: "Off-peak",
        },
      ];
  el.innerHTML = source.map(rateBandRow).join("");
}

function collectRateBands() {
  return $$("#rateBands .rate-band-row")
    .map((row) => {
      const field = (name) =>
        row.querySelector(`[data-rate-field="${name}"]`)?.value ?? "";
      return {
        label: field("label"),
        start: field("start") || "00:00",
        end: field("end") || "00:00",
        yenPerKwh: Number(field("yenPerKwh")),
      };
    })
    .filter((band) => Number.isFinite(band.yenPerKwh));
}

function defaultOffPeakBands(standardRate, offPeakRate) {
  return [
    {
      start: "00:00",
      end: "07:00",
      yenPerKwh: Number(offPeakRate || 0),
      label: "Off-peak",
    },
    {
      start: "07:00",
      end: "00:00",
      yenPerKwh: Number(standardRate || 0),
      label: "Standard",
    },
  ];
}

function defaultMultiBands(offPeakRate) {
  return [
    {
      start: "00:00",
      end: "07:00",
      yenPerKwh: Number(offPeakRate || 0),
      label: "Off-peak",
    },
  ];
}

function rateModeFromConfig(config = {}) {
  if (["simple", "offPeak", "multi"].includes(config.rateMode))
    return config.rateMode;
  if (config.offPeakSavingsEnabled === true)
    return (config.rateBands ?? []).length > 2 ? "multi" : "offPeak";
  return "simple";
}

function currentRateMode() {
  return (
    document.querySelector('input[name="rateMode"]:checked')?.value ?? "simple"
  );
}

function updateRateModeVisibility(mode = currentRateMode()) {
  $$("[data-rate-mode-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.rateModePanel !== mode);
  });
}

function buildRateConfigBody() {
  const mode = currentRateMode();
  if (mode === "simple") {
    const rate = Number($("#simpleRate").value || 0);
    return {
      rateMode: "simple",
      standardRateYenPerKwh: rate,
      offPeakRateYenPerKwh: rate,
      offPeakSavingsEnabled: false,
      rateBands: [
        { start: "00:00", end: "00:00", yenPerKwh: rate, label: "Simple" },
      ],
    };
  }
  if (mode === "offPeak") {
    const standardRate = Number($("#standardRate").value || 0);
    const offPeakRate = Number($("#offPeakRate").value || 0);
    return {
      rateMode: "offPeak",
      standardRateYenPerKwh: standardRate,
      offPeakRateYenPerKwh: offPeakRate,
      offPeakSavingsEnabled: true,
      rateBands: defaultOffPeakBands(standardRate, offPeakRate),
    };
  }
  const bands = collectRateBands();
  const rates = bands.map((band) => band.yenPerKwh).filter(Number.isFinite);
  const standardRate = Number(
    $("#multiStandardRate").value || Math.max(...rates, 0),
  );
  const offPeakRate = Math.min(...rates, standardRate);
  return {
    rateMode: "multi",
    standardRateYenPerKwh: standardRate,
    offPeakRateYenPerKwh: offPeakRate,
    offPeakSavingsEnabled: true,
    rateBands: bands.length ? bands : defaultMultiBands(offPeakRate),
  };
}

function defaultAutomationRule() {
  return {
    name: "Charging demand guard",
    type: "backup-demand-guard",
    enabled: false,
    conditions: {
      source: "gridImportW",
      breakerAmps: 40,
      breakerVoltage: 100,
      reserveAmps: 5,
      restoreBelowAmps: 30,
      restoreDelaySeconds: 300,
    },
    action: "set-mode",
    payload: { mode: "standby" },
    restoreAction: "set-mode",
    restorePayload: { mode: "auto" },
    cooldownSeconds: 300,
  };
}

function updateAutomationControls(rules = state.automationRules) {
  const rule =
    rules.find((item) => item.type === "backup-demand-guard") ??
    defaultAutomationRule();
  $("#automationEnabled").checked = rule.enabled === true;
  $("#automationBreakerAmps").value = rule.conditions?.breakerAmps ?? "";
  $("#automationReserveAmps").value = rule.conditions?.reserveAmps ?? "";
  $("#automationRestoreBelow").value = rule.conditions?.restoreBelowAmps ?? "";
  $("#automationRestoreDelay").value =
    rule.conditions?.restoreDelaySeconds ?? "";
  renderAutomationLog(rule);
}

function renderAutomationLog(rule) {
  const log = Array.isArray(rule.log) ? rule.log : [];
  const logEl = $("#automationLog");
  logEl.innerHTML = "";
  const emptyLogMessage = rule.id ? t("automationNoLog") : t("automationNoRules");
  const entries = log.length ? log.slice().reverse() : [{ message: emptyLogMessage }];
  for (const entry of entries) {
    const row = document.createElement("div");
    if (entry.at) {
      const time = document.createElement("time");
      time.textContent = new Date(entry.at).toLocaleString();
      row.append(time);
    }
    const message = document.createElement("span");
    message.textContent = normalizeAutomationLogMessage(entry.message ?? "");
    row.append(message);
    logEl.append(row);
  }
}

function settingsInputIsActive() {
  const active = document.activeElement;
  return state.currentPage === "settings" &&
    (state.isComposing ||
      Boolean(active?.closest?.("#settingsPage") && active.matches("input, textarea, select, button")));
}

function normalizeAutomationLogMessage(message) {
  return String(message)
    .replace(/^House demand/, "Grid Import")
    .replace(/\((auto|standby|rapid|charge|discharge)\)/gi, "$1")
    .replace(/battery working state/g, "operation mode");
}

async function refreshAutomationRules() {
  state.automationRules = await api("/api/automation-rules");
  updateAutomationControls(state.automationRules);
  return state.automationRules;
}

async function refreshAutomationLog() {
  if (settingsInputIsActive()) return state.automationRules;
  state.automationRules = await api("/api/automation-rules");
  const rule =
    state.automationRules.find((item) => item.type === "backup-demand-guard") ??
    defaultAutomationRule(state.config ?? {});
  renderAutomationLog(rule);
  return state.automationRules;
}

function renderNotificationTriggerControls(config = {}) {
  const root = $("#notificationTriggerControls");
  if (!root) return;
  root.innerHTML = "";
  for (const definition of NOTIFICATION_TRIGGER_DEFINITIONS) {
    const trigger = config.triggers?.[definition.id] ?? {};
    const row = document.createElement("div");
    row.className = "notification-trigger-row";

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "check-row";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.dataset.notificationTrigger = definition.id;
    enabled.checked = trigger.enabled !== false;
    const name = document.createElement("span");
    name.textContent = t(definition.labelKey);
    enabledLabel.append(enabled, name);

    const cooldownLabel = document.createElement("label");
    cooldownLabel.className = "notification-cooldown-field";
    const cooldownName = document.createElement("span");
    cooldownName.textContent = t("notificationCooldown");
    const cooldown = document.createElement("input");
    cooldown.type = "number";
    cooldown.min = "1";
    cooldown.max = "10080";
    cooldown.step = "1";
    cooldown.inputMode = "numeric";
    cooldown.dataset.notificationCooldown = definition.id;
    cooldown.value = trigger.cooldownMinutes ?? 30;
    cooldownLabel.append(cooldownName, cooldown);

    const triggerSettings = document.createElement("div");
    triggerSettings.className = "notification-trigger-settings";
    triggerSettings.append(cooldownLabel);
    if (definition.threshold) {
      const thresholdLabel = document.createElement("label");
      const thresholdName = document.createElement("span");
      thresholdName.textContent = t("notificationSocThreshold");
      const threshold = document.createElement("input");
      threshold.type = "number";
      threshold.min = "1";
      threshold.max = "95";
      threshold.step = "1";
      threshold.inputMode = "numeric";
      threshold.dataset.notificationThreshold = definition.id;
      threshold.value = trigger.thresholdPercent ?? 20;
      thresholdLabel.append(thresholdName, threshold);
      triggerSettings.append(thresholdLabel);
    }

    row.append(enabledLabel, triggerSettings);
    root.append(row);
  }
}

function renderNotificationLog(deliveries = []) {
  const root = $("#notificationLog");
  if (!root) return;
  root.innerHTML = "";
  if (!deliveries.length) {
    root.textContent = t("noNotificationDeliveries");
    return;
  }
  for (const delivery of deliveries) {
    const row = document.createElement("div");
    const time = document.createElement("time");
    time.textContent = new Date(delivery.at).toLocaleString();
    const message = document.createElement("span");
    const errors = (delivery.attempts ?? []).map((attempt) => attempt.error).filter(Boolean);
    message.textContent = `${delivery.ok ? t("notificationSuccess") : t("notificationFailure")}: ${delivery.event?.title ?? ""}${errors.length ? ` - ${errors.join("; ")}` : ""}`;
    row.append(time, message);
    root.append(row);
  }
}

function renderNotificationView(view) {
  state.notifications = view;
  const config = view.config ?? {};
  const channel = config.channels?.find((item) => item.type === "smtp") ?? { settings: {} };
  const settings = channel.settings ?? {};
  $("#notificationsEnabled").checked = config.enabled === true;
  $("#smtpHost").value = settings.host ?? "";
  $("#smtpPort").value = settings.port ?? 587;
  $("#smtpSecurity").value = settings.security ?? "starttls";
  $("#smtpUsername").value = settings.username ?? "";
  $("#smtpPassword").value = "";
  $("#smtpFrom").value = settings.from ?? "";
  $("#smtpRecipients").value = (settings.recipients ?? []).join(", ");
  $("#smtpClearPasswordRow").classList.toggle("hidden", !view.passwordConfigured);
  $("#smtpClearPassword").checked = false;
  $("#notificationStatus").textContent = view.passwordConfigured
    ? t("passwordConfigured")
    : t("passwordNotConfigured");
  renderNotificationTriggerControls(config);
  renderNotificationLog(view.deliveries ?? []);
}

function collectNotificationConfig() {
  const triggers = {};
  for (const definition of NOTIFICATION_TRIGGER_DEFINITIONS) {
    const threshold = $(`[data-notification-threshold="${definition.id}"]`);
    triggers[definition.id] = {
      enabled: $(`[data-notification-trigger="${definition.id}"]`).checked,
      cooldownMinutes: $(`[data-notification-cooldown="${definition.id}"]`).value,
      ...(threshold ? { thresholdPercent: threshold.value } : {}),
    };
  }
  return {
    enabled: $("#notificationsEnabled").checked,
    channels: [{
      id: "primary-email",
      type: "smtp",
      enabled: true,
      settings: {
        host: $("#smtpHost").value,
        port: $("#smtpPort").value,
        security: $("#smtpSecurity").value,
        username: $("#smtpUsername").value,
        from: $("#smtpFrom").value,
        recipients: $("#smtpRecipients").value,
      },
    }],
    triggers,
  };
}

async function refreshNotifications() {
  if (settingsInputIsActive()) return state.notifications;
  const view = await api("/api/notifications");
  renderNotificationView(view);
  return view;
}

function adaptiveChargingConfiguredInUi(config = state.config ?? {}) {
  return config.adaptiveCharging?.enabled === true && config.solarEnabled !== false && config.rateMode !== "simple";
}

function updateScheduleAdaptiveChargingState(config = state.config ?? {}) {
  const disabled = adaptiveChargingConfiguredInUi(config);
  $("#scheduleAdaptiveChargingNotice")?.classList.toggle("hidden", !disabled);
  $(".schedule-panel")?.classList.toggle("adaptive-charging-disabled", disabled);
  $$("#scheduleForm input, #scheduleForm select, #scheduleForm button, #scheduleRows button").forEach((control) => {
    control.disabled = disabled;
  });
}

function formatAdaptiveChargingKwh(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? `${Number(value).toFixed(2)} kWh`
    : "--";
}

function formatAdaptiveChargingPercent(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? `${Number(value).toFixed(0)}%`
    : "--";
}

function adaptiveChargingLocale() {
  return state.language === "ja" ? "ja-JP" : "en-GB";
}

function formatAdaptiveChargingDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(adaptiveChargingLocale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatAdaptiveChargingTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(adaptiveChargingLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatAdaptiveChargingDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(adaptiveChargingLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatAdaptiveChargingRange(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return "--";
  const sameDay = startDate.getFullYear() === endDate.getFullYear()
    && startDate.getMonth() === endDate.getMonth()
    && startDate.getDate() === endDate.getDate();
  return sameDay
    ? `${formatAdaptiveChargingDateTime(start)}–${formatAdaptiveChargingTime(end)}`
    : `${formatAdaptiveChargingDateTime(start)}–${formatAdaptiveChargingDateTime(end)}`;
}

function nextAdaptiveChargingSlot(status, now = Date.now()) {
  if (status?.owner === "adaptiveCharging" && status.activeSlot) return status.activeSlot;
  return (status?.plan?.slots ?? []).find((slot) => new Date(slot.end).getTime() > now) ?? null;
}

function adaptiveChargingDisplayState(status) {
  if (!status?.enabled) return t("adaptiveChargingDisabled");
  if (status.owner === "adaptiveCharging") return t("adaptiveChargingCharging");
  if (status.paused) return t("paused");
  if (status.available) return status.warning ? t("adaptiveChargingReadyPartial") : t("adaptiveChargingReady");
  return t("adaptiveChargingUnavailable");
}

function adaptiveChargingNextAction(status) {
  if (!status?.enabled) return t("enableAdaptiveCharging");
  if (status.owner === "adaptiveCharging" && status.activeSlot?.end) {
    return template("chargingUntil", { time: formatAdaptiveChargingTime(status.activeSlot.end) });
  }
  const next = nextAdaptiveChargingSlot(status);
  if (next) {
    return template("nextAdaptiveCharge", {
      time: formatAdaptiveChargingDateTime(next.start),
      energy: Math.round(Number(next.targetWh) || 0),
    });
  }
  return status.reason || status.warning || t("noChargingPlanned");
}

function renderAdaptiveChargingWidget(status) {
  const stateEl = $("#adaptiveChargingWidgetState");
  const note = $("#adaptiveChargingWidgetNote");
  if (!stateEl || !note) return;
  stateEl.textContent = adaptiveChargingDisplayState(status);
  note.textContent = adaptiveChargingNextAction(status);
}

function formatAwayDateTime(value) {
  return formatAdaptiveChargingDateTime(value);
}

function awaySummary(view = state.awayPeriodsView) {
  if (view?.active) {
    return template("awayUntil", { time: formatAwayDateTime(view.active.until) });
  }
  if (view?.next) {
    return template("nextAway", {
      from: formatAwayDateTime(view.next.from),
      until: formatAwayDateTime(view.next.until),
    });
  }
  return t("homeNoAway");
}

function resetAwayPeriodForm() {
  const form = $("#awayPeriodForm");
  if (!form) return;
  form.reset();
  form.dataset.mode = "create";
  $("#awayPeriodId").value = "";
  $("#awayFrom").disabled = false;
  $("#awayNow").disabled = false;
  $("#awaySave").textContent = t("scheduleAway");
  $("#awayCancel").classList.add("hidden");
  state.awayFromSetByNow = false;
}

function editAwayPeriod(period, mode = "edit") {
  const form = $("#awayPeriodForm");
  if (!form || !period) return;
  form.dataset.mode = mode;
  $("#awayPeriodId").value = period.id;
  $("#awayFrom").value = localDateTimeValue(new Date(period.from));
  $("#awayUntil").value = localDateTimeValue(new Date(period.until));
  $("#awayFrom").disabled = mode === "extend";
  $("#awayNow").disabled = mode === "extend";
  $("#awaySave").textContent = t(mode === "extend" ? "saveAwayExtension" : "saveAwayChanges");
  $("#awayCancel").classList.remove("hidden");
  state.awayFromSetByNow = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderAwayPeriods(view = state.awayPeriodsView) {
  if (!view) return;
  state.awayPeriodsView = view;
  const widgetState = $("#awayStatusWidgetState");
  const widgetNote = $("#awayStatusWidgetNote");
  if (widgetState) widgetState.textContent = t(view.state === "away" ? "away" : "home");
  if (widgetNote) widgetNote.textContent = awaySummary(view);
  setText("#awayCurrentSummary", awaySummary(view));

  const rows = $("#awayPeriodRows");
  if (!rows) return;
  rows.innerHTML = "";
  const periods = (view.periods ?? []).filter((period) => period.status !== "completed");
  rows.closest(".away-period-table-wrap")?.classList.toggle("hidden", periods.length === 0);
  for (const period of periods) {
    const row = document.createElement("tr");
    const from = document.createElement("td");
    const until = document.createElement("td");
    const status = document.createElement("td");
    const actions = document.createElement("td");
    from.textContent = formatAwayDateTime(period.from);
    until.textContent = formatAwayDateTime(period.until);
    status.textContent = t(period.status === "active" ? "active" : "scheduled");
    actions.className = "away-period-actions";
    const addAction = (action, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.dataset.awayAction = action;
      button.dataset.awayId = period.id;
      button.textContent = t(label);
      actions.append(button);
    };
    if (period.status === "active") {
      addAction("back-home", "backHome");
      addAction("extend", "extend");
    } else {
      addAction("edit", "edit");
      addAction("delete", "delete");
    }
    row.append(from, until, status, actions);
    rows.append(row);
  }
  const selectedId = $("#awayPeriodId")?.value;
  if (selectedId && !periods.some((period) => period.id === selectedId)) resetAwayPeriodForm();
}

function awayDemandDescription(demandHistory = {}) {
  if (!Number(demandHistory.awaySlotCount)) return t("awayDemandNotScheduled");
  const days = Number(demandHistory.awayComparableDayCount || 0);
  if (demandHistory.awayConfidence === "learned") return template("awayDemandLearned", { days });
  if (demandHistory.awayConfidence === "mixed") return template("awayDemandMixed", { days });
  return t("awayDemandLow");
}

function drawAdaptiveChargingTimeline(status = state.adaptiveChargingStatus) {
  const canvas = $("#adaptiveChargingTimeline");
  if (!canvas) return;
  const timeline = (status?.plan?.timeline ?? []).filter((item) => {
    return Number.isFinite(new Date(item.start).getTime()) && Number.isFinite(new Date(item.end).getTime());
  });
  $("#adaptiveChargingTimelineEmpty")?.classList.toggle("hidden", timeline.length > 0);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.width));
  const height = Math.max(1, Math.round(rect.height || canvas.height));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!timeline.length) return;

  const pad = { top: 22, right: 58, bottom: 42, left: 58 };
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = Math.max(1, height - pad.top - pad.bottom);
  const startMs = new Date(timeline[0].start).getTime();
  const endMs = new Date(timeline.at(-1).end).getTime();
  const spanMs = Math.max(1, endMs - startMs);
  const chargeW = (item) => {
    const durationHours = (new Date(item.end) - new Date(item.start)) / 3_600_000;
    return durationHours > 0 ? Number(item.plannedChargeWh || 0) / durationHours : 0;
  };
  const maxPower = Math.max(100, ...timeline.flatMap((item) => [item.demandW, item.solarW, item.fuelCellMedianW, chargeW(item)]).map(Number).filter(Number.isFinite));
  const xFor = (time) => pad.left + ((new Date(time).getTime() - startMs) / spanMs) * chartWidth;
  const powerY = (value) => pad.top + chartHeight - Math.max(0, Number(value) || 0) / maxPower * chartHeight;
  const socY = (value) => pad.top + chartHeight - Math.max(0, Math.min(100, Number(value) || 0)) / 100 * chartHeight;

  for (const item of timeline) {
    if (!item.away) continue;
    ctx.fillStyle = "rgba(71, 85, 105, 0.10)";
    ctx.fillRect(xFor(item.start), pad.top, Math.max(1, xFor(item.end) - xFor(item.start)), chartHeight);
  }
  for (const item of timeline) {
    if (!item.discounted) continue;
    ctx.fillStyle = "rgba(18, 124, 120, 0.08)";
    ctx.fillRect(xFor(item.start), pad.top, Math.max(1, xFor(item.end) - xFor(item.start)), chartHeight);
  }
  const hoveredItem = state.adaptiveChargingTimelineHover
    ? timeline[state.adaptiveChargingTimelineHover.index]
    : null;
  if (hoveredItem) {
    ctx.fillStyle = "rgba(15, 23, 42, 0.08)";
    ctx.fillRect(
      xFor(hoveredItem.start),
      pad.top,
      Math.max(1, xFor(hoveredItem.end) - xFor(hoveredItem.start)),
      chartHeight,
    );
  }
  ctx.strokeStyle = "#dbe5ef";
  ctx.fillStyle = "#64748b";
  ctx.font = "11px system-ui";
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + chartHeight * index / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(maxPower * (4 - index) / 4)} W`, 5, y + 4);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(100 * (4 - index) / 4)}%`, width - 5, y + 4);
    ctx.textAlign = "left";
  }

  const drawLine = (key, color, yFor) => {
    ctx.beginPath();
    timeline.forEach((item, index) => {
      const x = xFor((new Date(item.start).getTime() + new Date(item.end).getTime()) / 2);
      const y = yFor(item[key]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  };
  drawLine("demandW", "#dc2626", powerY);
  drawLine("solarW", "#d8872c", powerY);
  drawLine("fuelCellMedianW", "#db2777", powerY);

  const finiteSoc = (value) => value === null || value === undefined
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null);
  ctx.beginPath();
  let socLineStarted = false;
  timeline.forEach((item) => {
    const startSoc = finiteSoc(item.predictedStartSocPercent);
    const endSoc = finiteSoc(item.predictedEndSocPercent ?? item.predictedSocPercent);
    if (startSoc !== null) {
      const startX = xFor(item.start);
      if (!socLineStarted) ctx.moveTo(startX, socY(startSoc));
      else ctx.lineTo(startX, socY(startSoc));
      socLineStarted = true;
    }
    if (endSoc !== null) {
      const endX = xFor(item.end);
      if (!socLineStarted) ctx.moveTo(endX, socY(endSoc));
      else ctx.lineTo(endX, socY(endSoc));
      socLineStarted = true;
    }
  });
  if (socLineStarted) {
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  for (const item of timeline) {
    if (!(Number(item.plannedChargeWh) > 0)) continue;
    ctx.fillStyle = "#127c78";
    ctx.fillRect(xFor(item.start), pad.top + chartHeight - 9, Math.max(2, xFor(item.end) - xFor(item.start)), 9);
  }
  const now = Date.now();
  if (now >= startMs && now <= endMs) {
    const x = xFor(now);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.6)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "#64748b";
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const timeLabel = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameLocalDay = startDate.getFullYear() === endDate.getFullYear()
    && startDate.getMonth() === endDate.getMonth()
    && startDate.getDate() === endDate.getDate();
  const startLabel = width < 520
    ? timeLabel(startDate)
    : startDate.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const endLabel = width < 520 || sameLocalDay
    ? timeLabel(endDate)
    : endDate.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  ctx.fillText(startLabel, pad.left, height - 12);
  ctx.textAlign = "right";
  ctx.fillText(endLabel, width - pad.right, height - 12);
  ctx.textAlign = "left";

  const hover = state.adaptiveChargingTimelineHover;
  if (hover) {
    const item = timeline[hover.index];
    if (item) {
      const startX = xFor(item.start);
      const endX = xFor(item.end);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.5)";
      ctx.beginPath();
      ctx.moveTo(startX, pad.top);
      ctx.lineTo(startX, pad.top + chartHeight);
      ctx.moveTo(endX, pad.top);
      ctx.lineTo(endX, pad.top + chartHeight);
      ctx.stroke();

      const endSoc = finiteSoc(item.predictedEndSocPercent ?? item.predictedSocPercent);
      if (endSoc !== null) {
        ctx.beginPath();
        ctx.arc(endX, socY(endSoc), 4, 0, Math.PI * 2);
        ctx.fillStyle = "#7c3aed";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

function handleAdaptiveChargingTimelinePointer(event) {
  const timeline = state.adaptiveChargingStatus?.plan?.timeline ?? [];
  const canvas = $("#adaptiveChargingTimeline");
  if (!canvas || !timeline.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { right: 58, left: 58 };
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - pad.left) / Math.max(1, rect.width - pad.left - pad.right)));
  const timelineStartMs = new Date(timeline[0].start).getTime();
  const timelineEndMs = new Date(timeline.at(-1).end).getTime();
  const pointerMs = timelineStartMs + ratio * Math.max(1, timelineEndMs - timelineStartMs);
  let index = timeline.findIndex((candidate, candidateIndex) => {
    const candidateStartMs = new Date(candidate.start).getTime();
    const candidateEndMs = new Date(candidate.end).getTime();
    return pointerMs >= candidateStartMs
      && (pointerMs < candidateEndMs || (candidateIndex === timeline.length - 1 && pointerMs <= candidateEndMs));
  });
  if (index < 0) {
    index = timeline.reduce((nearestIndex, candidate, candidateIndex) => {
      const candidateStartMs = new Date(candidate.start).getTime();
      const candidateEndMs = new Date(candidate.end).getTime();
      const distance = Math.min(Math.abs(pointerMs - candidateStartMs), Math.abs(pointerMs - candidateEndMs));
      const nearest = timeline[nearestIndex];
      const nearestStartMs = new Date(nearest.start).getTime();
      const nearestEndMs = new Date(nearest.end).getTime();
      const nearestCandidateDistance = Math.min(
        Math.abs(pointerMs - nearestStartMs),
        Math.abs(pointerMs - nearestEndMs),
      );
      return distance < nearestCandidateDistance ? candidateIndex : nearestIndex;
    }, 0);
  }
  const item = timeline[index];
  state.adaptiveChargingTimelineHover = { index };
  drawAdaptiveChargingTimeline();
  const tooltip = ensureTrendTooltip();
  const rate = item.yenPerKwh === null || item.yenPerKwh === undefined ? "--" : `${item.yenPerKwh} yen/kWh`;
  const awayDetail = item.away
    ? ` · ${template("awayTimelineDetail", { confidence: item.awayDemandConfidence || "low" })}`
    : "";
  const storedCharge = Number.isFinite(Number(item.predictedStoredChargeWh))
    ? ` / ${item.predictedStoredChargeWh} Wh stored`
    : "";
  const startSoc = item.predictedStartSocPercent;
  const endSoc = item.predictedEndSocPercent ?? item.predictedSocPercent;
  const socDetail = startSoc === null || startSoc === undefined
    ? `End SOC ${formatAdaptiveChargingPercent(endSoc)}`
    : `End SOC ${formatAdaptiveChargingPercent(endSoc)} (from ${formatAdaptiveChargingPercent(startSoc)})`;
  const fuelCellDetail = Number(item.fuelCellMedianW) > 0 || Number(item.fuelCellSampleCount) > 0
    ? ` · ${Math.round(item.fuelCellMedianW)} W Ene-Farm median (P20 ${Math.round(item.fuelCellP20W)} W, P80 ${Math.round(item.fuelCellP80W)} W)`
    : "";
  tooltip.textContent = `${formatAdaptiveChargingRange(item.start, item.end)} · ${Math.round(item.demandW)} W average demand · ${Math.round(item.solarW)} W average solar${fuelCellDetail} · ${socDetail} · ${item.plannedChargeWh} Wh charge${storedCharge} · ${item.rateLabel || "Standard"} (${rate})${awayDetail}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 270, event.clientX + 12)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - 48)}px`;
  tooltip.classList.remove("hidden");
}

function clearAdaptiveChargingTimelinePointer() {
  state.adaptiveChargingTimelineHover = null;
  drawAdaptiveChargingTimeline();
  $("#trendTooltip")?.classList.add("hidden");
}

function renderSolarForecastAccuracy(accuracy = {}) {
  const outcomes = Array.isArray(accuracy.outcomes) ? accuracy.outcomes : [];
  const sampleCount = Number(accuracy.sampleCount ?? outcomes.length) || 0;
  const correctionPercent = (Number(accuracy.factor) - 1) * 100;
  $("#solarForecastBiasCorrection").textContent = accuracy.learned
    ? template("forecastBiasApplied", {
        value: `${correctionPercent >= 0 ? "+" : ""}${correctionPercent.toFixed(0)}`,
        count: sampleCount,
      })
    : template("forecastBiasLearning", { count: sampleCount });
  $("#solarForecastCompletedDays").textContent = String(outcomes.length);
  const absoluteErrorsKwh = outcomes
    .map((outcome) => Math.abs(Number(outcome.errorKwh)))
    .filter(Number.isFinite);
  const meanAbsoluteErrorKwh = absoluteErrorsKwh.length
    ? absoluteErrorsKwh.reduce((sum, value) => sum + value, 0) / absoluteErrorsKwh.length
    : null;
  $("#solarForecastMeanError").textContent = accuracy.learned
    && Number.isFinite(Number(accuracy.meanAbsolutePercentageError))
    ? `${Number(accuracy.meanAbsolutePercentageError).toFixed(1)}%`
    : Number.isFinite(meanAbsoluteErrorKwh)
      ? formatAdaptiveChargingKwh(meanAbsoluteErrorKwh)
      : "--";
  const confidence = $("#solarForecastAccuracyConfidence");
  confidence.textContent = sampleCount > 0
    ? template(accuracy.learned ? "forecastAccuracyEstablished" : "forecastAccuracyEarly", { count: sampleCount })
    : "";
  confidence.classList.toggle("hidden", sampleCount === 0);

  const rows = $("#solarForecastAccuracyRows");
  rows.innerHTML = "";
  for (const outcome of [...outcomes].reverse()) {
    const row = document.createElement("tr");
    const errorKwh = Number(outcome.errorKwh);
    const errorPercent = Number(outcome.errorPercent);
    const values = [
      formatAdaptiveChargingDate(`${outcome.targetDate}T00:00:00`),
      formatAdaptiveChargingKwh(outcome.predictedKwh),
      formatAdaptiveChargingKwh(outcome.planningKwh),
      formatAdaptiveChargingKwh(outcome.actualKwh),
      Number.isFinite(errorKwh)
        ? `${errorKwh >= 0 ? "+" : ""}${errorKwh.toFixed(2)} kWh${Number.isFinite(errorPercent) ? ` (${errorPercent >= 0 ? "+" : ""}${errorPercent.toFixed(0)}%)` : ""}`
        : "--",
    ];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.dataset.label = [
        t("date"),
        t("issuedForecast"),
        t("planningEstimate"),
        t("actualGeneration"),
        t("forecastError"),
      ][index];
      if (index === 4 && Number.isFinite(errorKwh)) cell.className = "solar-forecast-error";
      row.append(cell);
    }
    rows.append(row);
  }
  $("#solarForecastAccuracyEmpty").classList.toggle("hidden", outcomes.length > 0);
  rows.closest("table").classList.toggle("hidden", outcomes.length === 0);
}

function batteryModelBlockerText(blocker) {
  const value = String(blocker ?? "");
  const patterns = [
    [/^(\d+) more eligible observations required$/, "batteryBlockerObservations", ["count"]],
    [/^(\d+) more distinct days required$/, "batteryBlockerDays", ["count"]],
    [/^(\d+) more SOC points required$/, "batteryBlockerSocPoints", ["count"]],
    [/^dispersion ([\d.]+)% exceeds ([\d.]+)%$/, "batteryBlockerDispersion", ["value", "limit"]],
    [/^rolling stability must be within ([\d.]+)%$/, "batteryBlockerStability", ["limit"]],
    [/^valid observation acceptance ([\d.]+)% is below 60%$/, "batteryBlockerAcceptance", ["value"]],
    [/^(\d+) more forward validations required$/, "batteryBlockerValidations", ["count"]],
    [/^validation mean error exceeds 3 SOC points$/, "batteryBlockerMeanError", []],
    [/^validation bias exceeds 2 SOC points$/, "batteryBlockerBias", []],
    [/^validation maximum error exceeds 6 SOC points$/, "batteryBlockerMaximumError", []],
    [/^(\d+) more post-migration steady samples required$/, "batteryBlockerPowerSamples", ["count"]],
    [/^(\d+) more charging sessions required$/, "batteryBlockerPowerSessions", ["count"]],
    [/^charge-power dispersion must be within 3%$/, "batteryBlockerPowerDispersion", []],
  ];
  for (const [pattern, key, names] of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    return template(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
  }
  return value;
}

function renderFuelCellForecastOutcomes(outcomes = []) {
  const latestByInterval = new Map();
  for (const outcome of outcomes) {
    const key = outcome.targetStart ?? outcome.start;
    if (!key || latestByInterval.has(key)) continue;
    latestByInterval.set(key, outcome);
  }
  const rows = [...latestByInterval.values()].map((outcome) => {
    const start = new Date(outcome.start ?? outcome.targetStart);
    const end = new Date(outcome.end);
    const actualKwh = outcome.actualKwh === null || outcome.actualKwh === undefined
      ? Number.NaN
      : Number(outcome.actualKwh);
    const durationHours = Math.max(0, end.getTime() - start.getTime()) / 3_600_000;
    const medianKwh = Number(outcome.medianW) * durationHours / 1000;
    return {
      ...outcome,
      start,
      end,
      durationHours,
      actualKwh,
      medianKwh,
      errorKwh: actualKwh - medianKwh,
    };
  }).filter((outcome) => !Number.isNaN(outcome.start.getTime())
    && !Number.isNaN(outcome.end.getTime())
    && Number.isFinite(outcome.actualKwh)
    && Number.isFinite(outcome.medianKwh));

  setText("#fuelCellForecastCompletedIntervals", String(rows.length));
  setText("#fuelCellForecastMeanError", rows.length
    ? energyKwh(rows.reduce((sum, outcome) => sum + Math.abs(outcome.errorKwh), 0) / rows.length)
    : "--");
  setText("#fuelCellForecastBias", rows.length
    ? energyKwh(rows.reduce((sum, outcome) => sum + outcome.errorKwh, 0) / rows.length)
    : "--");

  const body = $("#fuelCellForecastOutcomeRows");
  body.innerHTML = "";
  for (const outcome of rows.slice(0, 12)) {
    const p20Kwh = Number(outcome.p20W) * outcome.durationHours / 1000;
    const p80Kwh = Number(outcome.p80W) * outcome.durationHours / 1000;
    const row = document.createElement("tr");
    const values = [
      formatAdaptiveChargingRange(outcome.start, outcome.end),
      `${energyKwh(p20Kwh)}–${energyKwh(p80Kwh)}`,
      energyKwh(outcome.medianKwh),
      energyKwh(outcome.actualKwh),
      energyKwh(outcome.errorKwh),
      displayValue(outcome.influence),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  $("#fuelCellForecastOutcomeEmpty").classList.toggle("hidden", rows.length > 0);
}

function renderAdaptiveChargingStatus(status = state.adaptiveChargingStatus) {
  if (!status) return;
  state.adaptiveChargingStatus = status;
  renderAdaptiveChargingWidget(status);
  renderAwayPeriods(status.away);
  renderSolarForecastAccuracy(status.solarForecastAccuracy);
  renderFuelCellForecastOutcomes(status.fuelCellForecastOutcomes);
  const plan = status.plan ?? {};
  const nextSlot = nextAdaptiveChargingSlot(status);
  $("#adaptiveChargingNextAction").textContent = adaptiveChargingNextAction(status);
  $("#adaptiveChargingCurrentSoc").textContent = formatAdaptiveChargingPercent(plan.currentSocPercent);
  $("#adaptiveChargingNextTarget").textContent = formatAdaptiveChargingPercent(nextSlot?.targetSocPercent);
  $("#adaptiveChargingPlanHorizon").textContent = plan.targetSunset
    ? formatAdaptiveChargingDateTime(plan.targetSunset)
    : "--";
  $("#adaptiveChargingForecastHorizon").textContent = plan.targetSunset
    ? template("forecastThrough", { time: formatAdaptiveChargingDateTime(plan.targetSunset) })
    : t("forecastHorizonUnavailable");
  $("#adaptiveChargingForecastAge").textContent = Number.isFinite(status.forecast?.ageMs)
    ? `${Math.round(status.forecast.ageMs / 60_000)} min`
    : "--";
  $("#adaptiveChargingPredictedSolar").textContent = formatAdaptiveChargingKwh(plan.predictedSolarKwh);
  $("#adaptiveChargingPredictedDemand").textContent = formatAdaptiveChargingKwh(plan.predictedDemandKwh);
  $("#adaptiveChargingPredictedFuelCell").textContent = formatAdaptiveChargingKwh(plan.predictedFuelCellKwh);
  $("#adaptiveChargingPredictedSurplus").textContent = formatAdaptiveChargingKwh(plan.predictedSurplusKwh);
  $("#adaptiveChargingGridCharge").textContent = formatAdaptiveChargingKwh(plan.plannedChargeKwh);
  $("#adaptiveChargingStoredCharge").textContent = formatAdaptiveChargingKwh(plan.plannedStoredChargeKwh);
  $("#adaptiveChargingSunsetSoc").textContent = Number.isFinite(Number(plan.expectedSunsetSocPercent))
    ? `${Number(plan.expectedSunsetSocPercent).toFixed(0)}%`
    : "--";
  const batteryModel = status.batteryModel ?? {};
  const statusKey = {
    learning: "batteryModelLearning",
    validating: "batteryModelValidating",
    active: "batteryModelActive",
    degraded: "batteryModelDegraded",
  }[batteryModel.status] ?? "batteryModelLearning";
  $("#adaptiveChargingBatteryModelStatus").textContent = `${t(statusKey)} · v${batteryModel.version ?? 2}`;
  const optionalNumber = (value) => value === null || value === undefined || value === ""
    ? Number.NaN
    : Number(value);
  const coefficientText = (model = {}) => {
    const configured = optionalNumber(model.configuredWhPerSocPoint);
    const active = optionalNumber(model.activeWhPerSocPoint);
    const candidate = optionalNumber(model.candidateWhPerSocPoint);
    const parts = [];
    if (Number.isFinite(configured)) {
      parts.push(template("configuredModelValue", { value: `${configured.toFixed(1)} Wh/SOC` }));
    }
    if (Number.isFinite(candidate)) {
      parts.push(template(
        model.source === "learned" ? "validatedCandidateModelValue" : "candidateModelValue",
        { value: `${candidate.toFixed(1)} Wh/SOC` },
      ));
    }
    if (Number.isFinite(active)) {
      parts.push(template(
        model.source === "learned" ? "learnedModelValue" : "activeConfiguredModelValue",
        { value: `${active.toFixed(1)} Wh/SOC` },
      ));
    }
    parts.push(template("batteryModelProgress", {
      count: model.acceptedObservationCount ?? 0,
      days: model.distinctDays ?? 0,
      points: Math.round(Number(model.totalSocPoints) || 0),
    }));
    const validationMae = optionalNumber(model.validation?.meanAbsoluteErrorSoc);
    if (Number.isFinite(validationMae)) {
      parts.push(template("batteryModelValidation", {
        value: validationMae.toFixed(1),
      }));
    }
    if (model.activatedAt) {
      parts.push(template("batteryModelActivatedAt", { value: formatAdaptiveChargingDateTime(model.activatedAt) }));
    }
    if (model.demotedAt && model.source !== "learned") {
      parts.push(template("batteryModelDemotedAt", { value: formatAdaptiveChargingDateTime(model.demotedAt) }));
    }
    if (model.blockers?.length) parts.push(model.blockers.map(batteryModelBlockerText).join("; "));
    return parts.join(" · ") || "--";
  };
  $("#adaptiveChargingChargeModel").textContent = coefficientText(batteryModel.charge);
  $("#adaptiveChargingDischargeModel").textContent = coefficientText(batteryModel.discharge);
  const power = batteryModel.power ?? {};
  const configuredPower = optionalNumber(power.configuredWatts);
  const activePower = optionalNumber(power.activeWatts);
  const candidatePower = optionalNumber(power.candidateWatts);
  const powerParts = [];
  if (Number.isFinite(configuredPower)) {
    powerParts.push(template("configuredModelValue", { value: `${Math.round(configuredPower)} W` }));
  }
  if (Number.isFinite(candidatePower)) {
    powerParts.push(template(
      power.source === "learned" ? "validatedCandidateModelValue" : "candidateModelValue",
      { value: `${Math.round(candidatePower)} W` },
    ));
  }
  if (Number.isFinite(activePower)) {
    powerParts.push(template(
      power.source === "learned" ? "learnedModelValue" : "activeConfiguredModelValue",
      { value: `${Math.round(activePower)} W` },
    ));
  }
  powerParts.push(template("chargeSamples", { count: power.sampleCount ?? 0 }));
  powerParts.push(template("postMigrationChargeSamples", { count: power.postMigrationSampleCount ?? 0 }));
  if (power.activatedAt) {
    powerParts.push(template("batteryModelActivatedAt", { value: formatAdaptiveChargingDateTime(power.activatedAt) }));
  }
  if (power.demotedAt && power.source !== "learned") {
    powerParts.push(template("batteryModelDemotedAt", { value: formatAdaptiveChargingDateTime(power.demotedAt) }));
  }
  if (power.blockers?.length) powerParts.push(power.blockers.map(batteryModelBlockerText).join("; "));
  $("#adaptiveChargingPowerModel").textContent = powerParts.join(" · ") || "--";
  $("#adaptiveChargingConfidence").textContent = `${state.config?.adaptiveCharging?.forecastMarginPercent ?? 10}% · ${plan.solarCalibration?.learned ? t("calibratedForecast") : t("initialForecastModel")}`;
  const fuelCellModel = plan.fuelCellModel;
  $("#adaptiveChargingFuelCellModel").textContent = fuelCellModel
    ? `${displayValue(fuelCellModel.method)} · ${displayValue(fuelCellModel.influence)}${fuelCellModel.blockers?.length ? ` · ${fuelCellModel.blockers.join("; ")}` : ""}`
    : "--";
  const demandHistory = plan.demandHistory ?? {};
  $("#adaptiveChargingDemandHistory").textContent = Number(demandHistory.recentComparableDayCount) > 0
    ? Number(demandHistory.seasonalYears?.length) > 0
      ? template("recentAndSeasonalHistory", {
          days: demandHistory.recentComparableDayCount,
          years: demandHistory.seasonalYears.length,
          percent: demandHistory.seasonalBlendPercent,
        })
      : template("recentHistoryOnly", { days: demandHistory.recentComparableDayCount })
    : "--";
  $("#adaptiveChargingAwayDemand").textContent = awayDemandDescription(demandHistory);
  const waitingForHeadroom = status.lastResult?.skipped === "live grid import leaves insufficient breaker headroom";
  $("#adaptiveChargingState").textContent = status.owner === "adaptiveCharging"
    ? t("adaptiveChargingCharging")
    : status.paused
      ? t("paused")
      : waitingForHeadroom
        ? template("adaptiveChargingWaitingForHeadroom", {
            current: status.lastResult.gridImportW !== null
              && status.lastResult.gridImportW !== undefined
              && Number.isFinite(Number(status.lastResult.gridImportW))
              ? Math.round(Number(status.lastResult.gridImportW))
              : "--",
            threshold: status.lastResult.thresholdW !== null
              && status.lastResult.thresholdW !== undefined
              && Number.isFinite(Number(status.lastResult.thresholdW))
              ? Math.round(Number(status.lastResult.thresholdW))
              : "--",
          })
      : status.available
        ? status.warning ? t("adaptiveChargingReadyPartial") : t("adaptiveChargingReady")
        : adaptiveChargingDisplayState(status);
  const windows = $("#adaptiveChargingWindows");
  windows.innerHTML = "";
  for (const windowPlan of plan.windows ?? []) {
    const card = document.createElement("article");
    card.className = "adaptive-charging-window-summary";
    const slotRows = (plan.slots ?? []).filter(
      (slot) => new Date(slot.windowEnd).getTime() === new Date(windowPlan.end).getTime(),
    );
    const heading = document.createElement("div");
    heading.className = "adaptive-charging-window-heading";
    const title = document.createElement("h3");
    title.textContent = `${windowPlan.label} · ${formatAdaptiveChargingTime(windowPlan.start)}–${formatAdaptiveChargingTime(windowPlan.end)}`;
    const rate = document.createElement("span");
    rate.textContent = `${windowPlan.yenPerKwh} yen/kWh`;
    heading.append(title, rate);
    card.append(heading);

    const plannedRange = document.createElement("p");
    plannedRange.className = "adaptive-charging-window-range";
    plannedRange.textContent = slotRows.length
      ? `${t("plannedChargingRange")} · ${formatAdaptiveChargingTime(slotRows[0].start)}–${formatAdaptiveChargingTime(slotRows.at(-1).end)}`
      : t("noChargingPlanned");
    card.append(plannedRange);

    const metrics = document.createElement("dl");
    metrics.className = "adaptive-charging-window-metrics";
    const addMetric = (label, value, warning = false) => {
      const metric = document.createElement("div");
      if (warning) metric.className = "adaptive-charging-window-warning";
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      metric.append(term, description);
      metrics.append(metric);
    };
    addMetric(t("predictedStartSoc"), formatAdaptiveChargingPercent(windowPlan.predictedStartSocPercent));
    addMetric(t("windowTarget"), formatAdaptiveChargingPercent(windowPlan.targetSocPercent));
    addMetric(t("predictedEndSoc"), formatAdaptiveChargingPercent(windowPlan.predictedEndSocPercent));
    addMetric(t("requiredCharge"), formatAdaptiveChargingKwh(windowPlan.requestedChargeKwh));
    addMetric(t("availableCharge"), formatAdaptiveChargingKwh(windowPlan.availableChargeKwh));
    addMetric(t("plannedCharge"), formatAdaptiveChargingKwh(windowPlan.plannedChargeKwh));
    addMetric(t("expectedStoredCharge"), formatAdaptiveChargingKwh(windowPlan.plannedStoredChargeKwh));
    addMetric(t("solarHeadroom"), formatAdaptiveChargingKwh(windowPlan.solarHeadroomKwh));
    if (Number(windowPlan.unmetChargeKwh) > 0.0001) {
      addMetric(t("remainingShortfall"), formatAdaptiveChargingKwh(windowPlan.unmetChargeKwh), true);
    }
    card.append(metrics);

    const notes = [];
    if (windowPlan.bridgeToCheaperWindow) notes.push(t("bridgeCharge"));
    if (Number(windowPlan.backfillForLaterKwh) > 0.0001) {
      notes.push(`${t("laterWindowBackfill")} · ${formatAdaptiveChargingKwh(windowPlan.backfillForLaterKwh)}`);
    }
    if (notes.length) {
      const note = document.createElement("p");
      note.className = "adaptive-charging-window-note";
      note.textContent = notes.join(" · ");
      card.append(note);
    }

    for (const slot of slotRows) {
      const row = document.createElement("div");
      row.className = "adaptive-charging-slot-summary";
      row.textContent = `${formatAdaptiveChargingRange(slot.start, slot.end)} · ${slot.targetWh} Wh`;
      card.append(row);
    }
    windows.append(card);
  }
  if (!windows.children.length) windows.textContent = t("noPlannedWindows");

  const executionHistory = $("#adaptiveChargingWindowSummaries");
  executionHistory.innerHTML = "";
  const executions = [
    ...(status.activeWindowExecution ? [{
      ...status.activeWindowExecution,
      unmetWh: Math.max(0, Number(status.activeWindowExecution.plannedWh) - Number(status.activeWindowExecution.deliveredWh)),
      endSocPercent: status.activeWindowExecution.latestSocPercent,
      active: true,
    }] : []),
    ...[...(status.windowSummaries ?? [])].reverse(),
  ];
  for (const execution of executions) {
    const card = document.createElement("article");
    card.className = "adaptive-charging-window-summary adaptive-charging-window-result";
    const heading = document.createElement("div");
    heading.className = "adaptive-charging-window-heading";
    const title = document.createElement("h3");
    title.textContent = `${execution.label || "Discounted"} · ${formatAdaptiveChargingTime(execution.windowStart)}–${formatAdaptiveChargingTime(execution.windowEnd)}`;
    const stateLabel = document.createElement("span");
    stateLabel.textContent = execution.active
      ? t("inProgress")
      : formatAdaptiveChargingDate(execution.windowStart);
    heading.append(title, stateLabel);
    card.append(heading);
    const metrics = document.createElement("dl");
    metrics.className = "adaptive-charging-window-metrics adaptive-charging-result-metrics";
    const values = [
      [t("plannedCharge"), `${Number(execution.plannedWh || 0)} Wh`],
      [t("deliveredCharge"), `${Number(execution.deliveredWh || 0)} Wh`],
      [t("remainingShortfall"), `${Number(execution.unmetWh || 0)} Wh`],
      [t("breakerInterruptions"), String(Number(execution.interruptionCount || 0))],
      [t("startingSoc"), formatAdaptiveChargingPercent(execution.startSocPercent)],
      [t("endingSoc"), formatAdaptiveChargingPercent(execution.endSocPercent)],
    ];
    for (const [label, value] of values) {
      const metric = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      metric.append(term, description);
      metrics.append(metric);
    }
    card.append(metrics);
    executionHistory.append(card);
  }
  if (!executionHistory.children.length) executionHistory.textContent = t("noWindowResults");
  const log = $("#adaptiveChargingLog");
  log.innerHTML = "";
  for (const entry of [...(status.log ?? [])].reverse()) {
    const row = document.createElement("div");
    row.innerHTML = `<time>${formatAdaptiveChargingDateTime(entry.at)}</time><span></span>`;
    row.querySelector("span").textContent = entry.message;
    log.append(row);
  }
  if (!log.children.length) log.textContent = t("noAdaptiveChargingLog");
  $("#adaptiveChargingResume").disabled = !status.paused;
  drawAdaptiveChargingTimeline(status);
}

function updateAdaptiveChargingAvailability(config = state.config ?? {}) {
  const reasons = [];
  if (config.solarEnabled === false) reasons.push(t("adaptiveChargingNeedsSolar"));
  if (config.rateMode === "simple") reasons.push(t("adaptiveChargingNeedsRates"));
  if (config.smartCosmoEnabled === false) reasons.push(t("adaptiveChargingNeedsDemand"));
  const requiredNumber = (selector, fallback) => {
    const field = $(selector);
    const value = field ? field.value : fallback;
    return value === "" || value === null || value === undefined ? Number.NaN : Number(value);
  };
  const latitude = requiredNumber("#adaptiveChargingLatitude", config.adaptiveCharging?.latitude);
  const longitude = requiredNumber("#adaptiveChargingLongitude", config.adaptiveCharging?.longitude);
  const arrayPeakKw = requiredNumber("#adaptiveChargingArrayPeak", config.adaptiveCharging?.arrayPeakKw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) reasons.push(t("adaptiveChargingNeedsLocation"));
  if (!Number.isFinite(arrayPeakKw) || arrayPeakKw <= 0) reasons.push(t("adaptiveChargingNeedsArray"));
  const capacityValue = config.batteryCapabilities?.usableCapacityKwh;
  const chargeWattsValue = config.batteryCapabilities?.maximumChargeWatts;
  const usableCapacityKwh = capacityValue === null || capacityValue === undefined ? Number.NaN : Number(capacityValue);
  const maximumChargeWatts = chargeWattsValue === null || chargeWattsValue === undefined ? Number.NaN : Number(chargeWattsValue);
  if (!Number.isFinite(usableCapacityKwh) || usableCapacityKwh <= 0
    || !Number.isFinite(maximumChargeWatts) || maximumChargeWatts <= 0) {
    reasons.push(t("adaptiveChargingNeedsBattery"));
  }
  const enable = $("#adaptiveChargingEnabled");
  const enabled = enable.checked;
  const configuredEnabled = config.adaptiveCharging?.enabled === true;
  enable.disabled = reasons.length > 0 && !enabled;
  const recalculateButton = $("#adaptiveChargingRecalculate");
  const recalculating = state.adaptiveChargingRecalculating === true;
  recalculateButton.disabled = recalculating || !enabled || !configuredEnabled || reasons.length > 0;
  recalculateButton.classList.toggle("is-recalculating", recalculating);
  recalculateButton.setAttribute("aria-busy", String(recalculating));
  recalculateButton.textContent = t(recalculating ? "recalculatingPlan" : "recalculatePlan");
  $("#adaptiveChargingResume").disabled = !configuredEnabled || !state.adaptiveChargingStatus?.paused || reasons.length > 0;
  const runtimeReason = configuredEnabled
    ? state.adaptiveChargingStatus?.available
      ? state.adaptiveChargingStatus?.warning
      : state.adaptiveChargingStatus?.reason
    : null;
  const availabilityText = reasons.length
    ? `${t("unavailable")}: ${reasons.join(" ")}`
    : runtimeReason ?? "";
  setText("#adaptiveChargingAvailability", availabilityText);
  setText("#adaptiveChargingSettingsAvailability", availabilityText);
  updateScheduleAdaptiveChargingState(config);
}

async function refreshAdaptiveCharging() {
  const status = await api("/api/adaptive-charging");
  renderAdaptiveChargingStatus(status);
  updateAdaptiveChargingAvailability();
  return status;
}

function updateControls(data) {
  // Settings are hydrated only when entering the Settings page so sliders/selects
  // do not jump around while the user is editing them.
  const mode = data.settings?.mode?.decoded?.mode;
  const selected = document.querySelector(
    `input[name="mode"][value="${mode}"]`,
  );
  if (selected) selected.checked = true;

  const dischargeLimitData = data.settings?.discharge_limit?.decoded
    ? data.settings.discharge_limit
    : data.settings?.discharge_limit?.lastKnown;
  const limit = dischargeLimitData?.decoded?.percent;
  if (Number.isInteger(limit)) {
    $("#limitValue").value = String(limit);
    $("#limitOutput").textContent = `${limit}%`;
  }

  const chargeData = data.settings?.osaifu_charge_window?.decoded
    ? data.settings.osaifu_charge_window
    : data.settings?.osaifu_charge_window?.lastKnown;
  const charge = parseOsaifuWindow(chargeData);
  if (charge) {
    $("#chargeStart").value = String(charge.start);
    $("#chargeEnd").value = String(charge.end);
  } else {
    $("#chargeStart").value = "";
    $("#chargeEnd").value = "";
  }

  const dischargeData = data.settings?.osaifu_discharge_window?.decoded
    ? data.settings.osaifu_discharge_window
    : data.settings?.osaifu_discharge_window?.lastKnown;
  const discharge = parseOsaifuWindow(dischargeData);
  if (discharge) {
    $("#dischargeStart").value = String(discharge.start);
    $("#dischargeEnd").value = String(discharge.end);
  } else {
    $("#dischargeStart").value = "";
    $("#dischargeEnd").value = "";
  }
}

function normalizeDashboardWidgets(config = {}) {
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

function refreshDashboardSectionVisibility() {
  $$("[data-widget-section]").forEach((section) => {
    const visibleWidgets = $$(
      `[data-widget-group="${section.dataset.widgetSection}"]`,
    ).filter((widget) => !widget.classList.contains("hidden"));
    section.classList.toggle("hidden", visibleWidgets.length === 0);
  });
}

function syncDashboardWidgetVisibility() {
  $$("[data-widget-id]").forEach((widget) => {
    const hiddenByConfig = widget.dataset.widgetHidden === "true";
    const hiddenByFeature = widget.dataset.featureHidden === "true";
    widget.classList.toggle("hidden", hiddenByConfig || hiddenByFeature);
  });
  refreshDashboardSectionVisibility();
}

function applyDashboardWidgetLayout(config = {}) {
  const widgets = normalizeDashboardWidgets(config);
  for (const group of ["trends", "status"]) {
    const grid = $(`[data-widget-section="${group}"] .widget-grid`);
    if (!grid) continue;
    widgets
      .filter((widget) => widget.group === group)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .forEach((widget) => {
        const el = $(`[data-widget-id="${widget.id}"]`);
        if (!el) return;
        el.dataset.widgetHidden = widget.visible ? "false" : "true";
        grid.append(el);
      });
  }
  applyGraphMenuOrder(widgets);
  syncDashboardWidgetVisibility();
}

function applyGraphMenuOrder(widgets) {
  // The Graphs menu lists the same trend metrics as the dashboard, so keep it in
  // the dashboard's configured priority order rather than the static HTML order.
  const submenu = $(".nav-submenu");
  if (!submenu) return;
  widgets
    .filter((widget) => widget.group === "trends")
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .forEach((widget) => {
      const button = submenu.querySelector(`[data-graph-page="${widget.id}"]`);
      if (button) submenu.append(button);
    });
  const circuitButton = submenu.querySelector('[data-graph-page="circuits"]');
  if (circuitButton) submenu.append(circuitButton);
}

function cacheDashboardLayout(config) {
  // Persist the layout so the very first paint on the next visit is already in the
  // saved order, instead of rendering in HTML order and then reshuffling once the
  // server config arrives.
  try {
    if (Array.isArray(config?.dashboardWidgets)) {
      localStorage.setItem(
        DASHBOARD_LAYOUT_CACHE_KEY,
        JSON.stringify(config.dashboardWidgets),
      );
    }
  } catch (_err) {
    // localStorage can be unavailable (private mode, disabled storage); the layout
    // still applies once the server config loads, just without the pre-paint hint.
  }
}

function applyCachedDashboardLayout() {
  try {
    const cached = localStorage.getItem(DASHBOARD_LAYOUT_CACHE_KEY);
    if (!cached) return;
    const dashboardWidgets = JSON.parse(cached);
    if (Array.isArray(dashboardWidgets)) {
      applyDashboardWidgetLayout({ dashboardWidgets });
    }
  } catch (_err) {
    // A malformed cache is harmless; the server config will set the order shortly.
  }
}

function renderDashboardWidgetControls(config = state.config ?? {}) {
  const root = $("#dashboardWidgetControls");
  if (!root) return;
  root.innerHTML = "";
  const widgets = normalizeDashboardWidgets(config);
  for (const group of ["trends", "status"]) {
    const groupEl = document.createElement("div");
    groupEl.className = "dashboard-widget-control-group";
    const heading = document.createElement("h2");
    heading.textContent = t(group === "trends" ? "trendWidgets" : "statusWidgets");
    groupEl.append(heading);
    widgets
      .filter((widget) => widget.group === group)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .forEach((widget) => {
        const row = document.createElement("div");
        row.className = "dashboard-widget-row";
        row.dataset.widgetId = widget.id;
        const feature = DASHBOARD_WIDGET_FEATURES[widget.id];
        if (feature) {
          row.dataset.feature = feature;
          row.classList.toggle("hidden", !featureEnabled(config, feature));
        }

        const visibleLabel = document.createElement("label");
        visibleLabel.className = "check-row";
        const visible = document.createElement("input");
        visible.type = "checkbox";
        visible.checked = widget.visible;
        visible.dataset.dashboardWidgetVisible = widget.id;
        const name = document.createElement("span");
        name.textContent = t(widget.labelKey);
        visibleLabel.append(visible, name);

        const priorityLabel = document.createElement("label");
        priorityLabel.className = "priority-field";
        const priorityText = document.createElement("span");
        priorityText.textContent = t("priority");
        const priority = document.createElement("input");
        priority.type = "number";
        priority.min = "0";
        priority.max = "10000";
        priority.step = "1";
        priority.inputMode = "numeric";
        priority.value = String(widget.priority);
        priority.dataset.dashboardWidgetPriority = widget.id;
        priorityLabel.append(priorityText, priority);

        row.append(visibleLabel, priorityLabel);
        groupEl.append(row);
      });
    root.append(groupEl);
  }
}

function collectDashboardWidgetControls() {
  return DASHBOARD_WIDGET_DEFAULTS.map((defaults) => {
    const visible = $(`[data-dashboard-widget-visible="${defaults.id}"]`);
    const priority = $(`[data-dashboard-widget-priority="${defaults.id}"]`);
    return {
      id: defaults.id,
      visible: visible ? visible.checked : defaults.visible,
      priority: priority ? priority.value : defaults.priority,
    };
  });
}

function circuitLabelIds(config = state.config ?? {}, status = state.status) {
  const ids = new Set([...Object.keys(config.circuitLabels ?? {}), ...circuitIdsFromStatus(status)]);
  return [...ids].filter((id) => Number.isInteger(Number(id))).sort((a, b) => Number(a) - Number(b));
}

function circuitLabelsAreBeingEdited() {
  const form = $("#circuitLabelsForm");
  return form?.dataset.dirty === "true" || document.activeElement?.matches("[data-circuit-label]");
}

function renderCircuitLabelControls(config = state.config ?? {}, options = {}) {
  const root = $("#circuitLabelControls");
  if (!root) return;
  const preserveExisting = options.preserveExisting === true;
  const existingValues = {};
  $$("[data-circuit-label]").forEach((input) => {
    existingValues[input.dataset.circuitLabel] = input.value;
  });
  const activeInput = document.activeElement?.matches("[data-circuit-label]")
    ? document.activeElement
    : null;
  const activeId = activeInput?.dataset.circuitLabel;
  const activeSelection = activeInput
    ? { start: activeInput.selectionStart, end: activeInput.selectionEnd }
    : null;
  const ids = new Set(circuitLabelIds(config));
  if (preserveExisting) {
    for (const id of Object.keys(existingValues)) ids.add(id);
  }
  const sortedIds = [...ids].filter((id) => Number.isInteger(Number(id))).sort((a, b) => Number(a) - Number(b));
  root.innerHTML = sortedIds.length
    ? ""
    : `<p class="empty-state">${t("noCircuitData")}</p>`;
  for (const id of sortedIds) {
    const row = document.createElement("label");
    row.className = "circuit-label-row";
    row.innerHTML = `
      <span>${t("circuit")} ${id}</span>
      <input data-circuit-label="${id}" maxlength="80" />
    `;
    row.querySelector("input").value = preserveExisting && Object.hasOwn(existingValues, id)
      ? existingValues[id]
      : config.circuitLabels?.[id] ?? "";
    root.append(row);
  }
  if (activeId) {
    const nextActive = root.querySelector(`[data-circuit-label="${activeId}"]`);
    nextActive?.focus();
    if (nextActive && activeSelection) {
      nextActive.setSelectionRange(activeSelection.start, activeSelection.end);
    }
  }
}

function collectCircuitLabels() {
  const labels = {};
  $$("[data-circuit-label]").forEach((input) => {
    const value = input.value.trim();
    if (value) labels[input.dataset.circuitLabel] = value;
  });
  return labels;
}

function setRetentionControl(inputSelector, indefiniteSelector, value, fallback) {
  const input = $(inputSelector);
  const indefinite = indefiniteSelector ? $(indefiniteSelector) : null;
  const isIndefinite = value === null;
  input.value = isIndefinite ? fallback : value ?? fallback;
  input.disabled = isIndefinite;
  if (indefinite) indefinite.checked = isIndefinite;
}

function collectRetentionConfig() {
  const finiteOrNull = (inputSelector, indefiniteSelector) =>
    $(indefiniteSelector).checked ? null : $(inputSelector).value;
  return {
    rawTelemetryDays: $("#rawTelemetryDays").value,
    intervalAggregatesDays: finiteOrNull("#intervalAggregatesDays", "#intervalAggregatesIndefinite"),
    dailyAggregatesDays: finiteOrNull("#dailyAggregatesDays", "#dailyAggregatesIndefinite"),
    adaptiveChargingHistoryDays: finiteOrNull("#adaptiveChargingHistoryDays", "#adaptiveChargingHistoryIndefinite"),
    automationEventDays: finiteOrNull("#automationEventDays", "#automationEventIndefinite"),
    notificationDeliveryDays: $("#notificationDeliveryDays").value,
    automaticMaintenance: $("#automaticRetention").checked,
  };
}

function fuelCellDayLabel(day) {
  const date = new Date(2026, 0, 4 + Number(day));
  return new Intl.DateTimeFormat(state.language === "ja" ? "ja-JP" : "en-US", { weekday: "short" }).format(date);
}

function addFuelCellAutomationWindow(window = {}) {
  const root = $("#fuelCellAutomationWindows");
  if (!root) return;
  const row = document.createElement("div");
  row.className = "fixed-window-row";
  row.innerHTML = `
    <label><span>${t("label")}</span><input data-fuel-cell-window="label" value="${escapeHtml(window.label ?? "")}" /></label>
    <label><span>${t("start")}</span><input data-fuel-cell-window="start" type="time" value="${window.start ?? "08:00"}" /></label>
    <label><span>${t("end")}</span><input data-fuel-cell-window="end" type="time" value="${window.end ?? "18:00"}" /></label>
    <button type="button" class="delete" data-remove-fuel-cell-window>${t("remove")}</button>
    <div class="fixed-window-days">${Array.from({ length: 7 }, (_, day) => `<label><input data-fuel-cell-day="${day}" type="checkbox" ${(window.days ?? [0,1,2,3,4,5,6]).includes(day) ? "checked" : ""} />${fuelCellDayLabel(day)}</label>`).join("")}</div>`;
  root.append(row);
}

function renderFuelCellAutomationWindows(windows = []) {
  const root = $("#fuelCellAutomationWindows");
  if (!root) return;
  root.replaceChildren();
  for (const window of windows) addFuelCellAutomationWindow(window);
  if (!windows.length) addFuelCellAutomationWindow();
}

function collectFuelCellAutomationWindows() {
  return $$("#fuelCellAutomationWindows .fixed-window-row").map((row) => ({
    label: row.querySelector('[data-fuel-cell-window="label"]').value,
    start: row.querySelector('[data-fuel-cell-window="start"]').value,
    end: row.querySelector('[data-fuel-cell-window="end"]').value,
    days: Array.from(row.querySelectorAll("[data-fuel-cell-day]:checked")).map((input) => Number(input.dataset.fuelCellDay)),
  })).filter((window) => window.days.length && window.start && window.end && window.start !== window.end);
}

function updateFuelCellAutomationControls() {
  const enabled = $("#fuelCellAutomationEnabled")?.checked === true;
  for (const selector of [
    "#fuelCellSpoolUpMinutes",
    "#fuelCellHotWaterStartLimit",
    "#fuelCellStopDuringOffPeak",
    "#addFuelCellWindow",
  ]) {
    const control = $(selector);
    if (control) control.disabled = !enabled;
  }
  $$("#fuelCellAutomationWindows input, #fuelCellAutomationWindows button").forEach((control) => {
    control.disabled = !enabled;
  });
}

function renderFuelCellAutomationStatus(view = {}) {
  const result = view.lastResult ?? {};
  setText("#fuelCellAutomationStatus", result.reason ?? (view.enabled ? t("fuelCellAutomationWaiting") : t("fuelCellAutomationDisabled")));
  const root = $("#fuelCellAutomationLog");
  if (!root) return;
  root.replaceChildren();
  const entries = [...(view.log ?? [])].reverse();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("noFuelCellAutomationLog");
    root.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    const time = document.createElement("time");
    time.dateTime = entry.at ?? "";
    time.textContent = entry.at ? new Date(entry.at).toLocaleString() : "--";
    const message = document.createElement("span");
    message.textContent = entry.message;
    row.append(time, message);
    root.append(row);
  }
}

async function refreshFuelCellAutomation() {
  const view = await api("/api/fuel-cell-automation");
  renderFuelCellAutomationStatus(view);
  return view;
}

async function loadFuelCellTariffMonth() {
  const month = $("#fuelCellTariffMonth")?.value;
  if (!month) return;
  try {
    const result = await api(`/api/gas-tariffs?month=${encodeURIComponent(month)}`);
    const tariff = result.snapshots?.[0] ?? null;
    setText("#fuelCellTariffStatus", tariff
      ? `${month} · v${tariff.version} · ${t(tariff.season === "winter" ? "winter" : "otherSeason")}`
      : "");
  } catch (error) {
    setText("#fuelCellTariffStatus", error.message);
  }
}

function updateConfigControls(config) {
  state.config = config;
  setLanguage(config.language ?? "en");
  applyDashboardWidgetLayout(config);
  cacheDashboardLayout(config);
  renderDashboardWidgetControls(config);
  renderCircuitLabelControls(config, { preserveExisting: circuitLabelsAreBeingEdited() });
  applyFeatureVisibility(config);
  $("#circuitSortMode").value = circuitSortMode(config);
  $("#updateIntervalSeconds").value = config.updateIntervalSeconds ?? 15;
  $("#configBatteryHost").value = config.batteryHost ?? "";
  $("#configMeterHost").value = config.meterHost ?? "";
  $("#configSolarHost").value = config.solarHost ?? "";
  $("#configFuelCellPrimaryHost").value = config.fuelCellPrimaryHost ?? "";
  $("#configFuelCellProxyHosts").value = (config.fuelCellProxyHosts ?? []).join(",");
  $("#configDiscoverySubnets").value = (config.discoverySubnets ?? []).join(
    ",",
  );
  $("#configSolarEnabled").checked = config.solarEnabled !== false;
  $("#configSmartCosmoEnabled").checked = config.smartCosmoEnabled !== false;
  $("#configFuelCellEnabled").checked = config.fuelCellEnabled !== false;
  const fuelCell = config.fuelCell ?? {};
  const fuelCellAutomation = fuelCell.automation ?? {};
  $("#fuelCellAutomationEnabled").checked = fuelCellAutomation.enabled === true;
  $("#fuelCellSpoolUpMinutes").value = fuelCellAutomation.spoolUpMinutes ?? 40;
  $("#fuelCellHotWaterStartLimit").value = fuelCellAutomation.preventStartAtOrAboveHotWaterLevel ?? "";
  $("#fuelCellStopDuringOffPeak").checked = fuelCellAutomation.stopDuringDiscountedRates === true;
  $("#fuelCellIncludeInAdaptiveCharging").checked = fuelCellAutomation.includeInAdaptiveCharging === true;
  $("#fuelCellGasCo2").value = fuelCell.gasCo2KgPerM3 ?? 2.21;
  $("#fuelCellTariffProvider").value = fuelCell.tariff?.provider ?? "tokyo-gas";
  $("#fuelCellTariffRegion").value = fuelCell.tariff?.region ?? "tokyo";
  $("#fuelCellTariffPlan").value = fuelCell.tariff?.plan ?? "enefarm";
  const tariffSource = $("#fuelCellTariffSource");
  if (tariffSource) tariffSource.href = `https://reception.tokyo-gas.co.jp/ryokin/?tik=${fuelCell.tariff?.region === "gunma" ? 6 : 1}`;
  $("#fuelCellReadingDay").value = fuelCell.tariff?.meterReadingDay ?? 1;
  $("#fuelCellDiscount").value = fuelCell.tariff?.equipmentDiscount ?? "";
  $("#fuelCellMarginalRate").value = fuelCell.tariff?.marginalRateOverrideYenPerM3 ?? "";
  $("#fuelCellTariffAutomatic").checked = fuelCell.tariff?.automaticUpdates === true;
  renderFuelCellAutomationWindows(fuelCellAutomation.schedules ?? []);
  updateFuelCellAutomationControls();
  if (!$("#fuelCellTariffMonth").value) $("#fuelCellTariffMonth").value = new Date().toISOString().slice(0, 7);
  const rateMode = rateModeFromConfig(config);
  const modeInput = document.querySelector(
    `input[name="rateMode"][value="${rateMode}"]`,
  );
  if (modeInput) modeInput.checked = true;
  $("#simpleRate").value = config.standardRateYenPerKwh ?? "";
  $("#standardRate").value = config.standardRateYenPerKwh ?? "";
  $("#offPeakRate").value = config.offPeakRateYenPerKwh ?? "";
  $("#multiStandardRate").value = config.standardRateYenPerKwh ?? "";
  $("#co2TonnesPerKwh").value = config.co2TonnesPerKwh ?? "";
  const retention = config.retention ?? {};
  setRetentionControl("#rawTelemetryDays", null, retention.rawTelemetryDays, 1095);
  setRetentionControl("#intervalAggregatesDays", "#intervalAggregatesIndefinite", retention.intervalAggregatesDays, 1095);
  setRetentionControl("#dailyAggregatesDays", "#dailyAggregatesIndefinite", retention.dailyAggregatesDays, 3650);
  setRetentionControl("#adaptiveChargingHistoryDays", "#adaptiveChargingHistoryIndefinite", retention.adaptiveChargingHistoryDays, 3650);
  setRetentionControl("#automationEventDays", "#automationEventIndefinite", retention.automationEventDays, 3650);
  setRetentionControl("#notificationDeliveryDays", null, retention.notificationDeliveryDays, 365);
  $("#automaticRetention").checked = retention.automaticMaintenance !== false;
  $("#batteryUsableCapacity").value = config.batteryCapabilities?.usableCapacityKwh ?? "";
  $("#batteryMaximumChargeWatts").value = config.batteryCapabilities?.maximumChargeWatts
    ?? "";
  $("#adaptiveChargingEnabled").checked = config.adaptiveCharging?.enabled === true;
  $("#adaptiveChargingLatitude").value = config.adaptiveCharging?.latitude ?? "";
  $("#adaptiveChargingLongitude").value = config.adaptiveCharging?.longitude ?? "";
  $("#adaptiveChargingArrayPeak").value = config.adaptiveCharging?.arrayPeakKw ?? "";
  $("#adaptiveChargingTilt").value = config.adaptiveCharging?.panelTiltDegrees ?? 30;
  $("#adaptiveChargingAzimuth").value = config.adaptiveCharging?.panelAzimuthDegrees ?? 0;
  $("#adaptiveChargingLoss").value = config.adaptiveCharging?.systemLossPercent ?? 14;
  $("#adaptiveChargingTargetSoc").value = config.adaptiveCharging?.targetSocPercent ?? 100;
  $("#adaptiveChargingMargin").value = config.adaptiveCharging?.forecastMarginPercent ?? 10;
  renderRateBands(
    rateMode === "multi"
      ? (config.rateBands ?? [])
      : defaultMultiBands(config.offPeakRateYenPerKwh ?? 25),
  );
  updateRateModeVisibility(rateMode);
  updateAutomationControls();
  $("#configSolarHost").disabled = config.solarEnabled === false;
  $("#configMeterHost").disabled = config.smartCosmoEnabled === false;
  $("#configFuelCellPrimaryHost").disabled = config.fuelCellEnabled === false;
  $("#configFuelCellProxyHosts").disabled = config.fuelCellEnabled === false;
  updateAdaptiveChargingAvailability(config);
}

function featureEnabled(features = {}, feature) {
  if (feature === "smart-cosmo") return features.smartCosmoEnabled !== false;
  if (feature === "solar") return features.solarEnabled !== false;
  if (feature === "fuel-cell") return features.fuelCellEnabled !== false;
  if (feature === "energy-sources") {
    return featureEnabled(features, "smart-cosmo");
  }
  if (feature === "off-peak-savings") {
    const featureRateMode = features.rateMode ?? state.config?.rateMode;
    return featureRateMode !== "simple" && featureRateMode !== undefined
      ? true
      : features.offPeakSavingsEnabled === true ||
        state.config?.offPeakSavingsEnabled === true;
  }
  return true;
}

function applyFeatureVisibility(features = {}) {
  // Hide optional equipment/widgets for homes without the corresponding device
  // or calculation enabled.
  for (const feature of ["smart-cosmo", "solar", "fuel-cell", "off-peak-savings", "energy-sources"]) {
    const enabled = featureEnabled(features, feature);
    $$(`[data-feature="${feature}"]`).forEach((el) =>
      el.dataset.widgetId
        ? (el.dataset.featureHidden = enabled ? "false" : "true")
        : el.classList.toggle("hidden", !enabled),
    );
  }
  syncDashboardWidgetVisibility();
}

function strongestFuelCellWatts(fuelCells) {
  const values = fuelCells
    .map((cell) => Number(cell.instant_power?.value))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function renderFuelCellHotWater(fuelCells = []) {
  const primary = fuelCells.find((cell) => cell.source_role === "primary");
  const rawLevel = primary?.hot_water_level?.value;
  const numericLevel = rawLevel === null || rawLevel === undefined || rawLevel === ""
    ? Number.NaN
    : Number(rawLevel);
  const level = Number.isInteger(numericLevel) && numericLevel >= 0 && numericLevel <= 5
    ? numericLevel
    : null;
  const percent = level === null ? null : level * 20;
  const levelText = percent === null ? t("unavailable") : template("hotWaterPercent", { percent });
  setText("#fuelCellHotWaterLevel", levelText);
  const tank = $("#fuelCellHotWaterTank");
  if (!tank) return;
  tank.setAttribute("aria-label", t("hotWaterLevel"));
  tank.setAttribute("aria-valuenow", level === null ? "0" : String(level));
  tank.setAttribute("aria-valuetext", levelText);
  tank.style.setProperty("--tank-fill", `${percent ?? 0}%`);
  tank.classList.toggle("is-unavailable", percent === null);
  const startButton = $("#fuelCellManualStart");
  if (!startButton) return;
  const generationState = primary?.generation_status?.value ?? null;
  const canStart = generationState === "stopped" || generationState === "idling";
  startButton.disabled = !canStart;
  startButton.textContent = generationState === "starting"
    ? t("fuelCellStateStarting")
    : generationState === "generating"
      ? t("fuelCellStateGenerating")
      : generationState === "stopping"
        ? t("fuelCellStateStopping")
        : t("startManualFuelCellGeneration");
}

function renderCircuitWidgets(data) {
  const grid = $("#circuitWidgetGrid");
  const section = $("[data-circuit-section]");
  if (!grid || !section) return;
  const smartCosmoEnabled = data.features?.smartCosmoEnabled !== false && state.config?.smartCosmoEnabled !== false;
  if (!smartCosmoEnabled) {
    grid.innerHTML = "";
    delete grid.dataset.staticRenderKey;
    section.classList.add("hidden");
    updateCircuitGraphPicker([], { ordered: true });
    return;
  }
  const wattsByChannel = circuitWattsFromStatus(data);
  const summaries = circuitSummaryMap(data.savings ?? {});
  const ids = circuitOrderForData(data);
  const staticRenderKey = state.historyMode
    ? JSON.stringify({
        dataset: state.staticCircuitOrderKey,
        language: state.language,
        labels: ids.map((id) => [id, circuitLabel(id)]),
      })
    : null;

  if (staticRenderKey && grid.dataset.staticRenderKey === staticRenderKey) {
    updateCircuitGraphPicker(ids, { ordered: true });
    return;
  }

  if (staticRenderKey) grid.dataset.staticRenderKey = staticRenderKey;
  else delete grid.dataset.staticRenderKey;
  section.classList.toggle("hidden", ids.length === 0);
  grid.innerHTML = ids.length
    ? ""
    : `<p class="empty-state">${t("noCircuitData")}</p>`;

  for (const id of ids) {
    const graphName = circuitGraphName(id);
    ensureCircuitTrendConfig(id);
    const article = document.createElement("article");
    article.className = "widget circuit-widget";
    article.dataset.circuitChannel = id;
    const wattsValue = wattsByChannel[id];
    const summary = summaries[id];
    const headline = state.historyMode
      ? energyKwh(Number(summary?.totalKwh ?? 0))
      : Number.isFinite(wattsValue)
        ? `${wattsValue} W`
        : "-- W";
    const note = state.historyMode
      ? t("rangeTotal")
      : summary?.totalKwh
        ? `${energyKwh(Number(summary.totalKwh))}`
        : "";
    article.innerHTML = `
      <span></span>
      <strong>${headline}</strong>
      <small class="widget-note">${note}</small>
      <canvas class="trend" id="circuitTrend-${id}" width="260" height="78"></canvas>
    `;
    article.querySelector("span").textContent = circuitLabel(id);
    grid.append(article);
    const canvas = article.querySelector("canvas");
    canvas.addEventListener("pointermove", (event) => handleTrendPointer(graphName, event));
    canvas.addEventListener("pointerleave", () => clearTrendPointer(graphName));
  }
  updateCircuitGraphPicker(ids, { ordered: true });
  drawAllTrends();
}

function updateCircuitGraphPicker(ids = circuitIdsFromStatus(), options = {}) {
  const label = $("#graphCircuitPickerLabel");
  const picker = $("#graphCircuitPicker");
  if (!label || !picker) return;
  label.classList.toggle("hidden", !isCircuitGraph(state.activeGraph));
  const sortedIds = options.ordered
    ? [...ids]
    : circuitOrderForData(state.status, ids);
  if (!sortedIds.length) {
    picker.innerHTML = "";
    return;
  }
  const selected = circuitGraphChannel(state.activeGraph) || state.activeCircuit || sortedIds[0];
  picker.innerHTML = "";
  for (const id of sortedIds) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = circuitLabel(id);
    picker.append(option);
  }
  picker.value = sortedIds.includes(selected) ? selected : sortedIds[0];
}

function renderEnergySources(summary = {}, periodLabel = "--") {
  const sources = summary.energySources;
  const hasData = Number(summary.sampleCount) > 0 && sources;
  const segments = [
    ["Peak", "peakGridKwh", "peakGridPercent"],
    ["OffPeak", "offPeakGridKwh", "offPeakGridPercent"],
    ["Solar", "solarUsedKwh", "solarUsedPercent"],
    ["FuelCell", "fuelCellContributionKwh", "fuelCellContributionPercent"],
  ];
  for (const [suffix, valueKey, percentKey] of segments) {
    const value = Number(sources?.[valueKey]);
    const share = Math.max(0, Math.min(100, Number(sources?.[percentKey]) || 0));
    setText(`#energy${suffix}Value`, hasData && Number.isFinite(value) ? energyKwh(value) : "--");
    setText(`#energy${suffix}Share`, hasData ? `${Math.round(share)}%` : "--");
    const bar = $(`#energy${suffix}Bar`);
    if (bar) bar.style.width = `${hasData ? share : 0}%`;
  }
  setText("#energySourcesPeriod", periodLabel);
}

function renderDashboard(data, options = {}) {
  // The server returns raw and decoded data together. The dashboard uses decoded
  // values and appends live samples onto the preloaded trend buffers.
  const recordTrend = options.recordTrend ?? true;
  state.status = data;
  applyFeatureVisibility(data.features ?? state.config ?? {});
  const now = Date.now();
  if (recordTrend && !state.historyMode) {
    advanceLiveTrendWindow(now, { draw: false });
  }
  setText("#batteryPower", watts(data.energy?.battery?.instant_power?.value));
  setText(
    "#batterySoc",
    Number.isFinite(data.energy?.battery?.remaining_percent?.value)
      ? `${data.energy.battery.remaining_percent.value}%`
      : "--%",
  );
  setText(
    "#batteryWorking",
    displayValue(data.energy?.battery?.working_status?.human),
  );
  setText(
    "#operationMode",
    displayValue(data.energy?.battery?.operation_mode?.human),
  );
  const profile = data.settings?.mode?.decoded?.mode;
  setText(
    "#vendorProfile",
    profile
      ? displayValue(`profile${profile.replace(/^./, (c) => c.toUpperCase())}`)
      : "--",
  );
  const dischargeLimitData = data.settings?.discharge_limit?.decoded
    ? data.settings.discharge_limit
    : data.settings?.discharge_limit?.lastKnown;
  setText(
    "#dischargeLimitWidget",
    dischargeLimitData?.decoded?.human ??
      (data.settings?.discharge_limit?.available === false
        ? t("unavailable")
        : "--"),
  );
  const solarEnabled = data.features?.solarEnabled !== false;
  const fuelCellEnabled = data.features?.fuelCellEnabled !== false;
  setText(
    "#solarPower",
    solarEnabled ? metricValue(data.energy?.solar?.instant_power) : "-- W",
  );

  const batteryWatts = numericValue(data.energy?.battery?.instant_power);
  const soc = numericValue(data.energy?.battery?.remaining_percent);
  const dischargeLimit = Number(dischargeLimitData?.decoded?.percent ?? 0);
  const solarWatts = solarEnabled
    ? numericValue(data.energy?.solar?.instant_power)
    : Number.NaN;
  const houseDemandWatts = data.meter?.house_demand_power?.value;
  const gridImportWatts = data.meter?.grid_import_power?.value;
  const gridExportWatts = data.meter?.grid_export_power?.value;
  $("#batterySocGauge").style.setProperty(
    "--value",
    Math.max(0, Math.min(100, soc)),
  );
  setBar("#dischargeLimitBar", dischargeLimit);
  setText(
    "#houseDemandPower",
    Number.isFinite(houseDemandWatts)
      ? `${houseDemandWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );
  setText(
    "#gridImportPower",
    Number.isFinite(gridImportWatts)
      ? `${gridImportWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );
  setText(
    "#gridExportPower",
    Number.isFinite(gridExportWatts)
      ? `${gridExportWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );

  const fuelCells = fuelCellEnabled ? (data.energy?.fuel_cells ?? []) : [];
  const fuelCellWatts = fuelCellEnabled
    ? strongestFuelCellWatts(fuelCells)
    : Number.NaN;
  const fuelStatuses = [
    ...new Set(
      fuelCells.map((cell) => cell.generation_status?.human).filter(Boolean),
    ),
  ];
  setText(
    "#fuelCellPower",
    Number.isFinite(fuelCellWatts) ? `${fuelCellWatts} W` : "-- W",
  );
  setText("#fuelCellStatus", fuelStatuses.map(displayValue).join(", ") || "--");
  renderFuelCellHotWater(fuelCells);
  setText("#solarSavings", yen(Number(data.savings?.solarSavingYen)));
  setText("#co2Savings", co2Saved(Number(data.savings?.co2SavingKg)));
  setText("#offPeakSavings", yen(Number(data.savings?.offPeakSavingYen)));
  setText("#powerImported", energyKwh(Number(data.savings?.gridImportKwh)));
  setText("#powerExported", energyKwh(Number(data.savings?.gridExportKwh)));
  setText(
    "#guardTriggerCount",
    Number(data.savings?.guardTriggerCount ?? 0).toLocaleString(
      state.language === "ja" ? "ja-JP" : "en-US",
    ),
  );
  const summaryPeriod = state.historyMode
    ? rangeLabel(data.savings, "selectedRange")
    : t("today");
  setText(
    "#solarSavingsPeriod",
    summaryPeriod,
  );
  setText(
    "#co2SavingsPeriod",
    summaryPeriod,
  );
  setText(
    "#offPeakSavingsPeriod",
    summaryPeriod,
  );
  setText("#powerImportedPeriod", summaryPeriod);
  setText("#powerExportedPeriod", summaryPeriod);
  setText("#guardTriggerCountPeriod", summaryPeriod);
  renderEnergySources(data.savings, summaryPeriod);

  renderCircuitWidgets(data);
  if (state.currentPage === "settings" && !settingsInputIsActive()) {
    renderCircuitLabelControls(state.config ?? {}, { preserveExisting: circuitLabelsAreBeingEdited() });
  }
  applyTrendHeadlines(data);

  if (recordTrend) {
    pushTrend("batteryPower", batteryWatts, now);
    pushTrend("batterySoc", soc, now);
    pushTrend("solarPower", solarWatts, now);
    pushTrend("houseDemandPower", Number(houseDemandWatts), now);
    pushTrend("gridExportPower", Number(gridExportWatts), now);
    pushTrend("gridImportPower", Number(gridImportWatts), now);
    pushTrend("fuelCellPower", Number(fuelCellWatts), now);
    for (const [channel, wattsValue] of Object.entries(circuitWattsFromStatus(data))) {
      ensureCircuitTrendConfig(channel);
      pushTrend(circuitGraphName(channel), Number(wattsValue), now, { draw: false });
    }
    drawAllTrends();
  } else {
    drawAllTrends();
  }

}

function renderFuelCellSummary(summary) {
  state.fuelCellSummary = summary;
  if (!summary) return;
  setText("#fuelCellElectricityToday", energyKwh(optionalNumber(summary.generatedKwh)));
  setText("#fuelCellGasToday", gasM3(optionalNumber(summary.gasM3)));
  setText("#fuelCellOperatingToday", durationText(optionalNumber(summary.operatingSeconds)));
  setText("#fuelCellStartsToday", Number(summary.startCount ?? 0).toLocaleString());
  setText("#fuelCellTimeInState", durationText(summary.timeInStateSeconds == null ? Number.NaN : Number(summary.timeInStateSeconds)));
  setText("#fuelCellLastStop", summary.lastStopAt ? new Date(summary.lastStopAt).toLocaleString() : "--");
  if (summary.currentState) setText("#fuelCellStatus", displayValue(summary.currentState));
  renderFuelCellStateStrip("#fuelCellStatusStateStrip", summary.transitions, summary.start, summary.end, summary.stateIntervals);
  renderFuelCellStateAxis(summary.start, summary.end);
  renderFuelCellStateStrip("#fuelCellDashboardStateStrip", summary.transitions, summary.start, summary.end, summary.stateIntervals);
}

async function refreshFuelCellSummary({ start = null, end = null, graph = false } = {}) {
  if (state.config?.fuelCellEnabled === false) return null;
  const rangeEnd = end ?? new Date();
  const rangeStart = start ?? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  const summary = await api(`/api/ene-farm?${new URLSearchParams({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() })}`);
  if (!start) renderFuelCellSummary(summary);
  if (graph) {
    $("#graphFuelCellStateStrip")?.classList.toggle("hidden", state.activeGraph !== "fuelCellPower");
    if (state.activeGraph === "fuelCellPower") {
      renderFuelCellStateStrip("#graphFuelCellStateStrip", summary.transitions, summary.start, summary.end, summary.stateIntervals);
    }
  }
  return summary;
}

const TREND_HEADLINE_NOTE_IDS = [
  "#solarPowerNote",
  "#fuelCellPowerNote",
  "#houseDemandPowerNote",
  "#batteryPowerNote",
  "#batterySocNote",
  "#gridImportPowerNote",
  "#gridExportPowerNote",
];

function applyTrendHeadlines(data) {
  // In live mode the big trend numbers stay as instantaneous power/percentage and
  // carry no note. For a selected historical range an instantaneous value is
  // meaningless, so show the quantity that answers "how much over this window":
  // energy totals (kWh) for the power flows and an average for state of charge.
  if (!state.historyMode) {
    TREND_HEADLINE_NOTE_IDS.forEach((id) => setText(id, ""));
    return;
  }
  const summary = data.savings ?? {};
  const total = t("rangeTotal");
  const setFlow = (valueId, noteId, kwh) => {
    setText(valueId, energyKwh(Number(kwh)));
    setText(noteId, total);
  };
  setFlow("#solarPower", "#solarPowerNote", summary.solarGenerationKwh);
  setFlow("#fuelCellPower", "#fuelCellPowerNote", summary.fuelCellKwh);
  setFlow("#houseDemandPower", "#houseDemandPowerNote", summary.houseDemandKwh);
  setFlow("#gridImportPower", "#gridImportPowerNote", summary.gridImportKwh);
  setFlow("#gridExportPower", "#gridExportPowerNote", summary.gridExportKwh);

  setText("#batteryPower", energyKwh(Number(summary.batteryNetKwh)));
  setText(
    "#batteryPowerNote",
    `${t("batteryChargedLabel")} ${energyKwh(Number(summary.batteryChargedKwh))} · ${t("batteryDischargedLabel")} ${energyKwh(Number(summary.batteryDischargedKwh))}`,
  );

  setText(
    "#batterySoc",
    Number.isFinite(summary.averageStateOfChargePercent)
      ? `${Math.round(summary.averageStateOfChargePercent)}%`
      : "--%",
  );
  setText("#batterySocNote", t("rangeAverage"));
  if (Number.isFinite(summary.averageStateOfChargePercent)) {
    $("#batterySocGauge")?.style.setProperty(
      "--value",
      Math.max(0, Math.min(100, summary.averageStateOfChargePercent)),
    );
  }
}

function renderInitialStatus(data) {
  renderDashboard(data);
}

async function renderHistory(history, { start, end } = {}) {
  // Historical mode uses persisted samples instead of live polling. It pauses the
  // refresh timer until the user presses Live again.
  state.historyMode = true;
  setLiveModeButton();
  clearTimeout(state.refreshTimer);
  const samples = history.samples ?? [];
  await loadHistorySamplesAsync(history, {
    target: "dashboard",
    rangeStartMs: start?.getTime(),
    rangeEndMs: end?.getTime(),
  });
  const latest = samples[samples.length - 1] ?? {};
  const syntheticStatus = {
    ...(state.status ?? {}),
    features: state.config ?? state.status?.features ?? {},
    savings: history.summary,
    energy: {
      ...(state.status?.energy ?? {}),
      battery: {
        ...(state.status?.energy?.battery ?? {}),
        instant_power: { value: latest.batteryPowerW, unit: "W" },
        remaining_percent: { value: latest.stateOfChargePercent, unit: "%" },
      },
      solar: { instant_power: { value: latest.solarPowerW, unit: "W" } },
      fuel_cells: [
        {
          source_role: "primary",
          instant_power: { value: latest.fuelCellPowerW, unit: "W" },
          hot_water_level: { value: latest.fuelCellHotWaterLevel, unit: "level" },
        },
      ],
    },
    meter: {
      ...(state.status?.meter ?? {}),
      configured: true,
      house_demand_power: { value: latest.houseDemandW, unit: "W" },
      grid_import_power: { value: latest.gridImportW, unit: "W" },
      grid_export_power: { value: latest.gridExportW, unit: "W" },
      channel_power: {
        decoded: {
          channels: Object.entries(latest.circuitPowerW ?? {}).map(([channel, value]) => ({
            channel: Number(channel),
            value,
            unit: "W",
          })),
        },
      },
    },
  };
  renderDashboard(syntheticStatus, { recordTrend: false });
  setServiceState("historicalData");
}

async function loadGraphHistory() {
  const start = new Date($("#graphHistoryStart").value);
  const end = new Date($("#graphHistoryEnd").value);
  setLoadProgress("graph", 0, 0, true);
  const history = await api(`/api/history?${historyParams(start, end)}`);
  await loadHistorySamplesAsync(history, {
    target: "graph",
    graphName: state.activeGraph,
    rangeStartMs: start.getTime(),
    rangeEndMs: end.getTime(),
  });
  $("#graphFuelCellStateStrip")?.classList.toggle("hidden", state.activeGraph !== "fuelCellPower");
  if (state.activeGraph === "fuelCellPower") {
    await refreshFuelCellSummary({ start, end, graph: true }).catch(() => {});
  }
  setServiceState("historicalData");
}

async function openGraphPage(name) {
  let graphName = name;
  if (name === "circuits") {
    const ids = circuitIdsFromStatus();
    graphName = circuitGraphName(state.activeCircuit || ids[0] || "1");
    ensureCircuitTrendConfig(circuitGraphChannel(graphName));
  }
  if (!TREND_CONFIG[graphName]) return;
  state.activeGraph = graphName;
  if (isCircuitGraph(graphName)) state.activeCircuit = circuitGraphChannel(graphName);
  updateCircuitGraphPicker(circuitIdsFromStatus());
  setPage("graph");
  if (!$("#graphHistoryStart").value || !$("#graphHistoryEnd").value) {
    setGraphHistoryRange(24 * 60 * 60_000);
  }
  await loadGraphHistory().catch((err) => toast(err.message));
}

function reportBucket() {
  return document.querySelector('input[name="reportBucket"]:checked')?.value ?? "day";
}

function reportDomain() {
  return document.querySelector('input[name="reportDomain"]:checked')?.value ?? "energy";
}

function addReportRange(date, amount, unit) {
  const next = new Date(date);
  if (unit === "month") next.setMonth(next.getMonth() + amount);
  else if (unit === "week") next.setDate(next.getDate() + amount * 7);
  else next.setDate(next.getDate() + amount);
  return next;
}

function startOfLocalReportBucket(date, bucket) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (bucket === "month") return new Date(start.getFullYear(), start.getMonth(), 1);
  if (bucket === "week") {
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  }
  return start;
}

function setReportRange(amount, unit, end = new Date()) {
  // Reports compare complete calendar periods. Ending at the current bucket's
  // boundary avoids mixing a partial day, week, or month with full periods.
  const bucketEnd = startOfLocalReportBucket(end, unit);
  $("#reportEnd").value = localDateTimeValue(bucketEnd);
  $("#reportStart").value = localDateTimeValue(addReportRange(bucketEnd, -amount, unit));
}

function renderReportQuickRanges(bucket = reportBucket()) {
  const root = $("#reportQuickRanges");
  if (!root) return;
  root.innerHTML = "";
  for (const preset of REPORT_PRESETS[bucket] ?? REPORT_PRESETS.day) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.dataset.reportAmount = preset.amount;
    button.dataset.reportUnit = preset.unit;
    button.textContent = t(preset.key);
    root.append(button);
  }
}

function setDefaultReportRange(bucket = reportBucket()) {
  const defaults = {
    day: REPORT_PRESETS.day[0],
    week: REPORT_PRESETS.week[0],
    month: REPORT_PRESETS.month[0],
  };
  const preset = defaults[bucket] ?? REPORT_PRESETS.day[0];
  setReportRange(preset.amount, preset.unit);
}

function reportParams(start, end, bucket) {
  return new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
    bucket,
  });
}

function setReportFeatureVisibility(features = {}) {
  const enabled = {
    solar: features.solarEnabled !== false,
    "smart-cosmo": features.smartCosmoEnabled !== false,
    "fuel-cell": features.fuelCellEnabled !== false,
  };
  $$("[data-report-feature]").forEach((el) => {
    el.classList.toggle("hidden", enabled[el.dataset.reportFeature] === false);
  });
}

function formatReportDelta(bucket) {
  const delta = Number(bucket.houseDemandDeltaKwh);
  if (!Number.isFinite(delta)) return "--";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${energyKwh(delta)} (${percentage(Number(bucket.houseDemandDeltaPercent))})`;
}

function renderReportSummary(report) {
  const totals = report?.totals ?? {};
  setText("#reportUsageTotal", energyKwh(Number(totals.houseDemandKwh)));
  setText("#reportImportTotal", energyKwh(Number(totals.gridImportKwh)));
  setText("#reportSolarTotal", energyKwh(Number(totals.solarGenerationKwh)));
  setText("#reportExportTotal", energyKwh(Number(totals.gridExportKwh)));
  setText("#reportPeakDemand", watts(Number(totals.peakDemandW)));
  setText("#reportCo2Total", co2Saved(Number(totals.co2SavingKg)));
  const solarCardNote = $("#reportSolarTotal")?.closest(".report-card")?.querySelector(".widget-note");
  if (solarCardNote) solarCardNote.textContent = `${t("solarCoverage")}: ${percentage(Number(totals.solarCoveragePercent))}`;
}

function renderEneFarmReportSummary(report) {
  const totals = report?.totals ?? {};
  setText("#eneFarmReportGeneration", energyKwh(optionalNumber(totals.generatedKwh)));
  setText("#eneFarmReportGas", gasM3(optionalNumber(totals.gasM3)));
  setText("#eneFarmReportYield", Number.isFinite(optionalNumber(totals.electricalYieldKwhPerM3)) ? `${Number(totals.electricalYieldKwhPerM3).toFixed(2)} kWh/m³` : "--");
  setText("#eneFarmReportCoverage", percentage(optionalNumber(totals.generationCoveragePercent)));
  setText("#eneFarmReportOperating", durationText(optionalNumber(totals.operatingSeconds)));
  setText("#eneFarmReportStarts", `${t("starts")}: ${Number(totals.startCount ?? 0).toLocaleString()}`);
  setText("#eneFarmReportQuality", fuelCellQualityLabel(totals.dataQuality));
  setText("#eneFarmReportMarginalCost", yen(optionalNumber(totals.estimatedGasCost?.marginalCostYen)));
  const allocated = totals.estimatedGasCost?.standingChargeInclusive;
  setText("#eneFarmReportAllocatedCost", yenPerM3(optionalNumber(allocated?.allocatedYenPerM3)));
  setText("#eneFarmReportAllocatedCostNote", allocated?.available
    ? `${yen(optionalNumber(allocated.totalYen))} · ${t("standingChargeScenario")}`
    : allocated?.reason ?? t("standingChargeScenario"));
  const carbon = optionalNumber(totals.carbon?.electricityOnlyBalanceKg);
  setText("#eneFarmReportCarbon", Number.isFinite(carbon) ? `${carbon.toFixed(2)} kg-CO₂` : "--");
}

function renderEneFarmReportRows(report) {
  const root = $("#eneFarmReportRows");
  if (!root) return;
  root.replaceChildren();
  if (!(report?.buckets ?? []).length) {
    root.innerHTML = `<tr><td colspan="9">${t("noReportData")}</td></tr>`;
    return;
  }
  for (const bucket of report.buckets) {
    const row = document.createElement("tr");
    const carbon = optionalNumber(bucket.carbon?.electricityOnlyBalanceKg);
    row.innerHTML = `<td>${escapeHtml(bucket.label)}</td><td>${energyKwh(optionalNumber(bucket.generatedKwh))}</td><td>${gasM3(optionalNumber(bucket.gasM3))}</td><td>${Number.isFinite(optionalNumber(bucket.electricalYieldKwhPerM3)) ? `${Number(bucket.electricalYieldKwhPerM3).toFixed(2)} kWh/m³` : "--"}</td><td>${durationText(optionalNumber(bucket.operatingSeconds))}</td><td>${Number(bucket.startCount ?? 0).toLocaleString()}</td><td>${yen(optionalNumber(bucket.estimatedGasCost?.marginalCostYen))}</td><td>${yenPerM3(optionalNumber(bucket.estimatedGasCost?.standingChargeInclusive?.allocatedYenPerM3))}</td><td>${Number.isFinite(carbon) ? `${carbon.toFixed(2)} kg-CO₂` : "--"}</td>`;
    root.append(row);
  }
}

function renderReportRows(report) {
  const rows = $("#reportRows");
  if (!rows) return;
  const buckets = report?.buckets ?? [];
  rows.innerHTML = "";
  if (!buckets.length) {
    rows.innerHTML = `<tr><td colspan="8">${t("noReportData")}</td></tr>`;
    return;
  }
  for (const bucket of buckets) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(bucket.label)}</td>
      <td data-report-feature="smart-cosmo">${energyKwh(Number(bucket.houseDemandKwh))}</td>
      <td data-report-feature="smart-cosmo">${formatReportDelta(bucket)}</td>
      <td data-report-feature="solar">${energyKwh(Number(bucket.solarGenerationKwh))}</td>
      <td data-report-feature="smart-cosmo">${energyKwh(Number(bucket.gridImportKwh))}</td>
      <td data-report-feature="smart-cosmo">${energyKwh(Number(bucket.gridExportKwh))}</td>
      <td data-report-feature="fuel-cell">${energyKwh(Number(bucket.fuelCellKwh))}</td>
      <td data-report-feature="smart-cosmo">${watts(Number(bucket.peakDemandW))}</td>
    `;
    rows.append(tr);
  }
}

function reportChartSeries(features = {}) {
  if (state.reportDomain === "ene-farm") {
    return [
      { key: "generatedKwh", color: "#7c3aed", label: t("generatedElectricity"), style: "bar", enabled: true },
      { key: "onSiteKwh", color: "#16877f", label: t("onSiteGeneration"), style: "line", enabled: true },
    ];
  }
  return [
    {
      key: "houseDemandKwh",
      color: "#127c78",
      label: t("houseDemand"),
      style: "bar",
      enabled: features.smartCosmoEnabled !== false,
    },
    {
      key: "solarGenerationKwh",
      color: "#d8872c",
      label: t("solarGeneration"),
      style: "line",
      enabled: features.solarEnabled !== false,
    },
    {
      key: "gridImportKwh",
      color: "#dc2626",
      label: t("gridImport"),
      style: "line",
      enabled: features.smartCosmoEnabled !== false,
    },
    {
      key: "gridExportKwh",
      color: "#16a34a",
      label: t("gridExport"),
      style: "line",
      enabled: features.smartCosmoEnabled !== false,
    },
  ].filter((item) => item.enabled);
}

function renderReportChartLegend(features) {
  const legend = $("#reportChartLegend");
  if (!legend) return;
  legend.replaceChildren(
    ...reportChartSeries(features).map((item) => {
      const entry = document.createElement("span");
      entry.className = "report-chart-legend-item";
      const swatch = document.createElement("i");
      swatch.className = `report-chart-swatch is-${item.style}`;
      swatch.style.setProperty("--series-color", item.color);
      const label = document.createElement("span");
      label.textContent = item.label;
      entry.append(swatch, label);
      return entry;
    }),
  );
}

function drawReportChart(report = state.reportData) {
  const canvas = $("#reportTrendChart");
  if (!canvas) return;
  const buckets = report?.buckets ?? [];
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.width));
  const height = Math.max(1, Math.round(rect.height || canvas.height));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const pad = { top: 18, right: 18, bottom: 54, left: 58 };
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = Math.max(1, height - pad.top - pad.bottom);
  ctx.strokeStyle = "#dbe5ef";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad.top + (chartHeight * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }
  const features = report?.features ?? {};
  const series = reportChartSeries(features);
  const values = buckets.flatMap((bucket) =>
    series.map((item) => Number(bucket[item.key])).filter(Number.isFinite),
  );
  const max = Math.max(1, ...values);
  ctx.fillStyle = "#64748b";
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(max)} kWh`, pad.left - 6, pad.top);
  ctx.fillText("0 kWh", pad.left - 6, pad.top + chartHeight);
  if (!buckets.length || !series.length || !values.length) {
    ctx.textAlign = "center";
    ctx.fillText(t("noReportData"), width / 2, height / 2);
    return;
  }
  const step = chartWidth / buckets.length;
  const barWidth = Math.min(34, Math.max(8, step * 0.48));
  const xFor = (index) => pad.left + step * index + step / 2;
  const yFor = (value) => pad.top + chartHeight - (value / max) * chartHeight;

  ctx.fillStyle = "rgba(18, 124, 120, 0.72)";
  buckets.forEach((bucket, index) => {
    const value = Number(bucket.houseDemandKwh);
    if (!Number.isFinite(value)) return;
    const x = xFor(index) - barWidth / 2;
    const y = yFor(value);
    ctx.fillRect(x, y, barWidth, pad.top + chartHeight - y);
  });

  for (const item of series.filter((entry) => entry.key !== "houseDemandKwh")) {
    ctx.beginPath();
    let started = false;
    buckets.forEach((bucket, index) => {
      const value = Number(bucket[item.key]);
      if (!Number.isFinite(value)) {
        started = false;
        return;
      }
      const x = xFor(index);
      const y = yFor(value);
      if (!started) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      started = true;
    });
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.floor(chartWidth / 90)));
  buckets.forEach((bucket, index) => {
    if (index % labelEvery !== 0 && index !== buckets.length - 1) return;
    ctx.save();
    ctx.translate(xFor(index), height - 18);
    ctx.rotate(-Math.PI / 5);
    ctx.fillText(bucket.label, 0, 0);
    ctx.restore();
  });
}

function renderReport(report) {
  state.reportData = report;
  setText("#reportEyebrow", state.reportDomain === "ene-farm" ? t("fuelCell") : t("energyReports"));
  setText("#reportHeading", state.reportDomain === "ene-farm" ? t("eneFarmReports") : t("exactUsageReports"));
  setText("#reportHelp", state.reportDomain === "ene-farm" ? t("eneFarmReportsHelp") : t("reportsHelp"));
  $$('[data-report-domain]').forEach((element) => element.classList.toggle("hidden", element.dataset.reportDomain !== state.reportDomain));
  if (state.reportDomain === "ene-farm") {
    renderEneFarmReportSummary(report);
    renderEneFarmReportRows(report);
  } else {
    renderReportSummary(report);
    renderReportRows(report);
    setReportFeatureVisibility(report.features);
  }
  renderReportChartLegend(report.features);
  $("#reportMeta").textContent = template("reportBucketCount", {
    count: (report.buckets ?? []).length.toLocaleString(),
  });
  drawReportChart(report);
}

async function loadReport() {
  const start = new Date($("#reportStart").value);
  const end = new Date($("#reportEnd").value);
  const bucket = reportBucket();
  setLoadProgress("report", 0, 0, true);
  try {
    state.reportDomain = reportDomain();
    const endpoint = state.reportDomain === "ene-farm" ? "ene-farm" : "energy";
    const report = await api(`/api/reports/${endpoint}?${reportParams(start, end, bucket)}`);
    renderReport(report);
    const recordsRead = Number(report.meta?.recordsRead ?? 0);
    finishLoadProgress("report", recordsRead, recordsRead);
    setServiceState("historicalData");
  } catch (err) {
    setLoadProgress("report", 0, 0, false);
    throw err;
  }
}

function schedulePayloadFields(action) {
  // Schedule payloads mirror the same action names used by immediate buttons, so
  // the server can execute scheduled and manual actions through one code path.
  const el = $("#schedulePayload");
  const modeOptions = `
    <label>${t("chargingProfile")}
      <select data-payload="mode">
        <option value="osaifu">${t("profileOsaifu")}</option>
        <option value="eco">${t("profileEco")}</option>
        <option value="backup">${t("profileBackup")}</option>
      </select>
    </label>`;
  const operationOptions = `
    <label>${t("operationMode")}
      <select data-payload="mode">${operationModeOptions()}</select>
    </label>`;
  const windowFields = `
    <label>${t("startHour")}
      <select data-payload="startHour">${hourOptions()}</select>
    </label>
    <label>${t("endHour")}
      <select data-payload="endHour">${hourOptions()}</select>
    </label>`;
  const targetField = `
    <label>${t("targetWh")}
      <input data-payload="targetWh" type="number" min="0" placeholder="${t("optional")}" />
    </label>`;
  const limitField = `
    <label>${t("percent")}
      <select data-payload="percent">
        ${Array.from({ length: 11 }, (_, i) => `<option value="${i * 10}">${i * 10}%</option>`).join("")}
      </select>
    </label>`;

  if (action === "vendor-profile") el.innerHTML = modeOptions;
  else if (action === "set-mode") el.innerHTML = operationOptions;
  else if (action === "discharge-limit") el.innerHTML = limitField;
  else if (action.includes("window")) el.innerHTML = windowFields;
  else el.innerHTML = targetField;
}

function collectPayload() {
  const payload = {};
  document.querySelectorAll("[data-payload]").forEach((input) => {
    if (input.value !== "") payload[input.dataset.payload] = input.value;
  });
  return payload;
}

function scheduleWhen(schedule) {
  if (schedule.repeat === "daily") return `${t("daily")} ${schedule.time}`;
  return new Date(schedule.runAt).toLocaleString();
}

function scheduleWhenSortValue(schedule) {
  if (schedule.repeat === "daily" && /^\d{2}:\d{2}$/.test(schedule.time ?? "")) {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    return hours * 60 + minutes;
  }
  const timestamp = new Date(schedule.runAt ?? schedule.createdAt ?? 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function sortSchedulesByWhen(schedules = []) {
  return [...schedules].sort((a, b) => {
    const whenDiff = scheduleWhenSortValue(a) - scheduleWhenSortValue(b);
    if (whenDiff) return whenDiff;
    return String(a.createdAt ?? a.id ?? "").localeCompare(String(b.createdAt ?? b.id ?? ""));
  });
}

function scheduleDays(schedule) {
  const days =
    Array.isArray(schedule.days) && schedule.days.length
      ? schedule.days
      : [0, 1, 2, 3, 4, 5, 6];
  if (days.length === 7) return t("everyDay");
  return days
    .sort((a, b) => a - b)
    .map((day) => t(DAY_KEYS[day]))
    .join(", ");
}

function schedulePayloadDetails(schedule) {
  const payload = schedule.payload ?? {};
  const operationLabels = {
    auto: "operationAuto",
    standby: "operationStandby",
    rapid: "operationRapid",
    charge: "operationCharge",
    discharge: "operationDischarge",
  };
  const profileLabels = {
    osaifu: "profileOsaifu",
    eco: "profileEco",
    backup: "profileBackup",
  };

  switch (schedule.action) {
    case "vendor-profile":
      return `${t("profile")}: ${t(profileLabels[payload.mode] ?? payload.mode)}`;
    case "set-mode":
      return `${t("mode")}: ${t(operationLabels[payload.mode] ?? payload.mode)}`;
    case "discharge-limit":
      return `${t("percent")}: ${payload.percent}%`;
    case "osaifu-charge-window":
    case "osaifu-discharge-window":
      return `${t("startHour")}: ${payload.startHour}:00 / ${t("endHour")}: ${payload.endHour}:00`;
    case "charge":
    case "discharge":
      return `${t("targetWh")}: ${payload.targetWh || t("notSet")}`;
    default:
      return JSON.stringify(payload);
  }
}

function renderSchedules(schedules) {
  const sortedSchedules = sortSchedulesByWhen(schedules);
  state.schedules = sortedSchedules;
  const rows = $("#scheduleRows");
  rows.innerHTML = "";
  if (!sortedSchedules.length) {
    rows.innerHTML = `<tr><td colspan="5">${t("noSchedules")}</td></tr>`;
    updateScheduleAdaptiveChargingState();
    return;
  }
  for (const schedule of sortedSchedules) {
    const tr = document.createElement("tr");
    const status = schedule.running
      ? t("running")
      : schedule.completed && schedule.lastResult?.ok
      ? `${t("lastRan")} ${new Date(schedule.lastResult.at).toLocaleString()}`
      : schedule.enabled === false
        ? t("paused")
      : schedule.lastResult
      ? schedule.lastResult.ok
        ? `${t("lastRan")} ${new Date(schedule.lastResult.at).toLocaleString()}`
        : schedule.lastResult.error
      : t("waiting");
    const toggleLabel = schedule.enabled === false ? t("resume") : t("pause");
    const whenCell = document.createElement("td");
    whenCell.textContent = scheduleWhen(schedule);
    const actionCell = document.createElement("td");
    actionCell.textContent = actionLabel(schedule.action);
    const detailsCell = document.createElement("td");
    if (schedule.repeat === "daily") {
      detailsCell.append(document.createTextNode(scheduleDays(schedule)), document.createElement("br"));
    }
    detailsCell.append(document.createTextNode(schedulePayloadDetails(schedule)));
    const statusCell = document.createElement("td");
    statusCell.textContent = status;
    const actionsCell = document.createElement("td");
    actionsCell.className = "schedule-actions";
    if (!schedule.completed) {
      const toggleButton = document.createElement("button");
      toggleButton.className = "ghost";
      toggleButton.dataset.toggleEnabled = schedule.id;
      toggleButton.dataset.enabled = schedule.enabled === false ? "true" : "false";
      toggleButton.textContent = toggleLabel;
      actionsCell.append(toggleButton);
    }
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete";
    deleteButton.dataset.delete = schedule.id;
    deleteButton.textContent = t("delete");
    actionsCell.append(deleteButton);
    tr.append(whenCell, actionCell, detailsCell, statusCell, actionsCell);
    rows.append(tr);
  }
  updateScheduleAdaptiveChargingState();
}

function setPage(page) {
  state.currentPage = page;
  $$(".page").forEach((el) => el.classList.remove("active-page"));
  $(`#${page}Page`).classList.add("active-page");
  $$(".nav-button").forEach((button) =>
    button.classList.toggle("active", button.dataset.page === page),
  );
  $$(".nav-subbutton").forEach((button) =>
    button.classList.toggle(
      "active",
      page === "graph" &&
        (button.dataset.graphPage === state.activeGraph ||
          (button.dataset.graphPage === "circuits" && isCircuitGraph(state.activeGraph))),
    ),
  );
  $$("[data-dashboard-only]").forEach((el) =>
    el.classList.toggle("hidden", page !== "dashboard"),
  );
  if (page === "dashboard") {
    $("#pageEyebrow").textContent = t("liveDashboard");
    $("#pageTitle").textContent = t("homeEnergyFlow");
  } else if (page === "graph") {
    $("#pageEyebrow").textContent = t("graphAnalysis");
    $("#pageTitle").textContent = trendLabel(state.activeGraph);
    updateCircuitGraphPicker(circuitIdsFromStatus());
    drawGraphAnalysis();
  } else if (page === "reports") {
    $("#pageEyebrow").textContent = t("energyReports");
    $("#pageTitle").textContent = t("exactUsageReports");
    drawReportChart();
    if (!state.reportData) {
      loadReport().catch((err) => toast(err.message));
    }
  } else if (page === "adaptiveCharging") {
    $("#pageEyebrow").textContent = t("chargingAutomation");
    $("#pageTitle").textContent = t("adaptiveCharging");
    drawAdaptiveChargingTimeline();
  } else if (page === "settings") {
    $("#pageEyebrow").textContent = t("navSettings");
    $("#pageTitle").textContent = t("navSettings");
  }
  if (page === "settings") {
    hydrateSettingsView();
  }
}

function refreshInterval() {
  const configuredMs =
    Math.max(5, Number(state.config?.updateIntervalSeconds ?? ACTIVE_REFRESH_MS / 1000)) *
    1000;
  return document.visibilityState === "visible"
    ? configuredMs
    : Math.max(configuredMs, INACTIVE_REFRESH_MS);
}

function scheduleNextRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshAll, refreshInterval());
}

async function refreshStatus() {
  if (state.historyMode) return;
  advanceLiveTrendWindow(Date.now());
  if (state.discoveryInProgress) return;
  setServiceState("readingDevices");
  try {
    const [status, fuelCell] = await Promise.all([
      api("/api/status"),
      state.config?.fuelCellEnabled === false ? null : refreshFuelCellSummary().catch(() => null),
    ]);
    renderDashboard(status);
    if (fuelCell) renderFuelCellSummary(fuelCell);
    state.lastLivePollAt = Date.now();
    setServiceState(
      document.visibilityState === "visible"
        ? "serviceOnline"
        : "backgroundRefresh",
    );
  } catch (err) {
    setServiceState("readFailed");
    toast(err.message);
  }
}

async function refreshSchedules() {
  renderSchedules(await api("/api/schedules"));
}

async function refreshAll() {
  const tasks = [];
  if (!state.historyMode) tasks.push(refreshStatus());
  if (state.currentPage === "settings") {
    tasks.push(refreshAutomationLog());
    tasks.push(refreshNotifications());
    if (state.config?.fuelCellEnabled !== false) tasks.push(refreshFuelCellAutomation());
  }
  if (["dashboard", "adaptiveCharging", "settings"].includes(state.currentPage)) {
    tasks.push(refreshAdaptiveCharging());
  }
  if (state.currentPage === "graph" && state.activeGraph === "fuelCellPower") {
    const start = new Date($("#graphHistoryStart").value);
    const end = new Date($("#graphHistoryEnd").value);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) tasks.push(refreshFuelCellSummary({ start, end, graph: true }));
  }
  if (tasks.length) await Promise.allSettled(tasks);
  scheduleNextRefresh();
}

async function initialLoad() {
  applyCachedDashboardLayout();
  setServiceState("readingDevices");
  await loadLiveTrendHistory(PAGE_LOAD_TIME_MS).catch(() => {});
  const [statusResult, configResult] = await Promise.allSettled([
    api("/api/status"),
    api("/api/config"),
    refreshSchedules(),
    refreshAutomationRules(),
  ]);
  if (statusResult.status === "fulfilled") {
    state.historyMode = false;
    state.historyHorizonMs = null;
    setLiveModeButton();
    renderInitialStatus(statusResult.value);
    setServiceState("serviceOnline");
  } else {
    setServiceState("readFailed");
    toast(statusResult.reason.message);
  }
  if (configResult.status === "fulfilled") {
    updateConfigControls(configResult.value);
    if (state.status) renderCircuitWidgets(state.status);
    refreshAdaptiveCharging().catch(() => {});
    refreshFuelCellSummary().catch(() => {});
  }
  scheduleNextRefresh();
}

async function hydrateSettingsView() {
  if (state.settingsLoadedForView) return;
  state.settingsLoadedForView = true;
  try {
    updateConfigControls(await api("/api/config"));
  } catch (err) {
    toast(err.message);
  }
  const results = await Promise.allSettled([
    api("/api/status").then(updateControls),
    refreshAutomationRules(),
    refreshAdaptiveCharging(),
    refreshHistoryStats(),
    refreshNotifications(),
    refreshDatabaseBackups(),
    state.config?.fuelCellEnabled === false ? Promise.resolve() : refreshFuelCellAutomation(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") toast(result.reason.message);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: value >= 100 || exponent === 0 ? 0 : 1,
  }).format(value)} ${units[exponent]}`;
}

async function refreshHistoryStats() {
  try {
    const stats = await api("/api/history/stats");
    setText("#historyStatSize", formatBytes(Number(stats.sizeBytes)));
    setText(
      "#historyStatDays",
      new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
        maximumFractionDigits: 1,
      }).format(Math.max(0, Number(stats.daysRecorded) || 0)),
    );
    setText(
      "#historyStatSamples",
      Number(stats.sampleCount ?? 0).toLocaleString(),
    );
    setText("#historyStatIntervals", Number(stats.rollups?.interval ?? 0).toLocaleString());
    setText("#historyStatDaily", Number(stats.rollups?.daily ?? 0).toLocaleString());
    setText(
      "#historyStatEvents",
      Object.values(stats.events ?? {}).reduce((sum, value) => sum + Number(value || 0), 0).toLocaleString(),
    );
  } catch (err) {
    toast(err.message);
  }
}

function databaseBackupTypeLabel(kind) {
  return t({
    manual: "backupTypeManual",
    "pre-upgrade": "backupTypePreUpgrade",
    "pre-restore": "backupTypePreRestore",
  }[kind] ?? "backupTypeUnknown");
}

function databaseOperationLabel(phase = "idle") {
  if (String(phase).startsWith("safety-")) return t("databaseOperationSafetyBackup");
  return t({
    preparing: "databaseOperationPreparing",
    copying: "databaseOperationCopying",
    validating: "databaseOperationValidating",
    compressing: "databaseOperationCompressing",
    decompressing: "databaseOperationDecompressing",
    "safety-backup": "databaseOperationSafetyBackup",
    stopping: "databaseOperationStopping",
    restoring: "databaseOperationRestoring",
    restarting: "databaseOperationRestarting",
    deleting: "databaseOperationDeleting",
    complete: "databaseOperationComplete",
    failed: "databaseOperationFailed",
  }[phase] ?? "databaseOperationPreparing");
}

function renderDatabaseBackupProgress(operation = {}) {
  const root = $("#databaseBackupProgress");
  if (!root) return;
  const visible = operation.busy || ["complete", "failed"].includes(operation.phase);
  root.classList.toggle("hidden", !visible);
  if (!visible) return;
  const percent = Math.max(0, Math.min(100, Number(operation.percent) || 0));
  setText("#databaseBackupProgressLabel", operation.error || databaseOperationLabel(operation.phase));
  setText("#databaseBackupProgressPercent", `${Math.round(percent)}%`);
  $("#databaseBackupProgressBar").value = percent;
  const processed = Number(operation.processed);
  const total = Number(operation.total);
  const detail = Number.isFinite(processed) && Number.isFinite(total) && total > 0
    ? operation.unit === "bytes"
      ? `${formatBytes(processed)} / ${formatBytes(total)}`
      : `${processed.toLocaleString()} / ${total.toLocaleString()} ${operation.unit ?? ""}`.trim()
    : operation.filename ?? "";
  setText("#databaseBackupProgressDetail", detail);
}

function renderDatabaseBackups(view) {
  state.databaseBackups = view;
  const rows = $("#databaseBackupRows");
  if (!rows) return;
  const busy = view?.operation?.busy === true;
  const currentVersion = Number.isInteger(view?.schemaVersion) ? view.schemaVersion : null;
  setText("#currentDatabaseVersion", Number.isInteger(currentVersion) ? `v${currentVersion}` : "--");
  $("#createDatabaseBackupBtn").disabled = busy;
  renderDatabaseBackupProgress(view?.operation ?? {});
  rows.replaceChildren();
  const backups = view?.backups ?? [];
  if (!backups.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-state";
    cell.textContent = t("noDatabaseBackups");
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const backup of backups) {
    const row = document.createElement("tr");
    const created = document.createElement("td");
    const filename = document.createElement("strong");
    filename.textContent = backup.filename;
    const date = document.createElement("small");
    date.textContent = new Date(backup.createdAt ?? backup.modifiedAt).toLocaleString();
    created.append(filename, date);
    const kind = document.createElement("td");
    kind.textContent = databaseBackupTypeLabel(backup.kind);
    const version = document.createElement("td");
    version.textContent = Number.isInteger(backup.schemaVersion) ? `v${backup.schemaVersion}` : "--";
    const size = document.createElement("td");
    size.textContent = formatBytes(Number(backup.sizeBytes));
    const actions = document.createElement("td");
    actions.className = "database-backup-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "ghost";
    restore.dataset.databaseBackupAction = "restore";
    restore.dataset.databaseBackupFilename = backup.filename;
    restore.textContent = t("restoreBackup");
    const compatible = backup.compatible === true
      && Number.isInteger(backup.schemaVersion)
      && Number.isInteger(currentVersion)
      && backup.schemaVersion === currentVersion;
    restore.disabled = busy || !compatible;
    if (!compatible) {
      restore.title = Number.isInteger(backup.schemaVersion)
        ? template("incompatibleBackup", {
          version: backup.schemaVersion,
          currentVersion: Number.isInteger(currentVersion) ? currentVersion : "--",
        })
        : t("unknownBackupVersion");
      row.classList.add("database-backup-incompatible");
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.dataset.databaseBackupAction = "delete";
    remove.dataset.databaseBackupFilename = backup.filename;
    remove.textContent = t("deleteBackup");
    remove.disabled = busy;
    actions.append(restore, remove);
    row.append(created, kind, version, size, actions);
    rows.append(row);
  }
}

async function refreshDatabaseBackups() {
  const view = await api("/api/database-backups");
  renderDatabaseBackups(view);
  return view;
}

async function runDatabaseOperation(request, successKey, { reload = false } = {}) {
  let settled = false;
  let result;
  let failure;
  request.then((value) => {
    settled = true;
    result = value;
  }, (error) => {
    settled = true;
    failure = error;
  });
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await refreshDatabaseBackups().catch(() => {});
  }
  if (failure) throw failure;
  renderDatabaseBackups(result);
  toast(t(successKey));
  if (reload) window.location.reload();
  return result;
}

async function mutate(path, body, success) {
  try {
    await api(path, { method: "POST", body });
    toast(success);
    await refreshAll();
  } catch (err) {
    toast(err.message);
  }
}

function initForms() {
  for (const [checkbox, input] of [
    ["#intervalAggregatesIndefinite", "#intervalAggregatesDays"],
    ["#dailyAggregatesIndefinite", "#dailyAggregatesDays"],
    ["#adaptiveChargingHistoryIndefinite", "#adaptiveChargingHistoryDays"],
    ["#automationEventIndefinite", "#automationEventDays"],
  ]) {
    $(checkbox).addEventListener("change", () => {
      $(input).disabled = $(checkbox).checked;
    });
  }
  $("#settingsPage")?.addEventListener("compositionstart", () => {
    state.isComposing = true;
  });
  $("#settingsPage")?.addEventListener("compositionend", () => {
    state.isComposing = false;
  });
  $("#fuelCellManualStart")?.addEventListener("click", async (event) => {
    if (!window.confirm(t("confirmManualFuelCellGeneration"))) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/api/actions/fuel-cell-start", { method: "POST", body: {} });
      toast(t("manualFuelCellGenerationRequested"));
      await refreshAll();
    } catch (err) {
      toast(err.message);
      if (state.status) renderDashboard(state.status, { recordTrend: false });
    }
  });
  ["#chargeStart", "#chargeEnd", "#dischargeStart", "#dischargeEnd"].forEach(
    (selector) => selectHourOptions($(selector)),
  );
  populateActionOptions();
  $("#limitValue").addEventListener("input", () => {
    $("#limitOutput").textContent = `${$("#limitValue").value}%`;
  });
  setHistoryRange(30 * 60_000);
  setGraphHistoryRange(24 * 60 * 60_000);
  renderReportQuickRanges("day");
  setDefaultReportRange("day");
  setLiveModeButton();
  $$("[data-range-ms]").forEach((button) => {
    button.addEventListener("click", () => {
      setHistoryRange(Number(button.dataset.rangeMs));
      $("#historyForm").requestSubmit();
    });
  });
  $$("[data-graph-range-ms]").forEach((button) => {
    button.addEventListener("click", () => {
      setGraphHistoryRange(Number(button.dataset.graphRangeMs));
      $("#graphHistoryForm").requestSubmit();
    });
  });
  $("#historyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const start = new Date($("#historyStart").value);
    const end = new Date($("#historyEnd").value);
    try {
      setLoadProgress("history", 0, 0, true);
      await renderHistory(await api(`/api/history?${historyParams(start, end)}`), { start, end });
    } catch (err) {
      toast(err.message);
    }
  });
  $("#graphHistoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadGraphHistory();
    } catch (err) {
      toast(err.message);
    }
  });
  $$('input[name="reportDomain"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.reportDomain = input.value;
      state.reportData = null;
      $$('[data-report-domain]').forEach((element) => element.classList.toggle("hidden", element.dataset.reportDomain !== state.reportDomain));
      if (state.currentPage === "reports") loadReport().catch((err) => toast(err.message));
    });
  });
  $$('input[name="reportBucket"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.reportBucket = input.value;
      renderReportQuickRanges(input.value);
      setDefaultReportRange(input.value);
      if (state.currentPage === "reports") {
        loadReport().catch((err) => toast(err.message));
      }
    });
  });
  $("#reportQuickRanges")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-report-amount]");
    if (!button) return;
    setReportRange(Number(button.dataset.reportAmount), button.dataset.reportUnit);
    $("#reportsForm").requestSubmit();
  });
  $("#reportsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadReport();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#graphCircuitPicker")?.addEventListener("change", async (event) => {
    const channel = event.target.value;
    state.activeCircuit = channel;
    state.activeGraph = circuitGraphName(channel);
    ensureCircuitTrendConfig(channel);
    setPage("graph");
    await loadGraphHistory().catch((err) => toast(err.message));
  });
  $("#liveBtn").addEventListener("click", async () => {
    state.historyMode = false;
    state.historyHorizonMs = null;
    setLiveModeButton();
    await loadLiveTrendHistory().catch(() => {});
    await refreshStatus();
    scheduleNextRefresh();
  });
  for (const name of Object.keys(TREND_CONFIG)) {
    const canvas = $(TREND_CONFIG[name].canvas);
    canvas?.addEventListener("pointermove", (event) =>
      handleTrendPointer(name, event),
    );
    canvas?.addEventListener("pointerleave", () => clearTrendPointer(name));
  }
  $("#graphAnalysisTrend")?.addEventListener("pointermove", handleGraphPointer);
  $("#graphAnalysisTrend")?.addEventListener("pointerleave", clearGraphPointer);
  $("#adaptiveChargingTimeline")?.addEventListener("pointermove", handleAdaptiveChargingTimelinePointer);
  $("#adaptiveChargingTimeline")?.addEventListener("pointerleave", clearAdaptiveChargingTimelinePointer);
  const mobileNavigation = window.matchMedia("(max-width: 720px)");
  const closeMobileGraphMenu = () => {
    if (mobileNavigation.matches) $(".nav-section")?.removeAttribute("open");
  };
  $$(".nav-button").forEach((button) =>
    button.addEventListener("click", () => {
      closeMobileGraphMenu();
      setPage(button.dataset.page);
    }),
  );
  $$(".nav-subbutton").forEach((button) =>
    button.addEventListener("click", async () => {
      if (mobileNavigation.matches) button.closest(".nav-section")?.removeAttribute("open");
      await openGraphPage(button.dataset.graphPage);
    }),
  );
  mobileNavigation.addEventListener?.("change", closeMobileGraphMenu);
  closeMobileGraphMenu();
  const openAdaptiveCharging = () => {
    setPage("adaptiveCharging");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  };
  $("#adaptiveChargingWidgetState")?.closest("[data-widget-id='adaptiveCharging']")?.addEventListener("click", openAdaptiveCharging);
  $("#adaptiveChargingWidgetState")?.closest("[data-widget-id='adaptiveCharging']")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAdaptiveCharging();
    }
  });
  const openAwaySchedule = () => {
    setPage("adaptiveCharging");
    $(".away-periods-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("#awayStatusWidgetState")?.closest("[data-widget-id='awayStatus']")?.addEventListener("click", openAwaySchedule);
  $("#awayStatusWidgetState")?.closest("[data-widget-id='awayStatus']")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAwaySchedule();
    }
  });
  $("#adaptiveChargingOpen")?.addEventListener("click", openAdaptiveCharging);
  $("#adaptiveChargingConfigure")?.addEventListener("click", () => {
    setPage("settings");
    $(".adaptive-charging-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  ["#configSolarEnabled", "#configSmartCosmoEnabled", "#configFuelCellEnabled"].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      const features = {
        solarEnabled: $("#configSolarEnabled").checked,
        smartCosmoEnabled: $("#configSmartCosmoEnabled").checked,
        fuelCellEnabled: $("#configFuelCellEnabled").checked,
      };
      $("#configSolarHost").disabled = !features.solarEnabled;
      $("#configMeterHost").disabled = !features.smartCosmoEnabled;
      $("#configFuelCellPrimaryHost").disabled = !features.fuelCellEnabled;
      $("#configFuelCellProxyHosts").disabled = !features.fuelCellEnabled;
      applyFeatureVisibility(features);
      updateAdaptiveChargingAvailability({ ...(state.config ?? {}), ...features });
    });
  });

  $("#circuitLabelsForm")?.addEventListener("input", (event) => {
    if (event.target.matches("[data-circuit-label]")) {
      event.currentTarget.dataset.dirty = "true";
    }
  });
  $("#circuitSortMode")?.addEventListener("change", (event) => {
    if (state.config) state.config = { ...state.config, circuitSortMode: event.target.value };
    renderCircuitWidgets(state.status ?? {});
  });

  $("#deviceConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      batteryHost: $("#configBatteryHost").value,
      meterHost: $("#configMeterHost").value,
      smartCosmoEnabled: $("#configSmartCosmoEnabled").checked,
      solarHost: $("#configSolarHost").value,
      solarEnabled: $("#configSolarEnabled").checked,
      fuelCellPrimaryHost: $("#configFuelCellPrimaryHost").value,
      fuelCellProxyHosts: $("#configFuelCellProxyHosts").value,
      fuelCellEnabled: $("#configFuelCellEnabled").checked,
      discoverySubnets: $("#configDiscoverySubnets").value,
      meterEoj: state.config?.meterEoj,
      rateMode: state.config?.rateMode,
      standardRateYenPerKwh: state.config?.standardRateYenPerKwh,
      offPeakRateYenPerKwh: state.config?.offPeakRateYenPerKwh,
      offPeakSavingsEnabled: state.config?.offPeakSavingsEnabled,
      rateBands: state.config?.rateBands,
      retention: state.config?.retention,
      dashboardWidgets: state.config?.dashboardWidgets,
      circuitLabels: state.config?.circuitLabels,
      circuitSortMode: state.config?.circuitSortMode,
      language: state.language,
    };
    try {
      const config = await api("/api/config", { method: "PUT", body });
      updateConfigControls(config);
      toast(t("savedAddresses"));
      await refreshStatus();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#fuelCellAutomationEnabled")?.addEventListener("change", updateFuelCellAutomationControls);
  $("#addFuelCellWindow")?.addEventListener("click", () => addFuelCellAutomationWindow());
  $("#fuelCellAutomationWindows")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-fuel-cell-window]");
    if (!button) return;
    button.closest(".fixed-window-row")?.remove();
  });
  $("#fuelCellConfigForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const optional = (selector) => $(selector).value === "" ? null : $(selector).value;
    try {
      const config = await api("/api/config", { method: "PUT", body: {
        fuelCell: {
          automation: {
            enabled: $("#fuelCellAutomationEnabled").checked,
            spoolUpMinutes: $("#fuelCellSpoolUpMinutes").value,
            stopDuringDiscountedRates: $("#fuelCellStopDuringOffPeak").checked,
            preventStartAtOrAboveHotWaterLevel: optional("#fuelCellHotWaterStartLimit"),
            includeInAdaptiveCharging: $("#fuelCellIncludeInAdaptiveCharging").checked,
            schedules: collectFuelCellAutomationWindows(),
          },
          gasCo2KgPerM3: $("#fuelCellGasCo2").value,
          tariff: {
            provider: $("#fuelCellTariffProvider").value,
            region: $("#fuelCellTariffRegion").value,
            plan: $("#fuelCellTariffPlan").value,
            equipmentDiscount: $("#fuelCellDiscount").value,
            meterReadingDay: $("#fuelCellReadingDay").value,
            automaticUpdates: $("#fuelCellTariffAutomatic").checked,
            marginalRateOverrideYenPerM3: optional("#fuelCellMarginalRate"),
          },
        },
      }});
      updateConfigControls(config);
      toast(t("saved"));
      await refreshFuelCellAutomation();
    } catch (err) { toast(err.message); }
  });
  $("#fuelCellTariffImportForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setText("#fuelCellTariffStatus", t("loading"));
    try {
      const result = await api("/api/gas-tariffs/import", { method: "POST", body: {
        provider: $("#fuelCellTariffProvider").value,
        billingMonth: $("#fuelCellTariffMonth").value,
      }});
      setText("#fuelCellTariffStatus", `${result.billingMonth} · v${result.version}`);
      await loadFuelCellTariffMonth();
    } catch (err) { setText("#fuelCellTariffStatus", err.message); }
  });
  $("#fuelCellTariffMonth")?.addEventListener("change", () => void loadFuelCellTariffMonth());
  $("#circuitLabelsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          circuitLabels: collectCircuitLabels(),
          circuitSortMode: $("#circuitSortMode").value,
          dashboardWidgets: state.config?.dashboardWidgets,
        },
      });
      delete $("#circuitLabelsForm").dataset.dirty;
      updateConfigControls(config);
      renderCircuitWidgets(state.status ?? {});
      toast(t("circuitSettingsSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#rateConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          ...buildRateConfigBody(),
        },
      });
      updateConfigControls(config);
      toast(t("saveRates"));
      if (!state.historyMode) await refreshStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#co2ConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          co2TonnesPerKwh: $("#co2TonnesPerKwh").value,
        },
      });
      updateConfigControls(config);
      toast(t("co2ReleaseSaved"));
      if (!state.historyMode) await refreshStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#rateBands").addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-rate-band")) return;
    event.target.closest(".rate-band-row")?.remove();
  });

  $("#addRateBandBtn").addEventListener("click", () => {
    const bands = collectRateBands();
    bands.push({
      start: "23:00",
      end: "07:00",
      yenPerKwh: Number($("#multiStandardRate").value || 0),
      label: "Custom",
    });
    renderRateBands(bands);
  });

  $$('input[name="rateMode"]').forEach((input) => {
    input.addEventListener("change", () => {
      updateRateModeVisibility(input.value);
      updateAdaptiveChargingAvailability({ ...(state.config ?? {}), rateMode: input.value });
    });
  });

  $("#adaptiveChargingForm").addEventListener("input", () => {
    updateAdaptiveChargingAvailability(state.config ?? {});
  });

  $("#batteryCapabilitiesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          batteryCapabilities: {
            usableCapacityKwh: $("#batteryUsableCapacity").value,
            maximumChargeWatts: $("#batteryMaximumChargeWatts").value,
          },
        },
      });
      updateConfigControls(config);
      toast(t("batteryCapabilitiesSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#adaptiveChargingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          adaptiveCharging: {
            enabled: $("#adaptiveChargingEnabled").checked,
            latitude: $("#adaptiveChargingLatitude").value,
            longitude: $("#adaptiveChargingLongitude").value,
            arrayPeakKw: $("#adaptiveChargingArrayPeak").value,
            panelTiltDegrees: $("#adaptiveChargingTilt").value,
            panelAzimuthDegrees: $("#adaptiveChargingAzimuth").value,
            systemLossPercent: $("#adaptiveChargingLoss").value,
            targetSocPercent: $("#adaptiveChargingTargetSoc").value,
            forecastMarginPercent: $("#adaptiveChargingMargin").value,
          },
        },
      });
      updateConfigControls(config);
      await refreshAdaptiveCharging();
      toast(t("adaptiveChargingSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#adaptiveChargingRecalculate").addEventListener("click", async () => {
    if (state.adaptiveChargingRecalculating) return;
    state.adaptiveChargingRecalculating = true;
    updateAdaptiveChargingAvailability();
    try {
      renderAdaptiveChargingStatus(await api("/api/adaptive-charging/recalculate", { method: "POST", body: {} }));
    } catch (err) {
      toast(err.message);
    } finally {
      state.adaptiveChargingRecalculating = false;
      updateAdaptiveChargingAvailability();
    }
  });

  $("#adaptiveChargingResume").addEventListener("click", async () => {
    try {
      renderAdaptiveChargingStatus(await api("/api/adaptive-charging/resume", { method: "POST", body: {} }));
      updateAdaptiveChargingAvailability();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#awayNow")?.addEventListener("click", () => {
    const next = nextHalfHourBoundary(new Date());
    if (!next) return;
    $("#awayFrom").value = localDateTimeValue(next);
    state.awayFromSetByNow = true;
  });

  $("#awayFrom")?.addEventListener("input", () => {
    state.awayFromSetByNow = false;
  });

  $("#awayCancel")?.addEventListener("click", resetAwayPeriodForm);

  $("#awayPeriodForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = form.dataset.mode ?? "create";
    const id = $("#awayPeriodId").value;
    const from = new Date($("#awayFrom").value);
    const until = new Date($("#awayUntil").value);
    try {
      let view;
      let message;
      if (mode === "extend") {
        view = await api(`/api/away-periods/${encodeURIComponent(id)}/extend`, {
          method: "POST",
          body: { until: until.toISOString() },
        });
        message = t("awayPeriodExtended");
      } else if (mode === "edit") {
        view = await api(`/api/away-periods/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { from: from.toISOString(), until: until.toISOString() },
        });
        message = t("awayPeriodUpdated");
      } else {
        view = await api("/api/away-periods", {
          method: "POST",
          body: {
            from: from.toISOString(),
            until: until.toISOString(),
            source: state.awayFromSetByNow ? "manual" : "scheduled",
          },
        });
        message = t("awayPeriodSaved");
      }
      resetAwayPeriodForm();
      renderAwayPeriods(view);
      toast(message);
      await refreshAdaptiveCharging();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#awayPeriodRows")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-away-action]");
    if (!button) return;
    const period = state.awayPeriodsView?.periods?.find((value) => value.id === button.dataset.awayId);
    if (!period) return;
    const action = button.dataset.awayAction;
    if (action === "edit" || action === "extend") {
      editAwayPeriod(period, action);
      return;
    }
    if (action === "delete" && !window.confirm(t("confirmDeleteAway"))) return;
    button.disabled = true;
    try {
      const view = action === "back-home"
        ? await api(`/api/away-periods/${encodeURIComponent(period.id)}/back-home`, { method: "POST", body: {} })
        : await api(`/api/away-periods/${encodeURIComponent(period.id)}`, { method: "DELETE" });
      resetAwayPeriodForm();
      renderAwayPeriods(view);
      toast(t(action === "back-home" ? "awayPeriodEnded" : "awayPeriodDeleted"));
      await refreshAdaptiveCharging();
    } catch (err) {
      button.disabled = false;
      toast(err.message);
    }
  });

  $("#historyConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          retention: collectRetentionConfig(),
        },
      });
      updateConfigControls(config);
      toast(t("saveRetention"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#trimHistoryBtn").addEventListener("click", async () => {
    try {
      const result = await api("/api/history/trim", {
        method: "POST",
        body: { retention: collectRetentionConfig() },
      });
      const deleted = Object.values(result.deleted ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
      toast(`${t("historyTrimmed")}: ${deleted}`);
      await refreshHistoryStats();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#createDatabaseBackupBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await runDatabaseOperation(
        api("/api/database-backups", { method: "POST", body: {} }),
        "databaseBackupCreated",
      );
    } catch (err) {
      toast(err.message);
      await refreshDatabaseBackups().catch(() => {});
    } finally {
      button.disabled = state.databaseBackups?.operation?.busy === true;
    }
  });

  $("#databaseBackupRows")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-database-backup-action]");
    if (!button || button.disabled) return;
    const filename = button.dataset.databaseBackupFilename;
    const action = button.dataset.databaseBackupAction;
    if (action === "restore"
      && !window.confirm(template("confirmRestoreDatabase", { filename }))) return;
    if (action === "delete"
      && !window.confirm(template("confirmDeleteDatabaseBackup", { filename }))) return;
    button.disabled = true;
    try {
      if (action === "restore") {
        await runDatabaseOperation(
          api(`/api/database-backups/${encodeURIComponent(filename)}/restore`, { method: "POST", body: {} }),
          "databaseBackupRestored",
          { reload: true },
        );
      } else {
        await runDatabaseOperation(
          api(`/api/database-backups/${encodeURIComponent(filename)}`, { method: "DELETE" }),
          "databaseBackupDeleted",
        );
      }
    } catch (err) {
      toast(err.message);
      await refreshDatabaseBackups().catch(() => {});
    }
  });

  async function saveNotificationSettings(showToast = true) {
    const config = collectNotificationConfig();
    const view = await api("/api/notifications", {
      method: "PUT",
      body: {
        config,
        password: $("#smtpPassword").value,
        clearPassword: $("#smtpClearPassword").checked,
      },
    });
    state.config = { ...(state.config ?? {}), notifications: view.config };
    renderNotificationView(view);
    if (showToast) toast(t("notificationsSaved"));
    return view;
  }

  $("#notificationsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveNotificationSettings();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#sendTestNotification").addEventListener("click", async () => {
    try {
      await saveNotificationSettings(false);
      await api("/api/notifications/test", { method: "POST", body: {} });
      await refreshNotifications();
      toast(t("testNotificationSent"));
    } catch (err) {
      await refreshNotifications().catch(() => {});
      toast(err.message);
    }
  });

  $("#preferencesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextLanguage = $("#languageSelect").value;
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          language: nextLanguage,
          updateIntervalSeconds: $("#updateIntervalSeconds").value,
        },
      });
      updateConfigControls(config);
      if (!state.historyMode) scheduleNextRefresh();
      toast(t("preferencesSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#dashboardLayoutForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          dashboardWidgets: collectDashboardWidgetControls(),
        },
      });
      updateConfigControls(config);
      toast(t("dashboardLayoutSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#resetDashboardLayoutBtn").addEventListener("click", async () => {
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          dashboardWidgets: DASHBOARD_WIDGET_DEFAULTS.map((widget) => ({
            id: widget.id,
            visible: widget.visible,
            priority: widget.priority,
          })),
        },
      });
      updateConfigControls(config);
      toast(t("dashboardLayoutReset"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#languageSelect").addEventListener("change", async () => {
    const nextLanguage = $("#languageSelect").value;
    setLanguage(nextLanguage);
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: { ...(state.config ?? {}), language: nextLanguage },
      });
      updateConfigControls(config);
    } catch (err) {
      toast(err.message);
    }
  });

  async function startDiscovery(mode, button) {
    const buttons = [$("#broadcastDiscoverBtn"), $("#activeScanBtn")];
    state.discoveryInProgress = true;
    clearTimeout(state.refreshTimer);
    buttons.forEach((item) => {
      item.disabled = true;
    });
    button.textContent = t("scanning");
    $("#discoveryResults").innerHTML = "";
    renderDiscoveryProgress({
      status: "running",
      phase: "starting",
      total: 0,
      scanned: 0,
      found: 0,
      createdAt: new Date().toISOString(),
    });
    try {
      const job = await api("/api/discovery/jobs", {
        method: "POST",
        body: { timeout: 6, mode, subnets: $("#configDiscoverySubnets").value },
      });
      await pollDiscoveryJob(job.id);
    } catch (err) {
      renderDiscoveryProgress({
        status: "failed",
        phase: "failed",
        error: err.message,
      });
      $("#discoveryResults").innerHTML = "";
      toast(err.message);
    } finally {
      state.discoveryInProgress = false;
      buttons.forEach((item) => {
        item.disabled = false;
      });
      $("#broadcastDiscoverBtn").textContent = t("broadcastDiscovery");
      $("#activeScanBtn").textContent = t("activeSubnetScan");
      scheduleNextRefresh();
    }
  }

  $("#broadcastDiscoverBtn").addEventListener("click", () =>
    startDiscovery("broadcast", $("#broadcastDiscoverBtn")),
  );
  $("#activeScanBtn").addEventListener("click", () =>
    startDiscovery("active", $("#activeScanBtn")),
  );

  $("#automationRuleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const existing = state.automationRules.find(
      (rule) => rule.type === "backup-demand-guard",
    );
    const body = {
      ...(existing ?? defaultAutomationRule()),
      enabled: $("#automationEnabled").checked,
      conditions: {
        source: "gridImportW",
        breakerAmps: $("#automationBreakerAmps").value,
        breakerVoltage: existing?.conditions?.breakerVoltage ?? 100,
        reserveAmps: $("#automationReserveAmps").value,
        restoreBelowAmps: $("#automationRestoreBelow").value,
        restoreDelaySeconds: $("#automationRestoreDelay").value,
      },
      action: "set-mode",
      payload: { mode: "standby" },
      restoreAction: "set-mode",
      restorePayload: { mode: "auto" },
    };
    try {
      if (existing)
        await api(`/api/automation-rules/${existing.id}`, {
          method: "PATCH",
          body,
        });
      else await api("/api/automation-rules", { method: "POST", body });
      await refreshAutomationRules();
      toast(t("automationSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#modeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = new FormData(event.currentTarget).get("mode");
    if (!mode) return toast(t("chooseProfile"));
    mutate(
      "/api/settings/vendor-profile",
      { mode },
      `${t("setProfileAction")}: ${displayValue(`profile${mode.replace(/^./, (c) => c.toUpperCase())}`)}`,
    );
  });

  $("#limitForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/discharge-limit",
      { percent: $("#limitValue").value },
      t("setLimitAction"),
    );
  });

  $("#chargeWindowForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/osaifu-charge-window",
      {
        startHour: $("#chargeStart").value,
        endHour: $("#chargeEnd").value,
      },
      t("setChargeWindowAction"),
    );
  });

  $("#dischargeWindowForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/osaifu-discharge-window",
      {
        startHour: $("#dischargeStart").value,
        endHour: $("#dischargeEnd").value,
      },
      t("setDischargeWindowAction"),
    );
  });

  $("#directActionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("#directAction").value;
    if (value.startsWith("set-mode:")) {
      const mode = value.split(":")[1];
      mutate(
        "/api/actions/set-mode",
        { mode },
        `${t("setOperationModeAction")}: ${displayValue(mode)}`,
      );
      return;
    }
    mutate(
      `/api/actions/${value}`,
      { targetWh: $("#targetWh").value },
      actionLabel(value),
    );
  });

  $("#scheduleAction").addEventListener("change", () =>
    schedulePayloadFields($("#scheduleAction").value),
  );
  $("#scheduleRepeat").addEventListener("change", () => {
    $("#scheduleTime").type =
      $("#scheduleRepeat").value === "daily" ? "time" : "datetime-local";
    $("#scheduleDays").classList.toggle(
      "disabled",
      $("#scheduleRepeat").value !== "daily",
    );
  });
  $("#scheduleDays").classList.add("disabled");
  schedulePayloadFields($("#scheduleAction").value);

  $("#scheduleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = $("#scheduleAction").value;
    const repeat = $("#scheduleRepeat").value;
    const timeValue = $("#scheduleTime").value;
    if (!timeValue) return toast(t("chooseScheduleTime"));
    const body = {
      name: action,
      action,
      repeat,
      payload: collectPayload(),
      days: collectScheduleDays(),
    };
    if (repeat === "daily") body.time = timeValue;
    else body.runAt = new Date(timeValue).toISOString();
    try {
      await api("/api/schedules", { method: "POST", body });
      toast(t("scheduleCreated"));
      await refreshSchedules();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#scheduleRows").addEventListener("click", async (event) => {
    const toggleId = event.target.dataset.toggleEnabled;
    if (toggleId) {
      await api(`/api/schedules/${toggleId}`, {
        method: "PATCH",
        body: { enabled: event.target.dataset.enabled === "true" },
      });
      await refreshSchedules();
      return;
    }
    const id = event.target.dataset.delete;
    if (!id) return;
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    await refreshSchedules();
  });

  document.addEventListener("visibilitychange", () => {
    scheduleNextRefresh();
    if (document.visibilityState === "visible") {
      if (!state.historyMode) {
        // If polling stalled while the tab was backgrounded (throttled timers,
        // suspended tab), the in-memory trend window has a gap that live polling
        // won't repair. Re-backfill from persisted history in that case;
        // otherwise a single fresh poll is enough.
        const gap = Date.now() - state.lastLivePollAt;
        if (gap > 2 * refreshInterval()) {
          loadLiveTrendHistory()
            .then(() => refreshStatus())
            .catch(() => refreshStatus());
        } else {
          refreshStatus();
        }
      }
      if (state.currentPage === "settings") refreshAutomationLog();
    }
  });
  window.addEventListener("resize", () => {
    drawAllTrends();
    drawReportChart();
  });
}

function collectScheduleDays() {
  return Array.from(
    document.querySelectorAll("#scheduleDays input:checked"),
  ).map((input) => Number(input.value));
}

function discoveryPhaseKey(phase) {
  return (
    {
      starting: "discoveryStarting",
      broadcast: "discoveryBroadcast",
      "active-scan": "discoveryActiveScan",
      waiting: "discoveryWaiting",
      identifying: "discoveryIdentifying",
      complete: "discoveryComplete",
      failed: "discoveryFailed",
    }[phase] ?? "discoveryStarting"
  );
}

function renderDiscoveryProgress(job) {
  // Discovery can be slow on quiet networks, so progress is shown even when only
  // the current phase is known and the scan is effectively indeterminate.
  const progress = $("#discoveryProgress");
  const bar = progress.querySelector(".progress-bar");
  const fill = $("#discoveryProgressFill");
  const total = Number(job.total ?? 0);
  const scanned = Number(job.scanned ?? 0);
  const found = Number(job.found ?? job.result?.discovered?.length ?? 0);
  const percent =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((scanned / total) * 100)))
      : 0;
  const elapsed = job.createdAt
    ? Math.max(
        0,
        Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000),
      )
    : 0;
  const details = [
    total > 0
      ? template("discoveryProgressCount", { scanned, total })
      : t("scanningNearby"),
    template("discoveryFoundCount", { count: found }),
    template("discoveryElapsed", { seconds: elapsed }),
  ];

  progress.classList.remove("hidden");
  $("#discoveryProgressTitle").textContent = t(discoveryPhaseKey(job.phase));
  $("#discoveryProgressDetail").textContent = details.join(" · ");
  bar.classList.toggle(
    "indeterminate",
    total === 0 && job.status === "running",
  );
  bar.setAttribute("aria-valuenow", String(percent));
  fill.style.width = total > 0 ? `${percent}%` : "";
}

async function pollDiscoveryJob(id) {
  clearTimeout(state.discoveryPollTimer);
  const job = await api(`/api/discovery/jobs/${id}`);
  renderDiscoveryProgress(job);
  if (job.status === "running") {
    await new Promise((resolve) => {
      state.discoveryPollTimer = setTimeout(resolve, 350);
    });
    return pollDiscoveryJob(id);
  }
  if (job.status === "failed")
    throw new Error(job.error || t("discoveryFailed"));
  renderDiscovery(job.result);
  return job.result;
}

function renderDiscovery(result) {
  state.lastDiscovery = result;
  const el = $("#discoveryResults");
  if (!result.discovered.length) {
    el.innerHTML = `<p>${t("noDevicesFound")}</p>`;
    return;
  }
  el.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "table-wrap discovery-table";
  const table = document.createElement("table");
  const header = document.createElement("tr");
  for (const label of [t("address"), t("likelyRole"), t("services")]) {
    const th = document.createElement("th");
    th.textContent = label;
    header.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const device of result.discovered) {
    const row = document.createElement("tr");
    for (const value of [
      device.host,
      device.roles.map(localizeRole).join(", "),
      String(device.instances.length),
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  const applyButton = document.createElement("button");
  applyButton.id = "applyDiscoveryBtn";
  applyButton.className = "ghost";
  applyButton.type = "button";
  applyButton.textContent = t("useSuggestedAddresses");
  el.append(wrap, applyButton);
  applyButton.addEventListener("click", () => {
    updateConfigControls(result.suggestedConfig);
    toast(t("suggestedLoaded"));
  });
}

function localizeRole(role) {
  return (
    {
      Battery: t("battery"),
      "Solar generation": t("solarGeneration"),
      "Home power meter": t("smartCosmoMeter"),
      "Smart Cosmo / home power meter": t("smartCosmoMeter"),
      "Ene-Farm": t("fuelCell"),
      "Water heater": state.language === "ja" ? "給湯器" : "Water heater",
      Controller: state.language === "ja" ? "コントローラー" : "Controller",
      "Unknown energy device":
        state.language === "ja"
          ? "不明なエネルギー機器"
          : "Unknown energy device",
    }[role] ?? role
  );
}

initForms();
initialLoad();
