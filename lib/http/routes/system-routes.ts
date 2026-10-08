import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDependencies } from "../api.js";
import type { AppConfig, StatusSnapshot } from "../../../shared/api-contracts.js";
import { invalidDiscoverySubnets } from "../../domain/discovery-subnets.js";
import { isSupportedSmtpPort, smtpSecurityWarning } from "../../domain/notification-configuration.js";
import { asRecord } from "../../domain/values.js";

function explicitSmtpSettings(value: unknown): Record<string, unknown> | null {
  const source = asRecord(value);
  const channels = Array.isArray(source.channels) ? source.channels : [];
  const smtp = channels.map(asRecord).find((channel) => channel.type === "smtp") ?? asRecord(source.smtp);
  const settings = asRecord(smtp.settings ?? smtp);
  return Object.keys(settings).length ? settings : null;
}

type SystemRouteDependencies = Pick<ApiDependencies,
  | "DEFAULT_CONFIG"
  | "EXTERNAL_IO_DISABLED"
  | "PORT"
  | "UI_DEVELOPMENT_MODE"
  | "applicationArchitectureStatus"
  | "batteryStrategyView"
  | "databaseBackupsView"
  | "discoveryInProgress"
  | "discoveryService"
  | "gasTariffHash"
  | "getLatestStatusSnapshot"
  | "getStatusSnapshot"
  | "importGasTariff"
  | "json"
  | "manualDatabaseBackup"
  | "normalizeGasTariffPayload"
  | "normalizeNotificationConfig"
  | "normalizeRetentionConfig"
  | "notificationService"
  | "readBody"
  | "readConfig"
  | "recordGasTariffSnapshot"
  | "removeDatabaseBackup"
  | "requestError"
  | "restoreDatabaseBackup"
  | "systemAlertsView"
  | "trimHistory"
  | "validBillingMonth"
  | "writeConfig"
>;

export function createSystemRouteHandler(dependencies: SystemRouteDependencies) {
  const {
    DEFAULT_CONFIG,
    EXTERNAL_IO_DISABLED,
    PORT,
    UI_DEVELOPMENT_MODE,
    applicationArchitectureStatus,
    batteryStrategyView,
    databaseBackupsView,
    discoveryInProgress,
    discoveryService,
    gasTariffHash,
    getLatestStatusSnapshot,
    getStatusSnapshot,
    importGasTariff,
    json,
    manualDatabaseBackup,
    normalizeGasTariffPayload,
    normalizeNotificationConfig,
    normalizeRetentionConfig,
    notificationService,
    readBody,
    readConfig,
    recordGasTariffSnapshot,
    removeDatabaseBackup,
    requestError,
    restoreDatabaseBackup,
    systemAlertsView,
    trimHistory,
    validBillingMonth,
    writeConfig,
  } = dependencies;

  return async function handleSystemRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void | false> {
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
      const notificationInput = body.config ?? body.notifications ?? body;
      const smtpSettings = explicitSmtpSettings(notificationInput);
      if (smtpSettings && !isSupportedSmtpPort(smtpSettings.port)) {
        throw requestError(400, "SMTP port must be 25, 465, or 587");
      }
      const notifications = normalizeNotificationConfig(notificationInput);
      const config = await writeConfig({ notifications });
      await notificationService.updateSecret({
        channelId: notifications.channels[0].id,
        password: body.password,
        clearPassword: body.clearPassword === true,
      });
      const view = await notificationService.view(config);
      const warning = smtpSecurityWarning(notifications.channels[0].settings);
      return json(res, 200, warning ? { ...view, warning } : view);
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/test") {
      if (EXTERNAL_IO_DISABLED) throw requestError(403, "External notification delivery is disabled in simulated UI development");
      return json(res, 200, await notificationService.sendTest());
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      const response = {
        ...(await readConfig()),
        port: PORT,
        runtime: {
          uiDevelopment: UI_DEVELOPMENT_MODE,
          simulatedDevices: UI_DEVELOPMENT_MODE,
          externalIoDisabled: EXTERNAL_IO_DISABLED,
          architecture: applicationArchitectureStatus(),
        },
      } satisfies AppConfig;
      return json(res, 200, response);
    }
    if (req.method === "PUT" && url.pathname === "/api/config") {
      const body = await readBody(req);
      if (Object.hasOwn(body, "discoverySubnets")) {
        const invalid = invalidDiscoverySubnets(body.discoverySubnets);
        if (invalid.length) throw requestError(400, `Discovery subnets must be RFC1918 /24 networks: ${invalid.join(", ")}`);
      }
      const smtpSettings = explicitSmtpSettings(asRecord(body.notifications));
      if (smtpSettings && !isSupportedSmtpPort(smtpSettings.port)) {
        throw requestError(400, "SMTP port must be 25, 465, or 587");
      }
      const response = { ...(await writeConfig(body)), port: PORT } satisfies AppConfig;
      return json(res, 200, response);
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
          sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : payload.providerPlanUrl ?? null,
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
      return json(res, 201, recordGasTariffSnapshot({ ...imported, fetchedAt: new Date().toISOString() }));
    }
    if (req.method === "POST" && url.pathname === "/api/discovery/jobs") {
      const body = await readBody(req);
      if (body.mode !== undefined && body.mode !== "broadcast" && body.mode !== "active") {
        throw requestError(400, "discovery mode must be broadcast or active");
      }
      const mode = typeof body.mode === "string" ? body.mode : undefined;
      return json(res, 202, discoveryService.startJob(body.timeout, mode, body.subnets));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/discovery/jobs/")) {
      discoveryService.cleanupJobs();
      const id = url.pathname.split("/").pop() ?? "";
      const job = discoveryService.getJob(id);
      if (!job) return json(res, 404, { error: "discovery job not found" });
      return json(res, 200, discoveryService.jobView(job));
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      if (discoveryInProgress()) {
        const cachedStatusSnapshot = getLatestStatusSnapshot();
        if (cachedStatusSnapshot) {
          const response = {
            ...cachedStatusSnapshot,
            batteryStrategy: await batteryStrategyView(),
            alerts: await systemAlertsView(cachedStatusSnapshot),
            statusRefreshPaused: true,
            statusRefreshPausedReason: `discovery is running (${discoveryService.label()})`,
          } satisfies StatusSnapshot;
          return json(res, 200, response);
        }
        return json(res, 409, {
          error: `discovery is running (${discoveryService.label()}); status polling is paused`,
        });
      }
      const config = await readConfig();
      const maxAgeMs = Math.max(5, Number(config.updateIntervalSeconds) || DEFAULT_CONFIG.updateIntervalSeconds) * 1000;
      const snapshot = await getStatusSnapshot({ maxAgeMs });
      const response = {
        ...snapshot,
        batteryStrategy: await batteryStrategyView(),
        alerts: await systemAlertsView(snapshot),
      } satisfies StatusSnapshot;
      return json(res, 200, response);
    }
    return false;
  };
}
