import assert from "node:assert/strict";

import type { BatterySchedule } from "../lib/contracts/schedules.js";
import { clearStaleScheduleRuns, isDue } from "../lib/domain/schedules.js";

function daily(overrides: Partial<BatterySchedule> = {}): BatterySchedule {
  return {
    id: "daily-1",
    name: "Daily charge",
    action: "charge",
    enabled: true,
    repeat: "daily",
    time: "02:00",
    ...overrides,
  };
}

const exactMinute = new Date(2026, 6, 13, 2, 0, 0);
const afterMinute = new Date(2026, 6, 13, 5, 30, 0);
const beforeMinute = new Date(2026, 6, 13, 1, 30, 0);
const todayKey = "2026-07-13";

// Exact minute still runs.
assert.equal(isDue(daily(), exactMinute), true);

// A delayed tick or restart after the scheduled minute catches up the same day.
assert.equal(isDue(daily(), afterMinute), true);

// Before the scheduled minute it is not yet due.
assert.equal(isDue(daily(), beforeMinute), false);

// Already run or attempted today blocks a second run.
assert.equal(isDue(daily({ lastRunDate: todayKey }), afterMinute), false);
assert.equal(isDue(daily({ lastAttemptDate: todayKey }), afterMinute), false);

// A schedule created today after its time must not fire immediately; it waits
// for the next occurrence.
assert.equal(isDue(daily({ createdAt: new Date(2026, 6, 13, 15, 0).toISOString() }), afterMinute), false);

// A schedule created today before its time still catches up after the time.
assert.equal(isDue(daily({ createdAt: new Date(2026, 6, 13, 1, 0).toISOString() }), afterMinute), true);

// A schedule created on a previous day catches up after its time.
assert.equal(isDue(daily({ createdAt: new Date(2026, 6, 12, 12, 0).toISOString() }), afterMinute), true);

// Disabled schedules, invalid times, and off-days are never due.
assert.equal(isDue(daily({ enabled: false }), afterMinute), false);
assert.equal(isDue(daily({ time: "25:00" }), afterMinute), false);
assert.equal(isDue(daily({ time: "nonsense" }), afterMinute), false);
assert.equal(isDue(daily({ days: [(afterMinute.getDay() + 1) % 7] }), afterMinute), false);

// A stale run clears the pending intent so a one-time schedule is due again.
const staleOnce: BatterySchedule = {
  id: "stale-once",
  name: "Stale",
  action: "charge",
  enabled: true,
  repeat: "once",
  runAt: "2020-01-01T00:00:00.000Z",
  running: true,
  runningSince: "2020-01-01T00:00:00.000Z",
  executionIntent: { id: "intent", state: "pending", attemptedAt: "2020-01-01T00:00:00.000Z", action: "charge" },
};
assert.equal(isDue(staleOnce, afterMinute), false);
assert.equal(clearStaleScheduleRuns([staleOnce], new Set()), true);
assert.equal(staleOnce.running, false);
assert.equal(staleOnce.executionIntent, undefined);
assert.equal(isDue(staleOnce, afterMinute), true);
