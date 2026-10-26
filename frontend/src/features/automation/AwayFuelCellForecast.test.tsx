import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { AwayFuelCellSummary } from "../../api/contracts";
import { AwayFuelCellForecast } from "./AwayFuelCellForecast";

const forecast: AwayFuelCellSummary = {
  periodId: "trip", from: "2026-10-24T00:00:00Z", until: "2026-10-30T00:00:00Z",
  observationFrom: "2026-10-24T00:00:00Z", regime: "provisional-off", reason: "observing",
  coveragePercent: 95, lastReadingAt: "2026-10-25T00:00:00Z", lastGeneratingAt: null,
  nextReviewAt: "2026-10-25T01:00:00Z", headroomAllowanceRetained: true,
};

describe("Away ENE-FARM forecast explanation", () => {
  it("distinguishes an initial assumption from measured silence and explains headroom", () => {
    const { rerender } = render(<AwayFuelCellForecast forecasts={[forecast]} />);
    expect(screen.getByText("Assumed off — observing")).toBeVisible();
    expect(screen.getByText(/Observation coverage: 95%/)).toBeVisible();
    expect(screen.getByText(/Battery headroom still allows for generation/)).toBeVisible();
    rerender(<AwayFuelCellForecast forecasts={[{ ...forecast, regime: "off-supported", reason: "quiet-cycle", headroomAllowanceRetained: false }]} />);
    expect(screen.getByText("Off supported by measurements")).toBeVisible();
    expect(screen.queryByText("Assumed off — observing")).not.toBeInTheDocument();
    expect(screen.getByText(/A full quiet observation cycle supports reserving no space/)).toBeVisible();
    expect(screen.queryByText(/Battery headroom still allows for generation/)).not.toBeInTheDocument();
  });

  it("explains normal generation separately from missing observations", () => {
    const { rerender } = render(<AwayFuelCellForecast forecasts={[{ ...forecast, regime: "normal-model", reason: "sustained-generation" }]} />);
    expect(screen.getByText(/household demand still uses Away assumptions/)).toBeVisible();
    rerender(<AwayFuelCellForecast forecasts={[{ ...forecast, regime: "uncertain", reason: "stale-readings", lastReadingAt: null }]} />);
    expect(screen.getByText(/Missing measurements do not count as zero generation/)).toBeVisible();
    rerender(<AwayFuelCellForecast forecasts={[]} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
