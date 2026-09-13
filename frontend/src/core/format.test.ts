import { describe, expect, it } from "vitest";
import { formatEnergy, formatFreshness, formatPower, formatSoc, metricValue } from "./format";

describe("energy formatting", () => {
  it("keeps missing metric values distinct from zero", () => {
    expect(metricValue()).toBeNull();
    expect(metricValue({ value: null })).toBeNull();
    expect(metricValue({ value: 0 })).toBe(0);
  });

  it("uses watts and kilowatts at an understandable scale", () => {
    expect(formatPower(null)).toBe("—");
    expect(formatPower(840)).toBe("840 W");
    expect(formatPower(2450)).toBe("2.5 kW");
    expect(formatPower(-1200)).toBe("-1.2 kW");
    expect(formatEnergy(1.4)).toContain("kWh");
  });

  it("formats SOC and freshness without presenting absent data as live", () => {
    expect(formatSoc(null)).toBe("—");
    expect(formatSoc(67.6)).toBe("68%");
    expect(formatFreshness()).toBe("Waiting for the first reading");
    expect(formatFreshness("2026-09-12T00:00:00.000Z", Date.parse("2026-09-12T00:00:42.000Z"))).toBe("Updated 42 sec ago");
  });
});
