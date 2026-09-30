import { useMemo } from "react";
import { Link } from "react-router-dom";
import { EnergyFlow } from "../../components/EnergyFlow";
import { EnergyPeriodSections } from "../../components/EnergyPeriodSections";
import { OffPeakSavings } from "../../components/TelemetryParity";
import { formatDateTime, formatDateTimeRange, formatDateTimesInText, formatFreshness, formatPercent, formatPower, formatSoc, formatTime, metricValue } from "../../core/format";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useSnapshotStale } from "../../hooks/useSnapshotStale";
import { T, useI18n } from "../../i18n";

function preferredFuelCell(status: ReturnType<typeof useEnergyStatus>["status"]) {
  const fuelCells = status?.energy?.fuel_cells ?? [];
  return fuelCells.find((cell) => cell.source_role === "primary") ?? fuelCells[0];
}

function batteryStateLabel(power: number | null) {
  if (power === null) return "Unavailable";
  if (power > 0) return "Charging";
  if (power < 0) return "Discharging";
  return "Idle";
}

function nextActionTitle(nextAction: NonNullable<NonNullable<ReturnType<typeof useEnergyStatus>["status"]>["batteryStrategy"]>["nextAction"], text: (source?: string, values?: Record<string, string | number | null | undefined>) => string) {
  if (nextAction?.action === "charge" && nextAction.at && nextAction.endAt) {
    return text("Charge {value}", { value: formatDateTimeRange(nextAction.at, nextAction.endAt) });
  }
  if (nextAction?.action === "continue-charging" && nextAction.endAt) {
    return text("Continue charging until {value}", { value: formatDateTime(nextAction.endAt) });
  }
  return text(nextAction?.title ?? "No application action scheduled");
}

export function OverviewPage() {
  const { text } = useI18n();
  const { config, status, loadingState, manualRefreshing, error, refresh: refreshStatus } = useEnergyStatus();
  const todayStart = useMemo(() => {
    const value = new Date();
    value.setHours(0, 0, 0, 0);
    return value.toISOString();
  }, []);
  const battery = status?.energy?.battery;
  const fuelCell = preferredFuelCell(status);
  const soc = metricValue(battery?.remaining_percent);
  const batteryPower = metricValue(battery?.instant_power);
  const solarPower = metricValue(status?.energy?.solar?.instant_power);
  const fuelCellPower = metricValue(fuelCell?.instant_power);
  const demandPower = metricValue(status?.meter?.house_demand_power);
  const gridImport = metricValue(status?.meter?.grid_import_power);
  const gridExport = metricValue(status?.meter?.grid_export_power);
  const reserve = status?.settings?.discharge_limit?.decoded?.percent;
  const nextAction = status?.batteryStrategy?.nextAction;
  const formattedNextActionTitle = nextActionTitle(nextAction, text);
  const readingsStale = useSnapshotStale(status?.read_at, config?.updateIntervalSeconds);
  const widgetVisible = (id: string) => config?.dashboardWidgets?.find((widget) => widget.id === id)?.visible !== false;
  const attentionItems = [
    ...(status?.alerts ?? []).filter((alert) => alert.resolution !== "resolved").slice(0, 3).map((alert) => ({ id: alert.id, title: alert.title, detail: formatDateTimesInText(alert.impact), href: alert.href ?? "/system/equipment" })),
    ...(status?.batteryStrategy?.manualOverride?.active ? [{ id: "manual-override", title: text("Manual battery override is active"), detail: status.batteryStrategy.manualOverride.label ?? text("Automation will wait until the override ends."), href: "/battery" }] : []),
  ];
  const topCircuits = useMemo(
    () =>
      (status?.meter?.channel_power?.decoded?.channels ?? [])
        .map((circuit) => ({
          id: String(circuit.channel),
          label: config?.circuitLabels?.[String(circuit.channel)] ?? text("Circuit {value}", { value: circuit.channel }),
          watts: metricValue({ value: circuit.value }),
        }))
        .filter((circuit): circuit is typeof circuit & { watts: number } => circuit.watts !== null && circuit.watts > 0 && config?.circuitDashboardVisibility?.[circuit.id] !== false)
        .sort((left, right) => config?.circuitSortMode === "number" ? Number(left.id) - Number(right.id) : right.watts - left.watts)
        .slice(0, 5),
    [config?.circuitDashboardVisibility, config?.circuitLabels, config?.circuitSortMode, status?.meter?.channel_power?.decoded?.channels, text],
  );

  return (
    <main className="page overview-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            <T text={"Right now"} />
          </p>
          <h1>
            <T text={"Home energy overview"} />
          </h1>
          <p>{formatFreshness(status?.read_at)}</p>
        </div>
        <button
          className="quiet-button"
          type="button"
          onClick={() => {
            refreshStatus();
          }}
          disabled={loadingState === "loading" || manualRefreshing}
        >
          {text(manualRefreshing ? "Refreshing…" : "Refresh")}
        </button>
      </header>

      {error ? (
        <div className="status-banner" data-severity="critical">
          {formatDateTimesInText(error)}
        </div>
      ) : null}

      <section className="mobile-operating-summary" aria-label={text("Current operating summary")}>
        <div><span>{text(gridExport != null && gridExport > 0 ? "Grid export" : "Grid import")}</span><strong>{formatPower(gridExport != null && gridExport > 0 ? gridExport : gridImport)}</strong></div>
        <div><span><T text={"Battery"} /></span><strong>{formatSoc(soc)} · {text(batteryStateLabel(batteryPower))}</strong></div>
        <div><span><T text={"Next action"} /></span><strong>{formattedNextActionTitle}</strong></div>
      </section>

      <section className="overview-grid" aria-label={text("Live energy status")}>
        <article className="flow-panel panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <T text={"Live power"} />
              </p>
              <h2>
                <T text={"Energy flow"} />
              </h2>
            </div>
            <span className="live-state" data-stale={readingsStale || undefined} data-unavailable={!status?.read_at || undefined}>
              <i aria-hidden="true" /> {text(!status?.read_at ? "Unavailable" : readingsStale ? "Stale · last known values" : "Live")}
            </span>
          </div>
          <EnergyFlow solar={solarPower} fuelCell={fuelCellPower} battery={batteryPower} demand={demandPower} gridImport={gridImport} gridExport={gridExport} showSolar={config?.solarEnabled !== false && widgetVisible("solarPower")} showFuelCell={config?.fuelCellEnabled !== false && widgetVisible("fuelCellPower")} showBattery={widgetVisible("batteryPower")} showDemand={widgetVisible("houseDemandPower")} showGrid={widgetVisible(gridExport != null && gridExport > 0 ? "gridExportPower" : "gridImportPower")} />
          <p className="panel-note">
            <T text={"Direction and magnitude from the latest equipment reading."} />
          </p>
        </article>

        <article className="battery-panel panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <T text={"Storage"} />
              </p>
              <h2>
                <T text={"Battery"} />
              </h2>
            </div>
            {widgetVisible("batterySoc") ? <span className="battery-soc">{formatSoc(soc)}</span> : null}
          </div>
          {widgetVisible("batterySoc") ? <div className="soc-track" role="meter" aria-label={text("Battery state of charge")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={soc ?? undefined}>
            <i style={{ width: `${soc ?? 0}%` }} />
          </div> : null}
          <dl className="definition-grid">
            {widgetVisible("batteryPower") ? <div>
              <dt>
                <T text={"Power"} />
              </dt>
              <dd>{formatPower(batteryPower)}</dd>
            </div> : null}
            {widgetVisible("batteryWorking") ? <div>
              <dt>
                <T text={"Working state"} />
              </dt>
              <dd>{text(battery?.working_status?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("operationMode") ? <div>
              <dt>
                <T text={"Operation mode"} />
              </dt>
              <dd>{text(battery?.operation_mode?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("vendorProfile") ? <div>
              <dt>
                <T text={"Profile"} />
              </dt>
              <dd>{text(battery?.vendor_profile?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("dischargeLimit") ? <div>
              <dt><T text={"Reserve"} /></dt>
              <dd>{formatPercent(reserve ?? null)}</dd>
            </div> : null}
            <div>
              <dt><T text={"Latest contact"} /></dt>
              <dd>{status?.read_at ? formatTime(status.read_at) : text("Unavailable")}</dd>
            </div>
          </dl>
          <p className="panel-note">
            <strong>{text(status?.batteryStrategy?.title ?? "Current strategy unavailable")}</strong>
            <br />
            {formatDateTimesInText(text(status?.batteryStrategy?.description ?? "Waiting for operational state."))}
          </p>
        </article>
      </section>

      {widgetVisible("adaptiveCharging") || widgetVisible("awayStatus") ? (
        <section className="panel overview-next-action" aria-labelledby="overview-next-action-heading">
          <div>
            <p className="eyebrow"><T text={"Next automation action"} /></p>
            <h2 id="overview-next-action-heading">{nextAction ? formattedNextActionTitle : text("Waiting for the next automation decision")}</h2>
            <p>{formatDateTimesInText(text(nextAction?.reason ?? "Automation status is not available yet."))}</p>
          </div>
          <div className="overview-next-action-meta">
            {nextAction?.at ? <time dateTime={nextAction.at}>{formatDateTime(nextAction.at)}</time> : null}
            {nextAction?.targetSocPercent != null ? <span>{text("Target {value}", { value: formatPercent(nextAction.targetSocPercent) })}</span> : null}
            {nextAction?.confidence ? <span>{text("{value} confidence", { value: nextAction.confidence })}</span> : null}
            <Link className="text-link" to={nextAction?.href ?? "/automation"}><T text={"Open automation →"} /></Link>
          </div>
        </section>
      ) : null}

      {config?.smartCosmoEnabled !== false ? <section className="panel top-circuits-panel" aria-labelledby="top-circuits-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              <T text={"Live power"} />
            </p>
            <h2 id="top-circuits-heading">
              <T text={"Circuits consuming most power"} />
            </h2>
          </div>
          <Link className="text-link" to="/#today-circuits">
            <T text={"All circuits →"} />
          </Link>
        </div>
        {topCircuits.length ? (
          <ol>
            {topCircuits.map((circuit) => (
              <li key={circuit.id}>
                <span>{circuit.label}</span>
                <strong>{formatPower(circuit.watts)}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-copy">
            <T text={"No circuits are currently reporting power use."} />
          </p>
        )}
      </section> : null}

      {attentionItems.length ? <section className="panel overview-attention" aria-labelledby="overview-attention-heading">
        <div className="section-heading"><div><p className="eyebrow"><T text={"Attention"} /></p><h2 id="overview-attention-heading"><T text={"Needs attention"} /></h2></div></div>
        <ul>{attentionItems.map((item) => <li key={item.id}><div><strong>{text(item.title)}</strong><span>{text(item.detail)}</span></div><Link to={item.href}><T text={"Review →"} /></Link></li>)}</ul>
      </section> : null}

      <section className="overview-daily-section" aria-labelledby="today-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              <T text={"Daily summary"} />
            </p>
            <h2 id="today-heading">
              <T text={"Today at a glance"} />
            </h2>
          </div>
          <Link className="text-link" to="/reports">
            <T text={"Open reports →"} />
          </Link>
        </div>
        <EnergyPeriodSections
          milliseconds={24 * 60 * 60_000}
          start={todayStart}
          periodLabel={text("Today")}
          sections={["history", "balance", "outcomes", "battery", "ene-farm", "circuits"]}
          current
          refreshKey={status?.read_at}
          visible={widgetVisible}
        />
      </section>

      {widgetVisible("offPeakSavings") ? <div className="overview-savings">
        <OffPeakSavings status={status} todayOnly />
      </div> : null}
    </main>
  );
}
