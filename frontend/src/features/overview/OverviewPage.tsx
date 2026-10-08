import { useMemo } from "react";
import { Link } from "react-router-dom";
import { EnergyFlow } from "../../components/EnergyFlow";
import { EnergyPeriodSections } from "../../components/EnergyPeriodSections";
import { OffPeakSavings } from "../../components/TelemetryParity";
import { formatDateTime, formatDateTimeRange, formatDateTimesInText, formatFreshness, formatPercent, formatPower, formatSoc, formatTime, metricValue } from "../../core/format";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useSnapshotStale } from "../../hooks/useSnapshotStale";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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

function nextActionTitle(nextAction: NonNullable<NonNullable<ReturnType<typeof useEnergyStatus>["status"]>["batteryStrategy"]>["nextAction"], t: TFunction<"overview">) {
  if (nextAction?.action === "charge" && nextAction.at && nextAction.endAt) {
    return t("chargeValue", { value: formatDateTimeRange(nextAction.at, nextAction.endAt) });
  }
  if (nextAction?.action === "continue-charging" && nextAction.endAt) {
    return t("continueChargingUntilValue", { value: formatDateTime(nextAction.endAt) });
  }
  return t(nextAction?.title ?? "No application action scheduled");
}

export function OverviewPage() {
  const { t } = useTranslation("overview");
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
  const homeLoadMetric = status?.meter?.home_load_power;
  const homeLoadSource = status?.meter?.home_load_source;
  const homeLoadIsDerived = homeLoadSource === "derived";
  const branchDemandPower = metricValue(status?.meter?.branch_demand_power);
  const demandPower = metricValue(homeLoadMetric) ?? branchDemandPower;
  const demandLabel = homeLoadIsDerived ? "Home" : "Circuits total";
  const demandTitle = homeLoadIsDerived
    ? "Home demand — grid + solar + fuel cell − battery"
    : "Circuits total — sum of monitored circuits";
  const gridImport = metricValue(status?.meter?.grid_import_power);
  const gridExport = metricValue(status?.meter?.grid_export_power);
  const reserve = status?.settings?.discharge_limit?.decoded?.percent;
  const nextAction = status?.batteryStrategy?.nextAction;
  const formattedNextActionTitle = nextActionTitle(nextAction, t);
  const readingsStale = useSnapshotStale(status?.read_at, config?.updateIntervalSeconds);
  const widgetVisible = (id: string) => config?.dashboardWidgets?.find((widget) => widget.id === id)?.visible !== false;
  const attentionItems = [
    ...(status?.alerts ?? []).slice(0, 3).map((alert) => ({ id: alert.id, title: alert.title, detail: formatDateTimesInText(alert.impact), href: alert.href ?? "/system/equipment" })),
    ...(status?.batteryStrategy?.manualOverride?.active ? [{ id: "manual-override", title: t("manualBatteryOverrideIsActive"), detail: status.batteryStrategy.manualOverride.label ?? t("automationWillWaitUntilTheOverrideEnds"), href: "/battery" }] : []),
  ];
  const topCircuits = useMemo(
    () =>
      (status?.meter?.channel_power?.decoded?.channels ?? [])
        .map((circuit) => ({
          id: String(circuit.channel),
          label: config?.circuitLabels?.[String(circuit.channel)] ?? t("circuitValue", { value: circuit.channel }),
          watts: metricValue({ value: circuit.value }),
        }))
        .filter((circuit): circuit is typeof circuit & { watts: number } => circuit.watts !== null && circuit.watts > 0 && config?.circuitDashboardVisibility?.[circuit.id] !== false)
        .sort((left, right) => config?.circuitSortMode === "number" ? Number(left.id) - Number(right.id) : right.watts - left.watts)
        .slice(0, 5),
    [config?.circuitDashboardVisibility, config?.circuitLabels, config?.circuitSortMode, status?.meter?.channel_power?.decoded?.channels, t],
  );

  return (
    <main className="page overview-page">
      <header className="page-heading">
        <div>
          <h1>
            {t("homeEnergyOverview")}
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
          {t(manualRefreshing ? "Refreshing…" : "Refresh")}
        </button>
      </header>

      {error ? (
        <div className="status-banner" data-severity="critical">
          {formatDateTimesInText(error)}
        </div>
      ) : null}

      <section className="mobile-operating-summary" aria-label={t("currentOperatingSummary")}>
        <div><span>{t(gridExport != null && gridExport > 0 ? "Grid export" : "Grid import")}</span><strong>{formatPower(gridExport != null && gridExport > 0 ? gridExport : gridImport)}</strong></div>
        <div><span>{t("battery")}</span><strong>{formatSoc(soc)} · {t(batteryStateLabel(batteryPower))}</strong></div>
        <div><span>{t("nextAction")}</span><strong>{formattedNextActionTitle}</strong></div>
      </section>

      <section className="overview-grid" aria-label={t("liveEnergyStatus")}>
        <article className="flow-panel panel">
          <div className="section-heading">
            <div>
              <h2>
                {t("energyFlow")}
              </h2>
            </div>
            <span className="live-state" data-stale={readingsStale || undefined} data-unavailable={!status?.read_at || undefined}>
              <i aria-hidden="true" /> {t(!status?.read_at ? "Unavailable" : readingsStale ? "Stale · last known values" : "Live")}
            </span>
          </div>
          <EnergyFlow solar={solarPower} fuelCell={fuelCellPower} battery={batteryPower} demand={demandPower} demandLabel={demandLabel} demandTitle={demandTitle} gridImport={gridImport} gridExport={gridExport} showSolar={config?.solarEnabled !== false && widgetVisible("solarPower")} showFuelCell={config?.fuelCellEnabled !== false && widgetVisible("fuelCellPower")} showBattery={widgetVisible("batteryPower")} showDemand={widgetVisible("branchDemandPower")} showGrid={widgetVisible(gridExport != null && gridExport > 0 ? "gridExportPower" : "gridImportPower")} />
        </article>

        <article className="battery-panel panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {t("storage")}
              </p>
              <h2>
                {t("battery")}
              </h2>
            </div>
            {widgetVisible("batterySoc") ? <span className="battery-soc">{formatSoc(soc)}</span> : null}
          </div>
          {widgetVisible("batterySoc") ? <div className="soc-track" role="meter" aria-label={t("batteryStateOfCharge")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={soc ?? undefined}>
            <i style={{ width: `${soc ?? 0}%` }} />
          </div> : null}
          <dl className="definition-grid">
            {widgetVisible("batteryPower") ? <div>
              <dt>
                {t("power")}
              </dt>
              <dd>{formatPower(batteryPower)}</dd>
            </div> : null}
            {widgetVisible("batteryWorking") ? <div>
              <dt>
                {t("workingState")}
              </dt>
              <dd>{t(battery?.working_status?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("operationMode") ? <div>
              <dt>
                {t("operationMode")}
              </dt>
              <dd>{t(battery?.operation_mode?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("vendorProfile") ? <div>
              <dt>
                {t("profile")}
              </dt>
              <dd>{t(battery?.vendor_profile?.value ?? "Unavailable")}</dd>
            </div> : null}
            {widgetVisible("dischargeLimit") ? <div>
              <dt>{t("reserve")}</dt>
              <dd>{formatPercent(reserve ?? null)}</dd>
            </div> : null}
            <div>
              <dt>{t("latestContact")}</dt>
              <dd>{status?.read_at ? formatTime(status.read_at) : t("unavailable")}</dd>
            </div>
          </dl>
          <p className="panel-note">
            <strong>{t(status?.batteryStrategy?.title ?? "Current strategy unavailable")}</strong>
            <br />
            {formatDateTimesInText(t(status?.batteryStrategy?.description ?? "Waiting for operational state."))}
          </p>
        </article>
      </section>

      {widgetVisible("adaptiveCharging") || widgetVisible("awayStatus") ? (
        <section className="panel overview-next-action" aria-labelledby="overview-next-action-heading">
          <div>
            <p className="eyebrow">{t("nextAutomationAction")}</p>
            <h2 id="overview-next-action-heading">{nextAction ? formattedNextActionTitle : t("waitingForTheNextAutomationDecision")}</h2>
            <p>{formatDateTimesInText(t(nextAction?.reason ?? "Automation status is not available yet."))}</p>
          </div>
          <div className="overview-next-action-meta">
            {nextAction?.at ? <time dateTime={nextAction.at}>{formatDateTime(nextAction.at)}</time> : null}
            {nextAction?.targetSocPercent != null ? <span>{t("targetValue", { value: formatPercent(nextAction.targetSocPercent) })}</span> : null}
            {nextAction?.confidence ? <span>{t("valueConfidence", { value: nextAction.confidence })}</span> : null}
            <Link className="text-link" to={nextAction?.href ?? "/automation"}>{t("openAutomation")}</Link>
          </div>
        </section>
      ) : null}

      {config?.smartCosmoEnabled !== false ? <section className="panel top-circuits-panel" aria-labelledby="top-circuits-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {t("livePower")}
            </p>
            <h2 id="top-circuits-heading">
              {t("circuitsConsumingMostPower")}
            </h2>
          </div>
          <a className="text-link" href="#today-circuits">
            {t("allCircuits")}
          </a>
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
            {t("noCircuitsAreCurrentlyReportingPowerUse")}
          </p>
        )}
      </section> : null}

      {attentionItems.length ? <section className="panel overview-attention" aria-labelledby="overview-attention-heading">
        <div className="section-heading"><div><p className="eyebrow">{t("attention")}</p><h2 id="overview-attention-heading">{t("needsAttention")}</h2></div></div>
        <ul>{attentionItems.map((item) => <li key={item.id}><div><strong>{t(item.title)}</strong><span>{t(item.detail)}</span></div><Link to={item.href}>{t("review")}</Link></li>)}</ul>
      </section> : null}

      <section className="overview-daily-section" aria-labelledby="today-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {t("dailySummary")}
            </p>
            <h2 id="today-heading">
              {t("todayAtAGlance")}
            </h2>
          </div>
          <Link className="text-link" to="/reports">
            {t("openReports")}
          </Link>
        </div>
        <EnergyPeriodSections
          milliseconds={24 * 60 * 60_000}
          start={todayStart}
          periodLabel={t("today")}
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
