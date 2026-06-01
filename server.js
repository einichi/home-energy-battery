#!/usr/bin/env node
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
const AUTOMATION_RULES_FILE = path.join(DATA_DIR, "automation-rules.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_FILE = path.join(HISTORY_DIR, "samples.jsonl");
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 15000);
const CLI_FILE = "home-energy-battery-node.js";

// Public defaults use RFC 5737 documentation addresses. Real deployments should
// set device addresses from the Settings page, where they are persisted in /data.
const DEFAULT_CONFIG = {
  batteryHost: "192.0.2.10",
  smartMeterHost: "",
  meterHost: "192.0.2.20",
  meterEoj: "0x028701",
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
  settingCache: {},
  language: "en",
};

let cliQueue = Promise.resolve();
let scheduleTimer = null;
let automationTimer = null;
let lastRecordedSample = null;
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
  const task = cliQueue.then(() => runCli(command, args, positional));
  cliQueue = task.catch(() => {});
  return task;
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(HISTORY_DIR, { recursive: true });
}

function numericMetric(item) {
  const value = Number(item?.value);
  return Number.isFinite(value) ? value : null;
}

function strongestFuelCellWatts(fuelCells = []) {
  const values = fuelCells.map((cell) => numericMetric(cell.instant_power)).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function jsonSnippet(text, maxLength = 4000) {
  if (text === "") return "(empty)";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated ${text.length - maxLength} chars>`;
}

function parseJsonWithContext(text, source) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const err = new Error(`Failed to parse JSON from ${source}: ${cause.message}`);
    err.cause = cause;
    err.jsonSource = source;
    err.jsonText = text;
    throw err;
  }
}

function logDetailedError(label, err) {
  console.error(`${label}:`, err.stack || err.message);
  if (err.jsonSource !== undefined) {
    console.error(`${label} JSON source: ${err.jsonSource}`);
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

function sampleFromStatus(status, config, previousSample) {
  // Convert the large live status payload into one compact time-series sample.
  // We store only normalized values that graphs and savings calculations need.
  const timestamp = status.read_at ?? new Date().toISOString();
  const batteryPowerW = numericMetric(status.energy?.battery?.instant_power);
  const solarPowerW = config.solarEnabled === false ? null : numericMetric(status.energy?.solar?.instant_power);
  const fuelCellPowerW = config.fuelCellEnabled === false ? null : strongestFuelCellWatts(status.energy?.fuel_cells);
  const houseDemandW = numericMetric(status.meter?.house_demand_power);
  const gridImportW = numericMetric(status.meter?.grid_import_power);
  const gridExportW = numericMetric(status.meter?.grid_export_power);
  const stateOfChargePercent = numericMetric(status.energy?.battery?.remaining_percent);
  const rateBand = rateForTimestamp(config.rateBands, timestamp, config.standardRateYenPerKwh);
  const activeRate = rateBand.yenPerKwh;
  const highestRate = maxDailyRate(config.rateBands, config.standardRateYenPerKwh);
  const deltaHours = previousSample
    ? Math.max(0, Math.min(1, (new Date(timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000))
    : 0;
  const offPeakSavingsEnabled = config.rateMode !== "simple" || config.offPeakSavingsEnabled === true;
  const offPeakSavingW = offPeakSavingsEnabled && batteryPowerW > 0 && !(solarPowerW > 0) ? batteryPowerW : 0;
  const solarGenerationKwh = deltaHours * (Math.max(0, solarPowerW ?? 0) / 1000);
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
    solarGenerationKwh,
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

function summarizeSamples(samples, config = DEFAULT_CONFIG) {
  const solarGenerationKwh = samples.reduce((sum, sample) => sum + sampleSolarGenerationKwh(sample), 0);
  const co2TonnesPerKwh = configNumber(config.co2TonnesPerKwh, DEFAULT_CONFIG.co2TonnesPerKwh, 0, 1);
  return {
    sampleCount: samples.length,
    start: samples[0]?.timestamp ?? null,
    end: samples[samples.length - 1]?.timestamp ?? null,
    offPeakSavingYen: samples.reduce((sum, sample) => sum + Number(sample.offPeakSavingYen ?? 0), 0),
    solarSavingYen: samples.reduce((sum, sample) => sum + Number(sample.solarSavingYen ?? 0), 0),
    solarGenerationKwh,
    co2SavingKg: solarGenerationKwh * co2TonnesPerKwh * 1000,
  };
}

async function readHistoryRange(start, end, config = DEFAULT_CONFIG) {
  // History is read by scanning the JSONL file. This is intentionally boring and
  // inspectable; a database can replace it later if retention grows large.
  await ensureDataDir();
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 60_000;
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error("valid start and end date/time are required");
  }
  let text = "";
  try {
    text = await readFile(HISTORY_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const samples = parseHistorySamples(text)
    .filter((sample) => {
      const time = new Date(sample.timestamp).getTime();
      return time >= startMs && time <= endMs;
    });
  return { samples, summary: summarizeSamples(samples, config) };
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

async function trimHistory(retentionDays) {
  await ensureDataDir();
  const days = configNumber(retentionDays, DEFAULT_CONFIG.historyRetentionDays, 1, 3650);
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const samples = await readAllHistorySamples();
  const kept = samples.filter((sample) => new Date(sample.timestamp).getTime() >= cutoff);
  await writeJsonLinesAtomic(HISTORY_FILE, kept);
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
    smartMeterHost: String(input.smartMeterHost ?? DEFAULT_CONFIG.smartMeterHost).trim(),
    meterHost: String(input.meterHost ?? DEFAULT_CONFIG.meterHost).trim(),
    meterEoj: String(input.meterEoj ?? DEFAULT_CONFIG.meterEoj).trim() || DEFAULT_CONFIG.meterEoj,
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
  const hostKeys = ["batteryHost", "smartMeterHost", "meterHost", "meterEoj", "solarHost"];
  const hostChanged = hostKeys.some((key) => previous[key] !== cleaned[key])
    || JSON.stringify(previous.fuelCellHosts) !== JSON.stringify(cleaned.fuelCellHosts);
  if (hostChanged) lastRecordedSample = null;
  return cleaned;
}

async function readAutomationRules() {
  await ensureDataDir();
  try {
    const text = await readFile(AUTOMATION_RULES_FILE, "utf8");
    const parsed = parseJsonWithContext(text, AUTOMATION_RULES_FILE);
    return Array.isArray(parsed) ? parsed.map(cleanAutomationRule) : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAutomationRules(rules) {
  await ensureDataDir();
  const cleaned = rules.map(cleanAutomationRule);
  await writeJsonFileAtomic(AUTOMATION_RULES_FILE, cleaned);
  return cleaned;
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

async function readSmartMeterStatus(config) {
  if (!config.smartMeterHost || isDocumentationHost(config.smartMeterHost)) {
    return { configured: false, host: null };
  }
  try {
    const power = await runCliQueued("raw-get", { host: config.smartMeterHost, eoj: "0x028801" }, ["0xE7"]);
    const raw = parseRawHex(power.raw);
    return {
      configured: true,
      host: config.smartMeterHost,
      instant_power: {
        host: config.smartMeterHost,
        eoj: "0x028801",
        epc: "0xE7",
        name: "smart_meter_instant_power",
        raw: power.raw,
        value: raw ? raw.readIntBE(0, raw.length) : null,
        unit: "W",
        human: raw ? `${raw.readIntBE(0, raw.length)} W` : null,
      },
    };
  } catch (err) {
    return {
      configured: true,
      host: config.smartMeterHost,
      error: err.message,
    };
  }
}

async function readMeterStatus(config) {
  if (!config.meterHost || isDocumentationHost(config.meterHost)) {
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

async function readAllStatus() {
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
  const [energy, smartMeter, meter, mode, dischargeLimit, chargeWindow, dischargeWindow, vendor] = await Promise.all([
    batteryConfigured ? safeCli("energy-status", energyArgs) : Promise.resolve({ battery: { configured: false } }),
    readSmartMeterStatus(config),
    readMeterStatus(config),
    batteryConfigured ? safeCli("vendor-profile", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" }),
    batteryConfigured ? settingWithCache(config, "discharge_limit", () => safeCli("discharge-limit", { host: config.batteryHost })) : Promise.resolve(skippedSetting),
    batteryConfigured ? settingWithCache(config, "osaifu_charge_window", () => safeCli("osaifu-charge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting),
    batteryConfigured ? settingWithCache(config, "osaifu_discharge_window", () => safeCli("osaifu-discharge-window", { host: config.batteryHost })) : Promise.resolve(skippedSetting),
    batteryConfigured ? safeCli("dump-vendor", { host: config.batteryHost }) : Promise.resolve({ error: "battery host is not configured" }),
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

  const chargeWindowRead = await hydrateWindowRaw(chargeWindow, "0xF4");
  const dischargeWindowRead = await hydrateWindowRaw(dischargeWindow, "0xF5");
  const status = {
    hosts: {
      battery: config.batteryHost,
      smart_meter: config.smartMeterHost || null,
      meter: config.meterHost || null,
      solar: config.solarEnabled ? config.solarHost : null,
      fuel_cells: config.fuelCellEnabled ? config.fuelCellHosts : [],
    },
    features: {
      solarEnabled: config.solarEnabled,
      fuelCellEnabled: config.fuelCellEnabled,
      rateMode: config.rateMode,
      offPeakSavingsEnabled: config.offPeakSavingsEnabled,
    },
    energy,
    smart_meter: smartMeter,
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

async function runDueSchedules() {
  const schedules = await readSchedules();
  const now = new Date();
  let changed = false;
  for (const schedule of schedules) {
    if (!isDue(schedule, now)) continue;
    schedule.running = true;
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
      schedule.running = false;
      changed = true;
      await writeSchedules(schedules);
    }
  }
  if (changed) await writeSchedules(schedules);
}

function cleanAutomationRule(input = {}) {
  const conditions = input.conditions ?? {};
  const log = Array.isArray(input.log) ? input.log.slice(-100) : [];
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
    lastResult: input.lastResult ?? null,
    state: input.state && typeof input.state === "object" ? input.state : {},
    log,
  };
}

function automationDemandWatts(status, source) {
  if (source === "gridImportW") return Number(status.meter?.grid_import_power?.value);
  return Number(status.meter?.house_demand_power?.value);
}

function batteryOperationMode(status) {
  return status.energy?.battery?.operation_mode?.value
    ?? status.energy?.battery?.operation_mode?.human
    ?? null;
}

function batteryChargingWatts(status) {
  const watts = Number(status.energy?.battery?.instant_power?.value);
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

function appendAutomationLog(rule, message, at = new Date()) {
  rule.log = [
    ...(Array.isArray(rule.log) ? rule.log : []),
    { at: at.toISOString(), message },
  ].slice(-100);
}

function automationDemandLabel(source) {
  return source === "gridImportW" ? "Grid Import" : "House demand";
}

async function evaluateAutomationRule(rule, status, now = new Date()) {
  if (!rule.enabled) return { changed: false, result: { skipped: "disabled" } };
  if (rule.type !== "backup-demand-guard") return { changed: false, result: { skipped: "unknown rule type" } };

  const operationMode = batteryOperationMode(status);
  const demandW = automationDemandWatts(status, rule.conditions.source);
  if (!Number.isFinite(demandW)) return { changed: false, result: { skipped: "demand unavailable" } };

  const breakerLimitW = Math.max(0, (rule.conditions.breakerAmps - rule.conditions.reserveAmps) * rule.conditions.breakerVoltage);
  const batteryChargingW = batteryChargingWatts(status);
  const actualDemandWithChargingW = Number.isFinite(batteryChargingW) ? demandW + batteryChargingW : null;
  const guardDemandW = rule.conditions.source === "gridImportW" ? demandW : actualDemandWithChargingW;
  const estimatedRestoredDemandW = demandW + rule.conditions.batteryChargingEstimateW;
  const restoreLimitW = rule.conditions.restoreBelowAmps * rule.conditions.breakerVoltage;
  const demandLabel = automationDemandLabel(rule.conditions.source);

  if (operationMode === "auto" && guardDemandW !== null && batteryChargingW > 0 && guardDemandW >= breakerLimitW) {
    if (!canRunAutomation(rule, now)) return { changed: false, result: { skipped: "cooldown" } };
    const result = await executeAction(rule.action, rule.payload);
    appendAutomationLog(
      rule,
      `${demandLabel} (${formatWatts(guardDemandW)}) exceeds Charge Demand Guard limit (${formatWatts(breakerLimitW)}), setting operation mode from ${operationMode} to Standby`,
      now,
    );
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
      const result = await executeAction(rule.restoreAction, rule.restorePayload);
      appendAutomationLog(
        rule,
        `${demandLabel} (${formatWatts(demandW)}) now below Guard restore limit (${formatWatts(restoreLimitW)}), setting operation mode to Auto`,
        now,
      );
      rule.state = { ...rule.state, awaitingRestore: false, restoreSince: null };
      rule.lastResult = { ok: true, at: now.toISOString(), kind: "restore", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW, result };
      return { changed: true, result: rule.lastResult };
    }
    return { changed: true, result: { skipped: "waiting for restore delay", demandW, estimatedRestoredDemandW, breakerLimitW, restoreLimitW } };
  }

  if (rule.state?.awaitingRestore && demandW > restoreLimitW) {
    if (rule.lastResult?.skipped !== "restore demand still high") {
      appendAutomationLog(
        rule,
        `${demandLabel} (${formatWatts(demandW)}) still exceeds Guard restore limit (${formatWatts(restoreLimitW)}), maintaining Standby operation mode`,
        now,
      );
    }
    rule.state = { ...rule.state, restoreSince: null };
    return { changed: true, result: { skipped: "restore demand still high", demandW, restoreLimitW } };
  }

  return { changed: false, result: { skipped: "conditions not met", operationMode, demandW, batteryChargingW, actualDemandWithChargingW, guardDemandW, estimatedRestoredDemandW, breakerLimitW } };
}

async function runAutomationRules() {
  const rules = await readAutomationRules();
  if (!rules.some((rule) => rule.enabled)) return;
  const status = await readAllStatus();
  const now = new Date();
  let changed = false;
  for (const rule of rules) {
    try {
      const result = await evaluateAutomationRule(rule, status, now);
      changed = changed || result.changed;
      if (!result.result?.skipped) continue;
      rule.lastResult = { ok: true, at: now.toISOString(), ...result.result };
      changed = true;
    } catch (err) {
      rule.lastResult = { ok: false, at: now.toISOString(), error: err.message };
      changed = true;
    }
    rule.updatedAt = now.toISOString();
  }
  if (changed) await writeAutomationRules(rules);
}

function inferDevice(instances) {
  const set = new Set(instances.map((item) => String(item).toLowerCase().slice(0, 4)));
  const roles = [];
  if (set.has("027d")) roles.push("Battery");
  if (set.has("0279")) roles.push("Solar generation");
  if (set.has("0287")) roles.push("Home power meter");
  if (set.has("0288")) roles.push("Utility meter");
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
    config.smartMeterHost,
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

async function activeScanSubnets(subnets, timeoutMs, progress = () => {}) {
  // Broadcast discovery is polite but not always reliable through controllers or
  // Docker networking, so this optional scan pokes each /24 address directly.
  const socket = dgram.createSocket("udp4");
  const tidToHost = new Map();
  const found = {};
  let tid = 1;
  const hosts = subnets.flatMap(ipRangeFromCidr);
  let scanned = 0;

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(3610, "0.0.0.0", resolve);
  });

  socket.on("message", (msg, rinfo) => {
    const parsed = parseInstanceListResponse(msg);
    if (!parsed) return;
    const host = tidToHost.get(parsed.tid) ?? rinfo.address;
    found[host] = found[host] ?? { all_instances: [], storage_battery_instances: [] };
    for (const instance of parsed.instances) {
      if (!found[host].all_instances.includes(instance)) found[host].all_instances.push(instance);
      if (instance.startsWith("027d")) {
        const batteryInstance = Number.parseInt(instance.slice(4, 6), 16);
        if (!found[host].storage_battery_instances.includes(batteryInstance)) {
          found[host].storage_battery_instances.push(batteryInstance);
        }
      }
    }
    progress({ found: Object.keys(found).length });
  });

  progress({ phase: "active-scan", total: hosts.length, scanned: 0, found: 0 });
  for (const host of hosts) {
    tid = (tid % 0xfffe) + 1;
    tidToHost.set(tid, host);
    socket.send(instanceListRequest(tid), 3610, host, () => {});
    scanned += 1;
    if (scanned === hosts.length || scanned % 8 === 0) {
      progress({ phase: "active-scan", total: hosts.length, scanned, found: Object.keys(found).length });
    }
  }

  progress({ phase: "waiting", total: hosts.length, scanned, found: Object.keys(found).length });
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  socket.close();
  return found;
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
    if (instances.some((item) => item.toLowerCase().startsWith("0287"))) next.meterHost = host;
    if (instances.some((item) => item.toLowerCase().startsWith("0288"))) next.smartMeterHost = host;
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
  if (mode === "active") {
    const subnets = normalizeSubnets(requestedSubnets).length
      ? normalizeSubnets(requestedSubnets)
      : network.userSubnets.length
        ? network.userSubnets
        : network.configuredSubnets.length
          ? network.configuredSubnets
          : network.containerSubnets;
    const devices = await activeScanSubnets(
      subnets,
      Math.max(1000, scanTimeout * 1000),
      (patch) => progress({ ...patch, network }),
    );
    return discoveryResult(devices, network, config);
  }

  progress({ phase: "broadcast", total: 1, scanned: 0, found: 0, network });
  const devices = await runCliQueued("discover", { timeout: scanTimeout });
  progress({ phase: "broadcast", total: 1, scanned: 1, found: Object.keys(devices).length, network });
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
  discoverDevices(timeout, mode, (patch) => updateDiscoveryJob(job, patch), subnets)
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
    runAutomationRules().catch((err) => logDetailedError("automation", err));
  }, 30000);
  runDueSchedules().catch((err) => logDetailedError("scheduler", err));
  runAutomationRules().catch((err) => logDetailedError("automation", err));
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
    return json(res, 200, await discoverDevices(body.timeout, body.mode, () => {}, body.subnets));
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
    return json(res, 200, await readAllStatus());
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    const config = await readConfig();
    return json(res, 200, await readHistoryRange(url.searchParams.get("start"), url.searchParams.get("end"), config));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/settings/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/settings/", "");
    return json(res, 200, await executeAction(action, body));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const body = await readBody(req);
    const action = url.pathname.replace("/api/actions/", "");
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
    return json(res, 201, rule);
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/automation-rules/")) {
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const rules = await readAutomationRules();
    const index = rules.findIndex((item) => item.id === id);
    if (index < 0) return json(res, 404, { error: "automation rule not found" });
    rules[index] = cleanAutomationRule({ ...rules[index], ...body, id, updatedAt: new Date().toISOString() });
    await writeAutomationRules(rules);
    return json(res, 200, rules[index]);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/automation-rules/")) {
    const id = url.pathname.split("/").pop();
    const rules = await readAutomationRules();
    const next = rules.filter((item) => item.id !== id);
    await writeAutomationRules(next);
    return json(res, 200, { ok: next.length !== rules.length });
  }
  if (req.method === "POST" && url.pathname === "/api/schedules") {
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
  cleanAutomationRule,
  cleanConfig,
  evaluateAutomationRule,
  normalizeRateBands,
  normalizeSubnets,
  rateForTimestamp,
  sampleFromStatus,
  summarizeSamples,
};

async function main() {
  await ensureDataDir();
  startScheduler();
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
  server.close(() => process.exit(0));
});
