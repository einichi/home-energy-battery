type UnknownRecord = Record<string, unknown>;

export interface NotificationTrigger {
  [key: string]: unknown;
  enabled: boolean;
  cooldownMinutes: number;
  thresholdPercent?: number;
}

export interface SmtpSettings {
  [key: string]: unknown;
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string;
  from: string;
  recipients: string[];
}

export interface NotificationChannel {
  id: string;
  type: "smtp" | string;
  enabled: boolean;
  settings: SmtpSettings;
}

export interface NormalizedNotificationConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  triggers: Record<string, NotificationTrigger>;
}

export const DEFAULT_NOTIFICATION_TRIGGERS: Record<string, NotificationTrigger> = {
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

export const DEFAULT_NOTIFICATION_CONFIG: NormalizedNotificationConfig = {
  enabled: false,
  channels: [{
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
  }],
  triggers: DEFAULT_NOTIFICATION_TRIGGERS,
};

const VALID_SECURITY = new Set(["tls", "starttls", "none"]);
export const SUPPORTED_SMTP_PORTS = [25, 465, 587] as const;

export function isSupportedSmtpPort(value: unknown): boolean {
  return SUPPORTED_SMTP_PORTS.includes(Number(value) as 25 | 465 | 587)
    && Number.isInteger(Number(value));
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function stringList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeSmtpChannel(value: unknown = {}): NotificationChannel {
  const channel = record(value);
  const settings = record(channel.settings ?? channel);
  const securityValue = String(settings.security ?? "");
  const security = VALID_SECURITY.has(securityValue) ? securityValue as SmtpSettings["security"] : "starttls";
  const fallbackPort = security === "tls" ? 465 : 587;
  return {
    id: String(channel.id || "primary-email").trim() || "primary-email",
    type: "smtp",
    enabled: boolValue(channel.enabled, true),
    settings: {
      host: String(settings.host ?? "").trim(),
      port: isSupportedSmtpPort(settings.port) ? Number(settings.port) : fallbackPort,
      security,
      username: String(settings.username ?? "").trim(),
      from: String(settings.from ?? "").trim(),
      recipients: stringList(settings.recipients),
    },
  };
}

export function normalizeNotificationConfig(value: unknown = {}): NormalizedNotificationConfig {
  const source = record(value);
  const sourceChannels = Array.isArray(source.channels) ? source.channels : [];
  const smtpSource = sourceChannels.find((channel) => record(channel).type === "smtp")
    ?? source.smtp
    ?? DEFAULT_NOTIFICATION_CONFIG.channels[0];
  const triggers: Record<string, NotificationTrigger> = {};
  for (const [id, defaults] of Object.entries(DEFAULT_NOTIFICATION_TRIGGERS)) {
    const input = record(record(source.triggers)[id]);
    triggers[id] = {
      enabled: boolValue(input.enabled, defaults.enabled),
      cooldownMinutes: Math.round(boundedNumber(input.cooldownMinutes, defaults.cooldownMinutes, 1, 10080)),
      ...(id === "lowBattery" ? {
        thresholdPercent: Math.round(boundedNumber(input.thresholdPercent, defaults.thresholdPercent ?? 20, 1, 95)),
      } : {}),
    };
  }
  return {
    enabled: boolValue(source.enabled, DEFAULT_NOTIFICATION_CONFIG.enabled),
    channels: [normalizeSmtpChannel(smtpSource)],
    triggers,
  };
}
