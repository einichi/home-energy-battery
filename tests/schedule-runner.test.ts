import assert from "node:assert/strict";

import type { BatterySchedule } from "../lib/contracts/schedules.js";
import { isDue } from "../lib/domain/schedules.js";
import { createScheduleRunner } from "../lib/services/schedule-runner.js";

type ScheduleRunnerDependencies = Parameters<typeof createScheduleRunner>[0];

function runnerFor({
  schedules,
  guardActive,
  writeSchedules,
  onExecute,
}: {
  schedules: BatterySchedule[];
  guardActive: boolean;
  writeSchedules?: (value: BatterySchedule[]) => Promise<BatterySchedule[]>;
  onExecute?: () => void;
}) {
  const executed: string[] = [];
  const dependencies = {
    readConfig: async () => ({ adaptiveCharging: { enabled: false } }),
    readOperationalOverrides: async () => ({}),
    readAutomationRules: async () => (guardActive
      ? [{ id: "guard", enabled: true, type: "backup-demand-guard", state: { awaitingRestore: true } }]
      : []),
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
  return { runner: createScheduleRunner(dependencies), executed };
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
  const { runner, executed } = runnerFor({ schedules, guardActive: false });
  await runner.run();
  assert.deepEqual(executed, ["charge"]);
  assert.equal(schedules[0].enabled, false);
  assert.equal(schedules[0].completed, true);
  assert.equal(schedules[0].executionIntent?.state, "succeeded");
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
