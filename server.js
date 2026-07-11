#!/usr/bin/env node
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
const AUTOMATION_RULES_FILE = path.join(DATA_DIR, "automation-rules.json");
const AUTOMATION_RULE_STATE_FILE = path.join(DATA_DIR, "automation-rule-state.json");
const SOLAR_PLANNER_STATE_FILE = path.join(DATA_DIR, "solar-planner-state.json");
const SOLAR_PLANNER_DIR = path.join(DATA_DIR, "solar-planner");
const SOLAR_FORECAST_HISTORY_FILE = path.join(SOLAR_PLANNER_DIR, "forecast-snapshots.jsonl");
const SOLAR_WEATHER_HISTORY_FILE = path.join(SOLAR_PLANNER_DIR, "historical-weather.jsonl");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_FILE = path.join(HISTORY_DIR, "samples.jsonl");
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 15000);
const CLI_FILE = "home-energy-battery-node.js";
const AUTOMATION_CHECK_INTERVAL_MS = 30_000;
const SOLAR_FORECAST_REFRESH_MS = 3 * 60 * 60_000;
const SOLAR_FORECAST_MAX_AGE_MS = 6 * 60 * 60_000;
const SOLAR_PLAN_REFRESH_MS = 30 * 60_000;

const DEFAULT_DASHBOARD_WIDGETS = [
  { id: "solarPower", group: "trends", visible: true, priority: 10 },
  { id: "fuelCellPower", group: "trends", visible: true, priority: 20 },
  { id: "houseDemandPower", group: "trends", visible: true, priority: 30 },
  { id: "batteryPower", group: "trends", visible: true, priority: 40 },
  { id: "batterySoc", group: "trends", visible: true, priority: 50 },
  { id: "gridImportPower", group: "trends", visible: true, priority: 60 },
  { id: "gridExportPower", group: "trends", visible: true, priority: 70 },
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
];

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
  historyRetentionDays: 1095,
  updateIntervalSeconds: 15,
  co2TonnesPerKwh: 0.000423,
  rateBands: [
    { start: "00:00", end: "00:00", yenPerKwh: 35, label: "Simple" },
  ],
  automation: {
    breakerVoltage: 100,
    breakerAmps: 40,
    reserveAmps: 5,
    enabledDefaults: false,
  },
  batteryCapabilities: {
    usableCapacityKwh: null,
    maximumChargeWatts: null,
  },
  solarPlanner: {
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
  dashboardWidgets: DEFAULT_DASHBOARD_WIDGETS,
  settingCache: {},
  language: "en",
};

let cliQueue = Promise.resolve();
let scheduleTimer = null;
let automationTimer = null;
let recorderTimer = null;
let automationRunInProgress = false;
let automationRunContext = null;
let discoveryRunContext = null;
let activeCliContext = null;
let cliTimingSequence = 0;
const recentCliTimings = [];
let lastRecordedSample = null;
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
  await mkdir(SOLAR_PLANNER_DIR, { recursive: true });
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

function parseHistorySamples(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim())
    .map(({ line, index }) => {
      try {
        return parseJsonWithContext(line, `${HISTORY_FILE}:line ${index + 1}`);
      } catch (err) {
        logDetailedError("history", err);
        return null;
      }
    })
    .filter(Boolean);
}

async function readHistorySamplesInRange(startMs, endMs) {
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

async function writeJsonFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

async function writeJsonLinesAtomic(file, rows) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(tmp, body + (rows.length ? "\n" : ""));
  await rename(tmp, file);
}

function cleanSolarPlannerState(value = {}) {
  return {
    forecast: value.forecast ?? null,
    plan: value.plan ?? null,
    owner: value.owner === "planner" ? "planner" : null,
    activeSlot: value.activeSlot ?? null,
    activeChargedKwh: Math.max(0, Number(value.activeChargedKwh) || 0),
    activeLastCheckedAt: value.activeLastCheckedAt ?? null,
    pausedUntil: value.pausedUntil ?? null,
    lastResult: value.lastResult ?? null,
    lastForecastError: value.lastForecastError ?? null,
    historicalWeatherFetchedAt: value.historicalWeatherFetchedAt ?? null,
    log: Array.isArray(value.log) ? value.log.slice(-200) : [],
    updatedAt: value.updatedAt ?? new Date().toISOString(),
  };
}

async function readSolarPlannerState() {
  await ensureDataDir();
  try {
    const text = await readFile(SOLAR_PLANNER_STATE_FILE, "utf8");
    let parsed;
    let recovered = null;
    try {
      parsed = parseJsonWithContext(text, SOLAR_PLANNER_STATE_FILE);
    } catch (err) {
      recovered = recoverConcatenatedJsonValue(text, (value) => value && typeof value === "object" && !Array.isArray(value));
      if (!recovered) throw err;
      logDetailedError("solar-planner-state", err);
      parsed = recovered.value;
    }
    const cleaned = cleanSolarPlannerState(parsed);
    if (recovered) await writeJsonFileAtomic(SOLAR_PLANNER_STATE_FILE, cleaned);
    return cleaned;
  } catch (err) {
    if (err.code === "ENOENT") return cleanSolarPlannerState();
    throw err;
  }
}

async function writeSolarPlannerState(state) {
  const cleaned = cleanSolarPlannerState({ ...state, updatedAt: new Date().toISOString() });
  await ensureDataDir();
  await writeJsonFileAtomic(SOLAR_PLANNER_STATE_FILE, cleaned);
  return cleaned;
}

function appendSolarPlannerLog(state, message, kind = "info", at = new Date()) {
  state.log = [
    ...(Array.isArray(state.log) ? state.log : []),
    { at: at.toISOString(), kind, message },
  ].slice(-200);
}

async function readJsonLinesFile(file) {
  try {
    const text = await readFile(file, "utf8");
    return parseHistorySamples(text);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
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
  const planner = config.solarPlanner;
  const endpoint = historical
    ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/jma";
  const params = new URLSearchParams({
    latitude: String(planner.latitude),
    longitude: String(planner.longitude),
    hourly: "shortwave_radiation,global_tilted_irradiance,cloud_cover,temperature_2m",
    timezone: "auto",
    tilt: String(planner.panelTiltDegrees),
    azimuth: String(planner.panelAzimuthDegrees),
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

function plannerTimezoneError(forecast) {
  const configuredTimezone = process.env.TZ;
  if (!configuredTimezone) return "container TZ must be configured before rate-band times can be aligned";
  if (!forecast?.timezone) return "forecast timezone is unavailable";
  return configuredTimezone === forecast.timezone
    ? null
    : `container timezone ${configuredTimezone} does not match forecast timezone ${forecast.timezone}`;
}

async function refreshSolarPlannerForecast(config, { fetchImpl = fetch, now = new Date(), forceHistorical = false } = {}) {
  let state = await readSolarPlannerState();
  try {
    const forecast = parseOpenMeteoForecast(await fetchJson(openMeteoUrl(config, false, now), fetchImpl), now);
    const timezoneError = plannerTimezoneError(forecast);
    if (timezoneError) throw new Error(timezoneError);
    state.forecast = forecast;
    state.plan = null;
    state.lastForecastError = null;
    appendSolarPlannerLog(state, `Open-Meteo forecast refreshed for ${forecast.timezone || "local time"}`, "forecast", now);
    await appendFile(SOLAR_FORECAST_HISTORY_FILE, `${JSON.stringify(forecast)}\n`);
  } catch (err) {
    state.lastForecastError = { at: now.toISOString(), error: err.message };
    appendSolarPlannerLog(state, `Forecast refresh failed: ${err.message}`, "error", now);
    return writeSolarPlannerState(state);
  }
  const historicalAge = now.getTime() - new Date(state.historicalWeatherFetchedAt ?? 0).getTime();
  if (forceHistorical || !Number.isFinite(historicalAge) || historicalAge > 24 * 60 * 60_000) {
    try {
      const historical = parseOpenMeteoForecast(await fetchJson(openMeteoUrl(config, true, now), fetchImpl), now);
      await writeJsonLinesAtomic(SOLAR_WEATHER_HISTORY_FILE, historical.hours);
      state.historicalWeatherFetchedAt = now.toISOString();
    } catch (err) {
      appendSolarPlannerLog(state, `Historical weather refresh failed; using demand recency fallback: ${err.message}`, "warning", now);
    }
  }
  return writeSolarPlannerState(state);
}

async function solarPlannerContext() {
  const state = await readSolarPlannerState();
  const historicalWeather = await readJsonLinesFile(SOLAR_WEATHER_HISTORY_FILE);
  return { ...state, historicalWeather };
}

function solarPlannerView(config, state, now = new Date()) {
  const availability = solarPlannerBaseAvailability(config);
  const forecastAgeMs = state.forecast?.fetchedAt
    ? now.getTime() - new Date(state.forecast.fetchedAt).getTime()
    : null;
  const paused = Boolean(state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime());
  return {
    enabled: config.solarPlanner?.enabled === true,
    available: availability.available && forecastIsFresh(state.forecast, now) && !paused && !state.lastForecastError,
    reason: paused
      ? `paused until ${state.pausedUntil}`
      : availability.reason
        || state.lastForecastError?.error
        || (!forecastIsFresh(state.forecast, now) ? "solar forecast is stale or unavailable" : null),
    paused,
    pausedUntil: state.pausedUntil,
    forecast: state.forecast ? {
      fetchedAt: state.forecast.fetchedAt,
      ageMs: Number.isFinite(forecastAgeMs) ? Math.max(0, forecastAgeMs) : null,
      timezone: state.forecast.timezone,
      stale: !forecastIsFresh(state.forecast, now),
    } : null,
    plan: state.plan,
    owner: state.owner,
    activeSlot: state.activeSlot,
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

function solarPowerFromIrradiance(irradianceWm2, config, learnedFactor = null) {
  const irradiance = Math.max(0, Number(irradianceWm2) || 0);
  const planner = config.solarPlanner ?? config;
  const peakW = Math.max(0, Number(planner.arrayPeakKw) || 0) * 1000;
  const fallbackFactor = Math.max(0, Number(planner.arrayPeakKw) || 0)
    * (1 - Math.max(0, Number(planner.systemLossPercent) || 0) / 100);
  const factor = Number.isFinite(Number(learnedFactor)) && Number(learnedFactor) > 0
    ? Number(learnedFactor)
    : fallbackFactor;
  return Math.min(peakW, irradiance * factor);
}

function solarPlannerBaseAvailability(config) {
  if (config.solarEnabled === false) return { available: false, reason: "solar generation is disabled" };
  if (!config.solarPlanner?.enabled) return { available: false, reason: "adaptive solar charging is disabled" };
  if (config.rateMode === "simple") return { available: false, reason: "Off-Peak or Multi-Rate pricing is required" };
  const coordinates = [
    [config.solarPlanner.latitude, "latitude"],
    [config.solarPlanner.longitude, "longitude"],
  ];
  const positive = [
    [config.solarPlanner.arrayPeakKw, "array peak capacity"],
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

function forecastIsFresh(forecast, now = new Date()) {
  const fetchedAt = new Date(forecast?.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= SOLAR_FORECAST_MAX_AGE_MS;
}

function estimateEffectiveBatteryCapacity(samples, configuredCapacityKwh) {
  const estimates = [];
  let anchor = null;
  let energyKwh = 0;
  let previous = null;
  for (const sample of samples) {
    const soc = Number(sample.stateOfChargePercent);
    const time = new Date(sample.timestamp).getTime();
    if (!Number.isFinite(soc) || !Number.isFinite(time)) continue;
    if (!anchor) anchor = { soc, time };
    if (previous) {
      const dtHours = Math.max(0, Math.min(0.25, (time - previous.time) / 3_600_000));
      const watts = Number(sample.batteryPowerW);
      if (Number.isFinite(watts)) energyKwh += Math.abs(watts) * dtHours / 1000;
    }
    const deltaSoc = Math.abs(soc - anchor.soc);
    if (deltaSoc >= 10 && energyKwh > 0) {
      estimates.push(energyKwh / (deltaSoc / 100));
      anchor = { soc, time };
      energyKwh = 0;
    }
    previous = { time };
  }
  const configured = Number(configuredCapacityKwh);
  const filtered = estimates.filter((value) => Number.isFinite(value) && value > 0);
  const estimate = median(filtered);
  if (filtered.length < 5 || !Number.isFinite(estimate) || !Number.isFinite(configured)) {
    return { capacityKwh: configured || null, learnedCapacityKwh: null, sessionCount: filtered.length };
  }
  return {
    capacityKwh: Math.max(configured * 0.7, Math.min(configured * 1.3, estimate)),
    learnedCapacityKwh: estimate,
    sessionCount: filtered.length,
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
  const breakerLimitWatts = Math.max(
    0,
    (Number(config.automation?.breakerAmps) - Number(config.automation?.reserveAmps))
      * Number(config.automation?.breakerVoltage),
  );
  const slots = [];
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const stepMs = slotMinutes * 60_000;
  for (let time = Math.ceil(startMs / stepMs) * stepMs; time < endMs; time += stepMs) {
    const date = new Date(time);
    const band = explicitDiscountedBand(config, date);
    if (!band) continue;
    const demandW = Number(demandBySlot.get(time) ?? 0);
    if (Number.isFinite(breakerLimitWatts) && breakerLimitWatts > 0 && demandW + maximumChargeWatts > breakerLimitWatts) continue;
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

function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function halfHourIndex(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
}

function aggregateDemandDays(samples) {
  const days = new Map();
  for (const sample of samples) {
    const demand = Number(sample.houseDemandW);
    const time = new Date(sample.timestamp);
    if (!Number.isFinite(demand) || Number.isNaN(time.getTime())) continue;
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

function predictHouseDemand(samples, targetDate = new Date(), temperatureByDay = new Map()) {
  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetIsWeekend = [0, 6].includes(target.getDay());
  const targetTemperature = Number(temperatureByDay.get(localDayKey(target)));
  const recordedDays = aggregateDemandDays(samples);
  const validDays = recordedDays.filter((day) => day.daytimeCoverage >= 0.8);
  const candidates = validDays
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
  const profile = new Map();
  for (let index = 0; index < 48; index += 1) {
    const value = weightedMedian(candidates
      .filter((day) => day.values.has(index))
      .map((day) => ({ value: day.values.get(index), weight: day.weight })));
    if (Number.isFinite(value)) profile.set(index, value);
  }
  return {
    available: validDays.length >= 7 && candidates.length >= 4 && profile.size >= 39,
    reason: validDays.length < 7
      ? `house-demand history has ${validDays.length} of ${recordedDays.length} days with at least 80% daytime coverage; 7 are required`
      : candidates.length < 4
      ? `only ${candidates.length} usable demand days were found in the previous six weeks; 4 are required`
      : profile.size < 39
        ? "house-demand history coverage is below 80%"
        : null,
    comparableDays: candidates.map((day) => day.key),
    sameDayTypeDays: candidates.filter((day) => day.sameDayType).map((day) => day.key),
    usedDayTypeFallback: candidates.some((day) => !day.sameDayType),
    recordedDayCount: recordedDays.length,
    validDayCount: validDays.length,
    profile,
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
    const weather = weatherByHour.get(Math.floor(time.getTime() / 3_600_000));
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
  const fallback = Number(config.solarPlanner.arrayPeakKw) * (1 - Number(config.solarPlanner.systemLossPercent) / 100);
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

function forecastHourForTime(forecast, time) {
  const target = new Date(time).getTime();
  return (forecast?.hours ?? []).reduce((best, hour) => {
    const distance = Math.abs(new Date(hour.timestamp).getTime() - target);
    return !best || distance < best.distance ? { hour, distance } : best;
  }, null)?.hour ?? null;
}

function nextForecastSunset(forecast, now = new Date()) {
  return (forecast?.days ?? [])
    .map((day) => ({ ...day, timestamp: new Date(day.sunset).getTime() }))
    .filter((day) => Number.isFinite(day.timestamp) && day.timestamp > now.getTime())
    .sort((a, b) => a.timestamp - b.timestamp)[0] ?? null;
}

function buildSolarChargingPlan({ config, state, samples, now = new Date() } = {}) {
  const baseAvailability = solarPlannerBaseAvailability(config);
  if (!baseAvailability.available) return { available: false, reason: baseAvailability.reason, createdAt: now.toISOString(), slots: [] };
  if (!forecastIsFresh(state.forecast, now)) return { available: false, reason: "solar forecast is stale or unavailable", createdAt: now.toISOString(), slots: [] };
  const sunset = nextForecastSunset(state.forecast, now);
  if (!sunset) return { available: false, reason: "no upcoming sunset is available", createdAt: now.toISOString(), slots: [] };
  const temperatures = temperatureByDayFromWeather([...(state.historicalWeather ?? []), ...(state.forecast.hours ?? [])]);
  const demand = predictHouseDemand(samples, new Date(sunset.date), temperatures);
  if (!demand.available) return { available: false, reason: demand.reason, createdAt: now.toISOString(), slots: [] };
  const latest = samples.at(-1) ?? {};
  const soc = Number(latest.stateOfChargePercent);
  if (!Number.isFinite(soc)) return { available: false, reason: "battery state of charge is unavailable", createdAt: now.toISOString(), slots: [] };
  const capacityEstimate = estimateEffectiveBatteryCapacity(samples, config.batteryCapabilities.usableCapacityKwh);
  const capacityKwh = Number(capacityEstimate.capacityKwh);
  const dischargeLimit = Number(config.settingCache?.discharge_limit?.lastKnown?.decoded?.percent ?? 20);
  const calibration = learnedSolarFactor(samples, state.historicalWeather, config);
  const stepMs = 30 * 60_000;
  let storedKwh = capacityKwh * soc / 100;
  let predictedSolarKwh = 0;
  let predictedDemandKwh = 0;
  let predictedSurplusKwh = 0;
  const demandBySlot = new Map();
  for (let time = Math.ceil(now.getTime() / stepMs) * stepMs; time < sunset.timestamp; time += stepMs) {
    const hour = forecastHourForTime(state.forecast, time);
    const factor = calibration.groupFactors?.[solarCalibrationGroup(new Date(time))] ?? calibration.factor;
    const rawSolarW = solarPowerFromIrradiance(hour?.tiltedIrradianceWm2, config, factor);
    const solarW = rawSolarW * (1 - Number(config.solarPlanner.forecastMarginPercent) / 100);
    const slotDemandW = Number(demand.profile.get(halfHourIndex(new Date(time))) ?? 0);
    demandBySlot.set(time, slotDemandW);
    const solarKwh = solarW * 0.5 / 1000;
    const demandKwh = slotDemandW * 0.5 / 1000;
    const netKwh = solarKwh - demandKwh;
    predictedSolarKwh += solarKwh;
    predictedDemandKwh += demandKwh;
    predictedSurplusKwh += Math.max(0, netKwh);
    storedKwh = Math.max(
      capacityKwh * Math.max(0, dischargeLimit) / 100,
      Math.min(capacityKwh, storedKwh + netKwh),
    );
  }
  const targetKwh = capacityKwh * Number(config.solarPlanner.targetSocPercent) / 100;
  const requiredKwh = Math.max(0, targetKwh - storedKwh);
  const optimized = optimizeDiscountedChargeSlots({
    config,
    start: now,
    end: new Date(sunset.timestamp),
    requiredKwh,
    demandBySlot,
  });
  const expectedStoredKwh = Math.min(capacityKwh, storedKwh + optimized.plannedChargeKwh);
  return {
    available: optimized.unmetChargeKwh <= 0.0001,
    reason: optimized.unmetChargeKwh > 0 ? "discounted windows cannot supply the full predicted shortfall" : null,
    createdAt: now.toISOString(),
    targetDate: sunset.date,
    targetSunset: new Date(sunset.timestamp).toISOString(),
    currentSocPercent: soc,
    targetSocPercent: Number(config.solarPlanner.targetSocPercent),
    expectedSunsetSocPercent: capacityKwh ? Math.min(100, expectedStoredKwh / capacityKwh * 100) : null,
    predictedSolarKwh,
    predictedDemandKwh,
    predictedSurplusKwh,
    requiredGridChargeKwh: requiredKwh,
    ...optimized,
    comparableDemandDays: demand.comparableDays,
    demandHistory: {
      recordedDayCount: demand.recordedDayCount,
      validDayCount: demand.validDayCount,
      sameDayTypeDayCount: demand.sameDayTypeDays.length,
      usedDayTypeFallback: demand.usedDayTypeFallback,
    },
    solarCalibration: calibration,
    batteryCapacity: capacityEstimate,
    slots: optimized.slots,
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
  // JSON Lines keeps persistence simple: each status poll appends one complete
  // sample, and a partially-written final line is easy to ignore on read.
  const sample = sampleFromStatus(status, config, lastRecordedSample);
  lastRecordedSample = sample;
  await appendFile(HISTORY_FILE, `${JSON.stringify(sample)}\n`);
  return sample;
}

async function recordGuardTriggerSample(at = new Date()) {
  await ensureDataDir();
  await appendFile(HISTORY_FILE, `${JSON.stringify({
    timestamp: at.toISOString(),
    guardTriggerCount: 1,
  })}\n`);
}

function sampleSolarGenerationKwh(sample) {
  const direct = Number(sample.solarGenerationKwh);
  if (Number.isFinite(direct)) return direct;
  const solarSavingYen = Number(sample.solarSavingYen);
  const rateYenPerKwh = Number(sample.rateYenPerKwh);
  if (Number.isFinite(solarSavingYen) && Number.isFinite(rateYenPerKwh) && rateYenPerKwh > 0) {
    return solarSavingYen / rateYenPerKwh;
  }
  return 0;
}

function samplePowerKwh(sample, directKey, wattsKey, previousSample) {
  const direct = Number(sample[directKey]);
  if (Number.isFinite(direct)) return direct;
  if (!previousSample?.timestamp || !sample?.timestamp) return 0;
  const watts = Number(sample[wattsKey]);
  if (!Number.isFinite(watts)) return 0;
  const deltaHours = Math.max(0, Math.min(1, (new Date(sample.timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000));
  return deltaHours * (Math.max(0, watts) / 1000);
}

function hasPowerSample(sample, directKey, wattsKey, previousSample) {
  if (Number.isFinite(Number(sample?.[directKey]))) return true;
  return Boolean(previousSample?.timestamp && sample?.timestamp && Number.isFinite(Number(sample?.[wattsKey])));
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
    .map((sample) => Number(sample.stateOfChargePercent))
    .filter((value) => Number.isFinite(value));
  const averageStateOfChargePercent = socSamples.length
    ? socSamples.reduce((sum, value) => sum + value, 0) / socSamples.length
    : null;
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  const guardTriggerCount = samples.reduce(
    (sum, sample) => sum + Math.max(0, Number(sample.guardTriggerCount ?? 0) || 0),
    0,
  ) + Math.max(0, Number(extras.guardTriggerCount ?? 0) || 0);
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
  const peaks = buckets.map((bucket) => Number(bucket.peakDemandW)).filter(Number.isFinite);
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
      row.sampleCount += 1;
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
        Number.isFinite(Number(sample.solarGenerationKwh)) || hasPowerSample(sample, "solarGenerationKwh", "solarPowerW", prev),
      );
      row.solarSavingYen += Number(sample.solarSavingYen ?? 0) || 0;
      row.offPeakSavingYen += Number(sample.offPeakSavingYen ?? 0) || 0;
      row.co2SavingKg += solarGenerationKwh * co2TonnesPerKwh * 1000;
      const demand = Number(sample.houseDemandW);
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
  // History is read by scanning the JSONL file. This is intentionally boring and
  // inspectable; a database can replace it later if retention grows large.
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
  try {
    await stat(HISTORY_FILE);
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        ...aggregateEnergyReportSamples([], {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          bucket: bucketMode,
          config,
        }),
        meta: { recordsRead: 0, recordsIncluded: 0, invalidRecords: 0 },
      };
    }
    throw err;
  }

  const accumulator = createEnergyReportAccumulator({
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    bucket: bucketMode,
    config,
  });
  const stream = createReadStream(HISTORY_FILE, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let recordsIncluded = 0;
  let invalidRecords = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let sample = null;
      try {
        sample = parseJsonWithContext(line, `${HISTORY_FILE}:line ${lineNumber}`);
      } catch (err) {
        invalidRecords += 1;
        logDetailedError("history", err);
        continue;
      }
      const result = accumulator.process(sample);
      if (result === "included") recordsIncluded += 1;
      if (result === "after") {
        lines.close();
        stream.destroy();
        break;
      }
    }
  } finally {
    lines.close();
    if (!stream.destroyed) stream.destroy();
  }

  return {
    ...accumulator.finish(),
    meta: { recordsRead: lineNumber, recordsIncluded, invalidRecords },
  };
}

async function readAllHistorySamples() {
  await ensureDataDir();
  let text = "";
  try {
    text = await readFile(HISTORY_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return parseHistorySamples(text);
}

async function readHistoryStats() {
  // Summarizes the on-disk history store for the Data Retention settings panel:
  // how large the JSONL file is and how much of a time span it covers.
  await ensureDataDir();
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(HISTORY_FILE)).size;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const samples = await readAllHistorySamples();
  const earliest = samples[0]?.timestamp ?? null;
  const latest = samples[samples.length - 1]?.timestamp ?? null;
  const daysRecorded =
    earliest && latest
      ? Math.max(0, (new Date(latest).getTime() - new Date(earliest).getTime()) / 86_400_000)
      : 0;
  return { sizeBytes, sampleCount: samples.length, earliest, latest, daysRecorded };
}

async function trimHistory(retentionDays) {
  await ensureDataDir();
  const days = configNumber(retentionDays, DEFAULT_CONFIG.historyRetentionDays, 1, 3650);
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const samples = await readAllHistorySamples();
  const kept = samples.filter((sample) => new Date(sample.timestamp).getTime() >= cutoff);
  await writeJsonLinesAtomic(HISTORY_FILE, kept);
  const contextualCutoff = Date.now() - Math.min(days, 365) * 24 * 60 * 60_000;
  for (const file of [SOLAR_FORECAST_HISTORY_FILE, SOLAR_WEATHER_HISTORY_FILE]) {
    const records = await readJsonLinesFile(file);
    const contextual = records.filter((record) => {
      const timestamp = record.timestamp ?? record.fetchedAt ?? record.time;
      return Number.isFinite(new Date(timestamp).getTime()) && new Date(timestamp).getTime() >= contextualCutoff;
    });
    await writeJsonLinesAtomic(file, contextual);
  }
  return { retentionDays: days, before: samples.length, after: kept.length, deleted: samples.length - kept.length };
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

function normalizeAutomationConfig(value = {}) {
  return {
    breakerVoltage: configNumber(value.breakerVoltage, DEFAULT_CONFIG.automation.breakerVoltage, 1, 1000),
    breakerAmps: configNumber(value.breakerAmps, DEFAULT_CONFIG.automation.breakerAmps, 1, 400),
    reserveAmps: configNumber(value.reserveAmps, DEFAULT_CONFIG.automation.reserveAmps, 0, 200),
    enabledDefaults: configBool(value.enabledDefaults, DEFAULT_CONFIG.automation.enabledDefaults),
  };
}

function normalizeBatteryCapabilities(value = {}) {
  return {
    usableCapacityKwh: optionalConfigNumber(value.usableCapacityKwh, 0.1, 1000),
    maximumChargeWatts: optionalSteppedConfigNumber(value.maximumChargeWatts, 50, 100000, 50),
  };
}

function normalizeSolarPlanner(value = {}) {
  return {
    enabled: configBool(value.enabled, DEFAULT_CONFIG.solarPlanner.enabled),
    latitude: optionalConfigNumber(value.latitude, -90, 90),
    longitude: optionalConfigNumber(value.longitude, -180, 180),
    arrayPeakKw: optionalConfigNumber(value.arrayPeakKw, 0.1, 10000),
    panelTiltDegrees: configNumber(value.panelTiltDegrees, DEFAULT_CONFIG.solarPlanner.panelTiltDegrees, 0, 90),
    panelAzimuthDegrees: configNumber(value.panelAzimuthDegrees, DEFAULT_CONFIG.solarPlanner.panelAzimuthDegrees, -180, 180),
    systemLossPercent: configNumber(value.systemLossPercent, DEFAULT_CONFIG.solarPlanner.systemLossPercent, 0, 50),
    targetSocPercent: configNumber(value.targetSocPercent, DEFAULT_CONFIG.solarPlanner.targetSocPercent, 50, 100),
    forecastMarginPercent: configNumber(value.forecastMarginPercent, DEFAULT_CONFIG.solarPlanner.forecastMarginPercent, 0, 50),
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
  return ["number", "energy"].includes(value) ? value : DEFAULT_CONFIG.circuitSortMode;
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
    historyRetentionDays: configNumber(input.historyRetentionDays, DEFAULT_CONFIG.historyRetentionDays, 1, 3650),
    updateIntervalSeconds: configNumber(input.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 5, 3600),
    rateBands,
    automation: normalizeAutomationConfig(input.automation ?? {}),
    batteryCapabilities: normalizeBatteryCapabilities(input.batteryCapabilities ?? {}),
    solarPlanner: normalizeSolarPlanner(input.solarPlanner ?? {}),
    dashboardWidgets: normalizeDashboardWidgets(input.dashboardWidgets),
    settingCache: normalizeSettingCache(input.settingCache ?? {}),
    language: ["en", "ja"].includes(input.language) ? input.language : DEFAULT_CONFIG.language,
  };
}

async function readConfig() {
  await ensureDataDir();
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    return cleanConfig(parseJsonWithContext(text, CONFIG_FILE));
  } catch (err) {
    if (err.code === "ENOENT") return cleanConfig(DEFAULT_CONFIG);
    throw err;
  }
}

async function writeConfig(config) {
  const previous = await readConfig().catch(() => cleanConfig(DEFAULT_CONFIG));
  const cleaned = cleanConfig({ ...previous, ...config });
  await ensureDataDir();
  await writeJsonFileAtomic(CONFIG_FILE, cleaned);
  const hostKeys = ["batteryHost", "meterHost", "meterEoj", "solarHost"];
  const hostChanged = hostKeys.some((key) => previous[key] !== cleaned[key])
    || JSON.stringify(previous.fuelCellHosts) !== JSON.stringify(cleaned.fuelCellHosts);
  if (hostChanged) lastRecordedSample = null;
  const plannerInputsChanged = JSON.stringify({
    solarEnabled: previous.solarEnabled,
    smartCosmoEnabled: previous.smartCosmoEnabled,
    rateMode: previous.rateMode,
    rateBands: previous.rateBands,
    standardRateYenPerKwh: previous.standardRateYenPerKwh,
    batteryCapabilities: previous.batteryCapabilities,
    solarPlanner: previous.solarPlanner,
  }) !== JSON.stringify({
    solarEnabled: cleaned.solarEnabled,
    smartCosmoEnabled: cleaned.smartCosmoEnabled,
    rateMode: cleaned.rateMode,
    rateBands: cleaned.rateBands,
    standardRateYenPerKwh: cleaned.standardRateYenPerKwh,
    batteryCapabilities: cleaned.batteryCapabilities,
    solarPlanner: cleaned.solarPlanner,
  });
  if (plannerInputsChanged) {
    const state = await readSolarPlannerState();
    state.plan = null;
    const forecastInputsChanged = JSON.stringify({
      latitude: previous.solarPlanner.latitude,
      longitude: previous.solarPlanner.longitude,
      tilt: previous.solarPlanner.panelTiltDegrees,
      azimuth: previous.solarPlanner.panelAzimuthDegrees,
    }) !== JSON.stringify({
      latitude: cleaned.solarPlanner.latitude,
      longitude: cleaned.solarPlanner.longitude,
      tilt: cleaned.solarPlanner.panelTiltDegrees,
      azimuth: cleaned.solarPlanner.panelAzimuthDegrees,
    });
    if (forecastInputsChanged) {
      state.forecast = null;
      state.historicalWeatherFetchedAt = null;
    }
    if (plannerConfiguredActive(previous) && !plannerConfiguredActive(cleaned) && state.owner === "planner") {
      await releasePlannerCharge(state, "Adaptive solar charging was disabled");
    }
    await writeSolarPlannerState(state);
  }
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
  if (config.solarPlanner?.enabled && config.solarEnabled !== false && config.rateMode !== "simple") return;
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
      breakerAmps: configNumber(conditions.breakerAmps, DEFAULT_CONFIG.automation.breakerAmps, 1, 400),
      breakerVoltage: configNumber(conditions.breakerVoltage, DEFAULT_CONFIG.automation.breakerVoltage, 1, 1000),
      reserveAmps: configNumber(conditions.reserveAmps, DEFAULT_CONFIG.automation.reserveAmps, 0, 200),
      batteryChargingEstimateW: configNumber(conditions.batteryChargingEstimateW, 1000, 0, 20000),
      restoreBelowAmps: configNumber(conditions.restoreBelowAmps, Math.max(1, DEFAULT_CONFIG.automation.breakerAmps - 10), 1, 400),
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

async function evaluateAutomationRule(rule, status, now = new Date(), onPhase = () => {}, config = null) {
  onPhase("evaluating conditions");
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

  if (operationMode === "auto" && guardDemandW !== null && batteryChargingW > 0 && guardDemandW >= breakerLimitW) {
    if (!canRunAutomation(rule, now)) return { changed: false, result: { skipped: "cooldown" } };
    onPhase("executing Standby guard action");
    const result = await executeAction(rule.action, rule.payload);
    appendAutomationLog(
      rule,
      `${demandLabel} (${formatWatts(guardDemandW)}) exceeds Charge Demand Guard limit (${formatWatts(breakerLimitW)}), setting operation mode from ${operationMode} to Standby`,
      now,
      "guard",
    );
    await recordGuardTriggerSample(now);
    rule.state = {
      ...rule.state,
      awaitingRestore: true,
      restoreSince: null,
      previousMode: operationMode,
    };
    rule.lastResult = { ok: true, at: now.toISOString(), kind: "guard", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, breakerLimitW, result };
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
      onPhase("executing Auto restore action");
      const result = await executeAction(rule.restoreAction, rule.restorePayload);
      appendAutomationLog(
        rule,
        `${demandLabel} (${formatWatts(demandW)}) now below Guard restore limit (${formatWatts(restoreLimitW)}), setting operation mode to Auto`,
        now,
        "restore",
      );
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

function plannerConfiguredActive(config) {
  return config.solarPlanner?.enabled === true && config.solarEnabled !== false && config.rateMode !== "simple";
}

function nextLocalMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

async function pauseSolarPlannerForManualAction(action, now = new Date()) {
  const config = await readConfig();
  if (!plannerConfiguredActive(config)) return null;
  const state = await readSolarPlannerState();
  if (state.owner === "planner") await releasePlannerCharge(state, "Manual battery action received", now);
  state.pausedUntil = nextLocalMidnight(now);
  appendSolarPlannerLog(state, `Manual ${action} action paused the planner until ${state.pausedUntil}`, "pause", now);
  return writeSolarPlannerState(state);
}

async function resumeSolarPlanner(now = new Date()) {
  const state = await readSolarPlannerState();
  state.pausedUntil = null;
  state.plan = null;
  appendSolarPlannerLog(state, "Planner resumed manually", "resume", now);
  return writeSolarPlannerState(state);
}

async function releasePlannerCharge(state, reason, now = new Date()) {
  if (state.owner !== "planner") return false;
  await executeAction("set-mode", { mode: "auto" });
  appendSolarPlannerLog(state, `${reason}; setting operation mode to Auto`, "stop", now);
  state.owner = null;
  state.activeSlot = null;
  state.activeChargedKwh = 0;
  state.activeLastCheckedAt = null;
  return true;
}

function plannerSlotAt(plan, now = new Date()) {
  const time = now.getTime();
  return (plan?.slots ?? []).find((slot) => new Date(slot.start).getTime() <= time && time < new Date(slot.end).getTime()) ?? null;
}

async function evaluateSolarPlanner(config, status, rules, now = new Date()) {
  let state = await solarPlannerContext();
  const paused = state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime();
  const guardActive = rules.some((rule) => rule.enabled && rule.type === "backup-demand-guard" && rule.state?.awaitingRestore);
  const base = solarPlannerBaseAvailability(config);
  const forecastError = state.lastForecastError?.error;
  if (!base.available || paused || !forecastIsFresh(state.forecast, now) || forecastError) {
    const unavailableReason = paused
      ? "Planner is paused"
      : base.reason || forecastError || "Forecast is unavailable";
    if (!guardActive && state.owner === "planner") await releasePlannerCharge(state, unavailableReason, now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: paused ? "paused after manual action" : unavailableReason };
    return writeSolarPlannerState(state);
  }
  if (guardActive) {
    if (state.owner === "planner") {
      state.owner = null;
      state.activeSlot = null;
      state.activeChargedKwh = 0;
      state.activeLastCheckedAt = null;
      state.plan = null;
      appendSolarPlannerLog(state, "Charging Demand Guard owns battery control; planner is waiting", "guard", now);
    }
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "Charging Demand Guard active" };
    return writeSolarPlannerState(state);
  }

  const historyStart = now.getTime() - 90 * 86_400_000;
  const samples = await readHistorySamplesInRange(historyStart, now.getTime());
  const liveSoc = Number(status.energy?.battery?.remaining_percent?.value);
  samples.push({
    timestamp: now.toISOString(),
    stateOfChargePercent: Number.isFinite(liveSoc) ? liveSoc : null,
    batteryPowerW: numericMetric(status.energy?.battery?.instant_power),
    solarPowerW: numericMetric(status.energy?.solar?.instant_power),
    houseDemandW: numericMetric(status.meter?.house_demand_power),
  });
  const planAge = now.getTime() - new Date(state.plan?.createdAt ?? 0).getTime();
  const socChangedMaterially = Number.isFinite(liveSoc)
    && Number.isFinite(Number(state.plan?.currentSocPercent))
    && Math.abs(liveSoc - Number(state.plan.currentSocPercent)) >= 2;
  if (!state.plan || !Number.isFinite(planAge) || planAge >= SOLAR_PLAN_REFRESH_MS || socChangedMaterially) {
    state.plan = buildSolarChargingPlan({ config, state, samples, now });
    appendSolarPlannerLog(
      state,
      state.plan.available
        ? `Plan recalculated: ${state.plan.predictedSolarKwh.toFixed(2)} kWh solar, ${state.plan.predictedDemandKwh.toFixed(2)} kWh demand, ${state.plan.plannedChargeKwh.toFixed(2)} kWh discounted charging`
        : `Planner unavailable: ${state.plan.reason}`,
      "plan",
      now,
    );
  }
  if (!state.plan?.available) {
    if (state.owner === "planner") await releasePlannerCharge(state, state.plan?.reason || "Plan is unavailable", now);
    state.lastResult = { ok: true, at: now.toISOString(), skipped: state.plan?.reason || "plan unavailable" };
    return writeSolarPlannerState(state);
  }

  const chargingWatts = batteryChargingWatts(status) ?? 0;
  if (state.owner === "planner" && state.activeLastCheckedAt) {
    const elapsedHours = Math.max(0, Math.min(0.1, (now.getTime() - new Date(state.activeLastCheckedAt).getTime()) / 3_600_000));
    state.activeChargedKwh += chargingWatts * elapsedHours / 1000;
  }
  state.activeLastCheckedAt = now.toISOString();
  const soc = Number(status.energy?.battery?.remaining_percent?.value);
  const activeTargetKwh = Number(state.activeSlot?.targetWh ?? 0) / 1000;
  const activeExpired = state.activeSlot && now.getTime() >= new Date(state.activeSlot.end).getTime();
  if (state.owner === "planner" && (
    activeExpired
    || state.activeChargedKwh >= activeTargetKwh
    || (Number.isFinite(soc) && soc >= Number(config.solarPlanner.targetSocPercent))
  )) {
    await releasePlannerCharge(state, activeExpired ? "Planned discounted window ended" : "Planned charge target reached", now);
  }

  const slot = plannerSlotAt(state.plan, now);
  if (slot && state.owner !== "planner") {
    const demandW = Number(status.meter?.house_demand_power?.value);
    const maximumChargeWatts = Number(config.batteryCapabilities.maximumChargeWatts);
    const breakerLimitW = Math.max(0, (config.automation.breakerAmps - config.automation.reserveAmps) * config.automation.breakerVoltage);
    if (!Number.isFinite(demandW) || demandW + maximumChargeWatts > breakerLimitW) {
      state.lastResult = { ok: true, at: now.toISOString(), skipped: "live breaker headroom is insufficient", demandW, maximumChargeWatts, breakerLimitW };
      return writeSolarPlannerState(state);
    }
    const result = await executeAction("charge", { targetWh: slot.targetWh });
    state.owner = "planner";
    state.activeSlot = slot;
    state.activeChargedKwh = 0;
    state.activeLastCheckedAt = now.toISOString();
    state.lastResult = { ok: true, at: now.toISOString(), kind: "charge", slot, result };
    appendSolarPlannerLog(state, `Starting ${slot.targetWh} Wh charge in ${slot.label} band at ${slot.yenPerKwh} yen/kWh`, "charge", now);
  } else if (!slot && state.owner !== "planner") {
    state.lastResult = { ok: true, at: now.toISOString(), skipped: "no planned charge is due" };
  }
  return writeSolarPlannerState(state);
}

async function runAutomationRules(context = {}) {
  const startedAt = new Date();
  context.startedAt = startedAt.toISOString();
  context.phase = "loading automation rules";
  const config = await readConfig();
  const rules = await readAutomationRules();
  const enabledRules = rules.filter((rule) => rule.enabled);
  const plannerRequested = plannerConfiguredActive(config);
  const plannerStateBeforeStatus = plannerRequested ? await readSolarPlannerState() : null;
  const plannerEnabled = plannerRequested
    && (solarPlannerBaseAvailability(config).available || plannerStateBeforeStatus?.owner === "planner");
  context.enabledRules = [
    ...enabledRules.map(automationRuleLabel),
    ...(plannerEnabled ? ["Adaptive solar charging"] : []),
  ];
  if (!enabledRules.length && !plannerEnabled) {
    if (plannerRequested) await evaluateSolarPlanner(config, {}, rules, startedAt);
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
  for (const rule of rules) {
    const now = new Date();
    const ruleLabel = automationRuleLabel(rule);
    const ruleStartedAt = Date.now();
    let ruleChanged = false;
    try {
      const result = await evaluateAutomationRule(rule, status, now, (phase) => {
        context.phase = `${phase} for ${ruleLabel}`;
      }, config);
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
  if (plannerEnabled) {
    context.phase = "evaluating adaptive solar charging";
    let plannerState = await readSolarPlannerState();
    const forecastAge = startedAt.getTime() - new Date(plannerState.forecast?.fetchedAt ?? 0).getTime();
    if (solarPlannerBaseAvailability(config).available
      && (!Number.isFinite(forecastAge) || forecastAge >= SOLAR_FORECAST_REFRESH_MS)) {
      context.phase = "refreshing Open-Meteo forecast";
      plannerState = await refreshSolarPlannerForecast(config, { now: startedAt });
    }
    await evaluateSolarPlanner(config, status, rules, new Date());
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
        await readAllStatus();
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
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await readConfig()), port: PORT });
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await writeConfig(await readBody(req))), port: PORT });
  }
  if (req.method === "POST" && url.pathname === "/api/history/trim") {
    const config = await readConfig();
    const body = await readBody(req);
    return json(res, 200, await trimHistory(body.retentionDays ?? config.historyRetentionDays));
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
  if (req.method === "GET" && url.pathname === "/api/solar-planner") {
    const config = await readConfig();
    return json(res, 200, solarPlannerView(config, await readSolarPlannerState()));
  }
  if (req.method === "POST" && url.pathname === "/api/solar-planner/recalculate") {
    const config = await readConfig();
    const availability = solarPlannerBaseAvailability(config);
    if (!availability.available) return json(res, 409, { error: availability.reason });
    let state = await refreshSolarPlannerForecast(config, { forceHistorical: true });
    if (!state.forecast || !forecastIsFresh(state.forecast) || state.lastForecastError) {
      return json(res, 503, solarPlannerView(config, state));
    }
    const samples = await readHistorySamplesInRange(Date.now() - 90 * 86_400_000, Date.now());
    state = { ...state, historicalWeather: await readJsonLinesFile(SOLAR_WEATHER_HISTORY_FILE) };
    state.plan = buildSolarChargingPlan({ config, state, samples });
    appendSolarPlannerLog(state, "Plan recalculated manually", "plan");
    state = await writeSolarPlannerState(state);
    return json(res, 200, solarPlannerView(config, state));
  }
  if (req.method === "POST" && url.pathname === "/api/solar-planner/resume") {
    const config = await readConfig();
    return json(res, 200, solarPlannerView(config, await resumeSolarPlanner()));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/settings/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/settings/", "");
    await pauseSolarPlannerForManualAction(action);
    return json(res, 200, await executeAction(action, body));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/actions/", "");
    await pauseSolarPlannerForManualAction(action);
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
    if (plannerConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive solar charging is enabled" });
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
    if (plannerConfiguredActive(await readConfig())) {
      return json(res, 409, { error: "schedules are preserved but disabled while adaptive solar charging is enabled" });
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
    logDetailedError("api", err);
    json(res, 500, { error: err.message });
  }
});

export {
  aggregateEnergyReportSamples,
  buildSolarChargingPlan,
  clearStaleScheduleRuns,
  cleanAutomationRule,
  cleanAutomationRuleConfig,
  cleanConfig,
  countGuardTriggersForRange,
  evaluateAutomationRule,
  estimateEffectiveBatteryCapacity,
  forecastIsFresh,
  learnedSolarFactor,
  normalizeCircuitLabels,
  normalizeDashboardWidgets,
  normalizeRateBands,
  normalizeSubnets,
  optimizeDiscountedChargeSlots,
  parseJsonWithContext,
  parseOpenMeteoForecast,
  plannerTimezoneError,
  rateForTimestamp,
  recoverConcatenatedJsonValue,
  sampleFromStatus,
  solarPlannerBaseAvailability,
  solarPowerFromIrradiance,
  summarizeSamples,
  summarizeCircuits,
  predictHouseDemand,
};

async function main() {
  await ensureDataDir();
  await migrateBatteryCapabilitiesFromGuard();
  startScheduler();
  startBackgroundRecorder();
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
  server.close(() => process.exit(0));
});
