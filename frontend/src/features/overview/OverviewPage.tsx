import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CombinedEnergyChart } from "../../components/CombinedEnergyChart";
import { EnergyFlow } from "../../components/EnergyFlow";
import { OutcomeStrip } from "../../components/OutcomeStrip";
import { EneFarmActivity, EnergySourcesBar, OffPeakSavings } from "../../components/TelemetryParity";
import { formatFreshness, formatPower, formatSoc, metricValue } from "../../core/format";
import { withLatestStatus } from "../../core/energy";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useHistoryRange } from "../../hooks/useHistoryRange";
import { useEneFarm } from "../../hooks/useEneFarm";

function preferredFuelCell(status: ReturnType<typeof useEnergyStatus>["status"]) {
  const fuelCells = status?.energy?.fuel_cells ?? [];
  return fuelCells.find((cell) => cell.source_role === "primary") ?? fuelCells[0];
}

export function OverviewPage() {
  const { status, loadingState, manualRefreshing, error, refresh: refreshStatus } = useEnergyStatus();
  const { history, loading: historyLoading, refresh: refreshHistory } = useHistoryRange(24 * 60 * 60_000);
  const todayStart = useMemo(() => {
    const value = new Date();
    value.setHours(0, 0, 0, 0);
    return value.toISOString();
  }, []);
  const { history: todayHistory, refresh: refreshToday } = useHistoryRange(24 * 60 * 60_000, undefined, todayStart);
  const { summary: eneFarmToday, loading: eneFarmLoading, refresh: refreshEneFarm } = useEneFarm(24 * 60 * 60_000, todayStart);
  const battery = status?.energy?.battery;
  const fuelCell = preferredFuelCell(status);
  const soc = metricValue(battery?.remaining_percent);
  const batteryPower = metricValue(battery?.instant_power);
  const solarPower = metricValue(status?.energy?.solar?.instant_power);
  const fuelCellPower = metricValue(fuelCell?.instant_power);
  const demandPower = metricValue(status?.meter?.house_demand_power);
  const gridImport = metricValue(status?.meter?.grid_import_power);
  const gridExport = metricValue(status?.meter?.grid_export_power);
  const chartSamples = useMemo(() => withLatestStatus(history.samples, status), [history.samples, status]);

  return (
    <main className="page overview-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Right now</p>
          <h1>Home energy overview</h1>
          <p>{formatFreshness(status?.read_at)}</p>
        </div>
        <button className="quiet-button" type="button" onClick={() => { refreshStatus(); refreshHistory(); refreshToday(); refreshEneFarm(); }} disabled={loadingState === "loading" || manualRefreshing}>
          {manualRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? <div className="status-banner" data-severity="critical">{error}</div> : null}

      <section className="overview-grid" aria-label="Live energy status">
        <article className="flow-panel panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Live power</p>
              <h2>Energy flow</h2>
            </div>
            <span className="live-state"><i aria-hidden="true" /> Live</span>
          </div>
          <EnergyFlow solar={solarPower} fuelCell={fuelCellPower} battery={batteryPower} demand={demandPower} gridImport={gridImport} gridExport={gridExport} />
          <p className="panel-note">Direction and magnitude from the latest equipment reading.</p>
        </article>

        <article className="battery-panel panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Storage</p>
              <h2>Battery</h2>
            </div>
            <span className="battery-soc">{formatSoc(soc)}</span>
          </div>
          <div className="soc-track" role="meter" aria-label="Battery state of charge" aria-valuemin={0} aria-valuemax={100} aria-valuenow={soc ?? undefined}>
            <i style={{ width: `${soc ?? 0}%` }} />
          </div>
          <dl className="definition-grid">
            <div><dt>Power</dt><dd>{formatPower(batteryPower)}</dd></div>
            <div><dt>Working state</dt><dd>{battery?.working_status?.value ?? "Unavailable"}</dd></div>
            <div><dt>Operation mode</dt><dd>{battery?.operation_mode?.value ?? "Unavailable"}</dd></div>
            <div><dt>Profile</dt><dd>{battery?.vendor_profile?.value ?? "Unavailable"}</dd></div>
          </dl>
          <p className="panel-note"><strong>{status?.batteryStrategy?.title ?? "Current strategy unavailable"}</strong><br />{status?.batteryStrategy?.description ?? "Waiting for operational state."}</p>
        </article>
      </section>

      <section className="panel overview-history" aria-labelledby="overview-history-heading">
        <div className="history-toolbar"><div><p className="eyebrow">Last 24 hours</p><h2 id="overview-history-heading">Demand, generation, grid, and battery</h2></div><Link className="text-link" to="/energy">Explore Energy →</Link></div>
        {historyLoading && !chartSamples.length ? <div className="chart-empty">Loading history…</div> : (
          <CombinedEnergyChart samples={chartSamples} selected={["houseDemandW", "solarPowerW", "fuelCellPowerW", "gridImportW", "batteryPowerW"]} label="Last 24 hours of home energy" />
        )}
      </section>

      <div className="telemetry-parity-grid">
        <EnergySourcesBar sources={todayHistory.summary.energySources} />
        <EneFarmActivity summary={eneFarmToday} compact loading={eneFarmLoading} />
        <OffPeakSavings status={status} />
      </div>

      <section className="outcome-section" aria-labelledby="today-heading">
        <div className="section-heading"><div><p className="eyebrow">Today</p><h2 id="today-heading">Energy outcomes</h2></div><Link className="text-link" to="/energy">Full history →</Link></div>
        <OutcomeStrip summary={todayHistory.summary} compact />
      </section>

    </main>
  );
}
