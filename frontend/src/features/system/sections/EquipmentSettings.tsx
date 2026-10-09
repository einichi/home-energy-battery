import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig, DiscoveryJob, DiscoveryView, StatusSnapshot } from "../../../api/contracts";
import { getDiscoveryJob, startDiscovery } from "../../../api/system";
import { formatDateTime, formatDateTimesInText } from "../../../core/format";
import { useTranslation } from "react-i18next";
import type { Result, SaveSettings } from "./types.js";
import { ResultMessage } from "./ResultMessage.js";
import { entries } from "./form-utils.js";

export function EquipmentSettings({
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
            <div><dt>{t("EOJ")}</dt><dd>{device.eoj || t("reportedDuringDiscovery")}</dd></div>
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
