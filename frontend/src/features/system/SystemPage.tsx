import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import type {
  AppConfig,
  DatabaseBackupsView,
  DiscoveryJob,
  DiscoveryView,
  NotificationView,
  StatusSnapshot,
} from "../../api/contracts";
import { updateConfig } from "../../api/queries";
import {
  createDatabaseBackup,
  deleteDatabaseBackup,
  getDiscoveryJob,
  importGasTariff,
  restoreDatabaseBackup,
  saveNotifications,
  startDiscovery,
  testNotifications,
  trimHistory,
} from "../../api/system";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useSystemAdmin } from "../../hooks/useSystemAdmin";
import { formatDateTime, formatDateTimesInText } from "../../core/format";
import { useTranslation } from "react-i18next";
const sections = [
  {
    id: "equipment",
    label: "Equipment",
    description: "Installed devices and addresses",
  },
  {
    id: "rates",
    label: "Rates & emissions",
    description: "Electricity and Ene-Farm assumptions",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Email delivery and event triggers",
  },
  {
    id: "data",
    label: "Data & backups",
    description: "Retention, storage, and recovery",
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Refresh and dashboard visibility",
  },
] as const;
type SectionId = (typeof sections)[number]["id"];
type Result = {
  ok: boolean;
  message: string;
} | null;
type SaveSettings = (
  patch: Partial<AppConfig>,
  message: string,
) => Promise<Result>;
function entries(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function optionalNumber(value: FormDataEntryValue | null) {
  return String(value ?? "") === "" ? null : Number(value);
}
function positiveNumberOr(value: FormDataEntryValue | null, fallback: number | null | undefined) {
  const number = Number(value);
  // Keep the current value (including an explicit null = unlimited) on blank input.
  return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
}
function bytes(value?: number) {
  if (!Number.isFinite(value)) return "Unavailable";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value!;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function duration(days?: number) {
  return Number.isFinite(days) ? `${days!.toFixed(1)} days` : "Unavailable";
}
function ResultMessage({ result }: { result: Result }) {
  const { t } = useTranslation("system");
  return result ? (
    <p
      className={`inline-save-result ${result.ok ? "success" : "failure"}`}
      role={result.ok ? "status" : "alert"}
    >
      {formatDateTimesInText(t(result.message))}
    </p>
  ) : null;
}
function EquipmentSettings({
  config,
  status,
  save,
}: {
  config: AppConfig;
  status: StatusSnapshot | null;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [discovery, setDiscovery] = useState<DiscoveryView | null>(null);
  const [discoveryJob, setDiscoveryJob] = useState<DiscoveryJob | null>(null);
  const [discoveryMode, setDiscoveryMode] = useState<
    "broadcast" | "active" | null
  >(null);
  const [equipmentResult, setEquipmentResult] = useState<Result>(null);
  const [circuitResult, setCircuitResult] = useState<Result>(null);
  const discoveryRun = useRef(0);
  useEffect(() => () => { discoveryRun.current += 1; }, []);
  const circuitIds = [
    ...new Set([
      ...Object.keys(config.circuitLabels ?? {}),
      ...Object.keys(config.circuitDashboardVisibility ?? {}),
      ...(status?.meter?.channel_power?.decoded?.channels ?? []).map((item) =>
        String(item.channel),
      ),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setEquipmentResult(
      await save(
        {
          batteryHost: String(data.get("batteryHost") ?? "").trim(),
          meterHost: String(data.get("meterHost") ?? "").trim(),
          solarHost: String(data.get("solarHost") ?? "").trim(),
          fuelCellPrimaryHost: String(data.get("fuelCellPrimaryHost") ?? "").trim(),
          fuelCellProxyHosts: entries(data.get("fuelCellProxyHosts")),
          discoverySubnets: entries(data.get("discoverySubnets")),
          solarEnabled: data.has("solarEnabled"),
          smartCosmoEnabled: data.has("smartCosmoEnabled"),
          fuelCellEnabled: data.has("fuelCellEnabled"),
        },
        "Equipment settings saved.",
      ),
    );
  };
  const discover = async (mode: "broadcast" | "active") => {
    const runId = ++discoveryRun.current;
    setDiscovery(null);
    setDiscoveryMode(mode);
    try {
      let job = await startDiscovery(mode);
      setDiscoveryJob(job);
      while ((job.status === "queued" || job.status === "running") && discoveryRun.current === runId) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (discoveryRun.current !== runId) return;
        job = await getDiscoveryJob(job.id);
        setDiscoveryJob(job);
      }
      if (job.status === "complete") setDiscovery(job.result ?? null);
    } catch (error) {
      setDiscoveryJob({
        id: "failed",
        status: "failed",
        error: error instanceof Error ? error.message : "Discovery failed",
      });
    }
  };
  const submitCircuits = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const labels = Object.fromEntries(
      circuitIds
        .map((id) => [id, String(data.get(`label:${id}`) ?? "").trim()])
        .filter(([, value]) => value),
    );
    const visibility = Object.fromEntries(
      circuitIds.map((id) => [id, data.has(`visible:${id}`)]),
    );
    const sort = data.get("sort");
    const circuitSortMode = sort === "current" || sort === "accumulated" ? sort : "number";
    setCircuitResult(
      await save(
        {
          circuitLabels: labels,
          circuitDashboardVisibility: visibility,
          circuitSortMode,
        },
        "Circuit settings saved.",
      ),
    );
  };
  const discovering =
    discoveryJob?.status === "queued" || discoveryJob?.status === "running";
  const discoveryPercent = discoveryJob?.total
    ? Math.min(
        100,
        Math.round(((discoveryJob.scanned ?? 0) / discoveryJob.total) * 100),
      )
    : undefined;
  const devices = [
    { id: "battery", name: "Battery", address: config.batteryHost, eoj: null, enabled: true, error: status?.energy?.battery?.error },
    { id: "meter", name: "Smart Cosmo", address: config.meterHost, eoj: config.meterEoj, enabled: config.smartCosmoEnabled !== false, error: status?.meter?.error },
    { id: "solar", name: "Solar", address: config.solarHost, eoj: null, enabled: config.solarEnabled !== false, error: status?.energy?.solar?.error },
    { id: "fuel-cell", name: "Ene-Farm", address: config.fuelCellPrimaryHost, eoj: null, enabled: config.fuelCellEnabled !== false, error: status?.energy?.fuel_cells?.find((item) => item.source_role === "primary")?.error },
  ].filter((device) => device.enabled);
  const suggestedChanges = Object.entries(discovery?.suggestedConfig ?? {}).filter(([key, value]) => JSON.stringify(config[key as keyof AppConfig]) !== JSON.stringify(value));
  const applyDiscoverySuggestions = async () => {
    if (!discovery?.suggestedConfig || !suggestedChanges.length) return;
    setEquipmentResult(await save(discovery.suggestedConfig, "Discovered equipment suggestions applied."));
  };
  return (
    <div className="system-stack">
      <section className="equipment-card-grid" aria-label="Configured equipment">
        {devices.map((device) => <article className="panel equipment-card" key={device.id} data-health={device.error ? "attention" : "healthy"}>
          <div><span className="health-dot" aria-hidden="true" /><strong>{device.name}</strong></div>
          <dl>
            <div><dt>{t("address")}</dt><dd>{device.address || t("notConfigured")}</dd></div>
            <div><dt>EOJ</dt><dd>{device.eoj || t("reportedDuringDiscovery")}</dd></div>
            <div><dt>{t("lastSeen")}</dt><dd>{device.error ? t("unavailable") : status?.read_at ? formatDateTime(status.read_at) : t("waitingForStatus")}</dd></div>
            <div><dt>{t("health")}</dt><dd>{device.error ? formatDateTimesInText(device.error) : t("reportingNormally")}</dd></div>
          </dl>
          {device.id === "fuel-cell" && config.fuelCellProxyHosts?.length ? <p className="field-help">{"" + t("fallbackProxies") + " "}{config.fuelCellProxyHosts.join(", ")}</p> : null}
          <details><summary>{t("inspect")}</summary><p>{device.error ? formatDateTimesInText(device.error) : t("noDeviceSpecificErrorsArePresentInTheLatestReading")}</p></details>
        </article>)}
      </section>
      <form
        className="panel system-form"
        key={JSON.stringify({
          batteryHost: config.batteryHost,
          meterHost: config.meterHost,
          meterEoj: config.meterEoj,
          solarHost: config.solarHost,
          fuelCellPrimaryHost: config.fuelCellPrimaryHost,
          fuelCellProxyHosts: config.fuelCellProxyHosts,
          solarEnabled: config.solarEnabled,
          smartCosmoEnabled: config.smartCosmoEnabled,
          fuelCellEnabled: config.fuelCellEnabled,
          discoverySubnets: config.discoverySubnets,
        })}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("installedEquipment")}
            </h2>
            <p>{t("enableInstalledEquipmentAndConfirmItsAddress")}</p>
          </div>
        </div>
        <div className="system-toggle-grid">
          <label>
            <input
              name="solarEnabled"
              type="checkbox"
              defaultChecked={config.solarEnabled !== false}
            />{" "}
            {" " + t("solarGeneration") + ""}
          </label>
          <label>
            <input
              name="smartCosmoEnabled"
              type="checkbox"
              defaultChecked={config.smartCosmoEnabled !== false}
            />{" "}
            {" " + t("smartCosmoMeter") + ""}
          </label>
          <label>
            <input
              name="fuelCellEnabled"
              type="checkbox"
              defaultChecked={config.fuelCellEnabled !== false}
            />{" "}
            {" " + t("eneFarm") + ""}
          </label>
        </div>
        <div className="automation-form-grid">
          <label className="field">
            {t("batteryAddress")}
            <input
              name="batteryHost"
              defaultValue={config.batteryHost}
            />
          </label>
          <label className="field">
            {t("smartCosmoAddress")}
            <input
              name="meterHost"
              defaultValue={config.meterHost}
            />
          </label>
          <label className="field">
            {t("solarAddress")}
            <input
              name="solarHost"
              defaultValue={config.solarHost}
            />
          </label>
          <label className="field">
            {t("eneFarmPrimaryAddress")}
            <input
              name="fuelCellPrimaryHost"
              defaultValue={config.fuelCellPrimaryHost}
            />
          </label>
          <label className="field">
            {t("eneFarmFallbackProxies")}
            <input
              name="fuelCellProxyHosts"
              defaultValue={config.fuelCellProxyHosts?.join(", ")}
            />
          </label>
          <label className="field">
            {t("discoverySubnets")}
            <input
              name="discoverySubnets"
              defaultValue={config.discoverySubnets?.join(", ")}
              placeholder="192.168.1.0/24"
            />
          </label>
        </div>
        <div className="form-footer">
          <button className="button primary">
            {t("saveEquipment")}
          </button>
          <ResultMessage result={equipmentResult} />
        </div>
      </form>
      <form
        className="panel system-form"
        key={`circuits:${JSON.stringify(config.circuitLabels)}:${circuitIds.join()}`}
        onSubmit={submitCircuits}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("smartCosmoCircuits")}
            </h2>
            <p>
              {t("nameShowAndOrderDetectedCircuits")}
            </p>
          </div>
        </div>
        <label className="field">
          {t("circuitOrdering")}
          <select name="sort" defaultValue={config.circuitSortMode ?? "number"}>
            <option value="number">
              {t("circuitNumber")}
            </option>
            <option value="current">
              {t("currentDemand")}
            </option>
            <option value="accumulated">
              {t("accumulatedEnergy")}
            </option>
          </select>
        </label>
        {circuitIds.length ? (
          <div className="circuit-admin-grid">
            {circuitIds.map((id) => (
              <div key={id}>
                <strong>
                  {"" + t("circuit") + " "}
                  {id}
                </strong>
                <input
                  aria-label={`Circuit ${id} label`}
                  name={`label:${id}`}
                  maxLength={80}
                  defaultValue={config.circuitLabels?.[id] ?? ""}
                  placeholder={`Circuit ${id}`}
                />
                <label>
                  <input
                    name={`visible:${id}`}
                    type="checkbox"
                    defaultChecked={
                      config.circuitDashboardVisibility?.[id] !== false
                    }
                  />{" "}
                  {" " + t("showByDefault") + ""}
                </label>
              </div>
            ))}
          </div>
        ) : (
          <p className="automation-empty">
            {t("circuitChannelsWillAppearAfterSmartCosmoReportsThem")}
          </p>
        )}
        <div className="form-footer">
          <button className="button primary" disabled={!circuitIds.length}>
            {t("saveCircuits")}
          </button>
          <ResultMessage result={circuitResult} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("deviceDiscovery")}
            </h2>
            <p>
              {t("searchTheLocalNetworkAndReviewResultsBeforeApplyingAnyAdec2fdc")}
            </p>
          </div>
        </div>
        <div className="button-row">
          <button
            className="quiet-button"
            disabled={discovering}
            onClick={() => void discover("broadcast")}
          >
            {t(discovering && discoveryMode === "broadcast"
                  ? "Discovery in progress…"
                  : "Broadcast discovery")}
          </button>
          <button
            className="quiet-button"
            disabled={discovering}
            onClick={() => void discover("active")}
          >
            {t(discovering && discoveryMode === "active"
                  ? "Scanning subnet…"
                  : "Active subnet scan")}
          </button>
        </div>
        {discoveryJob ? (
          <div
            className="discovery-progress"
            role={discoveryJob.status === "failed" ? "alert" : "status"}
          >
            <div>
              <strong>
                {discoveryJob.status === "complete"
                  ? "Discovery complete"
                  : discoveryJob.status === "failed"
                    ? "Discovery failed"
                    : discoveryJob.phase || "Searching for devices…"}
              </strong>
              <span>
                {discoveryJob.error ??
                  (discoveryJob.total
                    ? `${discoveryJob.scanned ?? 0} of ${discoveryJob.total} addresses · ${discoveryJob.found ?? 0} found`
                    : "Listening for equipment responses…")}
              </span>
              {discovering ? <small>{t("liveEquipmentPollingIsPausedWhileDiscoveryUsesTheLocalDe7bd542")}</small> : null}
            </div>
            {discovering ? (
              <progress max="100" value={discoveryPercent} />
            ) : null}
          </div>
        ) : null}
        {discovery ? (
          <div className="discovery-results">
            <strong>
              {discovery.discovered?.length ?? 0} {" " + t("devicesFound") + ""}
            </strong>
            {discovery.discovered?.map((item) => (
              <article key={item.host}><div><strong>{item.host}</strong><span>{item.roles?.join(", ") || "Unknown role"}</span></div><small>{item.instances?.length ?? 0} {" " + t("objectInstancesReported") + ""}</small></article>
            ))}
            {suggestedChanges.length ? <div className="discovery-suggestions"><strong>{t("suggestedConfigurationChanges")}</strong><dl>{suggestedChanges.map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>)}</dl><button className="button primary" type="button" onClick={() => void applyDiscoverySuggestions()}>{t("applyReviewedSuggestions")}</button></div> : <p className="field-help">{t("noSavedEquipmentAddressesNeedToChange")}</p>}
          </div>
        ) : null}
      </section>
    </div>
  );
}
function RateSettings({
  config,
  save,
}: {
  config: AppConfig;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [mode, setMode] = useState(config.rateMode ?? "simple");
  const [bands, setBands] = useState(config.rateBands ?? []);
  const [rateResult, setRateResult] = useState<Result>(null);
  const [fuelResult, setFuelResult] = useState<Result>(null);
  const [tariffResult, setTariffResult] = useState<Result>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const standard = Number(data.get("standardRate"));
    const offPeak = Number(data.get("offPeakRate"));
    setRateResult(
      await save(
        {
          rateMode: mode,
          standardRateYenPerKwh: standard,
          offPeakRateYenPerKwh: offPeak,
          offPeakSavingsEnabled: mode !== "simple",
          co2TonnesPerKwh: Number(data.get("co2")),
          rateBands:
            mode === "multi"
              ? bands
              : [
                  {
                    start: mode === "offPeak" ? "07:00" : "00:00",
                    end: mode === "offPeak" ? "23:00" : "00:00",
                    yenPerKwh: standard,
                    label: "Standard",
                  },
                  ...(mode === "offPeak"
                    ? [
                        {
                          start: "23:00",
                          end: "07:00",
                          yenPerKwh: offPeak,
                          label: "Off-peak",
                        },
                      ]
                    : []),
                ],
        },
        "Rate and emissions settings saved.",
      ),
    );
  };
  const fuel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setFuelResult(
      await save(
        {
          fuelCell: {
            includeInAdaptiveCharging: data.has("include"),
            gasCo2KgPerM3: Number(data.get("gasCo2")),
            tariff: {
              provider: "tokyo-gas",
              region: String(data.get("region")),
              plan: "enefarm",
              equipmentDiscount: String(data.get("discount")),
              meterReadingDay: Number(data.get("readingDay")),
              automaticUpdates: data.has("automatic"),
              marginalRateOverrideYenPerM3: optionalNumber(
                data.get("marginal"),
              ),
            },
          },
        },
        "Ene-Farm tariff assumptions saved.",
      ),
    );
  };
  const updateBand = (
    index: number,
    field: "start" | "end" | "label" | "yenPerKwh",
    value: string,
  ) =>
    setBands((current) =>
      current.map((band, bandIndex) =>
        bandIndex === index
          ? { ...band, [field]: field === "yenPerKwh" ? Number(value) : value }
          : band,
      ),
    );
  const tariffImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const month = String(new FormData(event.currentTarget).get("month"));
    if (config.runtime?.externalIoDisabled) {
      setTariffResult({
        ok: false,
        message:
          "Published tariff import is disabled in simulator development.",
      });
      return;
    }
    try {
      const imported = await importGasTariff(month);
      setTariffResult({
        ok: true,
        message: `${imported.billingMonth} tariff imported.`,
      });
    } catch (error) {
      setTariffResult({
        ok: false,
        message: error instanceof Error ? error.message : "Import failed",
      });
    }
  };
  return (
    <div className="system-stack">
      <form className="panel system-form" onSubmit={submit}>
        <div className="section-heading">
          <div>
            <h2>
              {t("electricityRates")}
            </h2>
            <p>
              {t("ratesDriveEstimatedSavingsAndAdaptiveChargingWindowSelec1cfa1e")}
            </p>
          </div>
        </div>
        <fieldset>
          <legend>
            {t("rateMode")}
          </legend>
          <div className="system-toggle-grid">
            {(["simple", "offPeak", "multi"] as const).map((item) => (
              <label key={item}>
                <input
                  name="rateMode"
                  type="radio"
                  value={item}
                  checked={mode === item}
                  onChange={() => setMode(item)}
                />{" "}
                {item === "offPeak"
                  ? "Off-peak"
                  : item === "multi"
                    ? "Multi-rate"
                    : "Simple"}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="automation-form-grid">
          <label className="field">
            {t("standardRate")}
            <div className="input-suffix">
              <input
                name="standardRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.standardRateYenPerKwh}
              />
              <span>
                {t("kwh")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("discountedRate")}
            <div className="input-suffix">
              <input
                name="offPeakRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.offPeakRateYenPerKwh}
              />
              <span>
                {t("kwh")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("gridEmissionsFactor")}
            <div className="input-suffix">
              <input
                name="co2"
                type="number"
                min="0"
                step=".000001"
                defaultValue={config.co2TonnesPerKwh}
              />
              <span>
                {t("tKWh")}
              </span>
            </div>
          </label>
        </div>
        {mode === "multi" ? (
          <fieldset>
            <legend>
              {t("rateBands")}
            </legend>
            <div className="rate-band-editor">
              {bands.map((band, index) => (
                <div key={index}>
                  <input
                    aria-label={`Band ${index + 1} label`}
                    value={band.label ?? ""}
                    onChange={(event) =>
                      updateBand(index, "label", event.target.value)
                    }
                    placeholder="Label"
                  />
                  <input
                    aria-label={`Band ${index + 1} start`}
                    type="time"
                    value={band.start}
                    onChange={(event) =>
                      updateBand(index, "start", event.target.value)
                    }
                  />
                  <input
                    aria-label={`Band ${index + 1} end`}
                    type="time"
                    value={band.end}
                    onChange={(event) =>
                      updateBand(index, "end", event.target.value)
                    }
                  />
                  <input
                    aria-label={`Band ${index + 1} rate`}
                    type="number"
                    min="0"
                    step=".01"
                    value={band.yenPerKwh}
                    onChange={(event) =>
                      updateBand(index, "yenPerKwh", event.target.value)
                    }
                  />
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() =>
                      setBands((current) =>
                        current.filter((_, bandIndex) => bandIndex !== index),
                      )
                    }
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
            <button
              className="quiet-button"
              type="button"
              onClick={() =>
                setBands((current) => [
                  ...current,
                  {
                    start: "23:00",
                    end: "07:00",
                    yenPerKwh: config.offPeakRateYenPerKwh ?? 25,
                    label: "Custom",
                  },
                ])
              }
            >
              {t("addRateBand")}
            </button>
          </fieldset>
        ) : null}
        <div className="form-footer">
          <button className="button primary">
            {t("saveRates")}
          </button>
          <ResultMessage result={rateResult} />
        </div>
      </form>
      <form
        className="panel system-form"
        key={`fuel:${JSON.stringify(config.fuelCell)}`}
        onSubmit={fuel}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("eneFarmAssumptions")}
            </h2>
            <p>
              {t("usedForGasCostAndCarbonEstimatesTheApplicationNeverContr5d9b66")}
            </p>
          </div>
        </div>
        <label className="automation-toggle compact">
          <input
            name="include"
            type="checkbox"
            defaultChecked={config.fuelCell?.includeInAdaptiveCharging}
          />
          <span>
            <strong>
              {t("includeObservedEneFarmGenerationInPlanning")}
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            {t("gasRegion")}
            <select
              name="region"
              defaultValue={config.fuelCell?.tariff?.region ?? "tokyo"}
            >
              <option value="tokyo">
                {t("tokyoDistrict")}
              </option>
              <option value="gunma">
                {t("gunmaDistrict")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("meterReadingDay")}
            <input
              name="readingDay"
              type="number"
              min="1"
              max="31"
              defaultValue={config.fuelCell?.tariff?.meterReadingDay ?? 1}
            />
          </label>
          <label className="field">
            {t("equipmentDiscount")}
            <select
              name="discount"
              defaultValue={config.fuelCell?.tariff?.equipmentDiscount ?? ""}
            >
              <option value="">
                {t("none")}
              </option>
              <option value="bath">
                {t("bathHeating")}
              </option>
              <option value="floor">
                {t("floorHeating")}
              </option>
              <option value="set">
                {t("combinedBathFloor")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("gasEmissions")}
            <div className="input-suffix">
              <input
                name="gasCo2"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.fuelCell?.gasCo2KgPerM3 ?? 2.21}
              />
              <span>
                {t("kgM")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("marginalRateOverride")}
            <input
              name="marginal"
              type="number"
              min="0"
              step=".01"
              defaultValue={
                config.fuelCell?.tariff?.marginalRateOverrideYenPerM3 ?? ""
              }
            />
          </label>
        </div>
        <label className="automation-toggle compact">
          <input
            name="automatic"
            type="checkbox"
            defaultChecked={config.fuelCell?.tariff?.automaticUpdates}
          />
          <span>
            <strong>
              {t("automaticallyImportMonthlyTariffs")}
            </strong>
            <small>
              {t("requiresExternalAccessOutsideSimulatorDevelopment")}
            </small>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            {t("saveEneFarmAssumptions")}
          </button>
          <ResultMessage result={fuelResult} />
        </div>
      </form>
      <form className="panel system-form" onSubmit={tariffImport}>
        <div className="section-heading">
          <div>
            <h2>
              {t("publishedGasTariff")}
            </h2>
            <p>
              {t("importTheSelectedBillingMonthFromTheConfiguredProvider")}
            </p>
          </div>
        </div>
        <label className="field">
          {t("billingMonth")}
          <input
            name="month"
            type="month"
            required
            defaultValue={new Date().toISOString().slice(0, 7)}
          />
        </label>
        <div className="form-footer">
          <button
            className="quiet-button"
            disabled={config.runtime?.externalIoDisabled}
          >
            {t("importPublishedTariff")}
          </button>
          <ResultMessage result={tariffResult} />
        </div>
      </form>
    </div>
  );
}
function NotificationSettings({
  initial,
  setView,
  simulator,
}: {
  initial: NotificationView;
  setView: (value: NotificationView) => void;
  simulator: boolean;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const { config: appConfig, replaceConfig } = useEnergyStatus();
  const channel = initial.config.channels[0];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const config = {
        ...initial.config,
        enabled: data.has("enabled"),
        channels: [
          {
            ...channel,
            settings: {
              ...channel.settings,
              host: String(data.get("host")),
              port: Number(data.get("port")),
              security: String(data.get("security")),
              username: String(data.get("username")),
              from: String(data.get("from")),
              recipients: entries(data.get("recipients")),
            },
          },
        ],
        triggers: Object.fromEntries(
          Object.entries(initial.config.triggers).map(([key, trigger]) => [
            key,
            {
              ...trigger,
              enabled: data.has(`trigger:${key}`),
              cooldownMinutes: Number(data.get(`cooldown:${key}`)),
              ...(key === "lowBattery"
                ? { thresholdPercent: Number(data.get(`threshold:${key}`)) }
                : {}),
            },
          ]),
        ),
      };
      const view = await saveNotifications({
        config,
        password: String(data.get("password") || "") || undefined,
        clearPassword: data.has("clearPassword"),
      });
      setView(view);
      // Keep the shared config in sync so a later full-config save does not
      // overwrite the notification settings we just persisted.
      if (appConfig) replaceConfig({ ...appConfig, notifications: view.config });
      const warning = (view as unknown as { warning?: unknown }).warning;
      setResult({ ok: true, message: typeof warning === "string" ? `Notification settings saved. ${warning}` : "Notification settings saved." });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Save failed",
      });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await testNotifications();
      setResult({ ok: true, message: "Test email sent." });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Test failed",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="system-stack">
      <form
        className="panel system-form"
        key={JSON.stringify(initial.config)}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("emailNotifications")}
            </h2>
            <p>
              {simulator
                ? "Delivery tests are disabled by the simulator safety boundary."
                : "Send important equipment and automation events by email."}
            </p>
          </div>
          <span className="sample-count">
            {"" + t("password") + " "}
            {initial.passwordConfigured ? "stored" : "not stored"}
          </span>
        </div>
        <label className="automation-toggle">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={initial.config.enabled}
          />
          <span>
            <strong>
              {t("enableNotifications")}
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            {t("smtpServer")}
            <input name="host" defaultValue={channel?.settings.host} />
          </label>
          <label className="field">
            {t("port")}
            <select name="port" defaultValue={channel?.settings.port ?? 587}>
              <option value="25">25 — SMTP / STARTTLS</option>
              <option value="465">465 — Implicit TLS</option>
              <option value="587">587 — Submission / STARTTLS</option>
            </select>
            <small>Use 465 with TLS; 25 and 587 normally use STARTTLS.</small>
          </label>
          <label className="field">
            {t("security")}
            <select
              name="security"
              defaultValue={channel?.settings.security ?? "starttls"}
            >
              <option value="starttls">
                {t("starttls")}
              </option>
              <option value="tls">
                {t("tls")}
              </option>
              <option value="none">
                {t("none")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("username")}
            <input
              name="username"
              autoComplete="username"
              defaultValue={channel?.settings.username}
            />
          </label>
          <label className="field">
            {t("password")}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep saved password"
            />
          </label>
          <label className="field">
            {t("fromAddress")}
            <input
              name="from"
              type="email"
              defaultValue={channel?.settings.from}
            />
          </label>
          <label className="field span-two">
            {t("recipients")}
            <input
              name="recipients"
              defaultValue={channel?.settings.recipients?.join(", ")}
            />
          </label>
        </div>
        {initial.passwordConfigured ? (
          <label className="automation-toggle compact">
            <input name="clearPassword" type="checkbox" />
            <span>
              <strong>
                {t("removeSavedSMTPPassword")}
              </strong>
            </span>
          </label>
        ) : null}
        <fieldset>
          <legend>
            {t("eventTriggers")}
          </legend>
          <p className="field-help">{t("cooldownMin")}</p>
          <div className="trigger-grid">
            {Object.entries(initial.config.triggers).map(([key, trigger]) => (
              <div className="trigger-row" key={key}>
                <label>
                  <input
                    name={`trigger:${key}`}
                    type="checkbox"
                    defaultChecked={trigger.enabled}
                  />
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                </label>
                <label>
                  <input
                    aria-label={`${key} cooldown`}
                    name={`cooldown:${key}`}
                    type="number"
                    min="0"
                    max="10080"
                    defaultValue={trigger.cooldownMinutes}
                  />
                </label>
                {key === "lowBattery" ? (
                  <label>
                    <span>
                      {t("threshold")}
                    </span>
                    <div className="input-suffix">
                      <input
                        aria-label="Low battery threshold"
                        name={`threshold:${key}`}
                        type="number"
                        min="1"
                        max="95"
                        defaultValue={trigger.thresholdPercent ?? 20}
                      />
                      <span>%</span>
                    </div>
                  </label>
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>
        <div className="form-footer">
          <button className="button primary" disabled={busy}>
            {t("saveNotifications")}
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={busy || simulator}
            onClick={() => void test()}
          >
            {t("sendTestEmail")}
          </button>
          <ResultMessage result={result} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("recentDeliveries")}
            </h2>
            <p>
              {t("deliveryOutcomeEventDestinationChannelAndFailureDetail")}
            </p>
          </div>
          {initial.deliveries?.length ? <span className="sample-count">{initial.deliveries.length} {" " + t("records") + ""}</span> : null}
        </div>
        <div className="notification-deliveries">
          {initial.deliveries?.length ? (
            initial.deliveries.map((delivery, index) => (
              <article key={`${delivery.at}:${index}`} data-ok={delivery.ok}>
                <time>
                  {delivery.at
                    ? formatDateTime(delivery.at)
                    : "Unknown time"}
                </time>
                <strong>
                  {delivery.ok ? "Delivered" : "Failed"} ·{" "}
                  {delivery.event?.title ??
                    delivery.event?.type ??
                    "Notification"}
                </strong>
                <span>
                  {delivery.attempts
                    ?.map(
                      (attempt) => formatDateTimesInText(attempt.error) || attempt.channelId || "SMTP",
                    )
                    .join(" · ") || "No attempt detail"}
                </span>
              </article>
            ))
          ) : (
            <p>
              {t("noNotificationDeliveriesAreRecorded")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
function DataSettings({
  config,
  admin,
  save,
}: {
  config: AppConfig;
  admin: ReturnType<typeof useSystemAdmin>;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const [retentionResult, setRetentionResult] = useState<Result>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    detail: string;
    action: () => Promise<void>;
  } | null>(null);
  const retention = config.retention ?? {};
  const operation = admin.backups?.operation;
  const act = async (
    action: () => Promise<DatabaseBackupsView>,
    message: string,
  ) => {
    admin.setBackups((current) => ({
      backups: current?.backups ?? [],
      schemaVersion: current?.schemaVersion,
      operation: { busy: true, phase: "preparing", percent: 0, error: null },
    }));
    try {
      admin.setBackups(await action());
      admin.refresh();
      setResult({ ok: true, message });
    } catch (error) {
      admin.refresh();
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Operation failed",
      });
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = {
      rawTelemetryDays: positiveNumberOr(data.get("raw"), retention.rawTelemetryDays),
      intervalAggregatesDays: optionalNumber(data.get("interval")),
      dailyAggregatesDays: optionalNumber(data.get("daily")),
      adaptiveChargingHistoryDays: optionalNumber(data.get("adaptive")),
      automationEventDays: optionalNumber(data.get("automation")),
      commandReceiptDays: optionalNumber(data.get("commands")),
      notificationDeliveryDays: positiveNumberOr(data.get("notifications"), retention.notificationDeliveryDays),
      automaticMaintenance: data.has("automatic"),
    };
    const intent = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "data-intent",
    );
    if (intent === "trim") {
      setConfirm({
        title: "Run retention maintenance now?",
        detail:
          "Records older than the values shown in this form will be removed. Existing backups are not affected.",
        action: async () => {
          try {
            const response = (await trimHistory(next)) as unknown as {
              deleted?: Record<string, number>;
            };
            const deleted = Object.values(response.deleted ?? {}).reduce(
              (sum, value) => sum + Number(value || 0),
              0,
            );
            admin.refresh();
            setRetentionResult({
              ok: true,
              message: `Retention maintenance completed. ${deleted} records removed.`,
            });
          } catch (error) {
            setRetentionResult({
              ok: false,
              message:
                error instanceof Error ? error.message : "Maintenance failed",
            });
          }
        },
      });
    } else
      setRetentionResult(
        await save({ retention: next }, "Retention policy saved."),
      );
  };
  return (
    <div className="system-stack">
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("storageHealth")}
            </h2>
          </div>
          <button className="quiet-button" onClick={admin.refresh}>
            {t("refresh")}
          </button>
        </div>
        <dl className="system-stat-grid">
          <div>
            <dt>
              {t("databaseSize")}
            </dt>
            <dd>{bytes(admin.stats?.sizeBytes)}</dd>
          </div>
          <div>
            <dt>
              {t("recordedHistory")}
            </dt>
            <dd>{duration(admin.stats?.daysRecorded)}</dd>
          </div>
          <div>
            <dt>
              {t("rawSamples")}
            </dt>
            <dd>
              {admin.stats?.sampleCount?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("30MinuteAggregates")}
            </dt>
            <dd>
              {admin.stats?.rollups?.interval?.toLocaleString() ??
                "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("dailyAggregates")}
            </dt>
            <dd>
              {admin.stats?.rollups?.daily?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("schema")}
            </dt>
            <dd>
              {admin.stats?.schemaVersion
                ? `v${admin.stats.schemaVersion}`
                : "Unavailable"}
            </dd>
          </div>
        </dl>
      </section>
      <form
        className="panel system-form"
        key={JSON.stringify(retention)}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("retention")}
            </h2>
            <p>
              {t("blankAggregateFieldsMeanKeepIndefinitely")}
            </p>
          </div>
        </div>
        <div className="automation-form-grid">
          <label className="field">
            {t("rawTelemetryDays")}
            <input
              name="raw"
              type="number"
              min="1"
              defaultValue={retention.rawTelemetryDays ?? ""}
            />
          </label>
          <label className="field">
            {t("30MinuteAggregateDays")}
            <input
              name="interval"
              type="number"
              min="1"
              defaultValue={retention.intervalAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            {t("dailyAggregateDays")}
            <input
              name="daily"
              type="number"
              min="1"
              defaultValue={retention.dailyAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            {t("adaptiveHistoryDays")}
            <input
              name="adaptive"
              type="number"
              min="1"
              defaultValue={retention.adaptiveChargingHistoryDays ?? ""}
            />
          </label>
          <label className="field">
            {t("automationEventDays")}
            <input
              name="automation"
              type="number"
              min="1"
              defaultValue={retention.automationEventDays ?? ""}
            />
          </label>
          <label className="field">
            {t("commandReceiptDays")}
            <input
              name="commands"
              type="number"
              min="1"
              defaultValue={retention.commandReceiptDays ?? ""}
            />
          </label>
          <label className="field">
            {t("notificationDeliveryDays")}
            <input
              name="notifications"
              type="number"
              min="1"
              defaultValue={retention.notificationDeliveryDays ?? ""}
            />
          </label>
        </div>
        <label className="automation-toggle compact">
          <input
            name="automatic"
            type="checkbox"
            defaultChecked={retention.automaticMaintenance !== false}
          />
          <span>
            <strong>
              {t("runMaintenanceAutomatically")}
            </strong>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            {t("saveRetention")}
          </button>
          <button className="quiet-button" data-intent="trim">
            {t("runMaintenanceNow")}
          </button>
          <ResultMessage result={retentionResult} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("databaseBackups")}
            </h2>
            <p>
              {t("createRecoverableSnapshotsBeforeMaterialConfigurationOrSe1c55b")}
            </p>
          </div>
          <button
            className="button primary"
            disabled={operation?.busy}
            onClick={() =>
              void act(
                createDatabaseBackup,
                "Backup created and inventory refreshed.",
              )
            }
          >
            {t("createBackup")}
          </button>
        </div>
        {operation?.busy || operation?.phase === "failed" ? (
          <div
            className="database-operation"
            role={operation.phase === "failed" ? "alert" : "status"}
          >
            <div>
              <strong>{operation.phase ?? "Working"}</strong>
              <span>
                {operation.error ??
                  `${Math.round(operation.percent ?? 0)}% complete`}
              </span>
            </div>
            <progress max="100" value={operation.percent ?? 0} />
          </div>
        ) : null}
        <div className="backup-list">
          {admin.backups?.backups.length ? (
            admin.backups.backups.map((backup) => (
              <article key={backup.filename}>
                <div>
                  <strong>{backup.filename}</strong>
                  <small>
                    {bytes(backup.sizeBytes)} {" " + t("schemaV") + ""}
                    {backup.schemaVersion ?? "?"} ·{" "}
                    {backup.compatible
                      ? "compatible"
                      : "not restorable by this version"}
                  </small>
                </div>
                <div className="button-row">
                  <button
                    className="quiet-button"
                    disabled={operation?.busy || !backup.compatible}
                    onClick={() =>
                      setConfirm({
                        title: "Restore this database backup?",
                        detail:
                          "The application will pause background work, create a safety backup, replace the active database, validate it, restart local services, and refresh this inventory.",
                        action: () =>
                          act(
                            () => restoreDatabaseBackup(backup.filename),
                            "Backup restored and database state refreshed.",
                          ),
                      })
                    }
                  >
                    {t("restore")}
                  </button>
                  <button
                    className="danger-button"
                    disabled={operation?.busy}
                    onClick={() =>
                      setConfirm({
                        title: "Delete this backup?",
                        detail:
                          "This removes only the selected backup file and cannot be undone.",
                        action: () =>
                          act(
                            () => deleteDatabaseBackup(backup.filename),
                            "Backup deleted and inventory refreshed.",
                          ),
                      })
                    }
                  >
                    {t("delete")}
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p>
              {t("noDatabaseBackupsAreAvailable")}
            </p>
          )}
        </div>
        <ResultMessage result={result} />
      </section>
      {confirm ? (
        <div className="modal-backdrop">
          <section
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-confirm-title"
          >
            <h2 id="data-confirm-title">{confirm.title}</h2>
            <p>{confirm.detail}</p>
            <div className="button-row">
              <button className="quiet-button" onClick={() => setConfirm(null)}>
                {t("cancel")}
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const action = confirm.action;
                  setConfirm(null);
                  void action();
                }}
              >
                {t("continue")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
const widgetLabels: Record<string, string> = {
  solarPower: "Solar power",
  fuelCellPower: "Ene-Farm power",
  branchDemandPower: "Circuits total",
  batteryPower: "Battery power",
  batterySoc: "Battery state of charge",
  gridImportPower: "Grid import",
  gridExportPower: "Grid export",
  adaptiveCharging: "Adaptive charging",
  backupPreparation: "Disaster prep",
  awayStatus: "Away status",
  batteryWorking: "Battery working state",
  operationMode: "Battery operation mode",
  vendorProfile: "Battery profile",
  dischargeLimit: "Battery reserve",
  fuelCellStatus: "Ene-Farm status",
  fuelCellStateTimeline: "Ene-Farm activity",
  fuelCellHotWater: "Ene-Farm hot water",
  solarSavings: "Solar savings",
  co2Savings: "Avoided CO₂",
  offPeakSavings: "Off-peak savings",
  powerImported: "Imported energy",
  powerExported: "Exported energy",
  guardTriggerCount: "Demand Guard triggers",
  energySources: "Energy sources",
};
function Preferences({
  config,
  save,
}: {
  config: AppConfig;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setResult(
      await save(
        {
          updateIntervalSeconds: Number(data.get("interval")),
          language: String(data.get("language")) as "en" | "ja",
          dashboardWidgets: config.dashboardWidgets?.map((widget) => ({
            ...widget,
            visible: data.has(`widget:${widget.id}`),
          })),
        },
        "Preferences saved.",
      ),
    );
  };
  return (
    <form
      className="panel system-form"
      key={JSON.stringify(config.dashboardWidgets)}
      onSubmit={submit}
    >
      <div className="section-heading">
        <div>
          <h2>
            {t("applicationPreferences")}
          </h2>
          <p>
            {t("languageAndRegionalNumberAndDateFormattingApplyAfterSavi6572af")}
          </p>
        </div>
      </div>
      <div className="automation-form-grid">
        <label className="field">
          {t("language")}
          <select name="language" defaultValue={config.language}>
            <option value="en">
              {t("english")}
            </option>
            <option value="ja">
              {t("message")}
            </option>
          </select>
        </label>
        <label className="field">
          {t("refreshInterval")}
          <div className="input-suffix">
            <input
              name="interval"
              type="number"
              min="5"
              max="3600"
              defaultValue={config.updateIntervalSeconds}
            />
            <span>
              {t("sec")}
            </span>
          </div>
        </label>
      </div>
      <fieldset>
        <legend>
          {t("overviewVisibility")}
        </legend>
        <p className="field-help">
          {t("chooseWhichOptionalItemsAppearOnOverview")}
        </p>
        <div className="widget-visibility-grid">
          {config.dashboardWidgets?.map((widget) => (
            <label key={widget.id}>
              <input
                name={`widget:${widget.id}`}
                type="checkbox"
                defaultChecked={widget.visible}
              />
              <span>
                {t(
                  widgetLabels[widget.id] ??
                    widget.id.replace(/([A-Z])/g, " $1"),
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-footer">
        <button className="button primary">
          {t("savePreferences")}
        </button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
export function SystemPage() {
  const { t } = useTranslation("system");
  const { section } = useParams();
  const selected = sections.some((item) => item.id === section)
    ? (section as SectionId)
    : null;
  const { config, status, replaceConfig } = useEnergyStatus();
  const admin = useSystemAdmin();
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  if (!selected) return <Navigate to="/system/equipment" replace />;
  const save: SaveSettings = async (patch, message) => {
    if (!config)
      return { ok: false, message: "Configuration is not available." };
    // Prevent overlapping full-config saves from clobbering each other.
    if (savingRef.current) return { ok: false, message: "A save is already in progress." };
    savingRef.current = true;
    setBusy(true);
    try {
      const next = await updateConfig({ ...config, ...patch });
      replaceConfig({ ...next, runtime: next.runtime ?? config.runtime });
      return { ok: true, message };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Save failed",
      };
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="page system-page" aria-busy={busy}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            {t("administer")}
          </p>
          <h1>
            {t("system")}
          </h1>
        </div>
      </header>
      {admin.error ? (
        <div className="status-banner" data-severity="critical">
          {"" + t("systemData") + " "}
          {formatDateTimesInText(admin.error)}
        </div>
      ) : null}
      <nav className="system-navigation" aria-label={t("systemSections")}>
        {sections.map((item) => (
          <NavLink key={item.id} to={`/system/${item.id}`}>
            <strong>{t(item.label)}</strong>
            <span>{t(item.description)}</span>
          </NavLink>
        ))}
      </nav>
      {!config ? (
        <div className="panel automation-empty">
          {t("loadingSystemConfiguration")}
        </div>
      ) : selected === "equipment" ? (
        <EquipmentSettings config={config} status={status} save={save} />
      ) : selected === "rates" ? (
        <RateSettings config={config} save={save} />
      ) : selected === "notifications" && admin.notifications ? (
        <NotificationSettings
          initial={admin.notifications}
          setView={(view) => admin.setNotifications(view)}
          simulator={config.runtime?.externalIoDisabled === true}
        />
      ) : selected === "data" ? (
        <DataSettings config={config} admin={admin} save={save} />
      ) : selected === "preferences" ? (
        <Preferences config={config} save={save} />
      ) : (
        <div className="panel automation-empty">
          {t("loadingSection")}
        </div>
      )}
    </main>
  );
}
