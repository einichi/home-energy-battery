import * as v from "valibot";

const nullableString = v.nullable(v.string());
const nullableNumber = v.nullable(v.number());
const optionalNullableString = v.optional(nullableString);
const optionalNullableNumber = v.optional(nullableNumber);
const numberMap = v.record(v.string(), v.nullable(v.number()));

export const MetricSchema = v.object({
  value: v.optional(v.nullable(v.number())),
  human: optionalNullableString,
  error: optionalNullableString,
  acquired_at: optionalNullableString,
});

const EnergySourcesSchema = v.object({
  peakGridKwh: optionalNullableNumber,
  peakGridPercent: optionalNullableNumber,
  offPeakGridKwh: optionalNullableNumber,
  offPeakGridPercent: optionalNullableNumber,
  solarUsedKwh: optionalNullableNumber,
  solarUsedPercent: optionalNullableNumber,
  fuelCellContributionKwh: optionalNullableNumber,
  fuelCellContributionPercent: optionalNullableNumber,
  totalKwh: optionalNullableNumber,
});

const BatteryStatusSchema = v.object({
  configured: v.optional(v.boolean()),
  instant_power: v.optional(MetricSchema),
  remaining_percent: v.optional(MetricSchema),
  working_status: v.optional(v.object({ value: v.optional(nullableString), human: optionalNullableString, error: optionalNullableString, acquired_at: optionalNullableString })),
  operation_mode: v.optional(v.object({ value: v.optional(nullableString), human: optionalNullableString, error: optionalNullableString, acquired_at: optionalNullableString })),
  vendor_profile: v.optional(v.object({ value: v.optional(nullableString), human: optionalNullableString, error: optionalNullableString, acquired_at: optionalNullableString })),
  error: optionalNullableString,
});

const FuelCellStatusSchema = v.object({
  instant_power: v.optional(MetricSchema),
  generation_status: v.optional(v.object({ value: v.optional(nullableString), human: optionalNullableString, error: optionalNullableString, acquired_at: optionalNullableString })),
  hot_water_level: v.optional(MetricSchema),
  source_role: v.optional(v.string()),
  error: optionalNullableString,
});

const SavingsSummarySchema = v.object({
  start: optionalNullableString,
  end: optionalNullableString,
  solarSavingYen: optionalNullableNumber,
  co2SavingKg: optionalNullableNumber,
  guardTriggerCount: optionalNullableNumber,
  gridImportKwh: optionalNullableNumber,
  gridExportKwh: optionalNullableNumber,
  totalOffPeakSavingYen: optionalNullableNumber,
  gridOffPeakSavingYen: optionalNullableNumber,
  batteryOffPeakSavingYen: optionalNullableNumber,
  sampleCount: optionalNullableNumber,
  energySources: v.optional(EnergySourcesSchema),
});

const SystemAlertSchema = v.object({
  id: v.string(),
  source: optionalNullableString,
  severity: v.union([v.literal("info"), v.literal("warning"), v.literal("critical")]),
  title: v.string(),
  startedAt: v.string(),
  impact: v.string(),
  suggestedAction: v.string(),
  href: optionalNullableString,
  resolution: v.literal("active"),
});

const BatteryWindowSchema = v.object({
  start_hour: optionalNullableNumber,
  end_hour: optionalNullableNumber,
  human: optionalNullableString,
});

const BatteryStrategySchema = v.object({
  kind: v.union([
    v.literal("backup-preparation"), v.literal("demand-guard"), v.literal("adaptive-charging"),
    v.literal("away"), v.literal("manual"), v.literal("schedule"), v.literal("device-auto"),
  ]),
  title: v.string(),
  description: v.string(),
  manualOverride: v.optional(v.object({
    active: v.boolean(), label: v.optional(v.string()), until: optionalNullableString, untilChanged: v.optional(v.boolean()),
  })),
  nextSchedule: v.optional(v.nullable(v.object({ id: v.string(), name: v.string(), action: v.string(), at: v.string() }))),
  nextAction: v.optional(v.nullable(v.object({
    action: v.optional(v.union([v.literal("charge"), v.literal("continue-charging")])),
    title: v.string(), reason: v.string(), at: optionalNullableString, endAt: optionalNullableString,
    targetSocPercent: optionalNullableNumber, confidence: optionalNullableString, href: v.string(),
  }))),
});

const RuntimeInformationSchema = v.object({
  uiDevelopment: v.boolean(),
  simulatedDevices: v.boolean(),
  externalIoDisabled: v.boolean(),
  architecture: v.optional(v.object({
    architectureVersion: nullableNumber,
    state: v.string(),
    migratedAt: v.optional(v.string()),
    sourceDocuments: v.optional(v.array(v.string())),
    backupDirectory: optionalNullableString,
    validation: v.optional(v.object({
      state: v.string(), database: v.string(),
      history: v.optional(v.object({ count: v.number(), earliest: nullableString, latest: nullableString })),
      events: v.optional(v.object({ count: v.number(), earliest: nullableString, latest: nullableString })),
      itemCounts: v.optional(v.record(v.string(), v.number())),
      secretsBackedUp: v.optional(v.boolean()),
    })),
  })),
});

const NotificationConfigSchema = v.object({
  enabled: v.boolean(),
  channels: v.array(v.object({
    id: v.string(), type: v.literal("smtp"), enabled: v.boolean(),
    settings: v.object({
      host: v.optional(v.string()), port: v.optional(v.number()), security: v.optional(v.string()),
      username: v.optional(v.string()), from: v.optional(v.string()), recipients: v.optional(v.array(v.string())),
    }),
  })),
  triggers: v.record(v.string(), v.object({ enabled: v.boolean(), cooldownMinutes: v.number(), thresholdPercent: v.optional(v.number()) })),
});

export const AppConfigSchema = v.object({
  port: v.optional(v.number()),
  updateIntervalSeconds: v.number(),
  language: v.union([v.literal("en"), v.literal("ja")]),
  solarEnabled: v.boolean(), smartCosmoEnabled: v.boolean(), fuelCellEnabled: v.boolean(),
  rateMode: v.optional(v.union([v.literal("simple"), v.literal("offPeak"), v.literal("multi")])),
  runtime: v.optional(RuntimeInformationSchema),
  batteryHost: v.optional(v.string()), meterHost: v.optional(v.string()), meterEoj: v.optional(v.string()),
  solarHost: v.optional(v.string()), fuelCellPrimaryHost: v.optional(v.string()),
  fuelCellProxyHosts: v.optional(v.array(v.string())), discoverySubnets: v.optional(v.array(v.string())),
  circuitLabels: v.optional(v.record(v.string(), v.string())),
  circuitDashboardVisibility: v.optional(v.record(v.string(), v.boolean())),
  circuitSortMode: v.optional(v.union([v.literal("number"), v.literal("current"), v.literal("accumulated")])),
  standardRateYenPerKwh: v.optional(v.number()), offPeakRateYenPerKwh: v.optional(v.number()),
  offPeakSavingsEnabled: v.optional(v.boolean()), co2TonnesPerKwh: v.optional(v.number()),
  rateBands: v.optional(v.array(v.object({ start: v.string(), end: v.string(), yenPerKwh: v.number(), label: v.optional(v.string()) }))),
  fuelCell: v.optional(v.object({
    includeInAdaptiveCharging: v.optional(v.boolean()), gasCo2KgPerM3: v.optional(v.number()),
    tariff: v.optional(v.object({
      provider: v.optional(v.string()), region: v.optional(v.string()), plan: v.optional(v.string()),
      equipmentDiscount: v.optional(v.string()), meterReadingDay: v.optional(v.number()),
      automaticUpdates: v.optional(v.boolean()), marginalRateOverrideYenPerM3: optionalNullableNumber,
    })),
  })),
  retention: v.optional(v.object({
    rawTelemetryDays: optionalNullableNumber, intervalAggregatesDays: optionalNullableNumber,
    dailyAggregatesDays: optionalNullableNumber, adaptiveChargingHistoryDays: optionalNullableNumber,
    automationEventDays: optionalNullableNumber, commandReceiptDays: optionalNullableNumber,
    notificationDeliveryDays: optionalNullableNumber, automaticMaintenance: v.optional(v.boolean()),
  })),
  dashboardWidgets: v.optional(v.array(v.object({ id: v.string(), group: v.optional(v.string()), visible: v.boolean(), priority: v.optional(v.number()) }))),
  notifications: v.optional(NotificationConfigSchema),
  batteryCapabilities: v.optional(v.object({
    usableCapacityKwh: optionalNullableNumber, maximumChargeWatts: optionalNullableNumber, roundTripEfficiency: optionalNullableNumber,
  })),
  adaptiveCharging: v.optional(v.object({
    enabled: v.optional(v.boolean()), latitude: optionalNullableNumber, longitude: optionalNullableNumber,
    arrayPeakKw: optionalNullableNumber, panelTiltDegrees: optionalNullableNumber, panelAzimuthDegrees: optionalNullableNumber,
    systemLossPercent: optionalNullableNumber, targetSocPercent: optionalNullableNumber, forecastMarginPercent: optionalNullableNumber,
  })),
});

export const StatusSnapshotSchema = v.object({
  read_at: v.optional(v.string()),
  live_power: v.optional(v.object({
    started_at: optionalNullableString, completed_at: optionalNullableString, duration_ms: optionalNullableNumber,
    errors: v.optional(v.array(v.object({ error: optionalNullableString }))), error: optionalNullableString,
  })),
  statusRefreshPaused: v.optional(v.boolean()), statusRefreshPausedReason: optionalNullableString,
  alerts: v.optional(v.array(SystemAlertSchema)),
  hosts: v.optional(v.object({ battery: optionalNullableString })),
  energy: v.optional(v.object({
    battery: v.optional(BatteryStatusSchema),
    solar: v.optional(v.object({ configured: v.optional(v.boolean()), instant_power: v.optional(MetricSchema), error: optionalNullableString })),
    fuel_cells: v.optional(v.array(FuelCellStatusSchema)), error: optionalNullableString,
    errors: v.optional(v.array(v.object({ error: optionalNullableString }))),
  })),
  meter: v.optional(v.object({
    configured: v.optional(v.boolean()), branch_demand_power: v.optional(MetricSchema), home_load_power: v.optional(MetricSchema),
    home_load_source: v.optional(v.union([v.literal("derived"), v.literal("branch_fallback"), v.literal("unavailable"), v.literal("inconsistent")])),
    home_load_missing: v.optional(v.array(v.string())), grid_import_power: v.optional(MetricSchema), grid_export_power: v.optional(MetricSchema),
    channel_power: v.optional(v.object({ decoded: v.optional(v.object({ channels: v.optional(v.array(v.object({ channel: v.number(), value: optionalNullableNumber }))) })) })),
    error: optionalNullableString, errors: v.optional(v.array(v.object({ error: optionalNullableString }))),
  })),
  settings: v.optional(v.object({
    mode: v.optional(v.object({ decoded: v.optional(v.object({ mode: optionalNullableString })), mode: optionalNullableString, error: optionalNullableString })),
    discharge_limit: v.optional(v.object({ decoded: v.optional(v.object({ percent: optionalNullableNumber })), available: v.optional(v.boolean()), error: optionalNullableString })),
    osaifu_charge_window: v.optional(v.object({ decoded: v.optional(v.nullable(BatteryWindowSchema)), available: v.optional(v.boolean()), error: optionalNullableString })),
    osaifu_discharge_window: v.optional(v.object({ decoded: v.optional(v.nullable(BatteryWindowSchema)), available: v.optional(v.boolean()), error: optionalNullableString })),
  })),
  batteryStrategy: v.optional(BatteryStrategySchema),
  savings: v.optional(SavingsSummarySchema),
  savingsPeriods: v.optional(v.object({ today: v.optional(SavingsSummarySchema), lastMonth: v.optional(SavingsSummarySchema), month: v.optional(SavingsSummarySchema), year: v.optional(SavingsSummarySchema) })),
});

const DataQualitySchema = v.object({ quality: optionalNullableString, coverageSeconds: optionalNullableNumber, coveragePercent: optionalNullableNumber });
const CircuitSummarySchema = v.object({ channel: v.number(), id: v.optional(v.string()), label: v.optional(v.string()), totalKwh: optionalNullableNumber, latestWatts: optionalNullableNumber });
const HistorySummarySchema = v.object({
  sampleCount: v.optional(v.number()), start: optionalNullableString, end: optionalNullableString,
  solarGenerationKwh: optionalNullableNumber, fuelCellKwh: optionalNullableNumber, branchDemandKwh: optionalNullableNumber,
  gridImportKwh: optionalNullableNumber, gridExportKwh: optionalNullableNumber, batteryChargedKwh: optionalNullableNumber,
  batteryDischargedKwh: optionalNullableNumber, batteryNetKwh: optionalNullableNumber, averageStateOfChargePercent: optionalNullableNumber,
  solarSavingYen: optionalNullableNumber, offPeakSavingYen: optionalNullableNumber, totalOffPeakSavingYen: optionalNullableNumber,
  gridOffPeakSavingYen: optionalNullableNumber, batteryOffPeakSavingYen: optionalNullableNumber, co2SavingKg: optionalNullableNumber,
  guardTriggerCount: optionalNullableNumber, circuits: v.optional(v.array(CircuitSummarySchema)), circuitTotalKwh: optionalNullableNumber,
  dataQuality: v.optional(v.record(v.string(), DataQualitySchema)), energySources: v.optional(EnergySourcesSchema), solarCoveragePercent: optionalNullableNumber,
});

const EnergySampleSchema = v.object({
  timestamp: v.string(), batteryPowerW: optionalNullableNumber, stateOfChargePercent: optionalNullableNumber,
  solarPowerW: optionalNullableNumber, branchDemandW: optionalNullableNumber, fuelCellPowerW: optionalNullableNumber,
  fuelCellHotWaterLevel: optionalNullableNumber, gridImportW: optionalNullableNumber, gridExportW: optionalNullableNumber,
  circuitPowerW: v.optional(numberMap), circuitEnergyKwh: v.optional(numberMap), circuitCumulativeKwh: v.optional(numberMap),
  energyQuality: v.optional(v.record(v.string(), v.nullable(v.string()))),
});

export const HistoryResponseSchema = v.object({ samples: v.array(EnergySampleSchema), summary: HistorySummarySchema });

export type AppConfig = v.InferOutput<typeof AppConfigSchema>;
export type StatusSnapshot = v.InferOutput<typeof StatusSnapshotSchema>;
export type HistoryResponse = v.InferOutput<typeof HistoryResponseSchema>;
