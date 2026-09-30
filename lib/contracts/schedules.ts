export interface ScheduleExecutionIntent {
  id: string;
  state: "pending" | "blocked" | "succeeded" | "failed" | "unknown";
  attemptedAt: string;
  completedAt?: string;
  action: string;
  payload?: unknown;
}

export interface ScheduleResult {
  ok: boolean;
  at?: string;
  error?: string;
  skipped?: string;
  result?: unknown;
}

export interface BatterySchedule {
  id: string;
  name: string;
  action: string;
  payload?: unknown;
  enabled: boolean;
  repeat?: "daily" | "once" | string;
  runAt?: string | null;
  time?: string;
  days?: number[];
  createdAt?: string;
  running?: boolean;
  runningSince?: string | null;
  completed?: boolean;
  lastRunDate?: string;
  lastAttemptDate?: string;
  lastResult?: ScheduleResult | null;
  executionIntent?: ScheduleExecutionIntent;
}
