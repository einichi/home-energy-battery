import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

export const DEFAULT_NOTIFICATION_TRIGGERS: Record<string, any> = {
  guardActivated: { enabled: true, cooldownMinutes: 15 },
  guardRestored: { enabled: true, cooldownMinutes: 5 },
  scheduleFailed: { enabled: true, cooldownMinutes: 30 },
  deviceOffline: { enabled: true, cooldownMinutes: 60 },
  deviceRecovered: { enabled: true, cooldownMinutes: 5 },
  adaptiveChargingUnavailable: { enabled: true, cooldownMinutes: 60 },
  adaptiveChargingRecovered: { enabled: true, cooldownMinutes: 5 },
  adaptiveChargingWindowShortfall: { enabled: true, cooldownMinutes: 30 },
  fuelCellHotWaterEmpty: { enabled: true, cooldownMinutes: 60 },
  lowBattery: { enabled: false, cooldownMinutes: 120, thresholdPercent: 20 },
};

export const DEFAULT_NOTIFICATION_CONFIG: Record<string, any> = {
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

function boolValue(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function boundedNumber(value: any, fallback: any, min: any, max: any): any {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function stringList(value: any): any {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(source.map((item: any) => String(item).trim()).filter(Boolean))];
}

function normalizeSmtpChannel(value: any = {}): any {
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

export function normalizeNotificationConfig(value: any = {}): any {
  const sourceChannels = Array.isArray(value.channels) ? value.channels : [];
  const smtpSource = sourceChannels.find((channel: any) => channel?.type === "smtp")
    ?? value.smtp
    ?? DEFAULT_NOTIFICATION_CONFIG.channels[0];
  const triggers: Record<string, any> = {};
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

export function validateSmtpSettings(settings: any = {}, { password = "" }: any = {}): any {
  const errors: any[] = [];
  if (!settings.host) errors.push("SMTP host is required");
  if (!Number.isInteger(Number(settings.port)) || Number(settings.port) < 1 || Number(settings.port) > 65535) {
    errors.push("SMTP port must be from 1 to 65535");
  }
  if (!VALID_SECURITY.has(settings.security)) errors.push("SMTP security mode is invalid");
  if (!settings.from || !EMAIL_PATTERN.test(settings.from)) errors.push("A valid From address is required");
  if (!Array.isArray(settings.recipients) || !settings.recipients.length) {
    errors.push("At least one recipient is required");
  } else if (settings.recipients.some((address: any) => !EMAIL_PATTERN.test(address))) {
    errors.push("Every recipient must be a valid email address");
  }
  if (password && !settings.username) errors.push("SMTP username is required when a password is configured");
  return errors;
}

export function smtpTransportOptions(settings: any = {}, secrets: any = {}): any {
  const options: Record<string, any> = {
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

function htmlEscape(value: any): any {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendSmtpNotification(channel: any, secrets: any, event: any, createTransport: any = nodemailer.createTransport): Promise<any> {
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

function cleanNotificationState(value: any = {}): any {
  return {
    observations: value.observations && typeof value.observations === "object" ? value.observations : {},
    triggerAttempts: value.triggerAttempts && typeof value.triggerAttempts === "object" ? value.triggerAttempts : {},
    sentOnceKeys: (Array.isArray(value.sentOnceKeys) ? value.sentOnceKeys : []).map(String).slice(-ONCE_KEY_LIMIT),
    deliveries: (Array.isArray(value.deliveries) ? value.deliveries : []).slice(-DELIVERY_LIMIT),
  };
}

async function readJson(file: any, fallback: any): Promise<any> {
  try {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (cause: any) {
      throw new Error(`Failed to parse JSON from ${file}: ${cause.message}`, { cause });
    }
  } catch (error: any) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: any, value: any, mode: any = null): Promise<any> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(temporary, file);
  if (mode) await chmod(file, mode);
}

function cleanEvent(event: any = {}): any {
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

export function createNotificationService({ dataDir, getConfig, createTransport, providers = {}, recordEvent, stateStore }: any = {}): any {
  const secretsFile = path.join(dataDir, "notification-secrets.json");
  if (!stateStore?.isReady || !stateStore?.read || !stateStore?.write) {
    throw new TypeError("stateStore with isReady(), read(), and write() is required");
  }
  let queue = Promise.resolve();
  const providerRegistry = new Map([
    ["smtp", {
      send: (channel: any, secrets: any, event: any) => sendSmtpNotification(channel, secrets, event, createTransport),
    }],
    ...Object.entries(providers),
  ]);

  async function readSecrets(): Promise<any> {
    const value = await readJson(secretsFile, { channels: {} });
    return value?.channels && typeof value.channels === "object" ? value : { channels: {} };
  }

  async function readState(): Promise<any> {
    if (!stateStore.isReady()) throw new Error("Notification state storage is not initialized");
    return cleanNotificationState(stateStore.read("notificationState", {}));
  }

  async function writeState(state: any): Promise<any> {
    const cleaned = cleanNotificationState(state);
    if (!stateStore.isReady()) throw new Error("Notification state storage is not initialized");
    stateStore.write("notificationState", cleaned);
    return cleaned;
  }

  async function updateSecret({ channelId = "primary-email", password, clearPassword = false }: any = {}): Promise<any> {
    if (password === undefined && !clearPassword) return;
    const secrets = await readSecrets();
    const channels: Record<string, any> = { ...secrets.channels };
    if (clearPassword) delete channels[channelId];
    else if (password !== "") channels[channelId] = { password: String(password) };
    await writeJsonAtomic(secretsFile, { channels }, 0o600);
  }

  async function deliver(rawEvent: any, { force = false }: any = {}): Promise<any> {
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
    const channels = config.channels.filter((channel: any) => channel.enabled);
    if (!channels.length) throw new Error("No notification channels are enabled");
    const attempts: any[] = [];
    for (const channel of channels) {
      const startedAt = new Date();
      try {
        const provider: any = providerRegistry.get(channel.type);
        if (!provider) throw new Error(`Unsupported notification provider: ${channel.type}`);
        const result = await provider.send(channel, secrets.channels?.[channel.id] ?? {}, event);
        attempts.push({ channelId: channel.id, ok: true, at: startedAt.toISOString(), result });
      } catch (error: any) {
        attempts.push({ channelId: channel.id, ok: false, at: startedAt.toISOString(), error: error.message });
      }
    }
    const ok = attempts.some((attemptItem: any) => attemptItem.ok);
    state.triggerAttempts[event.dedupeKey] = { at: new Date().toISOString(), ok };
    if (ok && event.once) state.sentOnceKeys.push(event.dedupeKey);
    const deliveredAt = new Date().toISOString();
    state.deliveries.push({ event, ok, attempts, at: deliveredAt });
    await writeState(state);
    await recordEvent?.({
      eventKey: `notification:${event.dedupeKey}:${deliveredAt}`,
      at: deliveredAt,
      category: "notification",
      type: ok ? "delivered" : "failed",
      message: event.message,
      payload: { event, attempts },
    });
    if (!ok) throw new Error(attempts.map((attemptItem: any) => attemptItem.error).filter(Boolean).join("; "));
    return { ok, attempts };
  }

  function enqueue(event: any, options: any = {}): any {
    queue = queue
      .then(() => deliver(event, options))
      .catch((error: any) => console.error(`notifications: ${error.stack || error.message}`));
    return queue;
  }

  function observeCondition({
    key,
    active,
    activateAfter = 1,
    recoverAfter = 1,
    activeEvent,
    recoveryEvent,
  }: any): any {
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
    }).catch((error: any) => console.error(`notifications: ${error.stack || error.message}`));
    return queue;
  }

  async function view(configInput: any = null): Promise<any> {
    const config = normalizeNotificationConfig((configInput ?? await getConfig()).notifications);
    const secrets = await readSecrets();
    const state = await readState();
    const smtpChannel = config.channels.find((channel: any) => channel.type === "smtp");
    return {
      config,
      passwordConfigured: Boolean(secrets.channels?.[smtpChannel?.id]?.password),
      deliveries: [...state.deliveries].reverse(),
    };
  }

  async function sendTest(): Promise<any> {
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
