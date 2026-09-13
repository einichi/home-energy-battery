import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeStrip } from "./OutcomeStrip";

describe("outcome strip", () => {
  it("does not present missing local-source data as zero", () => {
    render(<OutcomeStrip summary={{}} />);
    expect(screen.getByText("Self-powered").parentElement).toHaveTextContent("—");
  });

  it("combines available solar and fuel-cell contribution", () => {
    render(<OutcomeStrip summary={{ energySources: { solarUsedKwh: 1.2, fuelCellContributionKwh: 0.4 } }} />);
    expect(screen.getByText("Self-powered").parentElement).toHaveTextContent("1.6 kWh");
  });
});
