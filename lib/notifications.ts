import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import nodemailer from "nodemailer";
import type { ApplicationConfig } from "./contracts/configuration.js";
import {
  isSupportedSmtpPort,
  normalizeNotificationConfig,
  type NotificationChannel,
  type SmtpSettings,
} from "./domain/notification-configuration.js";

export {
  DEFAULT_NOTIFICATION_CONFIG,
  DEFAULT_NOTIFICATION_TRIGGERS,
  isSupportedSmtpPort,
  normalizeNotificationConfig,
} from "./domain/notification-configuration.js";
export type {
  NormalizedNotificationConfig,
  NotificationChannel,
  NotificationTrigger,
  SmtpSettings,
} from "./domain/notification-configuration.js";

type UnknownRecord = Record<string, unknown>;

export interface NotificationEvent {
  type: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  occurredAt: string;
  dedupeKey: string;
  once: boolean;
}

interface NotificationAttempt {
  channelId: string;
  ok: boolean;
  at: string;
  result?: unknown;
  error?: string;
}

interface NotificationObservation {
  active: boolean;
  activeCount: number;
  recoveryCount: number;
  notified?: boolean;
  changedAt?: string;
}

interface NotificationState {
  observations: Record<string, NotificationObservation>;
  triggerAttempts: Record<string, { at: string; ok: boolean }>;
  sentOnceKeys: string[];
  deliveries: Array<{ event: NotificationEvent; ok: boolean; attempts: NotificationAttempt[]; at: string }>;
}

interface NotificationSecrets {
  channels: Record<string, { password?: string }>;
}

interface MailTransport {
  sendMail(message: UnknownRecord): Promise<{ messageId?: string; response?: string }>;
  close?(): void;
}

type TransportFactory = (options: ReturnType<typeof smtpTransportOptions>) => MailTransport;
type NotificationProvider = {
  send(channel: NotificationChannel, secrets: { password?: string }, event: NotificationEvent): Promise<unknown>;
};

export interface NotificationStateStore {
  isReady(): boolean;
  read(key: "notificationState", fallback: UnknownRecord): unknown;
  write(key: "notificationState", value: UnknownRecord): unknown;
}

export interface NotificationServiceDependencies {
  dataDir: string;
  getConfig(): Promise<Pick<ApplicationConfig, "notifications">>;
  createTransport?: TransportFactory;
  providers?: Record<string, NotificationProvider>;
  recordEvent?(event: UnknownRecord): Promise<unknown> | unknown;
  stateStore: NotificationStateStore;
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

const DELIVERY_LIMIT = 100;
const ONCE_KEY_LIMIT = 500;
const VALID_SECURITY = new Set(["tls", "starttls", "none"]);
const EMAIL_PATTERN = /^[^<>\s@]+@[^<>\s@]+$/;

export function validateSmtpSettings(settings: Partial<SmtpSettings> = {}, { password = "" }: { password?: string } = {}): string[] {
  const errors: string[] = [];
  if (!settings.host) errors.push("SMTP host is required");
  if (!isSupportedSmtpPort(settings.port)) {
    errors.push("SMTP port must be 25, 465, or 587");
  }
  if (!VALID_SECURITY.has(String(settings.security ?? ""))) errors.push("SMTP security mode is invalid");
  if (!settings.from || !EMAIL_PATTERN.test(settings.from)) errors.push("A valid From address is required");
  if (!Array.isArray(settings.recipients) || !settings.recipients.length) {
    errors.push("At least one recipient is required");
  } else if (settings.recipients.some((address) => !EMAIL_PATTERN.test(address))) {
    errors.push("Every recipient must be a valid email address");
  }
  if (password && !settings.username) errors.push("SMTP username is required when a password is configured");
  return errors;
}

export function smtpTransportOptions(settings: Partial<SmtpSettings> = {}, secrets: { password?: string } = {}) {
  const port = isSupportedSmtpPort(settings.port)
    ? Number(settings.port)
    : settings.security === "tls" ? 465 : 587;
  const options: UnknownRecord = {
    host: settings.host,
    port,
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

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendSmtpNotification(
  channel: NotificationChannel,
  secrets: { password?: string },
  event: NotificationEvent,
  createTransport: TransportFactory = (options) => nodemailer.createTransport(options) as MailTransport,
) {
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

function cleanNotificationState(value: unknown = {}): NotificationState {
  const source = record(value);
  return {
    observations: record(source.observations) as NotificationState["observations"],
    triggerAttempts: record(source.triggerAttempts) as NotificationState["triggerAttempts"],
    sentOnceKeys: (Array.isArray(source.sentOnceKeys) ? source.sentOnceKeys : []).map(String).slice(-ONCE_KEY_LIMIT),
    deliveries: (Array.isArray(source.deliveries) ? source.deliveries : []).slice(-DELIVERY_LIMIT) as NotificationState["deliveries"],
  };
}

async function readJson(file: string, fallback: unknown): Promise<unknown> {
  try {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to parse JSON from ${file}: ${message}`, { cause });
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown, mode: number | null = null): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(temporary, file);
  if (mode) await chmod(file, mode);
}

function cleanEvent(event: unknown = {}): NotificationEvent {
  const source = record(event);
  const severity = String(source.severity ?? "");
  return {
    type: String(source.type || "notification"),
    severity: severity === "warning" || severity === "error" ? severity : "info",
    title: String(source.title || "Home Energy notification"),
    message: String(source.message || ""),
    occurredAt: new Date(source.occurredAt as string | number | Date | undefined ?? Date.now()).toISOString(),
    dedupeKey: String(source.dedupeKey || source.type || "notification"),
    once: source.once === true,
  };
}

export function createNotificationService({
  dataDir,
  getConfig,
  createTransport,
  providers = {},
  recordEvent,
  stateStore,
}: NotificationServiceDependencies) {
  const secretsFile = path.join(dataDir, "notification-secrets.json");
  if (!stateStore?.isReady || !stateStore?.read || !stateStore?.write) {
    throw new TypeError("stateStore with isReady(), read(), and write() is required");
  }
  let queue: Promise<unknown> = Promise.resolve();
  const providerRegistry = new Map<string, NotificationProvider>([
    ["smtp", {
      send: (channel, secrets, event) => sendSmtpNotification(channel, secrets, event, createTransport),
    }],
    ...Object.entries(providers),
  ]);

  async function readSecrets(): Promise<NotificationSecrets> {
    const value = record(await readJson(secretsFile, { channels: {} }));
    return { channels: record(value.channels) as NotificationSecrets["channels"] };
  }

  async function readState(): Promise<NotificationState> {
    if (!stateStore.isReady()) throw new Error("Notification state storage is not initialized");
    return cleanNotificationState(stateStore.read("notificationState", {}));
  }

  async function writeState(state: NotificationState): Promise<NotificationState> {
    const cleaned = cleanNotificationState(state);
    if (!stateStore.isReady()) throw new Error("Notification state storage is not initialized");
    stateStore.write("notificationState", cleaned as unknown as UnknownRecord);
    return cleaned;
  }

  async function updateSecret({
    channelId = "primary-email",
    password,
    clearPassword = false,
  }: { channelId?: string; password?: unknown; clearPassword?: boolean } = {}): Promise<void> {
    if (password === undefined && !clearPassword) return;
    const secrets = await readSecrets();
    const channels: NotificationSecrets["channels"] = { ...secrets.channels };
    if (clearPassword) delete channels[channelId];
    else if (password !== "") channels[channelId] = { password: String(password) };
    await writeJsonAtomic(secretsFile, { channels }, 0o600);
  }

  async function deliver(rawEvent: unknown, { force = false }: { force?: boolean } = {}) {
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
    const attempts: NotificationAttempt[] = [];
    for (const channel of channels) {
      const startedAt = new Date();
      try {
        const provider = providerRegistry.get(channel.type);
        if (!provider) throw new Error(`Unsupported notification provider: ${channel.type}`);
        const result = await provider.send(channel, secrets.channels?.[channel.id] ?? {}, event);
        attempts.push({ channelId: channel.id, ok: true, at: startedAt.toISOString(), result });
      } catch (error: unknown) {
        attempts.push({ channelId: channel.id, ok: false, at: startedAt.toISOString(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    const ok = attempts.some((attemptItem) => attemptItem.ok);
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
    if (!ok) throw new Error(attempts.map((attemptItem) => attemptItem.error).filter(Boolean).join("; "));
    return { ok, attempts };
  }

  function enqueue(event: unknown, options: { force?: boolean } = {}): Promise<unknown> {
    queue = queue
      .then(() => deliver(event, options))
      .catch((error: unknown) => console.error(`notifications: ${error instanceof Error ? error.stack || error.message : String(error)}`));
    return queue;
  }

  function observeCondition({
    key,
    active,
    activateAfter = 1,
    recoverAfter = 1,
    activeEvent,
    recoveryEvent,
  }: {
    key: string;
    active: boolean;
    activateAfter?: number;
    recoverAfter?: number;
    activeEvent?: unknown;
    recoveryEvent?: unknown;
  }): Promise<unknown> {
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
        && config.triggers[String(record(activeEvent).type ?? "")]?.enabled === false) {
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
    }).catch((error: unknown) => console.error(`notifications: ${error instanceof Error ? error.stack || error.message : String(error)}`));
    return queue;
  }

  async function view(configInput: Pick<ApplicationConfig, "notifications"> | null = null) {
    const config = normalizeNotificationConfig((configInput ?? await getConfig()).notifications);
    const secrets = await readSecrets();
    const state = await readState();
    const smtpChannel = config.channels.find((channel) => channel.type === "smtp");
    return {
      config,
      passwordConfigured: Boolean(smtpChannel && secrets.channels[smtpChannel.id]?.password),
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
