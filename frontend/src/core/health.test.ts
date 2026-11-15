import { describe, expect, it } from "vitest";
import type { AppConfig, StatusSnapshot } from "../api/contracts";
import { deriveSystemHealth } from "./health";

const config: AppConfig = {
  updateIntervalSeconds: 15,
  language: "en",
  solarEnabled: true,
  smartCosmoEnabled: true,
  fuelCellEnabled: true,
};

describe("system health", () => {
  it("reports a fresh error-free snapshot as healthy", () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const status: StatusSnapshot = { read_at: "2026-09-12T11:59:55.000Z" };
    expect(deriveSystemHealth(status, config, "ready", now).severity).toBe("healthy");
  });

  it("distinguishes stale data from a service failure", () => {
    const now = Date.parse("2026-09-12T12:01:00.000Z");
    const stale = deriveSystemHealth({ read_at: "2026-09-12T11:59:00.000Z" }, config, "ready", now);
    expect(stale.label).toBe("Readings stale");
    expect(stale.alerts[0]).toMatchObject({ source: "Device", resolution: "active" });
    const unavailable = deriveSystemHealth(null, config, "error", now);
    expect(unavailable.severity).toBe("critical");
    expect(unavailable.alerts[0]).toMatchObject({ source: "Application", resolution: "active" });
  });

  it("surfaces equipment errors without marking the whole service offline", () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const result = deriveSystemHealth({
      read_at: "2026-09-12T11:59:59.000Z",
      energy: { battery: { error: "battery did not respond" } },
    }, config, "ready", now);
    expect(result.severity).toBe("attention");
    expect(result.detail).toBe("battery did not respond");
  });

  it("counts read failures from one Ene-Farm as one equipment issue when alerts are absent", () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const host = "10.250.0.150";
    const result = deriveSystemHealth({
      read_at: "2026-09-12T11:59:59.000Z",
      energy: {
        fuel_cells: [{ host, source_role: "primary", error: "Read failed" }],
        errors: ["c4", "cb", "f4"].map((code) => ({ error: `${host} 0x027C01 EPC 0x${code} timed out` })),
      },
    }, config, "ready", now);
    expect(result.label).toBe("1 equipment issue");
    expect(result.detail).toContain(`Ene-Farm (${host})`);
  });
});
