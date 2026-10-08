import { describe, expect, it } from "vitest";
import { validateApiPayload } from "./validation";

describe("API runtime validation", () => {
  it("accepts the stable history summary shape", () => {
    expect(() => validateApiPayload("/api/history/summary", { sampleCount: 2, branchDemandKwh: 1.2, energySources: {} })).not.toThrow();
  });

  it("rejects malformed history before it reaches a view", () => {
    expect(() => validateApiPayload("/api/history", { samples: {}, summary: {} })).toThrow(/invalid payload at samples/);
  });

  it("rejects malformed report and status collections", () => {
    expect(() => validateApiPayload("/api/reports/energy", { buckets: {}, totals: {} })).toThrow(/buckets must be an array/);
    expect(() => validateApiPayload("/api/status", { read_at: "2026-09-19T00:00:00Z", alerts: {} })).toThrow(/invalid payload at alerts/);
    expect(() => validateApiPayload("/api/status", { read_at: "2026-09-19T00:00:00Z", alerts: [{ id: "one", severity: "warning", title: "t", startedAt: "now", impact: "i", suggestedAction: "a", resolution: "active", source: 7 }] })).toThrow(/invalid payload at alerts.0.source/);
  });

  it("validates config and accepted status/history payloads with shared schemas", () => {
    expect(() => validateApiPayload("/api/config", { updateIntervalSeconds: 15, language: "en", solarEnabled: true, smartCosmoEnabled: true, fuelCellEnabled: false })).not.toThrow();
    expect(() => validateApiPayload("/api/status", { alerts: [] })).not.toThrow();
    expect(() => validateApiPayload("/api/history", { samples: [], summary: {} })).not.toThrow();
    expect(() => validateApiPayload("/api/config", { updateIntervalSeconds: "15", language: "en", solarEnabled: true, smartCosmoEnabled: true, fuelCellEnabled: false })).toThrow(/updateIntervalSeconds/);
  });

  it("accepts object responses from collection mutations", () => {
    expect(() => validateApiPayload("/api/schedules", { id: "schedule-1" }, "POST")).not.toThrow();
    expect(() => validateApiPayload("/api/automation-rules", { id: "rule-1" }, "POST")).not.toThrow();
  });
});
