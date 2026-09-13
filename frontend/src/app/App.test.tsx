import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwayPeriod, AwayPeriodsView } from "../api/contracts";
import { App } from "./App";
import { AppProviders } from "./providers";

const config = {
  updateIntervalSeconds: 15,
  language: "en",
  solarEnabled: true,
  smartCosmoEnabled: true,
  fuelCellEnabled: true,
  rateMode: "multi",
  batteryCapabilities: { usableCapacityKwh: 9.8, maximumChargeWatts: 3000 },
  adaptiveCharging: { enabled: false, latitude: 35.68, longitude: 139.76, arrayPeakKw: 5.5, panelTiltDegrees: 30, panelAzimuthDegrees: 0, targetSocPercent: 90, forecastMarginPercent: 10 },
  runtime: { uiDevelopment: true, simulatedDevices: true, externalIoDisabled: true },
};

const status = {
  read_at: new Date().toISOString(),
  savings: { sampleCount: 2, totalOffPeakSavingYen: 12, gridOffPeakSavingYen: 5, batteryOffPeakSavingYen: 7 },
  savingsPeriods: {
    today: { totalOffPeakSavingYen: 12, gridOffPeakSavingYen: 5, batteryOffPeakSavingYen: 7 },
    lastMonth: { totalOffPeakSavingYen: 310, gridOffPeakSavingYen: 110, batteryOffPeakSavingYen: 200 },
    month: { totalOffPeakSavingYen: 140, gridOffPeakSavingYen: 50, batteryOffPeakSavingYen: 90 },
    year: { totalOffPeakSavingYen: 2100, gridOffPeakSavingYen: 800, batteryOffPeakSavingYen: 1300 },
  },
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
    energySources: { peakGridKwh: 0.2, peakGridPercent: 5.6, offPeakGridKwh: 0.1, offPeakGridPercent: 2.8, solarUsedKwh: 2.4, solarUsedPercent: 66.7, fuelCellContributionKwh: 0.9, fuelCellContributionPercent: 25, totalKwh: 3.6 },
    circuits: [{ channel: 1, label: "Kitchen", totalKwh: 0.4, latestWatts: 420 }],
    dataQuality: { houseDemandKwh: { quality: "counter", coveragePercent: 100 } },
  },
};

const eneFarm = {
  configured: true,
  sampleCount: 2,
  start: "2026-09-12T00:00:00.000Z",
  end: "2026-09-12T12:00:00.000Z",
  generatedKwh: 0.5,
  gasM3: 0.22,
  electricalYieldKwhPerM3: 2.27,
  operatingSeconds: 7200,
  startCount: 1,
  averageGeneratingW: 500,
  currentState: "generating",
  timeInStateSeconds: 3600,
  lastStopAt: "2026-09-12T06:00:00.000Z",
  dataQuality: "counter",
  stateIntervals: [
    { start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T06:00:00.000Z", state: "stopped", durationSeconds: 21600, generatedKwh: 0 },
    { start: "2026-09-12T06:00:00.000Z", end: "2026-09-12T12:00:00.000Z", state: "generating", durationSeconds: 21600, generatedKwh: 0.5 },
  ],
};

const schedules = [
  { id: "schedule-1", name: "Overnight Eco", action: "vendor-profile", payload: { mode: "eco" }, repeat: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: "02:00", enabled: true, lastResult: { ok: true, at: "2026-09-12T02:00:00.000Z" } },
  { id: "schedule-2", name: "Reserve before morning", action: "discharge-limit", payload: { percent: 40 }, repeat: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: "02:00", enabled: true },
];

const automationStart = new Date(Date.now() - 30 * 60_000);
const automationMiddle = new Date(Date.now() + 30 * 60_000);
const automationEnd = new Date(Date.now() + 90 * 60_000);
const adaptiveCharging = {
  enabled: true,
  available: true,
  paused: false,
  owner: "adaptiveCharging",
  activeSlot: { start: automationStart.toISOString(), end: automationMiddle.toISOString(), targetWh: 1200, targetSocPercent: 82 },
  forecast: { fetchedAt: new Date().toISOString(), ageMs: 120_000, stale: false },
  plan: {
    available: true,
    reason: "Charging now uses the least expensive available window before forecast household demand.",
    targetSunset: automationEnd.toISOString(),
    currentSocPercent: 68,
    targetSocPercent: 90,
    expectedSunsetSocPercent: 88,
    predictedSolarKwh: 3.2,
    predictedDemandKwh: 5.8,
    predictedFuelCellKwh: 1.1,
    predictedSurplusKwh: 0.4,
    plannedChargeKwh: 1.2,
    demandHistory: { recordedDayCount: 12, validDayCount: 9, recentComparableDayCount: 7, seasonalComparableDayCount: 2 },
    slots: [{ start: automationStart.toISOString(), end: automationMiddle.toISOString(), targetWh: 1200, targetSocPercent: 82 }],
    timeline: [
      { start: automationStart.toISOString(), end: automationMiddle.toISOString(), demandW: 1800, solarW: 0, plannedChargeWh: 1200, discounted: true, rateLabel: "Night" },
      { start: automationMiddle.toISOString(), end: automationEnd.toISOString(), demandW: 2100, solarW: 900, plannedChargeWh: 0, discounted: false },
    ],
  },
  batteryModel: { version: 3, status: "learning", charge: { acceptedObservationCount: 4, distinctDays: 2 }, discharge: { acceptedObservationCount: 3, distinctDays: 2 }, power: { sampleCount: 48, sessionCount: 2 } },
  solarForecastAccuracy: { learned: false, sampleCount: 3, outcomes: [{ targetDate: "2026-09-12", predictedKwh: 3.4, planningKwh: 3.1, actualKwh: 3.0, errorKwh: -0.4 }] },
  fuelCellForecastOutcomes: [{ targetStart: automationStart.toISOString(), start: automationStart.toISOString(), end: automationMiddle.toISOString(), medianW: 500, actualKwh: 0.22, influence: "planning" }],
  windowSummaries: [{ key: "window-1", windowStart: automationStart.toISOString(), windowEnd: automationMiddle.toISOString(), label: "Night", plannedWh: 1200, deliveredWh: 1100, estimatedDeliveryWh: 50, startSocPercent: 68, endSocPercent: 81, targetSocPercent: 82, unmetWh: 100 }],
  log: [{ at: new Date().toISOString(), kind: "plan", message: "Selected the discounted charging window." }],
};
const automationRules = [{ id: "guard-1", name: "Charging demand guard", type: "backup-demand-guard", enabled: true, conditions: { breakerAmps: 40, breakerVoltage: 100, reserveAmps: 5, restoreBelowAmps: 30, restoreDelaySeconds: 300 }, state: { awaitingRestore: false }, log: [{ at: new Date(Date.now() - 60_000).toISOString(), kind: "monitoring", message: "Breaker headroom is within the configured limit." }] }];
const awayPeriods: AwayPeriodsView = { periods: [{ id: "away-1", from: automationEnd.toISOString(), until: new Date(automationEnd.getTime() + 86_400_000).toISOString(), status: "scheduled", source: "scheduled" }], active: null, next: { id: "away-1", from: automationEnd.toISOString(), until: new Date(automationEnd.getTime() + 86_400_000).toISOString(), status: "scheduled", source: "scheduled" }, state: "home", returnBufferMinutes: 30 };
const automationReceipts = [{ commandId: "automation-command-1", action: "set-mode", source: "adaptive-charging", request: { mode: "charging" }, state: "mismatched", requestedAt: new Date(Date.now() - 120_000).toISOString(), completedAt: new Date(Date.now() - 90_000).toISOString(), message: "Charging request was acknowledged but readback remained Standby", events: [] }];

function localDateTimeForTest(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function mockApi(
  commandState: "succeeded" | "mismatched" = "succeeded",
  adaptiveEnabled = false,
  adaptiveOverride: Record<string, unknown> = {},
  awayView: AwayPeriodsView = awayPeriods,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = url.endsWith("/api/config")
      ? { ...config, adaptiveCharging: { ...config.adaptiveCharging, enabled: adaptiveEnabled } }
      : url.includes("/api/history?")
        ? history
        : url.includes("/api/ene-farm?")
          ? eneFarm
        : url.endsWith("/api/adaptive-charging")
          ? { ...adaptiveCharging, enabled: adaptiveEnabled, available: adaptiveEnabled, ...adaptiveOverride }
        : url.endsWith("/api/automation-rules")
          ? automationRules
        : url.endsWith("/api/away-periods")
          ? awayView
        : url.includes("/api/command-receipts")
          ? { receipts: automationReceipts }
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
    expect(screen.getByRole("heading", { name: "Energy outcomes" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Full history →" })).toHaveAttribute("href", "/energy");
    expect(screen.queryByRole("img", { name: /Last 24 hours of home energy/ })).not.toBeInTheDocument();
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
    expect(screen.getByRole("group", { name: /Visible metrics/ })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Solar" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Solar" }));
    expect(screen.getByRole("checkbox", { name: "Solar" })).not.toBeChecked();
    expect(screen.queryByLabelText("Chart series")).not.toBeInTheDocument();
    expect(screen.getAllByText("Kitchen").length).toBeGreaterThan(0);
    expect(screen.getByText(/minimum coverage 100%/)).toBeVisible();
    expect(screen.getByText("3.2 kWh")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Circuit history" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Kitchen circuit power history" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ene-Farm Activity" })).toBeVisible();
    expect(screen.getByText("Electricity generated")).toBeVisible();
    expect(screen.queryByRole("button", { name: /charge|discharge|backup/i })).not.toBeInTheDocument();
  });

  it("restores source composition, Ene-Farm activity, and three off-peak savings views on Overview", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Energy Sources" })).toBeVisible();
    expect(screen.getByRole("img", { name: /Peak grid 5.6%/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Today at a glance" })).toBeVisible();
    expect(screen.getAllByText("Today", { exact: true })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Ene-Farm Activity" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Ene-Farm operating states for today" })).toBeVisible();
    const stoppedInterval = screen.getByRole("img", { name: /Stopped\. Start .* Finish .* Duration 6h 0m 0s/ });
    fireEvent.pointerEnter(stoppedInterval);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Stopped/);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/6h 0m 0s/);
    fireEvent.pointerLeave(stoppedInterval);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Estimated Off-Peak Savings" })).toBeVisible();
    expect(screen.getByText("¥12")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Grid use" }));
    expect(screen.getByText("¥5")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Battery charging" }));
    expect(screen.getByText("¥7")).toBeVisible();
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

  it("turns Automation into one explainable control center", async () => {
    const fetchMock = mockApi("succeeded", true);
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Automation" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Learning" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Charge until/ })).toBeVisible();
    expect(screen.getByText(/least expensive available window/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Active protections" })).toBeVisible();
    expect(screen.getByLabelText("Today and tonight automation plan")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Away schedule" })).toBeVisible();
    expect(screen.getByText("Selected the discounted charging window.")).toBeVisible();
    expect(screen.getByText("Charging request was acknowledged but readback remained Standby")).toBeVisible();
    expect(screen.getByText("Readback mismatch")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Performance" }));
    expect(screen.getByRole("heading", { name: "Forecast and control performance" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Historical model" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Charging-window outcomes" })).toBeVisible();
    expect(screen.getByText("9", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("1.1 kWh")).toBeVisible();
    expect(screen.getByText("100 Wh short")).toBeVisible();
    expect(screen.getAllByText("3 days").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
    expect(screen.getByText("6/6 ready")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open rate settings/ })).toHaveAttribute("href", "/?page=settings&focus=rateConfigForm");
    expect(screen.getAllByRole("link", { name: /Review planning settings/ })[0]).toHaveAttribute("href", "#adaptive-settings");
    expect(screen.getByRole("heading", { name: "Adaptive Charging configuration" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Demand Guard configuration" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    expect(screen.getByRole("dialog", { name: "Apply Adaptive Charging settings" })).toBeVisible();
    expect(screen.getByText(/control battery charging after the next plan/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save and recalculate" }));
    expect(await screen.findByText(/settings saved.*fresh plan has been queued/i)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining("maximumChargeWatts") }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Save Demand Guard" }));
    expect(screen.getByRole("dialog", { name: "Enable Demand Guard" })).toBeVisible();
    expect(screen.getByText(/place the battery in Standby/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Enable protection" }));
    expect(await screen.findByText("Demand Guard settings saved.")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/automation-rules/guard-1",
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining("restoreDelaySeconds") }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Recalculate plan" }));
    expect(await screen.findByText("Plan recalculated successfully.")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/adaptive-charging/recalculate",
      expect.objectContaining({ method: "POST" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save period" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/away-periods/away-1",
      expect.objectContaining({ method: "PATCH" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Remove this period?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/away-periods/away-1",
      expect.objectContaining({ method: "DELETE" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Away now" }));
    expect(screen.getByText(/Confirm when you expect to return/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start Away period" }));
    expect(await screen.findByText(/Away period saved and plan recalculation queued/)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/away-periods",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"source":"manual"') }),
    ));
  });

  it("reviews the impact before resuming paused automation", async () => {
    const fetchMock = mockApi("succeeded", true, { paused: true, pausedUntil: null, owner: null });
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Paused" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("dialog", { name: "Resume Adaptive Charging" })).toBeVisible();
    expect(screen.getByText(/may resume control of battery charging/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume automation" }));
    expect(await screen.findByText(/fresh plan has been queued/i)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/adaptive-charging/resume",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it.each([
    ["Running", { paused: false, available: true, batteryModel: { ...adaptiveCharging.batteryModel, status: "active" } }],
    ["Degraded", { paused: false, available: false, reason: "Forecast service unavailable", batteryModel: { ...adaptiveCharging.batteryModel, status: "active" } }],
  ])("reports the %s automation master state", async (label, adaptiveOverride) => {
    mockApi("succeeded", true, adaptiveOverride);
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: label })).toBeVisible();
  });

  it("extends an active Away period and provides a fast Back home action", async () => {
    const active: AwayPeriod = { id: "away-active", from: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 3_600_000).toISOString(), status: "active", source: "manual" };
    const fetchMock = mockApi("succeeded", true, {}, { periods: [active], active, next: null, state: "away", returnBufferMinutes: 30 });
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders><App /></AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Away now", { selector: "strong" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Extend" }));
    fireEvent.change(screen.getByLabelText("Away until"), { target: { value: localDateTimeForTest(new Date(Date.now() + 7_200_000)) } });
    fireEvent.click(screen.getByRole("button", { name: "Save extension" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/away-periods/away-active/extend",
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Back home" }));
    expect(await screen.findByText(/Home state restored/)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/away-periods/away-active/back-home",
      expect.objectContaining({ method: "POST" }),
    ));
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
    fireEvent.click(screen.getByRole("link", { name: "Disaster Prep" }));
    expect(await screen.findByRole("heading", { name: "Disaster Prep", level: 1 })).toBeVisible();
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
