import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { CombinedEnergyChart } from "../../components/CombinedEnergyChart";
import { Metric } from "../../components/Metric";
import { OutcomeStrip } from "../../components/OutcomeStrip";
import { TimeRangeControl } from "../../components/TimeRangeControl";
import { CircuitHistoryChart, EneFarmActivity, EneFarmDetails } from "../../components/TelemetryParity";
import { formatEnergy, formatPercent, formatPower, formatSoc, metricValue } from "../../core/format";
import { withLatestStatus } from "../../core/energy";
import { energySeries } from "../../core/energySeries";
import type { EnergySeriesKey } from "../../core/energySeries";
import { timeRangeMilliseconds } from "../../core/timeRange";
import type { TimeRangeId } from "../../core/timeRange";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useHistoryRange } from "../../hooks/useHistoryRange";
import { useEneFarm } from "../../hooks/useEneFarm";
import { T, useI18n } from "../../i18n";

const selectableSeries = Object.keys(energySeries) as EnergySeriesKey[];
const defaultSeries: EnergySeriesKey[] = ["houseDemandW", "solarPowerW", "fuelCellPowerW", "gridImportW", "batteryPowerW"];
type CircuitSortKey = "label" | "watts" | "energy";
type SortDirection = "ascending" | "descending";
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
  const { text } = useI18n();
  const [searchParams] = useSearchParams();
  const requestedMetric = metricAliases[searchParams.get("metric") ?? ""];
  const [range, setRange] = useState<TimeRangeId>("24h");
  const [selected, setSelected] = useState<EnergySeriesKey[]>(requestedMetric ? [requestedMetric] : defaultSeries);
  const [selectedCircuit, setSelectedCircuit] = useState("");
  const [circuitSort, setCircuitSort] = useState<{
    key: CircuitSortKey;
    direction: SortDirection;
  }>({ key: "watts", direction: "descending" });
  const { status, loadingState, manualRefreshing, refresh: refreshStatus } = useEnergyStatus();
  const { history, loading, error, refresh: refreshHistory } = useHistoryRange(timeRangeMilliseconds(range), range === "live" ? status?.read_at : undefined);
  const { summary: eneFarmSummary, error: eneFarmError, loading: eneFarmLoading, refresh: refreshEneFarm } = useEneFarm(timeRangeMilliseconds(range));
  const battery = status?.energy?.battery;
  const fuelCell = latestFuelCell(status);
  const latestSample = history.samples.at(-1);
  const chartSamples = useMemo(() => withLatestStatus(history.samples, status), [history.samples, status]);
  const circuits = useMemo(() => {
    const summaryByChannel = new Map((history.summary.circuits ?? []).map((item) => [String(item.channel), item]));
    const live = status?.meter?.channel_power?.decoded?.channels ?? [];
    const ids = new Set([...live.map((item) => String(item.channel)), ...Object.keys(latestSample?.circuitPowerW ?? {}), ...summaryByChannel.keys()]);
    return [...ids]
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => {
        const liveValue = live.find((item) => String(item.channel) === id)?.value;
        const summary = summaryByChannel.get(id);
        return {
          id,
          label: summary?.label ?? text("Circuit {value}", { value: id }),
          watts: liveValue ?? latestSample?.circuitPowerW?.[id] ?? summary?.latestWatts ?? null,
          energy: summary?.totalKwh ?? latestSample?.circuitEnergyKwh?.[id] ?? null,
        };
      });
  }, [history.summary.circuits, latestSample, status?.meter?.channel_power?.decoded?.channels, text]);
  const activeCircuit = circuits.some((circuit) => circuit.id === selectedCircuit) ? selectedCircuit : (circuits[0]?.id ?? "");
  const sortedCircuits = useMemo(
    () =>
      [...circuits].sort((left, right) => {
        const direction = circuitSort.direction === "ascending" ? 1 : -1;
        if (circuitSort.key === "label") return direction * left.label.localeCompare(right.label, undefined, { numeric: true });
        const leftValue = circuitSort.key === "watts" ? left.watts : left.energy;
        const rightValue = circuitSort.key === "watts" ? right.watts : right.energy;
        if (leftValue == null) return rightValue == null ? 0 : 1;
        if (rightValue == null) return -1;
        return direction * (leftValue - rightValue);
      }),
    [circuitSort, circuits],
  );

  const sortCircuits = (key: CircuitSortKey) =>
    setCircuitSort((current) => ({
      key,
      direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending",
    }));

  const toggleSeries = (key: EnergySeriesKey) => {
    setSelected((current) => (current.includes(key) ? (current.length === 1 ? current : current.filter((item) => item !== key)) : [...current, key]));
  };
  const refresh = () => {
    refreshStatus();
    refreshHistory();
    refreshEneFarm();
  };

  return (
    <main className="page energy-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            <T text={"Explore"} />
          </p>
          <h1>
            <T text={"Energy"} />
          </h1>
          <p>
            <T text={"Compare demand, generation, storage, and grid exchange on one timeline."} />
          </p>
        </div>
        <button className="quiet-button" type="button" onClick={refresh} disabled={(loading && !history.samples.length) || loadingState === "loading" || manualRefreshing}>
          {text(loading && !history.samples.length ? "Loading…" : manualRefreshing ? "Refreshing…" : "Refresh")}
        </button>
      </header>

      {error ? (
        <div className="status-banner" data-severity="critical">
          <T text={"History: "} />
          {error}
        </div>
      ) : null}

      <section className="live-summary" aria-label={text("Current energy measurements")}>
        <Metric label={text("House demand")} value={formatPower(metricValue(status?.meter?.house_demand_power))} detail={text("Current household load")} />
        <Metric label={text("Solar")} value={formatPower(metricValue(status?.energy?.solar?.instant_power))} detail={text("Generation now")} tone="solar" />
        <Metric
          label={text("Ene-Farm")}
          value={formatPower(metricValue(fuelCell?.instant_power))}
          detail={text(fuelCell?.generation_status?.value ?? "Generation state unavailable")}
          tone="fuel-cell"
        />
        <Metric
          label={text("Battery")}
          value={formatPower(metricValue(battery?.instant_power))}
          detail={text("{value} state of charge", {
            value: formatSoc(metricValue(battery?.remaining_percent)),
          })}
          tone="battery"
        />
        <Metric label={text("Grid import")} value={formatPower(metricValue(status?.meter?.grid_import_power))} detail={text("Power bought now")} tone="grid" />
        <Metric label={text("Grid export")} value={formatPower(metricValue(status?.meter?.grid_export_power))} detail={text("Power sent now")} tone="grid" />
      </section>

      <section className="panel history-workspace" aria-labelledby="energy-history-heading">
        <div className="history-toolbar">
          <div>
            <p className="eyebrow">
              <T text={"Combined history"} />
            </p>
            <h2 id="energy-history-heading">
              <T text={"Power flows and storage"} />
            </h2>
          </div>
          <TimeRangeControl value={range} onChange={setRange} />
        </div>
        <fieldset className="series-picker">
          <legend>
            <T text={"Visible metrics "} />
            <span>
              <T text={"· Select to show or hide"} />
            </span>
          </legend>
          {selectableSeries.map((key) => (
            <label key={key} style={{ "--series-color": energySeries[key].color } as CSSProperties}>
              <input type="checkbox" checked={selected.includes(key)} onChange={() => toggleSeries(key)} />
              <i aria-hidden="true" />
              {text(energySeries[key].label)}
            </label>
          ))}
        </fieldset>
        <CombinedEnergyChart samples={chartSamples} selected={selected} label={text("{value} energy history", { value: range })} showSeriesLegend={false} />
        <div className="quality-note">
          <strong>
            <T text={"Data quality"} />
          </strong>
          <span>{dataQualityDescription(history.summary.dataQuality)}</span>
        </div>
      </section>

      <section className="outcome-section" aria-labelledby="period-outcomes-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              <T text={"Selected period"} />
            </p>
            <h2 id="period-outcomes-heading">
              <T text={"Energy outcomes"} />
            </h2>
          </div>
          <span className="sample-count">
            {history.summary.sampleCount ?? history.samples.length} <T text={" records"} />
          </span>
        </div>
        <OutcomeStrip summary={history.summary} />
      </section>

      <section className="panel battery-balance" aria-labelledby="battery-balance-heading">
        <div>
          <p className="eyebrow">
            <T text={"Storage balance"} />
          </p>
          <h2 id="battery-balance-heading">
            <T text={"Battery over this period"} />
          </h2>
        </div>
        <dl>
          <div>
            <dt>
              <T text={"Charged"} />
            </dt>
            <dd>{formatEnergy(history.summary.batteryChargedKwh)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Discharged"} />
            </dt>
            <dd>{formatEnergy(history.summary.batteryDischargedKwh)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Net"} />
            </dt>
            <dd>{formatEnergy(history.summary.batteryNetKwh)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Average SOC"} />
            </dt>
            <dd>{formatPercent(history.summary.averageStateOfChargePercent)}</dd>
          </div>
          <div>
            <dt>
              <T text={"Hot-water tank"} />
            </dt>
            <dd>{fuelCell?.hot_water_level?.value == null ? "—" : `${fuelCell.hot_water_level.value}/5`}</dd>
          </div>
        </dl>
      </section>

      <section id="ene-farm" className="panel ene-farm-panel" aria-labelledby="ene-farm-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              <T text={"Selected period"} />
            </p>
            <h2 id="ene-farm-heading">
              <T text={"Ene-Farm"} />
            </h2>
          </div>
          <span className="sample-count">
            {eneFarmSummary?.sampleCount ?? 0} <T text={" records"} />
          </span>
        </div>
        {eneFarmError ? (
          <p className="status-banner">
            <T text={"Ene-Farm summary: "} />
            {eneFarmError}
          </p>
        ) : null}
        <EneFarmActivity summary={eneFarmSummary} period={text("Selected period")} loading={eneFarmLoading} />
        {!eneFarmLoading ? <EneFarmDetails summary={eneFarmSummary} hotWaterLevel={fuelCell?.hot_water_level?.value} /> : null}
      </section>

      <section id="circuits" className="panel circuits-panel" aria-labelledby="circuits-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              <T text={"Smart Cosmo"} />
            </p>
            <h2 id="circuits-heading">
              <T text={"Circuit history"} />
            </h2>
            <p className="section-copy">
              <T text={"Select a circuit in the table to update the graph."} />
            </p>
          </div>
          {circuits.length ? (
            <span className="sample-count">
              {circuits.length} <T text={"reporting"} />
            </span>
          ) : (
            <span className="sample-count">
              <T text={"0 reporting"} />
            </span>
          )}
        </div>
        {activeCircuit ? (
          <CircuitHistoryChart
            samples={history.samples}
            circuitId={activeCircuit}
            label={circuits.find((circuit) => circuit.id === activeCircuit)?.label ?? text("Circuit {value}", { value: activeCircuit })}
          />
        ) : null}
        {circuits.length ? (
          <div className="table-scroll">
            <table className="selectable-circuit-table">
              <thead>
                <tr>
                  <th aria-sort={circuitSort.key === "label" ? circuitSort.direction : "none"}>
                    <button type="button" onClick={() => sortCircuits("label")}>
                      <T text={"Circuit"} />
                      <span aria-hidden="true">↕</span>
                    </button>
                  </th>
                  <th aria-sort={circuitSort.key === "watts" ? circuitSort.direction : "none"}>
                    <button type="button" onClick={() => sortCircuits("watts")}>
                      <T text={"Power now"} />
                      <span aria-hidden="true">↕</span>
                    </button>
                  </th>
                  <th aria-sort={circuitSort.key === "energy" ? circuitSort.direction : "none"}>
                    <button type="button" onClick={() => sortCircuits("energy")}>
                      <T text={"Period energy"} />
                      <span aria-hidden="true">↕</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedCircuits.map((circuit) => (
                  <tr key={circuit.id} data-selected={circuit.id === activeCircuit}>
                    <th>
                      <button type="button" aria-pressed={circuit.id === activeCircuit} onClick={() => setSelectedCircuit(circuit.id)}>
                        {circuit.label}
                      </button>
                    </th>
                    <td>{formatPower(circuit.watts)}</td>
                    <td>{formatEnergy(circuit.energy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-copy">
            <T text={"No circuit readings are available for this period."} />
          </p>
        )}
      </section>
    </main>
  );
}
