#!/usr/bin/env node
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
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
  standardRateYenPerKwh: 35,
  offPeakRateYenPerKwh: 25,
  offPeakSavingsEnabled: false,
  language: "en",
};

let cliQueue = Promise.resolve();
let scheduleTimer = null;
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
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`CLI returned non-JSON output: ${stdout.trim()}`));
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
  const standardRate = config.standardRateYenPerKwh;
  const offPeakRate = config.offPeakRateYenPerKwh;
  const deltaHours = previousSample
    ? Math.max(0, Math.min(1, (new Date(timestamp).getTime() - new Date(previousSample.timestamp).getTime()) / 3_600_000))
    : 0;
  const offPeakSavingW = config.offPeakSavingsEnabled && batteryPowerW > 0 && !(solarPowerW > 0) ? batteryPowerW : 0;
  const offPeakSavingYen = deltaHours * (offPeakSavingW / 1000) * Math.max(0, standardRate - offPeakRate);
  const solarSavingYen = deltaHours * (Math.max(0, solarPowerW ?? 0) / 1000) * standardRate;
  return {
    timestamp,
    batteryPowerW,
    stateOfChargePercent,
    solarPowerW,
    houseDemandW,
    fuelCellPowerW,
    gridExportW,
    gridImportW,
    offPeakSavingYen,
    solarSavingYen,
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

function summarizeSamples(samples) {
  return {
    sampleCount: samples.length,
    start: samples[0]?.timestamp ?? null,
    end: samples[samples.length - 1]?.timestamp ?? null,
    offPeakSavingYen: samples.reduce((sum, sample) => sum + Number(sample.offPeakSavingYen ?? 0), 0),
    solarSavingYen: samples.reduce((sum, sample) => sum + Number(sample.solarSavingYen ?? 0), 0),
  };
}

async function readHistoryRange(start, end) {
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
  const samples = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((sample) => {
      const time = new Date(sample.timestamp).getTime();
      return time >= startMs && time <= endMs;
    });
  return { samples, summary: summarizeSamples(samples) };
}

async function readSchedules() {
  await ensureDataDir();
  try {
    const text = await readFile(SCHEDULES_FILE, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeSchedules(schedules) {
  await ensureDataDir();
  await writeFile(SCHEDULES_FILE, `${JSON.stringify(schedules, null, 2)}\n`);
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

function cleanConfig(input = {}) {
  // Config can arrive from old files, forms, or hand-edited JSON. Normalize it
  // here so the rest of the server can assume stable types.
  return {
    batteryHost: String(input.batteryHost ?? DEFAULT_CONFIG.batteryHost).trim(),
    smartMeterHost: String(input.smartMeterHost ?? DEFAULT_CONFIG.smartMeterHost).trim(),
    meterHost: String(input.meterHost ?? DEFAULT_CONFIG.meterHost).trim(),
    meterEoj: String(input.meterEoj ?? DEFAULT_CONFIG.meterEoj).trim() || DEFAULT_CONFIG.meterEoj,
    solarHost: String(input.solarHost ?? input.batteryHost ?? DEFAULT_CONFIG.solarHost).trim(),
    solarEnabled: configBool(input.solarEnabled, DEFAULT_CONFIG.solarEnabled),
    fuelCellHosts: normalizeHostList(input.fuelCellHosts ?? DEFAULT_CONFIG.fuelCellHosts),
    fuelCellEnabled: configBool(input.fuelCellEnabled, DEFAULT_CONFIG.fuelCellEnabled),
    standardRateYenPerKwh: configNumber(input.standardRateYenPerKwh, DEFAULT_CONFIG.standardRateYenPerKwh),
    offPeakRateYenPerKwh: configNumber(input.offPeakRateYenPerKwh, DEFAULT_CONFIG.offPeakRateYenPerKwh),
    offPeakSavingsEnabled: configBool(input.offPeakSavingsEnabled, DEFAULT_CONFIG.offPeakSavingsEnabled),
    language: ["en", "ja"].includes(input.language) ? input.language : DEFAULT_CONFIG.language,
  };
}

async function readConfig() {
  await ensureDataDir();
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    return cleanConfig({ ...DEFAULT_CONFIG, ...JSON.parse(text) });
  } catch (err) {
    if (err.code === "ENOENT") return cleanConfig(DEFAULT_CONFIG);
    throw err;
  }
}

async function writeConfig(config) {
  const cleaned = cleanConfig({ ...DEFAULT_CONFIG, ...config });
  await ensureDataDir();
  await writeFile(CONFIG_FILE, `${JSON.stringify(cleaned, null, 2)}\n`);
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
  return JSON.parse(textBody);
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

async function readSmartMeterStatus(config) {
  if (!config.smartMeterHost) {
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
  if (!config.meterHost) {
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

async function readAllStatus() {
  // One dashboard refresh fans out into several short CLI calls. The queue keeps
  // node-echonet-lite from fighting itself over UDP port 3610.
  const config = await readConfig();
  const energyArgs = {
    "battery-host": config.batteryHost,
    ...(config.solarEnabled ? { "solar-host": config.solarHost } : { "no-solar": true }),
    ...(config.fuelCellEnabled ? fuelCellArgs(config.fuelCellHosts) : { "no-fuel-cell": true }),
  };
  const [energy, smartMeter, meter, mode, dischargeLimit, chargeWindow, dischargeWindow, vendor] = await Promise.all([
    runCliQueued("energy-status", energyArgs),
    readSmartMeterStatus(config),
    readMeterStatus(config),
    runCliQueued("vendor-profile", { host: config.batteryHost }),
    runCliQueued("discharge-limit", { host: config.batteryHost }),
    runCliQueued("osaifu-charge-window", { host: config.batteryHost }),
    runCliQueued("osaifu-discharge-window", { host: config.batteryHost }),
    runCliQueued("dump-vendor", { host: config.batteryHost }),
  ]);

  async function hydrateWindowRaw(windowData, epcHex) {
    // Some profile/window helpers may return null decoded data if a device is in
    // a mode where that property is unavailable. A raw-get retry gives the UI the
    // best chance to populate selectors without inventing fallback values.
    if (windowData?.raw) return windowData;
    try {
      const rawRead = await runCliQueued("raw-get", { host: config.batteryHost, eoj: "0x027D01" }, [epcHex]);
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
    standardRateYenPerKwh: config.standardRateYenPerKwh,
    offPeakRateYenPerKwh: config.offPeakRateYenPerKwh,
    offPeakSavingsEnabled: config.offPeakSavingsEnabled,
  };
  status.sample = await recordStatusSample(status, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  status.savings = (await readHistoryRange(today.toISOString(), status.read_at)).summary;
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
  return { configuredSubnets, containerSubnets: [...new Set(containerSubnets)] };
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

async function discoverDevices(timeout = 5, mode = "broadcast", progress = () => {}) {
  const config = await readConfig();
  const network = localNetworkHints(config);
  const scanTimeout = Number(timeout) || 5;
  if (mode === "active") {
    const subnets = network.containerSubnets.length ? network.containerSubnets : network.configuredSubnets;
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

function startDiscoveryJob(timeout, mode = "broadcast") {
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
  discoverDevices(timeout, mode, (patch) => updateDiscoveryJob(job, patch))
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
    runDueSchedules().catch((err) => console.error("scheduler:", err.message));
  }, 15000);
  runDueSchedules().catch((err) => console.error("scheduler:", err.message));
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await readConfig()), port: PORT });
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    return json(res, 200, { ...(await writeConfig(await readBody(req))), port: PORT });
  }
  if (req.method === "POST" && url.pathname === "/api/discovery") {
    const body = await readBody(req);
    return json(res, 200, await discoverDevices(body.timeout, body.mode));
  }
  if (req.method === "POST" && url.pathname === "/api/discovery/jobs") {
    const body = await readBody(req);
    return json(res, 202, startDiscoveryJob(body.timeout, body.mode));
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
    return json(res, 200, await readHistoryRange(url.searchParams.get("start"), url.searchParams.get("end")));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await api(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

await ensureDataDir();
startScheduler();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HOME ENERGY & BATTERY listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  if (scheduleTimer) clearInterval(scheduleTimer);
  server.close(() => process.exit(0));
});
