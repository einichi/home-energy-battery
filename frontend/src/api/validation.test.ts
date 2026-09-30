import { describe, expect, it } from "vitest";
import { validateApiPayload } from "./validation";

describe("API runtime validation", () => {
  it("accepts the stable history summary shape", () => {
    expect(() => validateApiPayload("/api/history/summary", { sampleCount: 2, houseDemandKwh: 1.2, energySources: {} })).not.toThrow();
  });

  it("rejects malformed history before it reaches a view", () => {
    expect(() => validateApiPayload("/api/history", { samples: {}, summary: {} })).toThrow(/samples must be an array/);
  });

  it("rejects malformed report and status collections", () => {
    expect(() => validateApiPayload("/api/reports/energy", { buckets: {}, totals: {} })).toThrow(/buckets must be an array/);
    expect(() => validateApiPayload("/api/status", { read_at: "2026-09-19T00:00:00Z", alerts: {} })).toThrow(/alerts must be an array/);
    expect(() => validateApiPayload("/api/status", { read_at: "2026-09-19T00:00:00Z", alerts: [{ source: 7 }] })).toThrow(/source must be a string/);
  });

  it("accepts object responses from collection mutations", () => {
    expect(() => validateApiPayload("/api/schedules", { id: "schedule-1" }, "POST")).not.toThrow();
    expect(() => validateApiPayload("/api/automation-rules", { id: "rule-1" }, "POST")).not.toThrow();
  });
});
