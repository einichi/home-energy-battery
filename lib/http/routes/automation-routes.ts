import type { IncomingMessage, ServerResponse } from "node:http";
import type { BatterySchedule } from "../../contracts/schedules.js";
import type { AutomationRule } from "../../domain/automation-rules.js";
import type { ApiDependencies } from "../api.js";

type AutomationRouteDependencies = Pick<ApiDependencies,
  | "ALL_DAYS" | "adaptiveChargingConfiguredActive" | "cleanAutomationRule" | "json"
  | "backtestService"
  | "mergeAutomationRule" | "mutateSchedules" | "parseRunAt" | "randomUUID"
  | "readAutomationRules" | "readBody" | "readConfig" | "readSchedules"
  | "writeAutomationRuleStates" | "writeAutomationRules"
>;

export function createAutomationRouteHandler(dependencies: AutomationRouteDependencies) {
  const {
    ALL_DAYS, adaptiveChargingConfiguredActive, cleanAutomationRule, json, mergeAutomationRule,
    mutateSchedules, parseRunAt, randomUUID, readAutomationRules, readBody, readConfig,
    readSchedules, writeAutomationRuleStates, writeAutomationRules,
  } = dependencies;

  return async function handleAutomationRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void | false> {
    if (req.method === "GET" && url.pathname === "/api/backtests") {
      return json(res, 200, dependencies.backtestService.list());
    }
    if (req.method === "POST" && url.pathname === "/api/backtests") {
      const body = await readBody(req);
      return json(res, 201, await dependencies.backtestService.run({
        range: body.range === "all" ? "all" : body.range === "90d" || body.range === undefined ? "90d" : body.range as never,
        mode: body.mode === "as-operated" || body.mode === "model-only" || body.mode === "both" || body.mode === undefined
          ? body.mode
          : body.mode as never,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      }));
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
      const index = rules.findIndex((item: AutomationRule) => item.id === id);
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
      const next = rules.filter((item: AutomationRule) => item.id !== id);
      await writeAutomationRules(next);
      await writeAutomationRuleStates(next);
      return json(res, 200, { ok: next.length !== rules.length });
    }
    if (req.method === "POST" && url.pathname === "/api/schedules") {
      if (adaptiveChargingConfiguredActive(await readConfig())) {
        return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
      }
      const body = await readBody(req);
      const schedule: BatterySchedule = {
        id: randomUUID(),
        name: String(body.name || body.action || "Battery setting change"),
        action: String(body.action || ""),
        payload: body.payload || {},
        repeat: body.repeat === "daily" ? "daily" : "once",
        days: Array.isArray(body.days) && body.days.length ? body.days.map(Number).filter((day: number) => day >= 0 && day <= 6) : ALL_DAYS,
        time: typeof body.time === "string" ? body.time : undefined,
        runAt: typeof body.runAt === "string" ? body.runAt : undefined,
        enabled: body.enabled !== false,
        createdAt: new Date().toISOString(),
        lastResult: null,
      };
      schedule.runAt = parseRunAt(schedule);
      await mutateSchedules((schedules: BatterySchedule[]) => {
        schedules.push(schedule);
      });
      return json(res, 201, schedule);
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/schedules/")) {
      if (adaptiveChargingConfiguredActive(await readConfig())) {
        return json(res, 409, { error: "schedules are preserved but disabled while adaptive charging is enabled" });
      }
      const id = url.pathname.split("/").pop();
      const body = await readBody(req);
      const schedule = await mutateSchedules((schedules: BatterySchedule[]) => {
        const existing = schedules.find((item) => item.id === id);
        if (!existing) return null;
        Object.assign(existing, body);
        if ("runAt" in body || "time" in body || "repeat" in body) existing.runAt = parseRunAt(existing);
        return existing;
      });
      if (!schedule) return json(res, 404, { error: "schedule not found" });
      return json(res, 200, schedule);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
      const id = url.pathname.split("/").pop();
      const deleted = await mutateSchedules((schedules: BatterySchedule[]) => {
        const index = schedules.findIndex((item) => item.id === id);
        if (index < 0) return false;
        schedules.splice(index, 1);
        return true;
      });
      return json(res, 200, { ok: deleted });
    }
    return false;
  };
}
