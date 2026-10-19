import assert from "node:assert/strict";

import type { BatterySchedule } from "../lib/contracts/schedules.js";
import type { AutomationRule } from "../lib/domain/automation-rules.js";
import { cleanAutomationRule } from "../lib/domain/automation-rules.js";
import { isDue } from "../lib/domain/schedules.js";
import type { ScheduleRunnerDependencies } from "../lib/services/schedule-runner.js";
import { createScheduleRunner } from "../lib/services/schedule-runner.js";

function runnerFor({
  schedules,
  guardActive,
  rules,
  demandW = 1_000,
  maximumChargeWatts = 2_000,
  branchDemandW = demandW,
  batteryChargingW = 0,
  statusError,
  writeSchedules,
  onExecute,
}: {
  demandW?: number | null;
  schedules: BatterySchedule[];
  guardActive: boolean;
  rules?: AutomationRule[];
  branchDemandW?: number | null;
  batteryChargingW?: number | null;
  maximumChargeWatts?: number | null;
  statusError?: Error;
  writeSchedules?: (value: BatterySchedule[]) => Promise<BatterySchedule[]>;
  onExecute?: () => void;
}) {
  let statusReads = 0;
  const executed: string[] = [];
  const dependencies = {
    readConfig: async () => ({
      adaptiveCharging: { enabled: false },
      batteryCapabilities: { maximumChargeWatts },
    }),
    readOperationalOverrides: async () => ({}),
    readAutomationRules: async () => (guardActive
      ? [{ id: "guard", enabled: true, type: "backup-demand-guard", state: { awaitingRestore: true } }]
      : rules ?? []),
    getStatusSnapshot: async () => {
      statusReads += 1;
      if (statusError) throw statusError;
      return {
        meter: {
          grid_import_power: { value: demandW },
          branch_demand_power: { value: branchDemandW },
        },
        energy: { battery: { instant_power: { value: batteryChargingW } } },
      };
    },
    mutateSchedules: async (mutator: (value: BatterySchedule[]) => unknown) => mutator(schedules),
    writeSchedules: writeSchedules ?? (async (value: BatterySchedule[]) => value),
    executeAction: async (action: string) => {
      executed.push(action);
      onExecute?.();
      return { ok: true };
    },
    notify: () => undefined,
    warn: () => undefined,
  } as unknown as ScheduleRunnerDependencies;
  return { runner: createScheduleRunner(dependencies), executed, statusReads: () => statusReads };
}

function dueOneTimeSchedule(): BatterySchedule {
  return {
    id: "once-1",
    name: "One-time charge",
    action: "charge",
    enabled: true,
    repeat: "once",
    runAt: "2020-01-01T00:00:00.000Z",
  };
}

// A one-time schedule blocked by the Demand Guard must not remain enabled with a
// permanent blocked intent (which would make isDue() false forever).
{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({ schedules, guardActive: true });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].enabled, false);
  assert.equal(schedules[0].completed, true);
  assert.equal(schedules[0].executionIntent?.state, "blocked");
  assert.equal(isDue(schedules[0], new Date()), false);
}

// Without a guard owner, a due one-time schedule still runs exactly once.
{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed, statusReads } = runnerFor({ schedules, guardActive: false });
  await runner.run();
  assert.deepEqual(executed, ["charge"]);
  assert.equal(schedules[0].enabled, false);
  assert.equal(schedules[0].completed, true);
  assert.equal(schedules[0].executionIntent?.state, "succeeded");
  assert.equal(statusReads(), 0, "without an enabled guard, charge starts do not fetch a preflight snapshot");
}

// The running intent is persisted exactly once before execution; the mutation
// layer persists the final state, so there is no second write from the runner.
{
  const schedules = [dueOneTimeSchedule()];
  let writes = 0;
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    writeSchedules: async (value: BatterySchedule[]) => { writes += 1; return value; },
  });
  await runner.run();
  assert.equal(writes, 1);
  assert.deepEqual(executed, ["charge"]);
  assert.equal(schedules[0].running, false);
  assert.equal(schedules[0].runningSince, null);
}

// If persisting the running intent fails, the action is not executed and the
// schedule is not left stuck running.
{
  const schedules = [dueOneTimeSchedule()];
  let executeCount = 0;
  const { runner } = runnerFor({
    schedules,
    guardActive: false,
    writeSchedules: async () => { throw new Error("disk full"); },
    onExecute: () => { executeCount += 1; },
  });
  await runner.run();
  assert.equal(executeCount, 0);
  assert.equal(schedules[0].running, false);
  assert.equal(schedules[0].runningSince, null);
}
const guard = (id = "guard", source: "gridImportW" | "branchDemandW" = "gridImportW") => cleanAutomationRule({
  id,
  enabled: true,
  conditions: { source, breakerAmps: 40, reserveAmps: 5, breakerVoltage: 100 },
});

for (const [demandW, shouldBlock] of [[1_499, false], [1_500, true], [2_000, true]] as const) {
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({ schedules, guardActive: false, rules: [guard()], demandW });
  await runner.run();
  assert.equal(executed.length === 0, shouldBlock, `${demandW} W grid demand should ${shouldBlock ? "block" : "permit"} a 2,000 W start`);
  assert.equal(schedules[0].executionIntent?.state, shouldBlock ? "blocked" : "succeeded");
  if (shouldBlock) {
    assert.equal(schedules[0].enabled, false);
    assert.equal(schedules[0].completed, true);
    assert.equal(schedules[0].lastResult?.skipped, "Charging Demand Guard: projected charging demand reaches breaker reserve");
  }
}

for (const demandW of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({ schedules, guardActive: false, rules: [guard()], demandW });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].lastResult?.skipped, "Charging Demand Guard: demand unavailable");
}

for (const maximumChargeWatts of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    maximumChargeWatts,
  });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].lastResult?.skipped, "Charging Demand Guard: maximum battery charge watts unavailable");
}

{
  const schedules = [dueOneTimeSchedule()];
  const invalid = guard();
  invalid.conditions.reserveAmps = invalid.conditions.breakerAmps;
  const { runner, executed } = runnerFor({ schedules, guardActive: false, rules: [invalid] });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].lastResult?.skipped, "Charging Demand Guard: invalid breaker limit");
}

{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    statusError: new Error("snapshot read failed"),
  });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].lastResult?.skipped, "Charging Demand Guard: status unavailable");
  assert.equal(schedules[0].lastResult?.error, "snapshot read failed");
}

{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    demandW: 3_400,
    batteryChargingW: 2_000,
  });
  await runner.run();
  assert.deepEqual(executed, ["charge"], "grid import already includes charging load and must not double-count it");
}

{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard("branch", "branchDemandW")],
    demandW: 0,
    branchDemandW: 1_500,
  });
  await runner.run();
  assert.deepEqual(executed, [], "a guard must use its configured branch-demand source");
}

{
  const schedules = [dueOneTimeSchedule()];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard("permissive"), cleanAutomationRule({
      id: "blocking",
      enabled: true,
      conditions: { source: "branchDemandW", breakerAmps: 40, reserveAmps: 5, breakerVoltage: 100 },
    })],
    demandW: 0,
    branchDemandW: 1_500,
  });
  await runner.run();
  assert.deepEqual(executed, [], "every enabled guard must permit the start");
  const result = schedules[0].lastResult;
  assert.ok(result && "ruleId" in result);
  assert.equal(result.ruleId, "blocking", "the first blocking rule identifies the selected-source refusal");
}

{
  const schedules = [dueOneTimeSchedule()];
  const disabled = guard();
  disabled.enabled = false;
  const { runner, executed, statusReads } = runnerFor({ schedules, guardActive: false, rules: [disabled] });
  await runner.run();
  assert.deepEqual(executed, ["charge"]);
  assert.equal(statusReads(), 0, "disabled guards must not add a telemetry requirement");
}

{
  const now = new Date();
  const schedules: BatterySchedule[] = [{
    id: "daily-guard-block",
    name: "Daily charge",
    action: "charge",
    enabled: true,
    repeat: "daily",
    time: "00:00",
    days: [now.getDay()],
  }];
  const { runner, executed, statusReads } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    demandW: 1_500,
  });
  await runner.run();
  assert.deepEqual(executed, []);
  assert.equal(schedules[0].enabled, true);
  assert.equal(schedules[0].executionIntent?.state, "blocked");
  const readsAfterAttempt = statusReads();
  await runner.run();
  assert.equal(statusReads(), readsAfterAttempt, "daily blocked attempts must not retry again on the same day");
}

for (const statusError of [undefined, new Error("snapshot read failed")]) {
  const charge = dueOneTimeSchedule();
  const other: BatterySchedule = {
    ...dueOneTimeSchedule(),
    id: "other-setting",
    action: "set-mode",
    payload: { mode: "auto" },
  };
  const { runner, executed } = runnerFor({
    schedules: [charge, other],
    guardActive: false,
    rules: [guard()],
    demandW: 1_500,
    statusError,
  });
  await runner.run();
  assert.deepEqual(executed, ["set-mode"], "a blocked charge must not prevent later due non-charge actions");
}

{
  const schedule: BatterySchedule = {
    ...dueOneTimeSchedule(),
    action: "set-mode",
    payload: { mode: "charging" },
  };
  const schedules = [schedule];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    demandW: 1_500,
  });
  await runner.run();
  assert.deepEqual(executed, [], "set-mode charging starts must use the same preflight");
}

{
  const schedules: BatterySchedule[] = [{
    ...dueOneTimeSchedule(),
    action: "set-mode",
    payload: { mode: "auto" },
  }];
  const { runner, executed } = runnerFor({
    schedules,
    guardActive: false,
    rules: [guard()],
    statusError: new Error("charge telemetry unavailable"),
  });
  await runner.run();
  assert.deepEqual(executed, ["set-mode"], "non-charging mode changes must not require telemetry");
}
