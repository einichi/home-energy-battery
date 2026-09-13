import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { CombinedEnergyChart } from "../../components/CombinedEnergyChart";
import { Metric } from "../../components/Metric";
import { OutcomeStrip } from "../../components/OutcomeStrip";
import { TimeRangeControl } from "../../components/TimeRangeControl";
import { formatEnergy, formatPercent, formatPower, formatSoc, metricValue } from "../../core/format";
import { withLatestStatus } from "../../core/energy";
import { energySeries } from "../../core/energySeries";
import type { EnergySeriesKey } from "../../core/energySeries";
import { timeRangeMilliseconds } from "../../core/timeRange";
import type { TimeRangeId } from "../../core/timeRange";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useHistoryRange } from "../../hooks/useHistoryRange";

const selectableSeries = Object.keys(energySeries) as EnergySeriesKey[];
const defaultSeries: EnergySeriesKey[] = ["houseDemandW", "solarPowerW", "fuelCellPowerW", "gridImportW", "batteryPowerW"];
const metricAliases: Record<string, EnergySeriesKey> = {
  demand: "houseDemandW",
  solar: "solarPowerW",
  "ene-farm": "fuelCellPowerW",
  import: "gridImportW",
  export: "gridExportW",
  battery: "batteryPowerW",
  soc: "stateOfChargePercent",
  "hot-water": "fuelCellHotWaterLevel",
};

function latestFuelCell(status: ReturnType<typeof useEnergyStatus>["status"]) {
  return status?.energy?.fuel_cells?.find((item) => item.source_role === "primary") ?? status?.energy?.fuel_cells?.[0];
}

function dataQualityDescription(dataQuality: ReturnType<typeof useHistoryRange>["history"]["summary"]["dataQuality"]) {
  const entries = Object.entries(dataQuality ?? {});
  if (!entries.length) return "Quality metadata is not available for this period.";
  const qualities = [...new Set(entries.map(([, value]) => value.quality).filter(Boolean))];
  const coverage = entries.map(([, value]) => Number(value.coveragePercent)).filter(Number.isFinite);
  const minimumCoverage = coverage.length ? Math.min(...coverage) : null;
  return `${qualities.length ? qualities.join(" + ") : "Mixed source"}${minimumCoverage === null ? "" : ` · minimum coverage ${formatPercent(minimumCoverage)}`}`;
}

export function EnergyPage() {
  const [searchParams] = useSearchParams();
  const requestedMetric = metricAliases[searchParams.get("metric") ?? ""];
  const [range, setRange] = useState<TimeRangeId>("24h");
  const [selected, setSelected] = useState<EnergySeriesKey[]>(requestedMetric ? [requestedMetric] : defaultSeries);
  const { status, loadingState, manualRefreshing, refresh: refreshStatus } = useEnergyStatus();
  const { history, loading, error, refresh: refreshHistory } = useHistoryRange(
    timeRangeMilliseconds(range),
    range === "live" ? status?.read_at : undefined,
  );
  const battery = status?.energy?.battery;
  const fuelCell = latestFuelCell(status);
  const latestSample = history.samples.at(-1);
  const chartSamples = useMemo(() => withLatestStatus(history.samples, status), [history.samples, status]);
  const circuits = useMemo(() => {
    const summaryByChannel = new Map((history.summary.circuits ?? []).map((item) => [String(item.channel), item]));
    const live = status?.meter?.channel_power?.decoded?.channels ?? [];
    const ids = new Set([
      ...live.map((item) => String(item.channel)),
      ...Object.keys(latestSample?.circuitPowerW ?? {}),
      ...summaryByChannel.keys(),
    ]);
    return [...ids].sort((a, b) => Number(a) - Number(b)).map((id) => {
      const liveValue = live.find((item) => String(item.channel) === id)?.value;
      const summary = summaryByChannel.get(id);
      return {
        id,
        label: summary?.label ?? `Circuit ${id}`,
        watts: liveValue ?? latestSample?.circuitPowerW?.[id] ?? summary?.latestWatts ?? null,
        energy: summary?.totalKwh ?? latestSample?.circuitEnergyKwh?.[id] ?? null,
      };
    });
  }, [history.summary.circuits, latestSample, status?.meter?.channel_power?.decoded?.channels]);

  const toggleSeries = (key: EnergySeriesKey) => {
    setSelected((current) => current.includes(key)
      ? current.length === 1 ? current : current.filter((item) => item !== key)
      : [...current, key]);
  };
  const refresh = () => {
    refreshStatus();
    refreshHistory();
  };

  return (
    <main className="page energy-page">
      <header className="page-heading">
        <div><p className="eyebrow">Explore</p><h1>Energy</h1><p>Compare demand, generation, storage, and grid exchange on one timeline.</p></div>
        <button className="quiet-button" type="button" onClick={refresh} disabled={(loading && !history.samples.length) || loadingState === "loading" || manualRefreshing}>{loading && !history.samples.length ? "Loading…" : manualRefreshing ? "Refreshing…" : "Refresh"}</button>
      </header>

      {error ? <div className="status-banner" data-severity="critical">History: {error}</div> : null}

      <section className="live-summary" aria-label="Current energy measurements">
        <Metric label="House demand" value={formatPower(metricValue(status?.meter?.house_demand_power))} detail="Current household load" />
        <Metric label="Solar" value={formatPower(metricValue(status?.energy?.solar?.instant_power))} detail="Generation now" tone="solar" />
        <Metric label="Ene-Farm" value={formatPower(metricValue(fuelCell?.instant_power))} detail={fuelCell?.generation_status?.value ?? "Generation state unavailable"} tone="fuel-cell" />
        <Metric label="Battery" value={formatPower(metricValue(battery?.instant_power))} detail={`${formatSoc(metricValue(battery?.remaining_percent))} state of charge`} tone="battery" />
        <Metric label="Grid import" value={formatPower(metricValue(status?.meter?.grid_import_power))} detail="Power bought now" tone="grid" />
        <Metric label="Grid export" value={formatPower(metricValue(status?.meter?.grid_export_power))} detail="Power sent now" tone="grid" />
      </section>

      <section className="panel history-workspace" aria-labelledby="energy-history-heading">
        <div className="history-toolbar">
          <div><p className="eyebrow">Combined history</p><h2 id="energy-history-heading">Power flows and storage</h2></div>
          <TimeRangeControl value={range} onChange={setRange} />
        </div>
        <fieldset className="series-picker">
          <legend>Visible metrics</legend>
          {selectableSeries.map((key) => (
            <label key={key} style={{ "--series-color": energySeries[key].color } as CSSProperties}>
              <input type="checkbox" checked={selected.includes(key)} onChange={() => toggleSeries(key)} />
              <i aria-hidden="true" />{energySeries[key].label}
            </label>
          ))}
        </fieldset>
        <CombinedEnergyChart samples={chartSamples} selected={selected} label={`${range} energy history`} />
        <div className="quality-note"><strong>Data quality</strong><span>{dataQualityDescription(history.summary.dataQuality)}</span></div>
      </section>

      <section className="outcome-section" aria-labelledby="period-outcomes-heading">
        <div className="section-heading"><div><p className="eyebrow">Selected period</p><h2 id="period-outcomes-heading">Energy outcomes</h2></div><span className="sample-count">{history.summary.sampleCount ?? history.samples.length} records</span></div>
        <OutcomeStrip summary={history.summary} />
      </section>

      <section className="panel battery-balance" aria-labelledby="battery-balance-heading">
        <div><p className="eyebrow">Storage balance</p><h2 id="battery-balance-heading">Battery over this period</h2></div>
        <dl>
          <div><dt>Charged</dt><dd>{formatEnergy(history.summary.batteryChargedKwh)}</dd></div>
          <div><dt>Discharged</dt><dd>{formatEnergy(history.summary.batteryDischargedKwh)}</dd></div>
          <div><dt>Net</dt><dd>{formatEnergy(history.summary.batteryNetKwh)}</dd></div>
          <div><dt>Average SOC</dt><dd>{formatPercent(history.summary.averageStateOfChargePercent)}</dd></div>
          <div><dt>Hot-water tank</dt><dd>{fuelCell?.hot_water_level?.value == null ? "—" : `${fuelCell.hot_water_level.value}/5`}</dd></div>
        </dl>
      </section>

      <section id="circuits" className="panel circuits-panel" aria-labelledby="circuits-heading">
        <div className="section-heading"><div><p className="eyebrow">Smart Cosmo</p><h2 id="circuits-heading">Circuits</h2></div><span className="sample-count">{circuits.length} reporting</span></div>
        {circuits.length ? (
          <div className="table-scroll"><table><thead><tr><th>Circuit</th><th>Power now</th><th>Period energy</th></tr></thead><tbody>
            {circuits.map((circuit) => <tr key={circuit.id}><th>{circuit.label}</th><td>{formatPower(circuit.watts)}</td><td>{formatEnergy(circuit.energy)}</td></tr>)}
          </tbody></table></div>
        ) : <p className="empty-copy">No circuit readings are available for this period.</p>}
      </section>
    </main>
  );
}
