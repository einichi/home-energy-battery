import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

export const DEFAULT_NOTIFICATION_TRIGGERS = {
  guardActivated: { enabled: true, cooldownMinutes: 15 },
  guardRestored: { enabled: true, cooldownMinutes: 5 },
  scheduleFailed: { enabled: true, cooldownMinutes: 30 },
  deviceOffline: { enabled: true, cooldownMinutes: 60 },
  deviceRecovered: { enabled: true, cooldownMinutes: 5 },
  plannerUnavailable: { enabled: true, cooldownMinutes: 60 },
  plannerRecovered: { enabled: true, cooldownMinutes: 5 },
  plannerWindowShortfall: { enabled: true, cooldownMinutes: 30 },
  lowBattery: { enabled: false, cooldownMinutes: 120, thresholdPercent: 20 },
};

export const DEFAULT_NOTIFICATION_CONFIG = {
  enabled: false,
  channels: [
    {
      id: "primary-email",
      type: "smtp",
      enabled: true,
      settings: {
        host: "",
        port: 587,
        security: "starttls",
        username: "",
        from: "",
        recipients: [],
      },
    },
  ],
  triggers: DEFAULT_NOTIFICATION_TRIGGERS,
};

const DELIVERY_LIMIT = 100;
const ONCE_KEY_LIMIT = 500;
const VALID_SECURITY = new Set(["tls", "starttls", "none"]);
const EMAIL_PATTERN = /^[^<>\s@]+@[^<>\s@]+$/;

function boolValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function stringList(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeSmtpChannel(value = {}) {
  const settings = value.settings ?? value;
  const security = VALID_SECURITY.has(settings.security) ? settings.security : "starttls";
  return {
    id: String(value.id || "primary-email").trim() || "primary-email",
    type: "smtp",
    enabled: boolValue(value.enabled, true),
    settings: {
      host: String(settings.host ?? "").trim(),
      port: Math.round(boundedNumber(settings.port, security === "tls" ? 465 : 587, 1, 65535)),
      security,
      username: String(settings.username ?? "").trim(),
      from: String(settings.from ?? "").trim(),
      recipients: stringList(settings.recipients),
    },
  };
}

export function normalizeNotificationConfig(value = {}) {
  const sourceChannels = Array.isArray(value.channels) ? value.channels : [];
  const smtpSource = sourceChannels.find((channel) => channel?.type === "smtp")
    ?? value.smtp
    ?? DEFAULT_NOTIFICATION_CONFIG.channels[0];
  const triggers = {};
  for (const [id, defaults] of Object.entries(DEFAULT_NOTIFICATION_TRIGGERS)) {
    const input = value.triggers?.[id] ?? {};
    triggers[id] = {
      enabled: boolValue(input.enabled, defaults.enabled),
      cooldownMinutes: Math.round(boundedNumber(input.cooldownMinutes, defaults.cooldownMinutes, 1, 10080)),
      ...(id === "lowBattery" ? {
        thresholdPercent: Math.round(boundedNumber(input.thresholdPercent, defaults.thresholdPercent, 1, 95)),
      } : {}),
    };
  }
  return {
    enabled: boolValue(value.enabled, DEFAULT_NOTIFICATION_CONFIG.enabled),
    channels: [normalizeSmtpChannel(smtpSource)],
    triggers,
  };
}

export function validateSmtpSettings(settings = {}, { password = "" } = {}) {
  const errors = [];
  if (!settings.host) errors.push("SMTP host is required");
  if (!Number.isInteger(Number(settings.port)) || Number(settings.port) < 1 || Number(settings.port) > 65535) {
    errors.push("SMTP port must be from 1 to 65535");
  }
  if (!VALID_SECURITY.has(settings.security)) errors.push("SMTP security mode is invalid");
  if (!settings.from || !EMAIL_PATTERN.test(settings.from)) errors.push("A valid From address is required");
  if (!Array.isArray(settings.recipients) || !settings.recipients.length) {
    errors.push("At least one recipient is required");
  } else if (settings.recipients.some((address) => !EMAIL_PATTERN.test(address))) {
    errors.push("Every recipient must be a valid email address");
  }
  if (password && !settings.username) errors.push("SMTP username is required when a password is configured");
  return errors;
}

export function smtpTransportOptions(settings = {}, secrets = {}) {
  const options = {
    host: settings.host,
    port: Number(settings.port),
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: true },
  };
  if (settings.username) {
    options.auth = { user: settings.username, pass: secrets.password ?? "" };
  }
  return options;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendSmtpNotification(channel, secrets, event, createTransport = nodemailer.createTransport) {
  const settings = channel.settings;
  const errors = validateSmtpSettings(settings, secrets);
  if (errors.length) throw new Error(errors.join("; "));
  const transport = createTransport(smtpTransportOptions(settings, secrets));
  const occurredAt = new Date(event.occurredAt ?? Date.now());
  const subject = `[Home Energy] ${event.title}`;
  const text = `${event.message}\n\nTime: ${occurredAt.toLocaleString("en-GB")}`;
  const htmlMessage = htmlEscape(event.message).replaceAll("\n", "<br>");
  const html = `<p>${htmlMessage}</p><p><strong>Time:</strong> ${htmlEscape(occurredAt.toLocaleString("en-GB"))}</p>`;
  try {
    const result = await transport.sendMail({
      from: settings.from,
      to: settings.recipients.join(", "),
      subject,
      text,
      html,
    });
    return { messageId: result.messageId ?? null, response: result.response ?? null };
  } finally {
    if (typeof transport.close === "function") transport.close();
  }
}

function cleanNotificationState(value = {}) {
  return {
    observations: value.observations && typeof value.observations === "object" ? value.observations : {},
    triggerAttempts: value.triggerAttempts && typeof value.triggerAttempts === "object" ? value.triggerAttempts : {},
    sentOnceKeys: (Array.isArray(value.sentOnceKeys) ? value.sentOnceKeys : []).map(String).slice(-ONCE_KEY_LIMIT),
    deliveries: (Array.isArray(value.deliveries) ? value.deliveries : []).slice(-DELIVERY_LIMIT),
  };
}

function recoverLatestJsonDocument(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") starts.push(index);
  }
  for (const start of starts.reverse()) {
    try {
      const value = JSON.parse(text.slice(start));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Keep looking for the final complete state document.
    }
  }
  return null;
}

async function readJson(file, fallback, { recoverState = false } = {}) {
  try {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (cause) {
      if (recoverState) {
        const recovered = recoverLatestJsonDocument(text);
        if (recovered) return recovered;
      }
      throw new Error(`Failed to parse JSON from ${file}: ${cause.message}`, { cause });
    }
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value, mode = null) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(temporary, file);
  if (mode) await chmod(file, mode);
}

function cleanEvent(event = {}) {
  return {
    type: String(event.type || "notification"),
    severity: ["info", "warning", "error"].includes(event.severity) ? event.severity : "info",
    title: String(event.title || "Home Energy notification"),
    message: String(event.message || ""),
    occurredAt: new Date(event.occurredAt ?? Date.now()).toISOString(),
    dedupeKey: String(event.dedupeKey || event.type || "notification"),
    once: event.once === true,
  };
}

export function createNotificationService({ dataDir, getConfig, createTransport, providers = {} } = {}) {
  const secretsFile = path.join(dataDir, "notification-secrets.json");
  const stateFile = path.join(dataDir, "notification-state.json");
  let queue = Promise.resolve();
  const providerRegistry = new Map([
    ["smtp", {
      send: (channel, secrets, event) => sendSmtpNotification(channel, secrets, event, createTransport),
    }],
    ...Object.entries(providers),
  ]);

  async function readSecrets() {
    const value = await readJson(secretsFile, { channels: {} });
    return value?.channels && typeof value.channels === "object" ? value : { channels: {} };
  }

  async function readState() {
    return cleanNotificationState(await readJson(stateFile, {}, { recoverState: true }));
  }

  async function writeState(state) {
    const cleaned = cleanNotificationState(state);
    await writeJsonAtomic(stateFile, cleaned);
    return cleaned;
  }

  async function updateSecret({ channelId = "primary-email", password, clearPassword = false } = {}) {
    if (password === undefined && !clearPassword) return;
    const secrets = await readSecrets();
    const channels = { ...secrets.channels };
    if (clearPassword) delete channels[channelId];
    else if (password !== "") channels[channelId] = { password: String(password) };
    await writeJsonAtomic(secretsFile, { channels }, 0o600);
  }

  async function deliver(rawEvent, { force = false } = {}) {
    const event = cleanEvent(rawEvent);
    const config = normalizeNotificationConfig((await getConfig()).notifications);
    const trigger = config.triggers[event.type];
    const state = await readState();
    if (!force && (!config.enabled || !trigger?.enabled)) return { skipped: "disabled" };
    if (event.once && state.sentOnceKeys.includes(event.dedupeKey)) return { skipped: "already sent" };
    const attempt = state.triggerAttempts[event.dedupeKey];
    const cooldownMinutes = trigger?.cooldownMinutes ?? 1;
    if (!force && attempt?.at
      && Date.now() - new Date(attempt.at).getTime() < cooldownMinutes * 60_000) {
      return { skipped: "cooldown" };
    }

    const secrets = await readSecrets();
    const channels = config.channels.filter((channel) => channel.enabled);
    if (!channels.length) throw new Error("No notification channels are enabled");
    const attempts = [];
    for (const channel of channels) {
      const startedAt = new Date();
      try {
        const provider = providerRegistry.get(channel.type);
        if (!provider) throw new Error(`Unsupported notification provider: ${channel.type}`);
        const result = await provider.send(channel, secrets.channels?.[channel.id] ?? {}, event);
        attempts.push({ channelId: channel.id, ok: true, at: startedAt.toISOString(), result });
      } catch (error) {
        attempts.push({ channelId: channel.id, ok: false, at: startedAt.toISOString(), error: error.message });
      }
    }
    const ok = attempts.some((attemptItem) => attemptItem.ok);
    state.triggerAttempts[event.dedupeKey] = { at: new Date().toISOString(), ok };
    if (ok && event.once) state.sentOnceKeys.push(event.dedupeKey);
    state.deliveries.push({ event, ok, attempts, at: new Date().toISOString() });
    await writeState(state);
    if (!ok) throw new Error(attempts.map((attemptItem) => attemptItem.error).filter(Boolean).join("; "));
    return { ok, attempts };
  }

  function enqueue(event, options = {}) {
    queue = queue
      .then(() => deliver(event, options))
      .catch((error) => console.error(`notifications: ${error.stack || error.message}`));
    return queue;
  }

  function observeCondition({
    key,
    active,
    activateAfter = 1,
    recoverAfter = 1,
    activeEvent,
    recoveryEvent,
  }) {
    queue = queue.then(async () => {
      const config = normalizeNotificationConfig((await getConfig()).notifications);
      const state = await readState();
      const observation = state.observations[key] ?? { active: false, activeCount: 0, recoveryCount: 0 };
      if (!config.enabled) {
        if (state.observations[key]) {
          delete state.observations[key];
          await writeState(state);
        }
        return;
      }
      if (active && !observation.active && activeEvent
        && config.triggers[activeEvent.type]?.enabled === false) {
        observation.activeCount = 0;
        state.observations[key] = observation;
        await writeState(state);
        return;
      }
      if (!active && !observation.active) {
        if (observation.activeCount > 0) {
          observation.activeCount = 0;
          observation.recoveryCount = 0;
          state.observations[key] = observation;
          await writeState(state);
        }
        return;
      }
      if (active && observation.active) {
        if (observation.notified !== false || !activeEvent) return;
        const result = await deliver(activeEvent);
        if (result.ok) {
          const latestState = await readState();
          latestState.observations[key] = {
            ...(latestState.observations[key] ?? observation),
            notified: true,
          };
          await writeState(latestState);
        }
        return;
      }
      if (active) {
        observation.activeCount += 1;
        observation.recoveryCount = 0;
        if (!observation.active && observation.activeCount >= activateAfter) {
          observation.active = true;
          observation.notified = !activeEvent;
          observation.changedAt = new Date().toISOString();
          state.observations[key] = observation;
          await writeState(state);
          if (activeEvent) {
            const result = await deliver(activeEvent);
            if (result.ok) {
              const latestState = await readState();
              latestState.observations[key] = {
                ...(latestState.observations[key] ?? observation),
                notified: true,
              };
              await writeState(latestState);
            }
          }
          return;
        }
      } else {
        observation.recoveryCount += 1;
        observation.activeCount = 0;
        if (observation.active && observation.recoveryCount >= recoverAfter) {
          observation.active = false;
          observation.notified = false;
          observation.changedAt = new Date().toISOString();
          state.observations[key] = observation;
          await writeState(state);
          if (recoveryEvent) await deliver(recoveryEvent);
          return;
        }
      }
      state.observations[key] = observation;
      await writeState(state);
    }).catch((error) => console.error(`notifications: ${error.stack || error.message}`));
    return queue;
  }

  async function view(configInput = null) {
    const config = normalizeNotificationConfig((configInput ?? await getConfig()).notifications);
    const secrets = await readSecrets();
    const state = await readState();
    const smtpChannel = config.channels.find((channel) => channel.type === "smtp");
    return {
      config,
      passwordConfigured: Boolean(secrets.channels?.[smtpChannel?.id]?.password),
      deliveries: [...state.deliveries].reverse(),
    };
  }

  async function sendTest() {
    return deliver({
      type: "test",
      severity: "info",
      title: "Test notification",
      message: "SMTP notifications are configured correctly.",
      dedupeKey: `test:${Date.now()}`,
    }, { force: true });
  }

  return { deliver, enqueue, observeCondition, sendTest, updateSecret, view };
}
