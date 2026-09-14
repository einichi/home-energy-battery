import { useState } from "react";
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
import { T, useI18n } from "../../i18n";
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
  const { text } = useI18n();
  return result ? (
    <p
      className={`inline-save-result ${result.ok ? "success" : "failure"}`}
      role={result.ok ? "status" : "alert"}
    >
      {text(result.message)}
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
  const [discovery, setDiscovery] = useState<DiscoveryView | null>(null);
  const [discoveryJob, setDiscoveryJob] = useState<DiscoveryJob | null>(null);
  const [discoveryMode, setDiscoveryMode] = useState<
    "broadcast" | "active" | null
  >(null);
  const [equipmentResult, setEquipmentResult] = useState<Result>(null);
  const [circuitResult, setCircuitResult] = useState<Result>(null);
  const circuitIds = [
    ...new Set([
      ...Object.keys(config.circuitLabels ?? {}),
      ...Object.keys(config.circuitDashboardVisibility ?? {}),
      ...(status?.meter?.channel_power?.decoded?.channels ?? []).map((item) =>
        String(item.channel),
      ),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  const configuredOr = (
    data: FormData,
    name: string,
    current: string | undefined,
  ) => String(data.get(name) ?? "").trim() || current || "";
  const configuredListOr = (
    data: FormData,
    name: string,
    current: string[] | undefined,
  ) =>
    entries(data.get(name)).length ? entries(data.get(name)) : (current ?? []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setEquipmentResult(
      await save(
        {
          batteryHost: configuredOr(data, "batteryHost", config.batteryHost),
          meterHost: configuredOr(data, "meterHost", config.meterHost),
          solarHost: configuredOr(data, "solarHost", config.solarHost),
          fuelCellPrimaryHost: configuredOr(
            data,
            "fuelCellPrimaryHost",
            config.fuelCellPrimaryHost,
          ),
          fuelCellProxyHosts: configuredListOr(
            data,
            "fuelCellProxyHosts",
            config.fuelCellProxyHosts,
          ),
          discoverySubnets: configuredListOr(
            data,
            "discoverySubnets",
            config.discoverySubnets,
          ),
          solarEnabled: data.has("solarEnabled"),
          smartCosmoEnabled: data.has("smartCosmoEnabled"),
          fuelCellEnabled: data.has("fuelCellEnabled"),
        },
        "Equipment settings saved.",
      ),
    );
  };
  const discover = async (mode: "broadcast" | "active") => {
    setDiscovery(null);
    setDiscoveryMode(mode);
    try {
      let job = await startDiscovery(mode);
      setDiscoveryJob(job);
      while (job.status === "queued" || job.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 250));
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
    setCircuitResult(
      await save(
        {
          circuitLabels: labels,
          circuitDashboardVisibility: visibility,
          circuitSortMode: String(data.get("sort")),
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
  return (
    <div className="system-stack">
      <form
        className="panel system-form"
        key={JSON.stringify(config)}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              <T text={"Installed equipment"} />
            </h2>
            <p>
              <T
                text={
                  "Enable only equipment present in this home. Current addresses are shown as suggestions; enter a value only to replace one."
                }
              />
            </p>
          </div>
        </div>
        <div className="system-toggle-grid">
          <label>
            <input
              name="solarEnabled"
              type="checkbox"
              defaultChecked={config.solarEnabled !== false}
            />{" "}
            <T text={" Solar generation"} />
          </label>
          <label>
            <input
              name="smartCosmoEnabled"
              type="checkbox"
              defaultChecked={config.smartCosmoEnabled !== false}
            />{" "}
            <T text={" Smart Cosmo meter"} />
          </label>
          <label>
            <input
              name="fuelCellEnabled"
              type="checkbox"
              defaultChecked={config.fuelCellEnabled !== false}
            />{" "}
            <T text={" Ene-Farm"} />
          </label>
        </div>
        <div className="automation-form-grid">
          <label className="field">
            <T text={"Battery address"} />
            <input
              name="batteryHost"
              defaultValue=""
              placeholder={config.batteryHost}
            />
          </label>
          <label className="field">
            <T text={"Smart Cosmo address"} />
            <input
              name="meterHost"
              defaultValue=""
              placeholder={config.meterHost}
            />
          </label>
          <label className="field">
            <T text={"Solar address"} />
            <input
              name="solarHost"
              defaultValue=""
              placeholder={config.solarHost}
            />
          </label>
          <label className="field">
            <T text={"Ene-Farm primary address"} />
            <input
              name="fuelCellPrimaryHost"
              defaultValue=""
              placeholder={config.fuelCellPrimaryHost}
            />
          </label>
          <label className="field">
            <T text={"Ene-Farm fallback proxies"} />
            <input
              name="fuelCellProxyHosts"
              defaultValue=""
              placeholder={config.fuelCellProxyHosts?.join(", ")}
            />
          </label>
          <label className="field">
            <T text={"Discovery subnets"} />
            <input
              name="discoverySubnets"
              defaultValue=""
              placeholder={
                config.discoverySubnets?.join(", ") || "192.168.1.0/24"
              }
            />
          </label>
        </div>
        <div className="form-footer">
          <button className="button primary">
            <T text={"Save equipment"} />
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
              <T text={"Smart Cosmo circuits"} />
            </h2>
            <p>
              <T
                text={
                  "Name detected channels, choose their default visibility, and set their ordering."
                }
              />
            </p>
          </div>
        </div>
        <label className="field">
          <T text={"Circuit ordering"} />
          <select name="sort" defaultValue={config.circuitSortMode ?? "number"}>
            <option value="number">
              <T text={"Circuit number"} />
            </option>
            <option value="current">
              <T text={"Current demand"} />
            </option>
            <option value="accumulated">
              <T text={"Accumulated energy"} />
            </option>
          </select>
        </label>
        {circuitIds.length ? (
          <div className="circuit-admin-grid">
            {circuitIds.map((id) => (
              <div key={id}>
                <strong>
                  <T text={"Circuit "} />
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
                  <T text={" Show by default"} />
                </label>
              </div>
            ))}
          </div>
        ) : (
          <p className="automation-empty">
            <T
              text={
                "Circuit channels will appear after Smart Cosmo reports them."
              }
            />
          </p>
        )}
        <div className="form-footer">
          <button className="button primary" disabled={!circuitIds.length}>
            <T text={"Save circuits"} />
          </button>
          <ResultMessage result={circuitResult} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              <T text={"Device discovery"} />
            </h2>
            <p>
              <T
                text={
                  "Search the local network and review results before applying any address."
                }
              />
            </p>
          </div>
        </div>
        <div className="button-row">
          <button
            className="quiet-button"
            disabled={discovering}
            onClick={() => void discover("broadcast")}
          >
            <T
              text={
                discovering && discoveryMode === "broadcast"
                  ? "Discovery in progress…"
                  : "Broadcast discovery"
              }
            />
          </button>
          <button
            className="quiet-button"
            disabled={discovering}
            onClick={() => void discover("active")}
          >
            <T
              text={
                discovering && discoveryMode === "active"
                  ? "Scanning subnet…"
                  : "Active subnet scan"
              }
            />
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
            </div>
            {discovering ? (
              <progress max="100" value={discoveryPercent} />
            ) : null}
          </div>
        ) : null}
        {discovery ? (
          <div className="discovery-results">
            <strong>
              {discovery.discovered?.length ?? 0} <T text={" devices found"} />
            </strong>
            {discovery.discovered?.map((item) => (
              <p key={item.host}>
                {item.host} · {item.roles?.join(", ") || "Unknown role"}
              </p>
            ))}
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
              <T text={"Electricity rates"} />
            </h2>
            <p>
              <T
                text={
                  "Rates drive estimated savings and Adaptive Charging window selection."
                }
              />
            </p>
          </div>
        </div>
        <fieldset>
          <legend>
            <T text={"Rate mode"} />
          </legend>
          <div className="system-toggle-grid">
            {["simple", "offPeak", "multi"].map((item) => (
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
            <T text={"Standard rate"} />
            <div className="input-suffix">
              <input
                name="standardRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.standardRateYenPerKwh}
              />
              <span>
                <T text={"¥/kWh"} />
              </span>
            </div>
          </label>
          <label className="field">
            <T text={"Discounted rate"} />
            <div className="input-suffix">
              <input
                name="offPeakRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.offPeakRateYenPerKwh}
              />
              <span>
                <T text={"¥/kWh"} />
              </span>
            </div>
          </label>
          <label className="field">
            <T text={"Grid emissions factor"} />
            <div className="input-suffix">
              <input
                name="co2"
                type="number"
                min="0"
                step=".000001"
                defaultValue={config.co2TonnesPerKwh}
              />
              <span>
                <T text={"t/kWh"} />
              </span>
            </div>
          </label>
        </div>
        {mode === "multi" ? (
          <fieldset>
            <legend>
              <T text={"Rate bands"} />
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
                    <T text={"Remove"} />
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
              <T text={"Add rate band"} />
            </button>
          </fieldset>
        ) : null}
        <div className="form-footer">
          <button className="button primary">
            <T text={"Save rates"} />
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
              <T text={"Ene-Farm assumptions"} />
            </h2>
            <p>
              <T
                text={
                  "Used for gas-cost and carbon estimates. The application never controls Ene-Farm."
                }
              />
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
              <T text={"Include observed Ene-Farm generation in planning"} />
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            <T text={"Gas region"} />
            <select
              name="region"
              defaultValue={config.fuelCell?.tariff?.region ?? "tokyo"}
            >
              <option value="tokyo">
                <T text={"Tokyo district"} />
              </option>
              <option value="gunma">
                <T text={"Gunma district"} />
              </option>
            </select>
          </label>
          <label className="field">
            <T text={"Meter reading day"} />
            <input
              name="readingDay"
              type="number"
              min="1"
              max="31"
              defaultValue={config.fuelCell?.tariff?.meterReadingDay ?? 1}
            />
          </label>
          <label className="field">
            <T text={"Equipment discount"} />
            <select
              name="discount"
              defaultValue={config.fuelCell?.tariff?.equipmentDiscount ?? ""}
            >
              <option value="">
                <T text={"None"} />
              </option>
              <option value="bath">
                <T text={"Bath heating"} />
              </option>
              <option value="floor">
                <T text={"Floor heating"} />
              </option>
              <option value="set">
                <T text={"Combined bath/floor"} />
              </option>
            </select>
          </label>
          <label className="field">
            <T text={"Gas emissions"} />
            <div className="input-suffix">
              <input
                name="gasCo2"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.fuelCell?.gasCo2KgPerM3 ?? 2.21}
              />
              <span>
                <T text={"kg/m³"} />
              </span>
            </div>
          </label>
          <label className="field">
            <T text={"Marginal rate override"} />
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
              <T text={"Automatically import monthly tariffs"} />
            </strong>
            <small>
              <T
                text={"Requires external access outside simulator development."}
              />
            </small>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            <T text={"Save Ene-Farm assumptions"} />
          </button>
          <ResultMessage result={fuelResult} />
        </div>
      </form>
      <form className="panel system-form" onSubmit={tariffImport}>
        <div className="section-heading">
          <div>
            <h2>
              <T text={"Published gas tariff"} />
            </h2>
            <p>
              <T
                text={
                  "Import the selected billing month from the configured provider."
                }
              />
            </p>
          </div>
        </div>
        <label className="field">
          <T text={"Billing month"} />
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
            <T text={"Import published tariff"} />
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
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
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
      setResult({ ok: true, message: "Notification settings saved." });
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
              <T text={"Email notifications"} />
            </h2>
            <p>
              {simulator
                ? "Delivery tests are disabled by the simulator safety boundary."
                : "Send important equipment and automation events by email."}
            </p>
          </div>
          <span className="sample-count">
            <T text={"Password "} />
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
              <T text={"Enable notifications"} />
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            <T text={"SMTP server"} />
            <input name="host" defaultValue={channel?.settings.host} />
          </label>
          <label className="field">
            <T text={"Port"} />
            <input
              name="port"
              type="number"
              min="1"
              max="65535"
              defaultValue={channel?.settings.port ?? 587}
            />
          </label>
          <label className="field">
            <T text={"Security"} />
            <select
              name="security"
              defaultValue={channel?.settings.security ?? "starttls"}
            >
              <option value="starttls">
                <T text={"STARTTLS"} />
              </option>
              <option value="tls">
                <T text={"TLS"} />
              </option>
              <option value="none">
                <T text={"None"} />
              </option>
            </select>
          </label>
          <label className="field">
            <T text={"Username"} />
            <input
              name="username"
              autoComplete="username"
              defaultValue={channel?.settings.username}
            />
          </label>
          <label className="field">
            <T text={"Password"} />
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep saved password"
            />
          </label>
          <label className="field">
            <T text={"From address"} />
            <input
              name="from"
              type="email"
              defaultValue={channel?.settings.from}
            />
          </label>
          <label className="field span-two">
            <T text={"Recipients"} />
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
                <T text={"Remove saved SMTP password"} />
              </strong>
            </span>
          </label>
        ) : null}
        <fieldset>
          <legend>
            <T text={"Event triggers"} />
          </legend>
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
                  <span>
                    <T text={"Cooldown"} />
                  </span>
                  <div className="input-suffix">
                    <input
                      aria-label={`${key} cooldown`}
                      name={`cooldown:${key}`}
                      type="number"
                      min="0"
                      max="10080"
                      defaultValue={trigger.cooldownMinutes}
                    />
                    <span>
                      <T text={"min"} />
                    </span>
                  </div>
                </label>
                {key === "lowBattery" ? (
                  <label>
                    <span>
                      <T text={"Threshold"} />
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
            <T text={"Save notifications"} />
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={busy || simulator}
            onClick={() => void test()}
          >
            <T text={"Send test email"} />
          </button>
          <ResultMessage result={result} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              <T text={"Recent deliveries"} />
            </h2>
            <p>
              <T
                text={
                  "Delivery outcome, event, destination channel, and failure detail."
                }
              />
            </p>
          </div>
          <span className="sample-count">
            {initial.deliveries?.length ?? 0} <T text={" records"} />
          </span>
        </div>
        <div className="notification-deliveries">
          {initial.deliveries?.length ? (
            initial.deliveries.map((delivery, index) => (
              <article key={`${delivery.at}:${index}`} data-ok={delivery.ok}>
                <time>
                  {delivery.at
                    ? new Date(delivery.at).toLocaleString()
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
                      (attempt) => attempt.error || attempt.channelId || "SMTP",
                    )
                    .join(" · ") || "No attempt detail"}
                </span>
              </article>
            ))
          ) : (
            <p>
              <T text={"No notification deliveries are recorded."} />
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
      rawTelemetryDays: Number(data.get("raw")),
      intervalAggregatesDays: optionalNumber(data.get("interval")),
      dailyAggregatesDays: optionalNumber(data.get("daily")),
      adaptiveChargingHistoryDays: optionalNumber(data.get("adaptive")),
      automationEventDays: optionalNumber(data.get("automation")),
      commandReceiptDays: optionalNumber(data.get("commands")),
      notificationDeliveryDays: Number(data.get("notifications")),
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
              <T text={"Storage health"} />
            </h2>
            <p>
              <T
                text={"Current local history database and aggregate inventory."}
              />
            </p>
          </div>
          <button className="quiet-button" onClick={admin.refresh}>
            <T text={"Refresh"} />
          </button>
        </div>
        <dl className="system-stat-grid">
          <div>
            <dt>
              <T text={"Database size"} />
            </dt>
            <dd>{bytes(admin.stats?.sizeBytes)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Recorded history"} />
            </dt>
            <dd>{duration(admin.stats?.daysRecorded)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Raw samples"} />
            </dt>
            <dd>
              {admin.stats?.sampleCount?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              <T text={"30-minute aggregates"} />
            </dt>
            <dd>
              {admin.stats?.rollups?.interval?.toLocaleString() ??
                "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              <T text={"Daily aggregates"} />
            </dt>
            <dd>
              {admin.stats?.rollups?.daily?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              <T text={"Schema"} />
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
              <T text={"Retention"} />
            </h2>
            <p>
              <T text={"Blank aggregate fields mean keep indefinitely."} />
            </p>
          </div>
        </div>
        <div className="automation-form-grid">
          <label className="field">
            <T text={"Raw telemetry days"} />
            <input
              name="raw"
              type="number"
              min="1"
              defaultValue={retention.rawTelemetryDays}
            />
          </label>
          <label className="field">
            <T text={"30-minute aggregate days"} />
            <input
              name="interval"
              type="number"
              min="1"
              defaultValue={retention.intervalAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            <T text={"Daily aggregate days"} />
            <input
              name="daily"
              type="number"
              min="1"
              defaultValue={retention.dailyAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            <T text={"Adaptive history days"} />
            <input
              name="adaptive"
              type="number"
              min="1"
              defaultValue={retention.adaptiveChargingHistoryDays ?? ""}
            />
          </label>
          <label className="field">
            <T text={"Automation event days"} />
            <input
              name="automation"
              type="number"
              min="1"
              defaultValue={retention.automationEventDays ?? ""}
            />
          </label>
          <label className="field">
            <T text={"Command receipt days"} />
            <input
              name="commands"
              type="number"
              min="1"
              defaultValue={retention.commandReceiptDays ?? ""}
            />
          </label>
          <label className="field">
            <T text={"Notification delivery days"} />
            <input
              name="notifications"
              type="number"
              min="1"
              defaultValue={retention.notificationDeliveryDays}
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
              <T text={"Run maintenance automatically"} />
            </strong>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            <T text={"Save retention"} />
          </button>
          <button className="quiet-button" data-intent="trim">
            <T text={"Run maintenance now"} />
          </button>
          <ResultMessage result={retentionResult} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              <T text={"Database backups"} />
            </h2>
            <p>
              <T
                text={
                  "Create recoverable snapshots before material configuration or software changes."
                }
              />
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
            <T text={"Create backup"} />
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
                    {bytes(backup.sizeBytes)} <T text={" · schema v"} />
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
                    <T text={"Restore"} />
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
                    <T text={"Delete"} />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p>
              <T text={"No database backups are available."} />
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
                <T text={"Cancel"} />
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const action = confirm.action;
                  setConfirm(null);
                  void action();
                }}
              >
                <T text={"Continue"} />
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
  houseDemandPower: "House demand",
  batteryPower: "Battery power",
  batterySoc: "Battery state of charge",
  gridImportPower: "Grid import",
  gridExportPower: "Grid export",
  adaptiveCharging: "Adaptive charging",
  backupPreparation: "Disaster prep",
  awayStatus: "Away status",
  energySources: "Energy sources",
};
function Preferences({
  config,
  save,
}: {
  config: AppConfig;
  save: SaveSettings;
}) {
  const { text } = useI18n();
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
            <T text={"Application preferences"} />
          </h2>
          <p>
            <T
              text={
                "Language and regional number and date formatting apply after saving. Appearance is available globally in the sidebar."
              }
            />
          </p>
        </div>
      </div>
      <div className="automation-form-grid">
        <label className="field">
          <T text={"Language"} />
          <select name="language" defaultValue={config.language}>
            <option value="en">
              <T text={"English"} />
            </option>
            <option value="ja">
              <T text={"日本語"} />
            </option>
          </select>
        </label>
        <label className="field">
          <T text={"Refresh interval"} />
          <div className="input-suffix">
            <input
              name="interval"
              type="number"
              min="5"
              max="3600"
              defaultValue={config.updateIntervalSeconds}
            />
            <span>
              <T text={"sec"} />
            </span>
          </div>
        </label>
      </div>
      <fieldset>
        <legend>
          <T text={"Overview visibility"} />
        </legend>
        <p className="field-help">
          <T
            text={
              "The mature Overview has a fixed hierarchy. Hide optional widgets without managing numeric priorities."
            }
          />
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
                {text(
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
          <T text={"Save preferences"} />
        </button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
export function SystemPage() {
  const { text } = useI18n();
  const { section } = useParams();
  const selected = sections.some((item) => item.id === section)
    ? (section as SectionId)
    : null;
  const { config, status, replaceConfig } = useEnergyStatus();
  const admin = useSystemAdmin();
  const [busy, setBusy] = useState(false);
  if (!selected) return <Navigate to="/system/equipment" replace />;
  const save: SaveSettings = async (patch, message) => {
    if (!config)
      return { ok: false, message: "Configuration is not available." };
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
      setBusy(false);
    }
  };
  return (
    <main className="page system-page" aria-busy={busy}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            <T text={"Administer"} />
          </p>
          <h1>
            <T text={"System"} />
          </h1>
          <p>
            <T
              text={
                "Configure devices, assumptions, delivery, storage, and application preferences."
              }
            />
          </p>
        </div>
      </header>
      {admin.error ? (
        <div className="status-banner" data-severity="critical">
          <T text={"System data: "} />
          {admin.error}
        </div>
      ) : null}
      <nav className="system-navigation" aria-label={text("System sections")}>
        {sections.map((item) => (
          <NavLink key={item.id} to={`/system/${item.id}`}>
            <strong>{text(item.label)}</strong>
            <span>{text(item.description)}</span>
          </NavLink>
        ))}
      </nav>
      {!config ? (
        <div className="panel automation-empty">
          <T text={"Loading system configuration…"} />
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
          <T text={"Loading section…"} />
        </div>
      )}
    </main>
  );
}
