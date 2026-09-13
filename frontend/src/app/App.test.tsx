import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { AppProviders } from "./providers";

const config = {
  updateIntervalSeconds: 15,
  language: "en",
  solarEnabled: true,
  smartCosmoEnabled: true,
  fuelCellEnabled: true,
  runtime: { uiDevelopment: true, simulatedDevices: true, externalIoDisabled: true },
};

const status = {
  read_at: new Date().toISOString(),
  batteryStrategy: { kind: "device-auto", title: "Device-managed operation", description: "No application automation currently owns the battery.", manualOverride: { active: false } },
  energy: {
    battery: {
      instant_power: { value: -720 },
      remaining_percent: { value: 68 },
      working_status: { value: "discharging" },
      operation_mode: { value: "auto" },
      vendor_profile: { value: "eco" },
    },
    solar: { instant_power: { value: 2450 } },
    fuel_cells: [{ source_role: "primary", instant_power: { value: 510 }, generation_status: { value: "generating" }, hot_water_level: { value: 4 } }],
  },
  meter: {
    house_demand_power: { value: 3210 },
    grid_import_power: { value: 250 },
    grid_export_power: { value: 0 },
    channel_power: { decoded: { channels: [{ channel: 1, value: 420 }] } },
  },
};

const history = {
  samples: [
    { timestamp: "2026-09-12T11:00:00.000Z", houseDemandW: 2800, solarPowerW: 2200, fuelCellPowerW: 500, batteryPowerW: -400, stateOfChargePercent: 70, gridImportW: 500, gridExportW: 0, circuitPowerW: { 1: 400 } },
    { timestamp: "2026-09-12T12:00:00.000Z", houseDemandW: 3210, solarPowerW: 2450, fuelCellPowerW: 510, batteryPowerW: -720, stateOfChargePercent: 68, gridImportW: 250, gridExportW: 0, circuitPowerW: { 1: 420 } },
  ],
  summary: {
    sampleCount: 2,
    houseDemandKwh: 3.2,
    solarGenerationKwh: 2.4,
    fuelCellKwh: 0.5,
    gridImportKwh: 0.3,
    gridExportKwh: 0,
    batteryChargedKwh: 0.1,
    batteryDischargedKwh: 0.7,
    batteryNetKwh: -0.6,
    averageStateOfChargePercent: 69,
    solarSavingYen: 84,
    energySources: { solarUsedKwh: 2.4, fuelCellContributionKwh: 0.5 },
    circuits: [{ channel: 1, label: "Kitchen", totalKwh: 0.4, latestWatts: 420 }],
    dataQuality: { houseDemandKwh: { quality: "counter", coveragePercent: 100 } },
  },
};

const schedules = [
  { id: "schedule-1", name: "Overnight Eco", action: "vendor-profile", payload: { mode: "eco" }, repeat: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: "02:00", enabled: true, lastResult: { ok: true, at: "2026-09-12T02:00:00.000Z" } },
  { id: "schedule-2", name: "Reserve before morning", action: "discharge-limit", payload: { percent: 40 }, repeat: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: "02:00", enabled: true },
];

function mockApi(commandState: "succeeded" | "mismatched" = "succeeded", adaptiveEnabled = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = url.endsWith("/api/config")
      ? { ...config, adaptiveCharging: { enabled: adaptiveEnabled } }
      : url.includes("/api/history?")
        ? history
        : url.includes("/api/command-receipts")
          ? { receipts: [] }
          : url.includes("/api/device-commands/command-1")
            ? { commandId: "command-1", action: "charge", source: "manual", request: { targetWh: 500 }, state: commandState, requestedAt: new Date().toISOString(), completedAt: new Date().toISOString(), message: commandState === "succeeded" ? "charge was verified" : "expected charging, observed standby", error: commandState === "mismatched" ? "expected charging, observed standby" : null, events: [{ eventKey: "command:command-1:sending", at: new Date().toISOString(), type: "sending" }, { eventKey: "command:command-1:acknowledged", at: new Date().toISOString(), type: "acknowledged" }, { eventKey: `command:command-1:${commandState}`, at: new Date().toISOString(), type: commandState }] }
          : url.endsWith("/api/schedules") && (!init?.method || init.method === "GET")
            ? schedules
            : url.endsWith("/api/backup-preparation")
              ? { active: false, phase: "inactive", allowDemandGuard: true, log: [] }
              : url.endsWith("/api/device-commands") && init?.method === "POST"
                ? { commandId: "command-1", commandState: "requested" }
                : init?.method === "POST"
                ? { commandId: "command-1", commandState: "succeeded", completedAt: new Date().toISOString(), acknowledged: true, verified: true }
                : status;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("React application shell", () => {
  it("renders a simulator banner and read-only overview from the API", async () => {
    mockApi();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/No production devices/)).toBeVisible();
    expect(await screen.findAllByText("68%")).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Home energy overview" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /charge|discharge|backup/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /Last 24 hours/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Energy outcomes" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Current measurements" })).not.toBeInTheDocument();
  });

  it("consolidates current, historical, quality, and circuit data on Energy", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/energy"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Energy" })).toBeVisible();
    expect(await screen.findByRole("img", { name: /24h energy history/ })).toBeVisible();
    expect(screen.getByText("Kitchen")).toBeVisible();
    expect(screen.getByText(/minimum coverage 100%/)).toBeVisible();
    expect(screen.getByText("3.2 kWh")).toBeVisible();
    expect(screen.queryByRole("button", { name: /charge|discharge|backup/i })).not.toBeInTheDocument();
  });

  it("redirects a legacy graph route to a focused Energy metric", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/graphs/solarPower"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Energy" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Solar" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Demand" })).not.toBeChecked();
  });

  it("keeps physical battery changes behind review and reports verified completion", async () => {
    const fetchMock = mockApi();
    render(
      <MemoryRouter initialEntries={["/battery"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Battery" })).toBeVisible();
    expect(await screen.findByRole("img", { name: /battery power and state of charge/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Device-managed operation" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Charge" }));
    expect(screen.getByRole("dialog", { name: "Start manual charging" })).toBeVisible();
    expect(screen.getByText(/pause Adaptive Charging/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(await screen.findByText(/device state was verified/i)).toBeVisible();
    expect(screen.getByText("Request sent").closest("li")).toHaveAttribute("data-state", "complete");
    expect(screen.getByText("Device acknowledged").closest("li")).toHaveAttribute("data-state", "complete");
    expect(screen.getByText("Fresh readback verified").closest("li")).toHaveAttribute("data-state", "complete");
    expect(screen.getByText("Activity recorded").closest("li")).toHaveAttribute("data-state", "complete");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/device-commands",
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Close receipt" }));
    fireEvent.click(screen.getByRole("link", { name: "Schedules" }));
    expect(await screen.findByRole("heading", { name: "Battery schedules" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Seven-day plan" })).toBeVisible();
    expect(screen.getAllByText("Overnight Eco").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Conflicts with another enabled schedule/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Review schedule/ }));
    expect(screen.getByText(/^Review:/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/schedules",
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(screen.getByRole("link", { name: "Disaster Prep / 停電対策" }));
    expect(await screen.findByRole("heading", { name: "Disaster Prep / 停電対策", level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("dialog", { name: "Start Disaster Prep" })).toBeVisible();
    expect(screen.getByText(/temporary changes are reversed/i)).toBeVisible();
  });

  it("never presents a readback mismatch as command success", async () => {
    mockApi("mismatched");
    render(
      <MemoryRouter initialEntries={["/battery"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Battery" });
    fireEvent.click(screen.getByRole("button", { name: "Charge" }));
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/readback did not match/i);
    expect(screen.queryByText(/device state was verified/i)).not.toBeInTheDocument();
    expect(screen.getByText("Device acknowledged").closest("li")).toHaveAttribute("data-state", "complete");
    expect(screen.getByText("Fresh readback verified").closest("li")).toHaveAttribute("data-state", "muted");
    expect(screen.getByRole("button", { name: "Close receipt" })).toBeEnabled();
  });

  it("saves everyday controls directly and clearly confirms success", async () => {
    const fetchMock = mockApi();
    render(
      <MemoryRouter initialEntries={["/battery"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Battery" });
    fireEvent.change(screen.getByLabelText("Minimum reserve"), { target: { value: "30" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/saved and verified on the battery/i)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/device-commands",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("discharge-limit") }),
    ));
  });

  it("makes schedule suspension explicit while Adaptive Charging is enabled", async () => {
    mockApi("succeeded", true);
    render(
      <MemoryRouter initialEntries={["/battery/schedules"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Schedules are disabled while Adaptive Charging is on/)).toBeVisible();
    expect(screen.getAllByText("Paused by Adaptive Charging")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Review schedule/ })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Disable" })[0]).toBeDisabled();
    expect(screen.getByText("0 planned changes")).toBeVisible();
  });
});
