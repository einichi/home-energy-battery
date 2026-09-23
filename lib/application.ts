#!/usr/bin/env node
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  createNotificationService,
  normalizeNotificationConfig,
} from "./notifications.js";
import {
  SCHEMA_VERSION,
  createHistoryStore,
  inspectHistoryDatabase,
  normalizeRetentionPolicy,
} from "./history-store.js";
import {
  backupDatabaseManually,
  cleanupExtractedDatabaseBackup,
  deleteDatabaseBackup,
  extractAndValidateDatabaseBackup,
  listDatabaseBackups,
} from "./database-backup.js";
import {
  applicableGasDiscount,
  applicableGasTariffBand,
  gasTariffHash,
  importGasTariff,
  normalizeGasTariffPayload,
  validBillingMonth,
} from "./gas-tariffs.js";
import {
  COUNTER_POLICIES,
  cumulativeCounterDeltaResult,
} from "./counter-utils.js";
import { timestampConsole } from "./console-timestamps.js";
import {
  assertSafeUiDevelopmentEnvironment,
  externalIoDisabled,
  uiDevelopmentMode,
} from "./development-safety.js";
import { createEchonetCommandAdapter } from "./echonet-service.js";
import {
  ARCHITECTURE_VERSION,
  architectureVersionForDatabase,
  createApplicationStore,
} from "./application-store.js";
import {
  createStaticHandler,
  json,
  readBody as readJsonBody,
  requestError,
  requestHasValidOrigin,
  text,
} from "./http/server.js";
import { NativeRouter } from "./http/router.js";
import { startRuntime, stopRuntime } from "./runtime.js";
import { jsonSnippet, parseJsonWithContext } from "./domain/json.js";
import type { BatteryAction } from "../shared/api-contracts.js";
import { normalizeServerEnvironment } from "./config/environment.js";
import {
  circuitChannelMap,
  circuitCumulativeMap,
  intervalOverlapFraction,
  normalizeCircuitLabels,
  summarizeCircuits,
} from "./domain/circuits.js";
import {
  DeviceCommandQueue,
  type DeviceCommandArguments,
  type DeviceCommandExecutor,
} from "./services/device-command-queue.js";

timestampConsole();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED_ROOT = path.resolve(__dirname, "..");
const APP_ROOT = path.resolve(COMPILED_ROOT, "..");
const SERVER_ENVIRONMENT = normalizeServerEnvironment(process.env, path.join(APP_ROOT, "data"));
const PORT = SERVER_ENVIRONMENT.port;
const DATA_DIR = SERVER_ENVIRONMENT.dataDir;
const UI_DEVELOPMENT_MODE = uiDevelopmentMode(process.env);
const EXTERNAL_IO_DISABLED = externalIoDisabled(process.env);
const DATABASE_BACKUP_DIR = path.join(DATA_DIR, "backups");
const ECHONET_TIMEOUT_MS = SERVER_ENVIRONMENT.echonetTimeoutMs;
const DEVICE_QUEUE_TIMEOUT_MS = Math.max(30_000, ECHONET_TIMEOUT_MS * 4);
const DEVICE_QUEUE_STARVATION_MS = Math.max(15_000, ECHONET_TIMEOUT_MS * 2);
const SCHEDULE_CHECK_INTERVAL_MS = SERVER_ENVIRONMENT.scheduleCheckIntervalMs;
const AUTOMATION_CHECK_INTERVAL_MS = SERVER_ENVIRONMENT.automationCheckIntervalMs;
const SOLAR_FORECAST_REFRESH_MS = 3 * 60 * 60_000;
const SOLAR_FORECAST_MAX_AGE_MS = 6 * 60 * 60_000;
const ADAPTIVE_CHARGING_PREWINDOW_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_HISTORY_CACHE_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_END_RETRY_MS = 5_000;
const ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS = 3 * 60_000;
const ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS = 3;
const ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS = 2;
const ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS = 2;
const ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS = 3;
const ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W = 50;
const ADAPTIVE_CHARGING_TIMING_RESERVE_MIN_MS = 5 * 60_000;
const ADAPTIVE_CHARGING_TIMING_RESERVE_MAX_MS = 15 * 60_000;
const ADAPTIVE_CHARGING_TIMING_RESERVE_FRACTION = 0.1;
const ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W = 200;
const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = 5 * 60_000;
const ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH = 50;
const OPERATION_MODE_VERIFY_ATTEMPTS = 4;
const OPERATION_MODE_VERIFY_DELAY_MS = 750;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const ADAPTIVE_CHARGE_SESSION_LIMIT = 30;
const ADAPTIVE_CHARGE_SAMPLE_LIMIT = 500;
const BATTERY_LEARNING_MODEL_VERSION = 3;
const BATTERY_CHARGE_CURVE_BANDS: any[] = [
  { minSoc: 0, maxSoc: 80 },
  { minSoc: 80, maxSoc: 85 },
  { minSoc: 85, maxSoc: 90 },
  { minSoc: 90, maxSoc: 95 },
  { minSoc: 95, maxSoc: 100 },
];
const BATTERY_CURVE_MIN_SAMPLES = 60;
const BATTERY_CURVE_MIN_SESSIONS = 3;
const BATTERY_CURVE_MIN_DAYS = 2;
const BATTERY_CURVE_MAX_DISPERSION_PERCENT = 20;
const BATTERY_LEARNING_MIN_OBSERVATIONS = 10;
const BATTERY_LEARNING_MIN_DAYS = 7;
const BATTERY_LEARNING_MIN_SOC_POINTS = 300;
const BATTERY_LEARNING_MIN_VALIDATIONS = 5;
const BATTERY_LEARNING_MAX_MAE_SOC = 3;
const BATTERY_LEARNING_MAX_BIAS_SOC = 2;
const BATTERY_LEARNING_MAX_ERROR_SOC = 6;
const BATTERY_LEARNING_DEMOTION_FAILURES = 3;
const ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT = 30;
const ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS = 10;
const ADAPTIVE_CHARGING_SEASONAL_DAY_RANGE = 28;
const ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR = 2;
const AWAY_RETURN_BUFFER_MS = 30 * 60_000;
const AWAY_LEARNED_MIN_DAYS = 3;

const DEFAULT_DASHBOARD_WIDGETS: any[] = [
  { id: "solarPower", group: "trends", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", visible: true, priority: 70 },
  { id: "adaptiveCharging", group: "status", visible: true, priority: 5 },
  { id: "backupPreparation", group: "status", visible: true, priority: 6 },
  { id: "awayStatus", group: "status", visible: true, priority: 7 },
  { id: "batteryWorking", group: "status", visible: true, priority: 10 },
  { id: "operationMode", group: "status", visible: true, priority: 20 },
  { id: "vendorProfile", group: "status", visible: true, priority: 30 },
  { id: "dischargeLimit", group: "status", visible: true, priority: 40 },
  { id: "fuelCellStatus", group: "status", visible: true, priority: 50 },
  { id: "fuelCellStateTimeline", group: "status", visible: true, priority: 55 },
  { id: "fuelCellHotWater", group: "status", visible: true, priority: 57 },
  { id: "solarSavings", group: "status", visible: true, priority: 60 },
  { id: "co2Savings", group: "status", visible: true, priority: 70 },
  { id: "offPeakSavings", group: "status", visible: true, priority: 80 },
  { id: "powerImported", group: "status", visible: true, priority: 90 },
  { id: "powerExported", group: "status", visible: true, priority: 100 },
  { id: "guardTriggerCount", group: "status", visible: true, priority: 110 },
  { id: "energySources", group: "status", visible: true, priority: 120 },
];

const DEFAULT_GUARD_CONDITIONS: Record<string, any> = {
  breakerVoltage: 100,
  breakerAmps: 40,
  reserveAmps: 5,
};

const DEFAULT_RETENTION = normalizeRetentionPolicy();

// Public defaults use RFC 5737 documentation addresses. Real deployments should
// set device addresses from the Settings page, where they are persisted in /data.
const DEFAULT_CONFIG: Record<string, any> = {
  batteryHost: "192.0.2.10",
  meterHost: "192.0.2.20",
  meterEoj: "0x028701",
  smartCosmoEnabled: true,
  circuitLabels: {},
  circuitDashboardVisibility: {},
  circuitSortMode: "number",
  solarHost: "192.0.2.10",
  solarEnabled: true,
  fuelCellHosts: ["192.0.2.30"],
  fuelCellPrimaryHost: "192.0.2.30",
  fuelCellProxyHosts: [],
  fuelCellEnabled: true,
  fuelCell: {
    includeInAdaptiveCharging: false,
    gasCo2KgPerM3: 2.21,
    tariff: {
      provider: "tokyo-gas",
      region: "tokyo",
      plan: "enefarm",
      equipmentDiscount: "",
      meterReadingDay: 1,
      automaticUpdates: false,
      marginalRateOverrideYenPerM3: null,
    },
  },
  rateMode: "simple",
  standardRateYenPerKwh: 35,
  offPeakRateYenPerKwh: 25,
  offPeakSavingsEnabled: false,
  discoverySubnets: [],
  retention: { ...DEFAULT_RETENTION, automaticMaintenance: true },
  updateIntervalSeconds: 15,
  co2TonnesPerKwh: 0.000423,
  rateBands: [
    { start: "00:00", end: "00:00", yenPerKwh: 35, label: "Simple" },
  ],
  batteryCapabilities: {
    usableCapacityKwh: null,
    maximumChargeWatts: null,
  },
  adaptiveCharging: {
    enabled: false,
    latitude: null,
    longitude: null,
    arrayPeakKw: null,
    panelTiltDegrees: 30,
    panelAzimuthDegrees: 0,
    systemLossPercent: 14,
    targetSocPercent: 100,
    forecastMarginPercent: 10,
  },
  notifications: DEFAULT_NOTIFICATION_CONFIG,
  dashboardWidgets: DEFAULT_DASHBOARD_WIDGETS,
  settingCache: {},
  language: "en",
};

let configMutationQueue = Promise.resolve();
let adaptiveChargingStateWriteQueue = Promise.resolve();
let operationalOverrideMutationQueue = Promise.resolve();
let scheduleMutationQueue = Promise.resolve();
let scheduleTimer: any = null;
let automationTimer: any = null;
let recorderTimer: any = null;
let retentionTimer: any = null;
let retentionRunPromise: any = null;
let backgroundProcessesEnabled = false;
let adaptiveChargingSlotEndTimer: any = null;
let adaptiveChargingSlotEndTimerKey: any = null;
let applicationStarted = false;
let databaseOperation: Record<string, any> = {
  busy: false,
  type: null,
  filename: null,
  phase: "idle",
  percent: 0,
  processed: 0,
  total: 0,
  unit: null,
  startedAt: null,
  completedAt: null,
  error: null,
  result: null,
};
let automationRunInProgress = false;
let automationRunContext: any = null;
let discoveryRunContext: any = null;

const historyStore = createHistoryStore({ dataDir: DATA_DIR });
const applicationStore = createApplicationStore({ dataDir: DATA_DIR });
const notificationService = createNotificationService({
  dataDir: DATA_DIR,
  getConfig: () => readConfig(),
  recordEvent: (event: any) => historyStore.isReady() && historyStore.recordEvent(event),
  stateStore: {
    isReady: () => applicationStore.isReady(),
    read: (key: any, fallback: any) => applicationStore.readDocument(key, fallback),
    write: (key: any, value: any) => applicationStore.writeDocument(key, value),
  },
});
let lastRecordedSample: any = null;
let latestStatusSnapshot: any = null;
let statusRefreshPromise: any = null;
let adaptiveChargingHistoryCache: any = null;
let adaptiveChargingDemandProfileIndexPromise: any = null;
const runningScheduleIds = new Set();
const activeDeviceCommands = new Set();
const discoveryJobs = new Map();
const DISCOVERY_JOB_TTL_MS = 10 * 60 * 1000;

let activeDeviceAdapter: any = null;
const deviceQueue = new DeviceCommandQueue({
  executor: async () => { throw new Error("ECHONET adapter has not been initialized"); },
  queueTimeoutMs: DEVICE_QUEUE_TIMEOUT_MS,
  starvationMs: DEVICE_QUEUE_STARVATION_MS,
});
const setDeviceCommandExecutor = (executor: DeviceCommandExecutor) => deviceQueue.setExecutor(executor);
const runDeviceCommandQueued = (
  command: string,
  args: DeviceCommandArguments = {},
  positional: unknown[] = [],
  options: { priority?: number; queueTimeoutMs?: number } = {},
) => deviceQueue.run(command, args, positional, options);

async function configureDeviceCommandAdapter(): Promise<any> {
  const modulePath = process.env.DEVICE_COMMAND_ADAPTER_MODULE;
  let adapter;
  if (modulePath) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("DEVICE_COMMAND_ADAPTER_MODULE may only be used when NODE_ENV=test");
    }
    const resolvedPath = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, modulePath);
    const adapterModule = await import(pathToFileURL(resolvedPath).href);
    if (typeof adapterModule.createDeviceCommandAdapter !== "function") {
      throw new Error(`${resolvedPath} must export createDeviceCommandAdapter()`);
    }
    adapter = await adapterModule.createDeviceCommandAdapter({ environment: process.env });
  } else {
    adapter = await createEchonetCommandAdapter({
      timeout: ECHONET_TIMEOUT_MS / 1000,
      netif: process.env.ECHONET_NETIF ?? "",
      debug: process.env.ECHONET_DEBUG === "1",
    });
  }
  const execute = typeof adapter === "function" ? adapter : adapter?.execute?.bind(adapter);
  if (typeof execute !== "function") {
    throw new Error("Device adapter must be a function or an object with execute()");
  }
  activeDeviceAdapter = adapter;
  setDeviceCommandExecutor(execute);
}


async function ensureDataDir(): Promise<any> {
  await mkdir(DATA_DIR, { recursive: true });
}

function numericMetric(item: any): any {
  if (item?.value === null || item?.value === undefined || item.value === "" || typeof item.value === "boolean") return null;
  const value = Number(item?.value);
  return Number.isFinite(value) ? value : null;
}

function primaryFuelCell(fuelCells: any = []): any {
  return fuelCells.find((cell: any) => cell.source_role === "primary") ?? null;
}

function selectedFuelCellReading(fuelCells: any = []): any {
  const primary = primaryFuelCell(fuelCells);
  if (numericMetric(primary?.instant_power) !== null || primary?.generation_status?.value) return primary;
  return fuelCells.find((cell: any) => cell.source_role === "proxy" && (numericMetric(cell.instant_power) !== null || cell.generation_status?.value)) ?? primary;
}

function normalizeCircuitDashboardVisibility(value: any = {}): any {
  const out: Record<string, any> = {};
  const entries = Array.isArray(value)
    ? value.map((item: any) => [item?.channel, item?.visible])
    : Object.entries(value ?? {});
  for (const [channelRaw, visibleRaw] of entries) {
    const channel = Number(channelRaw);
    if (!Number.isInteger(channel) || channel < 1 || channel > 252) continue;
    out[String(channel)] = configBool(visibleRaw, true);
  }
  return out;
}

function logDetailedError(label: any, err: any): any {
  console.error(`${label}:`, err.stack || err.message);
  if (err.automationContext) {
    console.error(`${label} context: ${JSON.stringify(err.automationContext)}`);
  }
  if (err.jsonSource !== undefined) {
    console.error(`${label} JSON source: ${err.jsonSource}`);
    if (err.jsonLocation) {
      console.error(
        `${label} JSON location: line ${err.jsonLocation.line}, column ${err.jsonLocation.column}, position ${err.jsonLocation.position}`,
      );
    }
    if (err.jsonSnippet !== undefined) {
      console.error(`${label} JSON near error:\n${err.jsonSnippet}`);
    }
    console.error(`${label} JSON payload:\n${jsonSnippet(err.jsonText ?? "")}`);
  }
}

async function readHistorySamplesInRange(startMs: any, endMs: any): Promise<any> {
  return historyStore.querySamples(startMs, endMs);
}

function adaptiveChargingHistorySample(sample: any): any {
  const compact: Record<string, any> = { timestamp: sample.timestamp };
  let hasAdaptiveChargingMetric = false;
  for (const key of [
    "stateOfChargePercent", "batteryPowerW", "solarPowerW", "houseDemandW",
    "fuelCellPowerW", "fuelCellGenerationState", "fuelCellDataQuality",
  ]) {
    if (sample[key] === undefined) continue;
    compact[key] = sample[key];
    if (sample[key] !== null) hasAdaptiveChargingMetric = true;
  }
  for (const key of [
    "rollupStart", "rollupEnd", "rollupResolution", "expectedIntervalSeconds",
    "intervalAveragePowerW", "powerCoverageSeconds", "coverageSeconds",
  ]) {
    if (sample[key] !== undefined) compact[key] = sample[key];
  }
  return hasAdaptiveChargingMetric ? compact : null;
}

async function readAdaptiveChargingHistory(now: any = new Date()): Promise<any> {
  const endMs = now.getTime();
  const startMs = endMs - 90 * 86_400_000;
  if (adaptiveChargingHistoryCache
    && endMs >= adaptiveChargingHistoryCache.loadedAt
    && endMs - adaptiveChargingHistoryCache.loadedAt < ADAPTIVE_CHARGING_HISTORY_CACHE_MS
    && adaptiveChargingHistoryCache.startMs <= startMs) {
    return adaptiveChargingHistoryCache.samples.filter((sample: any) => {
      const time = new Date(sample.timestamp).getTime();
      return time >= startMs && time <= endMs;
    });
  }
  const samples = historyStore.querySamples(startMs, endMs)
    .map(adaptiveChargingHistorySample)
    .filter(Boolean);
  adaptiveChargingHistoryCache = { loadedAt: endMs, startMs, samples };
  return [...samples];
}

async function readBatteryLearningHistory(now: any = new Date()): Promise<any> {
  const endMs = now.getTime();
  const startMs = endMs - 90 * 86_400_000;
  const rollups = historyStore.querySamples(startMs, endMs, { resolution: "interval" });
  const manualActions = historyStore.eventsBetween("adaptiveCharging", startMs, endMs, ["pause"])
    .filter((event: any) => /^Manual\b/.test(event.message ?? ""))
    .map((event: any) => new Date(event.at).getTime())
    .filter(Number.isFinite);
  return rollups.map((rollup: any) => {
    const rollupStart = new Date(rollup.rollupStart ?? rollup.timestamp).getTime();
    const rollupEnd = new Date(rollup.rollupEnd ?? rollup.timestamp).getTime();
    return manualActions.some((time: any) => time >= rollupStart && time < rollupEnd)
      ? { ...rollup, manualAction: true }
      : rollup;
  });
}

async function refreshBatteryLearning(config: any, state: any, now: any = new Date()): Promise<any> {
  const rollups = await readBatteryLearningHistory(now);
  const curveSamples = historyStore.isReady()
    ? historyStore.batteryChargeCurveSamples(state.chargingPerformance?.sessions ?? [])
    : [];
  const previous = state.batteryLearning ?? cleanBatteryLearningModel();
  const model = buildBatteryLearningModel(config, rollups, {
    ...previous,
    performance: state.chargingPerformance,
  }, now, { curveSamples });
  const transitions: any[] = [];
  for (const key of ["charge", "discharge", "power"]) {
    if (previous[key]?.source !== model[key]?.source) {
      transitions.push(`${key} model ${model[key].source === "learned" ? "activated" : "returned to configured fallback"}`);
    }
  }
  const previousCurveSources = (previous.power?.curve ?? []).map((band: any) => band.source).join(":");
  const curveSources = (model.power?.curve ?? []).map((band: any) => band.source).join(":");
  if (previousCurveSources !== curveSources) transitions.push("charge-power curve confidence changed");
  if (transitions.length) {
    const message = `${transitions.join("; ")}; battery model version ${BATTERY_LEARNING_MODEL_VERSION}`;
    appendAdaptiveChargingLog(state, message, model.status === "degraded" ? "warning" : "learning", now);
    if (historyStore.isReady()) {
      historyStore.recordEvent({
        eventKey: `adaptiveCharging:battery-model:${now.toISOString()}:${transitions.join("|")}`,
        at: now.toISOString(),
        category: "adaptiveCharging",
        type: model.status === "degraded" ? "battery-model-demoted" : "battery-model-activated",
        message,
        payload: model,
      });
    }
  }
  if (historyStore.isReady()) {
    const snapshotKey = [
      model.charge.acceptedObservationCount,
      model.discharge.acceptedObservationCount,
      model.charge.validation.count,
      model.discharge.validation.count,
      model.charge.source,
      model.discharge.source,
      model.power.source,
      curveSources,
    ].join(":");
    historyStore.recordEvent({
      eventKey: `adaptiveCharging:battery-model-snapshot:v${BATTERY_LEARNING_MODEL_VERSION}:${snapshotKey}`,
      at: now.toISOString(),
      category: "adaptiveCharging",
      type: "battery-model-snapshot",
      message: `Battery model ${model.status}`,
      payload: model,
    });
    for (const kind of ["charge", "discharge"]) {
      for (const outcome of model[kind].validation.outcomes ?? []) {
        historyStore.recordEvent({
          eventKey: `adaptiveCharging:battery-model-validation:v${BATTERY_LEARNING_MODEL_VERSION}:${kind}:${outcome.id}`,
          at: now.toISOString(),
          category: "adaptiveCharging",
          type: "battery-model-validation",
          message: `${kind} model validation error ${Number(outcome.errorSoc).toFixed(2)} SOC points`,
          payload: { modelVersion: BATTERY_LEARNING_MODEL_VERSION, kind, ...outcome },
        });
      }
    }
  }
  state.batteryLearning = model;
  return model;
}

function emptyAdaptiveChargingDemandProfileIndex(): any {
  return { days: {} };
}

function addSampleToAdaptiveChargingDemandProfileIndex(index: any, sample: any): any {
  const demand = Number(sample?.intervalAveragePowerW?.houseDemandW ?? sample?.houseDemandW);
  const time = new Date(sample?.timestamp);
  if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) return;
  const key = localDayKey(time);
  const bucket = halfHourIndex(time);
  const day = index.days[key] ?? {
    weightedSums: Array(48).fill(0),
    coverageSeconds: Array(48).fill(0),
  };
  const coverageSeconds = Math.min(1800, Math.max(0,
    Number(sample?.powerCoverageSeconds?.houseDemandW
      ?? sample?.coverageSeconds?.houseDemandKwh
      ?? sample?.expectedIntervalSeconds
      ?? 0),
  ));
  if (coverageSeconds <= 0) return;
  day.weightedSums[bucket] = Number(day.weightedSums[bucket] ?? 0) + demand * coverageSeconds;
  day.coverageSeconds[bucket] = Math.min(
    1800,
    Number(day.coverageSeconds[bucket] ?? 0) + coverageSeconds,
  );
  index.days[key] = day;
}

function demandDayCoverage(coverageByBucket: any): any {
  const seconds = [...coverageByBucket.values()].reduce(
    (sum: any, value: any) => sum + Math.min(1800, Number(value) || 0),
    0,
  );
  const daytimeSeconds = [...coverageByBucket]
    .filter(([bucket]: any) => bucket >= 12 && bucket < 36)
    .reduce((sum: any, [, value]: any) => sum + Math.min(1800, Number(value) || 0), 0);
  return {
    coverage: seconds / (48 * 1800),
    daytimeCoverage: daytimeSeconds / (24 * 1800),
  };
}

function adaptiveChargingDemandProfileDays(index: any): any {
  return Object.entries(index.days).map(([key, day]: any) => {
    const values = new Map();
    const coverageByBucket = new Map();
    for (let bucket = 0; bucket < 48; bucket += 1) {
      const seconds = Number(day.coverageSeconds?.[bucket] ?? 0);
      const weightedSum = Number(day.weightedSums?.[bucket] ?? 0);
      if (seconds > 0 && Number.isFinite(weightedSum)) {
        values.set(bucket, weightedSum / seconds);
        coverageByBucket.set(bucket, Math.min(1800, seconds));
      }
    }
    return {
      key,
      date: new Date(`${key}T00:00:00`),
      ...demandDayCoverage(coverageByBucket),
      coverageByBucket,
      values,
    };
  }).filter((day: any) => !Number.isNaN(day.date.getTime()));
}

async function refreshAdaptiveChargingDemandProfileIndex(): Promise<any> {
  const endMs = Date.now();
  const startMs = endMs - ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS * 366 * 86_400_000;
  const index = emptyAdaptiveChargingDemandProfileIndex();
  for (const sample of historyStore.querySamples(startMs, endMs, { resolution: "interval" })) {
    addSampleToAdaptiveChargingDemandProfileIndex(index, sample);
  }
  return adaptiveChargingDemandProfileDays(index);
}

async function readAdaptiveChargingDemandProfileDays(): Promise<any> {
  if (!adaptiveChargingDemandProfileIndexPromise) {
    adaptiveChargingDemandProfileIndexPromise = refreshAdaptiveChargingDemandProfileIndex()
      .finally(() => { adaptiveChargingDemandProfileIndexPromise = null; });
  }
  return adaptiveChargingDemandProfileIndexPromise;
}

const BATTERY_PROFILES = new Set(["osaifu", "eco", "backup"]);
const BACKUP_PREPARATION_LOG_LIMIT = 50;

function cleanOperationalOverridesState(input: any = {}): any {
  const backup = input?.backupPreparation ?? {};
  const phase = ["inactive", "starting", "active", "ending"].includes(backup.phase)
    ? backup.phase
    : backup.active === true
      ? "active"
      : "inactive";
  const active = phase !== "inactive";
  return {
    version: 1,
    backupPreparation: {
      active,
      phase,
      allowDemandGuard: backup.allowDemandGuard !== false,
      previousProfile: BATTERY_PROFILES.has(backup.previousProfile) ? backup.previousProfile : null,
      currentProfile: BATTERY_PROFILES.has(backup.currentProfile) ? backup.currentProfile : null,
      startedAt: typeof backup.startedAt === "string" ? backup.startedAt : null,
      endedAt: typeof backup.endedAt === "string" ? backup.endedAt : null,
      updatedAt: typeof backup.updatedAt === "string" ? backup.updatedAt : null,
      lastResult: backup.lastResult && typeof backup.lastResult === "object" ? backup.lastResult : null,
    },
    log: (Array.isArray(input?.log) ? input.log : [])
      .filter((entry: any) => entry && typeof entry.at === "string" && typeof entry.message === "string")
      .map((entry: any) => ({ at: entry.at, message: entry.message, kind: String(entry.kind ?? "info") }))
      .slice(-BACKUP_PREPARATION_LOG_LIMIT),
  };
}

function appendBackupPreparationLog(state: any, message: any, kind: any = "info", now: any = new Date()): any {
  state.log = [
    ...(state.log ?? []),
    { at: now.toISOString(), message, kind },
  ].slice(-BACKUP_PREPARATION_LOG_LIMIT);
}

async function readOperationalOverridesState(): Promise<any> {
  return cleanOperationalOverridesState(applicationStore.readDocument("operationalOverrides", {}));
}

async function writeOperationalOverridesState(state: any): Promise<any> {
  const cleaned = cleanOperationalOverridesState(state);
  applicationStore.writeDocument("operationalOverrides", cleaned);
  return cleaned;
}

function withOperationalOverrideMutation(mutation: any): any {
  const task = operationalOverrideMutationQueue.then(mutation);
  operationalOverrideMutationQueue = task.catch(() => {});
  return task;
}

function backupPreparationBlocksActions(state: any): any {
  return state?.backupPreparation?.active === true;
}

function backupPreparationAllowsActionSource(state: any, source: any): any {
  if (!backupPreparationBlocksActions(state)) return true;
  if (source === "backup-preparation") return true;
  return source === "charging-demand-guard" && state.backupPreparation.allowDemandGuard !== false;
}

function backupPreparationView(state: any): any {
  const cleaned = cleanOperationalOverridesState(state);
  return {
    ...cleaned.backupPreparation,
    log: [...cleaned.log].reverse(),
  };
}

async function recordBlockedBackupPreparationAction(source: any, action: any): Promise<any> {
  return withOperationalOverrideMutation(async () => {
    const state = await readOperationalOverridesState();
    if (!backupPreparationBlocksActions(state)) return state;
    const now = new Date();
    appendBackupPreparationLog(
      state,
      `Blocked ${source} action ${action} while Backup Preparation is active`,
      "blocked",
      now,
    );
    state.backupPreparation.updatedAt = now.toISOString();
    return writeOperationalOverridesState(state);
  });
}

async function assertActionAllowedByOperationalOverride(source: any, action: any): Promise<any> {
  const state = await readOperationalOverridesState();
  if (backupPreparationAllowsActionSource(state, source)) return;
  await recordBlockedBackupPreparationAction(source, action);
  throw requestError(409, `Backup Preparation is active; ${action} is blocked until it is ended`);
}

function cleanBatteryLearningCoefficient(value: any = {}): any {
  const validation = value.validation ?? {};
  return {
    source: value.source === "learned" ? "learned" : "configured",
    configuredWhPerSocPoint: finiteNumberOrNull(value.configuredWhPerSocPoint),
    candidateWhPerSocPoint: finiteNumberOrNull(value.candidateWhPerSocPoint),
    activeWhPerSocPoint: finiteNumberOrNull(value.activeWhPerSocPoint),
    observationCount: Math.max(0, Math.round(Number(value.observationCount) || 0)),
    acceptedObservationCount: Math.max(0, Math.round(Number(value.acceptedObservationCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(value.distinctDays) || 0)),
    totalSocPoints: Math.max(0, Number(value.totalSocPoints) || 0),
    dispersionPercent: finiteNumberOrNull(value.dispersionPercent),
    stabilityPercent: finiteNumberOrNull(value.stabilityPercent),
    acceptancePercent: finiteNumberOrNull(value.acceptancePercent),
    validation: {
      count: Math.max(0, Math.round(Number(validation.count) || 0)),
      meanAbsoluteErrorSoc: finiteNumberOrNull(validation.meanAbsoluteErrorSoc),
      biasSoc: finiteNumberOrNull(validation.biasSoc),
      maximumErrorSoc: finiteNumberOrNull(validation.maximumErrorSoc),
      seenIds: (Array.isArray(validation.seenIds) ? validation.seenIds : [])
        .filter(Boolean)
        .map(String)
        .slice(-500),
      outcomes: (Array.isArray(validation.outcomes) ? validation.outcomes : []).slice(-20).map((outcome: any) => ({
        id: outcome.id ?? null,
        predictedSocDelta: finiteNumberOrNull(outcome.predictedSocDelta),
        actualSocDelta: finiteNumberOrNull(outcome.actualSocDelta),
        errorSoc: finiteNumberOrNull(outcome.errorSoc),
      })),
    },
    blockers: Array.isArray(value.blockers) ? value.blockers.map(String) : [],
    activatedAt: value.activatedAt ?? null,
    activationSnapshot: value.activationSnapshot && typeof value.activationSnapshot === "object"
      ? value.activationSnapshot
      : null,
    demotedAt: value.demotedAt ?? null,
    demotionReason: value.demotionReason ?? null,
    failureStreak: Math.max(0, Math.round(Number(value.failureStreak) || 0)),
    lastValidationCount: Math.max(0, Math.round(Number(value.lastValidationCount) || 0)),
  };
}

function cleanBatteryLearningPower(value: any = {}): any {
  const curve = (Array.isArray(value.curve) ? value.curve : []).map((band: any) => ({
    minSoc: Math.max(0, Math.min(100, Number(band.minSoc) || 0)),
    maxSoc: Math.max(0, Math.min(100, Number(band.maxSoc) || 0)),
    source: band.source === "learned" ? "learned" : "configured",
    configuredWatts: finiteNumberOrNull(band.configuredWatts),
    candidateWatts: finiteNumberOrNull(band.candidateWatts),
    activeWatts: finiteNumberOrNull(band.activeWatts),
    sampleCount: Math.max(0, Math.round(Number(band.sampleCount) || 0)),
    sessionCount: Math.max(0, Math.round(Number(band.sessionCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(band.distinctDays) || 0)),
    dispersionPercent: finiteNumberOrNull(band.dispersionPercent),
    blockers: Array.isArray(band.blockers) ? band.blockers.map(String) : [],
  })).filter((band: any) => band.maxSoc > band.minSoc);
  return {
    source: value.source === "learned" ? "learned" : "configured",
    configuredWatts: finiteNumberOrNull(value.configuredWatts),
    candidateWatts: finiteNumberOrNull(value.candidateWatts),
    activeWatts: finiteNumberOrNull(value.activeWatts),
    sampleCount: Math.max(0, Math.round(Number(value.sampleCount) || 0)),
    postMigrationSampleCount: Math.max(0, Math.round(Number(value.postMigrationSampleCount) || 0)),
    sessionCount: Math.max(0, Math.round(Number(value.sessionCount) || 0)),
    distinctDays: Math.max(0, Math.round(Number(value.distinctDays) || 0)),
    dispersionPercent: finiteNumberOrNull(value.dispersionPercent),
    blockers: Array.isArray(value.blockers) ? value.blockers.map(String) : [],
    activatedAt: value.activatedAt ?? null,
    activationSnapshot: value.activationSnapshot && typeof value.activationSnapshot === "object"
      ? value.activationSnapshot
      : null,
    demotedAt: value.demotedAt ?? null,
    demotionReason: value.demotionReason ?? null,
    curve,
  };
}

function cleanBatteryLearningModel(value: any = {}): any {
  return {
    version: BATTERY_LEARNING_MODEL_VERSION,
    migratedAt: value.migratedAt ?? new Date().toISOString(),
    status: ["learning", "validating", "active", "degraded"].includes(value.status)
      ? value.status
      : "learning",
    switchAfterSlotEnd: value.switchAfterSlotEnd ?? null,
    consumedSwitchAfterSlotEnd: value.consumedSwitchAfterSlotEnd ?? null,
    switchConsumedAt: value.switchConsumedAt ?? null,
    charge: cleanBatteryLearningCoefficient(value.charge),
    discharge: cleanBatteryLearningCoefficient(value.discharge),
    power: cleanBatteryLearningPower(value.power),
    lastEvaluatedAt: value.lastEvaluatedAt ?? null,
  };
}

function cleanAdaptiveChargingState(value: any = {}): any {
  const plan = value.plan?.available === false
    && value.plan.reason === "discounted windows cannot safely reach their planned SOC targets"
    && Number(value.plan.plannedChargeKwh) > 0
    ? { ...value.plan, ...discountedPlanStatus(value.plan) }
    : value.plan ?? null;
  return {
    revision: Math.max(0, Math.floor(Number(value.revision) || 0)),
    forecast: value.forecast ?? null,
    plan,
    owner: value.owner === "adaptiveCharging" ? "adaptiveCharging" : null,
    activeSlot: value.activeSlot ?? null,
    activePlanCreatedAt: value.activePlanCreatedAt ?? null,
    activeChargedKwh: Math.max(0, Number(value.activeChargedKwh) || 0),
    activeLastCheckedAt: value.activeLastCheckedAt ?? null,
    standbyHoldUntil: value.standbyHoldUntil ?? null,
    activeChargeSession: value.activeChargeSession ? {
      startedAt: value.activeChargeSession.startedAt ?? null,
      requestedWh: Math.max(0, Math.round(Number(value.activeChargeSession.requestedWh) || 0)),
      startSocPercent: finiteNumberOrNull(value.activeChargeSession.startSocPercent),
      latestSocPercent: finiteNumberOrNull(value.activeChargeSession.latestSocPercent),
      latestChargingW: finiteNumberOrNull(value.activeChargeSession.latestChargingW),
      lastSampleAt: value.activeChargeSession.lastSampleAt ?? null,
      idleSince: value.activeChargeSession.idleSince ?? null,
      idleCheckedAt: value.activeChargeSession.idleCheckedAt ?? null,
      slotStart: value.activeChargeSession.slotStart ?? null,
      slotEnd: value.activeChargeSession.slotEnd ?? null,
      label: value.activeChargeSession.label ?? null,
    } : null,
    chargingPerformance: cleanAdaptiveChargingPerformance(value.chargingPerformance),
    batteryLearning: cleanBatteryLearningModel(value.batteryLearning),
    lastPlanEventKey: value.lastPlanEventKey ?? null,
    pendingPlanReason: value.pendingPlanReason ?? null,
    pendingPlanRequestId: value.pendingPlanRequestId
      ?? (value.pendingPlanReason ? `legacy:${value.pendingPlanReason}` : null),
    pendingPlanRequestedAt: value.pendingPlanRequestedAt ?? null,
    interruptedCharge: value.interruptedCharge
      && Number.isFinite(Number(value.interruptedCharge.remainingWh))
      && Number(value.interruptedCharge.remainingWh) > 0
      ? {
        slotId: value.interruptedCharge.slotId ?? null,
        slotStart: value.interruptedCharge.slotStart ?? null,
        slotEnd: value.interruptedCharge.slotEnd ?? null,
        windowStart: value.interruptedCharge.windowStart ?? null,
        windowEnd: value.interruptedCharge.windowEnd ?? null,
        remainingWh: Math.max(1, Math.round(Number(value.interruptedCharge.remainingWh))),
        deliveredWh: Math.max(0, Math.round(Number(value.interruptedCharge.deliveredWh) || 0)),
        interruptedAt: value.interruptedCharge.interruptedAt ?? null,
      }
      : null,
    breakerRecovery: value.breakerRecovery?.interruptedAt
      ? {
        interruptedAt: value.breakerRecovery.interruptedAt,
        cooldownUntil: value.breakerRecovery.cooldownUntil ?? null,
        consecutiveSafeChecks: Math.max(0, Math.round(Number(value.breakerRecovery.consecutiveSafeChecks) || 0)),
        lastCheckedAt: value.breakerRecovery.lastCheckedAt ?? null,
        lastWaitLogAt: value.breakerRecovery.lastWaitLogAt ?? null,
        currentImportW: finiteNumberOrNull(value.breakerRecovery.currentImportW),
        thresholdW: finiteNumberOrNull(value.breakerRecovery.thresholdW),
        chargeWatts: finiteNumberOrNull(value.breakerRecovery.chargeWatts),
        safetyMarginW: finiteNumberOrNull(value.breakerRecovery.safetyMarginW),
      }
      : null,
    lastHeadroomWaitLogAt: value.lastHeadroomWaitLogAt ?? null,
    activeWindowExecution: value.activeWindowExecution?.key
      ? {
        key: value.activeWindowExecution.key,
        windowStart: value.activeWindowExecution.windowStart ?? null,
        windowEnd: value.activeWindowExecution.windowEnd ?? null,
        label: value.activeWindowExecution.label ?? null,
        yenPerKwh: finiteNumberOrNull(value.activeWindowExecution.yenPerKwh),
        plannedWh: Math.max(0, Math.round(Number(value.activeWindowExecution.plannedWh) || 0)),
        deliveredWh: Math.max(0, Math.round(Number(value.activeWindowExecution.deliveredWh) || 0)),
        estimatedDeliveryWh: Math.max(0, Math.round(Number(value.activeWindowExecution.estimatedDeliveryWh) || 0)),
        interruptionCount: Math.max(0, Math.round(Number(value.activeWindowExecution.interruptionCount) || 0)),
        solarHeadroomInterruptionCount: Math.max(
          0,
          Math.round(Number(value.activeWindowExecution.solarHeadroomInterruptionCount) || 0),
        ),
        startSocPercent: finiteNumberOrNull(value.activeWindowExecution.startSocPercent),
        latestSocPercent: finiteNumberOrNull(value.activeWindowExecution.latestSocPercent),
        targetSocPercent: finiteNumberOrNull(value.activeWindowExecution.targetSocPercent),
        idleRecoveryCount: Math.max(0, Math.round(Number(value.activeWindowExecution.idleRecoveryCount) || 0)),
        startedTrackingAt: value.activeWindowExecution.startedTrackingAt ?? null,
        updatedAt: value.activeWindowExecution.updatedAt ?? null,
      }
      : null,
    windowSummaries: (Array.isArray(value.windowSummaries) ? value.windowSummaries : [])
      .filter((summary: any) => summary?.key && summary.windowStart && summary.windowEnd)
      .map((summary: any) => ({
        key: summary.key,
        windowStart: summary.windowStart,
        windowEnd: summary.windowEnd,
        label: summary.label ?? null,
        yenPerKwh: finiteNumberOrNull(summary.yenPerKwh),
        plannedWh: Math.max(0, Math.round(Number(summary.plannedWh) || 0)),
        deliveredWh: Math.max(0, Math.round(Number(summary.deliveredWh) || 0)),
        estimatedDeliveryWh: Math.max(0, Math.round(Number(summary.estimatedDeliveryWh) || 0)),
        unmetWh: Math.max(0, Math.round(Number(summary.unmetWh) || 0)),
        targetSocPercent: finiteNumberOrNull(summary.targetSocPercent),
        socTargetReached: summary.socTargetReached === true,
        interruptionCount: Math.max(0, Math.round(Number(summary.interruptionCount) || 0)),
        solarHeadroomInterruptionCount: Math.max(
          0,
          Math.round(Number(summary.solarHeadroomInterruptionCount) || 0),
        ),
        startSocPercent: finiteNumberOrNull(summary.startSocPercent),
        endSocPercent: finiteNumberOrNull(summary.endSocPercent),
        completedAt: summary.completedAt ?? null,
        reason: summary.reason ?? null,
        modelVersion: Number(summary.modelVersion) || BATTERY_LEARNING_MODEL_VERSION,
      }))
      .slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT),
    pausedUntil: value.pausedUntil ?? null,
    solarHeadroomHoldUntil: value.solarHeadroomHoldUntil ?? null,
    solarHeadroomClearChecks: Math.max(0, Math.round(Number(value.solarHeadroomClearChecks) || 0)),
    exportConfirmation: {
      count: Math.max(0, Math.round(Number(value.exportConfirmation?.count) || 0)),
      coherent: value.exportConfirmation?.coherent === true,
      firstSeenAt: value.exportConfirmation?.firstSeenAt ?? null,
      lastSeenAt: value.exportConfirmation?.lastSeenAt ?? null,
      lastRejectedAt: value.exportConfirmation?.lastRejectedAt ?? null,
      lastRejectedLogAt: value.exportConfirmation?.lastRejectedLogAt ?? null,
      lastGridExportW: finiteNumberOrNull(value.exportConfirmation?.lastGridExportW),
      lastBalanceResidualW: finiteNumberOrNull(value.exportConfirmation?.lastBalanceResidualW),
    },
    lastResult: value.lastResult ?? null,
    lastForecastError: value.lastForecastError ?? null,
    historicalWeatherFetchedAt: value.historicalWeatherFetchedAt ?? null,
    lastAwayStateKey: value.lastAwayStateKey ?? null,
    log: Array.isArray(value.log) ? value.log.slice(-200) : [],
    updatedAt: value.updatedAt ?? new Date().toISOString(),
  };
}

function finiteNumberOrNull(value: any): any {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanAdaptiveChargingPerformance(value: any = {}): any {
  const samples = (Array.isArray(value.samples) ? value.samples : [])
    .map((sample: any) => ({
      at: sample.at ?? null,
      batteryChargingW: Number(sample.batteryChargingW),
      socPercent: finiteNumberOrNull(sample.socPercent),
      houseDemandW: sample.houseDemandW === null || sample.houseDemandW === undefined
        ? null
        : Number(sample.houseDemandW),
      gridImportW: sample.gridImportW === null || sample.gridImportW === undefined
        ? null
        : Number(sample.gridImportW),
    }))
    .filter((sample: any) => sample.at
      && Number.isFinite(sample.batteryChargingW)
      && sample.batteryChargingW > 0)
    .slice(-ADAPTIVE_CHARGE_SAMPLE_LIMIT);
  const sessions = (Array.isArray(value.sessions) ? value.sessions : [])
    .map((session: any) => ({
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      reason: session.reason ?? null,
      requestedWh: Math.max(0, Math.round(Number(session.requestedWh) || 0)),
      deliveredWh: Math.max(0, Math.round(Number(session.deliveredWh) || 0)),
      startSocPercent: finiteNumberOrNull(session.startSocPercent),
      endSocPercent: finiteNumberOrNull(session.endSocPercent),
      socDeltaPercent: finiteNumberOrNull(session.socDeltaPercent),
      averageChargeWatts: finiteNumberOrNull(session.averageChargeWatts),
      estimatedDeliveryWh: Math.max(0, Math.round(Number(session.estimatedDeliveryWh) || 0)),
      modelVersion: Number(session.modelVersion) || BATTERY_LEARNING_MODEL_VERSION,
    }))
    .filter((session: any) => session.startedAt && session.endedAt)
    .slice(-ADAPTIVE_CHARGE_SESSION_LIMIT);
  const chargingPowers = samples.map((sample: any) => sample.batteryChargingW).sort((a: any, b: any) => a - b);
  const upperQuartile = chargingPowers.slice(Math.floor(chargingPowers.length * 0.75));
  const learnedChargeWatts = chargingPowers.length >= 10 ? median(upperQuartile) : null;
  const demandPairs = samples.filter((sample: any) => Number.isFinite(sample.houseDemandW));
  let demandImpactWattsPerKw: any = null;
  if (demandPairs.length >= 10) {
    const meanDemand = demandPairs.reduce((sum: any, sample: any) => sum + sample.houseDemandW, 0) / demandPairs.length;
    const meanCharge = demandPairs.reduce((sum: any, sample: any) => sum + sample.batteryChargingW, 0) / demandPairs.length;
    const variance = demandPairs.reduce((sum: any, sample: any) => sum + (sample.houseDemandW - meanDemand) ** 2, 0);
    if (variance > 0) {
      const covariance = demandPairs.reduce(
        (sum: any, sample: any) => sum + (sample.houseDemandW - meanDemand) * (sample.batteryChargingW - meanCharge),
        0,
      );
      demandImpactWattsPerKw = covariance / variance * 1000;
    }
  }
  return {
    samples,
    sessions,
    sampleCount: samples.length,
    sessionCount: sessions.length,
    learnedChargeWatts,
    demandImpactWattsPerKw,
  };
}

async function readAdaptiveChargingState(): Promise<any> {
  return cleanAdaptiveChargingState(applicationStore.readDocument("adaptiveChargingState", {}));
}

async function commitAdaptiveChargingState(state: any): Promise<any> {
  const current = await readAdaptiveChargingState();
  const expectedRevision = Math.max(0, Math.floor(Number(state?.revision) || 0));
  if (current.revision !== expectedRevision) {
    throw new Error(`stale Adaptive Charging state revision ${expectedRevision}; current revision is ${current.revision}`);
  }
  const cleaned = cleanAdaptiveChargingState({
    ...state,
    revision: expectedRevision + 1,
    updatedAt: new Date().toISOString(),
  });
  applicationStore.writeDocument("adaptiveChargingState", cleaned);
  if (historyStore.isReady()) {
    for (const entry of cleaned.log) {
      historyStore.recordEvent({
        eventKey: `adaptiveCharging:log:${entry.at}:${entry.kind ?? "info"}:${entry.message}`,
        at: entry.at,
        category: "adaptiveCharging",
        type: entry.kind ?? "log",
        message: entry.message,
      });
    }
    for (const summary of cleaned.windowSummaries) {
      historyStore.recordEvent({
        eventKey: `adaptiveCharging:window:${summary.key}`,
        at: summary.completedAt ?? summary.windowEnd,
        category: "adaptiveCharging",
        type: "window-summary",
        message: summary.reason,
        payload: summary,
      });
    }
  }
  syncAdaptiveChargingSlotEndTimer(cleaned);
  return cleaned;
}

function writeAdaptiveChargingState(state: any): any {
  const task = adaptiveChargingStateWriteQueue.then(() => commitAdaptiveChargingState(state));
  adaptiveChargingStateWriteQueue = task.catch(() => {});
  return task;
}

function appendAdaptiveChargingLog(state: any, message: any, kind: any = "info", at: any = new Date()): any {
  state.log = [
    ...(Array.isArray(state.log) ? state.log : []),
    { at: at.toISOString(), kind, message },
  ].slice(-200);
}

async function fetchJson(url: any, fetchImpl: any = fetch): Promise<any> {
  if (EXTERNAL_IO_DISABLED) throw new Error("External HTTP access is disabled in simulated UI development");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function openMeteoUrl(config: any, historical: any = false, now: any = new Date()): any {
  const adaptiveCharging = config.adaptiveCharging;
  const endpoint = historical
    ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/jma";
  const params = new URLSearchParams({
    latitude: String(adaptiveCharging.latitude),
    longitude: String(adaptiveCharging.longitude),
    hourly: "shortwave_radiation,global_tilted_irradiance,cloud_cover,temperature_2m",
    timezone: "auto",
    tilt: String(adaptiveCharging.panelTiltDegrees),
    azimuth: String(adaptiveCharging.panelAzimuthDegrees),
  });
  if (historical) {
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 89);
    params.set("start_date", localDayKey(start));
    params.set("end_date", localDayKey(end));
    params.set("models", "jma_msm");
  } else {
    params.set("forecast_days", "3");
    params.set("daily", "sunrise,sunset");
  }
  return `${endpoint}?${params}`;
}

function adaptiveChargingTimezoneError(forecast: any): any {
  const configuredTimezone = process.env.TZ;
  if (!configuredTimezone) return "container TZ must be configured before rate-band times can be aligned";
  if (!forecast?.timezone) return "forecast timezone is unavailable";
  return configuredTimezone === forecast.timezone
    ? null
    : `container timezone ${configuredTimezone} does not match forecast timezone ${forecast.timezone}`;
}

async function refreshAdaptiveChargingForecast(config: any, { fetchImpl = fetch, now = new Date(), forceHistorical = false }: any = {}): Promise<any> {
  let state = await readAdaptiveChargingState();
  try {
    const forecast = parseOpenMeteoForecast(await fetchJson(openMeteoUrl(config, false, now), fetchImpl), now);
    const timezoneError = adaptiveChargingTimezoneError(forecast);
    if (timezoneError) throw new Error(timezoneError);
    state.forecast = forecast;
    state.lastForecastError = null;
    appendAdaptiveChargingLog(state, `Open-Meteo forecast refreshed for ${forecast.timezone || "local time"}`, "forecast", now);
    historyStore.recordForecast(forecast);
  } catch (err: any) {
    state.lastForecastError = { at: now.toISOString(), error: err.message };
    appendAdaptiveChargingLog(state, `Forecast refresh failed: ${err.message}`, "error", now);
    return writeAdaptiveChargingState(state);
  }
  const historicalAge = now.getTime() - new Date(state.historicalWeatherFetchedAt ?? 0).getTime();
  if (forceHistorical || !Number.isFinite(historicalAge) || historicalAge > 24 * 60 * 60_000) {
    try {
      const historical = parseOpenMeteoForecast(await fetchJson(openMeteoUrl(config, true, now), fetchImpl), now);
      historyStore.recordWeather(historical.hours);
      state.historicalWeatherFetchedAt = now.toISOString();
    } catch (err: any) {
      appendAdaptiveChargingLog(state, `Historical weather refresh failed; using demand recency fallback: ${err.message}`, "warning", now);
    }
  }
  if (historyStore.isReady() && state.forecast) {
    try {
      historyStore.settleSolarForecastOutcomes(now);
      const samples = await readAdaptiveChargingHistory(now);
      const calibration = learnedSolarFactor(samples, historyStore.historicalWeather(), config);
      const accuracy = historyStore.solarForecastAccuracy();
      historyStore.recordSolarForecastIssues(
        dailySolarForecastIssues(state.forecast, config, calibration, accuracy),
      );
    } catch (err: any) {
      appendAdaptiveChargingLog(
        state,
        `Solar forecast outcome recording failed: ${err.message}`,
        "warning",
        now,
      );
    }
  }
  return writeAdaptiveChargingState(state);
}

function adaptiveChargingSolarForecastAccuracy(now: any = new Date()): any {
  const fallback: Record<string, any> = { learned: false, sampleCount: 0, factor: 1, outcomes: [] };
  if (!historyStore.isReady()) return fallback;
  try {
    historyStore.settleSolarForecastOutcomes(now);
    return historyStore.solarForecastAccuracy();
  } catch (err: any) {
    logDetailedError("solar-forecast-accuracy", err);
    return { ...fallback, error: err.message };
  }
}

function adaptiveChargingView(config: any, state: any, rules: any = [], now: any = new Date()): any {
  const solarForecastAccuracy = adaptiveChargingSolarForecastAccuracy(now);
  const availability = adaptiveChargingAvailability(config, rules);
  const forecastAgeMs = state.forecast?.fetchedAt
    ? now.getTime() - new Date(state.forecast.fetchedAt).getTime()
    : null;
  const paused = Boolean(state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime());
  const planUnavailableReason = state.plan && state.plan.available === false ? state.plan.reason : null;
  return {
    enabled: config.adaptiveCharging?.enabled === true,
    available: availability.available
      && forecastIsFresh(state.forecast, now)
      && !paused
      && !state.lastForecastError
      && !planUnavailableReason,
    reason: paused
      ? `paused until ${state.pausedUntil}`
      : availability.reason
        || state.lastForecastError?.error
        || planUnavailableReason
        || (!forecastIsFresh(state.forecast, now) ? "solar forecast is stale or unavailable" : null),
    warning: state.plan?.warning ?? null,
    away: historyStore.isReady() ? awayPeriodsView(now) : { periods: [], active: null, next: null, state: "home" },
    paused,
    pausedUntil: state.pausedUntil,
    forecast: state.forecast ? {
      fetchedAt: state.forecast.fetchedAt,
      ageMs: Number.isFinite(forecastAgeMs) ? Math.max(0, Number(forecastAgeMs)) : null,
      timezone: state.forecast.timezone,
      stale: !forecastIsFresh(state.forecast, now),
    } : null,
    solarForecastAccuracy,
    fuelCellForecastOutcomes: historyStore.isReady() ? historyStore.fuelCellForecastOutcomes(100) : [],
    plan: state.plan,
    owner: state.owner,
    activeSlot: state.activeSlot,
    interruptedCharge: state.interruptedCharge,
    breakerRecovery: state.breakerRecovery,
    standbyHoldUntil: state.standbyHoldUntil,
    exportConfirmation: state.exportConfirmation,
    activeWindowExecution: state.activeWindowExecution,
    windowSummaries: state.windowSummaries ?? [],
    chargingPerformance: state.chargingPerformance,
    batteryModel: state.batteryLearning,
    lastResult: state.lastResult,
    lastForecastError: state.lastForecastError,
    log: state.log ?? [],
  };
}

function recordFuelCellPlanForecast(plan: any, now: any = new Date()): any {
  if (!historyStore.isReady() || !plan?.fuelCellModel) return 0;
  historyStore.settleFuelCellForecastOutcomes(now);
  return historyStore.recordFuelCellForecasts((plan.timeline ?? []).map((interval: any) => ({
    start: interval.start,
    end: interval.end,
    p20W: interval.fuelCellP20W,
    medianW: interval.fuelCellMedianW,
    p80W: interval.fuelCellP80W,
    sampleCount: interval.fuelCellSampleCount,
    method: plan.fuelCellModel.method,
    influence: plan.fuelCellModel.influence,
  })), plan.createdAt ?? now.toISOString());
}

function rateForTimestamp(rateBands: any = DEFAULT_CONFIG.rateBands, timestamp: any = new Date(), fallbackRate: any = null): any {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const minute = date.getHours() * 60 + date.getMinutes();
  const bands = normalizeRateBands({ rateBands });
  const match = bands.find((band: any) => {
    const start = minutesOfDay(band.start);
    const end = minutesOfDay(band.end);
    if (start === null || end === null) return false;
    if (start === end) return true;
    if (start < end) return minute >= start && minute < end;
    return minute >= start || minute < end;
  });
  if (match) return match;
  if (fallbackRate !== null && fallbackRate !== undefined) {
    return {
      start: "00:00",
      end: "00:00",
      yenPerKwh: configNumber(fallbackRate, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000),
      label: "Standard",
    };
  }
  return bands[0];
}

function maxDailyRate(rateBands: any = DEFAULT_CONFIG.rateBands, fallbackRate: any = null): any {
  const rates = normalizeRateBands({ rateBands }).map((band: any) => band.yenPerKwh);
  if (fallbackRate !== null && fallbackRate !== undefined) {
    rates.push(configNumber(fallbackRate, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000));
  }
  return Math.max(...rates);
}

function median(values: any = []): any {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a: any, b: any) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedMedian(values: any = []): any {
  const sorted = values
    .filter((item: any) => Number.isFinite(Number(item.value)) && Number(item.weight) > 0)
    .map((item: any) => ({ value: Number(item.value), weight: Number(item.weight) }))
    .sort((a: any, b: any) => a.value - b.value);
  const total = sorted.reduce((sum: any, item: any) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? null;
}

function matchesDailyBand(date: any, band: any): any {
  const start = minutesOfDay(band.start);
  const end = minutesOfDay(band.end);
  if (start === null || end === null) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function explicitDiscountedBand(config: any, date: any): any {
  return (config.rateBands ?? [])
    .filter((band: any) => Number(band.yenPerKwh) < Number(config.standardRateYenPerKwh))
    .find((band: any) => matchesDailyBand(date, band)) ?? null;
}

function discountedBandOccurrenceForDay(band: any, day: any = new Date()): any {
  const startMinute = minutesOfDay(band?.start);
  const endMinute = minutesOfDay(band?.end);
  if (startMinute === null || endMinute === null) return null;
  const start = new Date(day);
  start.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  const end = new Date(day);
  end.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
  if (startMinute === endMinute || endMinute < startMinute) end.setDate(end.getDate() + 1);
  const key = JSON.stringify([start.toISOString(), end.toISOString(), Number(band.yenPerKwh), band.label ?? null]);
  return { band, start: start.toISOString(), end: end.toISOString(), key };
}

function discountedBandOccurrences(config: any, now: any = new Date(), horizonMs: any = 48 * 60 * 60_000): any {
  const discountedBands = (config.rateBands ?? [])
    .filter((band: any) => Number(band.yenPerKwh) < Number(config.standardRateYenPerKwh));
  const horizonEnd = now.getTime() + horizonMs;
  const occurrences: any[] = [];
  for (let dayOffset = -1; dayOffset <= 3; dayOffset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    for (const band of discountedBands) {
      const occurrence = discountedBandOccurrenceForDay(band, day);
      if (!occurrence) continue;
      const startMs = new Date(occurrence.start).getTime();
      const endMs = new Date(occurrence.end).getTime();
      if (endMs > now.getTime() && startMs <= horizonEnd) occurrences.push(occurrence);
    }
  }
  return occurrences.sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

function discountedBandOccurrence(config: any, now: any = new Date()): any {
  const time = now.getTime();
  return discountedBandOccurrences(config, now)
    .find((occurrence: any) => new Date(occurrence.start).getTime() <= time
      && time < new Date(occurrence.end).getTime()) ?? null;
}

function solarPowerFromIrradiance(irradianceWm2: any, config: any, learnedFactor: any = null): any {
  const irradiance = Math.max(0, Number(irradianceWm2) || 0);
  const adaptiveCharging = config.adaptiveCharging ?? config;
  const peakW = Math.max(0, Number(adaptiveCharging.arrayPeakKw) || 0) * 1000;
  const fallbackFactor = Math.max(0, Number(adaptiveCharging.arrayPeakKw) || 0)
    * (1 - Math.max(0, Number(adaptiveCharging.systemLossPercent) || 0) / 100);
  const factor = Number.isFinite(Number(learnedFactor)) && Number(learnedFactor) > 0
    ? Number(learnedFactor)
    : fallbackFactor;
  return Math.min(peakW, irradiance * factor);
}

function applySolarForecastBias(solarW: any, peakW: any, accuracy: any = {}): any {
  const value = Math.max(0, Number(solarW) || 0);
  const maximum = Math.max(0, Number(peakW) || 0);
  const factor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  return Math.min(maximum, value * factor);
}

function adaptiveChargingBaseAvailability(config: any): any {
  if (config.solarEnabled === false) return { available: false, reason: "solar generation is disabled" };
  if (!config.adaptiveCharging?.enabled) return { available: false, reason: "adaptive charging is disabled" };
  if (config.rateMode === "simple") return { available: false, reason: "Off-Peak or Multi-Rate pricing is required" };
  const coordinates: any[] = [
    [config.adaptiveCharging.latitude, "latitude"],
    [config.adaptiveCharging.longitude, "longitude"],
  ];
  const positive: any[] = [
    [config.adaptiveCharging.arrayPeakKw, "array peak capacity"],
    [config.batteryCapabilities?.usableCapacityKwh, "usable battery capacity"],
    [config.batteryCapabilities?.maximumChargeWatts, "maximum battery charge watts"],
  ];
  const missing = [
    ...coordinates.filter(([value]: any) => !Number.isFinite(Number(value))),
    ...positive.filter(([value]: any) => !Number.isFinite(Number(value)) || Number(value) <= 0),
  ].map(([, label]: any) => label);
  if (missing.length) return { available: false, reason: `missing ${missing.join(", ")}` };
  if (config.smartCosmoEnabled === false) return { available: false, reason: "overall house demand is unavailable" };
  return { available: true, reason: null };
}

function adaptiveChargingAvailability(config: any, rules: any = []): any {
  const base = adaptiveChargingBaseAvailability(config);
  if (!base.available) return base;
  return adaptiveChargingBreakerSettings(rules).valid
    ? base
    : { available: false, reason: "Charging Demand Guard settings are unavailable" };
}

function forecastIsFresh(forecast: any, now: any = new Date()): any {
  const fetchedAt = new Date(forecast?.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= SOLAR_FORECAST_MAX_AGE_MS;
}

function optimizeDiscountedChargeSlots({
  config,
  start,
  end,
  requiredKwh,
  demandBySlot = new Map(),
  slotMinutes = 30,
}: any = {}): any {
  const maximumChargeWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const slots: any[] = [];
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const stepMs = slotMinutes * 60_000;
  for (let time = Math.ceil(startMs / stepMs) * stepMs; time < endMs; time += stepMs) {
    const date = new Date(time);
    const band = explicitDiscountedBand(config, date);
    if (!band) continue;
    const demandW = Number(demandBySlot.get(time) ?? 0);
    slots.push({
      start: date.toISOString(),
      end: new Date(Math.min(time + stepMs, endMs)).toISOString(),
      yenPerKwh: Number(band.yenPerKwh),
      label: band.label || "Discounted",
      demandW,
      capacityKwh: maximumChargeWatts * ((Math.min(time + stepMs, endMs) - time) / 3_600_000) / 1000,
    });
  }
  slots.sort((a: any, b: any) => a.yenPerKwh - b.yenPerKwh || new Date(b.start).getTime() - new Date(a.start).getTime());
  let remaining = Math.max(0, Number(requiredKwh) || 0);
  const selected: any[] = [];
  for (const slot of slots) {
    if (remaining <= 0.0001) break;
    const allocatedKwh = Math.min(slot.capacityKwh, remaining);
    const durationMs = allocatedKwh * 1000 / maximumChargeWatts * 3_600_000;
    selected.push({
      ...slot,
      slotId: `optimized:${slot.end}`,
      start: new Date(new Date(slot.end).getTime() - durationMs).toISOString(),
      targetWh: Math.max(1, Math.round(allocatedKwh * 1000)),
    });
    remaining -= allocatedKwh;
  }
  return {
    slots: selected.sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    plannedChargeKwh: Math.max(0, Number(requiredKwh) || 0) - remaining,
    unmetChargeKwh: Math.max(0, remaining),
  };
}

function discountedTimelineWindows(timeline: any = []): any {
  const windows: any[] = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const slot = timeline[index];
    if (!slot.band) continue;
    const previous = windows.at(-1);
    const hasConfiguredOccurrence = Number.isFinite(Number(slot.rateWindowStartMs))
      && Number.isFinite(Number(slot.rateWindowEndMs));
    const configuredStartMs = hasConfiguredOccurrence
      ? Number(slot.rateWindowStartMs)
      : slot.startMs;
    const configuredEndMs = hasConfiguredOccurrence
      ? Number(slot.rateWindowEndMs)
      : slot.endMs;
    const key = hasConfiguredOccurrence
      ? `${configuredStartMs}-${configuredEndMs}-${slot.band.yenPerKwh}-${slot.band.label ?? ""}`
      : `${slot.band.start}-${slot.band.end}-${slot.band.yenPerKwh}-${slot.band.label ?? ""}`;
    if (previous && previous.key === key && previous.endMs === slot.startMs) {
      previous.endIndex = index + 1;
      previous.endMs = slot.endMs;
      if (!hasConfiguredOccurrence) previous.configuredEndMs = slot.endMs;
      previous.slots.push(slot);
    } else {
      windows.push({
        key,
        startIndex: index,
        endIndex: index + 1,
        startMs: slot.startMs,
        endMs: slot.endMs,
        configuredStartMs,
        configuredEndMs,
        yenPerKwh: Number(slot.band.yenPerKwh),
        label: slot.band.label || "Discounted",
        slots: [slot],
      });
    }
  }
  return windows;
}

function cumulativeRangeNeeds(timeline: any, startIndex: any, endIndex: any, chargeToStoredRatio: any = 1): any {
  let lowCumulative = 0;
  let highCumulative = 0;
  let maximumDeficitKwh = 0;
  let maximumSurplusKwh = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const lowNet = Number(timeline[index]?.netKwh ?? 0);
    const highNet = Number(timeline[index]?.highSolarNetKwh ?? timeline[index]?.netKwh ?? 0);
    lowCumulative += lowNet > 0 ? lowNet * chargeToStoredRatio : lowNet;
    highCumulative += highNet > 0 ? highNet * chargeToStoredRatio : highNet;
    maximumDeficitKwh = Math.max(maximumDeficitKwh, -lowCumulative);
    maximumSurplusKwh = Math.max(maximumSurplusKwh, highCumulative);
  }
  return { maximumDeficitKwh, maximumSurplusKwh };
}

function applyPredictedBatteryFlow(storedKwh: any, netKwh: any, floorKwh: any, capacityKwh: any, chargeToStoredRatio: any = 1): any {
  const net = Number(netKwh || 0);
  const converted = net > 0 ? net * chargeToStoredRatio : net;
  return Math.max(floorKwh, Math.min(capacityKwh, storedKwh + converted));
}

function applyAdaptiveChargingTimelineSlot(
  storedKwh: any,
  slot: any,
  chargeKwh: any,
  floorKwh: any,
  capacityKwh: any,
  chargeToStoredRatio: any = 1,
): any {
  const allocatedChargeKwh = Math.max(0, Number(chargeKwh) || 0);
  const conversion = Math.min(1.5, Math.max(0.5, Number(chargeToStoredRatio) || 1));
  const slotChargeCapacityKwh = Math.max(0, Number(slot?.chargeCapacityKwh) || 0);
  const forcedChargeFraction = slotChargeCapacityKwh > 0
    ? Math.min(1, allocatedChargeKwh / slotChargeCapacityKwh)
    : 0;
  const autoNetKwh = Number(slot?.netKwh || 0) * (1 - forcedChargeFraction);
  const afterAuto = applyPredictedBatteryFlow(storedKwh, autoNetKwh, floorKwh, capacityKwh, conversion);
  return Math.min(capacityKwh, afterAuto + allocatedChargeKwh * conversion);
}

function buildAdaptiveChargingTimelineView({
  timeline = [],
  slots = [],
  initialStoredKwh,
  floorKwh,
  capacityKwh,
  chargeToStoredRatio = 1,
  config,
  standbyWindowEnd = null,
}: any = {}): any {
  let storedKwh = Math.max(floorKwh, Math.min(capacityKwh, Number(initialStoredKwh)));
  const normalizedSlots = slots.map((slot: any) => ({
    ...slot,
    startMs: new Date(slot.start).getTime(),
    endMs: new Date(slot.end).getTime(),
    targetKwh: Math.max(0, Number(slot.targetWh) || 0) / 1000,
  })).filter((slot: any) => Number.isFinite(slot.startMs)
    && Number.isFinite(slot.endMs)
    && slot.endMs > slot.startMs);
  const view: any[] = [];

  for (const interval of timeline) {
    const intervalDurationMs = Math.max(0, interval.endMs - interval.startMs);
    if (!(intervalDurationMs > 0)) continue;
    const intervalSlots = normalizedSlots.filter(
      (slot: any) => slot.startMs < interval.endMs && slot.endMs > interval.startMs,
    );
    const boundaries = [...new Set([
      interval.startMs,
      interval.endMs,
      ...intervalSlots.flatMap((slot: any) => [
        Math.max(interval.startMs, slot.startMs),
        Math.min(interval.endMs, slot.endMs),
      ]),
    ])].sort((left: any, right: any) => left - right);

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const segmentStartMs = boundaries[index];
      const segmentEndMs = boundaries[index + 1];
      const segmentDurationMs = segmentEndMs - segmentStartMs;
      if (!(segmentDurationMs > 0)) continue;
      const intervalFraction = segmentDurationMs / intervalDurationMs;
      const plannedChargeKwh = intervalSlots.reduce((sum: any, slot: any) => {
        const overlapMs = Math.max(
          0,
          Math.min(segmentEndMs, slot.endMs) - Math.max(segmentStartMs, slot.startMs),
        );
        return sum + slot.targetKwh * overlapMs / (slot.endMs - slot.startMs);
      }, 0);
      const segment: Record<string, any> = {
        ...interval,
        startMs: segmentStartMs,
        endMs: segmentEndMs,
        solarKwh: Number(interval.solarKwh || 0) * intervalFraction,
        fuelCellP20Kwh: Number(interval.fuelCellP20Kwh || 0) * intervalFraction,
        fuelCellMedianKwh: Number(interval.fuelCellMedianKwh || 0) * intervalFraction,
        fuelCellP80Kwh: Number(interval.fuelCellP80Kwh || 0) * intervalFraction,
        netKwh: Number(interval.netKwh || 0) * intervalFraction,
        chargeCapacityKwh: Number(interval.chargeCapacityKwh || 0) * intervalFraction,
      };
      const controlled = segmentStartMs < new Date(standbyWindowEnd).getTime()
        || normalizedSlots.some((slot: any) => slot.continuousWindowCharge
          && segmentStartMs >= slot.startMs && segmentStartMs < new Date(slot.windowEnd ?? slot.end).getTime());
      if (controlled) segment.netKwh = 0;
      const startingStoredKwh = storedKwh;
      storedKwh = applyAdaptiveChargingTimelineSlot(
        storedKwh,
        segment,
        plannedChargeKwh,
        floorKwh,
        capacityKwh,
        chargeToStoredRatio,
      );
      const durationHours = segmentDurationMs / 3_600_000;
      const rate = interval.band ?? rateForTimestamp(
        config.rateBands,
        new Date(segmentStartMs),
        config.standardRateYenPerKwh,
      );
      view.push({
        start: new Date(segmentStartMs).toISOString(),
        end: new Date(segmentEndMs).toISOString(),
        solarW: durationHours > 0 ? Number(segment.solarKwh || 0) * 1000 / durationHours : 0,
        fuelCellP20W: durationHours > 0 ? Number(segment.fuelCellP20Kwh || 0) * 1000 / durationHours : 0,
        fuelCellMedianW: durationHours > 0 ? Number(segment.fuelCellMedianKwh || 0) * 1000 / durationHours : 0,
        fuelCellP80W: durationHours > 0 ? Number(segment.fuelCellP80Kwh || 0) * 1000 / durationHours : 0,
        fuelCellSampleCount: interval.fuelCellSampleCount ?? 0,
        demandW: Number(interval.demandW) || 0,
        predictedStartSocPercent: capacityKwh > 0 ? startingStoredKwh / capacityKwh * 100 : null,
        predictedEndSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        predictedSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        discounted: Boolean(interval.band),
        rateLabel: rate?.label ?? null,
        yenPerKwh: finiteNumberOrNull(rate?.yenPerKwh),
        plannedChargeWh: Math.round(plannedChargeKwh * 1000),
        predictedStoredChargeWh: Math.round(plannedChargeKwh * chargeToStoredRatio * 1000),
        away: interval.away === true,
        awayDemandConfidence: interval.awayDemandConfidence ?? null,
      });
    }
  }
  return view;
}

function planChronologicalDiscountedCharging({
  timeline = [],
  currentStoredKwh,
  capacityKwh,
  dischargeFloorKwh,
  maximumTargetPercent = 100,
  maximumChargeWatts,
  chargePowerCurve = [],
  chargeWhPerSocPoint,
  chargeToStoredRatio = 1,
  standbyWindowEnd = null,
}: any = {}): any {
  const chargeConversion = Math.min(1.5, Math.max(0.5, Number(chargeToStoredRatio) || 1));
  const windows = discountedTimelineWindows(timeline);
  const maximumTargetKwh = capacityKwh * Number(maximumTargetPercent) / 100;
  const initialStoredKwh = Math.max(dischargeFloorKwh, Math.min(capacityKwh, Number(currentStoredKwh)));

  const buildPlan = (targetBoosts: any = []) => {
    let storedKwh = initialStoredKwh;
    let cursor = 0;
    const selectedSlots: any[] = [];
    const windowPlans: any[] = [];

    const simulate = (startIndex: any, endIndex: any, chargeByIndex: any = new Map()) => {
      for (let index = startIndex; index < endIndex; index += 1) {
        storedKwh = applyAdaptiveChargingTimelineSlot(
          storedKwh,
          timeline[index],
          chargeByIndex.get(index),
          dischargeFloorKwh,
          capacityKwh,
          chargeConversion,
        );
      }
    };

    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const window = windows[windowIndex];
      simulate(cursor, window.startIndex);
      const storedAtStartKwh = storedKwh;
      let windowSchedulingWatts = maximumChargeWatts;
      const simulateWindow = (chargeByIndex: any = new Map()) => {
        let projectedStoredKwh = storedKwh;
        let chargingStarted = window.startMs < new Date(standbyWindowEnd).getTime();
        for (let index = window.startIndex; index < window.endIndex; index += 1) {
          const allocated = chargeByIndex.get(index) ?? 0;
          // After charging starts, execution charges continuously then holds
          // Standby. Only the time before its start can discharge in Auto.
          const slot = timeline[index];
          projectedStoredKwh = applyAdaptiveChargingTimelineSlot(
            projectedStoredKwh,
            {
              ...slot,
              netKwh: chargingStarted ? 0 : slot.netKwh,
              chargeCapacityKwh: windowSchedulingWatts * (slot.endMs - slot.startMs) / 3_600_000 / 1000,
            },
            allocated,
            dischargeFloorKwh,
            capacityKwh,
            chargeConversion,
          );
          if (allocated > 0) chargingStarted = true;
        }
        return projectedStoredKwh;
      };
      const noGridStoredKwh = simulateWindow();
      const nextWindow = windows[windowIndex + 1] ?? null;
      const boundaryIndex = nextWindow?.startIndex ?? timeline.length;
      const rangeNeeds = cumulativeRangeNeeds(timeline, window.endIndex, boundaryIndex, chargeConversion);
      const solarHeadroomKwh = Math.min(
        Math.max(0, maximumTargetKwh - dischargeFloorKwh),
        rangeNeeds.maximumSurplusKwh,
      );
      const headroomTargetKwh = Math.max(dischargeFloorKwh, maximumTargetKwh - solarHeadroomKwh);
      const cheaperWindowAhead = Boolean(nextWindow && nextWindow.yenPerKwh < window.yenPerKwh);
      const bridgeTargetKwh = Math.min(
        headroomTargetKwh,
        dischargeFloorKwh + rangeNeeds.maximumDeficitKwh,
      );
      const baseTargetStoredKwh = cheaperWindowAhead ? bridgeTargetKwh : headroomTargetKwh;
      const targetStoredKwh = Math.min(
        headroomTargetKwh,
        baseTargetStoredKwh + Math.max(0, Number(targetBoosts[windowIndex]) || 0),
      );
      const requiredChargeWh = Math.max(0, targetStoredKwh - noGridStoredKwh) * 1000 / chargeConversion;
      const windowDurationMs = Math.max(0, window.endMs - window.startMs);
      const timing = chargePowerCurve.length && Number.isFinite(Number(chargeWhPerSocPoint))
        ? adaptiveChargingTimingProfile({
            requiredWh: requiredChargeWh,
            startSocPercent: capacityKwh ? storedAtStartKwh / capacityKwh * 100 : 0,
            whPerSocPoint: chargeWhPerSocPoint,
            powerCurve: chargePowerCurve,
            fallbackWatts: maximumChargeWatts,
            windowDurationMs,
          })
        : {
            modeledDurationMs: requiredChargeWh / maximumChargeWatts * 3_600_000,
            timingReserveMs: 0,
            scheduledDurationMs: requiredChargeWh / maximumChargeWatts * 3_600_000,
            schedulingWatts: maximumChargeWatts,
            unvalidatedTaper: false,
            physicallyDeliverableWh: maximumChargeWatts * windowDurationMs / 3_600_000,
            timeConstrainedWh: 0,
            source: "configured",
          };
      windowSchedulingWatts = timing.schedulingWatts;
      const chargeByIndex = new Map();
      let projectedEndKwh = noGridStoredKwh;
      for (let index = window.endIndex - 1; index >= window.startIndex && projectedEndKwh < targetStoredKwh - 0.0001; index -= 1) {
        const slot = timeline[index];
        const slotDurationHours = Math.max(0, slot.endMs - slot.startMs) / 3_600_000;
        const slotCapacityKwh = Math.max(0, windowSchedulingWatts * slotDurationHours / 1000);
        if (!slotCapacityKwh) continue;
        chargeByIndex.set(index, slotCapacityKwh);
        const fullSlotEndKwh = simulateWindow(chargeByIndex);
        if (fullSlotEndKwh <= projectedEndKwh + 0.0001) {
          chargeByIndex.delete(index);
          continue;
        }
        let allocatedKwh = slotCapacityKwh;
        if (fullSlotEndKwh >= targetStoredKwh - 0.0001) {
          let low = 0;
          let high = slotCapacityKwh;
          for (let iteration = 0; iteration < 24; iteration += 1) {
            const candidate = (low + high) / 2;
            chargeByIndex.set(index, candidate);
            if (simulateWindow(chargeByIndex) >= targetStoredKwh) high = candidate;
            else low = candidate;
          }
          allocatedKwh = high;
          chargeByIndex.set(index, allocatedKwh);
        }
        projectedEndKwh = simulateWindow(chargeByIndex);
      }

      for (const [index, allocatedKwh] of chargeByIndex) {
        const slot = timeline[index];
        const durationMs = allocatedKwh * 1000 / windowSchedulingWatts * 3_600_000;
        selectedSlots.push({
          slotId: `${window.configuredStartMs}:${window.configuredEndMs}:${slot.endMs}`,
          start: new Date(slot.endMs - durationMs).toISOString(),
          end: new Date(slot.endMs).toISOString(),
          yenPerKwh: window.yenPerKwh,
          label: window.label,
          demandW: slot.demandW,
          targetWh: Math.max(1, Math.round(allocatedKwh * 1000)),
          modeledDurationMs: timing.modeledDurationMs,
          timingReserveMs: timing.timingReserveMs,
          schedulingWatts: windowSchedulingWatts,
          schedulingSource: timing.source,
          unvalidatedTaper: timing.unvalidatedTaper,
          targetSocPercent: capacityKwh ? targetStoredKwh / capacityKwh * 100 : maximumTargetPercent,
          windowStart: new Date(window.configuredStartMs).toISOString(),
          windowEnd: new Date(window.configuredEndMs).toISOString(),
        });
      }

      storedKwh = simulateWindow(chargeByIndex);
      const predictedEndStoredKwh = storedKwh;
      const windowUnmetStoredKwh = Math.max(0, targetStoredKwh - predictedEndStoredKwh);
      const windowUnmetChargeKwh = windowUnmetStoredKwh / chargeConversion;
      const plannedWindowChargeKwh = [...chargeByIndex.values()].reduce((sum: any, value: any) => sum + value, 0);
      const selectedWindowSlots = selectedSlots.filter(
        (slot: any) => new Date(slot.windowEnd).getTime() === window.configuredEndMs,
      );
      if (selectedWindowSlots.length) {
        const roundedWindowWh = Math.round(plannedWindowChargeKwh * 1000);
        const roundedSlotWh = selectedWindowSlots.reduce((sum: any, slot: any) => sum + slot.targetWh, 0);
        selectedWindowSlots.at(-1).targetWh += roundedWindowWh - roundedSlotWh;
      }
      const plannedWindowStoredChargeKwh = plannedWindowChargeKwh * chargeConversion;
      const requestedKwh = plannedWindowChargeKwh + windowUnmetChargeKwh;
      const availableChargeKwh = windowSchedulingWatts * windowDurationMs / 3_600_000 / 1000;
      windowPlans.push({
        start: new Date(window.configuredStartMs).toISOString(),
        end: new Date(window.configuredEndMs).toISOString(),
        planningStart: new Date(window.startMs).toISOString(),
        planningEnd: new Date(window.endMs).toISOString(),
        label: window.label,
        yenPerKwh: window.yenPerKwh,
        storedAtStartKwh,
        predictedStartSocPercent: capacityKwh ? storedAtStartKwh / capacityKwh * 100 : null,
        predictedEndStoredKwh,
        predictedEndSocPercent: capacityKwh ? predictedEndStoredKwh / capacityKwh * 100 : null,
        baseTargetStoredKwh,
        maximumTargetStoredKwh: headroomTargetKwh,
        targetStoredKwh,
        targetSocPercent: capacityKwh ? targetStoredKwh / capacityKwh * 100 : null,
        solarHeadroomKwh,
        bridgeToCheaperWindow: cheaperWindowAhead,
        backfillForLaterKwh: Math.max(0, Number(targetBoosts[windowIndex]) || 0),
        requestedChargeKwh: requestedKwh,
        availableChargeKwh,
        plannedChargeKwh: plannedWindowChargeKwh,
        plannedStoredChargeKwh: plannedWindowStoredChargeKwh,
        unmetChargeKwh: windowUnmetChargeKwh,
        unmetStoredChargeKwh: windowUnmetStoredKwh,
        modeledChargeDurationMs: timing.modeledDurationMs,
        timingReserveMs: timing.timingReserveMs,
        schedulingWatts: windowSchedulingWatts,
        schedulingSource: timing.source,
        unvalidatedTaper: timing.unvalidatedTaper,
        timeConstrainedWh: Math.round(timing.timeConstrainedWh),
      });
      cursor = window.endIndex;
    }
    simulate(cursor, timeline.length);
    const plannedChargeKwh = selectedSlots.reduce((sum: any, slot: any) => sum + slot.targetWh / 1000, 0);
    const unmetChargeKwh = windowPlans.reduce((sum: any, window: any) => sum + window.unmetChargeKwh, 0);
    const unmetStoredChargeKwh = windowPlans.reduce(
      (sum: any, window: any) => sum + window.unmetStoredChargeKwh,
      0,
    );
    return {
      slots: mergeAdaptiveChargingSlots(selectedSlots),
      windows: windowPlans,
      plannedChargeKwh,
      plannedStoredChargeKwh: plannedChargeKwh * chargeConversion,
      requiredGridChargeKwh: plannedChargeKwh + unmetChargeKwh,
      unmetChargeKwh,
      unmetStoredChargeKwh,
      timeConstrainedWh: windowPlans.reduce((sum: any, window: any) => sum + Number(window.timeConstrainedWh || 0), 0),
      expectedEndStoredKwh: storedKwh,
    };
  };

  const targetBoosts = windows.map(() => 0);
  let plan = buildPlan(targetBoosts);
  const maxBackfillIterations = Math.max(1, windows.length * windows.length * 4);
  for (let iteration = 0; iteration < maxBackfillIterations; iteration += 1) {
    const constrainedIndex = plan.windows.findIndex(
      (window: any, index: any) => index > 0 && window.unmetStoredChargeKwh > 0.0001,
    );
    if (constrainedIndex < 0) break;
    const constrained = plan.windows[constrainedIndex];
    const candidates = plan.windows
      .map((window: any, index: any) => ({ window, index }))
      .filter(({ window, index }: any) => index < constrainedIndex
        && window.maximumTargetStoredKwh - window.targetStoredKwh > 0.0001)
      .sort((left: any, right: any) => left.window.yenPerKwh - right.window.yenPerKwh || right.index - left.index);
    let improved = false;
    for (const candidate of candidates) {
      const roomKwh = candidate.window.maximumTargetStoredKwh - candidate.window.targetStoredKwh;
      const addedKwh = Math.min(constrained.unmetStoredChargeKwh, roomKwh);
      if (addedKwh <= 0.0001) continue;
      const previousBoost = targetBoosts[candidate.index];
      targetBoosts[candidate.index] += addedKwh;
      const trial = buildPlan(targetBoosts);
      if (trial.unmetChargeKwh < plan.unmetChargeKwh - 0.0001) {
        plan = trial;
        improved = true;
        break;
      }
      targetBoosts[candidate.index] = previousBoost;
    }
    if (!improved) break;
  }
  return plan;
}

function discountedPlanStatus(plan: any = {}): any {
  const unmetChargeKwh = Math.max(0, Number(plan.unmetChargeKwh) || 0);
  if (unmetChargeKwh <= 0.0001) return { available: true, reason: null, warning: null };
  const plannedChargeKwh = Math.max(0, Number(plan.plannedChargeKwh) || 0);
  if (plannedChargeKwh <= 0.0001) {
    return {
      available: false,
      reason: "no discounted charging capacity remains before the planned targets",
      warning: null,
    };
  }
  const requestedChargeKwh = Number.isFinite(Number(plan.requiredGridChargeKwh))
    ? Number(plan.requiredGridChargeKwh)
    : plannedChargeKwh + unmetChargeKwh;
  return {
    available: true,
    reason: null,
    warning: `Plan schedules ${plannedChargeKwh.toFixed(2)} kWh of ${requestedChargeKwh.toFixed(2)} kWh requested; a ${unmetChargeKwh.toFixed(2)} kWh shortfall remains after using feasible discounted capacity`,
  };
}

function localDayKey(date: any): any {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function halfHourIndex(date: any): any {
  const d = date instanceof Date ? date : new Date(date);
  return d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
}

function awayPeriodContains(period: any, timeMs: any): any {
  const startMs = new Date(period?.from).getTime();
  const untilMs = new Date(period?.until).getTime();
  return Number.isFinite(startMs) && Number.isFinite(untilMs) && timeMs >= startMs && timeMs < untilMs;
}

function awayPeriodForecastContains(period: any, timeMs: any): any {
  const startMs = new Date(period?.from).getTime();
  const untilMs = new Date(period?.until).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs) return false;
  const returnBufferMs = Math.min(AWAY_RETURN_BUFFER_MS, (untilMs - startMs) / 4);
  return timeMs >= startMs && timeMs < untilMs - returnBufferMs;
}

function isAwayAt(timeMs: any, periods: any = [], { forecast = false }: any = {}): any {
  const contains = forecast ? awayPeriodForecastContains : awayPeriodContains;
  return periods.some((period: any) => contains(period, timeMs));
}

function demandDayBucketMidpoint(day: any, bucket: any): any {
  return new Date(
    day.date.getFullYear(),
    day.date.getMonth(),
    day.date.getDate(),
    Math.floor(bucket / 2),
    bucket % 2 ? 45 : 15,
  ).getTime();
}

function filterDemandDaysByOccupancy(days: any, awayPeriods: any = [], occupancy: any = "home"): any {
  if (occupancy === "all") return days;
  return days.map((day: any) => {
    const values = new Map([...day.values].filter(([bucket]: any) => {
      const away = isAwayAt(demandDayBucketMidpoint(day, bucket), awayPeriods);
      return occupancy === "away" ? away : !away;
    }));
    const sourceCoverage = day.coverageByBucket instanceof Map
      ? day.coverageByBucket
      : new Map([...day.values.keys()].map((bucket: any) => [bucket, 1800]));
    const coverageByBucket = new Map(
      [...sourceCoverage].filter(([bucket]: any) => values.has(bucket)),
    );
    return {
      ...day,
      ...demandDayCoverage(coverageByBucket),
      coverageByBucket,
      values,
    };
  }).filter((day: any) => day.values.size > 0);
}

function aggregateDemandDays(samples: any, { awayPeriods = [], occupancy = "all" }: any = {}): any {
  const days = new Map();
  for (const sample of samples) {
    const demand = Number(sample.intervalAveragePowerW?.houseDemandW ?? sample.houseDemandW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) continue;
    const away = isAwayAt(time.getTime(), awayPeriods);
    if ((occupancy === "away" && !away) || (occupancy === "home" && away)) continue;
    const key = localDayKey(time);
    if (!days.has(key)) days.set(key, { key, date: new Date(time.getFullYear(), time.getMonth(), time.getDate()), buckets: new Map() });
    const day = days.get(key);
    const index = halfHourIndex(time);
    const seconds = Math.min(1800, Math.max(0,
      Number(sample.powerCoverageSeconds?.houseDemandW
        ?? sample.coverageSeconds?.houseDemandKwh
        ?? sample.expectedIntervalSeconds
        ?? 0),
    ));
    if (seconds <= 0) continue;
    const bucket = day.buckets.get(index) ?? { weightedSum: 0, coverageSeconds: 0 };
    bucket.weightedSum += demand * seconds;
    bucket.coverageSeconds = Math.min(1800, bucket.coverageSeconds + seconds);
    day.buckets.set(index, bucket);
  }
  return [...days.values()].map((day: any) => {
    const coverageByBucket = new Map(
      [...day.buckets].map(([index, bucket]: any) => [index, bucket.coverageSeconds]),
    );
    return {
      ...day,
      ...demandDayCoverage(coverageByBucket),
      coverageByBucket,
      values: new Map([...day.buckets].map(
        ([index, bucket]: any) => [index, bucket.weightedSum / bucket.coverageSeconds],
      )),
    };
  }).filter((day: any) => day.values.size > 0);
}

function percentile(values: any, fraction: any): any {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a: any, b: any) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function monthDistance(left: any, right: any): any {
  const raw = Math.abs(left.getMonth() - right.getMonth());
  return Math.min(raw, 12 - raw);
}

function buildFuelCellGenerationModel(config: any, samples: any = [], now: any = new Date(), options: any = {}): any {
  const method = "observed";
  const requestedInfluence = config.fuelCell?.includeInAdaptiveCharging ? "active" : "observe";
  const temperatureByDay = options.temperatureByDay instanceof Map ? options.temperatureByDay : new Map();
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const powerSamples = samples.map((sample: any) => ({
    date: new Date(sample.timestamp),
    watts: finiteNumberOrNull(sample.fuelCellPowerW),
    state: sample.fuelCellGenerationState ?? null,
  })).filter((sample: any) => !Number.isNaN(sample.date.getTime()) && sample.watts !== null);
  const days = new Map();
  for (const sample of powerSamples) {
    const key = localDayKey(sample.date);
    const day = days.get(key) ?? {
      key,
      date: new Date(sample.date.getFullYear(), sample.date.getMonth(), sample.date.getDate()),
      buckets: new Map(),
    };
    const bucketIndex = halfHourIndex(sample.date);
    const bucket = day.buckets.get(bucketIndex) ?? { sum: 0, count: 0, states: new Map() };
    bucket.sum += Math.max(0, sample.watts);
    bucket.count += 1;
    if (sample.state) bucket.states.set(sample.state, Number(bucket.states.get(sample.state) ?? 0) + 1);
    day.buckets.set(bucketIndex, bucket);
    if (sample.watts > 25 || sample.state === "generating") day.generating = true;
    days.set(key, day);
  }
  const dailyBuckets = [...days.values()].map((day: any) => ({
    ...day,
    temperatureC: finiteNumberOrNull(temperatureByDay.get(day.key)),
    away: isAwayAt(new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), 12).getTime(), awayPeriods),
    values: new Map([...day.buckets].map(([index, bucket]: any) => [index, {
      watts: bucket.sum / bucket.count,
      state: [...bucket.states].sort((left: any, right: any) => right[1] - left[1])[0]?.[0] ?? null,
    }])),
  }));
  const validDays = dailyBuckets.filter((day: any) => day.buckets.size >= 16);
  const currentDayType = now.getDay() === 0 || now.getDay() === 6;
  const currentAway = isAwayAt(now.getTime(), awayPeriods, { forecast: true });
  const currentTemperature = finiteNumberOrNull(temperatureByDay.get(localDayKey(now)));
  const comparableDays = validDays.filter((day: any) => {
    const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
    const temperatureMatches = currentTemperature === null || day.temperatureC === null || Math.abs(day.temperatureC - currentTemperature) <= 6;
    return weekend === currentDayType && day.away === currentAway && monthDistance(day.date, now) <= 2 && temperatureMatches;
  });
  const blockers: any[] = [];
  if (validDays.length < 7) blockers.push(`${7 - validDays.length} more valid observation days required`);
  if (comparableDays.length < 4) blockers.push(`${4 - comparableDays.length} more comparable observation days required`);
  const ready = blockers.length === 0;
  const influencesPlanner = requestedInfluence === "active" && ready;
  const latest = powerSamples.at(-1) ?? null;

  const forecastAt = (date: any) => {
    const bucket = halfHourIndex(date);
    const targetWeekend = date.getDay() === 0 || date.getDay() === 6;
    const targetAway = isAwayAt(date.getTime(), awayPeriods, { forecast: true });
    const targetTemperature = finiteNumberOrNull(temperatureByDay.get(localDayKey(date)));
    let candidates = dailyBuckets.filter((day: any) => day.values.has(bucket));
    const comparable = candidates.filter((day: any) => {
      const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
      const temperatureMatches = targetTemperature === null || day.temperatureC === null || Math.abs(day.temperatureC - targetTemperature) <= 6;
      return weekend === targetWeekend && day.away === targetAway && monthDistance(day.date, date) <= 2 && temperatureMatches;
    });
    if (comparable.length >= 4) candidates = comparable;
    if (latest?.state && Math.abs(date.getTime() - now.getTime()) <= 2 * 60 * 60_000) {
      const sameRecentState = candidates.filter((day: any) => day.values.get(bucket)?.state === latest.state);
      if (sameRecentState.length >= 4) candidates = sameRecentState;
    }
    const values = candidates.map((day: any) => day.values.get(bucket)?.watts).filter(Number.isFinite);
    return {
      p20W: percentile(values, 0.2) ?? 0,
      medianW: percentile(values, 0.5) ?? 0,
      p80W: percentile(values, 0.8) ?? 0,
      sampleCount: values.length,
    };
  };
  return {
    method,
    requestedInfluence,
    influence: influencesPlanner ? "active" : "observe",
    ready,
    blockers,
    validObservationDays: validDays.length,
    comparableDays: comparableDays.length,
    recentState: latest?.state ?? null,
    forecastAt,
  };
}

function batteryLearningRollupInterval(sample: any): any {
  const startMs = new Date(sample?.rollupStart ?? sample?.timestamp).getTime();
  const endMs = new Date(sample?.rollupEnd ?? sample?.timestamp).getTime();
  const startSoc = Number(sample?.startStateOfChargePercent ?? sample?.stateOfChargePercent);
  const endSoc = Number(sample?.endStateOfChargePercent ?? sample?.stateOfChargePercent);
  const chargeWh = Math.max(0, Number(sample?.batteryChargeKwh) || 0) * 1000;
  const dischargeWh = Math.max(0, Number(sample?.batteryDischargeKwh) || 0) * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (!Number.isFinite(startSoc) || !Number.isFinite(endSoc)) return null;
  const mixed = chargeWh >= 10 && dischargeWh >= 10;
  const direction = mixed ? null : chargeWh >= 10 ? "charge" : dischargeWh >= 10 ? "discharge" : null;
  if (!direction) return null;
  const energyWh = direction === "charge" ? chargeWh : dischargeWh;
  const coveredSeconds = Number(sample?.coverageSeconds?.[
    direction === "charge" ? "batteryChargeKwh" : "batteryDischargeKwh"
  ]);
  const durationSeconds = (endMs - startMs) / 1000;
  return {
    startMs,
    endMs,
    startSoc,
    endSoc,
    direction,
    energyWh,
    coverageSeconds: Number.isFinite(coveredSeconds) ? coveredSeconds : durationSeconds,
    durationSeconds,
    mixed,
    manualAction: sample?.manualAction === true,
  };
}

function extractBatteryLearningObservations(samples: any = []): any {
  const intervals = samples
    .map(batteryLearningRollupInterval)
    .filter(Boolean)
    .sort((left: any, right: any) => left.startMs - right.startMs);
  const observations: any[] = [];
  let current: any = null;
  const flush = () => {
    if (!current) return;
    const socDelta = current.direction === "charge"
      ? current.endSoc - current.startSoc
      : current.startSoc - current.endSoc;
    const coverageRatio = current.durationSeconds > 0
      ? Math.min(1, current.coverageSeconds / current.durationSeconds)
      : 0;
    const reasons: any[] = [];
    if (current.reversed) reasons.push("SOC direction reversed");
    if (current.manualAction) reasons.push("manual action during observation");
    if (socDelta < 20) reasons.push("SOC change below 20 points");
    if (current.energyWh < 500) reasons.push("energy below 500 Wh");
    if (coverageRatio < 0.9) reasons.push("telemetry coverage below 90%");
    if (current.direction === "charge" && current.endSoc > 98) reasons.push("charge reached censored upper SOC");
    const eligible = reasons.length === 0;
    observations.push({
      id: `${current.direction}:${new Date(current.startMs).toISOString()}:${new Date(current.endMs).toISOString()}`,
      kind: current.direction,
      start: new Date(current.startMs).toISOString(),
      end: new Date(current.endMs).toISOString(),
      energyWh: current.energyWh,
      startSocPercent: current.startSoc,
      endSocPercent: current.endSoc,
      socDeltaPercent: socDelta,
      coverageRatio,
      eligible,
      rejectionReason: reasons.join("; ") || null,
      whPerSocPoint: eligible ? current.energyWh / socDelta : null,
    });
    current = null;
  };
  for (const interval of intervals) {
    if (interval.direction === "charge" && interval.endSoc > 98 && current) flush();
    const contiguous = current
      && current.direction === interval.direction
      && interval.startMs - current.endMs <= 35 * 60_000;
    if (!contiguous) {
      flush();
      current = {
        direction: interval.direction,
        startMs: interval.startMs,
        endMs: interval.endMs,
        startSoc: interval.startSoc,
        endSoc: interval.endSoc,
        energyWh: interval.energyWh,
        coverageSeconds: interval.coverageSeconds,
        durationSeconds: interval.durationSeconds,
        manualAction: interval.manualAction,
        reversed: interval.direction === "charge"
          ? interval.endSoc < interval.startSoc
          : interval.endSoc > interval.startSoc,
      };
      continue;
    }
    const intervalDelta = interval.direction === "charge"
      ? interval.endSoc - interval.startSoc
      : interval.startSoc - interval.endSoc;
    const boundaryReversed = interval.direction === "charge"
      ? interval.startSoc < current.endSoc
      : interval.startSoc > current.endSoc;
    current.endMs = interval.endMs;
    current.endSoc = interval.endSoc;
    current.energyWh += interval.energyWh;
    current.coverageSeconds += interval.coverageSeconds;
    current.durationSeconds += interval.durationSeconds;
    current.manualAction ||= interval.manualAction;
    if (intervalDelta < 0 || boundaryReversed) current.reversed = true;
  }
  flush();
  return observations;
}

function batteryLearningValidation(observations: any, migrationAt: any): any {
  const migrationMs = new Date(migrationAt).getTime();
  const validations: any[] = [];
  const sorted = observations.filter((item: any) => item.eligible).sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime());
  for (let index = 0; index < sorted.length; index += 1) {
    const observation = sorted[index];
    if (new Date(observation.start).getTime() < migrationMs) continue;
    const priorValues = sorted.slice(0, index).map((item: any) => item.whPerSocPoint).filter(Number.isFinite);
    if (priorValues.length < BATTERY_LEARNING_MIN_OBSERVATIONS) continue;
    const coefficient = median(priorValues);
    const predictedSocDelta = observation.energyWh / coefficient;
    validations.push({
      id: observation.id,
      predictedSocDelta,
      actualSocDelta: observation.socDeltaPercent,
      errorSoc: predictedSocDelta - observation.socDeltaPercent,
    });
  }
  const errors = validations.map((item: any) => item.errorSoc);
  return {
    count: validations.length,
    meanAbsoluteErrorSoc: errors.length
      ? errors.reduce((sum: any, value: any) => sum + Math.abs(value), 0) / errors.length
      : null,
    biasSoc: errors.length ? errors.reduce((sum: any, value: any) => sum + value, 0) / errors.length : null,
    maximumErrorSoc: errors.length ? Math.max(...errors.map(Math.abs)) : null,
    outcomes: validations.slice(-20),
  };
}

function batteryLearningCoefficient(kind: any, observations: any, configuredWhPerSocPoint: any, previous: any = {}, migrationAt: any, now: any = new Date()): any {
  const matching = observations.filter((item: any) => item.kind === kind);
  const structurallyComplete = matching.filter((item: any) => item.energyWh >= 500 && item.socDeltaPercent >= 20);
  const eligible = structurallyComplete.filter((item: any) => item.eligible && Number.isFinite(item.whPerSocPoint));
  const values = eligible.map((item: any) => item.whPerSocPoint);
  const candidate = median(values);
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const dispersionPercent = Number.isFinite(candidate) && candidate > 0 && Number.isFinite(q1) && Number.isFinite(q3)
    ? (q3 - q1) / candidate * 100
    : null;
  const recentMedian = median(values.slice(-5));
  const priorMedian = median(values.slice(-10, -5));
  const stabilityPercent = Number.isFinite(recentMedian) && Number.isFinite(priorMedian) && priorMedian > 0
    ? Math.abs(recentMedian - priorMedian) / priorMedian * 100
    : null;
  const distinctDays = new Set(eligible.map((item: any) => localDayKey(new Date(item.start)))).size;
  const totalSocPoints = eligible.reduce((sum: any, item: any) => sum + item.socDeltaPercent, 0);
  const acceptancePercent = structurallyComplete.length ? eligible.length / structurallyComplete.length * 100 : 0;
  const validation = batteryLearningValidation(matching, migrationAt);
  const blockers: any[] = [];
  if (eligible.length < BATTERY_LEARNING_MIN_OBSERVATIONS) blockers.push(`${BATTERY_LEARNING_MIN_OBSERVATIONS - eligible.length} more eligible observations required`);
  if (distinctDays < BATTERY_LEARNING_MIN_DAYS) blockers.push(`${BATTERY_LEARNING_MIN_DAYS - distinctDays} more distinct days required`);
  if (totalSocPoints < BATTERY_LEARNING_MIN_SOC_POINTS) blockers.push(`${Math.ceil(BATTERY_LEARNING_MIN_SOC_POINTS - totalSocPoints)} more SOC points required`);
  const dispersionLimit = kind === "charge" ? 7 : 10;
  if (Number.isFinite(dispersionPercent) && Number(dispersionPercent) > dispersionLimit) blockers.push(`dispersion ${Number(dispersionPercent).toFixed(1)}% exceeds ${dispersionLimit}%`);
  const stabilityLimit = kind === "charge" ? 3 : 5;
  if (!Number.isFinite(stabilityPercent) || Number(stabilityPercent) > stabilityLimit) blockers.push(`rolling stability must be within ${stabilityLimit}%`);
  if (kind === "discharge" && acceptancePercent < 60) blockers.push(`valid observation acceptance ${acceptancePercent.toFixed(0)}% is below 60%`);
  if (validation.count < BATTERY_LEARNING_MIN_VALIDATIONS) blockers.push(`${BATTERY_LEARNING_MIN_VALIDATIONS - validation.count} more forward validations required`);
  if (Number.isFinite(validation.meanAbsoluteErrorSoc) && validation.meanAbsoluteErrorSoc > BATTERY_LEARNING_MAX_MAE_SOC) blockers.push("validation mean error exceeds 3 SOC points");
  if (Number.isFinite(validation.biasSoc) && Math.abs(validation.biasSoc) > BATTERY_LEARNING_MAX_BIAS_SOC) blockers.push("validation bias exceeds 2 SOC points");
  if (Number.isFinite(validation.maximumErrorSoc) && validation.maximumErrorSoc > BATTERY_LEARNING_MAX_ERROR_SOC) blockers.push("validation maximum error exceeds 6 SOC points");

  const previousSource = previous.source === "learned" ? "learned" : "configured";
  const previouslySeenValidationIds = new Set([
    ...(previous.validation?.seenIds ?? []),
    ...(previous.validation?.outcomes ?? []).map((outcome: any) => outcome.id),
  ].filter(Boolean));
  const newValidationOutcomes = validation.outcomes.filter(
    (outcome: any) => outcome.id && !previouslySeenValidationIds.has(outcome.id),
  );
  validation.seenIds = [...previouslySeenValidationIds, ...newValidationOutcomes.map((outcome: any) => outcome.id)]
    .slice(-500);
  const aggregateValidationFailed = validation.count >= BATTERY_LEARNING_MIN_VALIDATIONS && (
    validation.meanAbsoluteErrorSoc > BATTERY_LEARNING_MAX_MAE_SOC
    || Math.abs(validation.biasSoc) > BATTERY_LEARNING_MAX_BIAS_SOC
    || validation.maximumErrorSoc > BATTERY_LEARNING_MAX_ERROR_SOC
  );
  let failureStreak = Number(previous.failureStreak) || 0;
  if (previousSource === "learned" && newValidationOutcomes.length) {
    for (const outcome of newValidationOutcomes) {
      const failed = aggregateValidationFailed
        || Math.abs(Number(outcome.errorSoc)) > BATTERY_LEARNING_MAX_ERROR_SOC;
      failureStreak = failed ? failureStreak + 1 : 0;
    }
  }
  const materialDrift = previousSource === "learned" && (
    Number(dispersionPercent) > dispersionLimit * 2
    || Number(stabilityPercent) > stabilityLimit * 2
  );
  const demoted = previousSource === "learned"
    && (failureStreak >= BATTERY_LEARNING_DEMOTION_FAILURES || materialDrift);
  const activate = previousSource !== "learned" && blockers.length === 0 && Number.isFinite(candidate);
  const source = demoted ? "configured" : previousSource === "learned" || activate ? "learned" : "configured";
  const active = source === "learned"
    ? blockers.length === 0 && Number.isFinite(candidate)
      ? candidate
      : finiteNumberOrNull(previous.activeWhPerSocPoint) ?? candidate
    : configuredWhPerSocPoint;
  if (activate) failureStreak = 0;
  const demotionReason = materialDrift
    ? "material observation distribution drift"
    : "three consecutive forward-validation failures";
  return cleanBatteryLearningCoefficient({
    source,
    configuredWhPerSocPoint,
    candidateWhPerSocPoint: candidate,
    activeWhPerSocPoint: active,
    observationCount: structurallyComplete.length,
    acceptedObservationCount: eligible.length,
    distinctDays,
    totalSocPoints,
    dispersionPercent,
    stabilityPercent,
    acceptancePercent,
    validation,
    blockers,
    activatedAt: activate ? now.toISOString() : previous.activatedAt,
    activationSnapshot: activate ? {
      candidateWhPerSocPoint: candidate,
      observationCount: eligible.length,
      distinctDays,
      totalSocPoints,
      dispersionPercent,
      stabilityPercent,
      validation,
    } : previous.activationSnapshot,
    demotedAt: demoted ? now.toISOString() : previous.demotedAt,
    demotionReason: demoted ? demotionReason : previous.demotionReason,
    failureStreak,
    lastValidationCount: validation.count,
  });
}

function batteryLearningPower(performance: any, configuredWatts: any, previous: any = {}, migrationAt: any, now: any = new Date()): any {
  const samples = [...(performance?.samples ?? [])].sort((left: any, right: any) => new Date(left.at).getTime() - new Date(right.at).getTime());
  const positiveValues = samples
    .map((item: any) => Number(item.batteryChargingW))
    .filter((watts: any) => Number.isFinite(watts) && watts > 0);
  const highWaterWatts = percentile(positiveValues, 0.9);
  const steadySamples = samples.filter((item: any) => {
    const watts = Number(item.batteryChargingW);
    return Number.isFinite(watts)
      && Number.isFinite(highWaterWatts)
      && watts >= highWaterWatts * 0.95;
  });
  const steadyValues = steadySamples.map((item: any) => Number(item.batteryChargingW)).sort((a: any, b: any) => a - b);
  const candidate = median(steadyValues);
  const q1 = percentile(steadyValues, 0.25);
  const q3 = percentile(steadyValues, 0.75);
  const dispersionPercent = Number.isFinite(candidate) && candidate > 0 && Number.isFinite(q1) && Number.isFinite(q3)
    ? (q3 - q1) / candidate * 100
    : null;
  let sessionCount = 0;
  let previousMs: any = null;
  const migrationMs = new Date(migrationAt).getTime();
  const postMigrationSamples = steadySamples.filter((sample: any) => new Date(sample.at).getTime() >= migrationMs);
  for (const sample of postMigrationSamples) {
    const time = new Date(sample.at).getTime();
    if (previousMs === null || time - previousMs > 2 * 60_000) sessionCount += 1;
    previousMs = time;
  }
  const distinctDays = new Set(postMigrationSamples.map((item: any) => localDayKey(new Date(item.at)))).size;
  const blockers: any[] = [];
  if (postMigrationSamples.length < 120) blockers.push(`${120 - postMigrationSamples.length} more post-migration steady samples required`);
  if (sessionCount < 3) blockers.push(`${3 - sessionCount} more charging sessions required`);
  if (distinctDays < 2) blockers.push(`${2 - distinctDays} more distinct days required`);
  if (!Number.isFinite(dispersionPercent) || Number(dispersionPercent) > 3) blockers.push("charge-power dispersion must be within 3%");
  const protectiveReduction = Number.isFinite(candidate) && candidate <= configuredWatts * 0.95;
  const qualified = blockers.length === 0;
  const enoughCurrentEvidence = postMigrationSamples.length >= 120 && sessionCount >= 3 && distinctDays >= 2;
  const materialDrift = enoughCurrentEvidence && Number(dispersionPercent) > 3;
  const reductionNoLongerNeeded = enoughCurrentEvidence
    && Number.isFinite(candidate)
    && !protectiveReduction
    && !materialDrift;
  const demoted = previous.source === "learned" && (materialDrift || reductionNoLongerNeeded);
  const source = demoted
    ? "configured"
    : (qualified && protectiveReduction) || previous.source === "learned"
      ? "learned"
      : "configured";
  const activeWatts = source === "learned"
    ? qualified && protectiveReduction
      ? Math.min(configuredWatts, candidate)
      : finiteNumberOrNull(previous.activeWatts) ?? configuredWatts
    : configuredWatts;
  return cleanBatteryLearningPower({
    source,
    configuredWatts,
    candidateWatts: candidate,
    activeWatts,
    sampleCount: steadySamples.length,
    postMigrationSampleCount: postMigrationSamples.length,
    sessionCount,
    distinctDays,
    dispersionPercent,
    blockers,
    activatedAt: source === "learned" && previous.source !== "learned" ? now.toISOString() : previous.activatedAt,
    activationSnapshot: source === "learned" && previous.source !== "learned" ? {
      candidateWatts: candidate,
      sampleCount: steadySamples.length,
      postMigrationSampleCount: postMigrationSamples.length,
      sessionCount,
      distinctDays,
      dispersionPercent,
    } : previous.activationSnapshot,
    demotedAt: demoted ? now.toISOString() : previous.demotedAt,
    demotionReason: demoted
      ? materialDrift
        ? "material charge-power distribution drift"
        : "measured charge power returned to configured range"
      : previous.demotionReason,
  });
}

function buildBatteryChargePowerCurve(samples: any = [], configuredWatts: any, plateauModel: any = {}, previousCurve: any = []): any {
  const normalized = samples.filter((sample: any) => Number.isFinite(Number(sample.socPercent))
    && Number(sample.socPercent) >= 0
    && Number(sample.socPercent) <= 100
    && Number.isFinite(Number(sample.batteryChargingW))
    && Number(sample.batteryChargingW) > 0);
  let previousCandidate = Number(plateauModel.candidateWatts ?? plateauModel.activeWatts ?? configuredWatts);
  let previousActive = Number(plateauModel.activeWatts ?? configuredWatts);
  return BATTERY_CHARGE_CURVE_BANDS.map((definition: any, index: any) => {
    if (index === 0) {
      return {
        ...definition,
        source: plateauModel.source === "learned" ? "learned" : "configured",
        configuredWatts,
        candidateWatts: finiteNumberOrNull(plateauModel.candidateWatts),
        activeWatts: Math.min(configuredWatts, previousActive),
        sampleCount: plateauModel.sampleCount ?? 0,
        sessionCount: plateauModel.sessionCount ?? 0,
        distinctDays: plateauModel.distinctDays ?? 0,
        dispersionPercent: finiteNumberOrNull(plateauModel.dispersionPercent),
        blockers: plateauModel.blockers ?? [],
      };
    }
    const bandSamples = normalized.filter((sample: any) => Number(sample.socPercent) >= definition.minSoc
      && (Number(sample.socPercent) < definition.maxSoc || definition.maxSoc === 100));
    const values = bandSamples.map((sample: any) => Number(sample.batteryChargingW)).sort((a: any, b: any) => a - b);
    const medianWatts = median(values);
    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const rawCandidate = Number.isFinite(q1) ? Math.min(configuredWatts, q1) : null;
    const candidateWatts = Number.isFinite(rawCandidate)
      ? Math.min(previousCandidate, Number(rawCandidate))
      : null;
    if (Number.isFinite(candidateWatts)) previousCandidate = Number(candidateWatts);
    const sessionCount = new Set(bandSamples.map((sample: any) => sample.sessionId).filter(Boolean)).size;
    const distinctDays = new Set(bandSamples.map((sample: any) => sample.day ?? localDayKey(new Date(sample.at)))).size;
    const dispersionPercent = Number.isFinite(medianWatts) && medianWatts > 0
      && Number.isFinite(q1) && Number.isFinite(q3)
      ? (q3 - q1) / medianWatts * 100
      : null;
    const blockers: any[] = [];
    if (values.length < BATTERY_CURVE_MIN_SAMPLES) {
      blockers.push(`${BATTERY_CURVE_MIN_SAMPLES - values.length} more samples required`);
    }
    if (sessionCount < BATTERY_CURVE_MIN_SESSIONS) {
      blockers.push(`${BATTERY_CURVE_MIN_SESSIONS - sessionCount} more charging sessions required`);
    }
    if (distinctDays < BATTERY_CURVE_MIN_DAYS) {
      blockers.push(`${BATTERY_CURVE_MIN_DAYS - distinctDays} more distinct days required`);
    }
    if (!Number.isFinite(dispersionPercent) || Number(dispersionPercent) > BATTERY_CURVE_MAX_DISPERSION_PERCENT) {
      blockers.push(`charge-power dispersion must be within ${BATTERY_CURVE_MAX_DISPERSION_PERCENT}%`);
    }
    const previousBand = previousCurve.find((band: any) => Number(band.minSoc) === definition.minSoc
      && Number(band.maxSoc) === definition.maxSoc);
    const qualified = blockers.length === 0 && Number.isFinite(candidateWatts);
    const source = qualified || previousBand?.source === "learned" ? "learned" : "configured";
    const learnedActive = qualified ? candidateWatts : finiteNumberOrNull(previousBand?.activeWatts);
    const activeWatts = source === "learned" && Number.isFinite(learnedActive)
      ? Math.min(previousActive, learnedActive)
      : configuredWatts;
    previousActive = Math.min(previousActive, activeWatts);
    return {
      ...definition,
      source,
      configuredWatts,
      candidateWatts,
      activeWatts: previousActive,
      sampleCount: values.length,
      sessionCount,
      distinctDays,
      dispersionPercent,
      blockers,
    };
  });
}

function buildBatteryLearningModel(config: any, rollups: any = [], previous: any = {}, now: any = new Date(), { curveSamples = [] }: any = {}): any {
  const configuredCapacityKwh = Number(config.batteryCapabilities?.usableCapacityKwh);
  const configuredWhPerSocPoint = configuredCapacityKwh * 1000 / 100;
  const configuredWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const migrationAt = previous.migratedAt ?? now.toISOString();
  const observations = extractBatteryLearningObservations(rollups);
  const charge = batteryLearningCoefficient("charge", observations, configuredWhPerSocPoint, previous.charge, migrationAt, now);
  const discharge = batteryLearningCoefficient("discharge", observations, configuredWhPerSocPoint, previous.discharge, migrationAt, now);
  const power = batteryLearningPower(previous.performance ?? {}, configuredWatts, previous.power, migrationAt, now);
  power.curve = buildBatteryChargePowerCurve(
    curveSamples,
    configuredWatts,
    power,
    previous.power?.curve ?? [],
  );
  const sources: any[] = [charge.source, discharge.source, power.source];
  const anyDegraded = [charge, discharge, power]
    .some((model: any) => model.source !== "learned" && model.demotedAt);
  const status = anyDegraded
    ? "degraded"
    : sources.some((source: any) => source === "learned")
      ? "active"
      : charge.validation.count || discharge.validation.count
        ? "validating"
        : "learning";
  return cleanBatteryLearningModel({
    ...previous,
    version: BATTERY_LEARNING_MODEL_VERSION,
    migratedAt: migrationAt,
    status,
    charge,
    discharge,
    power,
    lastEvaluatedAt: now.toISOString(),
  });
}

function effectiveAdaptiveChargeWatts(config: any, state: any = {}): any {
  const configuredWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const model = state.batteryLearning?.power;
  const learned = model?.source === "learned" && Number.isFinite(Number(model.activeWatts));
  const learnedWatts = Number(model?.candidateWatts ?? state.chargingPerformance?.learnedChargeWatts);
  return {
    configuredWatts,
    learnedWatts: Number.isFinite(learnedWatts) ? learnedWatts : null,
    effectiveWatts: learned ? Math.min(configuredWatts, Number(model.activeWatts)) : configuredWatts,
    learned,
    source: learned ? "learned" : "configured",
    curve: (model?.curve?.length ? model.curve : BATTERY_CHARGE_CURVE_BANDS.map((band: any) => ({
      ...band,
      source: "configured",
      configuredWatts,
      candidateWatts: null,
      activeWatts: configuredWatts,
      sampleCount: 0,
      sessionCount: 0,
      distinctDays: 0,
      dispersionPercent: null,
      blockers: band.minSoc >= 80 ? ["charge-power curve is not yet validated"] : [],
    }))).map((band: any) => ({ ...band })),
  };
}

function effectiveBatteryLearningModel(config: any, state: any = {}): any {
  const configuredWhPerSocPoint = Number(config.batteryCapabilities?.usableCapacityKwh) * 1000 / 100;
  const coefficient = (key: any) => {
    const value = state.batteryLearning?.[key];
    const learned = value?.source === "learned" && Number.isFinite(Number(value.activeWhPerSocPoint));
    return {
      source: learned ? "learned" : "configured",
      whPerSocPoint: learned ? Number(value.activeWhPerSocPoint) : configuredWhPerSocPoint,
      candidateWhPerSocPoint: finiteNumberOrNull(value?.candidateWhPerSocPoint),
    };
  };
  const charge = coefficient("charge");
  const discharge = coefficient("discharge");
  const power = effectiveAdaptiveChargeWatts(config, state);
  return {
    version: BATTERY_LEARNING_MODEL_VERSION,
    charge,
    discharge,
    power,
    capacityKwh: discharge.whPerSocPoint * 100 / 1000,
    chargeToStoredRatio: discharge.whPerSocPoint / charge.whPerSocPoint,
  };
}

function chargePowerCurveBand(curve: any = [], socPercent: any = 0): any {
  const soc = Math.max(0, Math.min(100, Number(socPercent) || 0));
  return curve.find((band: any) => soc >= Number(band.minSoc)
    && (soc < Number(band.maxSoc) || Number(band.maxSoc) === 100)) ?? curve.at(-1) ?? null;
}

function estimateChargeDurationMs({
  targetWh,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
}: any = {}): any {
  let remainingWh = Math.max(0, Number(targetWh) || 0);
  let soc = Math.max(0, Math.min(100, Number(startSocPercent) || 0));
  const whPerPoint = Math.max(0.001, Number(whPerSocPoint) || 0);
  let durationMs = 0;
  let guard = 0;
  while (remainingWh > 0.001 && guard < 20) {
    guard += 1;
    const band = chargePowerCurveBand(powerCurve, soc);
    const watts = Math.max(1, Number(band?.activeWatts ?? fallbackWatts) || 0);
    const maxSoc = Math.max(soc, Number(band?.maxSoc ?? 100));
    const bandWh = Math.max(0, (maxSoc - soc) * whPerPoint);
    const consumedWh = bandWh > 0 ? Math.min(remainingWh, bandWh) : remainingWh;
    durationMs += consumedWh / watts * 3_600_000;
    remainingWh -= consumedWh;
    soc = maxSoc < 100 ? maxSoc + 0.000001 : 100;
  }
  return durationMs;
}

function estimateDeliverableChargeWh({
  durationMs,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
}: any = {}): any {
  let remainingMs = Math.max(0, Number(durationMs) || 0);
  let soc = Math.max(0, Math.min(100, Number(startSocPercent) || 0));
  const whPerPoint = Math.max(0.001, Number(whPerSocPoint) || 0);
  let deliveredWh = 0;
  let guard = 0;
  while (remainingMs > 0.1 && guard < 20) {
    guard += 1;
    const band = chargePowerCurveBand(powerCurve, soc);
    const watts = Math.max(1, Number(band?.activeWatts ?? fallbackWatts) || 0);
    const maxSoc = Math.max(soc, Number(band?.maxSoc ?? 100));
    const bandWh = Math.max(0, (maxSoc - soc) * whPerPoint);
    const bandDurationMs = bandWh > 0 ? bandWh / watts * 3_600_000 : remainingMs;
    const usedMs = Math.min(remainingMs, bandDurationMs);
    const addedWh = watts * usedMs / 3_600_000;
    deliveredWh += addedWh;
    remainingMs -= usedMs;
    soc += addedWh / whPerPoint;
    if (soc >= 100) break;
    if (usedMs >= bandDurationMs - 0.1) soc = maxSoc + 0.000001;
  }
  return deliveredWh;
}

function adaptiveChargingTimingProfile({
  requiredWh,
  startSocPercent,
  whPerSocPoint,
  powerCurve = [],
  fallbackWatts,
  windowDurationMs,
}: any = {}): any {
  const targetWh = Math.max(0, Number(requiredWh) || 0);
  const modeledDurationMs = estimateChargeDurationMs({
    targetWh,
    startSocPercent,
    whPerSocPoint,
    powerCurve,
    fallbackWatts,
  });
  const endSocPercent = Math.min(100, Number(startSocPercent) + targetWh / Math.max(0.001, whPerSocPoint));
  const unvalidatedTaper = powerCurve.some((band: any) => Number(band.minSoc) >= 80
    && band.source !== "learned"
    && Number(startSocPercent) < Number(band.maxSoc)
    && endSocPercent > Number(band.minSoc));
  const timingReserveMs = Math.min(
    ADAPTIVE_CHARGING_TIMING_RESERVE_MAX_MS,
    Math.max(ADAPTIVE_CHARGING_TIMING_RESERVE_MIN_MS, modeledDurationMs * ADAPTIVE_CHARGING_TIMING_RESERVE_FRACTION),
  );
  const scheduledDurationMs = Math.min(
    Math.max(0, Number(windowDurationMs) || 0),
    unvalidatedTaper ? Number(windowDurationMs) : modeledDurationMs + timingReserveMs,
  );
  const physicallyDeliverableWh = estimateDeliverableChargeWh({
    durationMs: windowDurationMs,
    startSocPercent,
    whPerSocPoint,
    powerCurve,
    fallbackWatts,
  });
  const schedulableWh = Math.min(targetWh, physicallyDeliverableWh);
  const schedulingWatts = scheduledDurationMs > 0
    ? Math.min(Number(fallbackWatts), schedulableWh / scheduledDurationMs * 3_600_000)
    : Number(fallbackWatts);
  return {
    modeledDurationMs,
    timingReserveMs,
    scheduledDurationMs,
    schedulingWatts: Math.max(1, schedulingWatts || Number(fallbackWatts)),
    unvalidatedTaper,
    physicallyDeliverableWh,
    timeConstrainedWh: Math.max(0, targetWh - physicallyDeliverableWh),
    source: unvalidatedTaper ? "conservative-fallback" : "soc-curve",
  };
}

function calendarDayDistance(left: any, right: any): any {
  const normalizedLeft = new Date(2000, left.getMonth(), left.getDate());
  const normalizedRight = new Date(2000, right.getMonth(), right.getDate());
  const distance = Math.abs(normalizedLeft.getTime() - normalizedRight.getTime()) / 86_400_000;
  return Math.min(distance, 366 - distance);
}

function selectSeasonalDemandDays(validDays: any, target: any, targetIsWeekend: any, targetTemperature: any, temperatureByDay: any): any {
  const byYear = new Map();
  for (const day of validDays) {
    const yearsAgo = target.getFullYear() - day.date.getFullYear();
    if (yearsAgo < 1 || yearsAgo > ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS) continue;
    const calendarDistance = calendarDayDistance(day.date, target);
    if (calendarDistance > ADAPTIVE_CHARGING_SEASONAL_DAY_RANGE) continue;
    const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
    const temperature = Number(temperatureByDay.get(day.key));
    const hasTemperatureMatch = Number.isFinite(targetTemperature) && Number.isFinite(temperature);
    const temperatureDistance = hasTemperatureMatch ? Math.abs(targetTemperature - temperature) : 0;
    const candidate: Record<string, any> = {
      ...day,
      yearsAgo,
      sameDayType,
      calendarDistance,
      temperatureDistance,
      score: calendarDistance * 2 + temperatureDistance * 2 + yearsAgo * 2 + (sameDayType ? 0 : 14),
      weight: (sameDayType ? 1 : 0.35)
        / (1 + calendarDistance / 7 + temperatureDistance + yearsAgo / 2),
    };
    const candidates = byYear.get(day.date.getFullYear()) ?? [];
    candidates.push(candidate);
    byYear.set(day.date.getFullYear(), candidates);
  }
  return [...byYear.values()]
    .flatMap((days: any) => days.sort((a: any, b: any) => a.score - b.score).slice(0, ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR))
    .sort((a: any, b: any) => a.score - b.score);
}

function predictHouseDemand(samples: any, targetDate: any = new Date(), temperatureByDay: any = new Map(), options: any = {}): any {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const occupancy = options.occupancy ?? "home";
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const historicalDays = filterDemandDaysByOccupancy(
    Array.isArray(options.historicalDays) ? options.historicalDays : [],
    awayPeriods,
    occupancy,
  );
  const recordedDayMap = new Map<string, any>(historicalDays.map((day: any) => [day.key, day] as [string, any]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy })) {
    const existing = recordedDayMap.get(day.key);
    if (!existing || day.coverage >= existing.coverage) recordedDayMap.set(day.key, day);
  }
  const recordedDays: any[] = [...recordedDayMap.values()];
  const validDays = recordedDays.filter((day: any) => day.daytimeCoverage >= 0.8);
  const recentCandidates = validDays
    .map((day: any) => {
      const ageDays = (target.getTime() - day.date.getTime()) / 86_400_000;
      const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
      const temperature = Number(temperatureByDay.get(day.key));
      const temperatureDistance = Number.isFinite(targetTemperature) && Number.isFinite(temperature)
        ? Math.abs(targetTemperature - temperature)
        : 5;
      const dayTypePenalty = sameDayType ? 0 : 14;
      const baseWeight = 1 / (1 + ageDays / 14 + temperatureDistance);
      return {
        ...day,
        ageDays,
        sameDayType,
        score: dayTypePenalty + temperatureDistance * 2 + ageDays / 14,
        weight: baseWeight * (sameDayType ? 1 : 0.35),
      };
    })
    .filter((day: any) => day.ageDays > 0 && day.ageDays <= 42)
    .sort((a: any, b: any) => a.score - b.score)
    .slice(0, 8);
  const seasonalCandidates = selectSeasonalDemandDays(
    validDays,
    target,
    targetIsWeekend,
    targetTemperature,
    temperatureByDay,
  );
  const seasonalYears = [...new Set(seasonalCandidates.map((day: any) => day.date.getFullYear()))]
    .sort((a: any, b: any) => b - a);
  // Let recurring seasonal behavior inform the forecast without allowing an
  // older household pattern to outweigh the most recent six weeks.
  const seasonalBlendWeight = Math.min(0.3, seasonalYears.length * 0.1);
  const profile = new Map();
  const lowProfile = new Map();
  for (let index = 0; index < 48; index += 1) {
    const recentValue = weightedMedian(recentCandidates
      .filter((day: any) => day.values.has(index))
      .map((day: any) => ({ value: day.values.get(index), weight: day.weight })));
    const seasonalValue = weightedMedian(seasonalCandidates
      .filter((day: any) => day.values.has(index))
      .map((day: any) => ({ value: day.values.get(index), weight: day.weight })));
    const value = Number.isFinite(recentValue) && Number.isFinite(seasonalValue)
      ? recentValue * (1 - seasonalBlendWeight) + seasonalValue * seasonalBlendWeight
      : recentValue;
    if (Number.isFinite(value)) profile.set(index, value);
    const lowValue = percentile(
      recordedDays.filter((day: any) => day.values.has(index)).map((day: any) => day.values.get(index)),
      0.2,
    );
    if (Number.isFinite(lowValue)) lowProfile.set(index, lowValue);
  }
  return {
    available: validDays.length >= 7 && recentCandidates.length >= 4 && profile.size >= 39,
    reason: validDays.length < 7
      ? `house-demand history has ${validDays.length} of ${recordedDays.length} days with at least 80% daytime coverage; 7 are required`
      : recentCandidates.length < 4
      ? `only ${recentCandidates.length} usable demand days were found in the previous six weeks; 4 are required`
      : profile.size < 39
        ? "house-demand history coverage is below 80%"
        : null,
    comparableDays: [...recentCandidates, ...seasonalCandidates].map((day: any) => day.key),
    recentComparableDays: recentCandidates.map((day: any) => day.key),
    seasonalComparableDays: seasonalCandidates.map((day: any) => day.key),
    seasonalYears,
    seasonalBlendWeight,
    sameDayTypeDays: [...recentCandidates, ...seasonalCandidates]
      .filter((day: any) => day.sameDayType)
      .map((day: any) => day.key),
    usedDayTypeFallback: [...recentCandidates, ...seasonalCandidates].some((day: any) => !day.sameDayType),
    recordedDayCount: recordedDays.length,
    validDayCount: validDays.length,
    profile,
    lowProfile,
  };
}

function predictAwayDemand(samples: any, targetDate: any, temperatureByDay: any, options: any = {}): any {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const historicalDays = filterDemandDaysByOccupancy(
    Array.isArray(options.historicalDays) ? options.historicalDays : [],
    awayPeriods,
    "away",
  );
  const recordedDayMap = new Map(historicalDays.map((day: any) => [day.key, day]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy: "away" })) {
    recordedDayMap.set(day.key, day);
  }
  const candidates = [...recordedDayMap.values()].map((day: any) => {
    const ageDays = (target.getTime() - day.date.getTime()) / 86_400_000;
    const sameDayType = [0, 6].includes(day.date.getDay()) === targetIsWeekend;
    const temperature = Number(temperatureByDay.get(day.key));
    const temperatureDistance = Number.isFinite(targetTemperature) && Number.isFinite(temperature)
      ? Math.abs(targetTemperature - temperature)
      : 5;
    const calendarDistance = calendarDayDistance(day.date, target);
    return {
      ...day,
      ageDays,
      sameDayType,
      score: calendarDistance + temperatureDistance * 2 + ageDays / 90 + (sameDayType ? 0 : 10),
      weight: (sameDayType ? 1 : 0.4) / (1 + calendarDistance / 14 + temperatureDistance + ageDays / 365),
    };
  }).filter((day: any) => day.ageDays > 0 && day.ageDays <= ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS * 366)
    .sort((a: any, b: any) => a.score - b.score)
    .slice(0, 24);
  const normalPrediction = options.normalPrediction ?? { profile: new Map(), lowProfile: new Map() };
  const profile = new Map();
  const learnedBuckets = new Set();
  const fallbackBuckets = new Set();
  for (let index = 0; index < 48; index += 1) {
    const values = candidates
      .filter((day: any) => day.values.has(index))
      .map((day: any) => ({ value: day.values.get(index), weight: day.weight }));
    const learned = values.length >= AWAY_LEARNED_MIN_DAYS ? weightedMedian(values) : null;
    if (Number.isFinite(learned)) {
      profile.set(index, learned);
      learnedBuckets.add(index);
      continue;
    }
    const normalValue = Number(normalPrediction.profile?.get(index));
    const lowValue = Number(normalPrediction.lowProfile?.get(index));
    const fallback = Number.isFinite(lowValue)
      ? Math.min(lowValue, Number.isFinite(normalValue) ? normalValue : lowValue)
      : Number.isFinite(normalValue)
        ? normalValue * 0.35
        : null;
    if (Number.isFinite(fallback)) {
      profile.set(index, Math.max(0, Number(fallback)));
      fallbackBuckets.add(index);
    }
  }
  return {
    profile,
    learnedBuckets,
    fallbackBuckets,
    comparableDays: candidates.map((day: any) => day.key),
    recordedDayCount: recordedDayMap.size,
  };
}

function parseOpenMeteoForecast(data: any, fetchedAt: any = new Date()): any {
  const hourly = data?.hourly ?? {};
  const hours = (hourly.time ?? []).map((time: any, index: any) => ({
    time,
    timestamp: new Date(time).toISOString(),
    shortwaveRadiationWm2: Number(hourly.shortwave_radiation?.[index]) || 0,
    tiltedIrradianceWm2: Number(hourly.global_tilted_irradiance?.[index]) || 0,
    cloudCoverPercent: Number(hourly.cloud_cover?.[index]),
    temperatureC: Number(hourly.temperature_2m?.[index]),
  }));
  const daily = data?.daily ?? {};
  const days = (daily.time ?? []).map((date: any, index: any) => ({
    date,
    sunrise: daily.sunrise?.[index] ?? null,
    sunset: daily.sunset?.[index] ?? null,
  }));
  return {
    fetchedAt: (fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt)).toISOString(),
    timezone: data?.timezone ?? null,
    utcOffsetSeconds: data?.utc_offset_seconds ?? null,
    latitude: data?.latitude ?? null,
    longitude: data?.longitude ?? null,
    hours,
    days,
  };
}

function temperatureByDayFromWeather(hours: any = []): any {
  const grouped = new Map();
  for (const hour of hours) {
    const value = Number(hour.temperatureC);
    if (!Number.isFinite(value)) continue;
    const key = String(hour.time ?? hour.timestamp).slice(0, 10);
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]: any) => [key, values.reduce((sum: any, value: any) => sum + value, 0) / values.length]));
}

function solarCalibrationGroup(date: any): any {
  const d = date instanceof Date ? date : new Date(date);
  const season = Math.floor(d.getMonth() / 3);
  const solarHour = d.getHours() < 10 ? "morning" : d.getHours() < 14 ? "midday" : "afternoon";
  return `${season}:${solarHour}`;
}

function learnedSolarFactor(samples: any, historicalWeather: any, config: any): any {
  const weatherByHour = new Map<number, any>((historicalWeather ?? []).map((hour: any) => [
    Math.floor(new Date(hour.timestamp ?? hour.time).getTime() / 3_600_000),
    hour,
  ] as [number, any]));
  const daily = new Map<string, any>();
  for (const sample of samples) {
    const solarW = Number(sample.solarPowerW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(solarW) || Number.isNaN(time.getTime())) continue;
    const weather = weatherByHour.get(Math.floor(time.getTime() / 3_600_000) + 1);
    const irradiance = Number(weather?.tiltedIrradianceWm2);
    if (!Number.isFinite(irradiance) || irradiance < 50) continue;
    const key = localDayKey(time);
    const row = daily.get(key) ?? { factors: [], groups: new Map() };
    row.factors.push(solarW / irradiance);
    const group = solarCalibrationGroup(time);
    const grouped = row.groups.get(group) ?? [];
    grouped.push(solarW / irradiance);
    row.groups.set(group, grouped);
    daily.set(key, row);
  }
  const factors = [...daily.values()].map((day: any) => median(day.factors)).filter(Number.isFinite);
  const fallback = Number(config.adaptiveCharging.arrayPeakKw) * (1 - Number(config.adaptiveCharging.systemLossPercent) / 100);
  const learned = factors.length >= 7;
  const groupNames = new Set([...daily.values()].flatMap((day: any) => [...day.groups.keys()]));
  const groupFactors: Record<string, any> = {};
  for (const group of groupNames) {
    const values = [...daily.values()].map((day: any) => median(day.groups.get(group) ?? [])).filter(Number.isFinite);
    if (learned && values.length >= 4) groupFactors[group] = median(values.slice(-30));
  }
  return {
    factor: learned ? median(factors.slice(-30)) : fallback,
    groupFactors,
    validDays: factors.length,
    learned,
  };
}

function localDayRange(dayKey: any): any {
  const start = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function dailySolarForecastIssues(forecast: any, config: any, calibration: any, accuracy: any = {}): any {
  const issuedAt = forecast?.fetchedAt;
  if (!issuedAt || Number.isNaN(new Date(issuedAt).getTime())) return [];
  const biasFactor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  const marginPercent = Math.max(0, Number(config.adaptiveCharging?.forecastMarginPercent) || 0);
  const marginFactor = Math.max(0, 1 - marginPercent / 100);
  const peakW = Math.max(0, Number(config.adaptiveCharging?.arrayPeakKw) || 0) * 1000;
  const targetDates = new Set([
    ...(forecast.days ?? []).map((day: any) => day.date),
    ...(forecast.hours ?? []).map((hour: any) => localDayKey(hour.timestamp ?? hour.time)),
  ].filter(Boolean));
  const issues: any[] = [];
  for (const targetDate of [...targetDates].sort()) {
    const range = localDayRange(targetDate);
    if (!range) continue;
    let rawPredictedKwh = 0;
    let predictedKwh = 0;
    for (const hour of forecast.hours ?? []) {
      const timestamp = new Date(hour.timestamp ?? hour.time);
      if (Number.isNaN(timestamp.getTime()) || localDayKey(timestamp) !== targetDate) continue;
      const factor = calibration.groupFactors?.[solarCalibrationGroup(timestamp)] ?? calibration.factor;
      const rawW = solarPowerFromIrradiance(hour.tiltedIrradianceWm2, config, factor);
      rawPredictedKwh += rawW / 1000;
      predictedKwh += applySolarForecastBias(rawW, peakW, {
        learned: accuracy.learned,
        factor: biasFactor,
      }) / 1000;
    }
    issues.push({
      targetDate,
      issuedAt,
      periodStart: range.start.toISOString(),
      periodEnd: range.end.toISOString(),
      rawPredictedKwh,
      biasFactor,
      predictedKwh,
      planningKwh: predictedKwh * marginFactor,
      marginPercent,
      calibration: {
        learned: calibration.learned,
        validDays: calibration.validDays,
        factor: calibration.factor,
      },
    });
  }
  return issues;
}

function forecastHourForInterval(forecast: any, start: any, end: any): any {
  const midpoint = (new Date(start).getTime() + new Date(end).getTime()) / 2;
  const target = Math.ceil(midpoint / 3_600_000) * 3_600_000;
  return (forecast?.hours ?? []).reduce((best: any, hour: any) => {
    const distance = Math.abs(new Date(hour.timestamp).getTime() - target);
    return !best || distance < best.distance ? { hour, distance } : best;
  }, null)?.hour ?? null;
}

function nextPlanningBoundary(time: any, end: any, intervalMinutes: any = 30): any {
  const current = new Date(time);
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(endMs)) return Number.NaN;
  const next = new Date(current);
  next.setSeconds(0, 0);
  const elapsedInHour = next.getMinutes();
  const nextMinute = (Math.floor(elapsedInHour / intervalMinutes) + 1) * intervalMinutes;
  if (nextMinute >= 60) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  } else {
    next.setMinutes(nextMinute, 0, 0);
  }
  return Math.min(endMs, next.getTime());
}

function planningSunsetWithDiscountedWindow(config: any, forecast: any, now: any = new Date()): any {
  const startMs = now.getTime();
  return (forecast?.days ?? [])
    .map((day: any) => ({ ...day, timestamp: new Date(day.sunset).getTime() }))
    .filter((day: any) => Number.isFinite(day.timestamp) && day.timestamp > startMs)
    .sort((a: any, b: any) => a.timestamp - b.timestamp)
    .find((day: any) => {
      for (let time = startMs; time < day.timestamp;) {
        if (explicitDiscountedBand(config, new Date(time))) return true;
        time = nextPlanningBoundary(time, day.timestamp);
      }
      return false;
    }) ?? null;
}

function buildAdaptiveChargingPlan({
  config,
  state,
  samples,
  historicalDemandDays = [],
  awayPeriods = [],
  now = new Date(),
}: any = {}): any {
  const unavailable = (reason: any) => ({
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
  const sunset = planningSunsetWithDiscountedWindow(config, state.forecast, now);
  if (!sunset) return unavailable("no discounted window is available before the forecast horizon ends");
  const temperatures = temperatureByDayFromWeather([...(state.historicalWeather ?? []), ...(state.forecast.hours ?? [])]);
  const latestSocSample = samples.findLast((sample: any) => Number.isFinite(Number(sample.stateOfChargePercent)));
  const soc = Number(latestSocSample?.stateOfChargePercent);
  if (!Number.isFinite(soc)) return unavailable("battery state of charge is unavailable");
  const batteryModel = effectiveBatteryLearningModel(config, state);
  const capacityKwh = Number(batteryModel.capacityKwh);
  const cachedDischargeLimit = config.settingCache?.discharge_limit;
  const dischargeLimit = Number(cachedDischargeLimit?.lastKnown?.decoded?.percent);
  const dischargeLimitReadAt = new Date(cachedDischargeLimit?.lastReadAt).getTime();
  if (!Number.isFinite(dischargeLimit)) return unavailable("battery discharge limit is unavailable");
  if (!Number.isFinite(dischargeLimitReadAt) || now.getTime() - dischargeLimitReadAt > 24 * 60 * 60_000) {
    return unavailable("battery discharge limit has not been read successfully in the last 24 hours");
  }
  const initialStoredKwh = capacityKwh * soc / 100;
  const dischargeFloorKwh = capacityKwh * Math.max(0, dischargeLimit) / 100;
  const calibration = learnedSolarFactor(samples, state.historicalWeather, config);
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
  const demandByDay = new Map();
  const fuelCellModel = buildFuelCellGenerationModel(config, samples, now, {
    temperatureByDay: temperatures,
    awayPeriods,
  });
  const timeline: any[] = [];
  let predictedSolarKwh = 0;
  let forecastSolarKwh = 0;
  let predictedDemandKwh = 0;
  let predictedSurplusKwh = 0;
  let predictedFuelCellKwh = 0;
  let awaySlotCount = 0;
  let awayLearnedSlotCount = 0;
  let awayFallbackSlotCount = 0;
  const awayComparableDays = new Set();
  for (let time = startMs; time < sunset.timestamp;) {
    const date = new Date(time);
    const dayKey = localDayKey(date);
    if (!demandByDay.has(dayKey)) {
      const home = predictHouseDemand(samples, date, temperatures, {
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
    const demand = demandByDay.get(dayKey);
    const slotEndMs = nextPlanningBoundary(time, sunset.timestamp);
    const hour = forecastHourForInterval(state.forecast, time, slotEndMs);
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
    const fuelCellPlanningKwh = fuelCellModel.influence === "active"
      ? fuelCellForecast.p20W * durationHours / 1000
      : 0;
    const highFuelCellKwh = fuelCellModel.influence === "active"
      ? fuelCellForecast.p80W * durationHours / 1000
      : 0;
    const medianFuelCellKwh = fuelCellForecast.medianW * durationHours / 1000;
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
      fuelCellMedianKwh: medianFuelCellKwh,
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
  const demandPredictions = [...demandByDay.values()].map((prediction: any) => prediction.home);
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
    standbyWindowEnd,
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
    expectedSunsetSocPercent: capacityKwh ? Math.min(100, optimized.expectedEndStoredKwh / capacityKwh * 100) : null,
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
    comparableDemandDays: [...new Set(demandPredictions.flatMap((prediction: any) => prediction.comparableDays))],
    demandHistory: {
      recordedDayCount: Math.max(...demandPredictions.map((prediction: any) => prediction.recordedDayCount)),
      validDayCount: Math.max(...demandPredictions.map((prediction: any) => prediction.validDayCount)),
      sameDayTypeDayCount: Math.max(...demandPredictions.map((prediction: any) => prediction.sameDayTypeDays.length)),
      usedDayTypeFallback: demandPredictions.some((prediction: any) => prediction.usedDayTypeFallback),
      recentComparableDayCount: Math.max(...demandPredictions.map((prediction: any) => prediction.recentComparableDays.length)),
      seasonalComparableDayCount: Math.max(...demandPredictions.map((prediction: any) => prediction.seasonalComparableDays.length)),
      seasonalYears: [...new Set(demandPredictions.flatMap((prediction: any) => prediction.seasonalYears))]
        .sort((a: any, b: any) => b - a),
      seasonalBlendPercent: Math.round(Math.max(
        ...demandPredictions.map((prediction: any) => prediction.seasonalBlendWeight * 100),
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

function sampleFromStatus(status: any, config: any, previousSample: any = null): any {
  // Convert the large live status payload into one compact time-series sample.
  // We store only normalized values that graphs and savings calculations need.
  const timestamp = status.read_at ?? new Date().toISOString();
  const previousTimestamp = previousSample?.timestamp ?? null;
  const elapsedSeconds = previousTimestamp
    ? Math.max(0, (new Date(timestamp).getTime() - new Date(previousTimestamp).getTime()) / 1000)
    : 0;
  const batteryPowerW = numericMetric(status.energy?.battery?.instant_power);
  const solarPowerW = config.solarEnabled === false ? null : numericMetric(status.energy?.solar?.instant_power);
  const fuelCells = config.fuelCellEnabled === false ? [] : (status.energy?.fuel_cells ?? []);
  const fuelCellReading = selectedFuelCellReading(fuelCells);
  const fuelCellPrimary = primaryFuelCell(fuelCells);
  const fuelCellPowerW = numericMetric(fuelCellReading?.instant_power);
  const fuelCellGenerationState = fuelCellReading?.generation_status?.value ?? null;
  const fuelCellRatedPowerW = numericMetric(fuelCellPrimary?.rated_power);
  const fuelCellCumulativeGenerationKwh = numericMetric(fuelCellPrimary?.cumulative_generation);
  const fuelCellCumulativeGasM3 = numericMetric(fuelCellPrimary?.cumulative_gas);
  const fuelCellHotWaterLevel = numericMetric(fuelCellPrimary?.hot_water_level);
  const counterSourceHost = fuelCellCumulativeGenerationKwh !== null || fuelCellCumulativeGasM3 !== null
    ? fuelCellPrimary?.host ?? null
    : null;
  const sameCounterSource = counterSourceHost && counterSourceHost === previousSample?.fuelCellCounterSourceHost;
  const electricityCounter = sameCounterSource
    ? cumulativeCounterDeltaResult(
      fuelCellCumulativeGenerationKwh,
      previousSample?.fuelCellCumulativeGenerationKwh,
      COUNTER_POLICIES.fuelCellElectricity,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const gasCounter = sameCounterSource
    ? cumulativeCounterDeltaResult(
      fuelCellCumulativeGasM3,
      previousSample?.fuelCellCumulativeGasM3,
      COUNTER_POLICIES.fuelCellGas,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const fuelCellKwh = electricityCounter.delta;
  const fuelCellGasM3 = gasCounter.delta;
  const fuelCellInterconnection = fuelCellPrimary?.interconnection_status?.value ?? null;
  const houseDemandW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.house_demand_power);
  const gridImportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_import_power);
  const gridExportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_export_power);
  const gridImportCumulativeKwh = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.cumulative_bought);
  const gridExportCumulativeKwh = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.cumulative_sold);
  const meterCounterSourceHost = gridImportCumulativeKwh !== null || gridExportCumulativeKwh !== null
    ? config.meterHost
    : null;
  const sameMeterCounterSource = meterCounterSourceHost
    && meterCounterSourceHost === previousSample?.meterCounterSourceHost;
  const gridImportCounter = sameMeterCounterSource
    ? cumulativeCounterDeltaResult(
      gridImportCumulativeKwh,
      previousSample?.gridImportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const gridExportCounter = sameMeterCounterSource
    ? cumulativeCounterDeltaResult(
      gridExportCumulativeKwh,
      previousSample?.gridExportCumulativeKwh,
      COUNTER_POLICIES.grid,
      elapsedSeconds,
    )
    : { delta: null, issue: null };
  const stateOfChargePercent = numericMetric(status.energy?.battery?.remaining_percent);
  const circuitPowerW = config.smartCosmoEnabled === false
    ? {}
    : circuitChannelMap(status.meter?.channel_power?.decoded?.channels);
  const circuitCumulativeKwh = config.smartCosmoEnabled === false
    ? {}
    : circuitCumulativeMap(status.meter?.channel_energy?.decoded?.channels);
  const circuitEnergyKwh: Record<string, any> = {};
  const circuitCounterIssues: any[] = [];
  for (const id of Object.keys({ ...circuitPowerW, ...circuitCumulativeKwh })) {
    const result = cumulativeCounterDeltaResult(
      circuitCumulativeKwh[id],
      previousSample?.circuitCumulativeKwh?.[id],
      COUNTER_POLICIES.circuit,
      elapsedSeconds,
    );
    if (result.delta !== null) circuitEnergyKwh[id] = result.delta;
    if (result.issue) circuitCounterIssues.push({ channel: Number(id), issue: result.issue });
  }
  const rateBand = rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh);
  const activeRate = rateBand.yenPerKwh;
  const highestRate = maxDailyRate(config.rateBands, config.standardRateYenPerKwh);
  const maximumGapSeconds = Math.max(90, Number(config.updateIntervalSeconds) * 2.5);
  const intervalSeconds = elapsedSeconds <= maximumGapSeconds ? elapsedSeconds : 0;
  const fuelCellOperatingSeconds = ["generating", "starting", "stopping", "idling"].includes(previousSample?.fuelCellGenerationState)
    ? intervalSeconds
    : 0;
  const fuelCellStartCount = fuelCellGenerationState === "generating" && previousSample?.fuelCellGenerationState !== "generating" ? 1 : 0;
  const exactCircuitValues = Object.values(circuitEnergyKwh).filter(Number.isFinite);
  const exactHouseDemandKwh = exactCircuitValues.length > 0
    && exactCircuitValues.length === Object.values(circuitCumulativeKwh).filter(Number.isFinite).length
    ? exactCircuitValues.reduce((sum: any, value: any) => sum + value, 0)
    : null;
  const coverageSeconds: Record<string, any> = {};
  const energyQuality: Record<string, any> = {};
  const energyIntervalStart: Record<string, any> = {};
  if (gridImportCounter.delta !== null) {
    coverageSeconds.gridImportKwh = intervalSeconds;
    energyQuality.gridImportKwh = "counter";
    if (previousTimestamp) energyIntervalStart.gridImportKwh = previousTimestamp;
  }
  if (gridExportCounter.delta !== null) {
    coverageSeconds.gridExportKwh = intervalSeconds;
    energyQuality.gridExportKwh = "counter";
    if (previousTimestamp) energyIntervalStart.gridExportKwh = previousTimestamp;
  }
  if (exactHouseDemandKwh !== null) {
    coverageSeconds.houseDemandKwh = intervalSeconds;
    energyQuality.houseDemandKwh = "counter";
    if (previousTimestamp) energyIntervalStart.houseDemandKwh = previousTimestamp;
  }
  if (fuelCellKwh !== null) {
    coverageSeconds.fuelCellKwh = intervalSeconds;
    energyQuality.fuelCellKwh = "counter";
    if (previousTimestamp) energyIntervalStart.fuelCellKwh = previousTimestamp;
  }
  for (const id of Object.keys(circuitEnergyKwh)) {
    const key = `circuit:${id}`;
    coverageSeconds[key] = intervalSeconds;
    energyQuality[key] = "counter";
    if (previousTimestamp) energyIntervalStart[key] = previousTimestamp;
  }
  return {
    timestamp,
    batteryPowerW,
    stateOfChargePercent,
    solarPowerW,
    houseDemandW,
    fuelCellPowerW,
    fuelCellRatedPowerW,
    ...(fuelCellKwh !== null ? { fuelCellKwh } : {}),
    ...(fuelCellGasM3 !== null ? { fuelCellGasM3 } : {}),
    fuelCellCumulativeGenerationKwh,
    fuelCellCumulativeGasM3,
    fuelCellGenerationState,
    fuelCellHotWaterLevel,
    fuelCellInterconnection,
    fuelCellSourceHost: fuelCellReading?.host ?? null,
    fuelCellCounterSourceHost: counterSourceHost,
    fuelCellDataQuality: fuelCellKwh !== null
      ? "counter"
      : fuelCellPowerW !== null && fuelCellGasM3 !== null
        ? "mixed"
        : fuelCellPowerW !== null
          ? "integrated"
          : null,
    fuelCellGasDataQuality: fuelCellGasM3 !== null ? "counter" : null,
    fuelCellCounterIssues: [
      ...(electricityCounter.issue ? [{ counter: "electricity", issue: electricityCounter.issue }] : []),
      ...(gasCounter.issue ? [{ counter: "gas", issue: gasCounter.issue }] : []),
    ],
    fuelCellOperatingSeconds,
    fuelCellStartCount,
    gridExportW,
    gridImportW,
    gridImportCumulativeKwh,
    gridExportCumulativeKwh,
    meterCounterSourceHost,
    meterCounterIssues: [
      ...(gridImportCounter.issue ? [{ counter: "import", issue: gridImportCounter.issue }] : []),
      ...(gridExportCounter.issue ? [{ counter: "export", issue: gridExportCounter.issue }] : []),
    ],
    circuitPowerW,
    circuitCumulativeKwh,
    circuitEnergyKwh,
    circuitCounterIssues,
    ...(gridImportCounter.delta !== null ? { gridImportKwh: gridImportCounter.delta } : {}),
    ...(gridExportCounter.delta !== null ? { gridExportKwh: gridExportCounter.delta } : {}),
    ...(exactHouseDemandKwh !== null ? { houseDemandKwh: exactHouseDemandKwh } : {}),
    coverageSeconds,
    energyQuality,
    energyIntervalStart,
    expectedIntervalSeconds: Number(config.updateIntervalSeconds),
    rateYenPerKwh: activeRate,
    maximumRateYenPerKwh: highestRate,
    rateLabel: rateBand.label || null,
  };
}

async function recordStatusSample(status: any, config: any): Promise<any> {
  const sample = sampleFromStatus(status, config, lastRecordedSample);
  const hotWaterLevel = Number.isInteger(sample.fuelCellHotWaterLevel)
    ? sample.fuelCellHotWaterLevel
    : null;
  const previousHotWaterLevel = Number.isInteger(lastRecordedSample?.fuelCellHotWaterLevel)
    ? lastRecordedSample.fuelCellHotWaterLevel
    : null;
  if (hotWaterLevel !== null && hotWaterLevel !== previousHotWaterLevel) {
    const firstObservation = previousHotWaterLevel === null;
    historyStore.recordEvent({
      eventKey: `fuelCell:hot-water:${sample.timestamp}:${hotWaterLevel}`,
      at: sample.timestamp,
      category: "fuelCell",
      type: firstObservation ? "hot-water-level-observed" : "hot-water-level-transition",
      message: firstObservation
        ? `Ene-Farm hot-water level observed at ${hotWaterLevel}/5`
        : `Ene-Farm hot-water level changed from ${previousHotWaterLevel}/5 to ${hotWaterLevel}/5`,
      payload: {
        from: previousHotWaterLevel,
        to: hotWaterLevel,
        sourceHost: sample.fuelCellSourceHost,
      },
    });
  }
  if (sample.fuelCellGenerationState && sample.fuelCellGenerationState !== lastRecordedSample?.fuelCellGenerationState) {
    historyStore.recordEvent({
      eventKey: `fuelCell:state:${sample.timestamp}:${sample.fuelCellGenerationState}`,
      at: sample.timestamp,
      category: "fuelCell",
      type: "state-transition",
      message: `Ene-Farm state changed from ${lastRecordedSample?.fuelCellGenerationState ?? "unknown"} to ${sample.fuelCellGenerationState}`,
      payload: {
        from: lastRecordedSample?.fuelCellGenerationState ?? null,
        to: sample.fuelCellGenerationState,
        sourceHost: sample.fuelCellSourceHost,
        quality: sample.fuelCellDataQuality,
      },
    });
  }
  if (sample.fuelCellCounterSourceHost !== lastRecordedSample?.fuelCellCounterSourceHost) {
    historyStore.recordEvent({
      eventKey: `fuelCell:counter-source:${sample.timestamp}:${sample.fuelCellCounterSourceHost ?? "unavailable"}`,
      at: sample.timestamp,
      category: "fuelCell",
      type: "counter-source-transition",
      message: sample.fuelCellCounterSourceHost
        ? `Ene-Farm exact counters are now supplied by ${sample.fuelCellCounterSourceHost}`
        : "Ene-Farm exact counters are unavailable; estimated watt integration may continue",
      payload: {
        from: lastRecordedSample?.fuelCellCounterSourceHost ?? null,
        to: sample.fuelCellCounterSourceHost ?? null,
        instantaneousSourceHost: sample.fuelCellSourceHost,
        quality: sample.fuelCellDataQuality,
      },
    });
  }
  for (const counterIssue of sample.fuelCellCounterIssues ?? []) {
    historyStore.recordEvent({
      eventKey: `fuelCell:counter:${counterIssue.counter}:${counterIssue.issue}:${sample.timestamp}`,
      at: sample.timestamp,
      category: "fuelCell",
      type: `counter-${counterIssue.issue}`,
      message: counterIssue.issue === "rollover"
        ? `Ene-Farm ${counterIssue.counter} counter rollover detected and validated`
        : `Ene-Farm ${counterIssue.counter} counter ${counterIssue.issue.replace("-", " ")} detected; this interval was excluded`,
      payload: {
        counter: counterIssue.counter,
        issue: counterIssue.issue,
        sourceHost: sample.fuelCellCounterSourceHost,
      },
    });
  }
  lastRecordedSample = historyStore.appendSample(sample);
  if (adaptiveChargingHistoryCache) {
    const adaptiveChargingSample = adaptiveChargingHistorySample(sample);
    if (adaptiveChargingSample) adaptiveChargingHistoryCache.samples.push(adaptiveChargingSample);
    adaptiveChargingHistoryCache.samples = adaptiveChargingHistoryCache.samples.filter(
      (item: any) => new Date(item.timestamp).getTime() >= adaptiveChargingHistoryCache.startMs,
    );
  }
  return sample;
}

async function recordGuardTriggerSample(at: any = new Date()): Promise<any> {
  await ensureDataDir();
  const timestamp = at.toISOString();
  historyStore.recordEvent({
    eventKey: `automation:guard-trigger:${timestamp}`,
    at: timestamp,
    category: "automation",
    type: "guard-trigger",
    message: "Charging Demand Guard entered Standby",
  });
}

function sampleSolarGenerationKwh(sample: any, previousSample: any = null, range: any = {}): any {
  const direct = finiteNumberOrNull(sample.solarGenerationKwh);
  if (Number.isFinite(direct)) {
    return direct * intervalOverlapFraction(sample, "solarGenerationKwh", previousSample, range, false);
  }
  return 0;
}

function samplePowerKwh(sample: any, directKey: any, wattsKey: any, previousSample: any, range: any = {}): any {
  const direct = finiteNumberOrNull(sample[directKey]);
  if (Number.isFinite(direct)) return direct * intervalOverlapFraction(sample, directKey, previousSample, range, false);
  if (!previousSample?.timestamp || !sample?.timestamp) return 0;
  const watts = finiteNumberOrNull(sample[wattsKey]);
  const previousWatts = finiteNumberOrNull(previousSample[wattsKey]);
  if (!Number.isFinite(watts) || !Number.isFinite(previousWatts)) return 0;
  const elapsedMs = new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime();
  const expectedSeconds = Number(sample.expectedIntervalSeconds);
  const maximumGapMs = Number.isFinite(expectedSeconds)
    ? Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000))
    : 35 * 60_000;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > maximumGapMs) return 0;
  const averageWatts = (Math.max(0, watts) + Math.max(0, previousWatts)) / 2;
  return elapsedMs / 3_600_000 * averageWatts / 1000
    * intervalOverlapFraction(sample, directKey, previousSample, range);
}

function hasPowerSample(sample: any, directKey: any, wattsKey: any, previousSample: any): any {
  if (Number.isFinite(finiteNumberOrNull(sample?.[directKey]))) return true;
  if (!previousSample?.timestamp || !sample?.timestamp) return false;
  if (!Number.isFinite(finiteNumberOrNull(sample?.[wattsKey]))
    || !Number.isFinite(finiteNumberOrNull(previousSample?.[wattsKey]))) return false;
  const elapsedMs = new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime();
  const expectedSeconds = Number(sample.expectedIntervalSeconds);
  const maximumGapMs = Number.isFinite(expectedSeconds)
    ? Math.max(90_000, Math.min(2 * 60 * 60_000, expectedSeconds * 2.5 * 1000))
    : 35 * 60_000;
  return Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= maximumGapMs;
}

function energyMetricQuality(samples: any, key: any, range: any = {}): any {
  const qualities = new Set();
  let coverageSeconds = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    const fraction = intervalOverlapFraction(sample, key, previous, range, false);
    const seconds = Number(sample.coverageSeconds?.[key]);
    if (Number.isFinite(seconds)) coverageSeconds += Math.max(0, seconds) * fraction;
    const quality = sample.energyQuality?.[key];
    if (quality) qualities.add(quality);
  }
  const requestedSeconds = Number.isFinite(range.startMs) && Number.isFinite(range.endMs)
    ? Math.max(0, (range.endMs - range.startMs) / 1000)
    : null;
  return {
    quality: qualities.size === 1 ? [...qualities][0] : qualities.size > 1 ? "mixed" : "unavailable",
    coverageSeconds,
    coveragePercent: Number(requestedSeconds) > 0 ? Math.min(100, coverageSeconds / Number(requestedSeconds) * 100) : null,
  };
}

function sampleDiscountSavings(sample: any, previousSample: any, config: any = DEFAULT_CONFIG, range: any = {}): any {
  const standardRate = configNumber(
    config.standardRateYenPerKwh,
    DEFAULT_CONFIG.standardRateYenPerKwh,
    0,
    1000,
  );
  const recordedRate = finiteNumberOrNull(sample.rateYenPerKwh);
  const activeRate = recordedRate ?? rateForTimestamp(
    config.rateBands,
    sample.timestamp,
    standardRate,
  ).yenPerKwh;
  const savingPerKwh = Math.max(0, standardRate - activeRate);
  if (savingPerKwh === 0) {
    return { totalYen: 0, batteryYen: 0, gridYen: 0 };
  }

  const hasGridImport = hasPowerSample(sample, "gridImportKwh", "gridImportW", previousSample);
  const hasBatteryCharge = hasPowerSample(sample, "batteryChargeKwh", "batteryPowerW", previousSample);
  const gridImportKwh = hasGridImport
    ? samplePowerKwh(sample, "gridImportKwh", "gridImportW", previousSample, range)
    : null;
  const batteryChargeKwh = hasBatteryCharge
    ? samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", previousSample, range)
    : 0;
  const gridFundedBatteryKwh = gridImportKwh === null
    ? batteryChargeKwh
    : Math.min(batteryChargeKwh, gridImportKwh);
  const totalDiscountedKwh = gridImportKwh ?? gridFundedBatteryKwh;
  const batteryYen = gridFundedBatteryKwh * savingPerKwh;
  const totalYen = totalDiscountedKwh * savingPerKwh;
  return {
    totalYen,
    batteryYen,
    gridYen: Math.max(0, totalYen - batteryYen),
  };
}

function summarizeEnergySources(samples: any, config: any, solarGenerationKwh: any, gridExportKwh: any, fuelCellKwh: any, range: any = {}): any {
  const standardRate = configNumber(
    config.standardRateYenPerKwh,
    DEFAULT_CONFIG.standardRateYenPerKwh,
    0,
    1000,
  );
  const grid = samples.reduce(
    (totals: any, sample: any, index: any) => {
      const importedKwh = samplePowerKwh(
        sample,
        "gridImportKwh",
        "gridImportW",
        samples[index - 1],
        range,
      );
      const recordedRate = Number(sample.rateYenPerKwh);
      const activeRate = Number.isFinite(recordedRate)
        ? recordedRate
        : rateForTimestamp(config.rateBands, sample.timestamp, standardRate).yenPerKwh;
      if (activeRate < standardRate) totals.offPeakGridKwh += importedKwh;
      else totals.peakGridKwh += importedKwh;
      return totals;
    },
    { peakGridKwh: 0, offPeakGridKwh: 0 },
  );
  const solarUsedKwh = config.solarEnabled === false
    ? 0
    : Math.max(0, solarGenerationKwh - gridExportKwh);
  const fuelCellContributionKwh = config.fuelCellEnabled === false
    ? 0
    : Math.max(0, Number(fuelCellKwh) || 0);
  const totalKwh = grid.peakGridKwh + grid.offPeakGridKwh + solarUsedKwh + fuelCellContributionKwh;
  const percent = (value: any) => totalKwh > 0 ? (value / totalKwh) * 100 : 0;
  return {
    ...grid,
    solarUsedKwh,
    fuelCellContributionKwh,
    totalKwh,
    peakGridPercent: percent(grid.peakGridKwh),
    offPeakGridPercent: percent(grid.offPeakGridKwh),
    solarUsedPercent: percent(solarUsedKwh),
    fuelCellContributionPercent: percent(fuelCellContributionKwh),
  };
}

function summarizeSamples(samples: any, config: any = DEFAULT_CONFIG, extras: any = {}): any {
  const range: Record<string, any> = { startMs: extras.startMs, endMs: extras.endMs };
  const solarGenerationKwh = samples.reduce(
    (sum: any, sample: any, index: any) => sum + sampleSolarGenerationKwh(sample, samples[index - 1], range),
    0,
  );
  const gridImportKwh = samples.reduce(
    (sum: any, sample: any, index: any) => sum + samplePowerKwh(sample, "gridImportKwh", "gridImportW", samples[index - 1], range),
    0,
  );
  const gridExportKwh = samples.reduce(
    (sum: any, sample: any, index: any) => sum + samplePowerKwh(sample, "gridExportKwh", "gridExportW", samples[index - 1], range),
    0,
  );
  const houseDemandKwh = samples.reduce(
    (sum: any, sample: any, index: any) => sum + samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", samples[index - 1], range),
    0,
  );
  const fuelCellKwh = samples.reduce(
    (sum: any, sample: any, index: any) => sum + samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", samples[index - 1], range),
    0,
  );
  const circuits = summarizeCircuits(samples, config, range);
  const battery = samples.reduce(
    (acc: any, sample: any, index: any) => {
      const charged = samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", samples[index - 1], range);
      const dischargeSample: Record<string, any> = { ...sample, batteryPowerW: -Number(sample.batteryPowerW) };
      const previous = samples[index - 1];
      const previousDischargeSample = previous
        ? { ...previous, batteryPowerW: -Number(previous.batteryPowerW) }
        : null;
      const discharged = samplePowerKwh(
        dischargeSample,
        "batteryDischargeKwh",
        "batteryPowerW",
        previousDischargeSample,
        range,
      );
      acc.chargedKwh += charged;
      acc.dischargedKwh += discharged;
      return acc;
    },
    { chargedKwh: 0, dischargedKwh: 0 },
  );
  const socSamples = samples
    .map((sample: any) => finiteNumberOrNull(sample.stateOfChargePercent))
    .filter((value: any) => Number.isFinite(value));
  const averageStateOfChargePercent = socSamples.length
    ? socSamples.reduce((sum: any, value: any) => sum + value, 0) / socSamples.length
    : null;
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const guardTriggerCount = samples.reduce(
    (sum: any, sample: any) => sum + Math.max(0, Number(sample.guardTriggerCount ?? 0) || 0),
    0,
  ) + Math.max(0, Number(extras.guardTriggerCount ?? 0) || 0);
  const energySources = summarizeEnergySources(
    samples,
    config,
    solarGenerationKwh,
    gridExportKwh,
    fuelCellKwh,
    range,
  );
  const dataQuality = Object.fromEntries([
    "houseDemandKwh",
    "solarGenerationKwh",
    "gridImportKwh",
    "gridExportKwh",
    "fuelCellKwh",
    "batteryChargeKwh",
    "batteryDischargeKwh",
  ].map((key: any) => [key, energyMetricQuality(samples, key, range)]));
  const solarSavingYen = samples.reduce((sum: any, sample: any, index: any) => (
    sum + Number(sample.solarSavingYen ?? 0)
      * intervalOverlapFraction(sample, "solarGenerationKwh", samples[index - 1], range, false)
  ), 0);
  const offPeakSavingYen = samples.reduce((sum: any, sample: any, index: any) => (
    sum + Number(sample.offPeakSavingYen ?? 0)
      * intervalOverlapFraction(sample, "batteryChargeKwh", samples[index - 1], range, false)
  ), 0);
  const discountedSavings = samples.reduce(
    (totals: any, sample: any, index: any) => {
      const savings = sampleDiscountSavings(sample, samples[index - 1], config, range);
      totals.totalOffPeakSavingYen += savings.totalYen;
      totals.batteryOffPeakSavingYen += savings.batteryYen;
      totals.gridOffPeakSavingYen += savings.gridYen;
      return totals;
    },
    { totalOffPeakSavingYen: 0, batteryOffPeakSavingYen: 0, gridOffPeakSavingYen: 0 },
  );
  return {
    sampleCount: samples.length,
    start: samples[0]?.timestamp ?? null,
    end: samples[samples.length - 1]?.timestamp ?? null,
    offPeakSavingYen,
    ...discountedSavings,
    solarSavingYen,
    solarGenerationKwh,
    gridImportKwh,
    gridExportKwh,
    houseDemandKwh,
    fuelCellKwh,
    circuits,
    circuitTotalKwh: circuits.reduce((sum: any, circuit: any) => sum + Number(circuit.totalKwh ?? 0), 0),
    batteryChargedKwh: battery.chargedKwh,
    batteryDischargedKwh: battery.dischargedKwh,
    batteryNetKwh: battery.chargedKwh - battery.dischargedKwh,
    averageStateOfChargePercent,
    co2SavingKg: solarGenerationKwh * co2TonnesPerKwh * 1000,
    guardTriggerCount,
    energySources,
    dataQuality,
  };
}

function calendarSavingsRanges(end: any = new Date()): any {
  const rangeEnd = new Date(end);
  if (!Number.isFinite(rangeEnd.getTime())) throw new Error("a valid savings period end is required");
  const today = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  const thisMonth = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
  const lastMonth = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth() - 1, 1);
  return {
    today: { startMs: today.getTime(), endMs: rangeEnd.getTime() },
    lastMonth: { startMs: lastMonth.getTime(), endMs: thisMonth.getTime() },
    month: {
      startMs: thisMonth.getTime(),
      endMs: rangeEnd.getTime(),
    },
    year: {
      startMs: new Date(rangeEnd.getFullYear(), 0, 1).getTime(),
      endMs: rangeEnd.getTime(),
    },
  };
}

function compactSavingsSummary(summary: any, range: any): any {
  return {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
    solarSavingYen: Number(summary?.solarSavingYen ?? 0),
    co2SavingKg: Number(summary?.co2SavingKg ?? 0),
    offPeakSavingYen: Number(summary?.offPeakSavingYen ?? 0),
    totalOffPeakSavingYen: Number(summary?.totalOffPeakSavingYen ?? 0),
    batteryOffPeakSavingYen: Number(summary?.batteryOffPeakSavingYen ?? 0),
    gridOffPeakSavingYen: Number(summary?.gridOffPeakSavingYen ?? 0),
  };
}

function summarizeCalendarSavings(samples: any, config: any = DEFAULT_CONFIG, end: any = new Date(), todaySummary: any = null): any {
  const ranges = calendarSavingsRanges(end);
  return Object.fromEntries(Object.entries(ranges).map(([period, range]: any) => {
    const summary = period === "today" && todaySummary
      ? todaySummary
      : summarizeSamples(samples, config, range);
    return [period, compactSavingsSummary(summary, range)];
  }));
}

function normalizeReportBucket(value: any): any {
  if (["day", "week", "month"].includes(value)) return value;
  throw new Error("bucket must be day, week, or month");
}

function startOfReportBucket(date: any, bucket: any): any {
  const local = new Date(date);
  if (bucket === "month") return new Date(local.getFullYear(), local.getMonth(), 1);
  if (bucket === "week") {
    const start = new Date(local.getFullYear(), local.getMonth(), local.getDate());
    const dayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dayOffset);
    return start;
  }
  return new Date(local.getFullYear(), local.getMonth(), local.getDate());
}

function endOfReportBucket(start: any, bucket: any): any {
  const end = new Date(start);
  if (bucket === "month") end.setMonth(end.getMonth() + 1);
  else if (bucket === "week") end.setDate(end.getDate() + 7);
  else end.setDate(end.getDate() + 1);
  return end;
}

function reportBucketKey(start: any, bucket: any): any {
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const day = String(start.getDate()).padStart(2, "0");
  if (bucket === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function reportBucketLabel(start: any, bucket: any): any {
  if (bucket === "month") {
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  }
  if (bucket === "week") {
    const end = new Date(endOfReportBucket(start, bucket).getTime() - 1);
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")} - ${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  }
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}

function emptyReportBucket(start: any, bucket: any): any {
  const end = endOfReportBucket(start, bucket);
  return {
    key: reportBucketKey(start, bucket),
    label: reportBucketLabel(start, bucket),
    start: start.toISOString(),
    end: end.toISOString(),
    sampleCount: 0,
    houseDemandKwh: 0,
    solarGenerationKwh: 0,
    gridImportKwh: 0,
    gridExportKwh: 0,
    fuelCellKwh: 0,
    batteryChargedKwh: 0,
    batteryDischargedKwh: 0,
    solarSavingYen: 0,
    offPeakSavingYen: 0,
    totalOffPeakSavingYen: 0,
    batteryOffPeakSavingYen: 0,
    gridOffPeakSavingYen: 0,
    co2SavingKg: 0,
    peakDemandW: null,
    _valid: {
      houseDemandKwh: 0,
      solarGenerationKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      fuelCellKwh: 0,
      batteryChargedKwh: 0,
      batteryDischargedKwh: 0,
    },
    _coverageSeconds: {},
    _qualities: {},
  };
}

function addReportEnergy(bucket: any, key: any, value: any, valid: any): any {
  if (!valid) return;
  bucket[key] += Number(value) || 0;
  bucket._valid[key] += 1;
}

function addReportQuality(bucket: any, key: any, sample: any, previousSample: any, range: any): any {
  const fraction = intervalOverlapFraction(sample, key, previousSample, range, false);
  const seconds = Number(sample.coverageSeconds?.[key]);
  if (Number.isFinite(seconds)) {
    bucket._coverageSeconds[key] = Number(bucket._coverageSeconds[key] ?? 0) + Math.max(0, seconds) * fraction;
  }
  const quality = sample.energyQuality?.[key];
  if (quality) bucket._qualities[key] = [...new Set([...(bucket._qualities[key] ?? []), quality])];
}

function finalizeReportBucket(bucket: any, previousBucket: any, selectedRange: any = {}): any {
  const out: Record<string, any> = { ...bucket };
  delete out._valid;
  delete out._coverageSeconds;
  delete out._qualities;
  for (const key of [
    "houseDemandKwh",
    "solarGenerationKwh",
    "gridImportKwh",
    "gridExportKwh",
    "fuelCellKwh",
    "batteryChargedKwh",
    "batteryDischargedKwh",
  ]) {
    if (!bucket._valid[key]) out[key] = null;
  }
  out.previousHouseDemandKwh = previousBucket?.houseDemandKwh ?? null;
  out.houseDemandDeltaKwh =
    Number.isFinite(out.houseDemandKwh) && Number.isFinite(out.previousHouseDemandKwh)
      ? out.houseDemandKwh - out.previousHouseDemandKwh
      : null;
  out.houseDemandDeltaPercent =
    Number.isFinite(out.houseDemandDeltaKwh) && Number.isFinite(out.previousHouseDemandKwh) && out.previousHouseDemandKwh !== 0
      ? (out.houseDemandDeltaKwh / out.previousHouseDemandKwh) * 100
      : null;
  const bucketStartMs = new Date(bucket.start).getTime();
  const bucketEndMs = new Date(bucket.end).getTime();
  const selectedStartMs = Number.isFinite(selectedRange.startMs)
    ? Math.max(bucketStartMs, selectedRange.startMs)
    : bucketStartMs;
  const selectedEndMs = Number.isFinite(selectedRange.endMs)
    ? Math.min(bucketEndMs, selectedRange.endMs)
    : bucketEndMs;
  const bucketSeconds = Math.max(0, (selectedEndMs - selectedStartMs) / 1000);
  out.dataQuality = Object.fromEntries(Object.keys(bucket._valid).map((key: any) => {
    const qualities = bucket._qualities[key] ?? [];
    const coverageSeconds = Number(bucket._coverageSeconds[key] ?? 0);
    return [key, {
      quality: qualities.length === 1 ? qualities[0] : qualities.length > 1 ? "mixed" : "unavailable",
      coverageSeconds,
      coveragePercent: bucketSeconds > 0 ? Math.min(100, coverageSeconds / bucketSeconds * 100) : null,
    }];
  }));
  return out;
}

function summarizeReportBuckets(buckets: any): any {
  const sum = (key: any) => {
    const values = buckets
      .map((bucket: any) => bucket[key])
      .filter((value: any) => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((total: any, value: any) => total + value, 0) : null;
  };
  const peaks = buckets
    .map((bucket: any) => finiteNumberOrNull(bucket.peakDemandW))
    .filter(Number.isFinite);
  const houseDemandKwh = sum("houseDemandKwh");
  const solarGenerationKwh = sum("solarGenerationKwh");
  return {
    houseDemandKwh,
    solarGenerationKwh,
    gridImportKwh: sum("gridImportKwh"),
    gridExportKwh: sum("gridExportKwh"),
    fuelCellKwh: sum("fuelCellKwh"),
    batteryChargedKwh: sum("batteryChargedKwh"),
    batteryDischargedKwh: sum("batteryDischargedKwh"),
    solarSavingYen: buckets.reduce((total: any, bucket: any) => total + Number(bucket.solarSavingYen ?? 0), 0),
    offPeakSavingYen: buckets.reduce((total: any, bucket: any) => total + Number(bucket.offPeakSavingYen ?? 0), 0),
    totalOffPeakSavingYen: buckets.reduce((total: any, bucket: any) => total + Number(bucket.totalOffPeakSavingYen ?? 0), 0),
    batteryOffPeakSavingYen: buckets.reduce((total: any, bucket: any) => total + Number(bucket.batteryOffPeakSavingYen ?? 0), 0),
    gridOffPeakSavingYen: buckets.reduce((total: any, bucket: any) => total + Number(bucket.gridOffPeakSavingYen ?? 0), 0),
    co2SavingKg: buckets.reduce((total: any, bucket: any) => total + Number(bucket.co2SavingKg ?? 0), 0),
    peakDemandW: peaks.length ? Math.max(...peaks) : null,
    solarCoveragePercent:
      Number.isFinite(houseDemandKwh) && houseDemandKwh > 0 && Number.isFinite(solarGenerationKwh)
        ? (solarGenerationKwh / houseDemandKwh) * 100
        : null,
    sampleCount: buckets.reduce((total: any, bucket: any) => total + Number(bucket.sampleCount ?? 0), 0),
  };
}

function createEnergyReportAccumulator({ start, end, bucket = "day", config = DEFAULT_CONFIG, previousSample = null }: any = {}): any {
  const bucketMode = normalizeReportBucket(bucket);
  const startMs = start ? new Date(start).getTime() : Number.NaN;
  const endMs = end ? new Date(end).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const byKey = new Map();
  let prev = previousSample;

  return {
    process(sample: any): any {
      const time = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(time)) {
        prev = sample;
        return "skipped";
      }
      if (time < startMs) {
        prev = sample;
        return "before";
      }
      const intervalStartMs = new Date(
        sample.rollupStart
          ?? Object.values(sample.energyIntervalStart ?? {}).sort()[0]
          ?? prev?.timestamp,
      ).getTime();
      if (time >= endMs && (!Number.isFinite(intervalStartMs) || intervalStartMs >= endMs)) return "after";
      const bucketStart = startOfReportBucket(new Date(Math.max(startMs, time - 1)), bucketMode);
      const key = reportBucketKey(bucketStart, bucketMode);
      if (!byKey.has(key)) byKey.set(key, emptyReportBucket(bucketStart, bucketMode));
      const row = byKey.get(key);
      row.sampleCount += Number(sample.rollupSampleCount ?? 1) || 1;
      const reportRange: Record<string, any> = {
        startMs: Math.max(startMs, bucketStart.getTime()),
        endMs: Math.min(endMs, endOfReportBucket(bucketStart, bucketMode).getTime()),
      };
      addReportEnergy(
        row,
        "houseDemandKwh",
        samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", prev, reportRange),
        hasPowerSample(sample, "houseDemandKwh", "houseDemandW", prev),
      );
      addReportQuality(row, "houseDemandKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "gridImportKwh",
        samplePowerKwh(sample, "gridImportKwh", "gridImportW", prev, reportRange),
        hasPowerSample(sample, "gridImportKwh", "gridImportW", prev),
      );
      addReportQuality(row, "gridImportKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "gridExportKwh",
        samplePowerKwh(sample, "gridExportKwh", "gridExportW", prev, reportRange),
        hasPowerSample(sample, "gridExportKwh", "gridExportW", prev),
      );
      addReportQuality(row, "gridExportKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "fuelCellKwh",
        samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", prev, reportRange),
        hasPowerSample(sample, "fuelCellKwh", "fuelCellPowerW", prev),
      );
      addReportQuality(row, "fuelCellKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "batteryChargedKwh",
        samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", prev, reportRange),
        hasPowerSample(sample, "batteryChargeKwh", "batteryPowerW", prev),
      );
      addReportQuality(row, "batteryChargeKwh", sample, prev, reportRange);
      addReportEnergy(
        row,
        "batteryDischargedKwh",
        samplePowerKwh(
          { ...sample, batteryPowerW: -Number(sample.batteryPowerW) },
          "batteryDischargeKwh",
          "batteryPowerW",
          prev ? { ...prev, batteryPowerW: -Number(prev.batteryPowerW) } : null,
          reportRange,
        ),
        hasPowerSample(sample, "batteryDischargeKwh", "batteryPowerW", prev),
      );
      addReportQuality(row, "batteryDischargeKwh", sample, prev, reportRange);
      const solarGenerationKwh = sampleSolarGenerationKwh(sample, prev, reportRange);
      addReportEnergy(
        row,
        "solarGenerationKwh",
        solarGenerationKwh,
        Number.isFinite(finiteNumberOrNull(sample.solarGenerationKwh))
          || hasPowerSample(sample, "solarGenerationKwh", "solarPowerW", prev),
      );
      addReportQuality(row, "solarGenerationKwh", sample, prev, reportRange);
      row.solarSavingYen += (Number(sample.solarSavingYen ?? 0) || 0)
        * intervalOverlapFraction(sample, "solarGenerationKwh", prev, reportRange, false);
      row.offPeakSavingYen += (Number(sample.offPeakSavingYen ?? 0) || 0)
        * intervalOverlapFraction(sample, "batteryChargeKwh", prev, reportRange, false);
      const discountedSavings = sampleDiscountSavings(sample, prev, config, reportRange);
      row.totalOffPeakSavingYen += discountedSavings.totalYen;
      row.batteryOffPeakSavingYen += discountedSavings.batteryYen;
      row.gridOffPeakSavingYen += discountedSavings.gridYen;
      row.co2SavingKg += solarGenerationKwh * co2TonnesPerKwh * 1000;
      const demand = Number(sample.peakHouseDemandW ?? sample.houseDemandW);
      if (Number.isFinite(demand)) row.peakDemandW = Math.max(row.peakDemandW ?? demand, demand);
      prev = sample;
      return "included";
    },
    finish(): any {
      const buckets: any[] = [];
      let cursor = startOfReportBucket(new Date(startMs), bucketMode);
      while (cursor.getTime() < endMs) {
        const key = reportBucketKey(cursor, bucketMode);
        const raw = byKey.get(key) ?? emptyReportBucket(cursor, bucketMode);
        buckets.push(finalizeReportBucket(raw, buckets.at(-1), { startMs, endMs }));
        cursor = endOfReportBucket(cursor, bucketMode);
      }
      return {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        bucket: bucketMode,
        buckets,
        totals: summarizeReportBuckets(buckets),
        features: {
          solarEnabled: config.solarEnabled !== false,
          smartCosmoEnabled: config.smartCosmoEnabled !== false,
          fuelCellEnabled: config.fuelCellEnabled !== false,
        },
      };
    },
  };
}

function aggregateEnergyReportSamples(samples: any, options: any = {}): any {
  const accumulator = createEnergyReportAccumulator(options);
  for (const sample of samples) {
    const result = accumulator.process(sample);
    if (result === "after") break;
  }
  return accumulator.finish();
}

function gasTariffForMonth(config: any, billingMonth: any): any {
  const provider = config.fuelCell?.tariff?.provider ?? "tokyo-gas";
  const snapshot = historyStore.gasTariffSnapshots({ provider, billingMonth })[0] ?? null;
  return snapshot ? { ...snapshot, source: "snapshot" } : null;
}

function localMonthKey(value: any): any {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function clampedReadingDate(year: any, month: any, readingDay: any): any {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(readingDay, lastDay));
}

function completeBillingPeriod(start: any, end: any, readingDay: any): any {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const expectedStart = clampedReadingDate(startDate.getFullYear(), startDate.getMonth(), readingDay);
  const expectedEnd = clampedReadingDate(startDate.getFullYear(), startDate.getMonth() + 1, readingDay);
  return startDate.getTime() === expectedStart.getTime() && endDate.getTime() === expectedEnd.getTime();
}

function billingPeriodKey(value: any, readingDay: any): any {
  const date = new Date(value);
  const boundary = clampedReadingDate(date.getFullYear(), date.getMonth(), readingDay);
  const periodStart = date.getTime() < boundary.getTime()
    ? clampedReadingDate(date.getFullYear(), date.getMonth() - 1, readingDay)
    : boundary;
  return localMonthKey(periodStart);
}

function billingPeriodBounds(billingMonth: any, readingDay: any): any {
  const [year, month] = String(billingMonth).split("-").map(Number);
  return {
    start: clampedReadingDate(year, month - 1, readingDay),
    end: clampedReadingDate(year, month, readingDay),
  };
}

function fuelCellGasUsageByBillingPeriod(samples: any, readingDay: any): any {
  const usage = new Map();
  for (const sample of samples) {
    const gasM3 = finiteNumberOrNull(sample.fuelCellGasM3);
    if (gasM3 === null) continue;
    const billingMonth = billingPeriodKey(sample.timestamp, readingDay);
    usage.set(billingMonth, Number(usage.get(billingMonth) ?? 0) + Math.max(0, gasM3));
  }
  return usage;
}

async function measuredFuelCellGasByBillingPeriod(start: any, end: any, readingDay: any): Promise<any> {
  const startMonth = billingPeriodKey(start, readingDay);
  const endMs = new Date(end).getTime();
  const finalInstant = Number.isFinite(endMs) ? new Date(Math.max(new Date(start).getTime(), endMs - 1)) : end;
  const endMonth = billingPeriodKey(finalInstant, readingDay);
  const first = billingPeriodBounds(startMonth, readingDay);
  const last = billingPeriodBounds(endMonth, readingDay);
  const samples = await readHistorySamplesInRange(first.start.getTime(), last.end.getTime());
  return fuelCellGasUsageByBillingPeriod(samples, readingDay);
}

function estimatedGasCost(config: any, gasM3: any, start: any, end: any, billingPeriodGasM3: any = gasM3): any {
  const settings = config.fuelCell?.tariff ?? {};
  const readingDay = settings.meterReadingDay ?? 1;
  const billingMonth = billingPeriodKey(start, readingDay);
  const rangeEndMs = new Date(end).getTime();
  const finalInstant = Number.isFinite(rangeEndMs) ? new Date(Math.max(new Date(start).getTime(), rangeEndMs - 1)) : end;
  const endBillingMonth = billingPeriodKey(finalInstant, readingDay);
  if (billingMonth !== endBillingMonth) {
    return {
      estimated: true,
      available: false,
      billingMonth: null,
      reason: "The selected range crosses billing periods; review the per-period estimates instead",
      methodology: "Each billing period must use its own immutable tariff snapshot",
    };
  }
  const tariff = gasTariffForMonth(config, billingMonth);
  if (!Number.isFinite(gasM3) || !tariff) {
    return {
      estimated: true,
      available: false,
      billingMonth,
      reason: !tariff ? "No tariff snapshot is available for this billing month" : "No exact Ene-Farm gas counter data is available",
      methodology: "Ene-Farm gas volume multiplied by the configured monthly gas tariff",
    };
  }
  if (!Number.isFinite(billingPeriodGasM3)) {
    return {
      estimated: true,
      available: false,
      billingMonth,
      reason: "No exact Ene-Farm gas counter data is available for this billing period",
      methodology: "Measured Ene-Farm gas is assumed to be the household's entire gas consumption",
    };
  }
  const band = applicableGasTariffBand(tariff, billingPeriodGasM3);
  const discount = applicableGasDiscount(tariff, settings.equipmentDiscount);
  const configuredRate = finiteNumberOrNull(settings.marginalRateOverrideYenPerM3);
  const baseRate = configuredRate ?? band?.yenPerM3 ?? null;
  if (!Number.isFinite(baseRate)) {
    return { estimated: true, available: false, billingMonth, reason: "No applicable variable gas rate is configured", methodology: "Ene-Farm gas volume multiplied by the configured monthly gas tariff" };
  }
  const discountRatio = (discount?.percent ?? 0) / 100;
  const marginalRateYenPerM3 = baseRate * (1 - discountRatio);
  const variableCostYen = gasM3 * baseRate;
  const uncappedDiscountYen = variableCostYen * discountRatio;
  const discountYen = Math.min(uncappedDiscountYen, discount?.capYen ?? Number.POSITIVE_INFINITY);
  const marginalCostYen = variableCostYen - discountYen;
  const fullPeriod = completeBillingPeriod(start, end, readingDay);
  const standingChargeYen = band?.baseChargeYen ?? null;
  const allocatedTotalYen = fullPeriod && Number.isFinite(standingChargeYen) ? Number(standingChargeYen) + marginalCostYen : null;
  return {
    estimated: true,
    available: true,
    billingMonth,
    source: tariff.source,
    sourceUrl: tariff.sourceUrl ?? tariff.providerPlanUrl ?? null,
    methodology: "Measured Ene-Farm gas is assumed to be the household's entire gas consumption; other gas appliances are excluded",
    assumedBillingPeriodUsageM3: billingPeriodGasM3,
    assumption: "Ene-Farm is the household's only gas consumer; gas used by other appliances is not included",
    band,
    discount,
    marginalRateYenPerM3,
    marginalCostYen,
    standingChargeInclusive: {
      available: allocatedTotalYen !== null && gasM3 > 0,
      reason: fullPeriod ? (gasM3 > 0 ? null : "No Ene-Farm gas was measured") : "Available only for a complete configured billing period",
      standingChargeYen,
      totalYen: allocatedTotalYen,
      allocatedYenPerM3: allocatedTotalYen !== null && gasM3 > 0 ? allocatedTotalYen / gasM3 : null,
      methodology: "The full household standing charge is allocated to measured Ene-Farm gas under the assumption that Ene-Farm is the only gas consumer; this is not a reconstructed provider bill",
    },
  };
}

async function updateCurrentGasTariff(config: any, now: any = new Date()): Promise<any> {
  if (EXTERNAL_IO_DISABLED) return null;
  if (config.fuelCellEnabled === false || config.fuelCell?.tariff?.automaticUpdates !== true) return null;
  const provider = config.fuelCell.tariff.provider;
  if (provider !== "tokyo-gas") return null;
  const billingMonth = billingPeriodKey(now, config.fuelCell.tariff.meterReadingDay ?? 1);
  const imported = await importGasTariff(provider, {
    billingMonth,
    readingDay: config.fuelCell.tariff.meterReadingDay,
    region: config.fuelCell.tariff.region,
    plan: config.fuelCell.tariff.plan,
  });
  return historyStore.recordGasTariffSnapshot({ ...imported, fetchedAt: now.toISOString() });
}

function summarizeEneFarmSamples(samples: any, config: any, { start, end, billingPeriodGasM3 }: any = {}): any {
  let generatedKwh = 0;
  let gasM3 = 0;
  let hasGas = false;
  let onSiteKwh = 0;
  let onSiteKnown = true;
  let operatingSeconds = 0;
  let startCount = 0;
  const qualities = new Set();
  const states: Record<string, any> = {};
  let previousState: any = null;
  let stateSince: any = null;
  let lastStopAt: any = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    const energy = samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", previous);
    generatedKwh += energy;
    const gas = finiteNumberOrNull(sample.fuelCellGasM3);
    if (Number.isFinite(gas)) { gasM3 += Math.max(0, gas); hasGas = true; }
    const demand = samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", previous);
    if (sample.fuelCellInterconnection === "grid_connected_reverse_flow_prohibited") {
      onSiteKwh += energy;
    } else if (Number.isFinite(demand)) {
      onSiteKwh += Math.min(energy, Math.max(0, demand));
    } else if (energy > 0) {
      onSiteKnown = false;
    }
    const seconds = Math.max(0, finiteNumberOrNull(sample.fuelCellOperatingSeconds) ?? 0);
    operatingSeconds += seconds;
    startCount += Math.max(0, finiteNumberOrNull(sample.fuelCellStartCount) ?? 0);
    if (sample.fuelCellGenerationState) {
      states[sample.fuelCellGenerationState] = Number(states[sample.fuelCellGenerationState] ?? 0) + seconds;
      if (sample.fuelCellGenerationState !== previousState) {
        stateSince = sample.timestamp;
        if (sample.fuelCellGenerationState === "stopped") lastStopAt = sample.timestamp;
        previousState = sample.fuelCellGenerationState;
      }
    }
    if (sample.fuelCellDataQuality) qualities.add(sample.fuelCellDataQuality);
  }
  const gasValue = hasGas ? gasM3 : null;
  const gasCo2Kg = gasValue === null ? null : gasValue * Number(config.fuelCell?.gasCo2KgPerM3 ?? 2.21);
  const onSiteValue = onSiteKnown ? onSiteKwh : null;
  const avoidedGridCo2Kg = onSiteValue === null
    ? null
    : onSiteValue * Number(config.co2TonnesPerKwh ?? DEFAULT_CONFIG.co2TonnesPerKwh) * 1000;
  const rangeStart = start ?? samples[0]?.timestamp ?? null;
  const rangeEnd = end ?? samples.at(-1)?.timestamp ?? null;
  const stateIntervals: any[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const sampleState = sample.fuelCellGenerationState ?? "unknown";
    let interval = stateIntervals.at(-1);
    if (!interval || interval.state !== sampleState || interval.sourceHost !== (sample.fuelCellSourceHost ?? null)) {
      interval = {
        start: index === 0 ? rangeStart ?? sample.timestamp : sample.timestamp,
        end: sample.timestamp,
        state: sampleState,
        generatedKwh: 0,
        gasM3: 0,
        hasGas: false,
        sourceHost: sample.fuelCellSourceHost ?? null,
        qualities: new Set(),
      };
      stateIntervals.push(interval);
    }
    interval.end = samples[index + 1]?.timestamp ?? rangeEnd ?? sample.timestamp;
    interval.generatedKwh += samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", samples[index - 1]);
    const intervalGas = finiteNumberOrNull(sample.fuelCellGasM3);
    if (intervalGas !== null) { interval.gasM3 += Math.max(0, intervalGas); interval.hasGas = true; }
    if (sample.fuelCellDataQuality) interval.qualities.add(sample.fuelCellDataQuality);
  }
  return {
    sampleCount: samples.length,
    start: rangeStart,
    end: rangeEnd,
    generatedKwh: samples.length ? generatedKwh : null,
    gasM3: gasValue,
    electricalYieldKwhPerM3: Number(gasValue) > 0 ? generatedKwh / Number(gasValue) : null,
    onSiteKwh: onSiteValue,
    generationCoveragePercent: null,
    operatingSeconds,
    startCount,
    averageGeneratingW: operatingSeconds > 0 ? generatedKwh / (operatingSeconds / 3600) * 1000 : null,
    ratedPowerW: samples.findLast((sample: any) => Number.isFinite(Number(sample.fuelCellRatedPowerW)))?.fuelCellRatedPowerW ?? null,
    stateDurations: states,
    currentState: samples.at(-1)?.fuelCellGenerationState ?? null,
    stateSince,
    timeInStateSeconds: stateSince && rangeEnd
      ? Math.max(0, (new Date(rangeEnd).getTime() - new Date(stateSince).getTime()) / 1000)
      : null,
    lastStopAt,
    stateIntervals: stateIntervals.map((interval: any) => ({
      start: interval.start,
      end: interval.end,
      state: interval.state,
      durationSeconds: Math.max(0, (new Date(interval.end).getTime() - new Date(interval.start).getTime()) / 1000),
      generatedKwh: interval.generatedKwh,
      gasM3: interval.hasGas ? interval.gasM3 : null,
      sourceHost: interval.sourceHost,
      quality: interval.qualities.size > 1 ? "mixed" : interval.qualities.values().next().value ?? null,
    })),
    sourceHost: samples.at(-1)?.fuelCellSourceHost ?? null,
    counterSourceHost: samples.at(-1)?.fuelCellCounterSourceHost ?? null,
    dataQuality: qualities.size > 1 ? "mixed" : qualities.values().next().value ?? null,
    estimatedGasCost: rangeStart && rangeEnd ? estimatedGasCost(config, gasValue, rangeStart, rangeEnd, billingPeriodGasM3) : null,
    carbon: {
      estimated: true,
      directGasCo2Kg: gasCo2Kg,
      avoidedGridCo2Kg,
      electricityOnlyBalanceKg: gasCo2Kg === null || avoidedGridCo2Kg === null ? null : avoidedGridCo2Kg - gasCo2Kg,
      methodology: "Avoided grid emissions minus direct gas emissions; recovered heat is not measured",
    },
  };
}

async function eneFarmReport(start: any, end: any, bucket: any, config: any): Promise<any> {
  const samples = await readHistorySamplesInRange(new Date(start).getTime(), new Date(end).getTime());
  const readingDay = config.fuelCell?.tariff?.meterReadingDay ?? 1;
  const billingPeriodUsage = await measuredFuelCellGasByBillingPeriod(start, end, readingDay);
  const energy = aggregateEnergyReportSamples(samples, { start, end, bucket, config });
  let sampleIndex = 0;
  const buckets = energy.buckets.map((row: any) => {
    const rowStartMs = new Date(row.start).getTime();
    const rowEndMs = new Date(row.end).getTime();
    while (sampleIndex < samples.length && new Date(samples[sampleIndex].timestamp).getTime() < rowStartMs) sampleIndex += 1;
    const bucketSamples: any[] = [];
    while (sampleIndex < samples.length && new Date(samples[sampleIndex].timestamp).getTime() < rowEndMs) {
      bucketSamples.push(samples[sampleIndex]);
      sampleIndex += 1;
    }
    const summary = summarizeEneFarmSamples(bucketSamples, config, {
      start: row.start,
      end: row.end,
      billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(row.start, readingDay)) ?? null,
    });
    summary.generationCoveragePercent = Number.isFinite(row.houseDemandKwh) && row.houseDemandKwh > 0 && Number.isFinite(summary.onSiteKwh)
      ? summary.onSiteKwh / row.houseDemandKwh * 100
      : null;
    return { key: row.key, label: row.label, ...summary };
  });
  const totals = summarizeEneFarmSamples(samples, config, {
    start,
    end,
    billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(start, readingDay)) ?? null,
  });
  totals.generationCoveragePercent = Number.isFinite(energy.totals.houseDemandKwh) && energy.totals.houseDemandKwh > 0 && Number.isFinite(totals.onSiteKwh)
    ? totals.onSiteKwh / energy.totals.houseDemandKwh * 100
    : null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    bucket,
    totals,
    buckets,
    estimateNotice: "All costs and savings are estimates. Check your provider statement for accurate billing information.",
  };
}

function isGuardTriggerLog(entry: any): any {
  return entry?.kind === "guard" ||
    String(entry?.message ?? "").includes("exceeds Charge Demand Guard limit");
}

function countGuardTriggersForRange(rules: any, start: any, end: any, options: any = {}): any {
  const startMs = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
  const endMs = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  const excludeTimes = options.excludeTimes ?? new Set();
  return rules
    .filter((rule: any) => rule.type === "backup-demand-guard")
    .flatMap((rule: any) => Array.isArray(rule.log) ? rule.log : [])
    .filter((entry: any) => {
      if (!isGuardTriggerLog(entry)) return false;
      const atMs = new Date(entry.at).getTime();
      if (excludeTimes.has(entry.at)) return false;
      return Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs;
    })
    .length;
}

async function readHistoryRange(start: any, end: any, config: any = DEFAULT_CONFIG): Promise<any> {
  await ensureDataDir();
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 60_000;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  // Interactive charts do not need every 5-second record across long ranges.
  // Using persisted interval rollups keeps 8h–30d responses bounded even when
  // the newest raw sample is a few seconds newer than the current rollup.
  const samples = endMs - startMs > 2 * 60 * 60_000
    ? historyStore.querySamples(startMs, endMs, { resolution: "interval" })
    : await readHistorySamplesInRange(startMs, endMs);
  const summarySamples = historyStore.querySamples(startMs, endMs, { resolution: "interval" });
  const guardTriggerSampleTimes = new Set(
    samples
      .filter((sample: any) => Number(sample.guardTriggerCount ?? 0) > 0 && sample.timestamp)
      .map((sample: any) => sample.timestamp),
  );
  const guardEvents = historyStore.eventsBetween("automation", startMs, endMs, ["guard-trigger"]);
  const persistedGuardTimes = new Set(guardEvents.map((event: any) => event.at));
  const guardTriggerCount = countGuardTriggersForRange(
    await readAutomationRules(),
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    { excludeTimes: new Set([...guardTriggerSampleTimes, ...persistedGuardTimes]) },
  ) + guardEvents.length;
  return {
    samples,
    summary: summarizeSamples(summarySamples, config, { guardTriggerCount, startMs, endMs }),
  };
}

async function readHistorySummaryRange(start: any, end: any, config: any = DEFAULT_CONFIG): Promise<any> {
  await ensureDataDir();
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 60_000;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  const summarySamples = historyStore.querySamples(startMs, endMs, { resolution: "interval" });
  const guardTriggerSampleTimes = new Set(
    summarySamples
      .filter((sample: any) => Number(sample.guardTriggerCount ?? 0) > 0 && sample.timestamp)
      .map((sample: any) => sample.timestamp),
  );
  const guardEvents = historyStore.eventsBetween("automation", startMs, endMs, ["guard-trigger"]);
  const persistedGuardTimes = new Set(guardEvents.map((event: any) => event.at));
  const guardTriggerCount = countGuardTriggersForRange(
    await readAutomationRules(),
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    { excludeTimes: new Set([...guardTriggerSampleTimes, ...persistedGuardTimes]) },
  ) + guardEvents.length;
  return summarizeSamples(summarySamples, config, { guardTriggerCount, startMs, endMs });
}

function readCalendarSavings(end: any, config: any = DEFAULT_CONFIG, todaySummary: any = null): any {
  const ranges = calendarSavingsRanges(end);
  const completedDayEndMs = ranges.today.startMs - 1;
  const earliestDailyStartMs = Math.min(ranges.lastMonth.startMs, ranges.year.startMs);
  const samples: any[] = [
    ...(completedDayEndMs >= earliestDailyStartMs
      ? historyStore.querySamples(earliestDailyStartMs, completedDayEndMs, { resolution: "interval" })
      : []),
    ...historyStore.querySamples(ranges.today.startMs, ranges.today.endMs, { resolution: "interval" }),
  ];
  return summarizeCalendarSavings(samples, config, end, todaySummary);
}

async function readEnergyReport(start: any, end: any, bucket: any, config: any = DEFAULT_CONFIG): Promise<any> {
  await ensureDataDir();
  const bucketMode = normalizeReportBucket(bucket ?? "day");
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 86_400_000;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  const samples = historyStore.querySamples(startMs, endMs, { resolution: "interval" });
  return {
    ...aggregateEnergyReportSamples(samples, {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      bucket: bucketMode,
      config,
    }),
    meta: {
      recordsRead: samples.length,
      recordsIncluded: samples.length,
      invalidRecords: 0,
      resolution: "30-minute",
    },
  };
}

async function readHistoryStats(): Promise<any> {
  return historyStore.stats();
}

function readCommandReceipts(limit: any = 25, beforeMs: any = Date.now()): any {
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 25)));
  const events = historyStore.recentEvents("command", Math.min(250, normalizedLimit * 8), beforeMs);
  const receipts = new Map();
  for (const event of events) {
    const commandId = event.payload?.commandId;
    if (!commandId) continue;
    if (!receipts.has(commandId)) {
      receipts.set(commandId, {
        commandId,
        action: event.payload?.action ?? "unknown",
        source: event.payload?.source ?? "unknown",
        target: event.payload?.target ?? null,
        request: event.payload?.request ?? {},
        state: event.type,
        requestedAt: null,
        completedAt: ["succeeded", "failed", "timed-out", "mismatched"].includes(event.type) ? event.at : null,
        message: event.message,
        error: event.payload?.error ?? null,
        verification: event.payload?.verification ?? null,
        durationMs: event.payload?.durationMs ?? null,
        events: [],
      });
    }
    const receipt = receipts.get(commandId);
    receipt.events.push(event);
    if (event.type === "requested") receipt.requestedAt = event.at;
  }
  return [...receipts.values()].slice(0, normalizedLimit);
}

function readCommandReceipt(commandId: any): any {
  const events = historyStore.eventsByKeyPrefix(`command:${commandId}:`);
  if (!events.length) return null;
  const ordered = [...events].reverse();
  const latest = ordered[0];
  const requested = events.find((event: any) => event.type === "requested");
  const terminal = ordered.find((event: any) => ["succeeded", "failed", "timed-out", "mismatched"].includes(event.type));
  return {
    commandId,
    action: latest.payload?.action ?? requested?.payload?.action ?? "unknown",
    source: latest.payload?.source ?? requested?.payload?.source ?? "unknown",
    target: latest.payload?.target ?? requested?.payload?.target ?? null,
    request: latest.payload?.request ?? requested?.payload?.request ?? {},
    state: latest.type,
    requestedAt: requested?.at ?? null,
    completedAt: terminal?.at ?? null,
    message: latest.message,
    error: terminal?.payload?.error ?? null,
    verification: terminal?.payload?.verification ?? null,
    durationMs: terminal?.payload?.durationMs ?? null,
    events: ordered,
  };
}

function nextScheduleAt(schedule: any, now: any = new Date()): any {
  if (!schedule.enabled) return null;
  if (schedule.repeat !== "daily") {
    const timestamp = new Date(schedule.runAt ?? "").getTime();
    return Number.isFinite(timestamp) && timestamp > now.getTime() ? new Date(timestamp).toISOString() : null;
  }
  if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) return null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : ALL_DAYS;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (days.includes(candidate.getDay()) && candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return null;
}

async function batteryStrategyView(now: any = new Date()): Promise<any> {
  const [config, adaptive, overrides, rules, schedules] = await Promise.all([
    readConfig(),
    readAdaptiveChargingState(),
    readOperationalOverridesState(),
    readAutomationRules(),
    readSchedules(),
  ]);
  const backup = backupPreparationView(overrides);
  const away = historyStore.isReady() ? awayPeriodsView(now) : { active: null, next: null, state: "home" };
  const guard = rules.find((rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
  const recentTerminal = readCommandReceipts(20, now.getTime())
    .find((receipt: any) => ["succeeded", "failed", "timed-out", "mismatched"].includes(receipt.state));
  const nextSchedule = schedules
    .map((schedule: any) => ({ schedule, at: nextScheduleAt(schedule, now) }))
    .filter((item: any) => item.at)
    .sort((left: any, right: any) => new Date(left.at).getTime() - new Date(right.at).getTime())[0] ?? null;
  const paused = adaptive.pausedUntil && new Date(adaptive.pausedUntil).getTime() > now.getTime();
  const manualDirect = recentTerminal?.state === "succeeded"
    && recentTerminal.source === "manual"
    && ["charge", "discharge", "set-mode"].includes(recentTerminal.action)
    && !(recentTerminal.action === "set-mode" && recentTerminal.request?.mode === "auto");
  const manualProfile = recentTerminal?.state === "succeeded" && recentTerminal.source === "manual" && recentTerminal.action === "vendor-profile";
  const scheduledCommand = recentTerminal?.state === "succeeded" && recentTerminal.source === "schedule";

  let strategy;
  if (backup.active) {
    strategy = { kind: "backup-preparation", title: "Disaster Prep", description: `Holding the ${backup.currentProfile ?? "backup"} profile while normal automation is suspended.` };
  } else if (guard) {
    strategy = { kind: "demand-guard", title: "Charging Demand Guard", description: "Standby is being held to preserve configured breaker headroom." };
  } else if (adaptive.owner === "adaptiveCharging") {
    strategy = { kind: "adaptive-charging", title: "Adaptive Charging", description: adaptive.plan?.reason ?? "The active charging plan currently owns battery operation." };
  } else if (away.active) {
    strategy = { kind: "away", title: "Away mode", description: `Away assumptions remain active until ${away.active.until}.` };
  } else if (manualDirect || manualProfile || paused) {
    strategy = {
      kind: "manual",
      title: "Manual control",
      description: paused
        ? `A manual battery action paused Adaptive Charging until ${adaptive.pausedUntil}.`
        : manualProfile
          ? `The ${recentTerminal.request?.mode ?? "selected"} charging profile was selected manually.`
          : "The latest direct battery command remains in effect until changed by another command or automation.",
    };
  } else if (config.adaptiveCharging?.enabled) {
    strategy = { kind: "adaptive-charging", title: "Adaptive Charging", description: adaptive.plan?.reason ?? "Waiting for the next planned charging window." };
  } else if (scheduledCommand) {
    strategy = { kind: "schedule", title: "Scheduled control", description: `The latest schedule applied ${recentTerminal.action}; that result remains in effect until another command or automation changes it.` };
  } else if (nextSchedule) {
    strategy = { kind: "schedule", title: "Scheduled control", description: `${nextSchedule.schedule.name} is next at ${nextSchedule.at}.` };
  } else {
    strategy = { kind: "device-auto", title: "Device-managed operation", description: "No application automation currently owns the battery." };
  }
  const upcomingAdaptiveSlot = adaptive.plan?.slots
    ?.filter((slot: any) => new Date(slot.end).getTime() > now.getTime())
    .sort((left: any, right: any) => new Date(left.start).getTime() - new Date(right.start).getTime())[0] ?? null;
  const nextAction = adaptive.owner === "adaptiveCharging" && adaptive.activeSlot
    ? {
        action: "continue-charging",
        title: "Continue charging",
        reason: adaptive.plan?.reason ?? "The active discounted window currently owns battery charging.",
        at: adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd ?? null,
        endAt: adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd ?? null,
        targetSocPercent: finiteNumberOrNull(adaptive.activeSlot.targetSocPercent),
        confidence: adaptive.solarForecastAccuracy?.learned ? "calibrated" : "initial",
        href: "/automation",
      }
    : config.adaptiveCharging?.enabled && upcomingAdaptiveSlot
      ? {
          action: "charge",
          title: "Charge",
          reason: adaptive.plan?.reason ?? "Charging is planned during a discounted period.",
          at: upcomingAdaptiveSlot.start,
          endAt: upcomingAdaptiveSlot.end,
          targetSocPercent: finiteNumberOrNull(upcomingAdaptiveSlot.targetSocPercent),
          confidence: adaptive.solarForecastAccuracy?.learned ? "calibrated" : "initial",
          href: "/automation",
        }
      : nextSchedule
        ? {
            title: nextSchedule.schedule.name,
            reason: `${nextSchedule.schedule.action} is the next enabled battery schedule.`,
            at: nextSchedule.at,
            targetSocPercent: null,
            confidence: null,
            href: "/battery/schedules",
          }
        : {
            title: config.adaptiveCharging?.enabled ? "No grid charging currently planned" : "No application action scheduled",
            reason: adaptive.plan?.reason ?? "The battery remains under its current strategy until conditions change.",
            at: null,
            targetSocPercent: null,
            confidence: config.adaptiveCharging?.enabled ? (adaptive.solarForecastAccuracy?.learned ? "calibrated" : "initial") : null,
            href: config.adaptiveCharging?.enabled ? "/automation" : "/battery/schedules",
          };
  return {
    ...strategy,
    manualOverride: manualDirect || manualProfile || paused ? {
      active: true,
      label: manualDirect ? `${recentTerminal.action} override` : manualProfile ? `${recentTerminal.request?.mode ?? "Profile"} override` : "Manual override",
      until: paused ? adaptive.pausedUntil : null,
      untilChanged: !paused,
    } : { active: false },
    nextSchedule: nextSchedule ? { id: nextSchedule.schedule.id, name: nextSchedule.schedule.name, action: nextSchedule.schedule.action, at: nextSchedule.at } : null,
    nextAction,
  };
}

async function systemAlertsView(snapshot: any, now: any = new Date()): Promise<any> {
  const [config, adaptiveState, rules, schedules, notifications] = await Promise.all([
    readConfig(),
    readAdaptiveChargingState(),
    readAutomationRules(),
    readSchedules(),
    notificationService.view(),
  ]);
  const alerts: any[] = [];
  const add = (alert: any) => alerts.push({ resolution: "active", ...alert });
  const equipmentErrors = [
    snapshot?.energy?.error,
    snapshot?.energy?.battery?.error,
    snapshot?.energy?.solar?.error,
    ...(snapshot?.energy?.fuel_cells ?? []).map((item: any) => item.error),
    ...(snapshot?.energy?.errors ?? []).map((item: any) => item.error),
    snapshot?.meter?.error,
    ...(snapshot?.meter?.errors ?? []).map((item: any) => item.error),
  ].filter(Boolean);
  if (equipmentErrors.length) {
    add({
      id: "equipment",
      source: equipmentErrors.some((error: any) => /timeout|unreachable|network|EHOST|ENET/i.test(String(error))) ? "Local network" : "Device",
      severity: "warning",
      title: `${equipmentErrors.length} equipment issue${equipmentErrors.length === 1 ? "" : "s"}`,
      startedAt: snapshot?.read_at ?? now.toISOString(),
      impact: equipmentErrors[0],
      suggestedAction: "Inspect configured equipment and its latest contact status.",
      href: "/system/equipment",
    });
  }
  if (snapshot?.energy?.battery?.configured === false) {
    add({
      id: "battery-configuration",
      source: "Configuration",
      severity: "warning",
      title: "Battery configuration incomplete",
      startedAt: snapshot?.read_at ?? now.toISOString(),
      impact: "Battery state and controls are unavailable until equipment is configured.",
      suggestedAction: "Review the battery address and installed-equipment settings.",
      href: "/system/equipment",
    });
  }
  const adaptive = adaptiveChargingView(config, adaptiveState, rules);
  if (config.adaptiveCharging?.enabled && adaptive.paused) {
    add({
      id: "automation-paused",
      source: "Automation",
      severity: "warning",
      title: "Adaptive Charging paused",
      startedAt: adaptiveState.updatedAt ?? now.toISOString(),
      impact: adaptive.reason ?? "The active plan cannot currently control battery charging.",
      suggestedAction: "Review the active override and resume automation when appropriate.",
      href: "/automation",
    });
  } else if (config.adaptiveCharging?.enabled && !adaptive.available) {
    add({
      id: "automation-degraded",
      source: /weather|forecast/i.test(String(adaptive.reason ?? "")) ? "Weather service" : "Automation",
      severity: "critical",
      title: "Adaptive Charging degraded",
      startedAt: adaptiveState.updatedAt ?? now.toISOString(),
      impact: adaptive.reason ?? "A safe charging plan cannot currently be produced.",
      suggestedAction: "Review prerequisites and forecast status.",
      href: "/automation",
    });
  }
  const failedReceipt = readCommandReceipts(25, now.getTime()).find((receipt: any) =>
    ["failed", "timed-out", "mismatched"].includes(receipt.state)
      && now.getTime() - new Date(receipt.completedAt ?? receipt.requestedAt ?? 0).getTime() <= 24 * 60 * 60_000,
  );
  if (failedReceipt) {
    add({
      id: `command:${failedReceipt.commandId}`,
      source: "Battery command",
      severity: "critical",
      title: "Battery command needs review",
      startedAt: failedReceipt.completedAt ?? failedReceipt.requestedAt ?? now.toISOString(),
      impact: failedReceipt.error ?? failedReceipt.message ?? `${failedReceipt.action} did not complete successfully.`,
      suggestedAction: "Review the command receipt and current battery state before retrying.",
      href: "/battery",
    });
  }
  const failedSchedule = schedules
    .filter((schedule: any) => schedule.lastResult?.ok === false)
    .sort((left: any, right: any) => new Date(right.lastResult?.at ?? 0).getTime() - new Date(left.lastResult?.at ?? 0).getTime())[0];
  if (failedSchedule) {
    add({
      id: `schedule:${failedSchedule.id}`,
      source: "Schedule",
      severity: "warning",
      title: `Schedule failed: ${failedSchedule.name}`,
      startedAt: failedSchedule.lastResult.at ?? now.toISOString(),
      impact: failedSchedule.lastResult.error ?? "The scheduled battery action did not complete.",
      suggestedAction: "Review the schedule result and command activity.",
      href: "/battery/schedules",
    });
  }
  const latestDelivery = notifications.deliveries?.[0];
  const failedDelivery = latestDelivery?.ok === false ? latestDelivery : null;
  if (failedDelivery) {
    add({
      id: `notification:${failedDelivery.at ?? "latest"}`,
      source: "SMTP",
      severity: "warning",
      title: "Notification delivery failed",
      startedAt: failedDelivery.at ?? now.toISOString(),
      impact: failedDelivery.attempts?.find((attempt: any) => attempt.error)?.error ?? "A configured notification channel rejected the latest delivery.",
      suggestedAction: "Review SMTP configuration and recent delivery history.",
      href: "/system/notifications",
    });
  }
  if (databaseOperation.busy || databaseOperation.error) {
    add({
      id: "database",
      source: "Application database",
      severity: databaseOperation.error ? "critical" : "warning",
      title: databaseOperation.busy ? "Database maintenance in progress" : "Database operation failed",
      startedAt: databaseOperation.startedAt ?? now.toISOString(),
      impact: databaseOperation.error ?? "Historical data administration is temporarily limiting application work.",
      suggestedAction: "Review database health, maintenance, and backup state.",
      href: "/system/data",
    });
  }
  return alerts.sort((left: any, right: any) => {
    const rank: Record<string, any> = { critical: 0, warning: 1, info: 2 };
    return rank[left.severity] - rank[right.severity]
      || new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
  });
}

async function trimHistory(retention: any): Promise<any> {
  adaptiveChargingHistoryCache = null;
  return historyStore.applyRetention(retention);
}

async function readSchedules(): Promise<any> {
  const stored = applicationStore.readDocument("schedules", []);
  return Array.isArray(stored) ? stored : [];
}

async function writeSchedules(schedules: any): Promise<any> {
  applicationStore.writeDocument("schedules", schedules);
}

function mutateSchedules(mutator: any): any {
  const task = scheduleMutationQueue.then(async () => {
    const schedules = await readSchedules();
    const result = await mutator(schedules);
    await writeSchedules(schedules);
    return result;
  });
  scheduleMutationQueue = task.catch(() => {});
  return task;
}

function normalizeHostList(value: any): any {
  if (Array.isArray(value)) return value.map((item: any) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((host: any) => host.trim())
    .filter(Boolean);
}

function configBool(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function configNumber(value: any, fallback: any, min: any = 0, max: any = 1000): any {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function optionalConfigNumber(value: any, min: any, max: any): any {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function optionalSteppedConfigNumber(value: any, min: any, max: any, step: any): any {
  const number = optionalConfigNumber(value, min, max);
  if (number === null) return null;
  return Math.max(min, Math.min(max, Math.round(number / step) * step));
}

function isValidTime(value: any): any {
  if (!/^\d{2}:\d{2}$/.test(String(value ?? ""))) return false;
  const [hh, mm] = String(value).split(":").map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function minutesOfDay(value: any): any {
  if (!isValidTime(value)) return null;
  const [hh, mm] = String(value).split(":").map(Number);
  return hh * 60 + mm;
}

function normalizeSubnets(value: any): any {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(items.map((item: any) => String(item).trim()).filter(Boolean))]
    .filter((item: any) => /^(\d{1,3}\.){3}0\/24$/.test(item))
    .filter((item: any) => item.split(".").slice(0, 3).every((part: any) => Number(part) >= 0 && Number(part) <= 255));
}

function normalizeRateMode(input: any = {}): any {
  if (["simple", "offPeak", "multi"].includes(input.rateMode)) return input.rateMode;
  if (input.offPeakSavingsEnabled === true) {
    return Array.isArray(input.rateBands) && input.rateBands.length > 2 ? "multi" : "offPeak";
  }
  return DEFAULT_CONFIG.rateMode;
}

function normalizeRateBands(input: any = {}): any {
  const hasRateMode = ["simple", "offPeak", "multi"].includes(input.rateMode);
  const rateMode = hasRateMode ? input.rateMode : normalizeRateMode(input);
  const standardRate = configNumber(input.standardRateYenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000);
  const offPeakRate = configNumber(input.offPeakRateYenPerKwh, DEFAULT_CONFIG.offPeakRateYenPerKwh, 0, 1000);
  const source = !hasRateMode && Array.isArray(input.rateBands) && input.rateBands.length
    ? input.rateBands
    : rateMode === "simple"
    ? [{ start: "00:00", end: "00:00", yenPerKwh: standardRate, label: "Simple" }]
    : rateMode === "offPeak"
      ? [
        { start: "00:00", end: "07:00", yenPerKwh: offPeakRate, label: "Off-peak" },
        { start: "07:00", end: "00:00", yenPerKwh: standardRate, label: "Standard" },
      ]
      : Array.isArray(input.rateBands) && input.rateBands.length
        ? input.rateBands
        : [{ start: "00:00", end: "07:00", yenPerKwh: offPeakRate, label: "Off-peak" }];
  const bands = source
    .map((band: any) => ({
      start: isValidTime(band.start) ? band.start : "00:00",
      end: isValidTime(band.end) ? band.end : "00:00",
      yenPerKwh: configNumber(band.yenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000),
      label: String(band.label ?? "").trim(),
    }));
  return bands.length ? bands : DEFAULT_CONFIG.rateBands;
}

function normalizeBatteryCapabilities(value: any = {}): any {
  return {
    usableCapacityKwh: optionalConfigNumber(value.usableCapacityKwh, 0.1, 1000),
    maximumChargeWatts: optionalSteppedConfigNumber(value.maximumChargeWatts, 50, 100000, 1),
  };
}

function normalizeAdaptiveCharging(value: any = {}): any {
  return {
    enabled: configBool(value.enabled, DEFAULT_CONFIG.adaptiveCharging.enabled),
    latitude: optionalConfigNumber(value.latitude, -90, 90),
    longitude: optionalConfigNumber(value.longitude, -180, 180),
    arrayPeakKw: optionalConfigNumber(value.arrayPeakKw, 0.1, 10000),
    panelTiltDegrees: configNumber(value.panelTiltDegrees, DEFAULT_CONFIG.adaptiveCharging.panelTiltDegrees, 0, 90),
    panelAzimuthDegrees: configNumber(value.panelAzimuthDegrees, DEFAULT_CONFIG.adaptiveCharging.panelAzimuthDegrees, -180, 180),
    systemLossPercent: configNumber(value.systemLossPercent, DEFAULT_CONFIG.adaptiveCharging.systemLossPercent, 0, 50),
    targetSocPercent: configNumber(value.targetSocPercent, DEFAULT_CONFIG.adaptiveCharging.targetSocPercent, 50, 100),
    forecastMarginPercent: configNumber(value.forecastMarginPercent, DEFAULT_CONFIG.adaptiveCharging.forecastMarginPercent, 0, 50),
  };
}

function normalizeFuelCellConfig(value: any = {}): any {
  const tariff = value.tariff ?? {};
  const region = String(tariff.region ?? "tokyo").trim();
  const discount = String(tariff.equipmentDiscount ?? "").trim();
  return {
    includeInAdaptiveCharging: configBool(value.includeInAdaptiveCharging, false),
    gasCo2KgPerM3: configNumber(value.gasCo2KgPerM3, 2.21, 0, 100),
    tariff: {
      provider: String(tariff.provider ?? "tokyo-gas").trim() || "tokyo-gas",
      region: ["tokyo", "gunma"].includes(region) ? region : "tokyo",
      plan: "enefarm",
      equipmentDiscount: ["bath", "floor", "set"].includes(discount) ? discount : "",
      meterReadingDay: configNumber(tariff.meterReadingDay, 1, 1, 31),
      automaticUpdates: configBool(tariff.automaticUpdates, false),
      marginalRateOverrideYenPerM3: optionalConfigNumber(tariff.marginalRateOverrideYenPerM3, 0, 100000),
    },
  };
}

function normalizeFuelCellHosts(input: any = {}): any {
  const legacy = normalizeHostList(input.fuelCellHosts ?? DEFAULT_CONFIG.fuelCellHosts);
  const configuredPrimary = String(input.fuelCellPrimaryHost ?? "").trim();
  const primary = configuredPrimary && configuredPrimary !== input.meterHost
    ? configuredPrimary
    : legacy.find((host: any) => host !== input.meterHost) ?? "";
  const configuredProxies = input.fuelCellProxyHosts === undefined
    ? legacy.filter((host: any) => host !== primary)
    : normalizeHostList(input.fuelCellProxyHosts);
  const proxies = [...new Set([
    ...configuredProxies,
    ...(configuredPrimary === input.meterHost ? [configuredPrimary] : []),
    ...legacy.filter((host: any) => host === input.meterHost && host !== primary),
  ])].filter((host: any) => host && host !== primary);
  return { primary, proxies, all: [...new Set([primary, ...proxies].filter(Boolean))] };
}

function normalizeDashboardWidgets(value: any = []): any {
  const inputById = new Map<string, any>(
    (Array.isArray(value) ? value : [])
      .map((widget: any) => [String(widget?.id ?? ""), widget] as [string, any])
      .filter(([id]: any) => DEFAULT_DASHBOARD_WIDGETS.some((item: any) => item.id === id)),
  );
  return DEFAULT_DASHBOARD_WIDGETS.map((defaults: any) => {
    const input: any = inputById.get(defaults.id) ?? {};
    return {
      id: defaults.id,
      group: defaults.group,
      visible: configBool(input.visible, defaults.visible),
      priority: configNumber(input.priority, defaults.priority, 0, 10000),
    };
  });
}

function normalizeCircuitSortMode(value: any): any {
  if (value === "energy") return "current";
  return ["number", "current", "accumulated"].includes(value)
    ? value
    : DEFAULT_CONFIG.circuitSortMode;
}

function normalizeSettingCache(value: any = {}): any {
  const out: Record<string, any> = {};
  for (const key of ["discharge_limit", "osaifu_charge_window", "osaifu_discharge_window"]) {
    const cached = value?.[key];
    if (cached?.lastKnown) {
      out[key] = {
        lastKnown: cached.lastKnown,
        lastReadAt: cached.lastReadAt ?? null,
      };
    }
  }
  return out;
}

function normalizeRetentionConfig(value: any = {}, legacyDays: any = undefined): any {
  return {
    ...normalizeRetentionPolicy(value, legacyDays),
    automaticMaintenance: configBool(value.automaticMaintenance, true),
  };
}

function cleanConfig(input: any = {}): any {
  // Config can arrive from old files, forms, or hand-edited JSON. Normalize it
  // here so the rest of the server can assume stable types.
  const rateMode = normalizeRateMode(input);
  const rateBands = normalizeRateBands({ ...input, rateMode });
  const standardRate = configNumber(input.standardRateYenPerKwh, Math.max(...rateBands.map((band: any) => band.yenPerKwh)));
  const offPeakRate = configNumber(input.offPeakRateYenPerKwh, Math.min(...rateBands.map((band: any) => band.yenPerKwh)));
  const fuelCellHosts = normalizeFuelCellHosts(input);
  return {
    batteryHost: String(input.batteryHost ?? DEFAULT_CONFIG.batteryHost).trim(),
    meterHost: String(input.meterHost ?? DEFAULT_CONFIG.meterHost).trim(),
    meterEoj: String(input.meterEoj ?? DEFAULT_CONFIG.meterEoj).trim() || DEFAULT_CONFIG.meterEoj,
    smartCosmoEnabled: configBool(input.smartCosmoEnabled, DEFAULT_CONFIG.smartCosmoEnabled),
    circuitLabels: normalizeCircuitLabels(input.circuitLabels ?? DEFAULT_CONFIG.circuitLabels),
    circuitDashboardVisibility: normalizeCircuitDashboardVisibility(
      input.circuitDashboardVisibility ?? DEFAULT_CONFIG.circuitDashboardVisibility,
    ),
    circuitSortMode: normalizeCircuitSortMode(input.circuitSortMode),
    solarHost: String(input.solarHost ?? input.batteryHost ?? DEFAULT_CONFIG.solarHost).trim(),
    solarEnabled: configBool(input.solarEnabled, DEFAULT_CONFIG.solarEnabled),
    fuelCellHosts: fuelCellHosts.all,
    fuelCellPrimaryHost: fuelCellHosts.primary,
    fuelCellProxyHosts: fuelCellHosts.proxies,
    fuelCellEnabled: configBool(input.fuelCellEnabled, DEFAULT_CONFIG.fuelCellEnabled),
    fuelCell: normalizeFuelCellConfig(input.fuelCell ?? {}),
    rateMode,
    standardRateYenPerKwh: standardRate,
    offPeakRateYenPerKwh: offPeakRate,
    offPeakSavingsEnabled: rateMode !== "simple",
    co2TonnesPerKwh: configNumber(input.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1),
    discoverySubnets: normalizeSubnets(input.discoverySubnets),
    retention: normalizeRetentionConfig(input.retention, input.historyRetentionDays),
    updateIntervalSeconds: configNumber(input.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 5, 3600),
    rateBands,
    batteryCapabilities: normalizeBatteryCapabilities(input.batteryCapabilities ?? {}),
    adaptiveCharging: normalizeAdaptiveCharging(input.adaptiveCharging ?? {}),
    notifications: {
      ...normalizeNotificationConfig(input.notifications ?? {}),
      ...(EXTERNAL_IO_DISABLED ? { enabled: false } : {}),
    },
    dashboardWidgets: normalizeDashboardWidgets(input.dashboardWidgets),
    settingCache: normalizeSettingCache(input.settingCache ?? {}),
    language: ["en", "ja"].includes(input.language) ? input.language : DEFAULT_CONFIG.language,
  };
}

async function readConfig(): Promise<any> {
  return cleanConfig(applicationStore.readDocument("config", DEFAULT_CONFIG));
}

async function commitConfig(previous: any, config: any): Promise<any> {
  const cleaned = cleanConfig(config);
  await ensureDataDir();
  const hostKeys: any[] = ["batteryHost", "meterHost", "meterEoj", "solarHost"];
  const hostChanged = hostKeys.some((key: any) => previous[key] !== cleaned[key])
    || JSON.stringify(previous.fuelCellHosts) !== JSON.stringify(cleaned.fuelCellHosts);
  const adaptiveChargingInputsChanged = JSON.stringify({
    batteryHost: previous.batteryHost,
    meterHost: previous.meterHost,
    meterEoj: previous.meterEoj,
    solarHost: previous.solarHost,
    solarEnabled: previous.solarEnabled,
    smartCosmoEnabled: previous.smartCosmoEnabled,
    rateMode: previous.rateMode,
    rateBands: previous.rateBands,
    standardRateYenPerKwh: previous.standardRateYenPerKwh,
    batteryCapabilities: previous.batteryCapabilities,
    adaptiveCharging: previous.adaptiveCharging,
    fuelCellEnabled: previous.fuelCellEnabled,
    fuelCellForecastInfluence: previous.fuelCell?.includeInAdaptiveCharging,
  }) !== JSON.stringify({
    batteryHost: cleaned.batteryHost,
    meterHost: cleaned.meterHost,
    meterEoj: cleaned.meterEoj,
    solarHost: cleaned.solarHost,
    solarEnabled: cleaned.solarEnabled,
    smartCosmoEnabled: cleaned.smartCosmoEnabled,
    rateMode: cleaned.rateMode,
    rateBands: cleaned.rateBands,
    standardRateYenPerKwh: cleaned.standardRateYenPerKwh,
    batteryCapabilities: cleaned.batteryCapabilities,
    adaptiveCharging: cleaned.adaptiveCharging,
    fuelCellEnabled: cleaned.fuelCellEnabled,
    fuelCellForecastInfluence: cleaned.fuelCell?.includeInAdaptiveCharging,
  });
  if (adaptiveChargingInputsChanged) {
    const state = await readAdaptiveChargingState();
    const backupPreparationActive = backupPreparationBlocksActions(
      await readOperationalOverridesState(),
    );
    const changedAt = new Date();
    state.plan = null;
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.lastPlanEventKey = null;
    queueAdaptiveChargingPlanRefresh(state, "configuration changed", changedAt);
    const forecastInputsChanged = JSON.stringify({
      latitude: previous.adaptiveCharging.latitude,
      longitude: previous.adaptiveCharging.longitude,
      tilt: previous.adaptiveCharging.panelTiltDegrees,
      azimuth: previous.adaptiveCharging.panelAzimuthDegrees,
    }) !== JSON.stringify({
      latitude: cleaned.adaptiveCharging.latitude,
      longitude: cleaned.adaptiveCharging.longitude,
      tilt: cleaned.adaptiveCharging.panelTiltDegrees,
      azimuth: cleaned.adaptiveCharging.panelAzimuthDegrees,
    });
    if (forecastInputsChanged) {
      state.forecast = null;
      state.historicalWeatherFetchedAt = null;
    }
    if (backupPreparationActive) {
      state.owner = null;
      state.activeSlot = null;
      state.activePlanCreatedAt = null;
      state.activeChargedKwh = 0;
      state.activeLastCheckedAt = null;
      state.activeChargeSession = null;
      state.interruptedCharge = null;
      state.breakerRecovery = null;
      state.standbyHoldUntil = null;
      appendAdaptiveChargingLog(
        state,
        "Adaptive Charging configuration changed while Backup Preparation retained battery control",
        "pause",
        changedAt,
      );
    } else if (state.owner === "adaptiveCharging") {
      const reason = adaptiveChargingConfiguredActive(cleaned)
        ? "Adaptive Charging configuration changed"
        : "Adaptive Charging was disabled";
      await releaseAdaptiveCharge(state, reason, changedAt, previous.batteryHost);
    } else if (state.standbyHoldUntil) {
      await executeAction("set-mode", { mode: "auto", host: previous.batteryHost });
      appendAdaptiveChargingLog(
        state,
        "Adaptive Charging configuration changed; releasing Standby hold and restoring operation mode to Auto",
        "stop",
        changedAt,
      );
      state.standbyHoldUntil = null;
    }
    if (state.activeWindowExecution) {
      finalizeAdaptiveChargingWindowExecution(
        state,
        state.activeWindowExecution.latestSocPercent,
        changedAt,
        "adaptive charging configuration changed",
      );
    }
    await writeAdaptiveChargingState(state);
  }
  applicationStore.writeDocument("config", cleaned);
  if (hostChanged) {
    lastRecordedSample = null;
    invalidateStatusSnapshot();
  }
  return cleaned;
}

function updateConfig(mutator: any): any {
  const task = configMutationQueue.then(async () => {
    const previous = await readConfig().catch(() => cleanConfig(DEFAULT_CONFIG));
    const proposed = await mutator(structuredClone(previous));
    return commitConfig(previous, proposed);
  });
  configMutationQueue = task.catch(() => {});
  return task;
}

function writeConfig(config: any): any {
  return updateConfig((previous: any) => ({ ...previous, ...config }));
}

async function readAutomationRules(): Promise<any> {
  const configs = await readAutomationRuleConfigs();
  const states = await readAutomationRuleStates();
  return configs.map((config: any) => mergeAutomationRule(config, states[config.id] ?? {}));
}

async function readAutomationRuleConfigs(): Promise<any> {
  const parsed = applicationStore.readDocument("automationRules", []);
  return (Array.isArray(parsed) ? parsed : []).map(cleanAutomationRuleConfig);
}

function normalizeAutomationRuleStateFile(value: any = {}): any {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([id]: any) => id)
      .map(([id, state]: any) => [id, cleanAutomationRuleState(state)]),
  );
}

async function readAutomationRuleStates(): Promise<any> {
  return normalizeAutomationRuleStateFile(applicationStore.readDocument("automationRuleState", {}));
}

async function writeAutomationRules(rules: any): Promise<any> {
  const cleaned = rules.map(cleanAutomationRuleConfig);
  applicationStore.writeDocument("automationRules", cleaned);
  return cleaned;
}

async function writeAutomationRuleStates(rules: any): Promise<any> {
  const states = Object.fromEntries(
    rules.map((rule: any) => [rule.id, cleanAutomationRuleState(rule)]),
  );
  applicationStore.writeDocument("automationRuleState", states);
  if (historyStore.isReady()) {
    for (const rule of rules) {
      for (const entry of rule.log ?? []) {
        historyStore.recordEvent({
          eventKey: `automation:${rule.id}:${entry.at}:${entry.kind ?? "log"}:${entry.message}`,
          at: entry.at,
          category: "automation",
          type: entry.kind ?? "log",
          message: entry.message,
          payload: { ruleId: rule.id, ruleType: rule.type },
        });
      }
    }
  }
  return states;
}

async function readBody(req: any): Promise<any> {
  return readJsonBody(req, parseJsonWithContext);
}

function awayTimestamp(value: any, label: any): any {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw requestError(400, `${label} must be a valid date and time`);
  return time;
}

function awayPeriodRange(period: any): any {
  return {
    startMs: new Date(period.from).getTime(),
    untilMs: new Date(period.until).getTime(),
  };
}

function awayPeriodsOverlap(left: any, right: any): any {
  const leftRange = awayPeriodRange(left);
  const rightRange = awayPeriodRange(right);
  return leftRange.startMs < rightRange.untilMs && leftRange.untilMs > rightRange.startMs;
}

function ensureAwayPeriodDoesNotOverlap(period: any, excludeId: any = null): any {
  const conflict = historyStore.awayPeriods({ includeCompleted: true })
    .find((candidate: any) => candidate.id !== excludeId && awayPeriodsOverlap(period, candidate));
  if (conflict) {
    throw requestError(
      409,
      `Away period overlaps the existing period from ${conflict.from} until ${conflict.until}`,
    );
  }
}

function awayPeriodsView(now: any = new Date()): any {
  const nowMs = now.getTime();
  const periods = historyStore.awayPeriods({ includeCompleted: false, nowMs });
  return {
    periods,
    active: periods.find((period: any) => period.status === "active") ?? null,
    next: periods.find((period: any) => period.status === "scheduled") ?? null,
    state: periods.some((period: any) => period.status === "active") ? "away" : "home",
    returnBufferMinutes: AWAY_RETURN_BUFFER_MS / 60_000,
  };
}

function cleanNewAwayPeriod(body: any, now: any = new Date()): any {
  const from = awayTimestamp(body.from, "From");
  const until = awayTimestamp(body.until, "Until");
  if (from.getTime() < now.getTime() - 60_000) throw requestError(400, "From cannot be in the past");
  if (until.getTime() <= from.getTime()) throw requestError(400, "Until must be after From");
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    from: from.toISOString(),
    until: until.toISOString(),
    source: body.source === "manual" ? "manual" : "scheduled",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function queueAdaptiveChargingForAwayChange(reason: any, now: any = new Date()): Promise<any> {
  const state = await readAdaptiveChargingState();
  queueAdaptiveChargingPlanRefresh(state, reason, now);
  state.lastPlanEventKey = null;
  appendAdaptiveChargingLog(state, `${reason}; Adaptive Charging recalculation queued`, "away", now);
  await writeAdaptiveChargingState(state);
}

function numberInRange(value: any, label: any, min: any, max: any, step: any = 1): any {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max || n % step !== 0) {
    throw new Error(`${label} must be an integer from ${min} to ${max}${step > 1 ? ` in ${step} steps` : ""}`);
  }
  return n;
}

function hostFrom(body: any, config: any): any {
  return body.host || config.batteryHost;
}

function fuelCellArgs(config: any = {}): any {
  return {
    ...(config.fuelCellPrimaryHost ? { "fuel-cell-primary-host": config.fuelCellPrimaryHost } : {}),
    ...(config.fuelCellProxyHosts?.length ? { "fuel-cell-proxy-host": config.fuelCellProxyHosts } : {}),
  };
}

function isDocumentationHost(host: any): any {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(String(host ?? ""));
}

async function readMeterStatus(config: any): Promise<any> {
  if (config.smartCosmoEnabled === false || !config.meterHost || isDocumentationHost(config.meterHost)) {
    return { configured: false, host: null };
  }
  try {
    return {
      configured: true,
      ...((await runDeviceCommandQueued("meter-status", { host: config.meterHost, eoj: config.meterEoj })) as Record<string, unknown>),
    };
  } catch (err: any) {
    return {
      configured: true,
      host: config.meterHost,
      eoj: config.meterEoj,
      error: err.message,
    };
  }
}

async function safeCli(command: any, args: any = {}, positional: any = []): Promise<any> {
  try {
    return await runDeviceCommandQueued(command, args, positional);
  } catch (err: any) {
    return { error: err.message };
  }
}

async function settingWithCache(config: any, key: any, reader: any): Promise<any> {
  const cached = config.settingCache?.[key] ?? null;
  const data = await reader();
  if (data && !data.error && (data.raw || data.decoded)) {
    await updateConfig((current: any) => ({
      ...current,
      settingCache: {
        ...(current.settingCache ?? {}),
        [key]: {
          lastKnown: data,
          lastReadAt: new Date().toISOString(),
        },
      },
    }));
    return { ...data, available: true };
  }
  return {
    ...(data ?? {}),
    available: false,
    lastKnown: cached?.lastKnown ?? null,
    lastReadAt: cached?.lastReadAt ?? null,
    error: data?.error ?? "setting unavailable in current device mode",
  };
}

async function readAllStatus(onProbeComplete: any = () => {}): Promise<any> {
  // One dashboard refresh fans out into several ECHONET operations. The queue
  // serializes access to the persistent UDP client and prioritizes writes.
  const config = await readConfig();
  const energyArgs: Record<string, any> = {
    "battery-host": config.batteryHost,
    ...(config.solarEnabled ? { "solar-host": config.solarHost } : { "no-solar": true }),
    ...(config.fuelCellEnabled ? fuelCellArgs(config) : { "no-fuel-cell": true }),
  };
  const batteryConfigured = config.batteryHost && !isDocumentationHost(config.batteryHost);
  const skippedSetting: Record<string, any> = { available: false, error: "battery host is not configured", lastKnown: null, lastReadAt: null };
  const probe = async (label: any, reader: any) => {
    const startedAt = Date.now();
    try {
      return await reader();
    } finally {
      onProbeComplete({ label, durationMs: Date.now() - startedAt });
    }
  };
  const [energy, meter, mode, dischargeLimit, chargeWindow, dischargeWindow, vendor] = await Promise.all([
    probe("energy status", () => batteryConfigured ? safeCli("energy-status", energyArgs) : Promise.resolve({ battery: { configured: false } })),
    probe("home power meter status", () => readMeterStatus(config)),
    probe("charging profile", () => batteryConfigured ? safeCli("vendor-profile", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" })),
    probe("discharge limit", () => batteryConfigured ? settingWithCache(config, "discharge_limit", () => safeCli("discharge-limit", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
    probe("osaifu charge window", () => batteryConfigured ? settingWithCache(config, "osaifu_charge_window", () => safeCli("osaifu-charge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
    probe("osaifu discharge window", () => batteryConfigured ? settingWithCache(config, "osaifu_discharge_window", () => safeCli("osaifu-discharge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting)),
    probe("vendor properties", () => batteryConfigured ? safeCli("dump-vendor", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" })),
  ]);

  async function hydrateWindowRaw(windowData: any, epcHex: any): Promise<any> {
    // Some profile/window helpers may return null decoded data if a device is in
    // a mode where that property is unavailable. A raw-get retry gives the UI the
    // best chance to populate selectors without inventing fallback values.
    if (!batteryConfigured || windowData?.raw) return windowData;
    try {
      const rawRead = await safeCli("raw-get", { host: config.batteryHost, eoj: "0x027D01" }, [epcHex]);
      if (rawRead?.raw) {
        return {
          ...windowData,
          raw: rawRead.raw,
        };
      }
    } catch {
      return windowData;
    }
    return windowData;
  }

  const chargeWindowRead = await probe("osaifu charge window raw fallback", () => hydrateWindowRaw(chargeWindow, "0xF4"));
  const dischargeWindowRead = await probe("osaifu discharge window raw fallback", () => hydrateWindowRaw(dischargeWindow, "0xF5"));
  const status: Record<string, any> = {
    hosts: {
      battery: config.batteryHost,
      meter: config.smartCosmoEnabled ? config.meterHost || null : null,
      solar: config.solarEnabled ? config.solarHost : null,
      fuel_cells: config.fuelCellEnabled ? config.fuelCellHosts : [],
      fuel_cell_primary: config.fuelCellEnabled ? config.fuelCellPrimaryHost : null,
      fuel_cell_proxies: config.fuelCellEnabled ? config.fuelCellProxyHosts : [],
    },
    features: {
      smartCosmoEnabled: config.smartCosmoEnabled,
      solarEnabled: config.solarEnabled,
      fuelCellEnabled: config.fuelCellEnabled,
      rateMode: config.rateMode,
      offPeakSavingsEnabled: config.offPeakSavingsEnabled,
    },
    energy,
    meter,
    settings: {
      mode,
      discharge_limit: dischargeLimit,
      osaifu_charge_window: chargeWindowRead,
      osaifu_discharge_window: dischargeWindowRead,
      vendor,
    },
    read_at: new Date().toISOString(),
  };
  status.rates = {
    rateMode: config.rateMode,
    standardRateYenPerKwh: config.standardRateYenPerKwh,
    offPeakRateYenPerKwh: config.offPeakRateYenPerKwh,
    offPeakSavingsEnabled: config.offPeakSavingsEnabled,
    rateBands: config.rateBands,
  };
  status.sample = await recordStatusSample(status, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  status.savings = (await readHistoryRange(today.toISOString(), status.read_at, config)).summary;
  status.savingsPeriods = readCalendarSavings(status.read_at, config, status.savings);
  return status;
}

function statusSnapshotAgeMs(now: any = Date.now()): any {
  const readAt = new Date(latestStatusSnapshot?.read_at).getTime();
  return Number.isFinite(readAt) ? Math.max(0, now - readAt) : Number.POSITIVE_INFINITY;
}

async function refreshStatusSnapshot(onProbeComplete: any = () => {}): Promise<any> {
  if (statusRefreshPromise) return statusRefreshPromise;
  statusRefreshPromise = readAllStatus(onProbeComplete)
    .then((status: any) => {
      latestStatusSnapshot = status;
      return status;
    })
    .finally(() => {
      statusRefreshPromise = null;
    });
  return statusRefreshPromise;
}

async function getStatusSnapshot({ maxAgeMs = 0, force = false, onProbeComplete = () => {} }: any = {}): Promise<any> {
  if (!force && latestStatusSnapshot && statusSnapshotAgeMs() <= Math.max(0, Number(maxAgeMs) || 0)) {
    return latestStatusSnapshot;
  }
  return refreshStatusSnapshot(onProbeComplete);
}

function invalidateStatusSnapshot(): any {
  latestStatusSnapshot = null;
}

function deviceStatusFailures(status: any, config: any): any {
  const failures: any[] = [];
  const energyError = status.energy?.error;
  const propertyErrors = Array.isArray(status.energy?.errors) ? status.energy.errors : [];
  const errorsForHost = (host: any) => propertyErrors
    .filter((item: any) => item?.host === host && item?.error)
    .map((item: any) => `${item.epc ?? "property"}: ${item.error}`);
  if (config.batteryHost && !isDocumentationHost(config.batteryHost)) {
    const errors = [energyError ?? status.energy?.battery?.error, ...errorsForHost(config.batteryHost)].filter(Boolean);
    if (errors.length) failures.push(`Battery: ${errors.join(", ")}`);
  }
  if (config.smartCosmoEnabled && config.meterHost && !isDocumentationHost(config.meterHost)) {
    const errors = [
      status.meter?.error,
      ...(Array.isArray(status.meter?.errors) ? status.meter.errors.map((item: any) => `${item.epc ?? "property"}: ${item.error}`) : []),
    ].filter(Boolean);
    if (errors.length) failures.push(`Smart Cosmo: ${errors.join(", ")}`);
  }
  if (config.solarEnabled && config.solarHost && !isDocumentationHost(config.solarHost)) {
    const errors = [energyError ?? status.energy?.solar?.error, ...errorsForHost(config.solarHost)].filter(Boolean);
    if (errors.length) failures.push(`Solar: ${errors.join(", ")}`);
  }
  if (config.fuelCellEnabled && config.fuelCellHosts.some((host: any) => !isDocumentationHost(host))) {
    const fuelCellErrors = (status.energy?.fuel_cells ?? status.energy?.fuelCells ?? [])
      .map((item: any) => item?.error)
      .filter(Boolean);
    const configuredHosts = new Set(config.fuelCellHosts);
    const propertyFuelCellErrors = propertyErrors
      .filter((item: any) => configuredHosts.has(item?.host) && item?.error)
      .map((item: any) => `${item.host} ${item.epc ?? "property"}: ${item.error}`);
    if (energyError) failures.push(`Ene-Farm: ${energyError}`);
    else if (fuelCellErrors.length || propertyFuelCellErrors.length) {
      failures.push(`Ene-Farm: ${[...fuelCellErrors, ...propertyFuelCellErrors].join(", ")}`);
    }
  }
  return [...new Set(failures)];
}

function observeDeviceNotifications(status: any, config: any): any {
  const failures = deviceStatusFailures(status, config);
  notificationService.observeCondition({
    key: "device-health",
    active: failures.length > 0,
    activateAfter: 3,
    recoverAfter: 2,
    activeEvent: {
      type: "deviceOffline",
      severity: "error",
      title: "Energy device unavailable",
      message: `Three consecutive background polls reported device errors:\n${failures.join("\n")}`,
      dedupeKey: "device-health:offline",
    },
    recoveryEvent: {
      type: "deviceRecovered",
      severity: "info",
      title: "Energy devices recovered",
      message: "Configured energy devices responded successfully to two consecutive background polls.",
      dedupeKey: "device-health:recovered",
    },
  });
}

function observeBatterySocNotifications(status: any, config: any): any {
  const trigger = config.notifications?.triggers?.lowBattery;
  const stateOfCharge = numericMetric(status.energy?.battery?.remaining_percent);
  const thresholdPercent = Number(trigger?.thresholdPercent ?? 20);
  if (!config.notifications?.enabled) {
    notificationService.observeCondition({ key: "low-battery-soc", active: false });
    return;
  }
  if (!Number.isFinite(stateOfCharge)) return;
  if (stateOfCharge > thresholdPercent && stateOfCharge < thresholdPercent + 5) return;
  notificationService.observeCondition({
    key: "low-battery-soc",
    active: stateOfCharge <= thresholdPercent,
    activateAfter: 2,
    recoverAfter: 2,
    activeEvent: {
      type: "lowBattery",
      severity: "warning",
      title: "Battery state of charge is low",
      message: `Battery state of charge remained at or below ${thresholdPercent}% for two background polls. Current SOC: ${stateOfCharge}%.`,
      dedupeKey: "battery-soc:low",
    },
  });
}

function fuelCellHotWaterEmptyNotificationActive(primary: any): any {
  const hotWaterLevel = numericMetric(primary?.hot_water_level);
  const generationState = primary?.generation_status?.value ?? null;
  if (!Number.isFinite(hotWaterLevel) || !generationState) return null;
  return hotWaterLevel <= 0 && generationState !== "generating";
}

function observeFuelCellHotWaterNotifications(status: any, config: any): any {
  if (config.fuelCellEnabled === false || !config.fuelCellPrimaryHost) {
    notificationService.observeCondition({ key: "fuel-cell-hot-water-empty", active: false });
    return;
  }
  const primary = primaryFuelCell(status.energy?.fuel_cells ?? status.energy?.fuelCells ?? []);
  const active = fuelCellHotWaterEmptyNotificationActive(primary);
  if (active === null) return;
  notificationService.observeCondition({
    key: "fuel-cell-hot-water-empty",
    active,
    activateAfter: 2,
    recoverAfter: 2,
    activeEvent: {
      type: "fuelCellHotWaterEmpty",
      severity: "warning",
      title: "Ene-Farm hot-water tank is empty",
      message: "The Ene-Farm hot-water level remained at 0/5 for two background polls.",
      dedupeKey: "fuel-cell-hot-water:empty",
    },
  });
}

const DEVICE_ACTION_NAMES = [
  "vendor-profile",
  "discharge-limit",
  "osaifu-charge-window",
  "osaifu-discharge-window",
  "set-mode",
  "charge",
  "discharge",
] as const satisfies readonly BatteryAction[];
const DEVICE_ACTIONS: ReadonlySet<string> = new Set(DEVICE_ACTION_NAMES);

async function executeActionCore(action: any, payload: any = {}, { source = "manual" }: any = {}): Promise<any> {
  // Settings and direct actions share this path so scheduled jobs exercise the
  // same validation and ECHONET writes as button clicks in the UI.
  await assertActionAllowedByOperationalOverride(source, action);
  if (source === "manual") await pauseAdaptiveChargingForManualAction(action);
  const config = await readConfig();
  const host = hostFrom(payload, config);
  switch (action) {
    case "vendor-profile":
      if (!payload.mode) throw new Error("mode is required");
      return assertDeviceCommandResult(
        await runDeviceCommandQueued("vendor-profile", { host }, [payload.mode]),
        `charging profile ${payload.mode}`,
      );
    case "discharge-limit":
      return assertDeviceCommandResult(
        await runDeviceCommandQueued("discharge-limit", { host }, [
          numberInRange(payload.percent, "percent", 0, 100, 10),
        ]),
        "discharge limit",
      );
    case "osaifu-charge-window": {
      const startHour = numberInRange(payload.startHour, "startHour", 0, 23);
      const endHour = numberInRange(payload.endHour, "endHour", 0, 23);
      return assertDeviceCommandResult(
        await runDeviceCommandQueued("osaifu-charge-window", { host }, [startHour, endHour]),
        "osaifu charge window",
      );
    }
    case "osaifu-discharge-window": {
      const startHour = numberInRange(payload.startHour, "startHour", 0, 23);
      const endHour = numberInRange(payload.endHour, "endHour", 0, 23);
      return assertDeviceCommandResult(
        await runDeviceCommandQueued("osaifu-discharge-window", { host }, [startHour, endHour]),
        "osaifu discharge window",
      );
    }
    case "set-mode":
      if (!payload.mode) throw new Error("mode is required");
      return assertDeviceCommandResult(
        await runDeviceCommandQueued("set-mode", { host }, [payload.mode]),
        `operation mode ${payload.mode}`,
      );
    case "charge":
    case "discharge": {
      const args: Record<string, any> = { host };
      if (payload.targetWh !== undefined && payload.targetWh !== "") {
        args["target-wh"] = numberInRange(payload.targetWh, "targetWh", 0, 999999999);
      }
      return assertDeviceCommandResult(
        await runDeviceCommandQueued(action, args),
        `${action} request`,
      );
    }
    default:
      throw requestError(404, `unknown action: ${action}`);
  }
}

function commandRequestPayload(payload: any = {}): any {
  const allowed: any[] = ["mode", "percent", "startHour", "endHour", "targetWh"];
  return Object.fromEntries(allowed
    .filter((key: any) => payload[key] !== undefined && payload[key] !== "")
    .map((key: any) => [key, payload[key]]));
}

function commandResultSummary(result: any = {}): any {
  return {
    acknowledged: result?.acknowledged === true,
    ok: result?.ok !== false,
    esv: result?.esv ?? null,
    results: Array.isArray(result?.results)
      ? result.results.map((item: any) => ({ epc: item?.epc ?? null, ok: item?.ok !== false, esv: item?.esv ?? null }))
      : undefined,
  };
}

function recordCommandLifecycle(commandId: any, type: any, details: any): any {
  if (!historyStore.isReady()) return false;
  const at = new Date().toISOString();
  return historyStore.recordEvent({
    eventKey: `command:${commandId}:${type}`,
    at,
    category: "command",
    type,
    message: details.message,
    payload: { commandId, ...details, at },
  });
}

function commandFailureType(error: any): any {
  const message = String(error?.message ?? error);
  if (/timed? out|timeout|exceeded .*ms/i.test(message)) return "timed-out";
  if (/still read back as|verification mismatch|expected .* observed/i.test(message)) return "mismatched";
  return "failed";
}

async function verifyBatterySetting(result: any, host: any, command: any, expected: any, readObserved: any, {
  attempts = OPERATION_MODE_VERIFY_ATTEMPTS,
  delayMs = OPERATION_MODE_VERIFY_DELAY_MS,
}: any = {}): Promise<any> {
  let observed: any = null;
  let lastReadError: any = null;
  const maximumAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (attempt > 1 && delayMs > 0) await sleep(delayMs);
    try {
      const readback = await runDeviceCommandQueued(command, { host }, [], { priority: 0 });
      observed = readObserved(readback);
      lastReadError = null;
      if (JSON.stringify(observed) === JSON.stringify(expected)) {
        return { ...result, verified: true, readBack: { value: observed, attempts: attempt } };
      }
    } catch (error: any) {
      lastReadError = error;
    }
  }
  if (lastReadError) {
    throw new Error(`${command} was acknowledged but verification failed: ${lastReadError.message}`, { cause: lastReadError });
  }
  throw new Error(`${command} verification mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
}

async function verifyDeviceAction(action: any, payload: any, result: any, host: any): Promise<any> {
  switch (action) {
    case "set-mode":
      return verifyBatteryOperationMode(result, host, payload.mode);
    case "charge":
      return verifyBatteryOperationMode(result, host, "charging");
    case "discharge":
      return verifyBatteryOperationMode(result, host, "discharging");
    case "vendor-profile":
      return verifyBatterySetting(result, host, "vendor-profile", String(payload.mode), (readback: any) => readback?.decoded?.mode ?? readback?.mode ?? null);
    case "discharge-limit":
      return verifyBatterySetting(result, host, "discharge-limit", Number(result?.percent ?? payload.percent), (readback: any) => Number(readback?.decoded?.percent));
    case "osaifu-charge-window":
      return verifyBatterySetting(result, host, "osaifu-charge-window", [Number(result?.decoded?.start_hour ?? payload.startHour), Number(result?.decoded?.end_hour ?? payload.endHour)], (readback: any) => [Number(readback?.decoded?.start_hour), Number(readback?.decoded?.end_hour)]);
    case "osaifu-discharge-window":
      return verifyBatterySetting(result, host, "osaifu-discharge-window", [Number(result?.decoded?.start_hour ?? payload.startHour), Number(result?.decoded?.end_hour ?? payload.endHour)], (readback: any) => [Number(readback?.decoded?.start_hour), Number(readback?.decoded?.end_hour)]);
    default:
      throw new Error(`No readback verifier is defined for ${action}`);
  }
}

async function executeAction(action: any, payload: any = {}, {
  source = "manual",
  commandId = randomUUID(),
  requestedRecorded = false,
}: any = {}): Promise<any> {
  const startedAtMs = Date.now();
  const config = await readConfig();
  const host = hostFrom(payload, config);
  const request = commandRequestPayload(payload);
  if (!requestedRecorded) {
    recordCommandLifecycle(commandId, "requested", {
      action,
      source,
      target: { kind: "battery", host },
      request,
      message: `${source} requested ${action}`,
    });
  }
  recordCommandLifecycle(commandId, "sending", {
    action,
    source,
    target: { kind: "battery", host },
    request,
    message: `Sending ${action} to the device`,
  });
  try {
    const acknowledged = await executeActionCore(action, payload, { source });
    recordCommandLifecycle(commandId, "acknowledged", {
      action,
      source,
      target: { kind: "battery", host },
      request,
      acknowledgement: commandResultSummary(acknowledged),
      message: `${action} was acknowledged by the device`,
    });
    recordCommandLifecycle(commandId, "verifying", {
      action,
      source,
      target: { kind: "battery", host },
      request,
      message: `Reading back ${action}`,
    });
    const verified = await verifyDeviceAction(action, payload, acknowledged, host);
    const completedAt = new Date().toISOString();
    recordCommandLifecycle(commandId, "succeeded", {
      action,
      source,
      target: { kind: "battery", host },
      request,
      verification: verified.readBack ?? null,
      durationMs: Date.now() - startedAtMs,
      message: `${action} was verified`,
    });
    return {
      ...verified,
      commandId,
      commandState: "succeeded",
      completedAt,
    };
  } catch (error: any) {
    const type = commandFailureType(error);
    recordCommandLifecycle(commandId, type, {
      action,
      source,
      target: { kind: "battery", host },
      request,
      error: error.message,
      durationMs: Date.now() - startedAtMs,
      message: `${action} ${type.replace("-", " ")}: ${error.message}`,
    });
    error.commandId = commandId;
    error.commandState = type;
    throw error;
  }
}

async function startDeviceCommand(action: any, payload: any = {}, { source = "manual" }: any = {}): Promise<any> {
  if (!DEVICE_ACTIONS.has(action)) throw requestError(404, `unknown action: ${action}`);
  const commandId = randomUUID();
  const config = await readConfig();
  const host = hostFrom(payload, config);
  recordCommandLifecycle(commandId, "requested", {
    action,
    source,
    target: { kind: "battery", host },
    request: commandRequestPayload(payload),
    message: `${source} requested ${action}`,
  });
  const operation = executeAction(action, payload, { source, commandId, requestedRecorded: true })
    .catch(() => null)
    .finally(() => activeDeviceCommands.delete(operation));
  activeDeviceCommands.add(operation);
  return { commandId, commandState: "requested" };
}

function assertDeviceCommandResult(result: any, description: any = "device command"): any {
  if (!result || typeof result !== "object") {
    throw new Error(`${description} returned no acknowledgement`);
  }
  const failures: any[] = [];
  if (result.error) failures.push(result.error);
  if (result.ok === false) failures.push(result.esv ? `rejected with ${result.esv}` : "was rejected");
  for (const write of Array.isArray(result.results) ? result.results : []) {
    if (write?.ok === false) failures.push(`${write.epc ?? "write"} rejected with ${write.esv ?? "unknown ESV"}`);
  }
  if (failures.length) throw new Error(`${description} failed: ${failures.join("; ")}`);
  invalidateStatusSnapshot();
  return {
    ...result,
    acknowledged: result.acknowledged === true
      || result.ok === true
      || (Array.isArray(result.results) && result.results.length > 0),
  };
}

const BATTERY_OPERATION_MODE_BY_EDT = new Map([
  [0x40, "other"],
  [0x41, "rapid_charging"],
  [0x42, "charging"],
  [0x43, "discharging"],
  [0x44, "standby"],
  [0x45, "test"],
  [0x46, "auto"],
  [0x47, "restart"],
  [0x48, "capacity_recalculation"],
]);

function batteryOperationModeFromReadback(status: any): any {
  const decoded = status?.battery?.operation_mode?.value
    ?? status?.battery?.operation_mode?.human
    ?? null;
  if (decoded !== null) return decoded;
  const rawMatch = String(status?.raw ?? "").match(/^0x([0-9a-f]{2})$/i);
  if (!rawMatch) return null;
  return BATTERY_OPERATION_MODE_BY_EDT.get(Number.parseInt(rawMatch[1], 16)) ?? null;
}

async function verifyBatteryOperationMode(result: any, host: any, expectedMode: any, {
  attempts = OPERATION_MODE_VERIFY_ATTEMPTS,
  delayMs = OPERATION_MODE_VERIFY_DELAY_MS,
  readStatus = () => runDeviceCommandQueued(
    "raw-get",
    { host, eoj: "0x027D01", timeout: 3 },
    ["0xDA"],
    { priority: 0 },
  ),
  wait = (milliseconds: any) => new Promise((resolve: any) => setTimeout(resolve, milliseconds)),
}: any = {}): Promise<any> {
  const normalizedExpected = String(expectedMode).toLowerCase().replaceAll("-", "_");
  let actualMode: any = null;
  let lastReadError: any = null;
  const maximumAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const status = await readStatus();
      actualMode = batteryOperationModeFromReadback(status);
      const normalizedActual = actualMode === null
        ? null
        : String(actualMode).toLowerCase().replaceAll("-", "_");
      if (normalizedActual === normalizedExpected) {
        return { ...result, verified: true, readBack: { operationMode: actualMode, attempts: attempt } };
      }
      lastReadError = null;
    } catch (error: any) {
      lastReadError = error;
      break;
    }
    if (attempt < maximumAttempts && delayMs > 0) await wait(delayMs);
  }
  if (lastReadError) {
    throw new Error(
      `operation mode ${expectedMode} was acknowledged but verification failed after ${maximumAttempts} attempts: ${lastReadError.message}`,
      { cause: lastReadError },
    );
  }
  if (!actualMode) {
    throw new Error(`operation mode ${expectedMode} was acknowledged but could not be verified after ${maximumAttempts} attempts`);
  }
  throw new Error(`operation mode ${expectedMode} was acknowledged but still read back as ${actualMode} after ${maximumAttempts} attempts`);
}

function parseRunAt(schedule: any): any {
  if (schedule.repeat === "daily") {
    if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) throw new Error("daily schedules require time as HH:MM");
    const [hh, mm] = schedule.time.split(":").map(Number);
    if (hh > 23 || mm > 59) throw new Error("daily schedule time must be HH:MM");
    return null;
  }
  const runAt = new Date(schedule.runAt);
  if (Number.isNaN(runAt.getTime())) throw new Error("one-time schedules require runAt as an ISO date/time");
  return runAt.toISOString();
}

const ALL_DAYS: any[] = [0, 1, 2, 3, 4, 5, 6];

function isDue(schedule: any, now: any): any {
  // Daily schedules run once per local calendar day; one-off schedules disable
  // themselves after a successful attempt.
  if (!schedule.enabled) return false;
  if (schedule.running) return false;
  if (schedule.repeat === "daily") {
    const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : ALL_DAYS;
    if (!days.includes(now.getDay())) return false;
    const current = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const todayKey = localDayKey(now);
    return schedule.time === current
      && schedule.lastRunDate !== todayKey
      && schedule.lastAttemptDate !== todayKey;
  }
  return schedule.runAt && new Date(schedule.runAt) <= now && !schedule.executionIntent;
}

function clearStaleScheduleRuns(schedules: any, activeIds: any = runningScheduleIds): any {
  let changed = false;
  for (const schedule of schedules) {
    if (!schedule.running || activeIds.has(schedule.id)) continue;
    schedule.running = false;
    schedule.runningSince = null;
    changed = true;
  }
  return changed;
}

async function runDueSchedules(): Promise<any> {
  const config = await readConfig();
  if (config.adaptiveCharging?.enabled && config.solarEnabled !== false && config.rateMode !== "simple") return;
  if (backupPreparationBlocksActions(await readOperationalOverridesState())) {
    await mutateSchedules(async (schedules: any) => {
      const now = new Date();
      for (const schedule of schedules) {
        if (!isDue(schedule, now)) continue;
        const attemptedAt = now.toISOString();
        const attemptDate = localDayKey(now);
        schedule.lastAttemptDate = attemptDate;
        schedule.lastResult = {
          ok: false,
          skipped: "Backup Preparation owns battery control",
          at: attemptedAt,
        };
        schedule.executionIntent = {
          id: randomUUID(),
          state: "blocked",
          attemptedAt,
          completedAt: attemptedAt,
          action: schedule.action,
          payload: schedule.payload,
        };
        if (schedule.repeat !== "daily") {
          schedule.enabled = false;
          schedule.completed = true;
        }
      }
    });
    return;
  }
  const rules = await readAutomationRules();
  const guardOwner = rules.find(
    (rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
  );
  await mutateSchedules(async (schedules: any) => {
    const now = new Date();
    if (clearStaleScheduleRuns(schedules)) {
      console.warn("scheduler: cleared stale running state from persisted schedule data");
    }
    for (const schedule of schedules) {
      if (!isDue(schedule, now)) continue;
      const attemptAt = new Date().toISOString();
      const attemptDate = localDayKey(now);
      schedule.lastAttemptDate = attemptDate;
      schedule.executionIntent = {
        id: randomUUID(),
        state: guardOwner ? "blocked" : "pending",
        attemptedAt: attemptAt,
        action: schedule.action,
        payload: schedule.payload,
      };
      if (guardOwner) {
        schedule.lastResult = {
          ok: false,
          skipped: "Charging Demand Guard owns Standby operation mode",
          at: attemptAt,
        };
        schedule.executionIntent.state = "blocked";
        continue;
      }
      runningScheduleIds.add(schedule.id);
      schedule.running = true;
      schedule.runningSince = attemptAt;
      await writeSchedules(schedules);
      try {
        const result = await executeAction(schedule.action, schedule.payload, { source: "schedule" });
        schedule.lastResult = { ok: true, at: new Date().toISOString(), result };
        schedule.executionIntent.state = "succeeded";
        schedule.executionIntent.completedAt = schedule.lastResult.at;
        if (schedule.repeat === "daily") schedule.lastRunDate = attemptDate;
        else {
          schedule.enabled = false;
          schedule.completed = true;
        }
      } catch (err: any) {
        schedule.lastResult = { ok: false, at: new Date().toISOString(), error: err.message };
        schedule.executionIntent.state = /timed? out|timeout/i.test(err.message) ? "unknown" : "failed";
        schedule.executionIntent.completedAt = schedule.lastResult.at;
        if (schedule.repeat !== "daily") {
          schedule.enabled = false;
          schedule.completed = true;
        }
        notificationService.enqueue({
          type: "scheduleFailed",
          severity: "error",
          title: "Scheduled battery action failed",
          message: `${schedule.repeat === "daily" ? `Daily ${schedule.time}` : schedule.runAt} ${schedule.action} failed: ${err.message}`,
          dedupeKey: `schedule-failed:${schedule.id}:${attemptDate}`,
        });
      } finally {
        runningScheduleIds.delete(schedule.id);
        schedule.running = false;
        schedule.runningSince = null;
        await writeSchedules(schedules);
      }
    }
  });
}

function cleanAutomationRuleConfig(input: any = {}): any {
  const conditions = input.conditions ?? {};
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || "Charging demand guard"),
    type: String(input.type || "backup-demand-guard"),
    enabled: input.enabled === true,
    dashboardWarningEnabled: input.dashboardWarningEnabled !== false,
    conditions: {
      source: ["houseDemandW", "gridImportW"].includes(conditions.source) ? conditions.source : "gridImportW",
      breakerAmps: configNumber(conditions.breakerAmps, DEFAULT_GUARD_CONDITIONS.breakerAmps, 1, 400),
      breakerVoltage: configNumber(conditions.breakerVoltage, DEFAULT_GUARD_CONDITIONS.breakerVoltage, 1, 1000),
      reserveAmps: configNumber(conditions.reserveAmps, DEFAULT_GUARD_CONDITIONS.reserveAmps, 0, 200),
      restoreBelowAmps: configNumber(conditions.restoreBelowAmps, Math.max(1, DEFAULT_GUARD_CONDITIONS.breakerAmps - 10), 1, 400),
      restoreDelaySeconds: configNumber(conditions.restoreDelaySeconds, 300, 0, 86400),
    },
    action: "set-mode",
    payload: { mode: "standby" },
    restoreAction: "set-mode",
    restorePayload: { mode: "auto" },
    cooldownSeconds: configNumber(input.cooldownSeconds, 300, 0, 86400),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function cleanAutomationRuleState(input: any = {}): any {
  return {
    lastResult: input.lastResult ?? null,
    state: input.state && typeof input.state === "object" ? input.state : {},
    log: Array.isArray(input.log) ? input.log.slice(-100) : [],
    stateUpdatedAt: input.stateUpdatedAt || input.updatedAt || new Date().toISOString(),
  };
}

function mergeAutomationRule(config: any, state: any = {}): any {
  return {
    ...cleanAutomationRuleConfig(config),
    ...cleanAutomationRuleState(state),
  };
}

function cleanAutomationRule(input: any = {}): any {
  return mergeAutomationRule(input, input);
}

function automationDemandWatts(status: any, source: any): any {
  const raw = source === "gridImportW"
    ? status.meter?.grid_import_power?.value
    : status.meter?.house_demand_power?.value;
  if (raw === null || raw === undefined || raw === "") return Number.NaN;
  return Number(raw);
}

function batteryOperationMode(status: any): any {
  return status.energy?.battery?.operation_mode?.value
    ?? status.energy?.battery?.operation_mode?.human
    ?? null;
}

function batteryChargingWatts(status: any): any {
  const raw = status.energy?.battery?.instant_power?.value;
  if (raw === null || raw === undefined || raw === "") return null;
  const watts = Number(raw);
  if (!Number.isFinite(watts)) return null;
  return Math.max(0, watts);
}

function shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW }: any): any {
  const mode = String(operationMode ?? "").toLowerCase();
  return mode !== "standby"
    && Number(batteryChargingW) > 0
    && Number.isFinite(Number(guardDemandW))
    && Number(guardDemandW) >= Number(breakerLimitW);
}

function canRunAutomation(rule: any, now: any): any {
  if (rule.lastResult?.skipped) return true;
  const lastAt = rule.lastResult?.at ? new Date(rule.lastResult.at).getTime() : 0;
  return !lastAt || (now.getTime() - lastAt) / 1000 >= rule.cooldownSeconds;
}

function formatWatts(value: any): any {
  return `${Math.round(Number(value) || 0)} W`;
}

function appendAutomationLog(rule: any, message: any, at: any = new Date(), kind: any = null): any {
  rule.log = [
    ...(Array.isArray(rule.log) ? rule.log : []),
    { at: at.toISOString(), message, ...(kind ? { kind } : {}) },
  ].slice(-100);
}

function automationDemandLabel(source: any): any {
  return source === "gridImportW" ? "Grid Import" : "House demand";
}

function automationRuleLabel(rule: any): any {
  return `${rule.name || rule.type || "unnamed rule"} [${rule.id || "unknown id"}]`;
}

function automationRuleList(rules: any): any {
  return rules.map(automationRuleLabel).join(", ") || "none";
}

function activeEchonetLabel(context: any): any {
  if (!context) return "none";
  const elapsedMs = Date.now() - new Date(context.startedAt).getTime();
  return `${context.command}${context.host ? ` on ${context.host}` : ""} (${elapsedMs}ms)`;
}

async function evaluateAutomationRule(
  rule: any,
  status: any,
  now: any = new Date(),
  onPhase: any = () => {},
  config: any = null,
  coordination: any = {},
): Promise<any> {
  onPhase("evaluating conditions");
  const execute = coordination.execute ?? executeAction;
  if (!rule.enabled) return { changed: false, result: { skipped: "disabled" } };
  if (rule.type !== "backup-demand-guard") return { changed: false, result: { skipped: "unknown rule type" } };

  const operationMode = batteryOperationMode(status);
  const demandW = automationDemandWatts(status, rule.conditions.source);
  if (!Number.isFinite(demandW)) return { changed: false, result: { skipped: "demand unavailable" } };

  const breakerLimitW = Math.max(0, (rule.conditions.breakerAmps - rule.conditions.reserveAmps) * rule.conditions.breakerVoltage);
  const batteryChargingW = batteryChargingWatts(status);
  const actualDemandWithChargingW = Number.isFinite(batteryChargingW) ? demandW + batteryChargingW : null;
  const guardDemandW = rule.conditions.source === "gridImportW" ? demandW : actualDemandWithChargingW;
  const maximumChargeWatts = Number(config?.batteryCapabilities?.maximumChargeWatts);
  const maximumChargeWattsAvailable = Number.isFinite(maximumChargeWatts) && maximumChargeWatts > 0;
  const estimatedRestoredDemandW = maximumChargeWattsAvailable ? demandW + maximumChargeWatts : null;
  const restoreLimitW = rule.conditions.restoreBelowAmps * rule.conditions.breakerVoltage;
  const demandLabel = automationDemandLabel(rule.conditions.source);

  if (!rule.state?.awaitingRestore
    && shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW })) {
    if (!canRunAutomation(rule, now)) return { changed: false, result: { skipped: "cooldown" } };
    onPhase("executing Standby guard action");
    const result = await execute(rule.action, rule.payload);
    appendAutomationLog(
      rule,
      `${demandLabel} (${formatWatts(guardDemandW)}) exceeds Charge Demand Guard limit (${formatWatts(breakerLimitW)}), setting operation mode from ${operationMode} to Standby`,
      now,
      "guard",
    );
    await recordGuardTriggerSample(now);
    notificationService.enqueue({
      type: "guardActivated",
      severity: "warning",
      title: "Charging Demand Guard activated",
      message: `${demandLabel} (${formatWatts(guardDemandW)}) exceeded the guard limit (${formatWatts(breakerLimitW)}). Operation mode was changed from ${operationMode} to Standby.`,
      occurredAt: now.toISOString(),
      dedupeKey: "charging-demand-guard:active",
    });
    rule.state = {
      ...rule.state,
      awaitingRestore: true,
      restoreSince: null,
      previousMode: operationMode,
    };
    rule.lastResult = { ok: true, at: now.toISOString(), kind: "guard", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, breakerLimitW, result };
    return { changed: true, result: rule.lastResult };
  }

  if (rule.state?.awaitingRestore
    && operationMode
    && String(operationMode).toLowerCase() !== "standby") {
    onPhase("reasserting Standby guard action");
    const result = await execute(rule.action, rule.payload);
    appendAutomationLog(
      rule,
      `Charging Demand Guard restore is pending; operation mode changed to ${operationMode}, returning it to Standby`,
      now,
      "maintain",
    );
    rule.state = { ...rule.state, restoreSince: null };
    rule.lastResult = {
      ok: true,
      at: now.toISOString(),
      kind: "maintain",
      operationMode,
      demandW,
      breakerLimitW,
      result,
    };
    return { changed: true, result: rule.lastResult };
  }

  if (rule.state?.awaitingRestore && demandW <= restoreLimitW) {
    if (!maximumChargeWattsAvailable) {
      const changed = Boolean(rule.state.restoreSince);
      rule.state = { ...rule.state, restoreSince: null };
      return {
        changed,
        result: {
          skipped: "maximum battery charge watts unavailable; remaining in Standby",
          demandW,
          breakerLimitW,
        },
      };
    }
    if (estimatedRestoredDemandW > breakerLimitW) {
      rule.state = { ...rule.state, restoreSince: null };
      return { changed: true, result: { skipped: "restore would exceed breaker reserve", demandW, estimatedRestoredDemandW, breakerLimitW } };
    }
    const restoreSince = rule.state.restoreSince ? new Date(rule.state.restoreSince).getTime() : now.getTime();
    rule.state.restoreSince = new Date(restoreSince).toISOString();
    if ((now.getTime() - restoreSince) / 1000 >= rule.conditions.restoreDelaySeconds) {
      if (coordination.holdStandbyForAdaptiveCharging === true) {
        return {
          changed: true,
          result: {
            skipped: "adaptiveCharging waiting to resume charging",
            demandW,
            estimatedRestoredDemandW,
            breakerLimitW,
            restoreLimitW,
          },
        };
      }
      onPhase("executing Auto restore action");
      const result = await execute(rule.restoreAction, rule.restorePayload);
      appendAutomationLog(
        rule,
        `${demandLabel} (${formatWatts(demandW)}) now below Guard restore limit (${formatWatts(restoreLimitW)}), setting operation mode to Auto`,
        now,
        "restore",
      );
      notificationService.enqueue({
        type: "guardRestored",
        severity: "info",
        title: "Charging Demand Guard restored",
        message: `${demandLabel} (${formatWatts(demandW)}) remained below the restore limit (${formatWatts(restoreLimitW)}). Operation mode was returned to Auto.`,
        occurredAt: now.toISOString(),
        dedupeKey: "charging-demand-guard:restored",
      });
      rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
      rule.lastResult = { ok: true, at: now.toISOString(), kind: "restore", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW, result };
      return { changed: true, result: rule.lastResult };
    }
    return { changed: true, result: { skipped: "waiting for restore delay", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
  }

  if (rule.state?.awaitingRestore && demandW > restoreLimitW) {
    appendAutomationLog(
      rule,
      `${demandLabel} (${formatWatts(demandW)}) still exceeds Guard restore limit (${formatWatts(restoreLimitW)}), maintaining Standby operation mode`,
      now,
      "maintain",
    );
    rule.state = { ...rule.state, restoreSince: null };
    return { changed: true, result: { skipped: "restore demand still high", demandW, restoreLimitW } };
  }

  return { changed: false, result: { skipped: "conditions not met", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, estimatedRestoredDemandW, breakerLimitW } };
}

function adaptiveChargingConfiguredActive(config: any): any {
  return config.adaptiveCharging?.enabled === true && config.solarEnabled !== false && config.rateMode !== "simple";
}

function nextLocalMidnight(now: any = new Date()): any {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

async function readBatteryChargingProfile(host: any): Promise<any> {
  const result: any = await runDeviceCommandQueued("vendor-profile", { host });
  const profile = result?.decoded?.mode ?? result?.mode;
  if (!BATTERY_PROFILES.has(profile)) {
    throw new Error(`Unable to verify battery charging profile${result?.error ? `: ${result.error}` : ""}`);
  }
  return profile;
}

async function setAndVerifyBatteryChargingProfile(profile: any, host: any): Promise<any> {
  if (!BATTERY_PROFILES.has(profile)) throw new Error(`Unsupported battery charging profile: ${profile}`);
  const result = await executeAction(
    "vendor-profile",
    { mode: profile, host },
    { source: "backup-preparation" },
  );
  let observed: any = null;
  for (let attempt = 0; attempt < OPERATION_MODE_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(OPERATION_MODE_VERIFY_DELAY_MS);
    try {
      observed = await readBatteryChargingProfile(host);
      if (observed === profile) return { result, profile: observed };
    } catch (error: any) {
      if (attempt === OPERATION_MODE_VERIFY_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error(`Battery charging profile verification failed: expected ${profile}, observed ${observed ?? "unavailable"}`);
}

async function prepareAdaptiveChargingForBackup(now: any = new Date()): Promise<any> {
  const state = await readAdaptiveChargingState();
  const guardActive = (await readAutomationRules()).some(
    (rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
  );
  const execute = (action: any, payload: any) => executeAction(action, payload, { source: "backup-preparation" });
  if (state.owner === "adaptiveCharging") {
    await releaseAdaptiveCharge(state, "Backup Preparation activated", now, null, execute);
  } else if (state.standbyHoldUntil && !guardActive) {
    await execute("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Backup Preparation activated; releasing Adaptive Charging Standby hold",
      "stop",
      now,
    );
  }
  state.owner = null;
  state.activeSlot = null;
  state.activePlanCreatedAt = null;
  state.activeChargedKwh = 0;
  state.activeLastCheckedAt = null;
  state.activeChargeSession = null;
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.standbyHoldUntil = null;
  state.lastPlanEventKey = null;
  state.lastResult = { ok: true, at: now.toISOString(), skipped: "Backup Preparation active" };
  appendAdaptiveChargingLog(
    state,
    "Backup Preparation activated; battery control is suspended until the override is ended",
    "pause",
    now,
  );
  return writeAdaptiveChargingState(state);
}

async function releaseChargingDemandGuardForBackup(now: any = new Date()): Promise<any> {
  const rules = await readAutomationRules();
  let changed = false;
  for (const rule of rules) {
    if (rule.type !== "backup-demand-guard" || !rule.state?.awaitingRestore) continue;
    rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
    rule.lastResult = {
      ok: true,
      at: now.toISOString(),
      skipped: "Released because Backup Preparation disabled Demand Guard intervention",
    };
    rule.stateUpdatedAt = now.toISOString();
    appendAutomationLog(
      rule,
      "Backup Preparation disabled Charging Demand Guard intervention; releasing Standby ownership",
      now,
      "release",
    );
    changed = true;
  }
  if (changed) {
    await writeAutomationRuleStates(rules);
    await executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
  }
  return changed;
}

async function queueAdaptiveChargingAfterBackup(now: any = new Date()): Promise<any> {
  const state = await readAdaptiveChargingState();
  state.plan = null;
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.standbyHoldUntil = null;
  state.lastPlanEventKey = null;
  queueAdaptiveChargingPlanRefresh(state, "Backup Preparation ended", now);
  appendAdaptiveChargingLog(
    state,
    "Backup Preparation ended; Adaptive Charging will recalculate before resuming control",
    "resume",
    now,
  );
  return writeAdaptiveChargingState(state);
}

async function startBackupPreparation({ allowDemandGuard = true }: any = {}, now: any = new Date()): Promise<any> {
  return withOperationalOverrideMutation(async () => {
    let state = await readOperationalOverridesState();
    if (backupPreparationBlocksActions(state)) return backupPreparationView(state);
    const config = await readConfig();
    if (!config.batteryHost || isDocumentationHost(config.batteryHost)) {
      throw requestError(409, "A battery address must be configured before Backup Preparation can start");
    }
    const previousProfile = await readBatteryChargingProfile(config.batteryHost);
    state.backupPreparation = {
      active: true,
      phase: "starting",
      allowDemandGuard: allowDemandGuard !== false,
      previousProfile,
      currentProfile: previousProfile,
      startedAt: now.toISOString(),
      endedAt: null,
      updatedAt: now.toISOString(),
      lastResult: null,
    };
    appendBackupPreparationLog(
      state,
      `Starting Backup Preparation from ${previousProfile} profile`,
      "start",
      now,
    );
    state = await writeOperationalOverridesState(state);
    try {
      if (!state.backupPreparation.allowDemandGuard) {
        await releaseChargingDemandGuardForBackup(now);
      }
      await prepareAdaptiveChargingForBackup(now);
      const profileResult = await setAndVerifyBatteryChargingProfile("backup", config.batteryHost);
      const guardActive = state.backupPreparation.allowDemandGuard && (await readAutomationRules()).some(
        (rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
      );
      if (!guardActive) {
        await executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
      }
      const completedAt = new Date();
      state.backupPreparation = {
        ...state.backupPreparation,
        active: true,
        phase: "active",
        currentProfile: profileResult.profile,
        updatedAt: completedAt.toISOString(),
        lastResult: { ok: true, at: completedAt.toISOString() },
      };
      appendBackupPreparationLog(
        state,
        `Backup Preparation active; backup profile verified${state.backupPreparation.allowDemandGuard ? "; Charging Demand Guard remains enabled" : "; Charging Demand Guard intervention is disabled"}`,
        "active",
        completedAt,
      );
      invalidateStatusSnapshot();
      return backupPreparationView(await writeOperationalOverridesState(state));
    } catch (error: any) {
      const failedAt = new Date();
      try {
        if (previousProfile !== "backup") {
          await setAndVerifyBatteryChargingProfile(previousProfile, config.batteryHost);
        }
      } catch (restoreError: any) {
        error.message = `${error.message}; failed to restore ${previousProfile} profile: ${restoreError.message}`;
      }
      state.backupPreparation = {
        ...state.backupPreparation,
        active: false,
        phase: "inactive",
        currentProfile: previousProfile,
        endedAt: failedAt.toISOString(),
        updatedAt: failedAt.toISOString(),
        lastResult: { ok: false, at: failedAt.toISOString(), error: error.message },
      };
      appendBackupPreparationLog(state, `Backup Preparation failed: ${error.message}`, "error", failedAt);
      await writeOperationalOverridesState(state);
      await queueAdaptiveChargingAfterBackup(failedAt).catch((resumeError: any) => {
        logDetailedError("backup-preparation-resume-after-failure", resumeError);
      });
      throw error;
    }
  });
}

async function endBackupPreparation(now: any = new Date()): Promise<any> {
  return withOperationalOverrideMutation(async () => {
    let state = await readOperationalOverridesState();
    if (!backupPreparationBlocksActions(state)) return backupPreparationView(state);
    const config = await readConfig();
    const previousProfile = state.backupPreparation.previousProfile;
    state.backupPreparation.phase = "ending";
    state.backupPreparation.updatedAt = now.toISOString();
    appendBackupPreparationLog(state, "Ending Backup Preparation", "stop", now);
    state = await writeOperationalOverridesState(state);
    try {
      let currentProfile = "backup";
      if (previousProfile) {
        currentProfile = (await setAndVerifyBatteryChargingProfile(previousProfile, config.batteryHost)).profile;
      }
      const guardActive = (await readAutomationRules()).some(
        (rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore,
      );
      if (!guardActive) {
        await executeAction("set-mode", { mode: "auto" }, { source: "backup-preparation" });
      }
      await queueAdaptiveChargingAfterBackup(now);
      const completedAt = new Date();
      state.backupPreparation = {
        ...state.backupPreparation,
        active: false,
        phase: "inactive",
        currentProfile,
        endedAt: completedAt.toISOString(),
        updatedAt: completedAt.toISOString(),
        lastResult: {
          ok: true,
          at: completedAt.toISOString(),
          guardRetainedStandby: guardActive,
        },
      };
      appendBackupPreparationLog(
        state,
        guardActive
          ? `Backup Preparation ended; restored ${currentProfile} profile and left Standby under Charging Demand Guard control`
          : `Backup Preparation ended; restored ${currentProfile} profile and Auto operation mode`,
        "complete",
        completedAt,
      );
      invalidateStatusSnapshot();
      return backupPreparationView(await writeOperationalOverridesState(state));
    } catch (error: any) {
      const failedAt = new Date();
      let currentProfile = state.backupPreparation.currentProfile;
      try {
        currentProfile = (await setAndVerifyBatteryChargingProfile("backup", config.batteryHost)).profile;
      } catch (preserveError: any) {
        error.message = `${error.message}; could not reassert backup profile: ${preserveError.message}`;
      }
      state.backupPreparation = {
        ...state.backupPreparation,
        active: true,
        phase: "active",
        currentProfile,
        updatedAt: failedAt.toISOString(),
        lastResult: { ok: false, at: failedAt.toISOString(), error: error.message },
      };
      appendBackupPreparationLog(
        state,
        `Could not end Backup Preparation safely: ${error.message}; override remains active`,
        "error",
        failedAt,
      );
      await writeOperationalOverridesState(state);
      throw error;
    }
  });
}

async function reconcileBackupPreparationOnStartup(now: any = new Date()): Promise<any> {
  return withOperationalOverrideMutation(async () => {
    let state = await readOperationalOverridesState();
    if (!backupPreparationBlocksActions(state)) return backupPreparationView(state);
    const config = await readConfig();
    try {
      if (!state.backupPreparation.allowDemandGuard) {
        await releaseChargingDemandGuardForBackup(now);
      }
      await prepareAdaptiveChargingForBackup(now);
      const profile = (await setAndVerifyBatteryChargingProfile("backup", config.batteryHost)).profile;
      const completedAt = new Date();
      state.backupPreparation = {
        ...state.backupPreparation,
        active: true,
        phase: "active",
        currentProfile: profile,
        updatedAt: completedAt.toISOString(),
        lastResult: { ok: true, at: completedAt.toISOString(), recoveredAtStartup: true },
      };
      appendBackupPreparationLog(
        state,
        "Server restarted during Backup Preparation; backup profile was reverified before automation resumed",
        "active",
        completedAt,
      );
      invalidateStatusSnapshot();
      return backupPreparationView(await writeOperationalOverridesState(state));
    } catch (error: any) {
      const failedAt = new Date();
      state.backupPreparation = {
        ...state.backupPreparation,
        active: true,
        phase: "active",
        updatedAt: failedAt.toISOString(),
        lastResult: { ok: false, at: failedAt.toISOString(), error: error.message },
      };
      appendBackupPreparationLog(
        state,
        `Could not reverify Backup Preparation after restart: ${error.message}; battery actions remain blocked`,
        "error",
        failedAt,
      );
      await writeOperationalOverridesState(state);
      return backupPreparationView(state);
    }
  });
}

async function pauseAdaptiveChargingForManualAction(action: any, now: any = new Date()): Promise<any> {
  const config = await readConfig();
  if (!adaptiveChargingConfiguredActive(config)) return null;
  const state = await readAdaptiveChargingState();
  if (state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, "Manual battery action received", now);
  else if (state.standbyHoldUntil) {
    await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Manual battery action received; releasing Adaptive Charging Standby hold",
      "stop",
      now,
    );
  }
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.standbyHoldUntil = null;
  state.pausedUntil = nextLocalMidnight(now);
  appendAdaptiveChargingLog(state, `Manual ${action} action paused Adaptive Charging until ${state.pausedUntil}`, "pause", now);
  return writeAdaptiveChargingState(state);
}

async function resumeAdaptiveCharging(now: any = new Date()): Promise<any> {
  const state = await readAdaptiveChargingState();
  state.pausedUntil = null;
  state.plan = null;
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.solarHeadroomHoldUntil = null;
  if (state.standbyHoldUntil) {
    await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
    state.standbyHoldUntil = null;
  }
  state.lastPlanEventKey = null;
  queueAdaptiveChargingPlanRefresh(state, "manual resume", now);
  appendAdaptiveChargingLog(state, "Adaptive Charging resumed manually", "resume", now);
  return writeAdaptiveChargingState(state);
}

function startAdaptiveChargeSession(state: any, slot: any, soc: any, now: any = new Date()): any {
  state.activeChargeSession = {
    startedAt: now.toISOString(),
    requestedWh: Math.max(0, Math.round(Number(slot?.targetWh) || 0)),
    startSocPercent: finiteNumberOrNull(soc),
    latestSocPercent: finiteNumberOrNull(soc),
    latestChargingW: null,
    lastSampleAt: null,
    slotStart: slot?.start ?? null,
    slotEnd: slot?.end ?? null,
    label: slot?.label ?? null,
  };
}

function adaptiveChargingWindowKey(window: any): any {
  const start = window?.start ?? window?.windowStart;
  const end = window?.end ?? window?.windowEnd;
  if (!start || !end) return null;
  return JSON.stringify([start, end, Number(window?.band?.yenPerKwh ?? window?.yenPerKwh), window?.band?.label ?? window?.label ?? null]);
}

function adaptiveChargingWindowRemainingWh(plan: any, window: any): any {
  const endMs = new Date(window?.end ?? window?.windowEnd).getTime();
  if (!Number.isFinite(endMs)) return 0;
  return (plan?.slots ?? [])
    .filter((slot: any) => new Date(slot.windowEnd ?? slot.end).getTime() === endMs)
    .reduce((sum: any, slot: any) => sum + Math.max(0, Math.round(Number(slot.targetWh) || 0)), 0);
}

function finalizeAdaptiveChargingWindowExecution(state: any, endSocPercent: any = null, now: any = new Date(), reason: any = "discounted window ended"): any {
  const active = state.activeWindowExecution;
  if (!active) return null;
  const endSoc = Number.isFinite(finiteNumberOrNull(endSocPercent))
    ? finiteNumberOrNull(endSocPercent)
    : finiteNumberOrNull(active.latestSocPercent);
  const targetSocPercent = finiteNumberOrNull(active.targetSocPercent);
  const socTargetReached = Number.isFinite(endSoc) && Number.isFinite(targetSocPercent)
    && endSoc >= targetSocPercent;
  const summary: Record<string, any> = {
    key: active.key,
    windowStart: active.windowStart,
    windowEnd: active.windowEnd,
    label: active.label,
    yenPerKwh: active.yenPerKwh,
    plannedWh: active.plannedWh,
    deliveredWh: active.deliveredWh,
    estimatedDeliveryWh: Math.max(0, Math.round(Number(active.estimatedDeliveryWh) || 0)),
    unmetWh: Math.max(0, active.plannedWh - active.deliveredWh),
    targetSocPercent,
    socTargetReached,
    interruptionCount: active.interruptionCount,
    solarHeadroomInterruptionCount: Math.max(
      0,
      Math.round(Number(active.solarHeadroomInterruptionCount) || 0),
    ),
    startSocPercent: active.startSocPercent,
    endSocPercent: endSoc,
    completedAt: now.toISOString(),
    reason,
    modelVersion: BATTERY_LEARNING_MODEL_VERSION,
  };
  state.windowSummaries = [
    ...(state.windowSummaries ?? []).filter((item: any) => item.key !== summary.key),
    summary,
  ].slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT);
  state.activeWindowExecution = null;
  appendAdaptiveChargingLog(
    state,
    `${active.label || "Discounted window"} summary: ${summary.plannedWh} Wh planned, ${summary.deliveredWh} Wh delivered${summary.estimatedDeliveryWh > 0 ? ` (${summary.estimatedDeliveryWh} Wh estimated at exact boundaries)` : ""}, ${summary.unmetWh} Wh ${socTargetReached ? "unused (SOC target achieved)" : "unmet"}, ${summary.interruptionCount} breaker interruptions, ${summary.solarHeadroomInterruptionCount} solar-headroom pauses, SOC ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%`,
    summary.unmetWh > 0 && !socTargetReached ? "warning" : "summary",
    now,
  );
  return summary;
}

function syncAdaptiveChargingWindowExecution(state: any, occurrence: any, plan: any, soc: any, now: any = new Date(), planRecalculated: any = false): any {
  if (!occurrence) return null;
  const key = adaptiveChargingWindowKey(occurrence);
  if (!key) return null;
  if (state.activeWindowExecution && state.activeWindowExecution.key !== key) {
    finalizeAdaptiveChargingWindowExecution(state, soc, now, "next discounted window started");
  }
  const remainingWh = adaptiveChargingWindowRemainingWh(plan, occurrence);
  const targetSocPercent = finiteNumberOrNull((plan?.windows ?? []).find(
    (window: any) => window.start === occurrence.start && window.end === occurrence.end,
  )?.targetSocPercent);
  const activeDeliveredWh = planRecalculated && state.owner === "adaptiveCharging"
    ? Math.max(0, Math.round(Number(state.activeChargedKwh) * 1000))
    : 0;
  if (!state.activeWindowExecution) {
    state.activeWindowExecution = {
      key,
      windowStart: occurrence.start,
      windowEnd: occurrence.end,
      label: occurrence.band?.label || "Discounted",
      yenPerKwh: Number(occurrence.band?.yenPerKwh),
      plannedWh: remainingWh,
      deliveredWh: 0,
      estimatedDeliveryWh: 0,
      interruptionCount: 0,
      solarHeadroomInterruptionCount: 0,
      startSocPercent: finiteNumberOrNull(soc),
      latestSocPercent: finiteNumberOrNull(soc),
      targetSocPercent,
      startedTrackingAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  } else {
    state.activeWindowExecution.latestSocPercent = finiteNumberOrNull(soc);
    if (targetSocPercent !== null) state.activeWindowExecution.targetSocPercent = targetSocPercent;
    if (planRecalculated) {
      state.activeWindowExecution.plannedWh = state.activeWindowExecution.deliveredWh + activeDeliveredWh + remainingWh;
    }
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  return state.activeWindowExecution;
}

function finalizeExpiredAdaptiveChargingWindow(state: any, soc: any, now: any = new Date()): any {
  const active = state.activeWindowExecution;
  if (!active || state.owner === "adaptiveCharging") return null;
  const endMs = new Date(active.windowEnd).getTime();
  if (!Number.isFinite(endMs) || now.getTime() < endMs) return null;
  return finalizeAdaptiveChargingWindowExecution(state, soc, now);
}

function recordAdaptiveChargingWindowInterruption(state: any): any {
  if (!state.activeWindowExecution) return 0;
  state.activeWindowExecution.interruptionCount += 1;
  return state.activeWindowExecution.interruptionCount;
}

function recordAdaptiveChargingSolarHeadroomInterruption(state: any): any {
  if (!state.activeWindowExecution) return 0;
  state.activeWindowExecution.solarHeadroomInterruptionCount = Math.max(
    0,
    Math.round(Number(state.activeWindowExecution.solarHeadroomInterruptionCount) || 0),
  ) + 1;
  return state.activeWindowExecution.solarHeadroomInterruptionCount;
}

function recordAdaptiveChargeSample(state: any, status: any, now: any = new Date()): any {
  if (state.owner !== "adaptiveCharging") return false;
  const observedChargingW = batteryChargingWatts(status);
  const batteryChargingW = observedChargingW ?? 0;
  if (state.activeLastCheckedAt) {
    const elapsedHours = Math.max(
      0,
      Math.min(0.1, (now.getTime() - new Date(state.activeLastCheckedAt).getTime()) / 3_600_000),
    );
    state.activeChargedKwh += batteryChargingW * elapsedHours / 1000;
  }
  state.activeLastCheckedAt = now.toISOString();
  const soc = numericMetric(status.energy?.battery?.remaining_percent);
  if (!state.activeChargeSession) startAdaptiveChargeSession(state, state.activeSlot, soc, now);
  if (Number.isFinite(soc)) state.activeChargeSession.latestSocPercent = soc;
  if (Number.isFinite(observedChargingW)) {
    state.activeChargeSession.latestChargingW = observedChargingW;
    state.activeChargeSession.lastSampleAt = now.toISOString();
  }
  if (batteryChargingW > 0) {
    const houseDemandW = numericMetric(status.meter?.house_demand_power);
    const gridImportW = numericMetric(status.meter?.grid_import_power);
    state.chargingPerformance = cleanAdaptiveChargingPerformance({
      ...state.chargingPerformance,
      samples: [
        ...(state.chargingPerformance?.samples ?? []),
        { at: now.toISOString(), batteryChargingW, socPercent: soc, houseDemandW, gridImportW },
      ],
    });
  }
  return true;
}

function adaptiveChargeBoundaryTailWh(state: any, active: any, reason: any, now: any = new Date()): any {
  if (!["Planned charging slot ended", "Planned discounted window ended"].includes(reason)) return 0;
  const chargingW = Number(active.latestChargingW);
  const lastSampleMs = new Date(active.lastSampleAt).getTime();
  const slotEndMs = new Date(active.slotEnd).getTime();
  if (!(chargingW > 0) || !Number.isFinite(lastSampleMs)) return 0;
  const estimateEndMs = Number.isFinite(slotEndMs)
    ? Math.min(now.getTime(), slotEndMs)
    : now.getTime();
  const elapsedMs = Math.max(0, estimateEndMs - lastSampleMs);
  const measuredWh = Math.max(0, Number(state.activeChargedKwh) * 1000);
  const remainingWh = Math.max(0, Number(active.requestedWh) - measuredWh);
  return Math.min(remainingWh, chargingW * elapsedMs / 3_600_000);
}

function finalizeAdaptiveChargeSession(state: any, reason: any, now: any = new Date()): any {
  const active = state.activeChargeSession;
  if (!active) return null;
  const estimatedDeliveryWh = adaptiveChargeBoundaryTailWh(state, active, reason, now);
  const deliveredWh = Math.max(
    0,
    Math.round(Number(state.activeChargedKwh) * 1000 + estimatedDeliveryWh),
  );
  const startSocPercent = finiteNumberOrNull(active.startSocPercent);
  const endSocPercent = finiteNumberOrNull(active.latestSocPercent);
  const socDeltaPercent = Number.isFinite(startSocPercent) && Number.isFinite(endSocPercent)
    ? Math.max(0, endSocPercent - startSocPercent)
    : null;
  const durationHours = Math.max(0, (now.getTime() - new Date(active.startedAt).getTime()) / 3_600_000);
  const averageChargeWatts = durationHours > 0 ? deliveredWh / durationHours : null;
  const session: Record<string, any> = {
    startedAt: active.startedAt,
    endedAt: now.toISOString(),
    reason,
    requestedWh: active.requestedWh,
    deliveredWh,
    startSocPercent: Number.isFinite(startSocPercent) ? startSocPercent : null,
    endSocPercent: Number.isFinite(endSocPercent) ? endSocPercent : null,
    socDeltaPercent,
    averageChargeWatts,
    estimatedDeliveryWh: Math.max(0, Math.round(estimatedDeliveryWh)),
    modelVersion: BATTERY_LEARNING_MODEL_VERSION,
  };
  state.chargingPerformance = cleanAdaptiveChargingPerformance({
    ...state.chargingPerformance,
    sessions: [...(state.chargingPerformance?.sessions ?? []), session],
  });
  if (state.activeWindowExecution) {
    state.activeWindowExecution.deliveredWh += deliveredWh;
    state.activeWindowExecution.estimatedDeliveryWh = Math.max(
      0,
      Math.round(Number(state.activeWindowExecution.estimatedDeliveryWh) || 0),
    ) + session.estimatedDeliveryWh;
    state.activeWindowExecution.latestSocPercent = endSocPercent;
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  state.activeChargeSession = null;
  return session;
}

function executeAdaptiveChargingAction(action: any, payload: any = {}): any {
  return executeAction(action, payload, { source: "adaptive-charging" });
}

async function releaseAdaptiveCharge(
  state: any,
  reason: any,
  now: any = new Date(),
  batteryHost: any = null,
  execute: any = executeAdaptiveChargingAction,
): Promise<any> {
  if (state.owner !== "adaptiveCharging") return false;
  await execute("set-mode", { mode: "auto", ...(batteryHost ? { host: batteryHost } : {}) });
  finalizeAdaptiveChargeSession(state, reason, now);
  appendAdaptiveChargingLog(state, `${reason}; setting operation mode to Auto`, "stop", now);
  state.owner = null;
  state.activeSlot = null;
  state.activePlanCreatedAt = null;
  state.activeChargedKwh = 0;
  state.activeLastCheckedAt = null;
  state.standbyHoldUntil = null;
  return true;
}

async function suspendAdaptiveChargeInStandby(
  state: any,
  reason: any,
  now: any = new Date(),
  batteryHost: any = null,
  execute: any = executeAdaptiveChargingAction,
  holdUntil: any = null,
): Promise<any> {
  if (state.owner !== "adaptiveCharging") return false;
  await execute("set-mode", { mode: "standby", ...(batteryHost ? { host: batteryHost } : {}) });
  finalizeAdaptiveChargeSession(state, reason, now);
  const holdUntilMs = new Date(holdUntil).getTime();
  state.standbyHoldUntil = Number.isFinite(holdUntilMs) && holdUntilMs > now.getTime()
    ? new Date(holdUntilMs).toISOString()
    : null;
  appendAdaptiveChargingLog(
    state,
    state.standbyHoldUntil
      ? `${reason}; holding Standby operation mode until ${state.standbyHoldUntil}`
      : `${reason}; maintaining Standby operation mode`,
    "guard",
    now,
  );
  state.owner = null;
  state.activeSlot = null;
  state.activePlanCreatedAt = null;
  state.activeChargedKwh = 0;
  state.activeLastCheckedAt = null;
  return true;
}

async function executeAdaptiveChargeStart(slot: any, { resumeFromStandby = false, execute = executeAdaptiveChargingAction }: any = {}): Promise<any> {
  if (resumeFromStandby) await execute("set-mode", { mode: "auto" });
  try {
    return await execute("charge", { targetWh: slot.targetWh });
  } catch (error: any) {
    if (resumeFromStandby) {
      try {
        await execute("set-mode", { mode: "standby" });
      } catch (standbyError: any) {
        throw new Error(
          `${error.message}; failed to return battery to Standby: ${standbyError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function adaptiveChargingSlotEndKey(state: any): any {
  if (state?.owner !== "adaptiveCharging" || !state.activeSlot) return null;
  const endMs = new Date(state.activeSlot.end).getTime();
  if (!Number.isFinite(endMs)) return null;
  return JSON.stringify([
    state.activeSlot.start ?? null,
    state.activeSlot.end,
    state.activePlanCreatedAt ?? null,
  ]);
}

function adaptiveChargingSlotEndDelayMs(state: any, now: any = new Date()): any {
  if (!adaptiveChargingSlotEndKey(state)) return null;
  return Math.max(0, new Date(state.activeSlot.end).getTime() - now.getTime());
}

async function enforceAdaptiveChargingSlotEndDeadline(expectedKey: any, {
  now = new Date(),
  readState = readAdaptiveChargingState,
  release = releaseAdaptiveCharge,
  suspend = suspendAdaptiveChargeInStandby,
  writeState = writeAdaptiveChargingState,
}: any = {}): Promise<any> {
  const state = await readState();
  if (adaptiveChargingSlotEndKey(state) !== expectedKey) {
    return { stopped: false, reason: "active adaptiveCharging slot changed" };
  }
  const remainingMs = adaptiveChargingSlotEndDelayMs(state, now);
  if (remainingMs > 0) return { stopped: false, remainingMs };
  const windowEndMs = new Date(state.activeSlot?.windowEnd).getTime();
  const slotEndMs = new Date(state.activeSlot?.end).getTime();
  const windowEnded = Number.isFinite(windowEndMs)
    && (now.getTime() >= windowEndMs || (Number.isFinite(slotEndMs) && slotEndMs >= windowEndMs));
  const reason = windowEnded ? "Planned discounted window ended" : "Planned charging slot ended";
  try {
    if (windowEnded) await release(state, reason, now);
    else await suspend(state, reason, now, null, undefined, state.activeSlot?.windowEnd);
  } catch (error: any) {
    appendAdaptiveChargingLog(
      state,
      `Failed to stop overdue charge after ${reason.toLowerCase()}: ${error.message}; retrying`,
      "error",
      now,
    );
    state.lastResult = {
      ok: false,
      at: now.toISOString(),
      error: error.message,
      kind: "slot-end-retry",
      reason: reason.toLowerCase(),
    };
    await writeState(state);
    return { stopped: false, retryMs: ADAPTIVE_CHARGING_SLOT_END_RETRY_MS, error: error.message };
  }
  finalizeExpiredAdaptiveChargingWindow(state, state.activeWindowExecution?.latestSocPercent, now);
  state.lastResult = {
    ok: true,
    at: now.toISOString(),
    kind: "stop",
    reason: reason.toLowerCase(),
  };
  await writeState(state);
  return { stopped: true };
}

function clearAdaptiveChargingSlotEndTimer(): any {
  if (adaptiveChargingSlotEndTimer) clearTimeout(adaptiveChargingSlotEndTimer);
  adaptiveChargingSlotEndTimer = null;
  adaptiveChargingSlotEndTimerKey = null;
}

function armAdaptiveChargingSlotEndTimer(key: any, delayMs: any): any {
  adaptiveChargingSlotEndTimerKey = key;
  const timer = setTimeout(() => {
    enforceAdaptiveChargingSlotEndDeadline(key)
      .then((result: any) => {
        if (adaptiveChargingSlotEndTimer !== timer) return;
        adaptiveChargingSlotEndTimer = null;
        adaptiveChargingSlotEndTimerKey = null;
        const retryDelayMs = Number.isFinite(result.remainingMs) && result.remainingMs > 0
          ? result.remainingMs
          : result.retryMs;
        if (Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
          armAdaptiveChargingSlotEndTimer(key, Math.min(retryDelayMs, MAX_TIMER_DELAY_MS));
        }
      })
      .catch((err: any) => {
        if (adaptiveChargingSlotEndTimer !== timer) return;
        adaptiveChargingSlotEndTimer = null;
        adaptiveChargingSlotEndTimerKey = null;
        logDetailedError("adaptive-charging-slot-end", err);
        armAdaptiveChargingSlotEndTimer(key, ADAPTIVE_CHARGING_SLOT_END_RETRY_MS);
      });
  }, Math.max(0, Math.min(delayMs, MAX_TIMER_DELAY_MS)));
  adaptiveChargingSlotEndTimer = timer;
  if (typeof adaptiveChargingSlotEndTimer.unref === "function") adaptiveChargingSlotEndTimer.unref();
}

function syncAdaptiveChargingSlotEndTimer(state: any, now: any = new Date()): any {
  const key = adaptiveChargingSlotEndKey(state);
  if (!key) {
    clearAdaptiveChargingSlotEndTimer();
    return false;
  }
  if (adaptiveChargingSlotEndTimer && adaptiveChargingSlotEndTimerKey === key) return true;
  clearAdaptiveChargingSlotEndTimer();
  armAdaptiveChargingSlotEndTimer(key, adaptiveChargingSlotEndDelayMs(state, now));
  return true;
}

function adaptiveChargingSlotAt(plan: any, now: any = new Date()): any {
  const time = now.getTime();
  return (plan?.slots ?? []).find((slot: any) => new Date(slot.start).getTime() <= time && time < new Date(slot.end).getTime()) ?? null;
}

function mergeAdaptiveChargingSlots(slots: any = []): any {
  const merged: any[] = [];
  for (const slot of [...slots].sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime())) {
    const previous = merged.at(-1);
    if (previous && previous.yenPerKwh === slot.yenPerKwh && previous.label === slot.label
      && previous.windowStart && previous.windowStart === slot.windowStart && previous.windowEnd === slot.windowEnd
      && Math.abs(new Date(previous.end).getTime() - new Date(slot.start).getTime()) <= 1
      && previous.targetSocPercent === slot.targetSocPercent) {
      previous.end = slot.end;
      previous.targetWh += slot.targetWh;
      previous.slotId = slot.slotId;
      previous.continuousWindowCharge = true;
    } else merged.push({ ...slot, continuousWindowCharge: true });
  }
  return merged;
}

async function updateActiveAdaptiveChargingObjective(state: any, plan: any, now: any = new Date(), execute: any = executeAdaptiveChargingAction, soc: any = null): Promise<any> {
  if (state.owner !== "adaptiveCharging") return false;
  const active = state.activeSlot;
  if (now.getTime() >= new Date(active?.end).getTime()) return false;
  const planChanged = state.activePlanCreatedAt !== plan?.createdAt;
  if (!planChanged && Number.isFinite(active?.deviceTargetWh)) return false;
  const replacement = (plan?.slots ?? []).find((slot: any) => slot.windowStart === active?.windowStart
    && slot.windowEnd === active?.windowEnd && slot.yenPerKwh === active?.yenPerKwh
    && slot.label === active?.label && new Date(slot.end) > now);
  if (!replacement || !active?.continuousWindowCharge) return false;
  const deliveredWh = Math.max(0, Number(state.activeChargedKwh) * 1000);
  const remainingWh = Math.max(0, Math.round(Number(replacement.targetWh) || 0));
  if (!remainingWh) return false;
  const targetWh = planChanged ? Math.round(deliveredWh + remainingWh) : active.targetWh;
  if (!Number.isFinite(targetWh) || targetWh <= 0) return false;
  // The device target is cumulative for the ongoing charge, not an additional
  // allowance. Keep its total distinct from the planner's remaining energy.
  // Missing deviceTargetWh also repairs sessions persisted by the old code.
  const socReached = Number.isFinite(soc) && soc >= Number(replacement.targetSocPercent);
  let deviceTargetWh = active.deviceTargetWh;
  if (!socReached && targetWh !== deviceTargetWh) {
    await execute("charge", { targetWh });
    deviceTargetWh = targetWh;
  }
  state.activeSlot = { ...replacement, start: active.start, targetWh, deviceTargetWh, continuousWindowCharge: true };
  state.activePlanCreatedAt = plan.createdAt;
  if (state.activeChargeSession) {
    state.activeChargeSession.requestedWh = targetWh;
    state.activeChargeSession.slotEnd = replacement.end;
  }
  return true;
}

async function recoverIdleAdaptiveCharge(state: any, status: any, now: any = new Date(), execute: any = executeAdaptiveChargingAction): Promise<any> {
  const session = state.activeChargeSession;
  const window = state.activeWindowExecution;
  if (state.owner !== "adaptiveCharging" || !session || !window) return false;
  const soc = numericMetric(status.energy?.battery?.remaining_percent);
  const remainingWh = Number(state.activeSlot?.targetWh) - Number(state.activeChargedKwh) * 1000;
  const eligible = batteryChargingWatts(status) === 0
    && batteryOperationMode(status) === "charging"
    && Number.isFinite(soc) && soc < Number(state.activeSlot?.targetSocPercent)
    && remainingWh >= 50 && new Date(state.activeSlot?.end).getTime() - now.getTime() > 120_000;
  if (!eligible) {
    session.idleSince = null;
    session.idleCheckedAt = null;
    return false;
  }
  const previousCheckMs = new Date(session.idleCheckedAt).getTime();
  if (!session.idleSince || !session.idleCheckedAt || now.getTime() - previousCheckMs > 60_000) {
    session.idleSince = now.toISOString();
  }
  session.idleCheckedAt = now.toISOString();
  if (now.getTime() - new Date(session.idleSince).getTime() < 90_000
    || Number(window.idleRecoveryCount || 0) >= 2) return false;
  // A confirmed zero-power charge is different from slow taper. End the old
  // device session explicitly, preserve its measured delivery, and let the
  // normal start path recheck breaker headroom before starting the remainder.
  preserveInterruptedAdaptiveCharge(state, now);
  await releaseAdaptiveCharge(state, "Battery remained idle below its charging objective for 90 seconds; restarting the remaining charge", now, null, execute);
  window.idleRecoveryCount = Number(window.idleRecoveryCount || 0) + 1;
  return true;
}

function capAdaptiveChargingSlotToRemainingTime(slot: any, maximumChargeWatts: any, now: any = new Date()): any {
  const endMs = new Date(slot?.end).getTime();
  const nowMs = now.getTime();
  const maximumWatts = Number(slot?.schedulingWatts ?? maximumChargeWatts);
  if (!Number.isFinite(endMs) || endMs <= nowMs || !Number.isFinite(maximumWatts) || maximumWatts <= 0) {
    return null;
  }
  const maximumRemainingWh = Math.floor(maximumWatts * (endMs - nowMs) / 3_600_000);
  const targetWh = Math.min(
    Math.max(0, Math.round(Number(slot?.targetWh) || 0)),
    Math.max(0, maximumRemainingWh),
  );
  if (targetWh < ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH) return null;
  const durationMs = targetWh / maximumWatts * 3_600_000;
  return {
    ...slot,
    start: new Date(Math.max(nowMs, endMs - durationMs)).toISOString(),
    targetWh,
  };
}

function adaptiveChargingSlotIdentity(slot: any): any {
  if (!slot) return null;
  const endMs = new Date(slot.end).getTime();
  const windowEndMs = new Date(slot.windowEnd ?? slot.end).getTime();
  if (!Number.isFinite(endMs) || !Number.isFinite(windowEndMs)) return null;
  return JSON.stringify([
    Number.isFinite(new Date(slot.windowStart).getTime()) ? new Date(slot.windowStart).getTime() : null,
    windowEndMs,
    endMs,
    Number(slot.yenPerKwh),
    slot.label ?? null,
  ]);
}

function adaptiveChargingSlotsMatch(left: any, right: any): any {
  if (left?.slotId && right?.slotId) return left.slotId === right.slotId;
  const leftIdentity = adaptiveChargingSlotIdentity(left);
  const rightIdentity = adaptiveChargingSlotIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

function consumeCompletedAdaptiveChargingSlot(plan: any, completedSlot: any): any {
  if (!plan || !completedSlot) return plan;
  let removedWh = 0;
  const slots = (plan.slots ?? []).filter((slot: any) => {
    if (!adaptiveChargingSlotsMatch(slot, completedSlot)) return true;
    removedWh += Math.max(0, Math.round(Number(slot.targetWh) || 0));
    return false;
  });
  if (!removedWh) return plan;
  const chargeToStoredRatio = Math.min(
    1.5,
    Math.max(0.5, Number(plan.batteryModel?.chargeToStoredRatio) || 1),
  );
  const removedStoredKwh = removedWh / 1000 * chargeToStoredRatio;
  const completedWindowEnd = new Date(completedSlot.windowEnd ?? completedSlot.end).getTime();
  return {
    ...plan,
    slots,
    plannedChargeKwh: Math.max(0, Number(plan.plannedChargeKwh || 0) - removedWh / 1000),
    plannedStoredChargeKwh: Math.max(
      0,
      Number(plan.plannedStoredChargeKwh || 0) - removedStoredKwh,
    ),
    requiredGridChargeKwh: Math.max(
      0,
      Number(plan.requiredGridChargeKwh || 0) - removedWh / 1000,
    ),
    windows: (plan.windows ?? []).map((window: any) => (
      new Date(window.end).getTime() === completedWindowEnd
        ? {
          ...window,
          plannedChargeKwh: Math.max(0, Number(window.plannedChargeKwh || 0) - removedWh / 1000),
          plannedStoredChargeKwh: Math.max(
            0,
            Number(window.plannedStoredChargeKwh || 0) - removedStoredKwh,
          ),
          requestedChargeKwh: Math.max(0, Number(window.requestedChargeKwh || 0) - removedWh / 1000),
        }
        : window
    )),
  };
}

function preserveInterruptedAdaptiveCharge(state: any, now: any = new Date()): any {
  const activeSlot = state.activeSlot;
  const targetWh = Math.max(0, Math.round(Number(activeSlot?.targetWh) || 0));
  if (!activeSlot || !targetWh) return null;
  const deliveredWh = Math.max(
    0,
    Math.min(targetWh, Math.round(Number(state.activeChargedKwh || 0) * 1000)),
  );
  const remainingWh = Math.max(0, targetWh - deliveredWh);
  if (state.plan) {
    state.plan = {
      ...state.plan,
      slots: (state.plan.slots ?? []).flatMap((slot: any) => {
        if (!adaptiveChargingSlotsMatch(slot, activeSlot)) return [slot];
        return remainingWh > 0 ? [{ ...slot, targetWh: remainingWh }] : [];
      }),
    };
  }
  const interruption = remainingWh > 0 ? {
    slotId: activeSlot.slotId ?? null,
    slotStart: activeSlot.start,
    slotEnd: activeSlot.end,
    windowStart: activeSlot.windowStart ?? activeSlot.start,
    windowEnd: activeSlot.windowEnd ?? activeSlot.end,
    remainingWh,
    deliveredWh,
    interruptedAt: now.toISOString(),
  } : null;
  state.interruptedCharge = interruption;
  return interruption;
}

function applyInterruptedChargeCap(plan: any, interruption: any, maximumChargeWatts: any, now: any = new Date()): any {
  if (!plan || !interruption) return { plan, interruption: null };
  const interruptedEnd = new Date(interruption.slotEnd).getTime();
  if (!Number.isFinite(interruptedEnd) || interruptedEnd <= now.getTime()) {
    return { plan, interruption: null };
  }
  const remainingWh = Math.max(0, Math.round(Number(interruption.remainingWh) || 0));
  let matched = false;
  const slots = (plan.slots ?? []).map((slot: any) => {
    const sameSlot = interruption.slotId && slot.slotId
      ? interruption.slotId === slot.slotId
      : new Date(slot.end).getTime() === interruptedEnd;
    if (!sameSlot) return slot;
    matched = true;
    const targetWh = Math.min(Math.max(0, Math.round(Number(slot.targetWh) || 0)), remainingWh);
    if (!targetWh) return null;
    const endMs = new Date(slot.end).getTime();
    const maximumWatts = Number(slot.schedulingWatts ?? maximumChargeWatts);
    const durationMs = Number.isFinite(maximumWatts) && maximumWatts > 0
      ? targetWh / maximumWatts * 3_600_000
      : endMs - new Date(slot.start).getTime();
    return {
      ...slot,
      start: new Date(Math.max(new Date(slot.start).getTime(), endMs - durationMs)).toISOString(),
      targetWh,
    };
  }).filter(Boolean);
  return {
    plan: matched ? { ...plan, slots } : plan,
    interruption: matched ? { ...interruption, remainingWh } : null,
  };
}

function adaptiveChargingBreakerSettings(rules: any = []): any {
  const guardRules = (Array.isArray(rules) ? rules : [])
    .filter((rule: any) => rule?.type === "backup-demand-guard");
  const preferredRules = guardRules.some((rule: any) => rule.enabled)
    ? guardRules.filter((rule: any) => rule.enabled)
    : guardRules;
  const configuredGuards = preferredRules
    .map((rule: any) => {
      const conditions = rule.conditions ?? {};
      const breakerVoltage = Number(conditions.breakerVoltage);
      const breakerAmps = Number(conditions.breakerAmps);
      const reserveAmps = Number(conditions.reserveAmps);
      const breakerLimitW = (breakerAmps - reserveAmps) * breakerVoltage;
      return {
        breakerVoltage,
        breakerAmps,
        reserveAmps,
        breakerLimitW,
        ruleId: rule.id ?? null,
        ruleName: rule.name ?? "Charging Demand Guard",
        source: "automation-rule",
      };
    })
    .filter((settings: any) => Number.isFinite(settings.breakerLimitW) && settings.breakerLimitW > 0)
    .sort((left: any, right: any) => left.breakerLimitW - right.breakerLimitW);
  if (configuredGuards.length) return { ...configuredGuards[0], valid: true };
  return {
    breakerVoltage: null,
    breakerAmps: null,
    reserveAmps: null,
    breakerLimitW: Number.NaN,
    ruleId: null,
    ruleName: null,
    source: "missing",
    valid: false,
  };
}

function adaptiveChargingLiveChargeHeadroom(status: any, config: any, state: any = {}, rules: any = []): any {
  const rawGridImportW = status.meter?.grid_import_power?.value;
  const gridImportW = rawGridImportW === null || rawGridImportW === undefined || rawGridImportW === ""
    ? Number.NaN
    : Number(rawGridImportW);
  const maximumChargeWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const chargePerformance = effectiveAdaptiveChargeWatts(config, state);
  const chargeWatts = Number(chargePerformance.effectiveWatts);
  const breakerSettings = adaptiveChargingBreakerSettings(rules);
  const breakerLimitW = breakerSettings.breakerLimitW;
  const safetyMarginW = ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W;
  const thresholdW = breakerSettings.valid && breakerLimitW > 0
    ? breakerLimitW - chargeWatts - safetyMarginW
    : Number.NaN;
  const available = breakerSettings.valid
    && Number.isFinite(gridImportW)
    && Number.isFinite(chargeWatts)
    && gridImportW <= thresholdW;
  return {
    available,
    gridImportW,
    maximumChargeWatts,
    chargeWatts,
    learnedChargeWatts: chargePerformance.learnedWatts,
    breakerLimitW,
    safetyMarginW,
    thresholdW,
    breakerSettings,
  };
}

function beginAdaptiveChargingBreakerRecovery(state: any, headroom: any, now: any = new Date()): any {
  state.breakerRecovery = {
    interruptedAt: now.toISOString(),
    cooldownUntil: new Date(now.getTime() + ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS).toISOString(),
    consecutiveSafeChecks: 0,
    lastCheckedAt: null,
    lastWaitLogAt: null,
    currentImportW: finiteNumberOrNull(headroom?.gridImportW),
    thresholdW: finiteNumberOrNull(headroom?.thresholdW),
    chargeWatts: finiteNumberOrNull(headroom?.chargeWatts),
    safetyMarginW: finiteNumberOrNull(headroom?.safetyMarginW),
  };
  return state.breakerRecovery;
}

function advanceAdaptiveChargingBreakerRecovery(state: any, headroom: any, now: any = new Date()): any {
  const recovery = state.breakerRecovery;
  if (!recovery) return { ready: true, waiting: false };
  const checkedAt = now.toISOString();
  if (recovery.lastCheckedAt !== checkedAt) {
    recovery.consecutiveSafeChecks = headroom.available
      ? recovery.consecutiveSafeChecks + 1
      : 0;
    recovery.lastCheckedAt = checkedAt;
  }
  recovery.currentImportW = finiteNumberOrNull(headroom.gridImportW);
  recovery.thresholdW = finiteNumberOrNull(headroom.thresholdW);
  recovery.chargeWatts = finiteNumberOrNull(headroom.chargeWatts);
  recovery.safetyMarginW = finiteNumberOrNull(headroom.safetyMarginW);
  const cooldownReady = now.getTime() >= new Date(recovery.cooldownUntil).getTime();
  const checksReady = recovery.consecutiveSafeChecks >= ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS;
  const lastWaitLogMs = new Date(recovery.lastWaitLogAt ?? 0).getTime();
  const shouldLog = !Number.isFinite(lastWaitLogMs)
    || lastWaitLogMs <= 0
    || now.getTime() - lastWaitLogMs >= ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS;
  return {
    ready: Boolean(headroom.available && cooldownReady && checksReady),
    waiting: true,
    cooldownReady,
    checksReady,
    shouldLog,
    consecutiveSafeChecks: recovery.consecutiveSafeChecks,
    requiredSafeChecks: ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS,
    cooldownUntil: recovery.cooldownUntil,
  };
}

function adaptiveChargingBreakerRecoveryReady(state: any, now: any = new Date()): any {
  const recovery = state?.breakerRecovery;
  if (!recovery) return false;
  const cooldownUntilMs = new Date(recovery.cooldownUntil).getTime();
  return Number.isFinite(cooldownUntilMs)
    && now.getTime() >= cooldownUntilMs
    && Number(recovery.consecutiveSafeChecks) >= ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS;
}

function shouldHoldGuardStandbyForAdaptiveCharging(state: any, now: any = new Date()): any {
  const slotEndMs = new Date(state?.interruptedCharge?.slotEnd ?? 0).getTime();
  return Number.isFinite(slotEndMs)
    && slotEndMs > now.getTime()
    && !adaptiveChargingBreakerRecoveryReady(state, now);
}

function logAdaptiveChargingBreakerWait(state: any, headroom: any, recoveryStatus: any, now: any = new Date()): any {
  if (!state.breakerRecovery || !recoveryStatus.shouldLog) return false;
  const importText = Number.isFinite(headroom.gridImportW) ? `(${Math.round(headroom.gridImportW)} W)` : "unavailable";
  const thresholdText = Number.isFinite(headroom.thresholdW) ? `(${Math.round(headroom.thresholdW)} W)` : "unrestricted";
  const limitText = Number.isFinite(headroom.breakerLimitW) ? `(${Math.round(headroom.breakerLimitW)} W)` : "unavailable";
  appendAdaptiveChargingLog(
    state,
    `Waiting for breaker headroom: Grid Import ${importText}, required at or below ${thresholdText} from Charging Demand Guard limit ${limitText}, safe checks (${recoveryStatus.consecutiveSafeChecks}/${recoveryStatus.requiredSafeChecks}), retry after ${state.breakerRecovery.cooldownUntil}`,
    "guard",
    now,
  );
  state.breakerRecovery.lastWaitLogAt = now.toISOString();
  return true;
}

function logAdaptiveChargingInitialHeadroomWait(state: any, headroom: any, now: any = new Date()): any {
  const lastLogMs = new Date(state.lastHeadroomWaitLogAt ?? 0).getTime();
  if (Number.isFinite(lastLogMs) && lastLogMs > 0 && now.getTime() - lastLogMs < ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS) {
    return false;
  }
  const importText = Number.isFinite(headroom.gridImportW) ? `${Math.round(headroom.gridImportW)} W` : "unavailable";
  const thresholdText = Number.isFinite(headroom.thresholdW) ? `${Math.round(headroom.thresholdW)} W` : "unrestricted";
  const limitText = Number.isFinite(headroom.breakerLimitW) ? `${Math.round(headroom.breakerLimitW)} W` : "unavailable";
  const chargeText = Number.isFinite(headroom.chargeWatts) ? `${Math.round(headroom.chargeWatts)} W` : "unavailable";
  const marginText = Number.isFinite(headroom.safetyMarginW) ? `${Math.round(headroom.safetyMarginW)} W` : "unavailable";
  const settings = headroom.breakerSettings ?? {};
  const guardValues = [settings.breakerAmps, settings.reserveAmps, settings.breakerVoltage]
    .every((value: any) => Number.isFinite(Number(value)))
    ? `${settings.breakerAmps} A - ${settings.reserveAmps} A reserve at ${settings.breakerVoltage} V`
    : "settings unavailable";
  appendAdaptiveChargingLog(
    state,
    `Waiting to start planned charge: Grid Import (${importText}), required at or below (${thresholdText}) using Charging Demand Guard (${guardValues}) = Guard limit (${limitText}), charge estimate (${chargeText}), and safety margin (${marginText})`,
    "guard",
    now,
  );
  state.lastHeadroomWaitLogAt = now.toISOString();
  return true;
}

function adaptiveChargingLiveImportSafety(status: any, rules: any = []): any {
  const rawGridImportW = status.meter?.grid_import_power?.value;
  const gridImportW = rawGridImportW === null || rawGridImportW === undefined || rawGridImportW === ""
    ? Number.NaN
    : Number(rawGridImportW);
  const breakerSettings = adaptiveChargingBreakerSettings(rules);
  const breakerLimitW = breakerSettings.breakerLimitW;
  return {
    available: breakerSettings.valid
      && Number.isFinite(gridImportW)
      && gridImportW < breakerLimitW,
    gridImportW,
    breakerLimitW,
    breakerSettings,
  };
}

function activeAdaptiveChargingSlotStopReason(state: any, config: any, plan: any, now: any = new Date()): any {
  if (state.owner !== "adaptiveCharging") return null;
  if (!explicitDiscountedBand(config, now)) return "Current rate is no longer discounted";
  const replacement = state.activeSlot?.continuousWindowCharge
    ? (plan?.slots ?? []).find((slot: any) => slot.windowStart === state.activeSlot.windowStart
      && slot.windowEnd === state.activeSlot.windowEnd
      && slot.yenPerKwh === state.activeSlot.yenPerKwh && slot.label === state.activeSlot.label
      && new Date(slot.end) > now)
    : adaptiveChargingSlotAt(plan, now);
  if (!replacement) return "Recalculated plan no longer includes the active charging period";
  const planChanged = state.activePlanCreatedAt !== plan?.createdAt;
  if (planChanged) {
    const activeRemainingWh = Math.max(
      0,
      Number(state.activeSlot?.targetWh ?? 0) - Number(state.activeChargedKwh ?? 0) * 1000,
    );
    const replacementWh = Number(replacement.targetWh);
    if (!Number.isFinite(replacementWh) || Math.abs(replacementWh - activeRemainingWh) > 50) {
      return "Recalculated plan changed the remaining charge target";
    }
  }
  const activeTarget = Number(state.activeSlot?.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  const replacementTarget = Number(replacement.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  if (Number.isFinite(activeTarget) && Number.isFinite(replacementTarget) && replacementTarget < activeTarget - 0.1) {
    return "Recalculated plan reduced the active SOC target";
  }
  const activeEnd = new Date(state.activeSlot?.end).getTime();
  const replacementEnd = new Date(replacement.end).getTime();
  if (Number.isFinite(activeEnd) && Number.isFinite(replacementEnd) && replacementEnd < activeEnd) {
    return "Recalculated plan shortened the active charging period";
  }
  return null;
}

function adaptiveChargingScheduledEvent(config: any, now: any = new Date()): any {
  const activeWindow = discountedBandOccurrence(config, now);
  if (activeWindow) {
    const elapsedMs = Math.max(0, now.getTime() - new Date(activeWindow.start).getTime());
    const slotIndex = Math.floor(elapsedMs / ADAPTIVE_CHARGING_SLOT_MS);
    return {
      eventKey: `window:${activeWindow.key}:slot:${slotIndex}`,
      trigger: slotIndex === 0
        ? `entering ${activeWindow.band.label || "discounted window"}`
        : `30-minute slot boundary in ${activeWindow.band.label || "discounted window"}`,
      activeWindow,
    };
  }
  const upcomingWindow = discountedBandOccurrences(config, now)
    .find((occurrence: any) => new Date(occurrence.start).getTime() > now.getTime());
  if (!upcomingWindow) return { upcomingWindow: null };
  const timeUntilStartMs = new Date(upcomingWindow.start).getTime() - now.getTime();
  if (timeUntilStartMs > ADAPTIVE_CHARGING_PREWINDOW_MS) return { upcomingWindow };
  return {
    eventKey: `prewindow:${upcomingWindow.key}`,
    trigger: `30 minutes before ${upcomingWindow.band.label || "discounted window"}`,
    upcomingWindow,
  };
}

function queueAdaptiveChargingPlanRefresh(state: any, reason: any, now: any = new Date(), requestId: any = randomUUID()): any {
  state.pendingPlanReason = reason;
  state.pendingPlanRequestId = String(requestId);
  state.pendingPlanRequestedAt = now.toISOString();
  return state.pendingPlanRequestId;
}

function adaptiveChargingPlanRefreshDecision(state: any, config: any, now: any = new Date()): any {
  const forecastFetchedAt = state.forecast?.fetchedAt ?? null;
  const scheduledEvent = adaptiveChargingScheduledEvent(config, now);
  if (state.pendingPlanReason) {
    return {
      ...scheduledEvent,
      refresh: true,
      trigger: state.pendingPlanReason,
      eventKey: `pending:${state.pendingPlanRequestId ?? `legacy:${state.pendingPlanReason}`}`,
    };
  }
  if (!state.plan) {
    const trigger = state.pendingPlanReason || "initial plan";
    return {
      ...scheduledEvent,
      refresh: true,
      trigger,
      eventKey: scheduledEvent.eventKey ?? `initial:${trigger}:${forecastFetchedAt ?? "none"}`,
    };
  }
  if (forecastFetchedAt && state.plan.forecastFetchedAt !== forecastFetchedAt) {
    return {
      ...scheduledEvent,
      refresh: true,
      trigger: "forecast refresh",
      eventKey: scheduledEvent.eventKey ?? `forecast:${forecastFetchedAt}`,
    };
  }
  if (scheduledEvent.eventKey) {
    if (state.lastPlanEventKey !== scheduledEvent.eventKey) {
      return { refresh: true, ...scheduledEvent };
    }
    return { refresh: false, ...scheduledEvent };
  }
  return { refresh: false, ...scheduledEvent };
}

function batteryLearningModelSwitchDue(state: any, now: any = new Date()): any {
  const switchAfterSlotEnd = state.batteryLearning?.switchAfterSlotEnd;
  if (!switchAfterSlotEnd) return false;
  const switchAt = new Date(switchAfterSlotEnd).getTime();
  return Number.isFinite(switchAt) && switchAt <= now.getTime();
}

function consumeBatteryLearningModelSwitch(state: any, now: any = new Date()): any {
  const switchAfterSlotEnd = state.batteryLearning?.switchAfterSlotEnd;
  if (!switchAfterSlotEnd || !batteryLearningModelSwitchDue(state, now)) return false;
  state.batteryLearning.switchAfterSlotEnd = null;
  if (state.batteryLearning.consumedSwitchAfterSlotEnd === switchAfterSlotEnd) return false;
  state.batteryLearning.consumedSwitchAfterSlotEnd = switchAfterSlotEnd;
  state.batteryLearning.switchConsumedAt = now.toISOString();
  queueAdaptiveChargingPlanRefresh(
    state,
    "battery model migration after active slot",
    now,
    `battery-model-switch:${switchAfterSlotEnd}`,
  );
  return true;
}

function updateAdaptiveChargingSolarHeadroomHold(state: any, liveExportNeedsHeadroom: any, now: any = new Date()): any {
  const holdUntil = state.solarHeadroomHoldUntil;
  if (!holdUntil) {
    state.solarHeadroomClearChecks = 0;
    return { active: false, released: false, expired: false };
  }

  const holdUntilMs = new Date(holdUntil).getTime();
  if (!Number.isFinite(holdUntilMs) || holdUntilMs <= now.getTime()) {
    state.solarHeadroomHoldUntil = null;
    state.solarHeadroomClearChecks = 0;
    return { active: false, released: false, expired: true };
  }

  if (liveExportNeedsHeadroom) {
    state.solarHeadroomClearChecks = 0;
    return { active: true, released: false, expired: false };
  }

  state.solarHeadroomClearChecks = Math.max(0, Number(state.solarHeadroomClearChecks) || 0) + 1;
  if (state.solarHeadroomClearChecks < ADAPTIVE_CHARGING_SOLAR_HEADROOM_CLEAR_CHECKS) {
    return { active: true, released: false, expired: false };
  }

  state.solarHeadroomHoldUntil = null;
  state.solarHeadroomClearChecks = 0;
  return { active: false, released: true, expired: false };
}

function adaptiveChargingExportEvidence(status: any): any {
  const gridExportW = numericMetric(status.meter?.grid_export_power);
  const gridImportW = numericMetric(status.meter?.grid_import_power);
  const houseDemandW = numericMetric(status.meter?.house_demand_power);
  const batteryChargingW = batteryChargingWatts(status);
  const solarW = numericMetric(status.energy?.solar?.instant_power);
  const fuelCellW = numericMetric(selectedFuelCellReading(status.energy?.fuel_cells ?? [])?.instant_power);
  const aboveThreshold = Number.isFinite(gridExportW) && gridExportW > ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W;
  const balanceAvailable = [gridImportW, houseDemandW, batteryChargingW, solarW]
    .every(Number.isFinite);
  if (!aboveThreshold) {
    return { aboveThreshold: false, balanceAvailable, coherent: false, gridExportW, residualW: null };
  }
  if (!balanceAvailable) {
    return { aboveThreshold: true, balanceAvailable: false, coherent: false, gridExportW, residualW: null };
  }
  const expectedGridW = houseDemandW + batteryChargingW - solarW - (Number.isFinite(fuelCellW) ? fuelCellW : 0);
  const measuredGridW = gridImportW - gridExportW;
  const residualW = Math.abs(expectedGridW - measuredGridW);
  const toleranceW = Math.max(300, Math.max(Math.abs(expectedGridW), Math.abs(measuredGridW)) * 0.25);
  return {
    aboveThreshold: true,
    balanceAvailable: true,
    coherent: expectedGridW < -ADAPTIVE_CHARGING_EXPORT_THRESHOLD_W && residualW <= toleranceW,
    gridExportW,
    gridImportW,
    houseDemandW,
    batteryChargingW,
    solarW,
    fuelCellW,
    expectedGridW,
    measuredGridW,
    residualW,
    toleranceW,
  };
}

function updateAdaptiveChargingExportConfirmation(state: any, evidence: any, now: any = new Date()): any {
  const current = state.exportConfirmation ?? {};
  if (!evidence.aboveThreshold) {
    const cleared = Number(current.count) > 0;
    state.exportConfirmation = {
      count: 0,
      coherent: false,
      firstSeenAt: null,
      lastSeenAt: now.toISOString(),
      lastRejectedAt: current.lastRejectedAt ?? null,
      lastRejectedLogAt: current.lastRejectedLogAt ?? null,
      lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
      lastBalanceResidualW: null,
    };
    return { confirmed: false, pending: false, rejected: false, cleared, requiredChecks: 0 };
  }
  if (evidence.balanceAvailable && !evidence.coherent) {
    state.exportConfirmation = {
      count: 0,
      coherent: false,
      firstSeenAt: null,
      lastSeenAt: now.toISOString(),
      lastRejectedAt: now.toISOString(),
      lastRejectedLogAt: current.lastRejectedLogAt ?? null,
      lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
      lastBalanceResidualW: finiteNumberOrNull(evidence.residualW),
    };
    return {
      confirmed: false,
      pending: false,
      rejected: true,
      cleared: false,
      requiredChecks: ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS,
    };
  }
  const coherent = evidence.coherent === true;
  const compatibleSequence = Number(current.count) > 0 && current.coherent === coherent;
  const count = compatibleSequence ? Number(current.count) + 1 : 1;
  const requiredChecks = coherent
    ? ADAPTIVE_CHARGING_EXPORT_COHERENT_CHECKS
    : ADAPTIVE_CHARGING_EXPORT_METER_ONLY_CHECKS;
  state.exportConfirmation = {
    count,
    coherent,
    firstSeenAt: compatibleSequence ? current.firstSeenAt : now.toISOString(),
    lastSeenAt: now.toISOString(),
    lastRejectedAt: current.lastRejectedAt ?? null,
    lastRejectedLogAt: current.lastRejectedLogAt ?? null,
    lastGridExportW: finiteNumberOrNull(evidence.gridExportW),
    lastBalanceResidualW: finiteNumberOrNull(evidence.residualW),
  };
  return {
    confirmed: count >= requiredChecks,
    pending: count < requiredChecks,
    rejected: false,
    cleared: false,
    count,
    requiredChecks,
    coherent,
  };
}

function adaptiveChargingClock(value: any): any {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function adaptiveChargingPlanLogMessage(plan: any, trigger: any, liveSoc: any): any {
  if (!plan?.available) return `Plan recalculated (${trigger}); adaptiveCharging unavailable: ${plan?.reason || "unknown reason"}`;
  const targets = (plan.windows ?? [])
    .map((window: any) => `${window.label} ${Number(window.targetSocPercent).toFixed(0)}%/${Number(window.plannedChargeKwh).toFixed(2)} kWh`)
    .join(", ") || "none";
  const slots = (plan.slots ?? [])
    .map((slot: any) => `${adaptiveChargingClock(slot.start)}-${adaptiveChargingClock(slot.end)} ${slot.targetWh} Wh`)
    .join(", ") || "none";
  const timing = (plan.windows ?? [])
    .filter((window: any) => Number(window.plannedChargeKwh) > 0
      && Number.isFinite(Number(window.schedulingWatts))
      && Number.isFinite(Number(window.timingReserveMs)))
    .map((window: any) => `${window.label} ${Math.round(Number(window.schedulingWatts))} W/${Math.round(Number(window.timingReserveMs) / 60_000)} min reserve/${window.schedulingSource}`)
    .join(", ");
  const timingSummary = timing ? `; timing [${timing}]` : "";
  const awaySummary = Number(plan.demandHistory?.awaySlotCount) > 0
    ? `; away demand ${plan.demandHistory.awayConfidence} (${plan.demandHistory.awayComparableDayCount} comparable days, ${plan.demandHistory.awayFallbackSlotCount} fallback slots)`
    : "";
  const model = plan.batteryModel ?? {};
  const batteryModelSummary = Number.isFinite(Number(model.charge?.whPerSocPoint))
    ? `; battery model v${model.version ?? BATTERY_LEARNING_MODEL_VERSION} [charge ${Number(model.charge.whPerSocPoint).toFixed(1)} Wh/SOC (${model.charge.source}), discharge ${Number(model.discharge?.whPerSocPoint).toFixed(1)} Wh/SOC (${model.discharge?.source}), power ${Math.round(Number(model.power?.effectiveWatts))} W (${model.power?.source})]`
    : "";
  const fuelCell = plan.fuelCellModel;
  const fuelCellSummary = fuelCell
    ? `; Ene-Farm ${Number(plan.predictedFuelCellKwh ?? 0).toFixed(2)} kWh median (${fuelCell.method}, ${fuelCell.influence}${fuelCell.blockers?.length ? `; ${fuelCell.blockers.join(", ")}` : ""})`
    : "";
  return `Plan recalculated (${trigger}): SOC ${Number(liveSoc).toFixed(0)}%; ${Number(plan.predictedSolarKwh).toFixed(2)} kWh solar, ${Number(plan.predictedDemandKwh).toFixed(2)} kWh demand, ${Number(plan.plannedChargeKwh).toFixed(2)} kWh discounted charging; targets [${targets}]; slots [${slots}]${timingSummary}${awaySummary}${fuelCellSummary}${batteryModelSummary}${plan.warning ? `; ${plan.warning}` : ""}`;
}

async function evaluateAdaptiveCharging(config: any, status: any, rules: any, now: any = new Date()): Promise<any> {
  let state = await readAdaptiveChargingState();
  if (consumeBatteryLearningModelSwitch(state, now)) {
    // Persist the one-shot transition before history/model work so a failed or
    // overlapping evaluation can retry the queued plan without re-arming it.
    state = await writeAdaptiveChargingState(state);
  }
  const awayPeriods = historyStore.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
  const activeAway = awayPeriods.find((period: any) => period.status === "active") ?? null;
  const awayStateKey = activeAway ? `away:${activeAway.id}:${activeAway.until}` : "home";
  if (state.lastAwayStateKey === null && !activeAway) {
    state.lastAwayStateKey = awayStateKey;
  } else if (state.lastAwayStateKey !== awayStateKey) {
    queueAdaptiveChargingPlanRefresh(
      state,
      activeAway ? "Away period started" : "Away period ended",
      now,
    );
    state.lastPlanEventKey = null;
    state.lastAwayStateKey = awayStateKey;
  }
  recordAdaptiveChargeSample(state, status, now);
  const operationalOverrides = await readOperationalOverridesState();
  if (backupPreparationBlocksActions(operationalOverrides)) {
    if (state.owner === "adaptiveCharging") {
      finalizeAdaptiveChargeSession(state, "Backup Preparation activated", now);
      state.owner = null;
      state.activeSlot = null;
      state.activePlanCreatedAt = null;
      state.activeChargedKwh = 0;
      state.activeLastCheckedAt = null;
    }
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.standbyHoldUntil = null;
    if (state.lastResult?.skipped !== "Backup Preparation active") {
      appendAdaptiveChargingLog(
        state,
        "Backup Preparation is active; Adaptive Charging will continue observing data without controlling the battery",
        "pause",
        now,
      );
    }
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "Backup Preparation active" };
    return writeAdaptiveChargingState(state);
  }
  if (state.interruptedCharge
    && new Date(state.interruptedCharge.slotEnd).getTime() <= now.getTime()) {
    state.interruptedCharge = null;
    state.breakerRecovery = null;
  }
  const paused = state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime();
  const guardActive = rules.some((rule: any) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
  const standbyHoldUntilMs = new Date(state.standbyHoldUntil).getTime();
  if (state.standbyHoldUntil
    && (!Number.isFinite(standbyHoldUntilMs) || standbyHoldUntilMs <= now.getTime())
    && !guardActive) {
    await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Discounted charging hold ended; restoring operation mode to Auto",
      "stop",
      now,
    );
    state.standbyHoldUntil = null;
  }
  const guardSettings = adaptiveChargingBreakerSettings(rules);
  const base = adaptiveChargingBaseAvailability(config);
  const forecastError = state.lastForecastError?.error;
  if (!base.available || !guardSettings.valid || paused || !forecastIsFresh(state.forecast, now) || forecastError) {
    const unavailableReason = paused
      ? "Adaptive Charging is paused"
      : base.reason
        || (!guardSettings.valid ? "Charging Demand Guard settings are unavailable" : null)
        || forecastError
        || "Forecast is unavailable";
    if (!guardActive && state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, unavailableReason, now);
    finalizeExpiredAdaptiveChargingWindow(state, numericMetric(status.energy?.battery?.remaining_percent), now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: paused ? "paused after manual action" : unavailableReason };
    return writeAdaptiveChargingState(state);
  }
  if (guardActive) {
    if (state.owner === "adaptiveCharging") {
      const interruption = preserveInterruptedAdaptiveCharge(state, now);
      finalizeAdaptiveChargeSession(state, "Charging Demand Guard interrupted Adaptive Charging", now);
      state.owner = null;
      state.activeSlot = null;
      state.activePlanCreatedAt = null;
      state.activeChargedKwh = 0;
      state.activeLastCheckedAt = null;
      if (!interruption) state.plan = null;
      if (interruption) {
        recordAdaptiveChargingWindowInterruption(state);
        beginAdaptiveChargingBreakerRecovery(state, adaptiveChargingLiveChargeHeadroom(status, config, state, rules), now);
      }
      appendAdaptiveChargingLog(
        state,
        interruption
          ? `Charging Demand Guard interrupted Adaptive Charging after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains`
          : "Charging Demand Guard owns battery control; adaptiveCharging is waiting",
        "guard",
        now,
      );
    }
    if (state.breakerRecovery) {
      const headroom = adaptiveChargingLiveChargeHeadroom(status, config, state, rules);
      const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
      logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
    }
    finalizeExpiredAdaptiveChargingWindow(state, numericMetric(status.energy?.battery?.remaining_percent), now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "Charging Demand Guard active" };
    return writeAdaptiveChargingState(state);
  }

  const liveSoc = numericMetric(status.energy?.battery?.remaining_percent);
  const liveHouseDemandW = numericMetric(status.meter?.house_demand_power);
  const liveGridImportW = numericMetric(status.meter?.grid_import_power);
  const missingTelemetry = [
    [liveSoc, "battery state of charge"],
    [liveHouseDemandW, "house demand"],
    [liveGridImportW, "grid import"],
  ].filter(([value]: any) => !Number.isFinite(value)).map(([, label]: any) => label);
  if (missingTelemetry.length) {
    const reason = `${missingTelemetry.join(", ")} unavailable`;
    if (state.owner === "adaptiveCharging") {
      const interruption = preserveInterruptedAdaptiveCharge(state, now);
      await releaseAdaptiveCharge(
        state,
        interruption
          ? `${reason} after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
          : reason,
        now,
      );
    }
    finalizeExpiredAdaptiveChargingWindow(state, liveSoc, now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: reason };
    return writeAdaptiveChargingState(state);
  }

  const activeDiscountedWindow = discountedBandOccurrence(config, now);
  const refreshDecision = adaptiveChargingPlanRefreshDecision(state, config, now);
  if (refreshDecision.refresh) {
    const samples = await readAdaptiveChargingHistory(now);
    samples.push({
      timestamp: now.toISOString(),
      stateOfChargePercent: liveSoc,
      batteryPowerW: numericMetric(status.energy?.battery?.instant_power),
      solarPowerW: numericMetric(status.energy?.solar?.instant_power),
      houseDemandW: liveHouseDemandW,
    });
    state = {
      ...state,
      historicalWeather: historyStore.historicalWeather(),
      solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy(now),
    };
    await refreshBatteryLearning(config, state, now);
    const historicalDemandDays = await readAdaptiveChargingDemandProfileDays();
    state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
    recordFuelCellPlanForecast(state.plan, now);
    state.lastPlanEventKey = refreshDecision.eventKey;
    state.pendingPlanReason = null;
    state.pendingPlanRequestId = null;
    state.pendingPlanRequestedAt = null;
    if (state.interruptedCharge) {
      const capped = applyInterruptedChargeCap(
        state.plan,
        state.interruptedCharge,
        config.batteryCapabilities.maximumChargeWatts,
        now,
      );
      state.plan = capped.plan;
      state.interruptedCharge = capped.interruption;
    }
    appendAdaptiveChargingLog(
      state,
      adaptiveChargingPlanLogMessage(state.plan, refreshDecision.trigger, liveSoc),
      state.plan.warning ? "warning" : "plan",
      now,
    );
  }
  if (!state.plan?.available) {
    if (state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, state.plan?.reason || "Plan is unavailable", now);
    finalizeExpiredAdaptiveChargingWindow(state, liveSoc, now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: state.plan?.reason || "plan unavailable" };
    return writeAdaptiveChargingState(state);
  }

  const soc = liveSoc;
  if (activeDiscountedWindow) {
    syncAdaptiveChargingWindowExecution(state, activeDiscountedWindow, state.plan, soc, now, refreshDecision.refresh);
  }
  else finalizeExpiredAdaptiveChargingWindow(state, soc, now);
  const exportEvidence = adaptiveChargingExportEvidence(status);
  const exportConfirmation = updateAdaptiveChargingExportConfirmation(state, exportEvidence, now);
  const liveExportNeedsHeadroom = exportConfirmation.confirmed;
  const solarHeadroomHold = updateAdaptiveChargingSolarHeadroomHold(state, exportEvidence.aboveThreshold, now);
  if (exportConfirmation.pending && exportConfirmation.count === 1) {
    appendAdaptiveChargingLog(
      state,
      `Grid export (${Math.round(exportEvidence.gridExportW)} W) is awaiting confirmation (${exportConfirmation.count}/${exportConfirmation.requiredChecks})`,
      "observe",
      now,
    );
  }
  if (exportConfirmation.rejected) {
    const lastRejectedLogMs = new Date(state.exportConfirmation.lastRejectedLogAt).getTime();
    if (!Number.isFinite(lastRejectedLogMs) || now.getTime() - lastRejectedLogMs >= ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS) {
      appendAdaptiveChargingLog(
        state,
        `Rejected incoherent grid export (${Math.round(exportEvidence.gridExportW)} W); calculated grid flow is ${Math.round(exportEvidence.expectedGridW)} W (positive is import) with ${Math.round(exportEvidence.residualW)} W residual`,
        "observe",
        now,
      );
      state.exportConfirmation.lastRejectedLogAt = now.toISOString();
    }
  }
  if (liveExportNeedsHeadroom && exportConfirmation.count === exportConfirmation.requiredChecks) {
    appendAdaptiveChargingLog(
      state,
      `Grid export (${Math.round(exportEvidence.gridExportW)} W) confirmed after ${exportConfirmation.count} checks; preserving solar headroom`,
      "stop",
      now,
    );
  }
  if (solarHeadroomHold.released) {
    appendAdaptiveChargingLog(
      state,
      "Grid export remained clear for two checks; releasing solar headroom hold and allowing planned charging to resume",
      "resume",
      now,
    );
  }
  if (liveExportNeedsHeadroom && state.standbyHoldUntil) {
    await executeAdaptiveChargingAction("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Live grid export indicates solar needs battery headroom; releasing Standby hold and restoring operation mode to Auto",
      "stop",
      now,
    );
    state.standbyHoldUntil = null;
  }
  const liveImportSafety = adaptiveChargingLiveImportSafety(status, rules);
  if (explicitDiscountedBand(config, now) && liveImportSafety.available && !liveExportNeedsHeadroom) {
    await updateActiveAdaptiveChargingObjective(state, state.plan, now, executeAdaptiveChargingAction, soc);
  }
  const activeTargetKwh = Number(state.activeSlot?.targetWh ?? 0) / 1000;
  const activeTargetSocPercent = Number(state.activeSlot?.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  const activeExpired = state.activeSlot && now.getTime() >= new Date(state.activeSlot.end).getTime();
  const activePlanStopReason = activeAdaptiveChargingSlotStopReason(state, config, state.plan, now);
  const activeEnergyTargetReached = state.owner === "adaptiveCharging" && state.activeChargedKwh >= activeTargetKwh;
  const activeSocTargetReached = state.owner === "adaptiveCharging" && soc >= activeTargetSocPercent;
  const breakerReserveInterrupted = state.owner === "adaptiveCharging"
    && !activeExpired
    && !activePlanStopReason
    && !liveImportSafety.available
    && !activeEnergyTargetReached
    && !activeSocTargetReached
    && !liveExportNeedsHeadroom;
  if (state.owner === "adaptiveCharging" && (
    activeExpired
    || activePlanStopReason
    || !liveImportSafety.available
    || activeEnergyTargetReached
    || activeSocTargetReached
    || liveExportNeedsHeadroom
  )) {
    const completedSlot = state.activeSlot;
    let stopReason = "Planned charge target reached";
    if (activeExpired) {
      const activeWindowEndMs = new Date(completedSlot?.windowEnd).getTime();
      stopReason = Number.isFinite(activeWindowEndMs) && now.getTime() < activeWindowEndMs
        ? "Planned charging slot ended"
        : "Planned discounted window ended";
    }
    else if (activePlanStopReason) stopReason = activePlanStopReason;
    else if (!liveImportSafety.available) {
      const interruption = breakerReserveInterrupted
        ? preserveInterruptedAdaptiveCharge(state, now)
        : null;
      if (interruption) {
        recordAdaptiveChargingWindowInterruption(state);
        beginAdaptiveChargingBreakerRecovery(state, adaptiveChargingLiveChargeHeadroom(status, config, state, rules), now);
      }
      const importText = Number.isFinite(liveImportSafety.gridImportW)
        ? `${Math.round(liveImportSafety.gridImportW)} W`
        : "unavailable";
      const limitText = Number.isFinite(liveImportSafety.breakerLimitW)
        ? `${Math.round(liveImportSafety.breakerLimitW)} W`
        : "unavailable";
      stopReason = interruption
        ? `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText}) after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
        : `Grid Import (${importText}) reached Charging Demand Guard limit (${limitText})`;
    }
    else if (liveExportNeedsHeadroom) {
      const interruption = preserveInterruptedAdaptiveCharge(state, now);
      if (interruption) recordAdaptiveChargingSolarHeadroomInterruption(state);
      stopReason = interruption
        ? `Live grid export indicates solar needs battery headroom after ${interruption.deliveredWh} Wh; ${interruption.remainingWh} Wh remains in this charge`
        : "Live grid export indicates solar needs battery headroom";
    }
    if (liveExportNeedsHeadroom && state.activeSlot?.windowEnd) {
      state.solarHeadroomHoldUntil = state.activeSlot.windowEnd;
      state.solarHeadroomClearChecks = 0;
    }
    const completedWindowEndMs = new Date(completedSlot?.windowEnd).getTime();
    const holdStandbyUntilWindowEnd = Boolean(
      activeDiscountedWindow
      && !liveExportNeedsHeadroom
      && Number.isFinite(completedWindowEndMs)
      && completedWindowEndMs > now.getTime(),
    );
    try {
      if (breakerReserveInterrupted) {
        await suspendAdaptiveChargeInStandby(state, stopReason, now);
      } else if (holdStandbyUntilWindowEnd) {
        await suspendAdaptiveChargeInStandby(
          state,
          stopReason,
          now,
          null,
          executeAdaptiveChargingAction,
          completedSlot.windowEnd,
        );
      } else {
        await releaseAdaptiveCharge(state, stopReason, now);
      }
    } catch (error: any) {
      appendAdaptiveChargingLog(
        state,
        `Failed to stop active charge after ${stopReason.toLowerCase()}: ${error.message}; will retry on the next check`,
        "error",
        now,
      );
      state.lastResult = {
        ok: false,
        at: now.toISOString(),
        error: error.message,
        kind: "charge-stop-retry",
        reason: stopReason.toLowerCase(),
      };
      return writeAdaptiveChargingState(state);
    }
    if (activeEnergyTargetReached || activeSocTargetReached) {
      state.plan = consumeCompletedAdaptiveChargingSlot(state.plan, completedSlot);
      state.interruptedCharge = null;
      state.breakerRecovery = null;
    }
  } else if (state.owner === "adaptiveCharging" && state.activePlanCreatedAt !== state.plan.createdAt) {
    const replacement = adaptiveChargingSlotAt(state.plan, now);
    state.activeSlot = {
      ...state.activeSlot,
      ...replacement,
      targetWh: state.activeSlot?.targetWh,
    };
    state.activePlanCreatedAt = state.plan.createdAt;
  }

  // All override, telemetry, SOC, tariff, and live safety stop checks above
  // must run before idle recovery can release or restart device control.
  if (liveImportSafety.available && !liveExportNeedsHeadroom) {
    await recoverIdleAdaptiveCharge(state, status, now);
  }
  const plannedSlot = explicitDiscountedBand(config, now) ? adaptiveChargingSlotAt(state.plan, now) : null;
  const slot = plannedSlot ? capAdaptiveChargingSlotToRemainingTime(
    plannedSlot,
    state.plan.chargePerformance?.effectiveWatts ?? config.batteryCapabilities.maximumChargeWatts,
    now,
  ) : null;
  if (liveExportNeedsHeadroom && slot?.windowEnd) {
    state.solarHeadroomHoldUntil = slot.windowEnd;
    state.solarHeadroomClearChecks = 0;
  }
  const solarHeadroomHoldActive = Boolean(
    solarHeadroomHold.active
    || (state.solarHeadroomHoldUntil && new Date(state.solarHeadroomHoldUntil).getTime() > now.getTime()),
  );
  const standbyHoldActive = Boolean(
    state.standbyHoldUntil && new Date(state.standbyHoldUntil).getTime() > now.getTime(),
  );
  const slotTargetReached = slot
    && Number.isFinite(soc)
    && soc >= Number(slot.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  if (slot && state.owner !== "adaptiveCharging" && !solarHeadroomHoldActive && !slotTargetReached) {
    const resumeFromStandby = Boolean(state.breakerRecovery || state.interruptedCharge || standbyHoldActive);
    const headroom = adaptiveChargingLiveChargeHeadroom(status, config, state, rules);
    if (!headroom.available) {
      if (!state.breakerRecovery) logAdaptiveChargingInitialHeadroomWait(state, headroom, now);
      if (state.breakerRecovery) {
        const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
        logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
      }
      state.lastResult = {
        ok: true,
        at: now.toISOString(),
        skipped: "live grid import leaves insufficient breaker headroom",
        ...headroom,
      };
      return writeAdaptiveChargingState(state);
    }
    if (state.breakerRecovery) {
      const recoveryStatus = advanceAdaptiveChargingBreakerRecovery(state, headroom, now);
      if (!recoveryStatus.ready) {
        logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now);
        state.lastResult = {
          ok: true,
          at: now.toISOString(),
          skipped: "waiting for stable breaker headroom",
          ...headroom,
          ...recoveryStatus,
        };
        return writeAdaptiveChargingState(state);
      }
    }
    let result;
    try {
      result = await executeAdaptiveChargeStart(slot, { resumeFromStandby });
    } catch (error: any) {
      appendAdaptiveChargingLog(
        state,
        resumeFromStandby
          ? `Failed to resume charging: ${error.message}; maintaining Standby operation mode`
          : `Failed to start charging: ${error.message}`,
        "error",
        now,
      );
      state.lastResult = { ok: false, at: now.toISOString(), error: error.message };
      await writeAdaptiveChargingState(state);
      throw error;
    }
    state.owner = "adaptiveCharging";
    state.activeSlot = { ...slot, deviceTargetWh: slot.targetWh };
    state.activePlanCreatedAt = state.plan.createdAt;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = now.toISOString();
    startAdaptiveChargeSession(state, slot, soc, now);
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.standbyHoldUntil = null;
    state.lastHeadroomWaitLogAt = null;
    state.lastResult = { ok: true, at: now.toISOString(), kind: "charge", slot, result };
    const startImportText = Number.isFinite(headroom.gridImportW) ? `${Math.round(headroom.gridImportW)} W` : "unavailable";
    const startThresholdText = Number.isFinite(headroom.thresholdW) ? `${Math.round(headroom.thresholdW)} W` : "unrestricted";
    const startLimitText = Number.isFinite(headroom.breakerLimitW) ? `${Math.round(headroom.breakerLimitW)} W` : "unavailable";
    appendAdaptiveChargingLog(
      state,
      `${resumeFromStandby ? "Restoring operation mode to Auto and resuming" : "Starting"} ${slot.targetWh} Wh charge in ${slot.label} band at ${slot.yenPerKwh} yen/kWh; Grid Import (${startImportText}) is at or below start threshold (${startThresholdText}) from Charging Demand Guard limit (${startLimitText})`,
      "charge",
      now,
    );
  } else if (slot && state.owner !== "adaptiveCharging" && (solarHeadroomHoldActive || slotTargetReached)) {
    state.lastResult = {
      ok: true,
      at: now.toISOString(),
      skipped: solarHeadroomHoldActive ? "solar export requires battery headroom for the rest of this window" : "window SOC target already reached",
    };
  } else if (!slot && state.owner !== "adaptiveCharging") {
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "no planned charge is due" };
  }
  finalizeExpiredAdaptiveChargingWindow(state, soc, now);
  return writeAdaptiveChargingState(state);
}

function adaptiveChargingWindowHasShortfall(summary: any): any {
  return Number(summary?.unmetWh) >= 50 && summary?.socTargetReached !== true;
}

function observeAdaptiveChargingNotifications(config: any, adaptiveChargingState: any): any {
  if (!adaptiveChargingConfiguredActive(config)) return;
  const paused = adaptiveChargingState.pausedUntil && new Date(adaptiveChargingState.pausedUntil).getTime() > Date.now();
  if (!paused) {
    const reason = adaptiveChargingState.lastForecastError?.error
      ?? (adaptiveChargingState.plan?.available === false ? adaptiveChargingState.plan.reason : null)
      ?? (!adaptiveChargingState.plan ? adaptiveChargingState.lastResult?.skipped : null);
    notificationService.observeCondition({
      key: "adaptive-charging-availability",
      active: Boolean(reason),
      activateAfter: 2,
      recoverAfter: 1,
      activeEvent: {
        type: "adaptiveChargingUnavailable",
        severity: "warning",
        title: "Adaptive Charging unavailable",
        message: `Adaptive Charging remained unavailable for two checks: ${reason || "unknown reason"}`,
        dedupeKey: "adaptive-charging:unavailable",
      },
      recoveryEvent: {
        type: "adaptiveChargingRecovered",
        severity: "info",
        title: "Adaptive Charging recovered",
        message: "Adaptive Charging is available again and can evaluate discounted charging windows.",
        dedupeKey: "adaptive-charging:recovered",
      },
    });
  }

  const summary = adaptiveChargingState.windowSummaries?.at(-1);
  if (adaptiveChargingWindowHasShortfall(summary)) {
    const estimatedDeliveryText = summary.estimatedDeliveryWh > 0
      ? ` ${summary.estimatedDeliveryWh} Wh of delivery was estimated between the final sample and exact charge boundaries.`
      : "";
    notificationService.enqueue({
      type: "adaptiveChargingWindowShortfall",
      severity: "warning",
      title: "Discounted charging window ended with a shortfall",
      message: `${summary.label || "Discounted window"} planned ${summary.plannedWh} Wh and delivered ${summary.deliveredWh} Wh, leaving ${summary.unmetWh} Wh unmet.${estimatedDeliveryText} Breaker interruptions: ${summary.interruptionCount}. Solar-headroom pauses: ${summary.solarHeadroomInterruptionCount ?? 0}. SOC: ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%.`,
      occurredAt: summary.completedAt,
      dedupeKey: `adaptive-charging-window:${summary.key}`,
      once: true,
    });
  }
}

async function runAutomationRules(context: any = {}): Promise<any> {
  const startedAt = new Date();
  context.startedAt = startedAt.toISOString();
  context.phase = "loading automation rules";
  const config = await readConfig();
  const rules = await readAutomationRules();
  const operationalOverrides = await readOperationalOverridesState();
  const backupPreparation = operationalOverrides.backupPreparation;
  const enabledRules = rules.filter((rule: any) => rule.enabled && !(
    backupPreparation.active
    && backupPreparation.allowDemandGuard === false
    && rule.type === "backup-demand-guard"
  ));
  const adaptiveChargingRequested = adaptiveChargingConfiguredActive(config);
  const adaptiveChargingStateBeforeStatus = adaptiveChargingRequested ? await readAdaptiveChargingState() : null;
  const adaptiveChargingEnabled = adaptiveChargingRequested
    && (adaptiveChargingBaseAvailability(config).available || adaptiveChargingStateBeforeStatus?.owner === "adaptiveCharging");
  context.enabledRules = [
    ...enabledRules.map(automationRuleLabel),
    ...(adaptiveChargingEnabled ? ["Adaptive Charging"] : []),
  ];
  if (!enabledRules.length && !adaptiveChargingEnabled) {
    if (adaptiveChargingRequested) {
      const adaptiveChargingState = await evaluateAdaptiveCharging(config, {}, rules, startedAt);
      observeAdaptiveChargingNotifications(config, adaptiveChargingState);
    }
    context.phase = "complete; no enabled rules";
    return;
  }
  context.phase = `reading device status for ${automationRuleList(enabledRules)}`;
  const statusReadStartedAt = Date.now();
  const echonetSequenceStart = deviceQueue.recentTimings.at(-1)?.sequence ?? 0;
  const probeTimings: any[] = [];
  const status = await getStatusSnapshot({
    maxAgeMs: Math.min(5_000, Math.max(0, Number(config.updateIntervalSeconds) * 1000 || 0)),
    onProbeComplete: (probe: any) => {
      probeTimings.push(probe);
      context.statusProbeCompletionLatency = probeTimings.map(
        ({ label, durationMs }: any) => `${label}=${durationMs}ms`,
      );
    },
  });
  const statusReadDurationMs = Date.now() - statusReadStartedAt;
  if (statusReadDurationMs > AUTOMATION_CHECK_INTERVAL_MS) {
    const echonetProbes = deviceQueue.recentTimings
      .filter(({ sequence }: any) => sequence > echonetSequenceStart)
      .map(({ command, host, durationMs }: any) => `${command}${host ? ` on ${host}` : ""}=${durationMs}ms`)
      .join(", ");
    console.warn(
      `automation: device status read for ${automationRuleList(enabledRules)} took ${statusReadDurationMs}ms, longer than ${AUTOMATION_CHECK_INTERVAL_MS}ms interval; ECHONET operation durations: ${echonetProbes || "none"}`,
    );
  }
  let changed = false;
  const adaptiveChargingCoordinationState = adaptiveChargingEnabled ? await readAdaptiveChargingState() : null;
  for (const rule of rules) {
    const now = new Date();
    const ruleLabel = automationRuleLabel(rule);
    const ruleStartedAt = Date.now();
    let ruleChanged = false;
    try {
      if (backupPreparation.active
        && backupPreparation.allowDemandGuard === false
        && rule.enabled
        && rule.type === "backup-demand-guard") {
        const skipped = "Backup Preparation has Demand Guard intervention disabled";
        if (rule.lastResult?.skipped !== skipped) {
          rule.lastResult = { ok: true, at: now.toISOString(), skipped };
          rule.stateUpdatedAt = now.toISOString();
          changed = true;
        }
        continue;
      }
      const result = await evaluateAutomationRule(rule, status, now, (phase: any) => {
        context.phase = `${phase} for ${ruleLabel}`;
      }, config, {
        execute: (action: any, payload: any) => executeAction(action, payload, { source: "charging-demand-guard" }),
        holdStandbyForAdaptiveCharging: adaptiveChargingEnabled
          && shouldHoldGuardStandbyForAdaptiveCharging(adaptiveChargingCoordinationState, now),
      });
      const checkFinishedAt = new Date();
      const checkMeta: Record<string, any> = {
        checkStartedAt: startedAt.toISOString(),
        checkFinishedAt: checkFinishedAt.toISOString(),
        checkDurationMs: checkFinishedAt.getTime() - startedAt.getTime(),
        ruleDurationMs: checkFinishedAt.getTime() - ruleStartedAt,
      };
      ruleChanged = result.changed;
      if (result.result?.skipped) {
        rule.lastResult = { ok: true, at: now.toISOString(), ...result.result, ...checkMeta };
        ruleChanged = true;
      } else if (result.changed && rule.lastResult) {
        rule.lastResult = { ...rule.lastResult, ...checkMeta };
      }
    } catch (err: any) {
      const checkFinishedAt = new Date();
      rule.lastResult = {
        ok: false,
        at: now.toISOString(),
        error: err.message,
        checkStartedAt: startedAt.toISOString(),
        checkFinishedAt: checkFinishedAt.toISOString(),
        checkDurationMs: checkFinishedAt.getTime() - startedAt.getTime(),
        ruleDurationMs: checkFinishedAt.getTime() - ruleStartedAt,
      };
      ruleChanged = true;
    }
    const ruleDurationMs = Date.now() - ruleStartedAt;
    if (ruleDurationMs > AUTOMATION_CHECK_INTERVAL_MS) {
      console.warn(
        `automation: rule ${ruleLabel} took ${ruleDurationMs}ms, longer than ${AUTOMATION_CHECK_INTERVAL_MS}ms interval; last phase: ${context.phase}`,
      );
    }
    if (ruleChanged) {
      changed = true;
      rule.stateUpdatedAt = now.toISOString();
    }
  }
  if (changed) {
    context.phase = `persisting state for ${automationRuleList(enabledRules)}`;
    await writeAutomationRuleStates(rules);
  }
  if (adaptiveChargingEnabled) {
    context.phase = "evaluating adaptive charging";
    let adaptiveChargingState = await readAdaptiveChargingState();
    const forecastAge = startedAt.getTime() - new Date(adaptiveChargingState.forecast?.fetchedAt ?? 0).getTime();
    if (adaptiveChargingAvailability(config, rules).available
      && (!Number.isFinite(forecastAge) || forecastAge >= SOLAR_FORECAST_REFRESH_MS)) {
      context.phase = "refreshing Open-Meteo forecast";
      adaptiveChargingState = await refreshAdaptiveChargingForecast(config, { now: startedAt });
    }
    adaptiveChargingState = await evaluateAdaptiveCharging(config, status, rules, new Date());
    observeAdaptiveChargingNotifications(config, adaptiveChargingState);
  }
  context.phase = "complete";
  const totalDurationMs = Date.now() - startedAt.getTime();
  if (totalDurationMs > AUTOMATION_CHECK_INTERVAL_MS) {
    console.warn(
      `automation: complete check for ${automationRuleList(enabledRules)} took ${totalDurationMs}ms, longer than ${AUTOMATION_CHECK_INTERVAL_MS}ms interval`,
    );
  }
}

async function runAutomationRulesScheduled(): Promise<any> {
  if (discoveryInProgress()) {
    console.warn(
      `automation: discovery is running (${discoveryRunContext.label}); skipping this scheduled interval`,
    );
    return;
  }
  if (automationRunInProgress) {
    const elapsedMs = automationRunContext?.startedAt
      ? Date.now() - new Date(automationRunContext.startedAt).getTime()
      : null;
    const duration = Number.isFinite(elapsedMs) ? `; running for ${elapsedMs}ms` : "";
    const rules = automationRunContext?.enabledRules?.join(", ") || "not loaded yet";
    const phase = automationRunContext?.phase || "unknown phase";
    console.warn(
      `automation: previous check still running${duration}; current phase: ${phase}; active ECHONET operation: ${activeEchonetLabel(deviceQueue.activeContext)}; enabled rules: ${rules}; skipping this scheduled interval`,
    );
    return;
  }
  automationRunInProgress = true;
  automationRunContext = {};
  try {
    await runAutomationRules(automationRunContext);
  } catch (err: any) {
    const error: any = err instanceof Error ? err : new Error(String(err));
    error.automationContext = { ...automationRunContext };
    throw error;
  } finally {
    automationRunInProgress = false;
    automationRunContext = null;
  }
}

function inferDevice(instances: any): any {
  const set = new Set(instances.map((item: any) => String(item).toLowerCase().slice(0, 4)));
  const roles: any[] = [];
  if (set.has("027d")) roles.push("Battery");
  if (set.has("0279")) roles.push("Solar generation");
  if (set.has("0287")) roles.push("Smart Cosmo / home power meter");
  if (set.has("027c")) roles.push("Ene-Farm");
  if (set.has("0272")) roles.push("Water heater");
  if ([...set].some((item: any) => item.startsWith("0f"))) roles.push("Controller");
  return roles.length ? roles : ["Unknown energy device"];
}

function subnetFromHost(host: any): any {
  const match = String(host ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}.0/24` : null;
}

function localNetworkHints(config: any): any {
  const hosts = [
    config.batteryHost,
    config.meterHost,
    config.solarHost,
    ...config.fuelCellHosts,
  ].filter(Boolean);
  const configuredSubnets: any[] = [...new Set(hosts.map(subnetFromHost).filter(Boolean))];
  const containerSubnets: any[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        containerSubnets.push(`${entry.address.split(".").slice(0, 3).join(".")}.0/24`);
      }
    }
  }
  return {
    configuredSubnets,
    containerSubnets: [...new Set(containerSubnets)],
    userSubnets: normalizeSubnets(config.discoverySubnets),
  };
}

function ipRangeFromCidr(cidr: any): any {
  const match = String(cidr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  if (!match) return [];
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  return Array.from({ length: 254 }, (_: any, i: any) => `${prefix}.${i + 1}`);
}

function sleep(ms: any): any {
  return new Promise((resolve: any) => setTimeout(resolve, ms));
}

function instanceListRequest(tid: any): any {
  // Raw active-scan request: controller EOJ 0x05FF01 asks node profile 0x0EF001
  // for EPC 0xD6, the self-node instance list.
  return Buffer.from([
    0x10, 0x81,
    (tid >> 8) & 0xff, tid & 0xff,
    0x05, 0xff, 0x01,
    0x0e, 0xf0, 0x01,
    0x62,
    0x01,
    0xd6, 0x00,
  ]);
}

function propertyRequest(tid: any, eojHexText: any, epcHexText: any): any {
  const eoj = Buffer.from(eojHexText.replace(/^0x/i, ""), "hex");
  const epc = Number.parseInt(epcHexText.replace(/^0x/i, ""), 16);
  return Buffer.from([
    0x10, 0x81,
    (tid >> 8) & 0xff, tid & 0xff,
    0x05, 0xff, 0x01,
    eoj[0], eoj[1], eoj[2],
    0x62,
    0x01,
    epc, 0x00,
  ]);
}

function parseInstanceListResponse(msg: any): any {
  // Minimal ECHONET Lite frame parser for active scanning. It only accepts Get
  // responses for EPC 0xD6 because discovery progress does not need full parsing.
  if (msg.length < 14 || msg[0] !== 0x10 || msg[1] !== 0x81) return null;
  const tid = msg.readUInt16BE(2);
  const esv = msg[10];
  if (![0x72, 0x52].includes(esv)) return null;
  const opc = msg[11];
  let offset = 12;
  for (let i = 0; i < opc && offset + 2 <= msg.length; i += 1) {
    const epc = msg[offset];
    const pdc = msg[offset + 1];
    const edt = msg.slice(offset + 2, offset + 2 + pdc);
    offset += 2 + pdc;
    if (epc !== 0xd6 || edt.length < 1) continue;
    const count = edt[0];
    const instances: any[] = [];
    for (let pos = 1; pos + 2 < edt.length && instances.length < count; pos += 3) {
      instances.push(edt.slice(pos, pos + 3).toString("hex"));
    }
    return { tid, instances };
  }
  return null;
}

function parseTid(msg: any): any {
  return msg.length >= 4 && msg[0] === 0x10 && msg[1] === 0x81
    ? msg.readUInt16BE(2)
    : null;
}

function isGetResponse(msg: any): any {
  return msg.length >= 14 && msg[0] === 0x10 && msg[1] === 0x81 && msg[10] === 0x72;
}

function addDiscoveredInstance(found: any, host: any, instance: any): any {
  const normalized = String(instance).toLowerCase();
  found[host] = found[host] ?? { all_instances: [], storage_battery_instances: [] };
  if (!found[host].all_instances.includes(normalized)) found[host].all_instances.push(normalized);
  if (normalized.startsWith("027d")) {
    const batteryInstance = Number.parseInt(normalized.slice(4, 6), 16);
    if (!found[host].storage_battery_instances.includes(batteryInstance)) {
      found[host].storage_battery_instances.push(batteryInstance);
    }
  }
}

function mergeDiscoveredDevices(...deviceSets: any[]): any {
  const merged: Record<string, any> = {};
  for (const devices of deviceSets) {
    for (const [host, device] of Object.entries(devices ?? {}) as Array<[string, any]>) {
      merged[host] = merged[host] ?? { all_instances: [], storage_battery_instances: [] };
      for (const instance of device.all_instances ?? []) {
        const normalized = String(instance).toLowerCase();
        if (!merged[host].all_instances.includes(normalized)) {
          merged[host].all_instances.push(normalized);
        }
        if (normalized.startsWith("027d")) {
          const batteryInstance = Number.parseInt(normalized.slice(4, 6), 16);
          if (!merged[host].storage_battery_instances.includes(batteryInstance)) {
            merged[host].storage_battery_instances.push(batteryInstance);
          }
        }
      }
    }
  }
  return merged;
}

async function activeScanSubnets(subnets: any, timeoutMs: any, progress: any = () => {}): Promise<any> {
  // Broadcast discovery is polite but not always reliable through controllers or
  // Docker networking, so this scan pokes each /24 address directly. It binds an
  // ephemeral source port instead of ECHONET's 3610 so it can run even if another
  // local reader has recently held the standard port.
  const socket = dgram.createSocket("udp4");
  const tidToHost = new Map();
  const tidToDirectProbe = new Map();
  const found: Record<string, any> = {};
  let tid = 1;
  const hosts: any[] = [...new Set(subnets.flatMap(ipRangeFromCidr))];
  let scanned = 0;
  const retryRounds = 3;
  const batchSize = 16;

  await new Promise((resolve: any, reject: any) => {
    const bindEphemeral = () => {
      socket.removeAllListeners("error");
      socket.once("error", reject);
      socket.bind(0, "0.0.0.0", resolve);
    };
    socket.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        bindEphemeral();
      } else {
        reject(err);
      }
    });
    socket.bind(3610, "0.0.0.0", resolve);
  });

  socket.on("message", (msg: any, rinfo: any) => {
    const parsed = parseInstanceListResponse(msg);
    if (parsed) {
      const host = tidToHost.get(parsed.tid) ?? rinfo.address;
      for (const instance of parsed.instances) {
        addDiscoveredInstance(found, host, instance);
      }
      progress({ found: Object.keys(found).length });
      return;
    }
    const tidValue = parseTid(msg);
    const directProbe = tidValue ? tidToDirectProbe.get(tidValue) : null;
    if (directProbe && isGetResponse(msg)) {
      addDiscoveredInstance(found, directProbe.host ?? rinfo.address, directProbe.instance);
      progress({ found: Object.keys(found).length });
    }
  });

  progress({ phase: "active-scan", total: hosts.length, scanned: 0, found: 0 });
  for (let round = 0; round < retryRounds; round += 1) {
    for (let index = 0; index < hosts.length; index += 1) {
      const host = hosts[index];
      tid = (tid % 0xfffe) + 1;
      tidToHost.set(tid, host);
      socket.send(instanceListRequest(tid), 3610, host, () => {});
      if (round === 0) {
        for (const probe of KNOWN_DISCOVERY_PROBES) {
          const epc = probe.epcs[0];
          tid = (tid % 0xfffe) + 1;
          tidToDirectProbe.set(tid, {
            host,
            instance: probe.eoj.slice(2).toLowerCase(),
          });
          socket.send(propertyRequest(tid, probe.eoj, epc), 3610, host, () => {});
        }
      }
      if (round === 0) scanned += 1;
      if (
        round === 0 &&
        (scanned === hosts.length || scanned % batchSize === 0)
      ) {
        progress({ phase: "active-scan", total: hosts.length, scanned, found: Object.keys(found).length });
      }
      if ((index + 1) % batchSize === 0) await sleep(20);
    }
    await sleep(120);
  }

  progress({ phase: "waiting", total: hosts.length, scanned, found: Object.keys(found).length });
  await new Promise((resolve: any) => setTimeout(resolve, timeoutMs));
  socket.close();
  return found;
}

const KNOWN_DISCOVERY_PROBES: any[] = [
  { eoj: "0x027D01", epcs: ["0xE4", "0xDA"] },
  { eoj: "0x027901", epcs: ["0xE0"] },
  { eoj: "0x028701", epcs: ["0xC6", "0xB7"] },
  { eoj: "0x027C01", epcs: ["0xC4", "0xCB"] },
];

function configuredDiscoveryHosts(config: any): any {
  return [
    config.batteryHost,
    config.smartCosmoEnabled ? config.meterHost : null,
    config.solarEnabled ? config.solarHost : null,
    ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
  ].filter((host: any) => host && !isDocumentationHost(host));
}

async function enrichDiscoveredDevices(devices: any, config: any, progress: any = () => {}): Promise<any> {
  const hosts: any[] = [...new Set([...Object.keys(devices), ...configuredDiscoveryHosts(config)])];
  if (!hosts.length) return devices;
  const enriched = mergeDiscoveredDevices(devices);
  let scanned = 0;
  progress({ phase: "identifying", total: hosts.length, scanned: 0, found: Object.keys(enriched).length });
  for (const host of hosts) {
    const instances: any[] = [];
    for (const probe of KNOWN_DISCOVERY_PROBES) {
      const eoj = probe.eoj;
      let detected = false;
      try {
        const result: any = await runDeviceCommandQueued("inspect-host", { host, eoj, timeout: 2 });
        const entry = result?.[eoj.toLowerCase()];
        detected = entry && !entry.error;
      } catch {
        // Silent hosts are normal during subnet discovery.
      }
      for (const epc of probe.epcs) {
        if (detected) break;
        try {
          const result: any = await runDeviceCommandQueued("raw-get", { host, eoj, timeout: 2 }, [epc]);
          detected = typeof result?.raw === "string" && result.raw.startsWith("0x");
        } catch {
          // Not every device exposes every role. Keep trying the remaining hints.
        }
      }
      if (detected) instances.push(eoj.slice(2).toLowerCase());
    }
    if (instances.length) {
      enriched[host] = mergeDiscoveredDevices(enriched, {
        [host]: { all_instances: instances, storage_battery_instances: [] },
      })[host];
    }
    scanned += 1;
    progress({ phase: "identifying", total: hosts.length, scanned, found: Object.keys(enriched).length });
  }
  return enriched;
}

function suggestedConfigFromDiscovery(devices: any, currentConfig: any): any {
  const next: Record<string, any> = { ...currentConfig };
  const fuelCellHosts = new Set(next.fuelCellHosts);
  for (const [host, device] of Object.entries(devices) as Array<[string, any]>) {
    const instances = device.all_instances ?? [];
    if (instances.some((item: any) => item.toLowerCase().startsWith("027d"))) next.batteryHost = host;
    if (instances.some((item: any) => item.toLowerCase().startsWith("0279"))) {
      next.solarHost = host;
      next.solarEnabled = true;
    }
    if (instances.some((item: any) => item.toLowerCase().startsWith("0287"))) {
      next.meterHost = host;
      next.smartCosmoEnabled = true;
    }
    if (instances.some((item: any) => item.toLowerCase().startsWith("027c"))) {
      fuelCellHosts.add(host);
      next.fuelCellEnabled = true;
    }
  }
  next.fuelCellHosts = [...fuelCellHosts];
  return cleanConfig(next);
}

function discoveryResult(devices: any, network: any, config: any): any {
  const discovered = Object.entries(devices).map(([host, device]: any) => ({
    host,
    roles: inferDevice(device.all_instances ?? []),
    instances: device.all_instances ?? [],
  }));
  return {
    discovered,
    network,
    suggestedConfig: suggestedConfigFromDiscovery(devices, config),
  };
}

async function discoverDevices(timeout: any = 5, mode: any = "broadcast", progress: any = () => {}, requestedSubnets: any = []): Promise<any> {
  const config = await readConfig();
  const network = localNetworkHints(config);
  const scanTimeout = Number(timeout) || 5;
  const subnets = normalizeSubnets(requestedSubnets).length
    ? normalizeSubnets(requestedSubnets)
    : network.userSubnets.length
      ? network.userSubnets
      : network.configuredSubnets.length
        ? network.configuredSubnets
        : network.containerSubnets;
  if (mode === "active") {
    const activeDevices = await activeScanSubnets(
      subnets,
      Math.max(1000, scanTimeout * 1000),
      (patch: any) => progress({ ...patch, network }),
    );
    const devices = await enrichDiscoveredDevices(
      activeDevices,
      config,
      (patch: any) => progress({ ...patch, network }),
    );
    return discoveryResult(devices, network, config);
  }

  const activeDevices = await activeScanSubnets(
    subnets,
    Math.max(1000, scanTimeout * 1000),
    (patch: any) => progress({ ...patch, network }),
  );
  progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(activeDevices).length, network });
  const broadcastDevices = await runDeviceCommandQueued("discover", { timeout: scanTimeout });
  progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(mergeDiscoveredDevices(activeDevices, broadcastDevices)).length, network });
  const devices = await enrichDiscoveredDevices(
    mergeDiscoveredDevices(activeDevices, broadcastDevices),
    config,
    (patch: any) => progress({ ...patch, network }),
  );
  return discoveryResult(devices, network, config);
}

function discoveryJobView(job: any): any {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    total: job.total,
    scanned: job.scanned,
    found: job.found,
    network: job.network,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function cleanupDiscoveryJobs(): any {
  const cutoff = Date.now() - DISCOVERY_JOB_TTL_MS;
  for (const [id, job] of discoveryJobs) {
    if (new Date(job.updatedAt).getTime() < cutoff) discoveryJobs.delete(id);
  }
}

function updateDiscoveryJob(job: any, patch: any): any {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function discoveryInProgress(): any {
  return discoveryRunContext !== null;
}

async function withDiscoveryRun(label: any, fn: any): Promise<any> {
  if (discoveryRunContext) {
    throw new Error(`discovery already running (${discoveryRunContext.label})`);
  }
  discoveryRunContext = {
    label,
    startedAt: new Date().toISOString(),
  };
  try {
    return await fn();
  } finally {
    discoveryRunContext = null;
  }
}

function startDiscoveryJob(timeout: any, mode: any = "broadcast", subnets: any = []): any {
  cleanupDiscoveryJobs();
  const job: Record<string, any> = {
    id: randomUUID(),
    status: "running",
    phase: "starting",
    total: 0,
    scanned: 0,
    found: 0,
    network: null,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  discoveryJobs.set(job.id, job);
  withDiscoveryRun(`${mode} discovery`, () =>
    discoverDevices(timeout, mode, (patch: any) => updateDiscoveryJob(job, patch), subnets),
  )
    .then((result: any) => {
      updateDiscoveryJob(job, {
        status: "complete",
        phase: "complete",
        found: result.discovered.length,
        result,
      });
    })
    .catch((err: any) => {
      updateDiscoveryJob(job, {
        status: "failed",
        phase: "failed",
        error: err.message,
      });
    });
  return discoveryJobView(job);
}

function startScheduler(): any {
  scheduleTimer = setInterval(() => {
    runDueSchedules().catch((err: any) => logDetailedError("scheduler", err));
  }, SCHEDULE_CHECK_INTERVAL_MS);
  automationTimer = setInterval(() => {
    runAutomationRulesScheduled().catch((err: any) => logDetailedError("automation", err));
  }, AUTOMATION_CHECK_INTERVAL_MS);
  runDueSchedules().catch((err: any) => logDetailedError("scheduler", err));
  runAutomationRulesScheduled().catch((err: any) => logDetailedError("automation", err));
}

function stopApplicationBackgroundProcesses(): any {
  backgroundProcessesEnabled = false;
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (automationTimer) clearInterval(automationTimer);
  if (recorderTimer) clearTimeout(recorderTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  scheduleTimer = null;
  automationTimer = null;
  recorderTimer = null;
  retentionTimer = null;
  clearAdaptiveChargingSlotEndTimer();
}

async function runRetentionMaintenance(): Promise<any> {
  if (retentionRunPromise) return retentionRunPromise;
  retentionRunPromise = (async () => {
    try {
      const config = await readConfig();
      if (config.retention.automaticMaintenance) await trimHistory(config.retention);
      try {
        await updateCurrentGasTariff(config);
      } catch (error: any) {
        logDetailedError("gas-tariff", error);
      }
    } catch (err: any) {
      logDetailedError("retention", err);
    } finally {
      retentionRunPromise = null;
    }
  })();
  return retentionRunPromise;
}

function startApplicationBackgroundProcesses(): any {
  backgroundProcessesEnabled = true;
  Promise.all([readAdaptiveChargingState(), readOperationalOverridesState()])
    .then(([state, operationalOverrides]: any) => {
      if (backupPreparationBlocksActions(operationalOverrides)) {
        clearAdaptiveChargingSlotEndTimer();
        return false;
      }
      return syncAdaptiveChargingSlotEndTimer(state);
    })
    .catch((error: any) => logDetailedError("adaptive-charging-slot-end-startup", error));
  startScheduler();
  startBackgroundRecorder();
  retentionTimer = setInterval(runRetentionMaintenance, 24 * 60 * 60_000);
  retentionTimer.unref?.();
  void runRetentionMaintenance();
}

async function waitForDatabaseWriters(timeoutMs: any = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (automationRunInProgress
    || activeDeviceCommands.size > 0
    || deviceQueue.isRunning
    || runningScheduleIds.size > 0
    || retentionRunPromise
    || statusRefreshPromise) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for active application work before database restore");
    }
    await new Promise((resolve: any) => setTimeout(resolve, 50));
  }
}

function anyDeviceConfigured(config: any): any {
  // A real device is any host that isn't blank or one of the placeholder
  // documentation addresses shipped in DEFAULT_CONFIG.
  const hosts: any[] = [
    config.batteryHost,
    config.smartCosmoEnabled ? config.meterHost : null,
    config.solarEnabled ? config.solarHost : null,
    ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
  ];
  return hosts.some((host: any) => host && !isDocumentationHost(host));
}

function startBackgroundRecorder(): any {
  // History is only useful if it is captured continuously, so the server polls
  // devices on its own cadence instead of relying on an open browser tab to
  // drive /api/status. readAllStatus() records one sample per call. A recursive
  // timer (rescheduled after each read completes) guarantees reads never
  // overlap, even if one takes longer than the configured interval.
  const scheduleNext = (intervalMs: any) => {
    if (!backgroundProcessesEnabled) return;
    recorderTimer = setTimeout(tick, intervalMs);
    if (typeof recorderTimer.unref === "function") recorderTimer.unref();
  };
  async function tick(): Promise<any> {
    if (!backgroundProcessesEnabled) return;
    let intervalMs = DEFAULT_CONFIG.updateIntervalSeconds * 1000;
    try {
      const config = await readConfig();
      intervalMs =
        Math.max(5, configNumber(config.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 5, 3600)) * 1000;
      if (discoveryInProgress()) {
        console.warn(`recorder: discovery is running (${discoveryRunContext.label}); skipping this poll`);
      } else if (anyDeviceConfigured(config)) {
        const status = await getStatusSnapshot({ maxAgeMs: Math.max(0, intervalMs - 1) });
        observeDeviceNotifications(status, config);
        observeBatterySocNotifications(status, config);
        observeFuelCellHotWaterNotifications(status, config);
      }
    } catch (err: any) {
      logDetailedError("recorder", err);
    } finally {
      scheduleNext(intervalMs);
    }
  }
  tick();
}

function databaseOperationProgress(patch: any): any {
  Object.assign(databaseOperation, patch);
}

async function databaseBackupsView(): Promise<any> {
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: { ...databaseOperation },
    backups: await listDatabaseBackups({
      backupDir: DATABASE_BACKUP_DIR,
      currentVersion: SCHEMA_VERSION,
    }),
  };
}

async function withDatabaseOperation(type: any, filename: any, operation: any): Promise<any> {
  if (databaseOperation.busy) {
    throw requestError(409, `Database ${databaseOperation.type} is already running`);
  }
  databaseOperation = {
    busy: true,
    type,
    filename: filename ?? null,
    phase: "preparing",
    percent: 0,
    processed: 0,
    total: 0,
    unit: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    result: null,
  };
  try {
    const result = await operation((progress: any) => databaseOperationProgress(progress));
    databaseOperationProgress({
      busy: false,
      phase: "complete",
      percent: 100,
      completedAt: new Date().toISOString(),
      result,
    });
    return result;
  } catch (error: any) {
    databaseOperationProgress({
      busy: false,
      phase: "failed",
      completedAt: new Date().toISOString(),
      error: error.message,
      result: null,
    });
    throw error;
  }
}

async function manualDatabaseBackup(): Promise<any> {
  return withDatabaseOperation("backup", null, async (onProgress: any) => {
    const result = await backupDatabaseManually({
      databaseFile: historyStore.databaseFile,
      backupDir: DATABASE_BACKUP_DIR,
      sourceVersion: SCHEMA_VERSION,
      onProgress,
    });
    historyStore.recordEvent({
      eventKey: `database:manual-backup:${result.filename}`,
      at: new Date().toISOString(),
      category: "database",
      type: "manual-backup",
      message: `Manual database backup created: ${result.filename}`,
      payload: {
        filename: result.filename,
        compressedBytes: result.compressedBytes,
        durationMs: result.durationMs,
        schemaVersion: SCHEMA_VERSION,
      },
    });
    return {
      filename: result.filename,
      compressedBytes: result.compressedBytes,
      durationMs: result.durationMs,
      schemaVersion: SCHEMA_VERSION,
    };
  });
}

async function compatibleBackup(filename: any): Promise<any> {
  if (path.basename(filename) !== filename || !filename.endsWith(".sqlite.zst")) {
    throw requestError(400, "Invalid database backup filename");
  }
  const backups = await listDatabaseBackups({
    backupDir: DATABASE_BACKUP_DIR,
    currentVersion: SCHEMA_VERSION,
  });
  const backup = backups.find((item: any) => item.filename === filename);
  if (!backup) throw requestError(404, "Database backup not found");
  if (!backup.compatible) {
    throw requestError(409, `Backup schema v${backup.schemaVersion ?? "unknown"} cannot be restored by application schema v${SCHEMA_VERSION}`);
  }
  return { ...backup, path: path.join(DATABASE_BACKUP_DIR, filename) };
}

async function restoreDatabaseBackup(filename: any): Promise<any> {
  const backup = await compatibleBackup(filename);
  return withDatabaseOperation("restore", filename, async (onProgress: any) => {
    let extracted: any = null;
    let originalMoved = false;
    let backgroundStopped = false;
    let databaseReady = true;
    const databaseFile = historyStore.databaseFile;
    const originalFile = `${databaseFile}.restore-original-${randomUUID()}.tmp`;
    try {
      extracted = await extractAndValidateDatabaseBackup({
        backupFile: backup.path,
        workingDir: DATA_DIR,
        onProgress,
      });
      if (extracted.schemaVersion !== SCHEMA_VERSION) {
        throw requestError(409, `Backup contains schema v${extracted.schemaVersion}; application requires schema v${SCHEMA_VERSION}`);
      }
      const backupArchitectureVersion = architectureVersionForDatabase(extracted.snapshotFile);
      if (backupArchitectureVersion !== ARCHITECTURE_VERSION) {
        throw requestError(
          409,
          `Backup uses application architecture ${backupArchitectureVersion ?? "unversioned"}; version ${ARCHITECTURE_VERSION} is required`,
        );
      }

      onProgress({ phase: "safety-backup", percent: 0, processed: 0, total: 0, unit: null });
      const safetyBackup = await backupDatabaseManually({
        databaseFile,
        backupDir: DATABASE_BACKUP_DIR,
        sourceVersion: SCHEMA_VERSION,
        beforeRestore: true,
        onProgress(progress: any): any {
          onProgress({ ...progress, phase: `safety-${progress.phase}` });
        },
      });

      onProgress({ phase: "stopping", percent: 0, processed: 0, total: 0, unit: null });
      stopApplicationBackgroundProcesses();
      backgroundStopped = true;
      await waitForDatabaseWriters();
      applicationStore.close();
      historyStore.close();
      databaseReady = false;
      await Promise.all([
        rm(`${databaseFile}-wal`, { force: true }),
        rm(`${databaseFile}-shm`, { force: true }),
      ]);

      onProgress({ phase: "restoring", percent: 50, processed: 1, total: 2, unit: "files" });
      await rename(databaseFile, originalFile);
      originalMoved = true;
      await rename(extracted.snapshotFile, databaseFile);
      extracted = null;
      await historyStore.initialize();
      await applicationStore.initialize();
      databaseReady = true;
      await rm(originalFile, { force: true });
      originalMoved = false;
      lastRecordedSample = historyStore.latestSample();
      latestStatusSnapshot = null;
      statusRefreshPromise = null;
      adaptiveChargingHistoryCache = null;
      adaptiveChargingDemandProfileIndexPromise = null;
      try {
        historyStore.recordEvent({
          eventKey: `database:restore:${filename}:${new Date().toISOString()}`,
          at: new Date().toISOString(),
          category: "database",
          type: "manual-restore",
          message: `Database restored from ${filename}`,
          payload: {
            filename,
            schemaVersion: SCHEMA_VERSION,
            safetyBackupFilename: safetyBackup.filename,
          },
        });
      } catch (error: any) {
        logDetailedError("database-restore-event", error);
      }
      onProgress({ phase: "restarting", percent: 100, processed: 2, total: 2, unit: "files" });
      return {
        filename,
        schemaVersion: SCHEMA_VERSION,
        safetyBackupFilename: safetyBackup.filename,
      };
    } catch (error: any) {
      if (originalMoved) {
        try {
          applicationStore.close();
          historyStore.close();
          databaseReady = false;
          await Promise.all([
            rm(databaseFile, { force: true }),
            rm(`${databaseFile}-wal`, { force: true }),
            rm(`${databaseFile}-shm`, { force: true }),
          ]);
          await rename(originalFile, databaseFile);
          originalMoved = false;
          await historyStore.initialize();
          await applicationStore.initialize();
          databaseReady = true;
          lastRecordedSample = historyStore.latestSample();
        } catch (rollbackError: any) {
          logDetailedError("database-restore-rollback", rollbackError);
          throw new Error(`${error.message}; database rollback also failed: ${rollbackError.message}`);
        }
      } else if (!databaseReady) {
        try {
          await historyStore.initialize();
          await applicationStore.initialize();
          databaseReady = true;
          lastRecordedSample = historyStore.latestSample();
        } catch (reopenError: any) {
          logDetailedError("database-restore-reopen", reopenError);
          throw new Error(`${error.message}; database reopen also failed: ${reopenError.message}`);
        }
      }
      throw error;
    } finally {
      if (extracted?.snapshotFile) await cleanupExtractedDatabaseBackup(extracted.snapshotFile);
      if (backgroundStopped && databaseReady) startApplicationBackgroundProcesses();
    }
  });
}

async function removeDatabaseBackup(filename: any): Promise<any> {
  if (path.basename(filename) !== filename || !filename.endsWith(".sqlite.zst")) {
    throw requestError(400, "Invalid database backup filename");
  }
  const backups = await listDatabaseBackups({ backupDir: DATABASE_BACKUP_DIR, currentVersion: SCHEMA_VERSION });
  if (!backups.some((item: any) => item.filename === filename)) throw requestError(404, "Database backup not found");
  return withDatabaseOperation("delete", filename, async (onProgress: any) => {
    onProgress({ phase: "deleting", percent: 50, processed: 0, total: 1, unit: "files" });
    await deleteDatabaseBackup({ backupDir: DATABASE_BACKUP_DIR, filename });
    onProgress({ phase: "deleting", percent: 100, processed: 1, total: 1, unit: "files" });
    return { filename };
  });
}

async function api(req: any, res: any, url: any): Promise<any> {
  if (req.method === "GET" && url.pathname === "/api/database-backups") {
    return json(res, 200, await databaseBackupsView());
  }
  if (databaseOperation.busy) {
    return json(res, 503, {
      error: `Database ${databaseOperation.type} is in progress`,
      operation: { ...databaseOperation },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/database-backups") {
    await readBody(req);
    await manualDatabaseBackup();
    return json(res, 201, await databaseBackupsView());
  }
  if (url.pathname.startsWith("/api/database-backups/")) {
    const encodedFilename = url.pathname.slice("/api/database-backups/".length).split("/")[0];
    let filename;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw requestError(400, "Invalid database backup filename");
    }
    if (req.method === "POST" && url.pathname.endsWith("/restore")) {
      await readBody(req);
      await restoreDatabaseBackup(filename);
      return json(res, 200, await databaseBackupsView());
    }
    if (req.method === "DELETE" && !url.pathname.endsWith("/restore")) {
      await removeDatabaseBackup(filename);
      return json(res, 200, await databaseBackupsView());
    }
  }
  if (req.method === "GET" && url.pathname === "/api/notifications") {
    return json(res, 200, await notificationService.view());
  }
  if (req.method === "PUT" && url.pathname === "/api/notifications") {
    const body = await readBody(req);
    const notifications = normalizeNotificationConfig(body.config ?? body.notifications ?? body);
    const config = await writeConfig({ notifications });
    await notificationService.updateSecret({
      channelId: notifications.channels[0].id,
      password: body.password,
      clearPassword: body.clearPassword === true,
    });
    return json(res, 200, await notificationService.view(config));
  }
  if (req.method === "POST" && url.pathname === "/api/notifications/test") {
    if (EXTERNAL_IO_DISABLED) throw requestError(403, "External notification delivery is disabled in simulated UI development");
    return json(res, 200, await notificationService.sendTest());
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      ...(await readConfig()),
      port: PORT,
      runtime: {
        uiDevelopment: UI_DEVELOPMENT_MODE,
        simulatedDevices: UI_DEVELOPMENT_MODE,
        externalIoDisabled: EXTERNAL_IO_DISABLED,
        architecture: applicationStore.status(),
      },
    });
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await writeConfig(await readBody(req))), port: PORT });
  }
  if (req.method === "POST" && url.pathname === "/api/history/trim") {
    const config = await readConfig();
    const body = await readBody(req);
    const retention = body.retention
      ?? (body.retentionDays ? normalizeRetentionConfig({}, body.retentionDays) : config.retention);
    return json(res, 200, await trimHistory(retention));
  }
  if (req.method === "POST" && url.pathname === "/api/gas-tariffs/import") {
    const body = await readBody(req);
    const config = await readConfig();
    const provider = String(body.provider ?? config.fuelCell?.tariff?.provider ?? "tokyo-gas");
    const billingMonth = String(body.billingMonth ?? body.month ?? "");
    if (!validBillingMonth(billingMonth)) return json(res, 400, { error: "billingMonth must be YYYY-MM" });
    let imported;
    if (body.tariff || body.bands) {
      const payload = normalizeGasTariffPayload(body.tariff ?? body);
      imported = {
        provider,
        billingMonth,
        sourceUrl: body.sourceUrl ?? payload.providerPlanUrl ?? null,
        sourceHash: gasTariffHash(payload),
        payload,
      };
    } else {
      if (EXTERNAL_IO_DISABLED) throw requestError(403, "External tariff import is disabled in simulated UI development");
      imported = await importGasTariff(provider, {
        billingMonth,
        readingDay: config.fuelCell?.tariff?.meterReadingDay ?? 1,
        region: config.fuelCell?.tariff?.region ?? "tokyo",
        plan: config.fuelCell?.tariff?.plan ?? "enefarm",
      });
    }
    return json(res, 201, historyStore.recordGasTariffSnapshot({ ...imported, fetchedAt: new Date().toISOString() }));
  }
  if (req.method === "POST" && url.pathname === "/api/discovery/jobs") {
    const body = await readBody(req);
    return json(res, 202, startDiscoveryJob(body.timeout, body.mode, body.subnets));
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/discovery/jobs/")) {
    cleanupDiscoveryJobs();
    const id = url.pathname.split("/").pop();
    const job = discoveryJobs.get(id);
    if (!job) return json(res, 404, { error: "discovery job not found" });
    return json(res, 200, discoveryJobView(job));
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    if (discoveryInProgress()) {
      if (latestStatusSnapshot) {
        return json(res, 200, {
          ...latestStatusSnapshot,
          batteryStrategy: await batteryStrategyView(),
          alerts: await systemAlertsView(latestStatusSnapshot),
          statusRefreshPaused: true,
          statusRefreshPausedReason: `discovery is running (${discoveryRunContext.label})`,
        });
      }
      return json(res, 409, {
        error: `discovery is running (${discoveryRunContext.label}); status polling is paused`,
      });
    }
    const config = await readConfig();
    const maxAgeMs = Math.max(5, Number(config.updateIntervalSeconds) || DEFAULT_CONFIG.updateIntervalSeconds) * 1000;
    const snapshot = await getStatusSnapshot({ maxAgeMs });
    return json(res, 200, {
      ...snapshot,
      batteryStrategy: await batteryStrategyView(),
      alerts: await systemAlertsView(snapshot),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/command-receipts") {
    const before = url.searchParams.get("before");
    const beforeMs = before ? new Date(before).getTime() : Date.now();
    if (!Number.isFinite(beforeMs)) return json(res, 400, { error: "before must be an ISO date/time" });
    return json(res, 200, {
      receipts: readCommandReceipts(url.searchParams.get("limit"), beforeMs),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/device-commands") {
    const body = await readBody(req);
    return json(res, 202, await startDeviceCommand(String(body.action ?? ""), body.payload ?? {}, { source: "manual" }));
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/device-commands/")) {
    const commandId = decodeURIComponent(url.pathname.slice("/api/device-commands/".length));
    if (!/^[a-z0-9-]{8,}$/i.test(commandId)) return json(res, 400, { error: "invalid command id" });
    const receipt = readCommandReceipt(commandId);
    return receipt ? json(res, 200, receipt) : json(res, 404, { error: "command receipt not found" });
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    const config = await readConfig();
    return json(res, 200, await readHistoryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
  }
  if (req.method === "GET" && url.pathname === "/api/history/summary") {
    const config = await readConfig();
    return json(res, 200, await readHistorySummaryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
  }
  if (req.method === "GET" && url.pathname === "/api/history/stats") {
    return json(res, 200, await readHistoryStats());
  }
  if (req.method === "GET" && url.pathname === "/api/reports/energy") {
    const config = await readConfig();
    return json(
      res,
      200,
      await readEnergyReport(
        url.searchParams.get("start"),
        url.searchParams.get("end"),
        url.searchParams.get("bucket"),
        config,
      ),
    );
  }
  if (req.method === "GET" && url.pathname === "/api/ene-farm") {
    const config = await readConfig();
    const start = url.searchParams.get("start") ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const end = url.searchParams.get("end") ?? new Date().toISOString();
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return json(res, 400, { error: "valid start and end are required" });
    const samples = await readHistorySamplesInRange(startMs, endMs);
    const allTransitions = historyStore.eventsBetween("fuelCell", 0, endMs)
      .filter((event: any) => event.type === "state-transition");
    const rangeStateTransitions = allTransitions.filter((event: any) => {
      const atMs = new Date(event.at).getTime();
      return Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs;
    });
    const latestStateTransition = allTransitions.at(-1) ?? null;
    const lastStopTransition = allTransitions.findLast((event: any) => event.payload?.to === "stopped") ?? null;
    const readingDay = config.fuelCell?.tariff?.meterReadingDay ?? 1;
    const billingPeriodUsage = await measuredFuelCellGasByBillingPeriod(start, end, readingDay);
    const summary = summarizeEneFarmSamples(samples, config, {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      billingPeriodGasM3: billingPeriodUsage.get(billingPeriodKey(start, readingDay)) ?? null,
    });
    if (latestStateTransition?.at) {
      summary.stateSince = latestStateTransition.at;
      summary.timeInStateSeconds = Math.max(0, (endMs - new Date(latestStateTransition.at).getTime()) / 1000);
    }
    if (lastStopTransition?.at) summary.lastStopAt = lastStopTransition.at;
    return json(res, 200, {
      ...summary,
      transitions: rangeStateTransitions,
      configured: config.fuelCellEnabled !== false,
      estimateNotice: "All costs and savings are estimates. Check your provider statement for accurate billing information.",
    });
  }
  if (req.method === "GET" && url.pathname === "/api/reports/ene-farm") {
    const config = await readConfig();
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const bucket = normalizeReportBucket(url.searchParams.get("bucket") ?? "day");
    if (!start || !end) return json(res, 400, { error: "start and end are required" });
    return json(res, 200, await eneFarmReport(start, end, bucket, config));
  }
  if (req.method === "GET" && url.pathname === "/api/away-periods") {
    return json(res, 200, awayPeriodsView());
  }
  if (req.method === "POST" && url.pathname === "/api/away-periods") {
    const now = new Date();
    const period = cleanNewAwayPeriod(await readBody(req), now);
    ensureAwayPeriodDoesNotOverlap(period);
    const created = historyStore.createAwayPeriod(period);
    await queueAdaptiveChargingForAwayChange("Away schedule created", now);
    return json(res, 201, { period: created, ...awayPeriodsView(now) });
  }
  if (url.pathname.startsWith("/api/away-periods/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const operation = parts[3] ?? null;
    const now = new Date();
    const existing = historyStore.awayPeriod(id, now.getTime());
    if (!existing) throw requestError(404, "Away period not found");
    if (req.method === "PATCH" && !operation) {
      if (existing.status !== "scheduled") throw requestError(409, "Only an Away period that has not started can be edited");
      const body = await readBody(req);
      const from = awayTimestamp(body.from, "From");
      const until = awayTimestamp(body.until, "Until");
      if (from.getTime() < now.getTime() - 60_000) throw requestError(400, "From cannot be in the past");
      if (until.getTime() <= from.getTime()) throw requestError(400, "Until must be after From");
      const updated: Record<string, any> = {
        ...existing,
        from: from.toISOString(),
        until: until.toISOString(),
        updatedAt: now.toISOString(),
      };
      ensureAwayPeriodDoesNotOverlap(updated, id);
      historyStore.updateAwayPeriod(updated);
      await queueAdaptiveChargingForAwayChange("Away schedule edited", now);
      return json(res, 200, awayPeriodsView(now));
    }
    if (req.method === "DELETE" && !operation) {
      if (existing.status !== "scheduled") throw requestError(409, "Only an Away period that has not started can be deleted");
      historyStore.deleteAwayPeriod(id);
      await queueAdaptiveChargingForAwayChange("Away schedule deleted", now);
      return json(res, 200, awayPeriodsView(now));
    }
    if (req.method === "POST" && operation === "extend") {
      if (existing.status !== "active") throw requestError(409, "Only an active Away period can be extended");
      const until = awayTimestamp((await readBody(req)).until, "Until");
      if (until.getTime() <= new Date(existing.until).getTime()) {
        throw requestError(400, "The extended Until time must be later than the current Until time");
      }
      const updated: Record<string, any> = { ...existing, until: until.toISOString(), updatedAt: now.toISOString() };
      ensureAwayPeriodDoesNotOverlap(updated, id);
      historyStore.updateAwayPeriod(updated);
      await queueAdaptiveChargingForAwayChange("Active Away period extended", now);
      return json(res, 200, awayPeriodsView(now));
    }
    if (req.method === "POST" && operation === "back-home") {
      if (existing.status !== "active") throw requestError(409, "Back Home is only available during an active Away period");
      historyStore.updateAwayPeriod({ ...existing, until: now.toISOString(), updatedAt: now.toISOString() });
      await queueAdaptiveChargingForAwayChange("Returned home early", now);
      return json(res, 200, awayPeriodsView(now));
    }
  }
  if (req.method === "GET" && url.pathname === "/api/adaptive-charging") {
    const config = await readConfig();
    const rules = await readAutomationRules();
    return json(res, 200, adaptiveChargingView(config, await readAdaptiveChargingState(), rules));
  }
  if (req.method === "POST" && url.pathname === "/api/adaptive-charging/recalculate") {
    const config = await readConfig();
    const rules = await readAutomationRules();
    const availability = adaptiveChargingAvailability(config, rules);
    if (!availability.available) return json(res, 409, { error: availability.reason });
    const now = new Date();
    let state = await refreshAdaptiveChargingForecast(config, { forceHistorical: true, now });
    if (!state.forecast || !forecastIsFresh(state.forecast, now) || state.lastForecastError) {
      return json(res, 503, adaptiveChargingView(config, state, rules));
    }
    const samples = await readAdaptiveChargingHistory(now);
    state = {
      ...state,
      historicalWeather: historyStore.historicalWeather(),
      solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy(now),
    };
    await refreshBatteryLearning(config, state, now);
    const historicalDemandDays = await readAdaptiveChargingDemandProfileDays();
    const awayPeriods = historyStore.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
    state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
    recordFuelCellPlanForecast(state.plan, now);
    state.lastPlanEventKey = adaptiveChargingScheduledEvent(config, now).eventKey ?? `manual:${now.toISOString()}`;
    state.pendingPlanReason = null;
    state.pendingPlanRequestId = null;
    state.pendingPlanRequestedAt = null;
    if (state.interruptedCharge) {
      const capped = applyInterruptedChargeCap(
        state.plan,
        state.interruptedCharge,
        config.batteryCapabilities.maximumChargeWatts,
        now,
      );
      state.plan = capped.plan;
      state.interruptedCharge = capped.interruption;
    }
    appendAdaptiveChargingLog(
      state,
      adaptiveChargingPlanLogMessage(state.plan, "manual request", state.plan.currentSocPercent),
      state.plan.warning ? "warning" : "plan",
      now,
    );
    state = await writeAdaptiveChargingState(state);
    return json(res, 200, adaptiveChargingView(config, state, rules));
  }
  if (req.method === "POST" && url.pathname === "/api/adaptive-charging/resume") {
    await assertActionAllowedByOperationalOverride("adaptive-charging", "resume");
    const config = await readConfig();
    const rules = await readAutomationRules();
    return json(res, 200, adaptiveChargingView(config, await resumeAdaptiveCharging(), rules));
  }
  if (req.method === "GET" && url.pathname === "/api/backup-preparation") {
    return json(res, 200, backupPreparationView(await readOperationalOverridesState()));
  }
  if (req.method === "POST" && url.pathname === "/api/backup-preparation/start") {
    const body = await readBody(req);
    return json(res, 200, await startBackupPreparation({
      allowDemandGuard: body.allowDemandGuard !== false,
    }));
  }
  if (req.method === "POST" && url.pathname === "/api/backup-preparation/end") {
    await readBody(req);
    return json(res, 200, await endBackupPreparation());
  }
  if (req.method === "GET" && url.pathname === "/api/schedules") {
    return json(res, 200, await readSchedules());
  }
  if (req.method === "GET" && url.pathname === "/api/automation-rules") {
    return json(res, 200, await readAutomationRules());
  }
  if (req.method === "POST" && url.pathname === "/api/automation-rules") {
    const body = await readBody(req);
    const rules = await readAutomationRules();
    const rule = cleanAutomationRule({ ...body, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    rules.push(rule);
    await writeAutomationRules(rules);
    await writeAutomationRuleStates(rules);
    return json(res, 201, rule);
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/automation-rules/")) {
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const rules = await readAutomationRules();
    const index = rules.findIndex((item: any) => item.id === id);
    if (index < 0) return json(res, 404, { error: "automation rule not found" });
    rules[index] = mergeAutomationRule(
      { ...rules[index], ...body, id, updatedAt: new Date().toISOString() },
      rules[index],
    );
    await writeAutomationRules(rules);
    await writeAutomationRuleStates(rules);
    return json(res, 200, rules[index]);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/automation-rules/")) {
    const id = url.pathname.split("/").pop();
    const rules = await readAutomationRules();
    const next = rules.filter((item: any) => item.id !== id);
    await writeAutomationRules(next);
    await writeAutomationRuleStates(next);
    return json(res, 200, { ok: next.length !== rules.length });
  }
  if (req.method === "POST" && url.pathname === "/api/schedules") {
    if (adaptiveChargingConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
    }
    const body = await readBody(req);
    const schedule: Record<string, any> = {
      id: randomUUID(),
      name: String(body.name || body.action || "Battery setting change"),
      action: String(body.action || ""),
      payload: body.payload || {},
      repeat: body.repeat === "daily" ? "daily" : "once",
      days: Array.isArray(body.days) && body.days.length ? body.days.map(Number).filter((day: any) => day >= 0 && day <= 6) : ALL_DAYS,
      time: body.time || undefined,
      runAt: body.runAt || undefined,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
      lastResult: null,
    };
    schedule.runAt = parseRunAt(schedule);
    await mutateSchedules((schedules: any) => {
      schedules.push(schedule);
    });
    return json(res, 201, schedule);
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/schedules/")) {
    if (adaptiveChargingConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
    }
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const schedule = await mutateSchedules((schedules: any) => {
      const existing = schedules.find((item: any) => item.id === id);
      if (!existing) return null;
      Object.assign(existing, body);
      if ("runAt" in body || "time" in body || "repeat" in body) existing.runAt = parseRunAt(existing);
      return existing;
    });
    if (!schedule) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, schedule);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
    const id = url.pathname.split("/").pop();
    const deleted = await mutateSchedules((schedules: any) => {
      const index = schedules.findIndex((item: any) => item.id === id);
      if (index < 0) return false;
      schedules.splice(index, 1);
      return true;
    });
    return json(res, 200, { ok: deleted });
  }
  return json(res, 404, { error: "not found" });
}

const serveStatic = createStaticHandler(path.join(APP_ROOT, "public"));
const apiRouter = new NativeRouter().post(
  "/api/device-actions/:action",
  async ({ request, response, params }) => {
    const body = await readBody(request);
    const action = params.action ?? "";
    if (!DEVICE_ACTIONS.has(action)) throw requestError(404, `unknown action: ${action}`);
    const result = await executeAction(action, body, { source: "manual" });
    json(response, 200, result);
  },
);

async function initializeApplication(): Promise<any> {
  if (applicationStarted) return;
  await historyStore.initialize();
  await applicationStore.initialize();
  if (!activeDeviceAdapter) await configureDeviceCommandAdapter();
  lastRecordedSample = historyStore.latestSample();
  const startupConfig = await readConfig();
  const startupAdaptiveChargingState = await readAdaptiveChargingState();
  await refreshBatteryLearning(startupConfig, startupAdaptiveChargingState);
  await writeAdaptiveChargingState(startupAdaptiveChargingState);
  await writeAutomationRuleStates(await readAutomationRules());
  await reconcileBackupPreparationOnStartup();
  startApplicationBackgroundProcesses();
  applicationStarted = true;
}

export const server = http.createServer(async (req: any, res: any) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (!requestHasValidOrigin(req)) {
      return json(res, 403, { error: "cross-origin state-changing requests are not allowed" });
    }
    if (url.pathname.startsWith("/api/")) {
      if (await apiRouter.dispatch(req, res, url)) return;
      await api(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err: any) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (status >= 500) logDetailedError("api", err);
    json(res, status, {
      error: err.message,
      ...(err.commandId ? { commandId: err.commandId } : {}),
      ...(err.commandState ? { commandState: err.commandState } : {}),
    });
  }
});

export {
  recoverIdleAdaptiveCharge,
  adaptiveChargingWindowHasShortfall,
  mergeAdaptiveChargingSlots,
  updateActiveAdaptiveChargingObjective,
  activeAdaptiveChargingSlotStopReason,
  advanceAdaptiveChargingBreakerRecovery,
  aggregateDemandDays,
  applySolarForecastBias,
  applyInterruptedChargeCap,
  aggregateEnergyReportSamples,
  adaptiveChargingExportEvidence,
  adaptiveChargingTimingProfile,
  assertDeviceCommandResult,
  beginAdaptiveChargingBreakerRecovery,
  buildAdaptiveChargingPlan,
  buildAdaptiveChargingTimelineView,
  batteryLearningModelSwitchDue,
  consumeBatteryLearningModelSwitch,
  capAdaptiveChargingSlotToRemainingTime,
  clearStaleScheduleRuns,
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  cleanConfig,
  cleanAdaptiveChargingPerformance,
  cleanAdaptiveChargingState,
  consumeCompletedAdaptiveChargingSlot,
  countGuardTriggersForRange,
  discountedBandOccurrence,
  discountedBandOccurrences,
  discountedPlanStatus,
  dailySolarForecastIssues,
  buildBatteryLearningModel,
  buildBatteryChargePowerCurve,
  buildFuelCellGenerationModel,
  effectiveBatteryLearningModel,
  effectiveAdaptiveChargeWatts,
  estimateChargeDurationMs,
  estimateDeliverableChargeWh,
  executeAdaptiveChargeStart,
  evaluateAutomationRule,
  finalizeAdaptiveChargeSession,
  finalizeAdaptiveChargingWindowExecution,
  forecastHourForInterval,
  forecastIsFresh,
  fuelCellGasUsageByBillingPeriod,
  fuelCellHotWaterEmptyNotificationActive,
  learnedSolarFactor,
  extractBatteryLearningObservations,
  logAdaptiveChargingInitialHeadroomWait,
  logAdaptiveChargingBreakerWait,
  normalizeDashboardWidgets,
  normalizeNotificationConfig,
  normalizeRateBands,
  normalizeSubnets,
  nextPlanningBoundary,
  optimizeDiscountedChargeSlots,
  parseOpenMeteoForecast,
  planChronologicalDiscountedCharging,
  enforceAdaptiveChargingSlotEndDeadline,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingLiveImportSafety,
  adaptiveChargingBreakerSettings,
  backupPreparationAllowsActionSource,
  backupPreparationBlocksActions,
  adaptiveChargingBreakerRecoveryReady,
  adaptiveChargingSlotEndDelayMs,
  adaptiveChargingSlotEndKey,
  adaptiveChargingTimezoneError,
  awayPeriodContains,
  awayPeriodForecastContains,
  awayPeriodsOverlap,
  filterDemandDaysByOccupancy,
  predictAwayDemand,
  rateForTimestamp,
  readHistorySummaryRange,
  readAdaptiveChargingDemandProfileDays,
  sampleFromStatus,
  shouldTriggerDemandGuard,
  shouldHoldGuardStandbyForAdaptiveCharging,
  adaptiveChargingPlanRefreshDecision,
  adaptiveChargingPlanLogMessage,
  preserveInterruptedAdaptiveCharge,
  recordAdaptiveChargingSolarHeadroomInterruption,
  recordAdaptiveChargingWindowInterruption,
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  solarPowerFromIrradiance,
  summarizeCalendarSavings,
  summarizeSamples,
  suspendAdaptiveChargeInStandby,
  syncAdaptiveChargingWindowExecution,
  updateAdaptiveChargingSolarHeadroomHold,
  updateAdaptiveChargingExportConfirmation,
  verifyBatteryOperationMode,
  predictHouseDemand,
};

export async function main(): Promise<any> {
  await startRuntime({
    server,
    host: "0.0.0.0",
    port: PORT,
    validateEnvironment: () => assertSafeUiDevelopmentEnvironment(process.env, { projectDir: COMPILED_ROOT }),
    validateStorage: async () => {
      await ensureDataDir();
      const inspection = await inspectHistoryDatabase(DATA_DIR);
      if (inspection.state !== "new" && inspection.state !== "current") {
        throw new Error(inspection.error ?? `Database is not usable (${inspection.state})`);
      }
    },
    initializeApplication,
  });
}

export async function shutdown(): Promise<any> {
  await stopRuntime({
    server,
    stopBackgroundProcesses: () => {
      if (scheduleTimer) clearInterval(scheduleTimer);
      if (automationTimer) clearInterval(automationTimer);
      if (recorderTimer) clearTimeout(recorderTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      clearAdaptiveChargingSlotEndTimer();
    },
    closeResources: async () => {
      await activeDeviceAdapter?.close?.();
      applicationStore.close();
      historyStore.close();
    },
  });
}
