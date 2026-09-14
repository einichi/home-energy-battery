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
  batteryHost: "192.0.2.10",
  meterHost: "192.0.2.20",
  solarHost: "192.0.2.30",
  fuelCellPrimaryHost: "192.0.2.40",
  fuelCellProxyHosts: ["192.0.2.41"],
  discoverySubnets: ["192.0.2.0/24"],
  circuitLabels: { 1: "Kitchen", 2: "Laundry", 3: "Office" },
  dashboardWidgets: [
    { id: "adaptiveCharging", visible: true },
    { id: "backupPreparation", visible: true },
    { id: "energySources", visible: true },
  ],
  batteryCapabilities: { usableCapacityKwh: 9.8, maximumChargeWatts: 3000 },
  adaptiveCharging: {
    enabled: false,
    latitude: 35.68,
    longitude: 139.76,
    arrayPeakKw: 5.5,
    panelTiltDegrees: 30,
    panelAzimuthDegrees: 0,
    targetSocPercent: 90,
    forecastMarginPercent: 10,
  },
  runtime: {
    uiDevelopment: true,
    simulatedDevices: true,
    externalIoDisabled: true,
  },
};

const status = {
  read_at: new Date().toISOString(),
  savings: {
    sampleCount: 2,
    totalOffPeakSavingYen: 12,
    gridOffPeakSavingYen: 5,
    batteryOffPeakSavingYen: 7,
  },
  savingsPeriods: {
    today: {
      totalOffPeakSavingYen: 12,
      gridOffPeakSavingYen: 5,
      batteryOffPeakSavingYen: 7,
    },
    lastMonth: {
      totalOffPeakSavingYen: 310,
      gridOffPeakSavingYen: 110,
      batteryOffPeakSavingYen: 200,
    },
    month: {
      totalOffPeakSavingYen: 140,
      gridOffPeakSavingYen: 50,
      batteryOffPeakSavingYen: 90,
    },
    year: {
      totalOffPeakSavingYen: 2100,
      gridOffPeakSavingYen: 800,
      batteryOffPeakSavingYen: 1300,
    },
  },
  batteryStrategy: {
    kind: "device-auto",
    title: "Device-managed operation",
    description: "No application automation currently owns the battery.",
    manualOverride: { active: false },
  },
  energy: {
    battery: {
      instant_power: { value: -720 },
      remaining_percent: { value: 68 },
      working_status: { value: "discharging" },
      operation_mode: { value: "auto" },
      vendor_profile: { value: "eco" },
    },
    solar: { instant_power: { value: 2450 } },
    fuel_cells: [
      {
        source_role: "primary",
        instant_power: { value: 510 },
        generation_status: { value: "generating" },
        hot_water_level: { value: 4 },
      },
    ],
  },
  meter: {
    house_demand_power: { value: 3210 },
    grid_import_power: { value: 250 },
    grid_export_power: { value: 0 },
    channel_power: {
      decoded: {
        channels: [
          { channel: 1, value: 420 },
          { channel: 2, value: 900 },
          { channel: 3, value: 120 },
        ],
      },
    },
  },
};

const history = {
  samples: [
    {
      timestamp: "2026-09-12T11:00:00.000Z",
      houseDemandW: 2800,
      solarPowerW: 2200,
      fuelCellPowerW: 500,
      batteryPowerW: -400,
      stateOfChargePercent: 70,
      gridImportW: 500,
      gridExportW: 0,
      circuitPowerW: { 1: 400, 2: 850, 3: 100 },
    },
    {
      timestamp: "2026-09-12T12:00:00.000Z",
      houseDemandW: 3210,
      solarPowerW: 2450,
      fuelCellPowerW: 510,
      batteryPowerW: -720,
      stateOfChargePercent: 68,
      gridImportW: 250,
      gridExportW: 0,
      circuitPowerW: { 1: 420, 2: 900, 3: 120 },
    },
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
    energySources: {
      peakGridKwh: 0.2,
      peakGridPercent: 5.6,
      offPeakGridKwh: 0.1,
      offPeakGridPercent: 2.8,
      solarUsedKwh: 2.4,
      solarUsedPercent: 66.7,
      fuelCellContributionKwh: 0.9,
      fuelCellContributionPercent: 25,
      totalKwh: 3.6,
    },
    circuits: [
      { channel: 1, label: "Kitchen", totalKwh: 0.4, latestWatts: 420 },
      { channel: 2, label: "Laundry", totalKwh: 0.8, latestWatts: 900 },
      { channel: 3, label: "Office", totalKwh: 0.2, latestWatts: 120 },
    ],
    dataQuality: {
      houseDemandKwh: { quality: "counter", coveragePercent: 100 },
    },
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
    {
      start: "2026-09-12T00:00:00.000Z",
      end: "2026-09-12T06:00:00.000Z",
      state: "stopped",
      durationSeconds: 21600,
      generatedKwh: 0,
    },
    {
      start: "2026-09-12T06:00:00.000Z",
      end: "2026-09-12T12:00:00.000Z",
      state: "generating",
      durationSeconds: 21600,
      generatedKwh: 0.5,
    },
  ],
};

const energyReport = {
  start: "2026-08-13T00:00:00.000Z",
  end: "2026-09-13T00:00:00.000Z",
  bucket: "day",
  totals: {
    key: "total",
    label: "Selected period",
    houseDemandKwh: 84,
    solarGenerationKwh: 42,
    gridImportKwh: 39,
    gridExportKwh: 8,
    fuelCellKwh: 12,
    totalOffPeakSavingYen: 640,
    gridOffPeakSavingYen: 240,
    batteryOffPeakSavingYen: 400,
    solarSavingYen: 1470,
    co2SavingKg: 17.8,
    solarCoveragePercent: 50,
    peakDemandW: 5200,
  },
  buckets: [
    {
      key: "2026-09-11",
      label: "2026-09-11",
      start: "2026-09-11T00:00:00.000Z",
      end: "2026-09-12T00:00:00.000Z",
      houseDemandKwh: 3,
      solarGenerationKwh: 1.2,
      gridImportKwh: 1.5,
      gridExportKwh: 0.1,
      fuelCellKwh: 0.5,
      peakDemandW: 4100,
      sampleCount: 48,
      dataQuality: { houseDemandKwh: { coveragePercent: 100 } },
    },
    {
      key: "2026-09-12",
      label: "2026-09-12",
      start: "2026-09-12T00:00:00.000Z",
      end: "2026-09-13T00:00:00.000Z",
      houseDemandKwh: 3.3,
      houseDemandDeltaKwh: 0.3,
      houseDemandDeltaPercent: 10,
      solarGenerationKwh: 1.6,
      gridImportKwh: 1.4,
      gridExportKwh: 0.2,
      fuelCellKwh: 0.6,
      peakDemandW: 4300,
      sampleCount: 48,
      dataQuality: { houseDemandKwh: { coveragePercent: 98 } },
    },
  ],
  features: {
    solarEnabled: true,
    smartCosmoEnabled: true,
    fuelCellEnabled: true,
  },
  meta: { recordsRead: 96, resolution: "30-minute" },
};
const eneFarmReport = {
  start: energyReport.start,
  end: energyReport.end,
  bucket: "day",
  estimateNotice: "All costs and savings are estimates.",
  totals: {
    key: "total",
    label: "Selected period",
    generatedKwh: 12,
    gasM3: 5,
    electricalYieldKwhPerM3: 2.4,
    operatingSeconds: 72000,
    startCount: 5,
    estimatedGasCost: { marginalCostYen: 810 },
    carbon: { electricityOnlyBalanceKg: 1.2 },
  },
  buckets: [
    {
      key: "2026-09-12",
      label: "2026-09-12",
      generatedKwh: 0.6,
      gasM3: 0.25,
      electricalYieldKwhPerM3: 2.4,
      operatingSeconds: 3600,
      startCount: 1,
      estimatedGasCost: { marginalCostYen: 42 },
      carbon: { electricityOnlyBalanceKg: 0.08 },
    },
  ],
};
const notifications = {
  config: {
    enabled: false,
    channels: [
      {
        id: "primary-email",
        type: "smtp",
        enabled: true,
        settings: {
          host: "",
          port: 587,
          security: "starttls",
          username: "",
          from: "",
          recipients: [],
        },
      },
    ],
    triggers: {
      deviceOffline: { enabled: true, cooldownMinutes: 60 },
      lowBattery: {
        enabled: false,
        cooldownMinutes: 120,
        thresholdPercent: 20,
      },
    },
  },
  passwordConfigured: true,
  deliveries: [
    {
      at: "2026-09-12T12:00:00.000Z",
      ok: false,
      event: { title: "Battery unavailable", type: "deviceOffline" },
      attempts: [{ channelId: "primary-email", ok: false, error: "Connection refused" }],
    },
  ],
};

const schedules = [
  {
    id: "schedule-1",
    name: "Overnight Eco",
    action: "vendor-profile",
    payload: { mode: "eco" },
    repeat: "daily",
    days: [0, 1, 2, 3, 4, 5, 6],
    time: "02:00",
    enabled: true,
    lastResult: { ok: true, at: "2026-09-12T02:00:00.000Z" },
  },
  {
    id: "schedule-2",
    name: "Reserve before morning",
    action: "discharge-limit",
    payload: { percent: 40 },
    repeat: "daily",
    days: [0, 1, 2, 3, 4, 5, 6],
    time: "02:00",
    enabled: true,
  },
];

const automationStart = new Date(Date.now() - 30 * 60_000);
const automationMiddle = new Date(Date.now() + 30 * 60_000);
const automationEnd = new Date(Date.now() + 90 * 60_000);
const adaptiveCharging = {
  enabled: true,
  available: true,
  paused: false,
  owner: "adaptiveCharging",
  activeSlot: {
    start: automationStart.toISOString(),
    end: automationMiddle.toISOString(),
    targetWh: 1200,
    targetSocPercent: 82,
  },
  forecast: {
    fetchedAt: new Date().toISOString(),
    ageMs: 120_000,
    stale: false,
  },
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
    demandHistory: {
      recordedDayCount: 12,
      validDayCount: 9,
      recentComparableDayCount: 7,
      seasonalComparableDayCount: 2,
    },
    slots: [
      {
        start: automationStart.toISOString(),
        end: automationMiddle.toISOString(),
        targetWh: 1200,
        targetSocPercent: 82,
      },
    ],
    timeline: [
      {
        start: automationStart.toISOString(),
        end: automationMiddle.toISOString(),
        demandW: 1800,
        solarW: 0,
        plannedChargeWh: 1200,
        discounted: true,
        rateLabel: "Night",
      },
      {
        start: automationMiddle.toISOString(),
        end: automationEnd.toISOString(),
        demandW: 2100,
        solarW: 900,
        plannedChargeWh: 0,
        discounted: false,
      },
    ],
  },
  batteryModel: {
    version: 3,
    status: "learning",
    charge: { acceptedObservationCount: 4, distinctDays: 2 },
    discharge: { acceptedObservationCount: 3, distinctDays: 2 },
    power: { sampleCount: 48, sessionCount: 2 },
  },
  solarForecastAccuracy: {
    learned: false,
    sampleCount: 3,
    outcomes: [
      {
        targetDate: "2026-09-12",
        predictedKwh: 3.4,
        planningKwh: 3.1,
        actualKwh: 3.0,
        errorKwh: -0.4,
      },
    ],
  },
  fuelCellForecastOutcomes: [
    {
      targetStart: automationStart.toISOString(),
      start: automationStart.toISOString(),
      end: automationMiddle.toISOString(),
      medianW: 500,
      actualKwh: 0.22,
      influence: "planning",
    },
  ],
  windowSummaries: [
    {
      key: "window-1",
      windowStart: automationStart.toISOString(),
      windowEnd: automationMiddle.toISOString(),
      label: "Night",
      plannedWh: 1200,
      deliveredWh: 1100,
      estimatedDeliveryWh: 50,
      startSocPercent: 68,
      endSocPercent: 81,
      targetSocPercent: 82,
      unmetWh: 100,
    },
  ],
  log: [
    {
      at: new Date().toISOString(),
      kind: "plan",
      message: "Selected the discounted charging window.",
    },
  ],
};
const automationRules = [
  {
    id: "guard-1",
    name: "Charging demand guard",
    type: "backup-demand-guard",
    enabled: true,
    conditions: {
      breakerAmps: 40,
      breakerVoltage: 100,
      reserveAmps: 5,
      restoreBelowAmps: 30,
      restoreDelaySeconds: 300,
    },
    state: { awaitingRestore: false },
    log: [
      {
        at: new Date(Date.now() - 60_000).toISOString(),
        kind: "monitoring",
        message: "Breaker headroom is within the configured limit.",
      },
    ],
  },
];
const awayPeriods: AwayPeriodsView = {
  periods: [
    {
      id: "away-1",
      from: automationEnd.toISOString(),
      until: new Date(automationEnd.getTime() + 86_400_000).toISOString(),
      status: "scheduled",
      source: "scheduled",
    },
  ],
  active: null,
  next: {
    id: "away-1",
    from: automationEnd.toISOString(),
    until: new Date(automationEnd.getTime() + 86_400_000).toISOString(),
    status: "scheduled",
    source: "scheduled",
  },
  state: "home",
  returnBufferMinutes: 30,
};
const automationReceipts = [
  {
    commandId: "automation-command-1",
    action: "set-mode",
    source: "adaptive-charging",
    request: { mode: "charging" },
    state: "mismatched",
    requestedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 90_000).toISOString(),
    message: "Charging request was acknowledged but readback remained Standby",
    events: [],
  },
];

function localDateTimeForTest(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function mockApi(
  commandState: "succeeded" | "mismatched" = "succeeded",
  adaptiveEnabled = false,
  adaptiveOverride: Record<string, unknown> = {},
  awayView: AwayPeriodsView = awayPeriods,
  language: "en" | "ja" = "en",
  configOverride: Record<string, unknown> = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = url.includes("/api/reports/energy?")
      ? energyReport
      : url.includes("/api/reports/ene-farm?")
        ? eneFarmReport
        : url.endsWith("/api/notifications")
          ? notifications
          : url.endsWith("/api/history/stats")
            ? {
                sizeBytes: 2048,
                sampleCount: 96,
                daysRecorded: 2,
                rollups: { interval: 48, daily: 2 },
                schemaVersion: 7,
              }
            : url.endsWith("/api/database-backups")
              ? { schemaVersion: 7, operation: { busy: false }, backups: [] }
              : url.endsWith("/api/discovery/jobs") && init?.method === "POST"
                ? {
                    id: "discovery-1",
                    status: "running",
                    phase: "broadcast",
                    scanned: 0,
                    total: 10,
                    found: 0,
                  }
                : url.endsWith("/api/discovery/jobs/discovery-1")
                  ? {
                      id: "discovery-1",
                      status: "complete",
                      phase: "complete",
                      scanned: 10,
                      total: 10,
                      found: 1,
                      result: {
                        discovered: [{ host: "192.0.2.50", roles: ["battery"] }],
                      },
                    }
                  : url.endsWith("/api/config")
                    ? {
                        ...config,
                        ...configOverride,
                        language,
                        adaptiveCharging: {
                          ...config.adaptiveCharging,
                          enabled: adaptiveEnabled,
                          ...((configOverride.adaptiveCharging as Record<string, unknown>) ?? {}),
                        },
                      }
                    : url.includes("/api/history?")
                      ? history
                      : url.includes("/api/ene-farm?")
                        ? eneFarm
                        : url.endsWith("/api/adaptive-charging")
                          ? {
                              ...adaptiveCharging,
                              enabled: adaptiveEnabled,
                              available: adaptiveEnabled,
                              ...adaptiveOverride,
                            }
                          : url.endsWith("/api/automation-rules")
                            ? automationRules
                            : url.endsWith("/api/away-periods")
                              ? awayView
                              : url.includes("/api/command-receipts")
                                ? { receipts: automationReceipts }
                                : url.includes("/api/device-commands/command-1")
                                  ? {
                                      commandId: "command-1",
                                      action: "charge",
                                      source: "manual",
                                      request: { targetWh: 500 },
                                      state: commandState,
                                      requestedAt: new Date().toISOString(),
                                      completedAt: new Date().toISOString(),
                                      message: commandState === "succeeded" ? "charge was verified" : "expected charging, observed standby",
                                      error: commandState === "mismatched" ? "expected charging, observed standby" : null,
                                      events: [
                                        {
                                          eventKey: "command:command-1:sending",
                                          at: new Date().toISOString(),
                                          type: "sending",
                                        },
                                        {
                                          eventKey: "command:command-1:acknowledged",
                                          at: new Date().toISOString(),
                                          type: "acknowledged",
                                        },
                                        {
                                          eventKey: `command:command-1:${commandState}`,
                                          at: new Date().toISOString(),
                                          type: commandState,
                                        },
                                      ],
                                    }
                                  : url.endsWith("/api/schedules") && (!init?.method || init.method === "GET")
                                    ? schedules
                                    : url.endsWith("/api/backup-preparation")
                                      ? {
                                          active: false,
                                          phase: "inactive",
                                          allowDemandGuard: true,
                                          log: [],
                                        }
                                      : url.endsWith("/api/device-commands") && init?.method === "POST"
                                        ? {
                                            commandId: "command-1",
                                            commandState: "requested",
                                          }
                                        : init?.method === "POST"
                                          ? {
                                              commandId: "command-1",
                                              commandState: "succeeded",
                                              completedAt: new Date().toISOString(),
                                              acknowledged: true,
                                              verified: true,
                                            }
                                          : status;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("React application shell", () => {
  it("localizes navigation and controls without bilingual labels", async () => {
    mockApi("succeeded", false, {}, awayPeriods, "ja");
    render(
      <MemoryRouter initialEntries={["/battery/backup"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "停電対策", level: 1 })).toBeVisible();
    expect(screen.getByRole("link", { name: "停電対策" })).toBeVisible();
    expect(screen.queryByText("Disaster Prep / 停電対策")).not.toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "ja");
    expect(screen.getByRole("link", { name: "メインコンテンツへ移動" })).toHaveAttribute("href", "#main-content");
  });

  it("turns reports into outcome-oriented Insights with period and domain controls", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/insights"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Insights" })).toBeVisible();
    expect(await screen.findByRole("img", { name: /Energy use, solar generation/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Period comparison" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Estimated savings breakdown" })).toBeVisible();
    expect(screen.getByText("¥640")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ene-Farm" }));
    expect(await screen.findByRole("heading", { name: "Ene-Farm detail" })).toBeVisible();
    expect(screen.getByText("12 kWh")).toBeVisible();
  });

  it("routes System administration by task and saves equipment without device commands", async () => {
    const fetchMock = mockApi();
    render(
      <MemoryRouter initialEntries={["/system/equipment"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "System" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Installed equipment" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Smart Cosmo circuits" })).toBeVisible();
    expect(screen.getByLabelText("Circuit 1 label")).toBeVisible();
    expect(screen.getByLabelText("Battery address")).toHaveValue("");
    expect(screen.getByLabelText("Battery address")).toHaveAttribute("placeholder", "192.0.2.10");
    expect(screen.getByLabelText("Discovery subnets")).toHaveValue("");
    expect(screen.getByLabelText("Discovery subnets")).toHaveAttribute("placeholder", "192.0.2.0/24");
    fireEvent.click(screen.getByRole("button", { name: "Save equipment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT" })));
    const equipmentResult = await screen.findByText("Equipment settings saved.");
    expect(equipmentResult).toBeVisible();
    expect(equipmentResult.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save equipment" }));
    fireEvent.click(screen.getByRole("button", { name: "Broadcast discovery" }));
    expect(await screen.findByText(/Listening for equipment responses|0 of 10 addresses/)).toBeVisible();
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(await screen.findByText("Discovery complete")).toBeVisible();
    expect(screen.getByText(/192\.0\.2\.50/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Circuit 1 label"), {
      target: { value: "Kitchen" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save circuits" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/config",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"Kitchen"'),
        }),
      ),
    );
    const circuitResult = await screen.findByText("Circuit settings saved.");
    expect(circuitResult.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save circuits" }));
  });

  it("shows notification parameters, secret state, and durable delivery outcomes", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/system/notifications"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Email notifications" })).toBeVisible();
    expect(screen.getByText("Password stored")).toBeVisible();
    expect(screen.getByLabelText("deviceOffline cooldown")).toHaveValue(60);
    expect(screen.getByLabelText("Low battery threshold")).toHaveValue(20);
    expect(screen.getByRole("heading", { name: "Recent deliveries" })).toBeVisible();
    expect(screen.getByText(/Failed · Battery unavailable/)).toBeVisible();
    expect(screen.getByText("Connection refused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send test email" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));
    const result = await screen.findByText("Notification settings saved.");
    expect(result.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save notifications" }));
  });

  it("places rate-setting confirmations beside the form that was saved", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/system/rates"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save rates" }));
    const result = await screen.findByText("Rate and emissions settings saved.");
    expect(result.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save rates" }));
  });

  it("reviews retention maintenance before removing historical records", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/system/data"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Storage health" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    const retentionResult = await screen.findByText("Retention policy saved.");
    expect(retentionResult.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save retention" }));
    fireEvent.click(screen.getByRole("button", { name: "Run maintenance now" }));
    expect(screen.getByRole("dialog", { name: "Run retention maintenance now?" })).toBeVisible();
    expect(screen.getByText(/Records older than the values shown/)).toBeVisible();
  });

  it("renders a simulator banner and read-only overview from the API", async () => {
    mockApi();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders>
          <App />
        </AppProviders>
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
    expect(screen.getByRole("heading", { name: "Circuits consuming most power" })).toBeVisible();
    const topCircuits = screen.getByRole("heading", { name: "Circuits consuming most power" }).closest("section");
    expect(topCircuits).toHaveTextContent(/Laundry/);
    expect(topCircuits).toHaveTextContent(/900 W/);
    expect(topCircuits?.querySelector("li:first-child")).toHaveTextContent(/Laundry/);
  });

  it("consolidates current, historical, quality, and circuit data on Energy", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/energy"]}>
        <AppProviders>
          <App />
        </AppProviders>
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
    expect(screen.queryByRole("combobox", { name: "Circuit" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Office" }));
    expect(screen.getByRole("img", { name: "Office circuit power history" })).toBeVisible();
    const circuitTable = screen.getByRole("button", { name: /Power now/ }).closest("table")!;
    expect(circuitTable.querySelector("tbody tr:first-child")).toHaveTextContent("Laundry");
    fireEvent.click(screen.getByRole("button", { name: /Circuit/ }));
    expect(circuitTable.querySelector("tbody tr:first-child")).toHaveTextContent("Kitchen");
    expect(screen.getByRole("heading", { name: "Ene-Farm Activity" })).toBeVisible();
    expect(screen.getByText("Electricity generated")).toBeVisible();
    expect(screen.queryByRole("button", { name: /charge|discharge|backup/i })).not.toBeInTheDocument();
  });

  it("restores source composition, Ene-Farm activity, and three off-peak savings views on Overview", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Energy Sources" })).toBeVisible();
    expect(screen.getByRole("img", { name: /Peak grid 5.6%/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Today at a glance" })).toBeVisible();
    expect(screen.getAllByText("Today", { exact: true })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Ene-Farm Activity" })).toBeVisible();
    expect(
      screen.getByRole("group", {
        name: "Ene-Farm operating states for today",
      }),
    ).toBeVisible();
    const stoppedInterval = screen.getByRole("img", {
      name: /Stopped\. Start .* Finish .* Duration 6h 0m 0s/,
    });
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

  it("returns unknown routes to the React overview", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/removed-route"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Home energy overview" })).toBeVisible();
  });

  it("turns Automation into one explainable control center", async () => {
    const fetchMock = mockApi("succeeded", true);
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders>
          <App />
        </AppProviders>
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
    expect(screen.getByRole("link", { name: /Open rate settings/ })).toHaveAttribute("href", "/ui/system/rates");
    expect(screen.getByText("Off-peak electricity pricing")).toBeVisible();
    expect(screen.queryByText("Multi-rate electricity pricing")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Review planning settings/ })[0]).toHaveAttribute("href", "#adaptive-settings");
    expect(screen.getByRole("heading", { name: "Adaptive Charging configuration" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Demand Guard configuration" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    expect(screen.getByRole("dialog", { name: "Apply Adaptive Charging settings" })).toBeVisible();
    expect(screen.getByText(/control battery charging after the next plan/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save and recalculate" }));
    expect(await screen.findByText(/settings saved.*fresh plan has been queued/i)).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/config",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining("maximumChargeWatts"),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Demand Guard" }));
    expect(screen.getByRole("dialog", { name: "Enable Demand Guard" })).toBeVisible();
    expect(screen.getByText(/place the battery in Standby/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Enable protection" }));
    expect(await screen.findByText("Demand Guard settings saved.")).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/automation-rules/guard-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("restoreDelaySeconds"),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Recalculate plan" }));
    expect(await screen.findByText("Plan recalculated successfully.")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/adaptive-charging/recalculate", expect.objectContaining({ method: "POST" })));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save period" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/away-periods/away-1", expect.objectContaining({ method: "PATCH" })));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Remove this period?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/away-periods/away-1", expect.objectContaining({ method: "DELETE" })));

    fireEvent.click(screen.getByRole("button", { name: "Away now" }));
    expect(screen.getByText(/Confirm when you expect to return/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start Away period" }));
    expect(await screen.findByText(/Away period saved and plan recalculation queued/)).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/away-periods",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"source":"manual"'),
        }),
      ),
    );
  });

  it("accepts one off-peak rate window as sufficient for Automation", async () => {
    mockApi("succeeded", false, {}, awayPeriods, "en", { rateMode: "offPeak" });
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    const prerequisite = screen.getByText("Off-peak electricity pricing").closest("li");
    expect(prerequisite).toHaveAttribute("data-ready", "true");
    expect(screen.getByText(/One discounted off-peak window is enough/)).toBeVisible();
  });

  it("uses consistent Overview visibility names and the Settings mobile label", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/system/preferences"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Application preferences" })).toBeVisible();
    expect(screen.getByText("Adaptive charging")).toBeVisible();
    expect(screen.getByText("Disaster prep")).toBeVisible();
    expect(screen.getByText("Energy sources")).toBeVisible();
    expect(
      screen.queryByText("Energy Sources", {
        selector: ".widget-visibility-grid span",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Settings" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    const result = await screen.findByText("Preferences saved.");
    expect(result.closest(".form-footer")).toContainElement(screen.getByRole("button", { name: "Save preferences" }));
  });

  it("reviews the impact before resuming paused automation", async () => {
    const fetchMock = mockApi("succeeded", true, {
      paused: true,
      pausedUntil: null,
      owner: null,
    });
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Paused" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("dialog", { name: "Resume Adaptive Charging" })).toBeVisible();
    expect(screen.getByText(/may resume control of battery charging/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume automation" }));
    expect(await screen.findByText(/fresh plan has been queued/i)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/adaptive-charging/resume", expect.objectContaining({ method: "POST" })));
  });

  it.each([
    [
      "Running",
      {
        paused: false,
        available: true,
        batteryModel: { ...adaptiveCharging.batteryModel, status: "active" },
      },
    ],
    [
      "Degraded",
      {
        paused: false,
        available: false,
        reason: "Forecast service unavailable",
        batteryModel: { ...adaptiveCharging.batteryModel, status: "active" },
      },
    ],
  ])("reports the %s automation master state", async (label, adaptiveOverride) => {
    mockApi("succeeded", true, adaptiveOverride);
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: label })).toBeVisible();
  });

  it("extends an active Away period and provides a fast Back home action", async () => {
    const active: AwayPeriod = {
      id: "away-active",
      from: new Date(Date.now() - 60_000).toISOString(),
      until: new Date(Date.now() + 3_600_000).toISOString(),
      status: "active",
      source: "manual",
    };
    const fetchMock = mockApi(
      "succeeded",
      true,
      {},
      {
        periods: [active],
        active,
        next: null,
        state: "away",
        returnBufferMinutes: 30,
      },
    );
    render(
      <MemoryRouter initialEntries={["/automation"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Away now", { selector: "strong" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Extend" }));
    fireEvent.change(screen.getByLabelText("Away until"), {
      target: { value: localDateTimeForTest(new Date(Date.now() + 7_200_000)) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save extension" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/away-periods/away-active/extend", expect.objectContaining({ method: "POST" })));
    fireEvent.click(screen.getByRole("button", { name: "Back home" }));
    expect(await screen.findByText(/Home state restored/)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/away-periods/away-active/back-home", expect.objectContaining({ method: "POST" })));
  });

  it("keeps physical battery changes behind review and reports verified completion", async () => {
    const fetchMock = mockApi();
    render(
      <MemoryRouter initialEntries={["/battery"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Battery" })).toBeVisible();
    expect(
      await screen.findByRole("img", {
        name: /battery power and state of charge/,
      }),
    ).toBeVisible();
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/device-commands", expect.objectContaining({ method: "POST" })));
    fireEvent.click(screen.getByRole("button", { name: "Close receipt" }));
    fireEvent.click(screen.getByRole("link", { name: "Schedules" }));
    expect(await screen.findByRole("heading", { name: "Battery schedules" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Seven-day plan" })).toBeVisible();
    expect(screen.getAllByText("Overnight Eco").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Conflicts with another enabled schedule/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Review schedule/ }));
    expect(screen.getByText(/^Review:/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/schedules", expect.objectContaining({ method: "POST" })));
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
        <AppProviders>
          <App />
        </AppProviders>
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
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Battery" });
    fireEvent.change(screen.getByLabelText("Minimum reserve"), {
      target: { value: "30" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/saved and verified on the battery/i)).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/device-commands",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("discharge-limit"),
        }),
      ),
    );
  });

  it("makes schedule suspension explicit while Adaptive Charging is enabled", async () => {
    mockApi("succeeded", true);
    render(
      <MemoryRouter initialEntries={["/battery/schedules"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Schedules are disabled while Adaptive Charging is on/)).toBeVisible();
    expect(screen.getAllByText("Paused by Adaptive Charging")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Review schedule/ })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Disable" })[0]).toBeDisabled();
    expect(screen.getByText("0 planned changes")).toBeVisible();
  });
});
