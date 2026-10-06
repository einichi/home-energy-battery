import assert from "node:assert/strict";

import type { BatterySchedule } from "../lib/contracts/schedules.js";
import { isDue } from "../lib/domain/schedules.js";
import { createScheduleRunner } from "../lib/services/schedule-runner.js";

type ScheduleRunnerDependencies = Parameters<typeof createScheduleRunner>[0];

function runnerFor({ schedules, guardActive }: { schedules: BatterySchedule[]; guardActive: boolean }) {
  const executed: string[] = [];
  const dependencies = {
    readConfig: async () => ({ adaptiveCharging: { enabled: false } }),
    readOperationalOverrides: async () => ({}),
    readAutomationRules: async () => (guardActive
      ? [{ id: "guard", enabled: true, type: "backup-demand-guard", state: { awaitingRestore: true } }]
      : []),
    mutateSchedules: async (mutator: (value: BatterySchedule[]) => unknown) => mutator(schedules),
    writeSchedules: async (value: BatterySchedule[]) => value,
    executeAction: async (action: string) => {
      executed.push(action);
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
