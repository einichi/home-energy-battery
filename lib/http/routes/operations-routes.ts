import type { IncomingMessage, ServerResponse } from "node:http";
import type { AwayPeriod } from "../../contracts/away-period.js";
import type { ApiRouteServices } from "../api.js";
import type { AwayPeriodsView } from "../../../shared/api-contracts.js";
import { AwayPeriodRequestSchema, AwayUntilRequestSchema, BackupPreparationRequestSchema, EmptyRequestSchema } from "../../../shared/api-schemas.js";
import { validateRequestBody } from "../request-validation.js";
import { refreshAdaptivePlan } from "../../services/adaptive-plan-refresh.js";
import { cachedForecastIsUsable } from "../../domain/adaptive-availability.js";

export type OperationsRouteDependencies = Pick<ApiRouteServices,
  | "adaptiveChargingAvailability" | "adaptiveChargingScheduledEvent"
  | "adaptiveChargingSolarForecastAccuracy" | "adaptiveChargingView" | "appendAdaptiveChargingLog"
  | "assertActionAllowedByOperationalOverride" | "awayPeriodsView"
  | "awayTimestamp" | "backupPreparationView" | "cleanNewAwayPeriod"
  | "createAwayPeriod" | "endBackupPreparation" | "ensureAwayPeriodDoesNotOverlap" | "findAwayPeriod"
  | "getStatusSnapshot" | "historicalWeather" | "listAwayPeriods" | "removeAwayPeriod"
  | "http" | "queueAdaptiveChargingForAwayChange" | "readAdaptiveChargingDemandProfileDays"
  | "readAdaptiveChargingHistory" | "readAdaptiveChargingState" | "readAutomationRules"
  | "readConfig" | "readOperationalOverridesState" | "recordFuelCellPlanForecast" | "recordPlanSnapshot" | "withAdaptiveChargingMutation"
  | "refreshAdaptiveChargingForecast" | "refreshBatteryLearning"
  | "resumeAdaptiveCharging" | "startBackupPreparation" | "updateAwayPeriod" | "writeAdaptiveChargingState"
>;

export function createOperationsRouteHandler(dependencies: OperationsRouteDependencies) {
  const { json, readBody, requestError } = dependencies.http;
  const {
    adaptiveChargingAvailability, adaptiveChargingScheduledEvent,
    adaptiveChargingSolarForecastAccuracy, adaptiveChargingView, appendAdaptiveChargingLog,
    assertActionAllowedByOperationalOverride, awayPeriodsView,
    awayTimestamp, backupPreparationView, cleanNewAwayPeriod, createAwayPeriod,
    endBackupPreparation, ensureAwayPeriodDoesNotOverlap, findAwayPeriod, getStatusSnapshot, historicalWeather,
    listAwayPeriods, removeAwayPeriod,
    queueAdaptiveChargingForAwayChange, readAdaptiveChargingDemandProfileDays, readAdaptiveChargingHistory,
    readAdaptiveChargingState, readAutomationRules, readConfig, readOperationalOverridesState,
    recordFuelCellPlanForecast, recordPlanSnapshot, refreshAdaptiveChargingForecast, refreshBatteryLearning,
    resumeAdaptiveCharging, startBackupPreparation, updateAwayPeriod, writeAdaptiveChargingState, withAdaptiveChargingMutation,
  } = dependencies;

  return async function handleOperationsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void | false> {
    if (req.method === "GET" && url.pathname === "/api/away-periods") {
      return json(res, 200, awayPeriodsView() satisfies AwayPeriodsView);
    }
    if (req.method === "POST" && url.pathname === "/api/away-periods") {
      const now = new Date();
      const period = cleanNewAwayPeriod(validateRequestBody(await readBody(req), AwayPeriodRequestSchema, requestError), now);
      ensureAwayPeriodDoesNotOverlap(period);
      const created = createAwayPeriod(period);
      await queueAdaptiveChargingForAwayChange("Away schedule created", now);
      return json(res, 201, { period: created, ...awayPeriodsView(now) });
    }
    if (url.pathname.startsWith("/api/away-periods/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2];
      const operation = parts[3] ?? null;
      const now = new Date();
      const existing = findAwayPeriod(id, now);
      if (!existing) throw requestError(404, "Away period not found");
      if (req.method === "PATCH" && !operation) {
        if (existing.status !== "scheduled") throw requestError(409, "Only an Away period that has not started can be edited");
        const body = validateRequestBody(await readBody(req), AwayPeriodRequestSchema, requestError);
        const from = awayTimestamp(body.from, "From");
        const until = awayTimestamp(body.until, "Until");
        if (from.getTime() < now.getTime() - 60_000) throw requestError(400, "From cannot be in the past");
        if (until.getTime() <= from.getTime()) throw requestError(400, "Until must be after From");
        const updated: AwayPeriod = {
          ...existing,
          from: from.toISOString(),
          until: until.toISOString(),
          updatedAt: now.toISOString(),
        };
        ensureAwayPeriodDoesNotOverlap(updated, id);
        updateAwayPeriod(updated);
        await queueAdaptiveChargingForAwayChange("Away schedule edited", now);
        return json(res, 200, awayPeriodsView(now));
      }
      if (req.method === "DELETE" && !operation) {
        if (existing.status !== "scheduled") throw requestError(409, "Only an Away period that has not started can be deleted");
        removeAwayPeriod(id);
        await queueAdaptiveChargingForAwayChange("Away schedule deleted", now);
        return json(res, 200, awayPeriodsView(now));
      }
      if (req.method === "POST" && operation === "extend") {
        if (existing.status !== "active") throw requestError(409, "Only an active Away period can be extended");
        const body = validateRequestBody(await readBody(req), AwayUntilRequestSchema, requestError);
        const until = awayTimestamp(body.until, "Until");
        if (until.getTime() <= new Date(existing.until).getTime()) {
          throw requestError(400, "The extended Until time must be later than the current Until time");
        }
        const updated: AwayPeriod = { ...existing, until: until.toISOString(), updatedAt: now.toISOString() };
        ensureAwayPeriodDoesNotOverlap(updated, id);
        updateAwayPeriod(updated);
        await queueAdaptiveChargingForAwayChange("Active Away period extended", now);
        return json(res, 200, awayPeriodsView(now));
      }
      if (req.method === "POST" && operation === "back-home") {
        if (existing.status !== "active") throw requestError(409, "Back Home is only available during an active Away period");
        updateAwayPeriod({ ...existing, until: now.toISOString(), updatedAt: now.toISOString() });
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
      await assertActionAllowedByOperationalOverride("adaptive-charging", "recalculate");
      const currentState = await readAdaptiveChargingState();
      if (currentState.pausedUntil && new Date(currentState.pausedUntil).getTime() > now.getTime()) {
        return json(res, 409, adaptiveChargingView(config, currentState, rules));
      }
      await refreshAdaptiveChargingForecast(config, { forceHistorical: true, now });
      return withAdaptiveChargingMutation(async () => {
        const currentConfig = await readConfig();
        let state = await readAdaptiveChargingState();
        await assertActionAllowedByOperationalOverride("adaptive-charging", "recalculate");
        const status = await getStatusSnapshot({ force: true });
        const evaluatedAt = new Date();
        if (state.pausedUntil && new Date(state.pausedUntil).getTime() > evaluatedAt.getTime()) {
          return json(res, 409, adaptiveChargingView(currentConfig, state, rules));
        }
        if (!adaptiveChargingAvailability(currentConfig, rules).available || !cachedForecastIsUsable(state, evaluatedAt)) {
          return json(res, 503, adaptiveChargingView(currentConfig, state, rules));
        }
        const awayPeriods = listAwayPeriods(true, evaluatedAt.getTime());
        state = await refreshAdaptivePlan(state, currentConfig, status, awayPeriods, {
          eventKey: adaptiveChargingScheduledEvent(currentConfig, evaluatedAt).eventKey ?? `manual:${evaluatedAt.toISOString()}`,
          trigger: "manual request",
        }, evaluatedAt, {
          readHistory: readAdaptiveChargingHistory,
          historicalWeather,
          solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy,
          refreshBatteryLearning,
          readDemandProfileDays: readAdaptiveChargingDemandProfileDays,
          recordFuelCellPlanForecast,
          recordPlanSnapshot,
          appendLog: appendAdaptiveChargingLog,
        });
        state = await writeAdaptiveChargingState(state);
        return json(res, 200, adaptiveChargingView(currentConfig, state, rules));
      });
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
      const body = validateRequestBody(await readBody(req), BackupPreparationRequestSchema, requestError);
      return json(res, 200, await startBackupPreparation({
        allowDemandGuard: body.allowDemandGuard !== false,
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/backup-preparation/end") {
      validateRequestBody(await readBody(req), EmptyRequestSchema, requestError);
      return json(res, 200, await endBackupPreparation());
    }
    return false;
  };
}
