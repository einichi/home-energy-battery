#!/usr/bin/env node
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  createNotificationService,
  normalizeNotificationConfig,
} from "./lib/notifications.js";
import { createHistoryStore, normalizeRetentionPolicy } from "./lib/history-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
const AUTOMATION_RULES_FILE = path.join(DATA_DIR, "automation-rules.json");
const AUTOMATION_RULE_STATE_FILE = path.join(DATA_DIR, "automation-rule-state.json");
const ADAPTIVE_CHARGING_STATE_FILE = path.join(DATA_DIR, "adaptive-charging-state.json");
const ADAPTIVE_CHARGING_DIR = path.join(DATA_DIR, "adaptive-charging");
const ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_FILE = path.join(ADAPTIVE_CHARGING_DIR, "demand-day-profiles.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_FILE = path.join(HISTORY_DIR, "samples.jsonl");
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 15000);
const CLI_FILE = "home-energy-battery-node.js";
const AUTOMATION_CHECK_INTERVAL_MS = 30_000;
const SOLAR_FORECAST_REFRESH_MS = 3 * 60 * 60_000;
const SOLAR_FORECAST_MAX_AGE_MS = 6 * 60 * 60_000;
const ADAPTIVE_CHARGING_PREWINDOW_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_HISTORY_CACHE_MS = 30 * 60_000;
const ADAPTIVE_CHARGING_SLOT_END_RETRY_MS = 5_000;
const ADAPTIVE_CHARGING_BREAKER_RETRY_COOLDOWN_MS = 3 * 60_000;
const ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS = 3;
const ADAPTIVE_CHARGING_BREAKER_SAFETY_MARGIN_W = 200;
const ADAPTIVE_CHARGING_BREAKER_WAIT_LOG_MS = 5 * 60_000;
const ADAPTIVE_CHARGING_MIN_EXECUTABLE_CHARGE_WH = 50;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const ADAPTIVE_CHARGE_SESSION_LIMIT = 30;
const ADAPTIVE_CHARGE_SAMPLE_LIMIT = 500;
const ADAPTIVE_CHARGE_EFFICIENCY_MIN_SESSIONS = 3;
const ADAPTIVE_CHARGE_EFFICIENCY_MIN_PERCENT = 50;
const ADAPTIVE_CHARGE_EFFICIENCY_MAX_PERCENT = 100;
const ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT = 30;
const ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_VERSION = 1;
const ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS = 10;
const ADAPTIVE_CHARGING_SEASONAL_DAY_RANGE = 28;
const ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR = 2;
const AWAY_RETURN_BUFFER_MS = 30 * 60_000;
const AWAY_LEARNED_MIN_DAYS = 3;

const DEFAULT_DASHBOARD_WIDGETS = [
  { id: "solarPower", group: "trends", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", visible: true, priority: 70 },
  { id: "adaptiveCharging", group: "status", visible: true, priority: 5 },
  { id: "awayStatus", group: "status", visible: true, priority: 7 },
  { id: "batteryWorking", group: "status", visible: true, priority: 10 },
  { id: "operationMode", group: "status", visible: true, priority: 20 },
  { id: "vendorProfile", group: "status", visible: true, priority: 30 },
  { id: "dischargeLimit", group: "status", visible: true, priority: 40 },
  { id: "fuelCellStatus", group: "status", visible: true, priority: 50 },
  { id: "solarSavings", group: "status", visible: true, priority: 60 },
  { id: "co2Savings", group: "status", visible: true, priority: 70 },
  { id: "offPeakSavings", group: "status", visible: true, priority: 80 },
  { id: "powerImported", group: "status", visible: true, priority: 90 },
  { id: "powerExported", group: "status", visible: true, priority: 100 },
  { id: "guardTriggerCount", group: "status", visible: true, priority: 110 },
  { id: "energySources", group: "status", visible: true, priority: 120 },
];

const DEFAULT_GUARD_CONDITIONS = {
  breakerVoltage: 100,
  breakerAmps: 40,
  reserveAmps: 5,
};

const DEFAULT_RETENTION = normalizeRetentionPolicy();

// Public defaults use RFC 5737 documentation addresses. Real deployments should
// set device addresses from the Settings page, where they are persisted in /data.
const DEFAULT_CONFIG = {
  batteryHost: "192.0.2.10",
  meterHost: "192.0.2.20",
  meterEoj: "0x028701",
  smartCosmoEnabled: true,
  circuitLabels: {},
  circuitSortMode: "number",
  solarHost: "192.0.2.10",
  solarEnabled: true,
  fuelCellHosts: ["192.0.2.30"],
  fuelCellEnabled: true,
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

let cliQueue = Promise.resolve();
let scheduleTimer = null;
let automationTimer = null;
let recorderTimer = null;
let retentionTimer = null;
let adaptiveChargingSlotEndTimer = null;
let adaptiveChargingSlotEndTimerKey = null;
let automationRunInProgress = false;
let automationRunContext = null;
let discoveryRunContext = null;
let activeCliContext = null;

const historyStore = createHistoryStore({ dataDir: DATA_DIR });
const notificationService = createNotificationService({
  dataDir: DATA_DIR,
  getConfig: () => readConfig(),
  recordEvent: (event) => historyStore.isReady() && historyStore.recordEvent(event),
});
let cliTimingSequence = 0;
const recentCliTimings = [];
let lastRecordedSample = null;
let adaptiveChargingHistoryCache = null;
let adaptiveChargingDemandProfileIndexCache = null;
let adaptiveChargingDemandProfileIndexPromise = null;
const runningScheduleIds = new Set();
const discoveryJobs = new Map();
const DISCOVERY_JOB_TTL_MS = 10 * 60 * 1000;

function cliArgs(command, args = {}) {
  const out = [path.join(__dirname, CLI_FILE), command];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.push(`--${key}`, String(item));
    } else if (value === true) {
      out.push(`--${key}`);
    } else {
      out.push(`--${key}`, String(value));
    }
  }
  return out;
}

function runCli(command, args = {}, positional = []) {
  const execArgs = [...cliArgs(command, args), ...positional.map(String)];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, execArgs, { timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      try {
        resolve(parseJsonWithContext(stdout, `CLI ${command} stdout`));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function runCliQueued(command, args = {}, positional = []) {
  const task = cliQueue.then(async () => {
    const startedMs = Date.now();
    const context = {
      command,
      host: args.host || args["battery-host"] || args["solar-host"] || null,
      startedAt: new Date(startedMs).toISOString(),
    };
    activeCliContext = context;
    try {
      return await runCli(command, args, positional);
    } finally {
      recentCliTimings.push({
        ...context,
        sequence: ++cliTimingSequence,
        durationMs: Date.now() - startedMs,
      });
      if (recentCliTimings.length > 100) recentCliTimings.shift();
      if (activeCliContext === context) activeCliContext = null;
    }
  });
  cliQueue = task.catch(() => {});
  return task;
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(HISTORY_DIR, { recursive: true });
  await mkdir(ADAPTIVE_CHARGING_DIR, { recursive: true });
}

function numericMetric(item) {
  if (item?.value === null || item?.value === undefined || item.value === "") return null;
  const value = Number(item?.value);
  return Number.isFinite(value) ? value : null;
}

function strongestFuelCellWatts(fuelCells = []) {
  const values = fuelCells.map((cell) => numericMetric(cell.instant_power)).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function circuitLabelFor(channel, labels = {}) {
  const label = String(labels?.[channel] ?? "").trim();
  return label || `Circuit ${channel}`;
}

function normalizeCircuitLabels(value = {}) {
  const out = {};
  const entries = Array.isArray(value)
    ? value.map((item) => [item?.channel, item?.label])
    : Object.entries(value ?? {});
  for (const [channelRaw, labelRaw] of entries) {
    const channel = Number(channelRaw);
    const label = String(labelRaw ?? "").trim();
    if (!Number.isInteger(channel) || channel < 1 || channel > 252 || !label) continue;
    out[String(channel)] = label.slice(0, 80);
  }
  return out;
}

function circuitChannelMap(channels = []) {
  const out = {};
  for (const channel of channels) {
    const id = Number(channel?.channel);
    const value = Number(channel?.value);
    if (!Number.isInteger(id) || id < 1 || id > 252) continue;
    out[String(id)] = Number.isFinite(value) ? value : null;
  }
  return out;
}

function circuitCumulativeMap(channels = []) {
  const out = {};
  for (const channel of channels) {
    const id = Number(channel?.channel);
    const value = Number(channel?.value);
    if (!Number.isInteger(id) || id < 1 || id > 252) continue;
    out[String(id)] = Number.isFinite(value) ? value : null;
  }
  return out;
}

function circuitEnergyDeltaKwh(current, previous) {
  if (!previous || current === null || current === undefined) return null;
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  const delta = now - before;
  return delta >= 0 ? delta : null;
}

function circuitKwhForSample(sample, channel, previousSample) {
  const id = String(channel);
  const direct = Number(sample.circuitEnergyKwh?.[id]);
  if (Number.isFinite(direct)) return direct;
  const cumulative = circuitEnergyDeltaKwh(
    sample.circuitCumulativeKwh?.[id],
    previousSample?.circuitCumulativeKwh?.[id],
  );
  if (cumulative !== null) return cumulative;
  if (!previousSample?.timestamp || !sample?.timestamp) return 0;
  const watts = Number(sample.circuitPowerW?.[id]);
  if (!Number.isFinite(watts)) return 0;
  const deltaHours = Math.max(0, Math.min(1, (new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000));
  return deltaHours * (Math.max(0, watts) / 1000);
}

function summarizeCircuits(samples, config = DEFAULT_CONFIG) {
  const ids = new Set();
  for (const sample of samples) {
    for (const key of Object.keys(sample.circuitPowerW ?? {})) ids.add(key);
    for (const key of Object.keys(sample.circuitCumulativeKwh ?? {})) ids.add(key);
    for (const key of Object.keys(sample.circuitEnergyKwh ?? {})) ids.add(key);
  }
  return [...ids]
    .map((id) => {
      const channel = Number(id);
      const totalKwh = samples.reduce(
        (sum, sample, index) => sum + circuitKwhForSample(sample, id, samples[index - 1]),
        0,
      );
      const latestWatts = [...samples]
        .reverse()
        .map((sample) => sample.circuitPowerW?.[id])
        .find((value) => value !== null && value !== undefined);
      return {
        channel,
        id,
        label: circuitLabelFor(id, config.circuitLabels),
        totalKwh,
        latestWatts: Number.isFinite(Number(latestWatts)) ? Number(latestWatts) : null,
      };
    })
    .filter((item) => Number.isInteger(item.channel))
    .sort((a, b) => a.channel - b.channel);
}

function jsonSnippet(text, maxLength = 4000) {
  if (text === "") return "(empty)";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated ${text.length - maxLength} chars>`;
}

function jsonErrorPosition(message) {
  const match = String(message ?? "").match(/position (\d+)/);
  return match ? Number(match[1]) : null;
}

function lineColumnForPosition(text, position) {
  if (!Number.isInteger(position) || position < 0) return null;
  const prefix = text.slice(0, position);
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1, position };
}

function jsonSnippetNear(text, position, radius = 280) {
  if (!Number.isInteger(position) || position < 0) return jsonSnippet(text, radius * 2);
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  const prefix = start > 0 ? `...<${start} chars before>\n` : "";
  const suffix = end < text.length ? `\n...<${text.length - end} chars after>` : "";
  const pointer = `${" ".repeat(Math.max(0, position - start))}^`;
  return `${prefix}${text.slice(start, end)}\n${pointer}${suffix}`;
}

function parseJsonWithContext(text, source) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const position = jsonErrorPosition(cause.message);
    const location = lineColumnForPosition(text, position);
    const locationText = location
      ? ` at line ${location.line}, column ${location.column}, position ${location.position}`
      : "";
    const err = new Error(`Failed to parse JSON from ${source}${locationText}: ${cause.message}`);
    err.cause = cause;
    err.jsonSource = source;
    err.jsonText = text;
    err.jsonPosition = position;
    err.jsonLocation = location;
    err.jsonSnippet = jsonSnippetNear(text, position);
    throw err;
  }
}

function splitTopLevelJsonDocuments(text) {
  const docs = [];
  let start = null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (start === null) {
      if (/\s/.test(ch)) continue;
      if (ch !== "[" && ch !== "{") return [];
      start = i;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) return [];
      if (depth === 0) {
        docs.push({ start, end: i + 1, text: text.slice(start, i + 1) });
        start = null;
      }
    }
  }
  return start === null && !inString && depth === 0 ? docs : [];
}

function recoverConcatenatedJsonValue(text, isValidValue) {
  const docs = splitTopLevelJsonDocuments(text);
  if (docs.length <= 1) return null;
  const values = [];
  for (const doc of docs) {
    try {
      const value = JSON.parse(doc.text);
      if (isValidValue(value)) values.push({ ...doc, value });
    } catch {
      return null;
    }
  }
  if (values.length !== docs.length) return null;
  return { ...values.at(-1), documentCount: docs.length };
}

function logDetailedError(label, err) {
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

async function readHistorySamplesInRange(startMs, endMs) {
  if (historyStore.isReady()) return historyStore.querySamples(startMs, endMs);
  try {
    await stat(HISTORY_FILE);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const samples = [];
  const stream = createReadStream(HISTORY_FILE, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let sample = null;
      try {
        sample = parseJsonWithContext(line, `${HISTORY_FILE}:line ${lineNumber}`);
      } catch (err) {
        logDetailedError("history", err);
        continue;
      }
      const time = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(time)) continue;
      if (time > endMs) {
        lines.close();
        stream.destroy();
        break;
      }
      if (time >= startMs) samples.push(sample);
    }
  } finally {
    lines.close();
    if (!stream.destroyed) stream.destroy();
  }
  return samples;
}

async function readRecentHistorySamples(startMs, endMs, file = HISTORY_FILE, project = (sample) => sample) {
  if (file === HISTORY_FILE && historyStore.isReady()) {
    return historyStore.querySamples(startMs, endMs).map(project).filter(Boolean);
  }
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const samples = [];
  const chunkSize = 512 * 1024;
  let carry = Buffer.alloc(0);
  let reachedStart = false;
  try {
    let position = (await handle.stat()).size;
    const parseLine = (line) => {
      if (!line.trim()) return;
      let sample;
      try {
        sample = parseJsonWithContext(line, `${file}:recent-tail`);
      } catch (err) {
        logDetailedError("history", err);
        return;
      }
      const time = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(time) || time > endMs) return;
      if (time < startMs) {
        reachedStart = true;
        return;
      }
      const projected = project(sample);
      if (projected) samples.push(projected);
    };
    while (position > 0 && !reachedStart) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      const chunk = buffer.subarray(0, bytesRead);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      const firstNewline = data.indexOf(0x0a);
      if (firstNewline < 0) {
        carry = data;
        continue;
      }
      carry = data.subarray(0, firstNewline);
      const lines = data.subarray(firstNewline + 1).toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0 && !reachedStart; index -= 1) {
        parseLine(lines[index]);
      }
    }
    if (!reachedStart && carry.length) parseLine(carry.toString("utf8"));
  } finally {
    await handle.close();
  }
  return samples.reverse();
}

function adaptiveChargingHistorySample(sample) {
  const compact = { timestamp: sample.timestamp };
  let hasAdaptiveChargingMetric = false;
  for (const key of ["stateOfChargePercent", "batteryPowerW", "solarPowerW", "houseDemandW"]) {
    if (sample[key] === undefined) continue;
    compact[key] = sample[key];
    if (sample[key] !== null) hasAdaptiveChargingMetric = true;
  }
  return hasAdaptiveChargingMetric ? compact : null;
}

async function readAdaptiveChargingHistory(now = new Date()) {
  const endMs = now.getTime();
  const startMs = endMs - 90 * 86_400_000;
  if (adaptiveChargingHistoryCache
    && endMs >= adaptiveChargingHistoryCache.loadedAt
    && endMs - adaptiveChargingHistoryCache.loadedAt < ADAPTIVE_CHARGING_HISTORY_CACHE_MS
    && adaptiveChargingHistoryCache.startMs <= startMs) {
    return adaptiveChargingHistoryCache.samples.filter((sample) => {
      const time = new Date(sample.timestamp).getTime();
      return time >= startMs && time <= endMs;
    });
  }
  const samples = await readRecentHistorySamples(startMs, endMs, HISTORY_FILE, adaptiveChargingHistorySample);
  adaptiveChargingHistoryCache = { loadedAt: endMs, startMs, samples };
  return [...samples];
}

function emptyAdaptiveChargingDemandProfileIndex() {
  return {
    version: ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_VERSION,
    source: null,
    days: {},
  };
}

function cleanAdaptiveChargingDemandProfileIndex(value) {
  if (value?.version !== ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_VERSION || !value.days || typeof value.days !== "object") {
    return emptyAdaptiveChargingDemandProfileIndex();
  }
  const days = {};
  for (const [key, day] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !day || typeof day !== "object") continue;
    const sums = Array.from({ length: 48 }, (_, bucket) => {
      const sum = Number(day.sums?.[bucket]);
      return Number.isFinite(sum) ? sum : 0;
    });
    const counts = Array.from({ length: 48 }, (_, bucket) => {
      const count = Number(day.counts?.[bucket]);
      return Number.isFinite(count) && count > 0 ? count : 0;
    });
    days[key] = { sums, counts };
  }
  return {
    version: ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_VERSION,
    source: value.source && Number.isFinite(Number(value.source.size))
      ? { size: Number(value.source.size), ino: Number(value.source.ino) }
      : null,
    days,
  };
}

function addSampleToAdaptiveChargingDemandProfileIndex(index, sample) {
  const demand = Number(sample?.houseDemandW);
  const time = new Date(sample?.timestamp);
  if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) return;
  const key = localDayKey(time);
  const bucket = halfHourIndex(time);
  const day = index.days[key] ?? {
    sums: Array(48).fill(0),
    counts: Array(48).fill(0),
  };
  day.sums[bucket] = Number(day.sums[bucket] ?? 0) + demand;
  day.counts[bucket] = Number(day.counts[bucket] ?? 0) + 1;
  index.days[key] = day;
}

async function scanAdaptiveChargingDemandProfiles(index, start, end) {
  if (end <= start) return;
  const stream = createReadStream(HISTORY_FILE, { encoding: "utf8", start, end: end - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        addSampleToAdaptiveChargingDemandProfileIndex(
          index,
          parseJsonWithContext(line, `${HISTORY_FILE}:demand-index:${lineNumber}`),
        );
      } catch (err) {
        logDetailedError("solar demand profile index", err);
      }
    }
  } finally {
    lines.close();
    if (!stream.destroyed) stream.destroy();
  }
}

function adaptiveChargingDemandProfileDays(index) {
  return Object.entries(index.days).map(([key, day]) => {
    const values = new Map();
    for (let bucket = 0; bucket < 48; bucket += 1) {
      const count = Number(day.counts?.[bucket] ?? 0);
      const sum = Number(day.sums?.[bucket] ?? 0);
      if (count > 0 && Number.isFinite(sum)) values.set(bucket, sum / count);
    }
    return {
      key,
      date: new Date(`${key}T00:00:00`),
      coverage: values.size / 48,
      daytimeCoverage: [...values.keys()].filter((bucket) => bucket >= 12 && bucket < 36).length / 24,
      values,
    };
  }).filter((day) => !Number.isNaN(day.date.getTime()));
}

async function refreshAdaptiveChargingDemandProfileIndex() {
  await ensureDataDir();
  if (historyStore.isReady()) {
    const endMs = Date.now();
    const startMs = endMs - ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS * 366 * 86_400_000;
    const index = emptyAdaptiveChargingDemandProfileIndex();
    for (const sample of historyStore.querySamples(startMs, endMs, { resolution: "interval" })) {
      addSampleToAdaptiveChargingDemandProfileIndex(index, sample);
    }
    adaptiveChargingDemandProfileIndexCache = index;
    return adaptiveChargingDemandProfileDays(index);
  }
  let historyStat;
  try {
    historyStat = await stat(HISTORY_FILE);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let index = adaptiveChargingDemandProfileIndexCache;
  if (!index) {
    try {
      const value = parseJsonWithContext(
        await readFile(ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_FILE, "utf8"),
        ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_FILE,
      );
      index = cleanAdaptiveChargingDemandProfileIndex(value);
    } catch (err) {
      if (err.code !== "ENOENT") logDetailedError("solar demand profile index", err);
      index = emptyAdaptiveChargingDemandProfileIndex();
    }
  }
  const sameHistoryFile = index.source
    && Number(index.source.ino) === Number(historyStat.ino)
    && index.source.size <= historyStat.size;
  if (!sameHistoryFile) index = emptyAdaptiveChargingDemandProfileIndex();
  const start = index.source?.size ?? 0;
  if (start < historyStat.size) {
    await scanAdaptiveChargingDemandProfiles(index, start, historyStat.size);
    index.source = { size: historyStat.size, ino: Number(historyStat.ino) };
    await writeJsonFileAtomic(ADAPTIVE_CHARGING_DEMAND_PROFILE_INDEX_FILE, index);
  }
  adaptiveChargingDemandProfileIndexCache = index;
  return adaptiveChargingDemandProfileDays(index);
}

async function readAdaptiveChargingDemandProfileDays() {
  if (!adaptiveChargingDemandProfileIndexPromise) {
    adaptiveChargingDemandProfileIndexPromise = refreshAdaptiveChargingDemandProfileIndex()
      .finally(() => { adaptiveChargingDemandProfileIndexPromise = null; });
  }
  return adaptiveChargingDemandProfileIndexPromise;
}

async function writeJsonFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function migrateLegacyAdaptiveChargingData(dataDir = DATA_DIR, logger = console) {
  await mkdir(dataDir, { recursive: true });
  const configFile = path.join(dataDir, "config.json");
  if (await pathExists(configFile)) {
    const parsed = parseJsonWithContext(await readFile(configFile, "utf8"), configFile);
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(parsed, "solarPlanner")) {
      const canonicalValid = parsed.adaptiveCharging
        && typeof parsed.adaptiveCharging === "object"
        && !Array.isArray(parsed.adaptiveCharging);
      const legacyValid = parsed.solarPlanner
        && typeof parsed.solarPlanner === "object"
        && !Array.isArray(parsed.solarPlanner);
      if (!canonicalValid && legacyValid) {
        parsed.adaptiveCharging = parsed.solarPlanner;
      } else {
        logger.warn?.("Adaptive Charging migration: canonical configuration already exists; discarding obsolete solar planner configuration");
      }
      delete parsed.solarPlanner;
      changed = true;
    }
    if (parsed.retention && Object.prototype.hasOwnProperty.call(parsed.retention, "plannerHistoryDays")) {
      if (!Object.prototype.hasOwnProperty.call(parsed.retention, "adaptiveChargingHistoryDays")) {
        parsed.retention.adaptiveChargingHistoryDays = parsed.retention.plannerHistoryDays;
      }
      delete parsed.retention.plannerHistoryDays;
      changed = true;
    }
    const triggerRenames = {
      plannerUnavailable: "adaptiveChargingUnavailable",
      plannerRecovered: "adaptiveChargingRecovered",
      plannerWindowShortfall: "adaptiveChargingWindowShortfall",
    };
    for (const [legacyId, canonicalId] of Object.entries(triggerRenames)) {
      const triggers = parsed.notifications?.triggers;
      if (!triggers || !Object.prototype.hasOwnProperty.call(triggers, legacyId)) continue;
      if (!Object.prototype.hasOwnProperty.call(triggers, canonicalId)) {
        triggers[canonicalId] = triggers[legacyId];
      }
      delete triggers[legacyId];
      changed = true;
    }
    if (changed) {
      await writeJsonFileAtomic(configFile, parsed);
      logger.info?.("Adaptive Charging migration: updated configuration");
    }
  }

  const legacyStateFile = path.join(dataDir, "solar-planner-state.json");
  const stateFile = path.join(dataDir, "adaptive-charging-state.json");
  if (await pathExists(legacyStateFile)) {
    const readMigratingState = async (file) => {
      const text = await readFile(file, "utf8");
      let parsed;
      try {
        parsed = parseJsonWithContext(text, file);
      } catch (err) {
        const recovered = recoverConcatenatedJsonValue(
          text,
          (value) => value && typeof value === "object" && !Array.isArray(value),
        );
        if (!recovered) throw err;
        parsed = recovered.value;
      }
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    };
    let canonicalState = null;
    if (await pathExists(stateFile)) {
      try {
        canonicalState = await readMigratingState(stateFile);
      } catch (err) {
        logger.warn?.(`Adaptive Charging migration: canonical state is invalid and will be replaced: ${err.message}`);
      }
    }
    if (!canonicalState) {
      const legacyState = await readMigratingState(legacyStateFile);
      if (legacyState.owner === "planner") legacyState.owner = "adaptiveCharging";
      await writeJsonFileAtomic(stateFile, legacyState);
    } else {
      logger.warn?.("Adaptive Charging migration: canonical state already exists; discarding obsolete solar planner state");
    }
    await rm(legacyStateFile, { force: true });
    logger.info?.("Adaptive Charging migration: updated state file");
  }

  const legacyDir = path.join(dataDir, "solar-planner");
  const canonicalDir = path.join(dataDir, "adaptive-charging");
  if (await pathExists(legacyDir)) {
    await mkdir(canonicalDir, { recursive: true });
    for (const entry of await readdir(legacyDir, { withFileTypes: true })) {
      const source = path.join(legacyDir, entry.name);
      const target = path.join(canonicalDir, entry.name);
      if (!(await pathExists(target))) {
        await rename(source, target);
      } else {
        logger.warn?.(`Adaptive Charging migration: keeping canonical ${entry.name} and discarding obsolete copy`);
        await rm(source, { recursive: entry.isDirectory(), force: true });
      }
    }
    await rm(legacyDir, { recursive: true, force: true });
    logger.info?.("Adaptive Charging migration: updated data directory");
  }
}

async function writeJsonLinesAtomic(file, rows) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(tmp, body + (rows.length ? "\n" : ""));
  await rename(tmp, file);
}

function cleanAdaptiveChargingState(value = {}) {
  const plan = value.plan?.available === false
    && value.plan.reason === "discounted windows cannot safely reach their planned SOC targets"
    && Number(value.plan.plannedChargeKwh) > 0
    ? { ...value.plan, ...discountedPlanStatus(value.plan) }
    : value.plan ?? null;
  return {
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
      capacityKwh: finiteNumberOrNull(value.activeChargeSession.capacityKwh),
      slotStart: value.activeChargeSession.slotStart ?? null,
      slotEnd: value.activeChargeSession.slotEnd ?? null,
      label: value.activeChargeSession.label ?? null,
    } : null,
    chargingPerformance: cleanAdaptiveChargingPerformance(value.chargingPerformance),
    lastRebasedWindowKey: value.lastRebasedWindowKey ?? null,
    lastPlanEventKey: value.lastPlanEventKey ?? null,
    pendingPlanReason: value.pendingPlanReason ?? null,
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
        interruptionCount: Math.max(0, Math.round(Number(value.activeWindowExecution.interruptionCount) || 0)),
        startSocPercent: finiteNumberOrNull(value.activeWindowExecution.startSocPercent),
        latestSocPercent: finiteNumberOrNull(value.activeWindowExecution.latestSocPercent),
        startedTrackingAt: value.activeWindowExecution.startedTrackingAt ?? null,
        updatedAt: value.activeWindowExecution.updatedAt ?? null,
      }
      : null,
    windowSummaries: (Array.isArray(value.windowSummaries) ? value.windowSummaries : [])
      .filter((summary) => summary?.key && summary.windowStart && summary.windowEnd)
      .map((summary) => ({
        key: summary.key,
        windowStart: summary.windowStart,
        windowEnd: summary.windowEnd,
        label: summary.label ?? null,
        yenPerKwh: finiteNumberOrNull(summary.yenPerKwh),
        plannedWh: Math.max(0, Math.round(Number(summary.plannedWh) || 0)),
        deliveredWh: Math.max(0, Math.round(Number(summary.deliveredWh) || 0)),
        unmetWh: Math.max(0, Math.round(Number(summary.unmetWh) || 0)),
        interruptionCount: Math.max(0, Math.round(Number(summary.interruptionCount) || 0)),
        startSocPercent: finiteNumberOrNull(summary.startSocPercent),
        endSocPercent: finiteNumberOrNull(summary.endSocPercent),
        completedAt: summary.completedAt ?? null,
        reason: summary.reason ?? null,
      }))
      .slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT),
    pausedUntil: value.pausedUntil ?? null,
    solarHeadroomHoldUntil: value.solarHeadroomHoldUntil ?? null,
    lastResult: value.lastResult ?? null,
    lastForecastError: value.lastForecastError ?? null,
    historicalWeatherFetchedAt: value.historicalWeatherFetchedAt ?? null,
    lastAwayStateKey: value.lastAwayStateKey ?? null,
    log: Array.isArray(value.log) ? value.log.slice(-200) : [],
    updatedAt: value.updatedAt ?? new Date().toISOString(),
  };
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanAdaptiveChargingPerformance(value = {}) {
  const samples = (Array.isArray(value.samples) ? value.samples : [])
    .map((sample) => ({
      at: sample.at ?? null,
      batteryChargingW: Number(sample.batteryChargingW),
      houseDemandW: sample.houseDemandW === null || sample.houseDemandW === undefined
        ? null
        : Number(sample.houseDemandW),
      gridImportW: sample.gridImportW === null || sample.gridImportW === undefined
        ? null
        : Number(sample.gridImportW),
    }))
    .filter((sample) => sample.at
      && Number.isFinite(sample.batteryChargingW)
      && sample.batteryChargingW > 0)
    .slice(-ADAPTIVE_CHARGE_SAMPLE_LIMIT);
  const sessions = (Array.isArray(value.sessions) ? value.sessions : [])
    .map((session) => ({
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      reason: session.reason ?? null,
      requestedWh: Math.max(0, Math.round(Number(session.requestedWh) || 0)),
      deliveredWh: Math.max(0, Math.round(Number(session.deliveredWh) || 0)),
      startSocPercent: finiteNumberOrNull(session.startSocPercent),
      endSocPercent: finiteNumberOrNull(session.endSocPercent),
      socDeltaPercent: finiteNumberOrNull(session.socDeltaPercent),
      averageChargeWatts: finiteNumberOrNull(session.averageChargeWatts),
      estimatedStorageEfficiencyPercent: finiteNumberOrNull(session.estimatedStorageEfficiencyPercent),
    }))
    .filter((session) => session.startedAt && session.endedAt)
    .slice(-ADAPTIVE_CHARGE_SESSION_LIMIT);
  const chargingPowers = samples.map((sample) => sample.batteryChargingW).sort((a, b) => a - b);
  const upperQuartile = chargingPowers.slice(Math.floor(chargingPowers.length * 0.75));
  const learnedChargeWatts = chargingPowers.length >= 10 ? median(upperQuartile) : null;
  const efficiencies = sessions
    .map((session) => session.estimatedStorageEfficiencyPercent)
    .filter((value) => Number.isFinite(value) && value >= 50 && value <= 120);
  const demandPairs = samples.filter((sample) => Number.isFinite(sample.houseDemandW));
  let demandImpactWattsPerKw = null;
  if (demandPairs.length >= 10) {
    const meanDemand = demandPairs.reduce((sum, sample) => sum + sample.houseDemandW, 0) / demandPairs.length;
    const meanCharge = demandPairs.reduce((sum, sample) => sum + sample.batteryChargingW, 0) / demandPairs.length;
    const variance = demandPairs.reduce((sum, sample) => sum + (sample.houseDemandW - meanDemand) ** 2, 0);
    if (variance > 0) {
      const covariance = demandPairs.reduce(
        (sum, sample) => sum + (sample.houseDemandW - meanDemand) * (sample.batteryChargingW - meanCharge),
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
    medianStorageEfficiencyPercent: efficiencies.length ? median(efficiencies) : null,
    storageEfficiencySampleCount: efficiencies.length,
    demandImpactWattsPerKw,
  };
}

function effectiveAdaptiveChargeWatts(config, state = {}) {
  const configuredWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const learnedWatts = Number(state.chargingPerformance?.learnedChargeWatts);
  const learned = Number(state.chargingPerformance?.sampleCount) >= 10
    && Number.isFinite(learnedWatts)
    && learnedWatts > 0;
  return {
    configuredWatts,
    learnedWatts: learned ? learnedWatts : null,
    effectiveWatts: learned
      ? Math.min(configuredWatts, Math.max(configuredWatts * 0.5, learnedWatts))
      : configuredWatts,
    learned,
  };
}

function effectiveAdaptiveChargeStorageEfficiency(state = {}) {
  const performance = cleanAdaptiveChargingPerformance(state.chargingPerformance);
  const measuredPercent = finiteNumberOrNull(performance.medianStorageEfficiencyPercent);
  const sampleCount = Number(performance.storageEfficiencySampleCount) || 0;
  const learned = sampleCount >= ADAPTIVE_CHARGE_EFFICIENCY_MIN_SESSIONS
    && Number.isFinite(measuredPercent);
  const effectivePercent = learned
    ? Math.min(
      ADAPTIVE_CHARGE_EFFICIENCY_MAX_PERCENT,
      Math.max(ADAPTIVE_CHARGE_EFFICIENCY_MIN_PERCENT, measuredPercent),
    )
    : 100;
  return {
    measuredPercent,
    sampleCount,
    effectivePercent,
    fraction: effectivePercent / 100,
    learned,
  };
}

async function readAdaptiveChargingState() {
  await ensureDataDir();
  try {
    const text = await readFile(ADAPTIVE_CHARGING_STATE_FILE, "utf8");
    let parsed;
    let recovered = null;
    try {
      parsed = parseJsonWithContext(text, ADAPTIVE_CHARGING_STATE_FILE);
    } catch (err) {
      recovered = recoverConcatenatedJsonValue(text, (value) => value && typeof value === "object" && !Array.isArray(value));
      if (!recovered) throw err;
      logDetailedError("adaptive-charging-state", err);
      parsed = recovered.value;
    }
    const cleaned = cleanAdaptiveChargingState(parsed);
    if (recovered) await writeJsonFileAtomic(ADAPTIVE_CHARGING_STATE_FILE, cleaned);
    return cleaned;
  } catch (err) {
    if (err.code === "ENOENT") return cleanAdaptiveChargingState();
    throw err;
  }
}

async function writeAdaptiveChargingState(state) {
  const cleaned = cleanAdaptiveChargingState({ ...state, updatedAt: new Date().toISOString() });
  await ensureDataDir();
  await writeJsonFileAtomic(ADAPTIVE_CHARGING_STATE_FILE, cleaned);
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

function appendAdaptiveChargingLog(state, message, kind = "info", at = new Date()) {
  state.log = [
    ...(Array.isArray(state.log) ? state.log : []),
    { at: at.toISOString(), kind, message },
  ].slice(-200);
}

async function fetchJson(url, fetchImpl = fetch) {
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

function openMeteoUrl(config, historical = false, now = new Date()) {
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

function adaptiveChargingTimezoneError(forecast) {
  const configuredTimezone = process.env.TZ;
  if (!configuredTimezone) return "container TZ must be configured before rate-band times can be aligned";
  if (!forecast?.timezone) return "forecast timezone is unavailable";
  return configuredTimezone === forecast.timezone
    ? null
    : `container timezone ${configuredTimezone} does not match forecast timezone ${forecast.timezone}`;
}

async function refreshAdaptiveChargingForecast(config, { fetchImpl = fetch, now = new Date(), forceHistorical = false } = {}) {
  let state = await readAdaptiveChargingState();
  try {
    const forecast = parseOpenMeteoForecast(await fetchJson(openMeteoUrl(config, false, now), fetchImpl), now);
    const timezoneError = adaptiveChargingTimezoneError(forecast);
    if (timezoneError) throw new Error(timezoneError);
    state.forecast = forecast;
    state.lastForecastError = null;
    appendAdaptiveChargingLog(state, `Open-Meteo forecast refreshed for ${forecast.timezone || "local time"}`, "forecast", now);
    historyStore.recordForecast(forecast);
  } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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

function adaptiveChargingSolarForecastAccuracy(now = new Date()) {
  const fallback = { learned: false, sampleCount: 0, factor: 1, outcomes: [] };
  if (!historyStore.isReady()) return fallback;
  try {
    historyStore.settleSolarForecastOutcomes(now);
    return historyStore.solarForecastAccuracy();
  } catch (err) {
    logDetailedError("solar-forecast-accuracy", err);
    return { ...fallback, error: err.message };
  }
}

function adaptiveChargingView(config, state, rules = [], now = new Date()) {
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
      ageMs: Number.isFinite(forecastAgeMs) ? Math.max(0, forecastAgeMs) : null,
      timezone: state.forecast.timezone,
      stale: !forecastIsFresh(state.forecast, now),
    } : null,
    solarForecastAccuracy,
    plan: state.plan,
    owner: state.owner,
    activeSlot: state.activeSlot,
    interruptedCharge: state.interruptedCharge,
    breakerRecovery: state.breakerRecovery,
    standbyHoldUntil: state.standbyHoldUntil,
    activeWindowExecution: state.activeWindowExecution,
    windowSummaries: state.windowSummaries ?? [],
    chargingPerformance: state.chargingPerformance,
    learnedCapacityKwh: state.plan?.batteryCapacity?.learnedCapacityKwh ?? null,
    lastResult: state.lastResult,
    lastForecastError: state.lastForecastError,
    log: state.log ?? [],
  };
}

function rateForTimestamp(rateBands = DEFAULT_CONFIG.rateBands, timestamp = new Date(), fallbackRate = null) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const minute = date.getHours() * 60 + date.getMinutes();
  const bands = normalizeRateBands({ rateBands });
  const match = bands.find((band) => {
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

function maxDailyRate(rateBands = DEFAULT_CONFIG.rateBands, fallbackRate = null) {
  const rates = normalizeRateBands({ rateBands }).map((band) => band.yenPerKwh);
  if (fallbackRate !== null && fallbackRate !== undefined) {
    rates.push(configNumber(fallbackRate, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000));
  }
  return Math.max(...rates);
}

function median(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedMedian(values = []) {
  const sorted = values
    .filter((item) => Number.isFinite(Number(item.value)) && Number(item.weight) > 0)
    .map((item) => ({ value: Number(item.value), weight: Number(item.weight) }))
    .sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? null;
}

function matchesDailyBand(date, band) {
  const start = minutesOfDay(band.start);
  const end = minutesOfDay(band.end);
  if (start === null || end === null) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function explicitDiscountedBand(config, date) {
  return (config.rateBands ?? [])
    .filter((band) => Number(band.yenPerKwh) < Number(config.standardRateYenPerKwh))
    .find((band) => matchesDailyBand(date, band)) ?? null;
}

function discountedBandOccurrenceForDay(band, day = new Date()) {
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

function discountedBandOccurrences(config, now = new Date(), horizonMs = 48 * 60 * 60_000) {
  const discountedBands = (config.rateBands ?? [])
    .filter((band) => Number(band.yenPerKwh) < Number(config.standardRateYenPerKwh));
  const horizonEnd = now.getTime() + horizonMs;
  const occurrences = [];
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
  return occurrences.sort((a, b) => new Date(a.start) - new Date(b.start));
}

function discountedBandOccurrence(config, now = new Date()) {
  const time = now.getTime();
  return discountedBandOccurrences(config, now)
    .find((occurrence) => new Date(occurrence.start).getTime() <= time
      && time < new Date(occurrence.end).getTime()) ?? null;
}

function solarPowerFromIrradiance(irradianceWm2, config, learnedFactor = null) {
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

function applySolarForecastBias(solarW, peakW, accuracy = {}) {
  const value = Math.max(0, Number(solarW) || 0);
  const maximum = Math.max(0, Number(peakW) || 0);
  const factor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  return Math.min(maximum, value * factor);
}

function adaptiveChargingBaseAvailability(config) {
  if (config.solarEnabled === false) return { available: false, reason: "solar generation is disabled" };
  if (!config.adaptiveCharging?.enabled) return { available: false, reason: "adaptive charging is disabled" };
  if (config.rateMode === "simple") return { available: false, reason: "Off-Peak or Multi-Rate pricing is required" };
  const coordinates = [
    [config.adaptiveCharging.latitude, "latitude"],
    [config.adaptiveCharging.longitude, "longitude"],
  ];
  const positive = [
    [config.adaptiveCharging.arrayPeakKw, "array peak capacity"],
    [config.batteryCapabilities?.usableCapacityKwh, "usable battery capacity"],
    [config.batteryCapabilities?.maximumChargeWatts, "maximum battery charge watts"],
  ];
  const missing = [
    ...coordinates.filter(([value]) => !Number.isFinite(Number(value))),
    ...positive.filter(([value]) => !Number.isFinite(Number(value)) || Number(value) <= 0),
  ].map(([, label]) => label);
  if (missing.length) return { available: false, reason: `missing ${missing.join(", ")}` };
  if (config.smartCosmoEnabled === false) return { available: false, reason: "overall house demand is unavailable" };
  return { available: true, reason: null };
}

function adaptiveChargingAvailability(config, rules = []) {
  const base = adaptiveChargingBaseAvailability(config);
  if (!base.available) return base;
  return adaptiveChargingBreakerSettings(rules).valid
    ? base
    : { available: false, reason: "Charging Demand Guard settings are unavailable" };
}

function forecastIsFresh(forecast, now = new Date()) {
  const fetchedAt = new Date(forecast?.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= SOLAR_FORECAST_MAX_AGE_MS;
}

function estimateEffectiveBatteryCapacity(samples, configuredCapacityKwh) {
  const estimates = [];
  let anchor = null;
  let direction = 0;
  let energyKwh = 0;
  let previous = null;
  for (const sample of samples) {
    const soc = Number(sample.stateOfChargePercent);
    const time = new Date(sample.timestamp).getTime();
    if (!Number.isFinite(soc) || !Number.isFinite(time)) continue;
    if (!anchor) anchor = { soc, time };
    if (previous) {
      const dtHours = Math.max(0, Math.min(0.25, (time - previous.time) / 3_600_000));
      const watts = sample.batteryPowerW === null || sample.batteryPowerW === undefined
        ? Number.NaN
        : Number(sample.batteryPowerW);
      const socDirection = Math.sign(soc - previous.soc);
      const powerDirection = Number.isFinite(watts) ? Math.sign(watts) : 0;
      const observedDirection = powerDirection || socDirection;
      if (observedDirection && direction && observedDirection !== direction) {
        anchor = { soc: previous.soc, time: previous.time };
        direction = observedDirection;
        energyKwh = 0;
      } else if (!direction && observedDirection) {
        direction = observedDirection;
      }
      if (Number.isFinite(watts) && direction && powerDirection === direction) {
        energyKwh += Math.abs(watts) * dtHours / 1000;
      }
    }
    const deltaSoc = direction ? (soc - anchor.soc) * direction : 0;
    if (deltaSoc >= 10 && energyKwh > 0) {
      estimates.push({
        capacityKwh: energyKwh / (deltaSoc / 100),
        direction,
      });
      anchor = { soc, time };
      direction = 0;
      energyKwh = 0;
    }
    previous = { soc, time };
  }
  const configured = Number(configuredCapacityKwh);
  const chargeSessionCount = estimates.filter((item) => item.direction > 0).length;
  const dischargeEstimates = estimates
    .filter((item) => item.direction < 0)
    .map((item) => item.capacityKwh)
    .filter((value) => Number.isFinite(value) && value > 0);
  const plausible = Number.isFinite(configured) && configured > 0
    ? dischargeEstimates.filter((value) => value >= configured * 0.7 && value <= configured * 1.3)
    : dischargeEstimates;
  const estimate = median(plausible);
  const details = {
    sessionCount: plausible.length,
    chargeSessionCount,
    dischargeSessionCount: dischargeEstimates.length,
    rejectedDischargeSessionCount: dischargeEstimates.length - plausible.length,
  };
  if (plausible.length < 5 || !Number.isFinite(estimate) || !Number.isFinite(configured)) {
    return { capacityKwh: configured || null, learnedCapacityKwh: null, ...details };
  }
  return {
    capacityKwh: estimate,
    learnedCapacityKwh: estimate,
    ...details,
  };
}

function optimizeDiscountedChargeSlots({
  config,
  start,
  end,
  requiredKwh,
  demandBySlot = new Map(),
  slotMinutes = 30,
} = {}) {
  const maximumChargeWatts = Number(config.batteryCapabilities?.maximumChargeWatts);
  const slots = [];
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
  slots.sort((a, b) => a.yenPerKwh - b.yenPerKwh || new Date(b.start) - new Date(a.start));
  let remaining = Math.max(0, Number(requiredKwh) || 0);
  const selected = [];
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
    slots: selected.sort((a, b) => new Date(a.start) - new Date(b.start)),
    plannedChargeKwh: Math.max(0, Number(requiredKwh) || 0) - remaining,
    unmetChargeKwh: Math.max(0, remaining),
  };
}

function discountedTimelineWindows(timeline = []) {
  const windows = [];
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

function cumulativeRangeNeeds(timeline, startIndex, endIndex) {
  let lowCumulative = 0;
  let highCumulative = 0;
  let maximumDeficitKwh = 0;
  let maximumSurplusKwh = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    lowCumulative += Number(timeline[index]?.netKwh ?? 0);
    highCumulative += Number(timeline[index]?.highSolarNetKwh ?? timeline[index]?.netKwh ?? 0);
    maximumDeficitKwh = Math.max(maximumDeficitKwh, -lowCumulative);
    maximumSurplusKwh = Math.max(maximumSurplusKwh, highCumulative);
  }
  return { maximumDeficitKwh, maximumSurplusKwh };
}

function applyPredictedBatteryFlow(storedKwh, netKwh, floorKwh, capacityKwh) {
  return Math.max(floorKwh, Math.min(capacityKwh, storedKwh + Number(netKwh || 0)));
}

function applyAdaptiveChargingTimelineSlot(
  storedKwh,
  slot,
  chargeKwh,
  floorKwh,
  capacityKwh,
  chargeStorageEfficiency = 1,
) {
  const allocatedChargeKwh = Math.max(0, Number(chargeKwh) || 0);
  const efficiency = Math.min(1, Math.max(0.5, Number(chargeStorageEfficiency) || 1));
  const slotChargeCapacityKwh = Math.max(0, Number(slot?.chargeCapacityKwh) || 0);
  const forcedChargeFraction = slotChargeCapacityKwh > 0
    ? Math.min(1, allocatedChargeKwh / slotChargeCapacityKwh)
    : 0;
  const autoNetKwh = Number(slot?.netKwh || 0) * (1 - forcedChargeFraction);
  const afterAuto = applyPredictedBatteryFlow(storedKwh, autoNetKwh, floorKwh, capacityKwh);
  return Math.min(capacityKwh, afterAuto + allocatedChargeKwh * efficiency);
}

function buildAdaptiveChargingTimelineView({
  timeline = [],
  slots = [],
  initialStoredKwh,
  floorKwh,
  capacityKwh,
  chargeStorageEfficiency = 1,
  config,
} = {}) {
  let storedKwh = Math.max(floorKwh, Math.min(capacityKwh, Number(initialStoredKwh)));
  const normalizedSlots = slots.map((slot) => ({
    ...slot,
    startMs: new Date(slot.start).getTime(),
    endMs: new Date(slot.end).getTime(),
    targetKwh: Math.max(0, Number(slot.targetWh) || 0) / 1000,
  })).filter((slot) => Number.isFinite(slot.startMs)
    && Number.isFinite(slot.endMs)
    && slot.endMs > slot.startMs);
  const view = [];

  for (const interval of timeline) {
    const intervalDurationMs = Math.max(0, interval.endMs - interval.startMs);
    if (!(intervalDurationMs > 0)) continue;
    const intervalSlots = normalizedSlots.filter(
      (slot) => slot.startMs < interval.endMs && slot.endMs > interval.startMs,
    );
    const boundaries = [...new Set([
      interval.startMs,
      interval.endMs,
      ...intervalSlots.flatMap((slot) => [
        Math.max(interval.startMs, slot.startMs),
        Math.min(interval.endMs, slot.endMs),
      ]),
    ])].sort((left, right) => left - right);

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const segmentStartMs = boundaries[index];
      const segmentEndMs = boundaries[index + 1];
      const segmentDurationMs = segmentEndMs - segmentStartMs;
      if (!(segmentDurationMs > 0)) continue;
      const intervalFraction = segmentDurationMs / intervalDurationMs;
      const plannedChargeKwh = intervalSlots.reduce((sum, slot) => {
        const overlapMs = Math.max(
          0,
          Math.min(segmentEndMs, slot.endMs) - Math.max(segmentStartMs, slot.startMs),
        );
        return sum + slot.targetKwh * overlapMs / (slot.endMs - slot.startMs);
      }, 0);
      const segment = {
        ...interval,
        startMs: segmentStartMs,
        endMs: segmentEndMs,
        solarKwh: Number(interval.solarKwh || 0) * intervalFraction,
        netKwh: Number(interval.netKwh || 0) * intervalFraction,
        chargeCapacityKwh: Number(interval.chargeCapacityKwh || 0) * intervalFraction,
      };
      const startingStoredKwh = storedKwh;
      storedKwh = applyAdaptiveChargingTimelineSlot(
        storedKwh,
        segment,
        plannedChargeKwh,
        floorKwh,
        capacityKwh,
        chargeStorageEfficiency,
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
        demandW: Number(interval.demandW) || 0,
        predictedStartSocPercent: capacityKwh > 0 ? startingStoredKwh / capacityKwh * 100 : null,
        predictedEndSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        predictedSocPercent: capacityKwh > 0 ? storedKwh / capacityKwh * 100 : null,
        discounted: Boolean(interval.band),
        rateLabel: rate?.label ?? null,
        yenPerKwh: finiteNumberOrNull(rate?.yenPerKwh),
        plannedChargeWh: Math.round(plannedChargeKwh * 1000),
        predictedStoredChargeWh: Math.round(plannedChargeKwh * chargeStorageEfficiency * 1000),
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
  chargeStorageEfficiency = 1,
} = {}) {
  const storageEfficiency = Math.min(1, Math.max(0.5, Number(chargeStorageEfficiency) || 1));
  const windows = discountedTimelineWindows(timeline);
  const maximumTargetKwh = capacityKwh * Number(maximumTargetPercent) / 100;
  const initialStoredKwh = Math.max(dischargeFloorKwh, Math.min(capacityKwh, Number(currentStoredKwh)));

  const buildPlan = (targetBoosts = []) => {
    let storedKwh = initialStoredKwh;
    let cursor = 0;
    const selectedSlots = [];
    const windowPlans = [];

    const simulate = (startIndex, endIndex, chargeByIndex = new Map()) => {
      for (let index = startIndex; index < endIndex; index += 1) {
        storedKwh = applyAdaptiveChargingTimelineSlot(
          storedKwh,
          timeline[index],
          chargeByIndex.get(index),
          dischargeFloorKwh,
          capacityKwh,
          storageEfficiency,
        );
      }
    };

    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const window = windows[windowIndex];
      simulate(cursor, window.startIndex);
      const storedAtStartKwh = storedKwh;
      const simulateWindow = (chargeByIndex = new Map()) => {
        let projectedStoredKwh = storedKwh;
        for (let index = window.startIndex; index < window.endIndex; index += 1) {
          projectedStoredKwh = applyAdaptiveChargingTimelineSlot(
            projectedStoredKwh,
            timeline[index],
            chargeByIndex.get(index),
            dischargeFloorKwh,
            capacityKwh,
            storageEfficiency,
          );
        }
        return projectedStoredKwh;
      };
      const noGridStoredKwh = simulateWindow();
      const nextWindow = windows[windowIndex + 1] ?? null;
      const boundaryIndex = nextWindow?.startIndex ?? timeline.length;
      const rangeNeeds = cumulativeRangeNeeds(timeline, window.endIndex, boundaryIndex);
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
      const chargeByIndex = new Map();
      let projectedEndKwh = noGridStoredKwh;
      for (let index = window.endIndex - 1; index >= window.startIndex && projectedEndKwh < targetStoredKwh - 0.0001; index -= 1) {
        const slot = timeline[index];
        const slotCapacityKwh = Math.max(0, Number(slot.chargeCapacityKwh ?? 0));
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
        const durationMs = allocatedKwh * 1000 / maximumChargeWatts * 3_600_000;
        selectedSlots.push({
          slotId: `${window.configuredStartMs}:${window.configuredEndMs}:${slot.endMs}`,
          start: new Date(slot.endMs - durationMs).toISOString(),
          end: new Date(slot.endMs).toISOString(),
          yenPerKwh: window.yenPerKwh,
          label: window.label,
          demandW: slot.demandW,
          targetWh: Math.max(1, Math.round(allocatedKwh * 1000)),
          targetSocPercent: capacityKwh ? targetStoredKwh / capacityKwh * 100 : maximumTargetPercent,
          windowStart: new Date(window.configuredStartMs).toISOString(),
          windowEnd: new Date(window.configuredEndMs).toISOString(),
        });
      }

      simulate(window.startIndex, window.endIndex, chargeByIndex);
      const predictedEndStoredKwh = storedKwh;
      const windowUnmetStoredKwh = Math.max(0, targetStoredKwh - predictedEndStoredKwh);
      const windowUnmetChargeKwh = windowUnmetStoredKwh / storageEfficiency;
      const plannedWindowChargeKwh = [...chargeByIndex.values()].reduce((sum, value) => sum + value, 0);
      const plannedWindowStoredChargeKwh = plannedWindowChargeKwh * storageEfficiency;
      const requestedKwh = plannedWindowChargeKwh + windowUnmetChargeKwh;
      const availableChargeKwh = window.slots.reduce(
        (sum, slot) => sum + Math.max(0, Number(slot.chargeCapacityKwh) || 0),
        0,
      );
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
      });
      cursor = window.endIndex;
    }
    simulate(cursor, timeline.length);
    const plannedChargeKwh = selectedSlots.reduce((sum, slot) => sum + slot.targetWh / 1000, 0);
    const unmetChargeKwh = windowPlans.reduce((sum, window) => sum + window.unmetChargeKwh, 0);
    const unmetStoredChargeKwh = windowPlans.reduce(
      (sum, window) => sum + window.unmetStoredChargeKwh,
      0,
    );
    return {
      slots: selectedSlots.sort((a, b) => new Date(a.start) - new Date(b.start)),
      windows: windowPlans,
      plannedChargeKwh,
      plannedStoredChargeKwh: plannedChargeKwh * storageEfficiency,
      requiredGridChargeKwh: plannedChargeKwh + unmetChargeKwh,
      unmetChargeKwh,
      unmetStoredChargeKwh,
      expectedEndStoredKwh: storedKwh,
    };
  };

  const targetBoosts = windows.map(() => 0);
  let plan = buildPlan(targetBoosts);
  const maxBackfillIterations = Math.max(1, windows.length * windows.length * 4);
  for (let iteration = 0; iteration < maxBackfillIterations; iteration += 1) {
    const constrainedIndex = plan.windows.findIndex(
      (window, index) => index > 0 && window.unmetStoredChargeKwh > 0.0001,
    );
    if (constrainedIndex < 0) break;
    const constrained = plan.windows[constrainedIndex];
    const candidates = plan.windows
      .map((window, index) => ({ window, index }))
      .filter(({ window, index }) => index < constrainedIndex
        && window.maximumTargetStoredKwh - window.targetStoredKwh > 0.0001)
      .sort((left, right) => left.window.yenPerKwh - right.window.yenPerKwh || right.index - left.index);
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

function discountedPlanStatus(plan = {}) {
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

function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function halfHourIndex(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
}

function awayPeriodContains(period, timeMs) {
  const startMs = new Date(period?.from).getTime();
  const untilMs = new Date(period?.until).getTime();
  return Number.isFinite(startMs) && Number.isFinite(untilMs) && timeMs >= startMs && timeMs < untilMs;
}

function awayPeriodForecastContains(period, timeMs) {
  const startMs = new Date(period?.from).getTime();
  const untilMs = new Date(period?.until).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs) return false;
  const returnBufferMs = Math.min(AWAY_RETURN_BUFFER_MS, (untilMs - startMs) / 4);
  return timeMs >= startMs && timeMs < untilMs - returnBufferMs;
}

function isAwayAt(timeMs, periods = [], { forecast = false } = {}) {
  const contains = forecast ? awayPeriodForecastContains : awayPeriodContains;
  return periods.some((period) => contains(period, timeMs));
}

function demandDayBucketMidpoint(day, bucket) {
  return new Date(
    day.date.getFullYear(),
    day.date.getMonth(),
    day.date.getDate(),
    Math.floor(bucket / 2),
    bucket % 2 ? 45 : 15,
  ).getTime();
}

function filterDemandDaysByOccupancy(days, awayPeriods = [], occupancy = "home") {
  if (occupancy === "all") return days;
  return days.map((day) => {
    const values = new Map([...day.values].filter(([bucket]) => {
      const away = isAwayAt(demandDayBucketMidpoint(day, bucket), awayPeriods);
      return occupancy === "away" ? away : !away;
    }));
    return {
      ...day,
      coverage: values.size / 48,
      daytimeCoverage: [...values.keys()].filter((bucket) => bucket >= 12 && bucket < 36).length / 24,
      values,
    };
  }).filter((day) => day.values.size > 0);
}

function aggregateDemandDays(samples, { awayPeriods = [], occupancy = "all" } = {}) {
  const days = new Map();
  for (const sample of samples) {
    const demand = Number(sample.houseDemandW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) continue;
    const away = isAwayAt(time.getTime(), awayPeriods);
    if ((occupancy === "away" && !away) || (occupancy === "home" && away)) continue;
    const key = localDayKey(time);
    if (!days.has(key)) days.set(key, { key, date: new Date(time.getFullYear(), time.getMonth(), time.getDate()), buckets: new Map() });
    const day = days.get(key);
    const index = halfHourIndex(time);
    const bucket = day.buckets.get(index) ?? { sum: 0, count: 0 };
    bucket.sum += demand;
    bucket.count += 1;
    day.buckets.set(index, bucket);
  }
  return [...days.values()].map((day) => ({
    ...day,
    coverage: day.buckets.size / 48,
    daytimeCoverage: [...day.buckets.keys()].filter((index) => index >= 12 && index < 36).length / 24,
    values: new Map([...day.buckets].map(([index, bucket]) => [index, bucket.sum / bucket.count])),
  }));
}

function percentile(values, fraction) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function calendarDayDistance(left, right) {
  const normalizedLeft = new Date(2000, left.getMonth(), left.getDate());
  const normalizedRight = new Date(2000, right.getMonth(), right.getDate());
  const distance = Math.abs(normalizedLeft.getTime() - normalizedRight.getTime()) / 86_400_000;
  return Math.min(distance, 366 - distance);
}

function selectSeasonalDemandDays(validDays, target, targetIsWeekend, targetTemperature, temperatureByDay) {
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
    const candidate = {
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
    .flatMap((days) => days.sort((a, b) => a.score - b.score).slice(0, ADAPTIVE_CHARGING_SEASONAL_DAYS_PER_YEAR))
    .sort((a, b) => a.score - b.score);
}

function predictHouseDemand(samples, targetDate = new Date(), temperatureByDay = new Map(), options = {}) {
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
  const recordedDayMap = new Map(historicalDays.map((day) => [day.key, day]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy })) recordedDayMap.set(day.key, day);
  const recordedDays = [...recordedDayMap.values()];
  const validDays = recordedDays.filter((day) => day.daytimeCoverage >= 0.8);
  const recentCandidates = validDays
    .map((day) => {
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
    .filter((day) => day.ageDays > 0 && day.ageDays <= 42)
    .sort((a, b) => a.score - b.score)
    .slice(0, 8);
  const seasonalCandidates = selectSeasonalDemandDays(
    validDays,
    target,
    targetIsWeekend,
    targetTemperature,
    temperatureByDay,
  );
  const seasonalYears = [...new Set(seasonalCandidates.map((day) => day.date.getFullYear()))]
    .sort((a, b) => b - a);
  // Let recurring seasonal behavior inform the forecast without allowing an
  // older household pattern to outweigh the most recent six weeks.
  const seasonalBlendWeight = Math.min(0.3, seasonalYears.length * 0.1);
  const profile = new Map();
  const lowProfile = new Map();
  for (let index = 0; index < 48; index += 1) {
    const recentValue = weightedMedian(recentCandidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index), weight: day.weight })));
    const seasonalValue = weightedMedian(seasonalCandidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index), weight: day.weight })));
    const value = Number.isFinite(recentValue) && Number.isFinite(seasonalValue)
      ? recentValue * (1 - seasonalBlendWeight) + seasonalValue * seasonalBlendWeight
      : recentValue;
    if (Number.isFinite(value)) profile.set(index, value);
    const lowValue = percentile(
      recordedDays.filter((day) => day.values.has(index)).map((day) => day.values.get(index)),
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
    comparableDays: [...recentCandidates, ...seasonalCandidates].map((day) => day.key),
    recentComparableDays: recentCandidates.map((day) => day.key),
    seasonalComparableDays: seasonalCandidates.map((day) => day.key),
    seasonalYears,
    seasonalBlendWeight,
    sameDayTypeDays: [...recentCandidates, ...seasonalCandidates]
      .filter((day) => day.sameDayType)
      .map((day) => day.key),
    usedDayTypeFallback: [...recentCandidates, ...seasonalCandidates].some((day) => !day.sameDayType),
    recordedDayCount: recordedDays.length,
    validDayCount: validDays.length,
    profile,
    lowProfile,
  };
}

function predictAwayDemand(samples, targetDate, temperatureByDay, options = {}) {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const awayPeriods = Array.isArray(options.awayPeriods) ? options.awayPeriods : [];
  const historicalDays = filterDemandDaysByOccupancy(
    Array.isArray(options.historicalDays) ? options.historicalDays : [],
    awayPeriods,
    "away",
  );
  const recordedDayMap = new Map(historicalDays.map((day) => [day.key, day]));
  for (const day of aggregateDemandDays(samples, { awayPeriods, occupancy: "away" })) {
    recordedDayMap.set(day.key, day);
  }
  const candidates = [...recordedDayMap.values()].map((day) => {
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
  }).filter((day) => day.ageDays > 0 && day.ageDays <= ADAPTIVE_CHARGING_SEASONAL_LOOKBACK_YEARS * 366)
    .sort((a, b) => a.score - b.score)
    .slice(0, 24);
  const normalPrediction = options.normalPrediction ?? { profile: new Map(), lowProfile: new Map() };
  const profile = new Map();
  const learnedBuckets = new Set();
  const fallbackBuckets = new Set();
  for (let index = 0; index < 48; index += 1) {
    const values = candidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index), weight: day.weight }));
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
      profile.set(index, Math.max(0, fallback));
      fallbackBuckets.add(index);
    }
  }
  return {
    profile,
    learnedBuckets,
    fallbackBuckets,
    comparableDays: candidates.map((day) => day.key),
    recordedDayCount: recordedDayMap.size,
  };
}

function parseOpenMeteoForecast(data, fetchedAt = new Date()) {
  const hourly = data?.hourly ?? {};
  const hours = (hourly.time ?? []).map((time, index) => ({
    time,
    timestamp: new Date(time).toISOString(),
    shortwaveRadiationWm2: Number(hourly.shortwave_radiation?.[index]) || 0,
    tiltedIrradianceWm2: Number(hourly.global_tilted_irradiance?.[index]) || 0,
    cloudCoverPercent: Number(hourly.cloud_cover?.[index]),
    temperatureC: Number(hourly.temperature_2m?.[index]),
  }));
  const daily = data?.daily ?? {};
  const days = (daily.time ?? []).map((date, index) => ({
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

function temperatureByDayFromWeather(hours = []) {
  const grouped = new Map();
  for (const hour of hours) {
    const value = Number(hour.temperatureC);
    if (!Number.isFinite(value)) continue;
    const key = String(hour.time ?? hour.timestamp).slice(0, 10);
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [key, values.reduce((sum, value) => sum + value, 0) / values.length]));
}

function solarCalibrationGroup(date) {
  const d = date instanceof Date ? date : new Date(date);
  const season = Math.floor(d.getMonth() / 3);
  const solarHour = d.getHours() < 10 ? "morning" : d.getHours() < 14 ? "midday" : "afternoon";
  return `${season}:${solarHour}`;
}

function learnedSolarFactor(samples, historicalWeather, config) {
  const weatherByHour = new Map((historicalWeather ?? []).map((hour) => [
    Math.floor(new Date(hour.timestamp ?? hour.time).getTime() / 3_600_000),
    hour,
  ]));
  const daily = new Map();
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
  const factors = [...daily.values()].map((day) => median(day.factors)).filter(Number.isFinite);
  const fallback = Number(config.adaptiveCharging.arrayPeakKw) * (1 - Number(config.adaptiveCharging.systemLossPercent) / 100);
  const learned = factors.length >= 7;
  const groupNames = new Set([...daily.values()].flatMap((day) => [...day.groups.keys()]));
  const groupFactors = {};
  for (const group of groupNames) {
    const values = [...daily.values()].map((day) => median(day.groups.get(group) ?? [])).filter(Number.isFinite);
    if (learned && values.length >= 4) groupFactors[group] = median(values.slice(-30));
  }
  return {
    factor: learned ? median(factors.slice(-30)) : fallback,
    groupFactors,
    validDays: factors.length,
    learned,
  };
}

function localDayRange(dayKey) {
  const start = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function dailySolarForecastIssues(forecast, config, calibration, accuracy = {}) {
  const issuedAt = forecast?.fetchedAt;
  if (!issuedAt || Number.isNaN(new Date(issuedAt).getTime())) return [];
  const biasFactor = accuracy.learned && Number.isFinite(Number(accuracy.factor))
    ? Number(accuracy.factor)
    : 1;
  const marginPercent = Math.max(0, Number(config.adaptiveCharging?.forecastMarginPercent) || 0);
  const marginFactor = Math.max(0, 1 - marginPercent / 100);
  const peakW = Math.max(0, Number(config.adaptiveCharging?.arrayPeakKw) || 0) * 1000;
  const targetDates = new Set([
    ...(forecast.days ?? []).map((day) => day.date),
    ...(forecast.hours ?? []).map((hour) => localDayKey(hour.timestamp ?? hour.time)),
  ].filter(Boolean));
  const issues = [];
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

function forecastHourForInterval(forecast, start, end) {
  const midpoint = (new Date(start).getTime() + new Date(end).getTime()) / 2;
  const target = Math.ceil(midpoint / 3_600_000) * 3_600_000;
  return (forecast?.hours ?? []).reduce((best, hour) => {
    const distance = Math.abs(new Date(hour.timestamp).getTime() - target);
    return !best || distance < best.distance ? { hour, distance } : best;
  }, null)?.hour ?? null;
}

function nextPlanningBoundary(time, end, intervalMinutes = 30) {
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

function nextForecastSunset(forecast, now = new Date()) {
  return (forecast?.days ?? [])
    .map((day) => ({ ...day, timestamp: new Date(day.sunset).getTime() }))
    .filter((day) => Number.isFinite(day.timestamp) && day.timestamp > now.getTime())
    .sort((a, b) => a.timestamp - b.timestamp)[0] ?? null;
}

function planningSunsetWithDiscountedWindow(config, forecast, now = new Date()) {
  const startMs = now.getTime();
  return (forecast?.days ?? [])
    .map((day) => ({ ...day, timestamp: new Date(day.sunset).getTime() }))
    .filter((day) => Number.isFinite(day.timestamp) && day.timestamp > startMs)
    .sort((a, b) => a.timestamp - b.timestamp)
    .find((day) => {
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
} = {}) {
  const unavailable = (reason) => ({
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
  const latestSocSample = samples.findLast((sample) => Number.isFinite(Number(sample.stateOfChargePercent)));
  const soc = Number(latestSocSample?.stateOfChargePercent);
  if (!Number.isFinite(soc)) return unavailable("battery state of charge is unavailable");
  const capacityEstimate = estimateEffectiveBatteryCapacity(samples, config.batteryCapabilities.usableCapacityKwh);
  const capacityKwh = Number(capacityEstimate.capacityKwh);
  const dischargeLimit = Number(config.settingCache?.discharge_limit?.lastKnown?.decoded?.percent ?? 20);
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
  const chargePerformance = {
    ...effectiveAdaptiveChargeWatts(config, state),
    storageEfficiency: effectiveAdaptiveChargeStorageEfficiency(state),
  };
  const maximumChargeWatts = chargePerformance.effectiveWatts;
  const startMs = now.getTime();
  const demandByDay = new Map();
  const timeline = [];
  let predictedSolarKwh = 0;
  let forecastSolarKwh = 0;
  let predictedDemandKwh = 0;
  let predictedSurplusKwh = 0;
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
    predictedSolarKwh += solarKwh;
    predictedDemandKwh += demandKwh;
    predictedSurplusKwh += Math.max(0, solarKwh - demandKwh);
    const band = explicitDiscountedBand(config, date);
    const bandOccurrence = band ? discountedBandOccurrence(config, date) : null;
    timeline.push({
      startMs: time,
      endMs: slotEndMs,
      demandW: slotDemandW,
      solarKwh,
      demandKwh,
      netKwh: solarKwh - demandKwh,
      highSolarNetKwh: highSolarKwh - demandKwh,
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
  const optimized = planChronologicalDiscountedCharging({
    timeline,
    currentStoredKwh: initialStoredKwh,
    capacityKwh,
    dischargeFloorKwh,
    maximumTargetPercent: Number(config.adaptiveCharging.targetSocPercent),
    maximumChargeWatts,
    chargeStorageEfficiency: chargePerformance.storageEfficiency.fraction,
  });
  const timelineView = buildAdaptiveChargingTimelineView({
    timeline,
    slots: optimized.slots,
    initialStoredKwh,
    floorKwh: dischargeFloorKwh,
    capacityKwh,
    chargeStorageEfficiency: chargePerformance.storageEfficiency.fraction,
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
    targetSocPercent: Number(config.adaptiveCharging.targetSocPercent),
    expectedSunsetSocPercent: capacityKwh ? Math.min(100, optimized.expectedEndStoredKwh / capacityKwh * 100) : null,
    predictedSolarKwh,
    forecastSolarKwh,
    predictedDemandKwh,
    predictedSurplusKwh,
    chargePerformance,
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
        .sort((a, b) => b - a),
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
    batteryCapacity: capacityEstimate,
    slots: optimized.slots,
    timeline: timelineView,
  };
}

function sampleFromStatus(status, config, previousSample) {
  // Convert the large live status payload into one compact time-series sample.
  // We store only normalized values that graphs and savings calculations need.
  const timestamp = status.read_at ?? new Date().toISOString();
  const batteryPowerW = numericMetric(status.energy?.battery?.instant_power);
  const solarPowerW = config.solarEnabled === false ? null : numericMetric(status.energy?.solar?.instant_power);
  const fuelCellPowerW = config.fuelCellEnabled === false ? null : strongestFuelCellWatts(status.energy?.fuel_cells);
  const houseDemandW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.house_demand_power);
  const gridImportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_import_power);
  const gridExportW = config.smartCosmoEnabled === false ? null : numericMetric(status.meter?.grid_export_power);
  const stateOfChargePercent = numericMetric(status.energy?.battery?.remaining_percent);
  const circuitPowerW = config.smartCosmoEnabled === false
    ? {}
    : circuitChannelMap(status.meter?.channel_power?.decoded?.channels);
  const circuitCumulativeKwh = config.smartCosmoEnabled === false
    ? {}
    : circuitCumulativeMap(status.meter?.channel_energy?.decoded?.channels);
  const circuitEnergyKwh = {};
  for (const id of Object.keys({ ...circuitPowerW, ...circuitCumulativeKwh })) {
    const cumulative = circuitEnergyDeltaKwh(circuitCumulativeKwh[id], previousSample?.circuitCumulativeKwh?.[id]);
    if (cumulative !== null) {
      circuitEnergyKwh[id] = cumulative;
    } else if (previousSample?.timestamp) {
      const deltaHours = Math.max(0, Math.min(1, (new Date(timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000));
      const watts = Number(circuitPowerW[id]);
      if (Number.isFinite(watts)) circuitEnergyKwh[id] = deltaHours * (Math.max(0, watts) / 1000);
    }
  }
  const rateBand = rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh);
  const activeRate = rateBand.yenPerKwh;
  const highestRate = maxDailyRate(config.rateBands, config.standardRateYenPerKwh);
  const deltaHours = previousSample
    ? Math.max(0, Math.min(1, (new Date(timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000))
    : 0;
  const offPeakSavingsEnabled = config.rateMode !== "simple" || config.offPeakSavingsEnabled === true;
  // Grid import is already net of on-site generation, so it is the best cap on
  // how much of the battery's charging power can be attributed to bought energy.
  // When no grid meter is available, subtract solar as a conservative fallback.
  const gridChargingW = gridImportW === null
    ? Math.max(0, Number(batteryPowerW) - Math.max(0, Number(solarPowerW) || 0))
    : Math.min(Math.max(0, Number(batteryPowerW) || 0), Math.max(0, gridImportW));
  const offPeakSavingW = offPeakSavingsEnabled && batteryPowerW > 0 ? gridChargingW : 0;
  const solarGenerationKwh = deltaHours * (Math.max(0, solarPowerW ?? 0) / 1000);
  const gridImportKwh = deltaHours * (Math.max(0, gridImportW ?? 0) / 1000);
  const gridExportKwh = deltaHours * (Math.max(0, gridExportW ?? 0) / 1000);
  const offPeakSavingYen = deltaHours * (offPeakSavingW / 1000) * Math.max(0, highestRate - activeRate);
  const solarSavingYen = solarGenerationKwh * activeRate;
  return {
    timestamp,
    batteryPowerW,
    stateOfChargePercent,
    solarPowerW,
    houseDemandW,
    fuelCellPowerW,
    gridExportW,
    gridImportW,
    circuitPowerW,
    circuitCumulativeKwh,
    circuitEnergyKwh,
    solarGenerationKwh,
    gridImportKwh,
    gridExportKwh,
    offPeakSavingYen,
    solarSavingYen,
    rateYenPerKwh: activeRate,
    rateLabel: rateBand.label || null,
  };
}

async function recordStatusSample(status, config) {
  const sample = sampleFromStatus(status, config, lastRecordedSample);
  lastRecordedSample = historyStore.appendSample(sample);
  if (adaptiveChargingHistoryCache) {
    const adaptiveChargingSample = adaptiveChargingHistorySample(sample);
    if (adaptiveChargingSample) adaptiveChargingHistoryCache.samples.push(adaptiveChargingSample);
    adaptiveChargingHistoryCache.samples = adaptiveChargingHistoryCache.samples.filter(
      (item) => new Date(item.timestamp).getTime() >= adaptiveChargingHistoryCache.startMs,
    );
  }
  return sample;
}

async function recordGuardTriggerSample(at = new Date()) {
  await ensureDataDir();
  historyStore.appendSample({
    timestamp: at.toISOString(),
    guardTriggerCount: 1,
  });
}

function sampleSolarGenerationKwh(sample) {
  const direct = finiteNumberOrNull(sample.solarGenerationKwh);
  if (Number.isFinite(direct)) return direct;
  const solarSavingYen = finiteNumberOrNull(sample.solarSavingYen);
  const rateYenPerKwh = finiteNumberOrNull(sample.rateYenPerKwh);
  if (Number.isFinite(solarSavingYen) && Number.isFinite(rateYenPerKwh) && rateYenPerKwh > 0) {
    return solarSavingYen / rateYenPerKwh;
  }
  return 0;
}

function samplePowerKwh(sample, directKey, wattsKey, previousSample) {
  const direct = finiteNumberOrNull(sample[directKey]);
  if (Number.isFinite(direct)) return direct;
  if (!previousSample?.timestamp || !sample?.timestamp) return 0;
  const watts = finiteNumberOrNull(sample[wattsKey]);
  if (!Number.isFinite(watts)) return 0;
  const deltaHours = Math.max(0, Math.min(1, (new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000));
  return deltaHours * (Math.max(0, watts) / 1000);
}

function hasPowerSample(sample, directKey, wattsKey, previousSample) {
  if (Number.isFinite(finiteNumberOrNull(sample?.[directKey]))) return true;
  return Boolean(previousSample?.timestamp
    && sample?.timestamp
    && Number.isFinite(finiteNumberOrNull(sample?.[wattsKey])));
}

function summarizeEnergySources(samples, config, solarGenerationKwh, gridExportKwh) {
  const standardRate = configNumber(
    config.standardRateYenPerKwh,
    DEFAULT_CONFIG.standardRateYenPerKwh,
    0,
    1000,
  );
  const grid = samples.reduce(
    (totals, sample, index) => {
      const importedKwh = samplePowerKwh(
        sample,
        "gridImportKwh",
        "gridImportW",
        samples[index - 1],
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
  const solarUsedKwh = Math.max(0, solarGenerationKwh - gridExportKwh);
  const totalKwh = grid.peakGridKwh + grid.offPeakGridKwh + solarUsedKwh;
  const percent = (value) => totalKwh > 0 ? (value / totalKwh) * 100 : 0;
  return {
    ...grid,
    solarUsedKwh,
    totalKwh,
    peakGridPercent: percent(grid.peakGridKwh),
    offPeakGridPercent: percent(grid.offPeakGridKwh),
    solarUsedPercent: percent(solarUsedKwh),
  };
}

function summarizeSamples(samples, config = DEFAULT_CONFIG, extras = {}) {
  const solarGenerationKwh = samples.reduce((sum, sample) => sum + sampleSolarGenerationKwh(sample), 0);
  const gridImportKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "gridImportKwh", "gridImportW", samples[index - 1]),
    0,
  );
  const gridExportKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "gridExportKwh", "gridExportW", samples[index - 1]),
    0,
  );
  const houseDemandKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", samples[index - 1]),
    0,
  );
  const fuelCellKwh = samples.reduce(
    (sum, sample, index) => sum + samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", samples[index - 1]),
    0,
  );
  const circuits = summarizeCircuits(samples, config);
  const battery = samples.reduce(
    (acc, sample, index) => {
      const charged = samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", samples[index - 1]);
      const discharged = samplePowerKwh(
        { ...sample, batteryPowerW: -Number(sample.batteryPowerW) },
        "batteryDischargeKwh",
        "batteryPowerW",
        samples[index - 1],
      );
      acc.chargedKwh += charged;
      acc.dischargedKwh += discharged;
      return acc;
    },
    { chargedKwh: 0, dischargedKwh: 0 },
  );
  const socSamples = samples
    .map((sample) => finiteNumberOrNull(sample.stateOfChargePercent))
    .filter((value) => Number.isFinite(value));
  const averageStateOfChargePercent = socSamples.length
    ? socSamples.reduce((sum, value) => sum + value, 0) / socSamples.length
    : null;
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const guardTriggerCount = samples.reduce(
    (sum, sample) => sum + Math.max(0, Number(sample.guardTriggerCount ?? 0) || 0),
    0,
  ) + Math.max(0, Number(extras.guardTriggerCount ?? 0) || 0);
  const energySources = summarizeEnergySources(
    samples,
    config,
    solarGenerationKwh,
    gridExportKwh,
  );
  return {
    sampleCount: samples.length,
    start: samples[0]?.timestamp ?? null,
    end: samples[samples.length - 1]?.timestamp ?? null,
    offPeakSavingYen: samples.reduce((sum, sample) => sum + Number(sample.offPeakSavingYen ?? 0), 0),
    solarSavingYen: samples.reduce((sum, sample) => sum + Number(sample.solarSavingYen ?? 0), 0),
    solarGenerationKwh,
    gridImportKwh,
    gridExportKwh,
    houseDemandKwh,
    fuelCellKwh,
    circuits,
    circuitTotalKwh: circuits.reduce((sum, circuit) => sum + Number(circuit.totalKwh ?? 0), 0),
    batteryChargedKwh: battery.chargedKwh,
    batteryDischargedKwh: battery.dischargedKwh,
    batteryNetKwh: battery.chargedKwh - battery.dischargedKwh,
    averageStateOfChargePercent,
    co2SavingKg: solarGenerationKwh * co2TonnesPerKwh * 1000,
    guardTriggerCount,
    energySources,
  };
}

function normalizeReportBucket(value) {
  if (["day", "week", "month"].includes(value)) return value;
  throw new Error("bucket must be day, week, or month");
}

function startOfReportBucket(date, bucket) {
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

function endOfReportBucket(start, bucket) {
  const end = new Date(start);
  if (bucket === "month") end.setMonth(end.getMonth() + 1);
  else if (bucket === "week") end.setDate(end.getDate() + 7);
  else end.setDate(end.getDate() + 1);
  return end;
}

function reportBucketKey(start, bucket) {
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const day = String(start.getDate()).padStart(2, "0");
  if (bucket === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function reportBucketLabel(start, bucket) {
  if (bucket === "month") {
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  }
  if (bucket === "week") {
    const end = new Date(endOfReportBucket(start, bucket).getTime() - 1);
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")} - ${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  }
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}

function emptyReportBucket(start, bucket) {
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
  };
}

function addReportEnergy(bucket, key, value, valid) {
  if (!valid) return;
  bucket[key] += Number(value) || 0;
  bucket._valid[key] += 1;
}

function finalizeReportBucket(bucket, previousBucket) {
  const out = { ...bucket };
  delete out._valid;
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
  return out;
}

function summarizeReportBuckets(buckets) {
  const sum = (key) => {
    const values = buckets
      .map((bucket) => bucket[key])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const peaks = buckets
    .map((bucket) => finiteNumberOrNull(bucket.peakDemandW))
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
    solarSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.solarSavingYen ?? 0), 0),
    offPeakSavingYen: buckets.reduce((total, bucket) => total + Number(bucket.offPeakSavingYen ?? 0), 0),
    co2SavingKg: buckets.reduce((total, bucket) => total + Number(bucket.co2SavingKg ?? 0), 0),
    peakDemandW: peaks.length ? Math.max(...peaks) : null,
    solarCoveragePercent:
      Number.isFinite(houseDemandKwh) && houseDemandKwh > 0 && Number.isFinite(solarGenerationKwh)
        ? (solarGenerationKwh / houseDemandKwh) * 100
        : null,
    sampleCount: buckets.reduce((total, bucket) => total + Number(bucket.sampleCount ?? 0), 0),
  };
}

function createEnergyReportAccumulator({ start, end, bucket = "day", config = DEFAULT_CONFIG, previousSample = null } = {}) {
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
    process(sample) {
      const time = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(time)) {
        prev = sample;
        return "skipped";
      }
      if (time < startMs) {
        prev = sample;
        return "before";
      }
      if (time >= endMs) return "after";
      const bucketStart = startOfReportBucket(new Date(time), bucketMode);
      const key = reportBucketKey(bucketStart, bucketMode);
      if (!byKey.has(key)) byKey.set(key, emptyReportBucket(bucketStart, bucketMode));
      const row = byKey.get(key);
      row.sampleCount += Number(sample.rollupSampleCount ?? 1) || 1;
      addReportEnergy(
        row,
        "houseDemandKwh",
        samplePowerKwh(sample, "houseDemandKwh", "houseDemandW", prev),
        hasPowerSample(sample, "houseDemandKwh", "houseDemandW", prev),
      );
      addReportEnergy(
        row,
        "gridImportKwh",
        samplePowerKwh(sample, "gridImportKwh", "gridImportW", prev),
        hasPowerSample(sample, "gridImportKwh", "gridImportW", prev),
      );
      addReportEnergy(
        row,
        "gridExportKwh",
        samplePowerKwh(sample, "gridExportKwh", "gridExportW", prev),
        hasPowerSample(sample, "gridExportKwh", "gridExportW", prev),
      );
      addReportEnergy(
        row,
        "fuelCellKwh",
        samplePowerKwh(sample, "fuelCellKwh", "fuelCellPowerW", prev),
        hasPowerSample(sample, "fuelCellKwh", "fuelCellPowerW", prev),
      );
      addReportEnergy(
        row,
        "batteryChargedKwh",
        samplePowerKwh(sample, "batteryChargeKwh", "batteryPowerW", prev),
        hasPowerSample(sample, "batteryChargeKwh", "batteryPowerW", prev),
      );
      addReportEnergy(
        row,
        "batteryDischargedKwh",
        samplePowerKwh({ ...sample, batteryPowerW: -Number(sample.batteryPowerW) }, "batteryDischargeKwh", "batteryPowerW", prev),
        hasPowerSample(sample, "batteryDischargeKwh", "batteryPowerW", prev),
      );
      const solarGenerationKwh = sampleSolarGenerationKwh(sample);
      addReportEnergy(
        row,
        "solarGenerationKwh",
        solarGenerationKwh,
        Number.isFinite(finiteNumberOrNull(sample.solarGenerationKwh))
          || hasPowerSample(sample, "solarGenerationKwh", "solarPowerW", prev),
      );
      row.solarSavingYen += Number(sample.solarSavingYen ?? 0) || 0;
      row.offPeakSavingYen += Number(sample.offPeakSavingYen ?? 0) || 0;
      row.co2SavingKg += solarGenerationKwh * co2TonnesPerKwh * 1000;
      const demand = Number(sample.peakHouseDemandW ?? sample.houseDemandW);
      if (Number.isFinite(demand)) row.peakDemandW = Math.max(row.peakDemandW ?? demand, demand);
      prev = sample;
      return "included";
    },
    finish() {
      const buckets = [];
      let cursor = startOfReportBucket(new Date(startMs), bucketMode);
      while (cursor.getTime() < endMs) {
        const key = reportBucketKey(cursor, bucketMode);
        const raw = byKey.get(key) ?? emptyReportBucket(cursor, bucketMode);
        buckets.push(finalizeReportBucket(raw, buckets.at(-1)));
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

function aggregateEnergyReportSamples(samples, options = {}) {
  const accumulator = createEnergyReportAccumulator(options);
  for (const sample of samples) {
    const result = accumulator.process(sample);
    if (result === "after") break;
  }
  return accumulator.finish();
}

function isGuardTriggerLog(entry) {
  return entry?.kind === "guard" ||
    String(entry?.message ?? "").includes("exceeds Charge Demand Guard limit");
}

function countGuardTriggersForRange(rules, start, end, options = {}) {
  const startMs = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
  const endMs = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  const excludeTimes = options.excludeTimes ?? new Set();
  return rules
    .filter((rule) => rule.type === "backup-demand-guard")
    .flatMap((rule) => Array.isArray(rule.log) ? rule.log : [])
    .filter((entry) => {
      if (!isGuardTriggerLog(entry)) return false;
      const atMs = new Date(entry.at).getTime();
      if (excludeTimes.has(entry.at)) return false;
      return Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs;
    })
    .length;
}

async function readHistoryRange(start, end, config = DEFAULT_CONFIG) {
  await ensureDataDir();
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 60_000;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("valid start and end date/time are required");
  }
  const samples = await readHistorySamplesInRange(startMs, endMs);
  const guardTriggerSampleTimes = new Set(
    samples
      .filter((sample) => Number(sample.guardTriggerCount ?? 0) > 0 && sample.timestamp)
      .map((sample) => sample.timestamp),
  );
  const guardTriggerCount = countGuardTriggersForRange(
    await readAutomationRules(),
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    { excludeTimes: guardTriggerSampleTimes },
  );
  return { samples, summary: summarizeSamples(samples, config, { guardTriggerCount }) };
}

async function readEnergyReport(start, end, bucket, config = DEFAULT_CONFIG) {
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

async function readHistoryStats() {
  return historyStore.stats();
}

async function trimHistory(retention) {
  adaptiveChargingHistoryCache = null;
  adaptiveChargingDemandProfileIndexCache = null;
  return historyStore.applyRetention(retention);
}

async function readSchedules() {
  await ensureDataDir();
  try {
    const text = await readFile(SCHEDULES_FILE, "utf8");
    const parsed = parseJsonWithContext(text, SCHEDULES_FILE);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeSchedules(schedules) {
  await ensureDataDir();
  await writeJsonFileAtomic(SCHEDULES_FILE, schedules);
}

function normalizeHostList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function configBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function configNumber(value, fallback, min = 0, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function optionalConfigNumber(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function optionalSteppedConfigNumber(value, min, max, step) {
  const number = optionalConfigNumber(value, min, max);
  if (number === null) return null;
  return Math.max(min, Math.min(max, Math.round(number / step) * step));
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value ?? ""))) return false;
  const [hh, mm] = String(value).split(":").map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function minutesOfDay(value) {
  if (!isValidTime(value)) return null;
  const [hh, mm] = String(value).split(":").map(Number);
  return hh * 60 + mm;
}

function normalizeSubnets(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
    .filter((item) => /^(\d{1,3}\.){3}0\/24$/.test(item))
    .filter((item) => item.split(".").slice(0, 3).every((part) => Number(part) >= 0 && Number(part) <= 255));
}

function normalizeRateMode(input = {}) {
  if (["simple", "offPeak", "multi"].includes(input.rateMode)) return input.rateMode;
  if (input.offPeakSavingsEnabled === true) {
    return Array.isArray(input.rateBands) && input.rateBands.length > 2 ? "multi" : "offPeak";
  }
  return DEFAULT_CONFIG.rateMode;
}

function normalizeRateBands(input = {}) {
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
    .map((band) => ({
      start: isValidTime(band.start) ? band.start : "00:00",
      end: isValidTime(band.end) ? band.end : "00:00",
      yenPerKwh: configNumber(band.yenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh, 0, 1000),
      label: String(band.label ?? "").trim(),
    }));
  return bands.length ? bands : DEFAULT_CONFIG.rateBands;
}

function normalizeBatteryCapabilities(value = {}) {
  return {
    usableCapacityKwh: optionalConfigNumber(value.usableCapacityKwh, 0.1, 1000),
    maximumChargeWatts: optionalSteppedConfigNumber(value.maximumChargeWatts, 50, 100000, 50),
  };
}

function normalizeAdaptiveCharging(value = {}) {
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

function normalizeDashboardWidgets(value = []) {
  const inputById = new Map(
    (Array.isArray(value) ? value : [])
      .map((widget) => [String(widget?.id ?? ""), widget])
      .filter(([id]) => DEFAULT_DASHBOARD_WIDGETS.some((item) => item.id === id)),
  );
  return DEFAULT_DASHBOARD_WIDGETS.map((defaults) => {
    const input = inputById.get(defaults.id) ?? {};
    return {
      id: defaults.id,
      group: defaults.group,
      visible: configBool(input.visible, defaults.visible),
      priority: configNumber(input.priority, defaults.priority, 0, 10000),
    };
  });
}

function normalizeCircuitSortMode(value) {
  if (value === "energy") return "current";
  return ["number", "current", "accumulated"].includes(value)
    ? value
    : DEFAULT_CONFIG.circuitSortMode;
}

function normalizeSettingCache(value = {}) {
  const out = {};
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

function normalizeRetentionConfig(value = {}, legacyDays = undefined) {
  return {
    ...normalizeRetentionPolicy(value, legacyDays),
    automaticMaintenance: configBool(value.automaticMaintenance, true),
  };
}

function cleanConfig(input = {}) {
  // Config can arrive from old files, forms, or hand-edited JSON. Normalize it
  // here so the rest of the server can assume stable types.
  const rateMode = normalizeRateMode(input);
  const rateBands = normalizeRateBands({ ...input, rateMode });
  const standardRate = configNumber(input.standardRateYenPerKwh, Math.max(...rateBands.map((band) => band.yenPerKwh)));
  const offPeakRate = configNumber(input.offPeakRateYenPerKwh, Math.min(...rateBands.map((band) => band.yenPerKwh)));
  return {
    batteryHost: String(input.batteryHost ?? DEFAULT_CONFIG.batteryHost).trim(),
    meterHost: String(input.meterHost ?? DEFAULT_CONFIG.meterHost).trim(),
    meterEoj: String(input.meterEoj ?? DEFAULT_CONFIG.meterEoj).trim() || DEFAULT_CONFIG.meterEoj,
    smartCosmoEnabled: configBool(input.smartCosmoEnabled, DEFAULT_CONFIG.smartCosmoEnabled),
    circuitLabels: normalizeCircuitLabels(input.circuitLabels ?? DEFAULT_CONFIG.circuitLabels),
    circuitSortMode: normalizeCircuitSortMode(input.circuitSortMode),
    solarHost: String(input.solarHost ?? input.batteryHost ?? DEFAULT_CONFIG.solarHost).trim(),
    solarEnabled: configBool(input.solarEnabled, DEFAULT_CONFIG.solarEnabled),
    fuelCellHosts: normalizeHostList(input.fuelCellHosts ?? DEFAULT_CONFIG.fuelCellHosts),
    fuelCellEnabled: configBool(input.fuelCellEnabled, DEFAULT_CONFIG.fuelCellEnabled),
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
    notifications: normalizeNotificationConfig(input.notifications ?? {}),
    dashboardWidgets: normalizeDashboardWidgets(input.dashboardWidgets),
    settingCache: normalizeSettingCache(input.settingCache ?? {}),
    language: ["en", "ja"].includes(input.language) ? input.language : DEFAULT_CONFIG.language,
  };
}

async function readConfig() {
  await ensureDataDir();
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    const parsed = parseJsonWithContext(text, CONFIG_FILE);
    const cleaned = cleanConfig(parsed);
    if (Object.prototype.hasOwnProperty.call(parsed, "automation")
      || Object.prototype.hasOwnProperty.call(parsed, "historyRetentionDays")) {
      await writeJsonFileAtomic(CONFIG_FILE, cleaned);
    }
    return cleaned;
  } catch (err) {
    if (err.code === "ENOENT") return cleanConfig(DEFAULT_CONFIG);
    throw err;
  }
}

async function writeConfig(config) {
  const previous = await readConfig().catch(() => cleanConfig(DEFAULT_CONFIG));
  const cleaned = cleanConfig({ ...previous, ...config });
  await ensureDataDir();
  const hostKeys = ["batteryHost", "meterHost", "meterEoj", "solarHost"];
  const hostChanged = hostKeys.some((key) => previous[key] !== cleaned[key])
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
  });
  if (adaptiveChargingInputsChanged) {
    const state = await readAdaptiveChargingState();
    const changedAt = new Date();
    state.plan = null;
    state.interruptedCharge = null;
    state.breakerRecovery = null;
    state.lastPlanEventKey = null;
    state.pendingPlanReason = "configuration changed";
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
    if (state.owner === "adaptiveCharging") {
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
  await writeJsonFileAtomic(CONFIG_FILE, cleaned);
  if (hostChanged) lastRecordedSample = null;
  return cleaned;
}

async function migrateBatteryCapabilitiesFromGuard() {
  const config = await readConfig();
  if (Number.isFinite(Number(config.batteryCapabilities?.maximumChargeWatts))) return config;
  const rules = await readAutomationRules();
  const legacy = rules.find((rule) => rule.type === "backup-demand-guard")?.conditions?.batteryChargingEstimateW;
  if (!Number.isFinite(Number(legacy)) || Number(legacy) <= 0) return config;
  return writeConfig({
    ...config,
    batteryCapabilities: {
      ...config.batteryCapabilities,
      maximumChargeWatts: Number(legacy),
    },
  });
}

async function readAutomationRules() {
  await ensureDataDir();
  const { configs, legacyStates } = await readAutomationRuleConfigs();
  const states = await readAutomationRuleStates();
  let shouldWriteState = false;
  const rules = configs.map((config) => {
    const state = states[config.id] ?? legacyStates[config.id] ?? {};
    if (!states[config.id] && legacyStates[config.id]) shouldWriteState = true;
    return mergeAutomationRule(config, state);
  });
  if (shouldWriteState) {
    await writeAutomationRuleStates(rules);
    await writeAutomationRules(rules);
  }
  return rules;
}

async function readAutomationRuleConfigs() {
  await ensureDataDir();
  try {
    const text = await readFile(AUTOMATION_RULES_FILE, "utf8");
    const parsed = parseJsonWithContext(text, AUTOMATION_RULES_FILE);
    const source = Array.isArray(parsed) ? parsed : [];
    const configs = source.map(cleanAutomationRuleConfig);
    const legacyStates = Object.fromEntries(
      source
        .filter((rule) => rule && (rule.lastResult !== undefined || rule.state !== undefined || rule.log !== undefined))
        .map((rule) => [String(rule.id), cleanAutomationRuleState(rule)]),
    );
    return { configs, legacyStates };
  } catch (err) {
    if (err.code === "ENOENT") return { configs: [], legacyStates: {} };
    throw err;
  }
}

function normalizeAutomationRuleStateFile(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([id]) => id)
      .map(([id, state]) => [id, cleanAutomationRuleState(state)]),
  );
}

async function readAutomationRuleStates() {
  await ensureDataDir();
  try {
    const text = await readFile(AUTOMATION_RULE_STATE_FILE, "utf8");
    let parsed;
    let recovered = null;
    try {
      parsed = parseJsonWithContext(text, AUTOMATION_RULE_STATE_FILE);
    } catch (err) {
      recovered = recoverConcatenatedJsonValue(
        text,
        (value) => value && typeof value === "object" && !Array.isArray(value),
      );
      if (!recovered) throw err;
      logDetailedError("automation-rule-state", err);
      console.error(
        `automation-rule-state: recovered state from JSON document ${recovered.documentCount} at bytes ${recovered.start}-${recovered.end}`,
      );
      parsed = recovered.value;
    }
    const cleaned = normalizeAutomationRuleStateFile(parsed);
    if (recovered) {
      await writeJsonFileAtomic(AUTOMATION_RULE_STATE_FILE, cleaned);
      console.error("automation-rule-state: repaired automation-rule-state.json after recovery");
    }
    return cleaned;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeAutomationRules(rules) {
  await ensureDataDir();
  const cleaned = rules.map(cleanAutomationRuleConfig);
  await writeJsonFileAtomic(AUTOMATION_RULES_FILE, cleaned);
  return cleaned;
}

async function writeAutomationRuleStates(rules) {
  await ensureDataDir();
  const states = Object.fromEntries(
    rules.map((rule) => [rule.id, cleanAutomationRuleState(rule)]),
  );
  await writeJsonFileAtomic(AUTOMATION_RULE_STATE_FILE, states);
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

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const textBody = Buffer.concat(chunks).toString("utf8");
  if (!textBody) return {};
  return parseJsonWithContext(textBody, `${req.method} ${req.url} request body`);
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function awayTimestamp(value, label) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw requestError(400, `${label} must be a valid date and time`);
  return time;
}

function awayPeriodRange(period) {
  return {
    startMs: new Date(period.from).getTime(),
    untilMs: new Date(period.until).getTime(),
  };
}

function awayPeriodsOverlap(left, right) {
  const leftRange = awayPeriodRange(left);
  const rightRange = awayPeriodRange(right);
  return leftRange.startMs < rightRange.untilMs && leftRange.untilMs > rightRange.startMs;
}

function ensureAwayPeriodDoesNotOverlap(period, excludeId = null) {
  const conflict = historyStore.awayPeriods({ includeCompleted: true })
    .find((candidate) => candidate.id !== excludeId && awayPeriodsOverlap(period, candidate));
  if (conflict) {
    throw requestError(
      409,
      `Away period overlaps the existing period from ${conflict.from} until ${conflict.until}`,
    );
  }
}

function awayPeriodsView(now = new Date()) {
  const nowMs = now.getTime();
  const periods = historyStore.awayPeriods({ includeCompleted: false, nowMs });
  return {
    periods,
    active: periods.find((period) => period.status === "active") ?? null,
    next: periods.find((period) => period.status === "scheduled") ?? null,
    state: periods.some((period) => period.status === "active") ? "away" : "home",
    returnBufferMinutes: AWAY_RETURN_BUFFER_MS / 60_000,
  };
}

function cleanNewAwayPeriod(body, now = new Date()) {
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

async function queueAdaptiveChargingForAwayChange(reason, now = new Date()) {
  const state = await readAdaptiveChargingState();
  state.pendingPlanReason = reason;
  state.lastPlanEventKey = null;
  appendAdaptiveChargingLog(state, `${reason}; Adaptive Charging recalculation queued`, "away", now);
  await writeAdaptiveChargingState(state);
}

function numberInRange(value, label, min, max, step = 1) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max || n % step !== 0) {
    throw new Error(`${label} must be an integer from ${min} to ${max}${step > 1 ? ` in ${step} steps` : ""}`);
  }
  return n;
}

function hostFrom(body, config) {
  return body.host || config.batteryHost;
}

function fuelCellArgs(hosts = []) {
  return hosts.length ? { "fuel-cell-host": hosts } : {};
}

function parseRawHex(raw) {
  // The CLI reports raw EDT payloads as strings. Convert them back to Buffer
  // when the server needs to do small decodes itself.
  if (!raw || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  return Buffer.from(raw.slice(2), "hex");
}

function isDocumentationHost(host) {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(String(host ?? ""));
}

async function readMeterStatus(config) {
  if (config.smartCosmoEnabled === false || !config.meterHost || isDocumentationHost(config.meterHost)) {
    return { configured: false, host: null };
  }
  try {
    return {
      configured: true,
      ...(await runCliQueued("meter-status", { host: config.meterHost, eoj: config.meterEoj })),
    };
  } catch (err) {
    return {
      configured: true,
      host: config.meterHost,
      eoj: config.meterEoj,
      error: err.message,
    };
  }
}

async function safeCli(command, args = {}, positional = []) {
  try {
    return await runCliQueued(command, args, positional);
  } catch (err) {
    return { error: err.message };
  }
}

async function settingWithCache(config, key, reader) {
  const cached = config.settingCache?.[key] ?? null;
  const data = await reader();
  if (data && !data.error && (data.raw || data.decoded)) {
    config.settingCache = {
      ...(config.settingCache ?? {}),
      [key]: {
        lastKnown: data,
        lastReadAt: new Date().toISOString(),
      },
    };
    await writeConfig(config);
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

async function readAllStatus(onProbeComplete = () => {}) {
  // One dashboard refresh fans out into several short CLI calls. The queue keeps
  // node-echonet-lite from fighting itself over UDP port 3610.
  const config = await readConfig();
  const energyArgs = {
    "battery-host": config.batteryHost,
    ...(config.solarEnabled ? { "solar-host": config.solarHost } : { "no-solar": true }),
    ...(config.fuelCellEnabled ? fuelCellArgs(config.fuelCellHosts) : { "no-fuel-cell": true }),
  };
  const batteryConfigured = config.batteryHost && !isDocumentationHost(config.batteryHost);
  const skippedSetting = { available: false, error: "battery host is not configured", lastKnown: null, lastReadAt: null };
  const probe = async (label, reader) => {
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

  async function hydrateWindowRaw(windowData, epcHex) {
    // Some profile/window helpers may return null decoded data if a device is in
    // a mode where that property is unavailable. A raw-get retry gives the UI the
    // best chance to populate selectors without inventing fallback values.
    if (windowData?.raw) return windowData;
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
  const status = {
    hosts: {
      battery: config.batteryHost,
      meter: config.smartCosmoEnabled ? config.meterHost || null : null,
      solar: config.solarEnabled ? config.solarHost : null,
      fuel_cells: config.fuelCellEnabled ? config.fuelCellHosts : [],
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
  return status;
}

function deviceStatusFailures(status, config) {
  const failures = [];
  const energyError = status.energy?.error;
  if (config.batteryHost && !isDocumentationHost(config.batteryHost)) {
    const error = energyError ?? status.energy?.battery?.error;
    if (error) failures.push(`Battery: ${error}`);
  }
  if (config.smartCosmoEnabled && config.meterHost && !isDocumentationHost(config.meterHost)) {
    if (status.meter?.error) failures.push(`Smart Cosmo: ${status.meter.error}`);
  }
  if (config.solarEnabled && config.solarHost && !isDocumentationHost(config.solarHost)) {
    const error = energyError ?? status.energy?.solar?.error;
    if (error) failures.push(`Solar: ${error}`);
  }
  if (config.fuelCellEnabled && config.fuelCellHosts.some((host) => !isDocumentationHost(host))) {
    const fuelCellErrors = (status.energy?.fuel_cells ?? status.energy?.fuelCells ?? [])
      .map((item) => item?.error)
      .filter(Boolean);
    if (energyError) failures.push(`Ene-Farm: ${energyError}`);
    else if (fuelCellErrors.length) failures.push(`Ene-Farm: ${fuelCellErrors.join(", ")}`);
  }
  return [...new Set(failures)];
}

function observeDeviceNotifications(status, config) {
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

function observeBatterySocNotifications(status, config) {
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

async function executeAction(action, payload = {}) {
  // Settings and direct actions share this path so scheduled jobs exercise the
  // same validation and CLI writes as button clicks in the UI.
  const config = await readConfig();
  const host = hostFrom(payload, config);
  switch (action) {
    case "vendor-profile":
      if (!payload.mode) throw new Error("mode is required");
      return runCliQueued("vendor-profile", { host }, [payload.mode]);
    case "discharge-limit":
      return runCliQueued("discharge-limit", { host }, [
        numberInRange(payload.percent, "percent", 0, 100, 10),
      ]);
    case "osaifu-charge-window": {
      const startHour = numberInRange(payload.startHour, "startHour", 0, 23);
      const endHour = numberInRange(payload.endHour, "endHour", 0, 23);
      return runCliQueued("osaifu-charge-window", { host }, [startHour, endHour]);
    }
    case "osaifu-discharge-window": {
      const startHour = numberInRange(payload.startHour, "startHour", 0, 23);
      const endHour = numberInRange(payload.endHour, "endHour", 0, 23);
      return runCliQueued("osaifu-discharge-window", { host }, [startHour, endHour]);
    }
    case "set-mode":
      if (!payload.mode) throw new Error("mode is required");
      return runCliQueued("set-mode", { host }, [payload.mode]);
    case "charge":
    case "discharge": {
      const args = { host };
      if (payload.targetWh !== undefined && payload.targetWh !== "") {
        args["target-wh"] = numberInRange(payload.targetWh, "targetWh", 0, 999999999);
      }
      return runCliQueued(action, args);
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

function parseRunAt(schedule) {
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

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function isDue(schedule, now) {
  // Daily schedules run once per local calendar day; one-off schedules disable
  // themselves after a successful attempt.
  if (!schedule.enabled) return false;
  if (schedule.running) return false;
  if (schedule.repeat === "daily") {
    const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : ALL_DAYS;
    if (!days.includes(now.getDay())) return false;
    const current = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const todayKey = now.toISOString().slice(0, 10);
    return schedule.time === current && schedule.lastRunDate !== todayKey;
  }
  return schedule.runAt && new Date(schedule.runAt) <= now;
}

function clearStaleScheduleRuns(schedules, activeIds = runningScheduleIds) {
  let changed = false;
  for (const schedule of schedules) {
    if (!schedule.running || activeIds.has(schedule.id)) continue;
    schedule.running = false;
    schedule.runningSince = null;
    changed = true;
  }
  return changed;
}

async function runDueSchedules() {
  const config = await readConfig();
  if (config.adaptiveCharging?.enabled && config.solarEnabled !== false && config.rateMode !== "simple") return;
  const schedules = await readSchedules();
  const now = new Date();
  let changed = clearStaleScheduleRuns(schedules);
  if (changed) {
    console.warn("scheduler: cleared stale running state from persisted schedule data");
    await writeSchedules(schedules);
  }
  for (const schedule of schedules) {
    if (!isDue(schedule, now)) continue;
    runningScheduleIds.add(schedule.id);
    schedule.running = true;
    schedule.runningSince = now.toISOString();
    changed = true;
    await writeSchedules(schedules);
    try {
      const result = await executeAction(schedule.action, schedule.payload);
      schedule.lastResult = { ok: true, at: new Date().toISOString(), result };
      if (schedule.repeat === "daily") {
        schedule.lastRunDate = now.toISOString().slice(0, 10);
      } else {
        schedule.enabled = false;
        schedule.completed = true;
      }
    } catch (err) {
      schedule.lastResult = { ok: false, at: new Date().toISOString(), error: err.message };
      notificationService.enqueue({
        type: "scheduleFailed",
        severity: "error",
        title: "Scheduled battery action failed",
        message: `${schedule.repeat === "daily" ? `Daily ${schedule.time}` : schedule.runAt} ${schedule.action} failed: ${err.message}`,
        dedupeKey: `schedule-failed:${schedule.id}`,
      });
    } finally {
      runningScheduleIds.delete(schedule.id);
      schedule.running = false;
      schedule.runningSince = null;
      changed = true;
      await writeSchedules(schedules);
    }
  }
  if (changed) await writeSchedules(schedules);
}

function cleanAutomationRuleConfig(input = {}) {
  const conditions = input.conditions ?? {};
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || "Charging demand guard"),
    type: String(input.type || "backup-demand-guard"),
    enabled: input.enabled === true,
    conditions: {
      source: ["houseDemandW", "gridImportW"].includes(conditions.source) ? conditions.source : "gridImportW",
      breakerAmps: configNumber(conditions.breakerAmps, DEFAULT_GUARD_CONDITIONS.breakerAmps, 1, 400),
      breakerVoltage: configNumber(conditions.breakerVoltage, DEFAULT_GUARD_CONDITIONS.breakerVoltage, 1, 1000),
      reserveAmps: configNumber(conditions.reserveAmps, DEFAULT_GUARD_CONDITIONS.reserveAmps, 0, 200),
      batteryChargingEstimateW: configNumber(conditions.batteryChargingEstimateW, 1000, 0, 20000),
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

function cleanAutomationRuleState(input = {}) {
  return {
    lastResult: input.lastResult ?? null,
    state: input.state && typeof input.state === "object" ? input.state : {},
    log: Array.isArray(input.log) ? input.log.slice(-100) : [],
    stateUpdatedAt: input.stateUpdatedAt || input.updatedAt || new Date().toISOString(),
  };
}

function mergeAutomationRule(config, state = {}) {
  return {
    ...cleanAutomationRuleConfig(config),
    ...cleanAutomationRuleState(state),
  };
}

function cleanAutomationRule(input = {}) {
  return mergeAutomationRule(input, input);
}

function automationDemandWatts(status, source) {
  const raw = source === "gridImportW"
    ? status.meter?.grid_import_power?.value
    : status.meter?.house_demand_power?.value;
  if (raw === null || raw === undefined || raw === "") return Number.NaN;
  return Number(raw);
}

function batteryOperationMode(status) {
  return status.energy?.battery?.operation_mode?.value
    ?? status.energy?.battery?.operation_mode?.human
    ?? null;
}

function batteryChargingWatts(status) {
  const raw = status.energy?.battery?.instant_power?.value;
  if (raw === null || raw === undefined || raw === "") return null;
  const watts = Number(raw);
  if (!Number.isFinite(watts)) return null;
  return Math.max(0, watts);
}

function shouldTriggerDemandGuard({ operationMode, batteryChargingW, guardDemandW, breakerLimitW }) {
  const mode = String(operationMode ?? "").toLowerCase();
  return mode !== "standby"
    && Number(batteryChargingW) > 0
    && Number.isFinite(Number(guardDemandW))
    && Number(guardDemandW) >= Number(breakerLimitW);
}

function canRunAutomation(rule, now) {
  if (rule.lastResult?.skipped) return true;
  const lastAt = rule.lastResult?.at ? new Date(rule.lastResult.at).getTime() : 0;
  return !lastAt || (now.getTime() - lastAt) / 1000 >= rule.cooldownSeconds;
}

function formatWatts(value) {
  return `${Math.round(Number(value) || 0)} W`;
}

function appendAutomationLog(rule, message, at = new Date(), kind = null) {
  rule.log = [
    ...(Array.isArray(rule.log) ? rule.log : []),
    { at: at.toISOString(), message, ...(kind ? { kind } : {}) },
  ].slice(-100);
}

function automationDemandLabel(source) {
  return source === "gridImportW" ? "Grid Import" : "House demand";
}

function automationRuleLabel(rule) {
  return `${rule.name || rule.type || "unnamed rule"} [${rule.id || "unknown id"}]`;
}

function automationRuleList(rules) {
  return rules.map(automationRuleLabel).join(", ") || "none";
}

function activeCliLabel(context) {
  if (!context) return "none";
  const elapsedMs = Date.now() - new Date(context.startedAt).getTime();
  return `${context.command}${context.host ? ` on ${context.host}` : ""} (${elapsedMs}ms)`;
}

async function evaluateAutomationRule(
  rule,
  status,
  now = new Date(),
  onPhase = () => {},
  config = null,
  coordination = {},
) {
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
  const batteryChargingEstimateW = Number.isFinite(maximumChargeWatts) && maximumChargeWatts > 0
    ? maximumChargeWatts
    : rule.conditions.batteryChargingEstimateW;
  const estimatedRestoredDemandW = demandW + batteryChargingEstimateW;
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

function adaptiveChargingConfiguredActive(config) {
  return config.adaptiveCharging?.enabled === true && config.solarEnabled !== false && config.rateMode !== "simple";
}

function nextLocalMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

async function pauseAdaptiveChargingForManualAction(action, now = new Date()) {
  const config = await readConfig();
  if (!adaptiveChargingConfiguredActive(config)) return null;
  const state = await readAdaptiveChargingState();
  if (state.owner === "adaptiveCharging") await releaseAdaptiveCharge(state, "Manual battery action received", now);
  else if (state.standbyHoldUntil) {
    await executeAction("set-mode", { mode: "auto" });
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

async function resumeAdaptiveCharging(now = new Date()) {
  const state = await readAdaptiveChargingState();
  state.pausedUntil = null;
  state.plan = null;
  state.interruptedCharge = null;
  state.breakerRecovery = null;
  state.solarHeadroomHoldUntil = null;
  if (state.standbyHoldUntil) {
    await executeAction("set-mode", { mode: "auto" });
    state.standbyHoldUntil = null;
  }
  state.lastPlanEventKey = null;
  state.pendingPlanReason = "manual resume";
  appendAdaptiveChargingLog(state, "Adaptive Charging resumed manually", "resume", now);
  return writeAdaptiveChargingState(state);
}

function startAdaptiveChargeSession(state, slot, soc, now = new Date()) {
  state.activeChargeSession = {
    startedAt: now.toISOString(),
    requestedWh: Math.max(0, Math.round(Number(slot?.targetWh) || 0)),
    startSocPercent: finiteNumberOrNull(soc),
    latestSocPercent: finiteNumberOrNull(soc),
    capacityKwh: finiteNumberOrNull(state.plan?.batteryCapacity?.capacityKwh),
    slotStart: slot?.start ?? null,
    slotEnd: slot?.end ?? null,
    label: slot?.label ?? null,
  };
}

function adaptiveChargingWindowKey(window) {
  const start = window?.start ?? window?.windowStart;
  const end = window?.end ?? window?.windowEnd;
  if (!start || !end) return null;
  return JSON.stringify([start, end, Number(window?.band?.yenPerKwh ?? window?.yenPerKwh), window?.band?.label ?? window?.label ?? null]);
}

function adaptiveChargingWindowRemainingWh(plan, window) {
  const endMs = new Date(window?.end ?? window?.windowEnd).getTime();
  if (!Number.isFinite(endMs)) return 0;
  return (plan?.slots ?? [])
    .filter((slot) => new Date(slot.windowEnd ?? slot.end).getTime() === endMs)
    .reduce((sum, slot) => sum + Math.max(0, Math.round(Number(slot.targetWh) || 0)), 0);
}

function finalizeAdaptiveChargingWindowExecution(state, endSocPercent = null, now = new Date(), reason = "discounted window ended") {
  const active = state.activeWindowExecution;
  if (!active) return null;
  const endSoc = Number.isFinite(Number(endSocPercent))
    ? Number(endSocPercent)
    : finiteNumberOrNull(active.latestSocPercent);
  const summary = {
    key: active.key,
    windowStart: active.windowStart,
    windowEnd: active.windowEnd,
    label: active.label,
    yenPerKwh: active.yenPerKwh,
    plannedWh: active.plannedWh,
    deliveredWh: active.deliveredWh,
    unmetWh: Math.max(0, active.plannedWh - active.deliveredWh),
    interruptionCount: active.interruptionCount,
    startSocPercent: active.startSocPercent,
    endSocPercent: endSoc,
    completedAt: now.toISOString(),
    reason,
  };
  state.windowSummaries = [
    ...(state.windowSummaries ?? []).filter((item) => item.key !== summary.key),
    summary,
  ].slice(-ADAPTIVE_CHARGING_WINDOW_SUMMARY_LIMIT);
  state.activeWindowExecution = null;
  appendAdaptiveChargingLog(
    state,
    `${active.label || "Discounted window"} summary: ${summary.plannedWh} Wh planned, ${summary.deliveredWh} Wh delivered, ${summary.unmetWh} Wh unmet, ${summary.interruptionCount} breaker interruptions, SOC ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%`,
    summary.unmetWh > 0 ? "warning" : "summary",
    now,
  );
  return summary;
}

function syncAdaptiveChargingWindowExecution(state, occurrence, plan, soc, now = new Date(), planRecalculated = false) {
  if (!occurrence) return null;
  const key = adaptiveChargingWindowKey(occurrence);
  if (!key) return null;
  if (state.activeWindowExecution && state.activeWindowExecution.key !== key) {
    finalizeAdaptiveChargingWindowExecution(state, soc, now, "next discounted window started");
  }
  const remainingWh = adaptiveChargingWindowRemainingWh(plan, occurrence);
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
      interruptionCount: 0,
      startSocPercent: finiteNumberOrNull(soc),
      latestSocPercent: finiteNumberOrNull(soc),
      startedTrackingAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  } else {
    state.activeWindowExecution.latestSocPercent = finiteNumberOrNull(soc);
    if (planRecalculated) {
      state.activeWindowExecution.plannedWh = state.activeWindowExecution.deliveredWh + activeDeliveredWh + remainingWh;
    }
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  return state.activeWindowExecution;
}

function finalizeExpiredAdaptiveChargingWindow(state, soc, now = new Date()) {
  const active = state.activeWindowExecution;
  if (!active || state.owner === "adaptiveCharging") return null;
  const endMs = new Date(active.windowEnd).getTime();
  if (!Number.isFinite(endMs) || now.getTime() < endMs) return null;
  return finalizeAdaptiveChargingWindowExecution(state, soc, now);
}

function recordAdaptiveChargingWindowInterruption(state) {
  if (!state.activeWindowExecution) return 0;
  state.activeWindowExecution.interruptionCount += 1;
  return state.activeWindowExecution.interruptionCount;
}

function recordAdaptiveChargeSample(state, status, now = new Date()) {
  if (state.owner !== "adaptiveCharging") return false;
  const batteryChargingW = batteryChargingWatts(status) ?? 0;
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
  if (batteryChargingW > 0) {
    const houseDemandW = numericMetric(status.meter?.house_demand_power);
    const gridImportW = numericMetric(status.meter?.grid_import_power);
    state.chargingPerformance = cleanAdaptiveChargingPerformance({
      ...state.chargingPerformance,
      samples: [
        ...(state.chargingPerformance?.samples ?? []),
        { at: now.toISOString(), batteryChargingW, houseDemandW, gridImportW },
      ],
    });
  }
  return true;
}

function finalizeAdaptiveChargeSession(state, reason, now = new Date()) {
  const active = state.activeChargeSession;
  if (!active) return null;
  const deliveredWh = Math.max(0, Math.round(Number(state.activeChargedKwh) * 1000));
  const startSocPercent = finiteNumberOrNull(active.startSocPercent);
  const endSocPercent = finiteNumberOrNull(active.latestSocPercent);
  const socDeltaPercent = Number.isFinite(startSocPercent) && Number.isFinite(endSocPercent)
    ? Math.max(0, endSocPercent - startSocPercent)
    : null;
  const durationHours = Math.max(0, (now.getTime() - new Date(active.startedAt).getTime()) / 3_600_000);
  const averageChargeWatts = durationHours > 0 ? deliveredWh / durationHours : null;
  const capacityKwh = finiteNumberOrNull(active.capacityKwh);
  const estimatedStoredWh = Number.isFinite(capacityKwh) && Number.isFinite(socDeltaPercent)
    ? capacityKwh * 1000 * socDeltaPercent / 100
    : null;
  const estimatedStorageEfficiencyPercent = deliveredWh >= 100 && Number.isFinite(estimatedStoredWh)
    ? estimatedStoredWh / deliveredWh * 100
    : null;
  const session = {
    startedAt: active.startedAt,
    endedAt: now.toISOString(),
    reason,
    requestedWh: active.requestedWh,
    deliveredWh,
    startSocPercent: Number.isFinite(startSocPercent) ? startSocPercent : null,
    endSocPercent: Number.isFinite(endSocPercent) ? endSocPercent : null,
    socDeltaPercent,
    averageChargeWatts,
    estimatedStorageEfficiencyPercent,
  };
  state.chargingPerformance = cleanAdaptiveChargingPerformance({
    ...state.chargingPerformance,
    sessions: [...(state.chargingPerformance?.sessions ?? []), session],
  });
  if (state.activeWindowExecution) {
    state.activeWindowExecution.deliveredWh += deliveredWh;
    state.activeWindowExecution.latestSocPercent = endSocPercent;
    state.activeWindowExecution.updatedAt = now.toISOString();
  }
  state.activeChargeSession = null;
  return session;
}

async function releaseAdaptiveCharge(state, reason, now = new Date(), batteryHost = null) {
  if (state.owner !== "adaptiveCharging") return false;
  await executeAction("set-mode", { mode: "auto", ...(batteryHost ? { host: batteryHost } : {}) });
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
  state,
  reason,
  now = new Date(),
  batteryHost = null,
  execute = executeAction,
  holdUntil = null,
) {
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

async function executeAdaptiveChargeStart(slot, { resumeFromStandby = false, execute = executeAction } = {}) {
  if (resumeFromStandby) await execute("set-mode", { mode: "auto" });
  try {
    return await execute("charge", { targetWh: slot.targetWh });
  } catch (error) {
    if (resumeFromStandby) {
      try {
        await execute("set-mode", { mode: "standby" });
      } catch (standbyError) {
        throw new Error(
          `${error.message}; failed to return battery to Standby: ${standbyError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function adaptiveChargingSlotEndKey(state) {
  if (state?.owner !== "adaptiveCharging" || !state.activeSlot) return null;
  const endMs = new Date(state.activeSlot.end).getTime();
  if (!Number.isFinite(endMs)) return null;
  return JSON.stringify([
    state.activeSlot.start ?? null,
    state.activeSlot.end,
    state.activePlanCreatedAt ?? null,
  ]);
}

function adaptiveChargingSlotEndDelayMs(state, now = new Date()) {
  if (!adaptiveChargingSlotEndKey(state)) return null;
  return Math.max(0, new Date(state.activeSlot.end).getTime() - now.getTime());
}

async function enforceAdaptiveChargingSlotEndDeadline(expectedKey, {
  now = new Date(),
  readState = readAdaptiveChargingState,
  release = releaseAdaptiveCharge,
  suspend = suspendAdaptiveChargeInStandby,
  writeState = writeAdaptiveChargingState,
} = {}) {
  const state = await readState();
  if (adaptiveChargingSlotEndKey(state) !== expectedKey) {
    return { stopped: false, reason: "active adaptiveCharging slot changed" };
  }
  const remainingMs = adaptiveChargingSlotEndDelayMs(state, now);
  if (remainingMs > 0) return { stopped: false, remainingMs };
  const windowEndMs = new Date(state.activeSlot?.windowEnd).getTime();
  const slotEndMs = new Date(state.activeSlot?.end).getTime();
  const windowEnded = Number.isFinite(windowEndMs) && Number.isFinite(slotEndMs) && slotEndMs >= windowEndMs;
  const reason = windowEnded ? "Planned discounted window ended" : "Planned charging slot ended";
  if (windowEnded) await release(state, reason, now);
  else await suspend(state, reason, now, null, undefined, state.activeSlot?.windowEnd);
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

function clearAdaptiveChargingSlotEndTimer() {
  if (adaptiveChargingSlotEndTimer) clearTimeout(adaptiveChargingSlotEndTimer);
  adaptiveChargingSlotEndTimer = null;
  adaptiveChargingSlotEndTimerKey = null;
}

function armAdaptiveChargingSlotEndTimer(key, delayMs) {
  adaptiveChargingSlotEndTimerKey = key;
  adaptiveChargingSlotEndTimer = setTimeout(() => {
    adaptiveChargingSlotEndTimer = null;
    adaptiveChargingSlotEndTimerKey = null;
    enforceAdaptiveChargingSlotEndDeadline(key)
      .then((result) => {
        if (Number.isFinite(result.remainingMs) && result.remainingMs > 0) {
          armAdaptiveChargingSlotEndTimer(key, Math.min(result.remainingMs, MAX_TIMER_DELAY_MS));
        }
      })
      .catch((err) => {
        logDetailedError("adaptive-charging-slot-end", err);
        armAdaptiveChargingSlotEndTimer(key, ADAPTIVE_CHARGING_SLOT_END_RETRY_MS);
      });
  }, Math.max(0, Math.min(delayMs, MAX_TIMER_DELAY_MS)));
  if (typeof adaptiveChargingSlotEndTimer.unref === "function") adaptiveChargingSlotEndTimer.unref();
}

function syncAdaptiveChargingSlotEndTimer(state, now = new Date()) {
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

function adaptiveChargingSlotAt(plan, now = new Date()) {
  const time = now.getTime();
  return (plan?.slots ?? []).find((slot) => new Date(slot.start).getTime() <= time && time < new Date(slot.end).getTime()) ?? null;
}

function capAdaptiveChargingSlotToRemainingTime(slot, maximumChargeWatts, now = new Date()) {
  const endMs = new Date(slot?.end).getTime();
  const nowMs = now.getTime();
  const maximumWatts = Number(maximumChargeWatts);
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

function adaptiveChargingSlotIdentity(slot) {
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

function adaptiveChargingSlotsMatch(left, right) {
  if (left?.slotId && right?.slotId) return left.slotId === right.slotId;
  const leftIdentity = adaptiveChargingSlotIdentity(left);
  const rightIdentity = adaptiveChargingSlotIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

function consumeCompletedAdaptiveChargingSlot(plan, completedSlot) {
  if (!plan || !completedSlot) return plan;
  let removedWh = 0;
  const slots = (plan.slots ?? []).filter((slot) => {
    if (!adaptiveChargingSlotsMatch(slot, completedSlot)) return true;
    removedWh += Math.max(0, Math.round(Number(slot.targetWh) || 0));
    return false;
  });
  if (!removedWh) return plan;
  const storageEfficiency = Math.min(
    1,
    Math.max(0.5, Number(plan.chargePerformance?.storageEfficiency?.fraction) || 1),
  );
  const removedStoredKwh = removedWh / 1000 * storageEfficiency;
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
    windows: (plan.windows ?? []).map((window) => (
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

function preserveInterruptedAdaptiveCharge(state, now = new Date()) {
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
      slots: (state.plan.slots ?? []).flatMap((slot) => {
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

function applyInterruptedChargeCap(plan, interruption, maximumChargeWatts, now = new Date()) {
  if (!plan || !interruption) return { plan, interruption: null };
  const interruptedEnd = new Date(interruption.slotEnd).getTime();
  if (!Number.isFinite(interruptedEnd) || interruptedEnd <= now.getTime()) {
    return { plan, interruption: null };
  }
  const remainingWh = Math.max(0, Math.round(Number(interruption.remainingWh) || 0));
  const maximumWatts = Number(maximumChargeWatts);
  let matched = false;
  const slots = (plan.slots ?? []).map((slot) => {
    const sameSlot = interruption.slotId && slot.slotId
      ? interruption.slotId === slot.slotId
      : new Date(slot.end).getTime() === interruptedEnd;
    if (!sameSlot) return slot;
    matched = true;
    const targetWh = Math.min(Math.max(0, Math.round(Number(slot.targetWh) || 0)), remainingWh);
    if (!targetWh) return null;
    const endMs = new Date(slot.end).getTime();
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

function adaptiveChargingBreakerSettings(rules = []) {
  const guardRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.type === "backup-demand-guard");
  const preferredRules = guardRules.some((rule) => rule.enabled)
    ? guardRules.filter((rule) => rule.enabled)
    : guardRules;
  const configuredGuards = preferredRules
    .map((rule) => {
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
    .filter((settings) => Number.isFinite(settings.breakerLimitW) && settings.breakerLimitW > 0)
    .sort((left, right) => left.breakerLimitW - right.breakerLimitW);
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

function adaptiveChargingLiveChargeHeadroom(status, config, state = {}, rules = []) {
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

function beginAdaptiveChargingBreakerRecovery(state, headroom, now = new Date()) {
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

function advanceAdaptiveChargingBreakerRecovery(state, headroom, now = new Date()) {
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

function adaptiveChargingBreakerRecoveryReady(state, now = new Date()) {
  const recovery = state?.breakerRecovery;
  if (!recovery) return false;
  const cooldownUntilMs = new Date(recovery.cooldownUntil).getTime();
  return Number.isFinite(cooldownUntilMs)
    && now.getTime() >= cooldownUntilMs
    && Number(recovery.consecutiveSafeChecks) >= ADAPTIVE_CHARGING_BREAKER_SAFE_CHECKS;
}

function shouldHoldGuardStandbyForAdaptiveCharging(state, now = new Date()) {
  const slotEndMs = new Date(state?.interruptedCharge?.slotEnd ?? 0).getTime();
  return Number.isFinite(slotEndMs)
    && slotEndMs > now.getTime()
    && !adaptiveChargingBreakerRecoveryReady(state, now);
}

function logAdaptiveChargingBreakerWait(state, headroom, recoveryStatus, now = new Date()) {
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

function logAdaptiveChargingInitialHeadroomWait(state, headroom, now = new Date()) {
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
    .every((value) => Number.isFinite(Number(value)))
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

function adaptiveChargingLiveImportSafety(status, rules = []) {
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

function activeAdaptiveChargingSlotStopReason(state, config, plan, now = new Date()) {
  if (state.owner !== "adaptiveCharging") return null;
  if (!explicitDiscountedBand(config, now)) return "Current rate is no longer discounted";
  const replacement = adaptiveChargingSlotAt(plan, now);
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

function adaptiveChargingScheduledEvent(config, now = new Date()) {
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
    .find((occurrence) => new Date(occurrence.start).getTime() > now.getTime());
  if (!upcomingWindow) return { upcomingWindow: null };
  const timeUntilStartMs = new Date(upcomingWindow.start).getTime() - now.getTime();
  if (timeUntilStartMs > ADAPTIVE_CHARGING_PREWINDOW_MS) return { upcomingWindow };
  return {
    eventKey: `prewindow:${upcomingWindow.key}`,
    trigger: `30 minutes before ${upcomingWindow.band.label || "discounted window"}`,
    upcomingWindow,
  };
}

function adaptiveChargingPlanRefreshDecision(state, config, now = new Date()) {
  const forecastFetchedAt = state.forecast?.fetchedAt ?? null;
  const scheduledEvent = adaptiveChargingScheduledEvent(config, now);
  if (state.pendingPlanReason) {
    return {
      ...scheduledEvent,
      refresh: true,
      trigger: state.pendingPlanReason,
      eventKey: `pending:${state.pendingPlanReason}:${state.updatedAt ?? now.toISOString()}`,
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

function adaptiveChargingClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function adaptiveChargingPlanLogMessage(plan, trigger, liveSoc) {
  if (!plan?.available) return `Plan recalculated (${trigger}); adaptiveCharging unavailable: ${plan?.reason || "unknown reason"}`;
  const targets = (plan.windows ?? [])
    .map((window) => `${window.label} ${Number(window.targetSocPercent).toFixed(0)}%/${Number(window.plannedChargeKwh).toFixed(2)} kWh`)
    .join(", ") || "none";
  const slots = (plan.slots ?? [])
    .map((slot) => `${adaptiveChargingClock(slot.start)}-${adaptiveChargingClock(slot.end)} ${slot.targetWh} Wh`)
    .join(", ") || "none";
  const awaySummary = Number(plan.demandHistory?.awaySlotCount) > 0
    ? `; away demand ${plan.demandHistory.awayConfidence} (${plan.demandHistory.awayComparableDayCount} comparable days, ${plan.demandHistory.awayFallbackSlotCount} fallback slots)`
    : "";
  return `Plan recalculated (${trigger}): SOC ${Number(liveSoc).toFixed(0)}%; ${Number(plan.predictedSolarKwh).toFixed(2)} kWh solar, ${Number(plan.predictedDemandKwh).toFixed(2)} kWh demand, ${Number(plan.plannedChargeKwh).toFixed(2)} kWh discounted charging; targets [${targets}]; slots [${slots}]${awaySummary}${plan.warning ? `; ${plan.warning}` : ""}`;
}

async function evaluateAdaptiveCharging(config, status, rules, now = new Date()) {
  let state = await readAdaptiveChargingState();
  const awayPeriods = historyStore.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
  const activeAway = awayPeriods.find((period) => period.status === "active") ?? null;
  const awayStateKey = activeAway ? `away:${activeAway.id}:${activeAway.until}` : "home";
  if (state.lastAwayStateKey === null && !activeAway) {
    state.lastAwayStateKey = awayStateKey;
  } else if (state.lastAwayStateKey !== awayStateKey) {
    state.pendingPlanReason = activeAway ? "Away period started" : "Away period ended";
    state.lastPlanEventKey = null;
    state.lastAwayStateKey = awayStateKey;
  }
  recordAdaptiveChargeSample(state, status, now);
  if (state.interruptedCharge
    && new Date(state.interruptedCharge.slotEnd).getTime() <= now.getTime()) {
    state.interruptedCharge = null;
    state.breakerRecovery = null;
  }
  const paused = state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime();
  const guardActive = rules.some((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
  const standbyHoldUntilMs = new Date(state.standbyHoldUntil).getTime();
  if (state.standbyHoldUntil
    && (!Number.isFinite(standbyHoldUntilMs) || standbyHoldUntilMs <= now.getTime())
    && !guardActive) {
    await executeAction("set-mode", { mode: "auto" });
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
  ].filter(([value]) => !Number.isFinite(value)).map(([, label]) => label);
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
    const historicalDemandDays = await readAdaptiveChargingDemandProfileDays();
    state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
    state.lastPlanEventKey = refreshDecision.eventKey;
    state.pendingPlanReason = null;
    if (activeDiscountedWindow) state.lastRebasedWindowKey = activeDiscountedWindow.key;
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
  const gridExportW = numericMetric(status.meter?.grid_export_power);
  const liveExportNeedsHeadroom = Number.isFinite(gridExportW) && gridExportW > 50;
  if (liveExportNeedsHeadroom && state.standbyHoldUntil) {
    await executeAction("set-mode", { mode: "auto" });
    appendAdaptiveChargingLog(
      state,
      "Live grid export indicates solar needs battery headroom; releasing Standby hold and restoring operation mode to Auto",
      "stop",
      now,
    );
    state.standbyHoldUntil = null;
  }
  if (state.solarHeadroomHoldUntil && new Date(state.solarHeadroomHoldUntil).getTime() <= now.getTime()) {
    state.solarHeadroomHoldUntil = null;
  }
  const activeTargetKwh = Number(state.activeSlot?.targetWh ?? 0) / 1000;
  const activeTargetSocPercent = Number(state.activeSlot?.targetSocPercent ?? config.adaptiveCharging.targetSocPercent);
  const activeExpired = state.activeSlot && now.getTime() >= new Date(state.activeSlot.end).getTime();
  const activePlanStopReason = activeAdaptiveChargingSlotStopReason(state, config, state.plan, now);
  const liveImportSafety = adaptiveChargingLiveImportSafety(status, rules);
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
    if (activeExpired) stopReason = "Planned discounted window ended";
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
    else if (liveExportNeedsHeadroom) stopReason = "Live grid export indicates solar needs battery headroom";
    if (liveExportNeedsHeadroom && state.activeSlot?.windowEnd) {
      state.solarHeadroomHoldUntil = state.activeSlot.windowEnd;
    }
    const completedWindowEndMs = new Date(completedSlot?.windowEnd).getTime();
    const holdStandbyUntilWindowEnd = Boolean(
      activeDiscountedWindow
      && !liveExportNeedsHeadroom
      && Number.isFinite(completedWindowEndMs)
      && completedWindowEndMs > now.getTime(),
    );
    if (breakerReserveInterrupted) {
      await suspendAdaptiveChargeInStandby(state, stopReason, now);
    } else if (holdStandbyUntilWindowEnd) {
      await suspendAdaptiveChargeInStandby(
        state,
        stopReason,
        now,
        null,
        executeAction,
        completedSlot.windowEnd,
      );
    } else {
      await releaseAdaptiveCharge(state, stopReason, now);
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

  const plannedSlot = explicitDiscountedBand(config, now) ? adaptiveChargingSlotAt(state.plan, now) : null;
  const slot = plannedSlot ? capAdaptiveChargingSlotToRemainingTime(
    plannedSlot,
    state.plan.chargePerformance?.effectiveWatts ?? config.batteryCapabilities.maximumChargeWatts,
    now,
  ) : null;
  if (liveExportNeedsHeadroom && slot?.windowEnd) state.solarHeadroomHoldUntil = slot.windowEnd;
  const solarHeadroomHoldActive = Boolean(
    state.solarHeadroomHoldUntil && new Date(state.solarHeadroomHoldUntil).getTime() > now.getTime(),
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
    } catch (error) {
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
    state.activeSlot = slot;
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

function observeAdaptiveChargingNotifications(config, adaptiveChargingState) {
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
  if (summary?.unmetWh >= 50) {
    notificationService.enqueue({
      type: "adaptiveChargingWindowShortfall",
      severity: "warning",
      title: "Discounted charging window ended with a shortfall",
      message: `${summary.label || "Discounted window"} planned ${summary.plannedWh} Wh and delivered ${summary.deliveredWh} Wh, leaving ${summary.unmetWh} Wh unmet. Breaker interruptions: ${summary.interruptionCount}. SOC: ${summary.startSocPercent ?? "--"}% to ${summary.endSocPercent ?? "--"}%.`,
      occurredAt: summary.completedAt,
      dedupeKey: `adaptive-charging-window:${summary.key}`,
      once: true,
    });
  }
}

async function runAutomationRules(context = {}) {
  const startedAt = new Date();
  context.startedAt = startedAt.toISOString();
  context.phase = "loading automation rules";
  const config = await readConfig();
  const rules = await readAutomationRules();
  const enabledRules = rules.filter((rule) => rule.enabled);
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
  const cliSequenceStart = cliTimingSequence;
  const probeTimings = [];
  const status = await readAllStatus((probe) => {
    probeTimings.push(probe);
    context.statusProbeCompletionLatency = probeTimings.map(
      ({ label, durationMs }) => `${label}=${durationMs}ms`,
    );
  });
  const statusReadDurationMs = Date.now() - statusReadStartedAt;
  if (statusReadDurationMs > AUTOMATION_CHECK_INTERVAL_MS) {
    const cliProbes = recentCliTimings
      .filter(({ sequence }) => sequence > cliSequenceStart)
      .map(({ command, host, durationMs }) => `${command}${host ? ` on ${host}` : ""}=${durationMs}ms`)
      .join(", ");
    console.warn(
      `automation: device status read for ${automationRuleList(enabledRules)} took ${statusReadDurationMs}ms, longer than ${AUTOMATION_CHECK_INTERVAL_MS}ms interval; CLI probe durations: ${cliProbes || "none"}`,
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
      const result = await evaluateAutomationRule(rule, status, now, (phase) => {
        context.phase = `${phase} for ${ruleLabel}`;
      }, config, {
        holdStandbyForAdaptiveCharging: adaptiveChargingEnabled
          && shouldHoldGuardStandbyForAdaptiveCharging(adaptiveChargingCoordinationState, now),
      });
      const checkFinishedAt = new Date();
      const checkMeta = {
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
    } catch (err) {
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

async function runAutomationRulesScheduled() {
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
      `automation: previous check still running${duration}; current phase: ${phase}; active CLI probe: ${activeCliLabel(activeCliContext)}; enabled rules: ${rules}; skipping this scheduled interval`,
    );
    return;
  }
  automationRunInProgress = true;
  automationRunContext = {};
  try {
    await runAutomationRules(automationRunContext);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    error.automationContext = { ...automationRunContext };
    throw error;
  } finally {
    automationRunInProgress = false;
    automationRunContext = null;
  }
}

function inferDevice(instances) {
  const set = new Set(instances.map((item) => String(item).toLowerCase().slice(0, 4)));
  const roles = [];
  if (set.has("027d")) roles.push("Battery");
  if (set.has("0279")) roles.push("Solar generation");
  if (set.has("0287")) roles.push("Smart Cosmo / home power meter");
  if (set.has("027c")) roles.push("Ene-Farm");
  if (set.has("0272")) roles.push("Water heater");
  if ([...set].some((item) => item.startsWith("0f"))) roles.push("Controller");
  return roles.length ? roles : ["Unknown energy device"];
}

function subnetFromHost(host) {
  const match = String(host ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}.0/24` : null;
}

function localNetworkHints(config) {
  const hosts = [
    config.batteryHost,
    config.meterHost,
    config.solarHost,
    ...config.fuelCellHosts,
  ].filter(Boolean);
  const configuredSubnets = [...new Set(hosts.map(subnetFromHost).filter(Boolean))];
  const containerSubnets = [];
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

function ipRangeFromCidr(cidr) {
  const match = String(cidr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  if (!match) return [];
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instanceListRequest(tid) {
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

function propertyRequest(tid, eojHexText, epcHexText) {
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

function parseInstanceListResponse(msg) {
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
    const instances = [];
    for (let pos = 1; pos + 2 < edt.length && instances.length < count; pos += 3) {
      instances.push(edt.slice(pos, pos + 3).toString("hex"));
    }
    return { tid, instances };
  }
  return null;
}

function parseTid(msg) {
  return msg.length >= 4 && msg[0] === 0x10 && msg[1] === 0x81
    ? msg.readUInt16BE(2)
    : null;
}

function isGetResponse(msg) {
  return msg.length >= 14 && msg[0] === 0x10 && msg[1] === 0x81 && msg[10] === 0x72;
}

function addDiscoveredInstance(found, host, instance) {
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

function mergeDiscoveredDevices(...deviceSets) {
  const merged = {};
  for (const devices of deviceSets) {
    for (const [host, device] of Object.entries(devices ?? {})) {
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

async function activeScanSubnets(subnets, timeoutMs, progress = () => {}) {
  // Broadcast discovery is polite but not always reliable through controllers or
  // Docker networking, so this scan pokes each /24 address directly. It binds an
  // ephemeral source port instead of ECHONET's 3610 so it can run even if another
  // local reader has recently held the standard port.
  const socket = dgram.createSocket("udp4");
  const tidToHost = new Map();
  const tidToDirectProbe = new Map();
  const found = {};
  let tid = 1;
  const hosts = [...new Set(subnets.flatMap(ipRangeFromCidr))];
  let scanned = 0;
  const retryRounds = 3;
  const batchSize = 16;

  await new Promise((resolve, reject) => {
    const bindEphemeral = () => {
      socket.removeAllListeners("error");
      socket.once("error", reject);
      socket.bind(0, "0.0.0.0", resolve);
    };
    socket.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        bindEphemeral();
      } else {
        reject(err);
      }
    });
    socket.bind(3610, "0.0.0.0", resolve);
  });

  socket.on("message", (msg, rinfo) => {
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
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  socket.close();
  return found;
}

const KNOWN_DISCOVERY_PROBES = [
  { eoj: "0x027D01", epcs: ["0xE4", "0xDA"] },
  { eoj: "0x027901", epcs: ["0xE0"] },
  { eoj: "0x028701", epcs: ["0xC6", "0xB7"] },
  { eoj: "0x027C01", epcs: ["0xC4", "0xCB"] },
];

function configuredDiscoveryHosts(config) {
  return [
    config.batteryHost,
    config.smartCosmoEnabled ? config.meterHost : null,
    config.solarEnabled ? config.solarHost : null,
    ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
  ].filter((host) => host && !isDocumentationHost(host));
}

async function enrichDiscoveredDevices(devices, config, progress = () => {}) {
  const hosts = [...new Set([...Object.keys(devices), ...configuredDiscoveryHosts(config)])];
  if (!hosts.length) return devices;
  const enriched = mergeDiscoveredDevices(devices);
  let scanned = 0;
  progress({ phase: "identifying", total: hosts.length, scanned: 0, found: Object.keys(enriched).length });
  for (const host of hosts) {
    const instances = [];
    for (const probe of KNOWN_DISCOVERY_PROBES) {
      const eoj = probe.eoj;
      let detected = false;
      try {
        const result = await runCliQueued("inspect-host", { host, eoj, timeout: 2 });
        const entry = result?.[eoj.toLowerCase()];
        detected = entry && !entry.error;
      } catch {
        // Silent hosts are normal during subnet discovery.
      }
      for (const epc of probe.epcs) {
        if (detected) break;
        try {
          const result = await runCliQueued("raw-get", { host, eoj, timeout: 2 }, [epc]);
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

function suggestedConfigFromDiscovery(devices, currentConfig) {
  const next = { ...currentConfig };
  const fuelCellHosts = new Set(next.fuelCellHosts);
  for (const [host, device] of Object.entries(devices)) {
    const instances = device.all_instances ?? [];
    if (instances.some((item) => item.toLowerCase().startsWith("027d"))) next.batteryHost = host;
    if (instances.some((item) => item.toLowerCase().startsWith("0279"))) {
      next.solarHost = host;
      next.solarEnabled = true;
    }
    if (instances.some((item) => item.toLowerCase().startsWith("0287"))) {
      next.meterHost = host;
      next.smartCosmoEnabled = true;
    }
    if (instances.some((item) => item.toLowerCase().startsWith("027c"))) {
      fuelCellHosts.add(host);
      next.fuelCellEnabled = true;
    }
  }
  next.fuelCellHosts = [...fuelCellHosts];
  return cleanConfig(next);
}

function discoveryResult(devices, network, config) {
  const discovered = Object.entries(devices).map(([host, device]) => ({
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

async function discoverDevices(timeout = 5, mode = "broadcast", progress = () => {}, requestedSubnets = []) {
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
      (patch) => progress({ ...patch, network }),
    );
    const devices = await enrichDiscoveredDevices(
      activeDevices,
      config,
      (patch) => progress({ ...patch, network }),
    );
    return discoveryResult(devices, network, config);
  }

  const activeDevices = await activeScanSubnets(
    subnets,
    Math.max(1000, scanTimeout * 1000),
    (patch) => progress({ ...patch, network }),
  );
  progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(activeDevices).length, network });
  const broadcastDevices = await runCliQueued("discover", { timeout: scanTimeout });
  progress({ phase: "broadcast", total: 0, scanned: 0, found: Object.keys(mergeDiscoveredDevices(activeDevices, broadcastDevices)).length, network });
  const devices = await enrichDiscoveredDevices(
    mergeDiscoveredDevices(activeDevices, broadcastDevices),
    config,
    (patch) => progress({ ...patch, network }),
  );
  return discoveryResult(devices, network, config);
}

function discoveryJobView(job) {
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

function cleanupDiscoveryJobs() {
  const cutoff = Date.now() - DISCOVERY_JOB_TTL_MS;
  for (const [id, job] of discoveryJobs) {
    if (new Date(job.updatedAt).getTime() < cutoff) discoveryJobs.delete(id);
  }
}

function updateDiscoveryJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function discoveryInProgress() {
  return discoveryRunContext !== null;
}

async function withDiscoveryRun(label, fn) {
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

function startDiscoveryJob(timeout, mode = "broadcast", subnets = []) {
  cleanupDiscoveryJobs();
  const job = {
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
    discoverDevices(timeout, mode, (patch) => updateDiscoveryJob(job, patch), subnets),
  )
    .then((result) => {
      updateDiscoveryJob(job, {
        status: "complete",
        phase: "complete",
        found: result.discovered.length,
        result,
      });
    })
    .catch((err) => {
      updateDiscoveryJob(job, {
        status: "failed",
        phase: "failed",
        error: err.message,
      });
    });
  return discoveryJobView(job);
}

function startScheduler() {
  scheduleTimer = setInterval(() => {
    runDueSchedules().catch((err) => logDetailedError("scheduler", err));
  }, 15000);
  automationTimer = setInterval(() => {
    runAutomationRulesScheduled().catch((err) => logDetailedError("automation", err));
  }, AUTOMATION_CHECK_INTERVAL_MS);
  runDueSchedules().catch((err) => logDetailedError("scheduler", err));
  runAutomationRulesScheduled().catch((err) => logDetailedError("automation", err));
}

function anyDeviceConfigured(config) {
  // A real device is any host that isn't blank or one of the placeholder
  // documentation addresses shipped in DEFAULT_CONFIG.
  const hosts = [
    config.batteryHost,
    config.smartCosmoEnabled ? config.meterHost : null,
    config.solarEnabled ? config.solarHost : null,
    ...(config.fuelCellEnabled ? config.fuelCellHosts ?? [] : []),
  ];
  return hosts.some((host) => host && !isDocumentationHost(host));
}

function startBackgroundRecorder() {
  // History is only useful if it is captured continuously, so the server polls
  // devices on its own cadence instead of relying on an open browser tab to
  // drive /api/status. readAllStatus() records one sample per call. A recursive
  // timer (rescheduled after each read completes) guarantees reads never
  // overlap, even if one takes longer than the configured interval.
  const scheduleNext = (intervalMs) => {
    recorderTimer = setTimeout(tick, intervalMs);
    if (typeof recorderTimer.unref === "function") recorderTimer.unref();
  };
  async function tick() {
    let intervalMs = DEFAULT_CONFIG.updateIntervalSeconds * 1000;
    try {
      const config = await readConfig();
      intervalMs =
        Math.max(5, configNumber(config.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 5, 3600)) * 1000;
      if (discoveryInProgress()) {
        console.warn(`recorder: discovery is running (${discoveryRunContext.label}); skipping this poll`);
      } else if (anyDeviceConfigured(config)) {
        const status = await readAllStatus();
        observeDeviceNotifications(status, config);
        observeBatterySocNotifications(status, config);
      }
    } catch (err) {
      logDetailedError("recorder", err);
    } finally {
      scheduleNext(intervalMs);
    }
  }
  tick();
}

async function api(req, res, url) {
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
    return json(res, 200, await notificationService.sendTest());
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await readConfig()), port: PORT });
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
  if (req.method === "POST" && url.pathname === "/api/discovery") {
    const body = await readBody(req);
    return json(
      res,
      200,
      await withDiscoveryRun(`${body.mode ?? "broadcast"} discovery`, () =>
        discoverDevices(body.timeout, body.mode, () => {}, body.subnets),
      ),
    );
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
      return json(res, 409, {
        error: `discovery is running (${discoveryRunContext.label}); status polling is paused`,
      });
    }
    return json(res, 200, await readAllStatus());
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    const config = await readConfig();
    return json(res, 200, await readHistoryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
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
      const updated = {
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
      const updated = { ...existing, until: until.toISOString(), updatedAt: now.toISOString() };
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
    const historicalDemandDays = await readAdaptiveChargingDemandProfileDays();
    const awayPeriods = historyStore.awayPeriods({ includeCompleted: true, nowMs: now.getTime() });
    state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
    state.lastPlanEventKey = adaptiveChargingScheduledEvent(config, now).eventKey ?? `manual:${now.toISOString()}`;
    state.pendingPlanReason = null;
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
    const config = await readConfig();
    const rules = await readAutomationRules();
    return json(res, 200, adaptiveChargingView(config, await resumeAdaptiveCharging(), rules));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/settings/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/settings/", "");
    await pauseAdaptiveChargingForManualAction(action);
    return json(res, 200, await executeAction(action, body));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/actions/", "");
    await pauseAdaptiveChargingForManualAction(action);
    return json(res, 200, await executeAction(action, body));
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
    const index = rules.findIndex((item) => item.id === id);
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
    const next = rules.filter((item) => item.id !== id);
    await writeAutomationRules(next);
    await writeAutomationRuleStates(next);
    return json(res, 200, { ok: next.length !== rules.length });
  }
  if (req.method === "POST" && url.pathname === "/api/schedules") {
    if (adaptiveChargingConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
    }
    const body = await readBody(req);
    const schedule = {
      id: randomUUID(),
      name: String(body.name || body.action || "Battery setting change"),
      action: String(body.action || ""),
      payload: body.payload || {},
      repeat: body.repeat === "daily" ? "daily" : "once",
      days: Array.isArray(body.days) && body.days.length ? body.days.map(Number).filter((day) => day >= 0 && day <= 6) : ALL_DAYS,
      time: body.time || undefined,
      runAt: body.runAt || undefined,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
      lastResult: null,
    };
    schedule.runAt = parseRunAt(schedule);
    const schedules = await readSchedules();
    schedules.push(schedule);
    await writeSchedules(schedules);
    return json(res, 201, schedule);
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/schedules/")) {
    if (adaptiveChargingConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
    }
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const schedules = await readSchedules();
    const schedule = schedules.find((item) => item.id === id);
    if (!schedule) return json(res, 404, { error: "schedule not found" });
    Object.assign(schedule, body);
    if ("runAt" in body || "time" in body || "repeat" in body) schedule.runAt = parseRunAt(schedule);
    await writeSchedules(schedules);
    return json(res, 200, schedule);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
    const id = url.pathname.split("/").pop();
    const schedules = await readSchedules();
    const next = schedules.filter((item) => item.id !== id);
    await writeSchedules(next);
    return json(res, 200, { ok: next.length !== schedules.length });
  }
  return json(res, 404, { error: "not found" });
}

async function serveStatic(res, pathname) {
  const filePath = path.join(__dirname, "public", pathname === "/" ? "index.html" : pathname);
  const resolved = path.resolve(filePath);
  const publicDir = path.resolve(__dirname, "public");
  if (!resolved.startsWith(publicDir)) return text(res, 403, "Forbidden");
  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved);
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      "application/octet-stream";
    text(res, 200, data, type);
  } catch {
    text(res, 404, "Not found");
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await api(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (status >= 500) logDetailedError("api", err);
    json(res, status, { error: err.message });
  }
});

export {
  activeAdaptiveChargingSlotStopReason,
  advanceAdaptiveChargingBreakerRecovery,
  aggregateDemandDays,
  applySolarForecastBias,
  applyInterruptedChargeCap,
  aggregateEnergyReportSamples,
  beginAdaptiveChargingBreakerRecovery,
  buildAdaptiveChargingPlan,
  buildAdaptiveChargingTimelineView,
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
  effectiveAdaptiveChargeStorageEfficiency,
  effectiveAdaptiveChargeWatts,
  executeAdaptiveChargeStart,
  evaluateAutomationRule,
  estimateEffectiveBatteryCapacity,
  finalizeAdaptiveChargeSession,
  finalizeAdaptiveChargingWindowExecution,
  forecastHourForInterval,
  forecastIsFresh,
  learnedSolarFactor,
  migrateLegacyAdaptiveChargingData,
  logAdaptiveChargingInitialHeadroomWait,
  logAdaptiveChargingBreakerWait,
  normalizeCircuitLabels,
  normalizeDashboardWidgets,
  normalizeNotificationConfig,
  normalizeRateBands,
  normalizeSubnets,
  nextPlanningBoundary,
  optimizeDiscountedChargeSlots,
  parseJsonWithContext,
  parseOpenMeteoForecast,
  planChronologicalDiscountedCharging,
  enforceAdaptiveChargingSlotEndDeadline,
  adaptiveChargingLiveChargeHeadroom,
  adaptiveChargingLiveImportSafety,
  adaptiveChargingBreakerSettings,
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
  readRecentHistorySamples,
  readAdaptiveChargingDemandProfileDays,
  recoverConcatenatedJsonValue,
  sampleFromStatus,
  shouldTriggerDemandGuard,
  shouldHoldGuardStandbyForAdaptiveCharging,
  adaptiveChargingPlanRefreshDecision,
  adaptiveChargingPlanLogMessage,
  preserveInterruptedAdaptiveCharge,
  recordAdaptiveChargingWindowInterruption,
  adaptiveChargingAvailability,
  adaptiveChargingBaseAvailability,
  solarPowerFromIrradiance,
  summarizeSamples,
  suspendAdaptiveChargeInStandby,
  summarizeCircuits,
  syncAdaptiveChargingWindowExecution,
  predictHouseDemand,
};

async function main() {
  await ensureDataDir();
  await migrateLegacyAdaptiveChargingData();
  await historyStore.initialize();
  lastRecordedSample = historyStore.latestSample();
  await migrateBatteryCapabilitiesFromGuard();
  await writeAdaptiveChargingState(await readAdaptiveChargingState());
  await writeAutomationRuleStates(await readAutomationRules());
  const notificationHistory = await notificationService.view();
  for (const delivery of notificationHistory.deliveries) {
    const at = delivery.at ?? delivery.event?.occurredAt;
    historyStore.recordEvent({
      eventKey: `notification:legacy:${at}:${delivery.event?.dedupeKey ?? "delivery"}`,
      at,
      category: "notification",
      type: delivery.ok ? "delivered" : "failed",
      message: delivery.event?.message,
      payload: delivery,
    });
  }
  startScheduler();
  startBackgroundRecorder();
  const runRetention = async () => {
    try {
      const config = await readConfig();
      if (config.retention.automaticMaintenance) await trimHistory(config.retention);
    } catch (err) {
      logDetailedError("retention", err);
    }
  };
  retentionTimer = setInterval(runRetention, 24 * 60 * 60_000);
  retentionTimer.unref?.();
  void runRetention();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`HOME ENERGY & BATTERY listening on http://0.0.0.0:${PORT}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

process.on("SIGTERM", () => {
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (automationTimer) clearInterval(automationTimer);
  if (recorderTimer) clearTimeout(recorderTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  clearAdaptiveChargingSlotEndTimer();
  server.close(() => {
    historyStore.close();
    process.exit(0);
  });
});
