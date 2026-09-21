import { describe, expect, it } from "vitest";
import { formatDateTimeRange, formatDateTimesInText, formatEnergy, formatFreshness, formatPower, formatSoc, formatTime, metricValue, setFormattingLocale } from "./format";

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

  it("formats automation windows as localized date and time ranges", () => {
    setFormattingLocale("en");
    const english = formatDateTimeRange("2026-09-20T18:59:48.945Z", "2026-09-20T20:00:00.000Z");
    expect(english).toContain("–");
    expect(english).not.toMatch(/[TZ]/);
    expect(english).not.toContain(":48");
    setFormattingLocale("ja");
    const japanese = formatDateTimeRange("2026-09-20T18:59:48.945Z", "2026-09-20T20:00:00.000Z");
    expect(japanese).toContain("–");
    expect(japanese).not.toMatch(/[TZ]/);
    setFormattingLocale("en");
  });

  it("formats compact contact times without repeating the date", () => {
    const value = formatTime("2026-09-20T18:59:48.945Z");
    expect(value).toMatch(/\d{2}:\d{2}/);
    expect(value).not.toContain("2026");
    expect(formatTime("invalid")).toBe("—");
  });

  it("formats ISO timestamps embedded in API prose", () => {
    const value = formatDateTimesInText("Away assumptions remain active until 2026-09-27T07:00:00.000Z.");
    expect(value).toContain("Away assumptions remain active until");
    expect(value).not.toContain("2026-09-27T07:00:00.000Z");
    expect(value).not.toMatch(/T\d{2}:\d{2}/);
  });
});
