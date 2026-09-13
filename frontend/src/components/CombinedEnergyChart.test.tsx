import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CombinedEnergyChart } from "./CombinedEnergyChart";

describe("combined energy chart", () => {
  it("renders signed power, percentage data, and an accessible table", () => {
    render(<CombinedEnergyChart
      label="Test energy history"
      selected={["houseDemandW", "batteryPowerW", "stateOfChargePercent"]}
      samples={[
        { timestamp: "2026-09-12T10:00:00.000Z", houseDemandW: 1200, batteryPowerW: -500, stateOfChargePercent: 72 },
        { timestamp: "invalid timestamp", houseDemandW: 1300 },
        { timestamp: "2026-09-12T11:00:00.000Z", houseDemandW: 1600, batteryPowerW: 300, stateOfChargePercent: 68 },
      ]}
    />);

    expect(screen.getByRole("img", { name: "Test energy history" })).toBeVisible();
    expect(screen.getByText("View chart as data table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Battery" })).toBeInTheDocument();
    expect(screen.getByText("-500 W")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    const legend = screen.getByLabelText("Chart series");
    expect(within(legend).getByText("Demand")).toBeVisible();
    expect(within(legend).getByText("Battery")).toBeVisible();
    expect(within(legend).getByText("Battery SOC")).toBeVisible();

    fireEvent.pointerMove(screen.getByRole("img", { name: "Test energy history" }), { clientX: 460 });
    expect(screen.getByRole("status", { name: "Chart reading details" })).toHaveTextContent(/Demand: 1.2 kW/);
    expect(screen.getByRole("status", { name: "Chart reading details" })).toHaveTextContent(/Battery SOC: 72%/);
  });

  it("distinguishes an empty period from a zero reading", () => {
    const { rerender } = render(<CombinedEnergyChart label="Empty" selected={["gridExportW"]} samples={[]} />);
    expect(screen.getByText(/No readings/)).toBeVisible();
    rerender(<CombinedEnergyChart label="Zero export" selected={["gridExportW"]} samples={[{ timestamp: "2026-09-12T11:00:00.000Z", gridExportW: 0 }]} />);
    expect(screen.getAllByText("0 W").length).toBeGreaterThan(0);
  });

  it("shows reserve and operational windows on a battery timeline", () => {
    const { container } = render(<CombinedEnergyChart
      label="Battery timeline"
      selected={["batteryPowerW", "stateOfChargePercent"]}
      reservePercent={30}
      overlays={[{ start: "2026-09-12T10:15:00.000Z", end: "2026-09-12T10:45:00.000Z", label: "Charge window", tone: "charge" }]}
      samples={[
        { timestamp: "2026-09-12T10:00:00.000Z", batteryPowerW: 500, stateOfChargePercent: 28 },
        { timestamp: "2026-09-12T11:00:00.000Z", batteryPowerW: 0, stateOfChargePercent: 36 },
      ]}
    />);
    expect(screen.getByText("Reserve 30%")).toBeInTheDocument();
    expect(container.querySelector('rect[data-tone="charge"]')).toBeInTheDocument();
    expect(screen.getByLabelText("Timeline overlays")).toBeVisible();
  });
});
