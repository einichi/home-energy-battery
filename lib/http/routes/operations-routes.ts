import type { IncomingMessage, ServerResponse } from "node:http";
import type { AwayPeriod } from "../../contracts/away-period.js";
import type { ApiRouteServices } from "../api.js";
import type { AwayPeriodsView } from "../../../shared/api-contracts.js";

export type OperationsRouteDependencies = Pick<ApiRouteServices,
  | "adaptiveChargingAvailability" | "adaptiveChargingPlanLogMessage" | "adaptiveChargingScheduledEvent"
  | "adaptiveChargingSolarForecastAccuracy" | "adaptiveChargingView" | "appendAdaptiveChargingLog"
  | "applyInterruptedChargeCap" | "assertActionAllowedByOperationalOverride" | "awayPeriodsView"
  | "awayTimestamp" | "backupPreparationView" | "buildAdaptiveChargingPlan" | "cleanNewAwayPeriod"
  | "createAwayPeriod" | "endBackupPreparation" | "ensureAwayPeriodDoesNotOverlap" | "findAwayPeriod"
  | "forecastIsFresh" | "historicalWeather" | "listAwayPeriods" | "removeAwayPeriod"
  | "http" | "queueAdaptiveChargingForAwayChange" | "readAdaptiveChargingDemandProfileDays"
  | "readAdaptiveChargingHistory" | "readAdaptiveChargingState" | "readAutomationRules"
  | "readConfig" | "readOperationalOverridesState" | "recordFuelCellPlanForecast"
  | "refreshAdaptiveChargingForecast" | "refreshBatteryLearning"
  | "resumeAdaptiveCharging" | "startBackupPreparation" | "updateAwayPeriod" | "writeAdaptiveChargingState"
>;

export function createOperationsRouteHandler(dependencies: OperationsRouteDependencies) {
  const { json, readBody, requestError } = dependencies.http;
  const {
    adaptiveChargingAvailability, adaptiveChargingPlanLogMessage, adaptiveChargingScheduledEvent,
    adaptiveChargingSolarForecastAccuracy, adaptiveChargingView, appendAdaptiveChargingLog,
    applyInterruptedChargeCap, assertActionAllowedByOperationalOverride, awayPeriodsView,
    awayTimestamp, backupPreparationView, buildAdaptiveChargingPlan, cleanNewAwayPeriod, createAwayPeriod,
    endBackupPreparation, ensureAwayPeriodDoesNotOverlap, findAwayPeriod, forecastIsFresh, historicalWeather,
    listAwayPeriods, removeAwayPeriod,
    queueAdaptiveChargingForAwayChange, readAdaptiveChargingDemandProfileDays, readAdaptiveChargingHistory,
    readAdaptiveChargingState, readAutomationRules, readConfig, readOperationalOverridesState,
    recordFuelCellPlanForecast, refreshAdaptiveChargingForecast, refreshBatteryLearning,
    resumeAdaptiveCharging, startBackupPreparation, updateAwayPeriod, writeAdaptiveChargingState,
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
      const period = cleanNewAwayPeriod(await readBody(req), now);
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
        const body = await readBody(req);
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
        const until = awayTimestamp((await readBody(req)).until, "Until");
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
      let state = await refreshAdaptiveChargingForecast(config, { forceHistorical: true, now });
      if (!state.forecast || !forecastIsFresh(state.forecast, now) || state.lastForecastError) {
        return json(res, 503, adaptiveChargingView(config, state, rules));
      }
      const samples = await readAdaptiveChargingHistory(now);
      state = {
        ...state,
        historicalWeather: historicalWeather(),
        solarForecastAccuracy: adaptiveChargingSolarForecastAccuracy(now),
      };
      await refreshBatteryLearning(config, state, now);
      const historicalDemandDays = await readAdaptiveChargingDemandProfileDays();
      const awayPeriods = listAwayPeriods(true, now.getTime());
      state.plan = buildAdaptiveChargingPlan({ config, state, samples, historicalDemandDays, awayPeriods, now });
      recordFuelCellPlanForecast(state.plan, now);
      state.lastPlanEventKey = adaptiveChargingScheduledEvent(config, now).eventKey ?? `manual:${now.toISOString()}`;
      state.pendingPlanReason = null;
      state.pendingPlanRequestId = null;
      state.pendingPlanRequestedAt = null;
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
      await assertActionAllowedByOperationalOverride("adaptive-charging", "resume");
      const config = await readConfig();
      const rules = await readAutomationRules();
      return json(res, 200, adaptiveChargingView(config, await resumeAdaptiveCharging(), rules));
    }
    if (req.method === "GET" && url.pathname === "/api/backup-preparation") {
      return json(res, 200, backupPreparationView(await readOperationalOverridesState()));
    }
    if (req.method === "POST" && url.pathname === "/api/backup-preparation/start") {
      const body = await readBody(req);
      return json(res, 200, await startBackupPreparation({
        allowDemandGuard: body.allowDemandGuard !== false,
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/backup-preparation/end") {
      await readBody(req);
      return json(res, 200, await endBackupPreparation());
    }
    return false;
  };
}
