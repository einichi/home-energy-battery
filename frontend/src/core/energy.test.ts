import { describe, expect, it } from "vitest";
import { statusToEnergySample, withLatestStatus } from "./energy";

describe("energy view model", () => {
  it("maps a status snapshot without converting missing readings to zero", () => {
    const sample = statusToEnergySample({
      read_at: "2026-09-12T12:00:00.000Z",
      energy: { battery: { instant_power: { value: 0 } } },
      meter: { channel_power: { decoded: { channels: [{ channel: 1, value: 320 }] } } },
    });
    expect(sample?.batteryPowerW).toBe(0);
    expect(sample?.solarPowerW).toBeNull();
    expect(sample?.circuitPowerW).toEqual({ 1: 320 });
  });

  it("adds the latest live snapshot when history is initially empty", () => {
    const samples = withLatestStatus([], { read_at: "2026-09-12T12:00:00.000Z", meter: { house_demand_power: { value: 1400 } } });
    expect(samples).toHaveLength(1);
    expect(samples[0].houseDemandW).toBe(1400);
  });
});
