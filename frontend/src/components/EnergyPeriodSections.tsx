import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { CombinedEnergyChart } from "./CombinedEnergyChart";
import { OutcomeStrip } from "./OutcomeStrip";
import { CircuitHistoryChart, EneFarmActivity, EneFarmDetails, EnergySourcesBar } from "./TelemetryParity";
import { formatDateTimesInText, formatEnergy, formatPercent, formatPower, metricValue } from "../core/format";
import { withLatestStatus } from "../core/energy";
import { energySeries } from "../core/energySeries";
import type { EnergySeriesKey } from "../core/energySeries";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { useHistoryRange } from "../hooks/useHistoryRange";
import { useEneFarm } from "../hooks/useEneFarm";
import { T, useI18n } from "../i18n";

export type EnergyPeriodSection = "history" | "balance" | "outcomes" | "battery" | "ene-farm" | "circuits";

const selectableSeries = Object.keys(energySeries) as EnergySeriesKey[];
const defaultSeries: EnergySeriesKey[] = ["houseDemandW", "solarPowerW", "fuelCellPowerW", "gridImportW", "batteryPowerW"];
type CircuitSortKey = "id" | "label" | "watts" | "energy" | "share" | "trend";
type SortDirection = "ascending" | "descending";

function dataQualityDescription(dataQuality: ReturnType<typeof useHistoryRange>["history"]["summary"]["dataQuality"]) {
  const entries = Object.entries(dataQuality ?? {});
  if (!entries.length) return "Quality metadata is not available for this period.";
  const qualities = [...new Set(entries.map(([, value]) => value.quality).filter(Boolean))];
  const coverage = entries.map(([, value]) => Number(value.coveragePercent)).filter(Number.isFinite);
  const minimumCoverage = coverage.length ? Math.min(...coverage) : null;
  return `${qualities.length ? qualities.join(" + ") : "Mixed source"}${minimumCoverage === null ? "" : ` · minimum coverage ${formatPercent(minimumCoverage)}`}`;
}

export function EnergyPeriodSections({
  milliseconds,
  start,
  end,
  periodLabel,
  sections,
  current = false,
  refreshKey,
  visible = () => true,
}: {
  milliseconds: number;
  start?: string;
  end?: string;
  periodLabel: string;
  sections: EnergyPeriodSection[];
  current?: boolean;
  refreshKey?: string;
  visible?: (id: string) => boolean;
}) {
  const { text } = useI18n();
  const [selected, setSelected] = useState<EnergySeriesKey[]>(defaultSeries);
  const [selectedCircuit, setSelectedCircuit] = useState("");
  const [circuitSort, setCircuitSort] = useState<{ key: CircuitSortKey; direction: SortDirection } | null>(null);
  const { config, status } = useEnergyStatus();
  const { history, loading, rangeLoading, error } = useHistoryRange(milliseconds, refreshKey, start, end);
  const { summary: eneFarmSummary, error: eneFarmError, loading: eneFarmLoading, rangeLoading: eneFarmRangeLoading } = useEneFarm(milliseconds, start, end, refreshKey);
  const fuelCell = status?.energy?.fuel_cells?.find((item) => item.source_role === "primary") ?? status?.energy?.fuel_cells?.[0];
  const latestSample = history.samples.at(-1);
  const availableSeries = selectableSeries.filter((key) => {
    if (key === "solarPowerW") return config?.solarEnabled !== false;
    if (key === "fuelCellPowerW" || key === "fuelCellHotWaterLevel") return config?.fuelCellEnabled !== false;
    if (["houseDemandW", "gridImportW", "gridExportW"].includes(key)) return config?.smartCosmoEnabled !== false;
    return true;
  });
  const visibleSelected = selected.filter((key) => availableSeries.includes(key));
  const chartSamples = useMemo(() => current ? withLatestStatus(history.samples, status) : history.samples, [current, history.samples, status]);
  const circuits = useMemo(() => {
    const summaryByChannel = new Map((history.summary.circuits ?? []).map((item) => [String(item.channel), item]));
    const live = current ? status?.meter?.channel_power?.decoded?.channels ?? [] : [];
    const ids = new Set([...live.map((item) => String(item.channel)), ...Object.keys(latestSample?.circuitPowerW ?? {}), ...summaryByChannel.keys()]);
    const totalEnergy = Number(history.summary.circuitTotalKwh ?? (history.summary.circuits ?? []).reduce((sum, item) => sum + Number(item.totalKwh ?? 0), 0));
    return [...ids]
      .filter((id) => config?.circuitDashboardVisibility?.[id] !== false)
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => {
        const liveValue = live.find((item) => String(item.channel) === id)?.value;
        const summary = summaryByChannel.get(id);
        const points = history.samples.map((sample) => sample.circuitPowerW?.[id]).filter((value): value is number => Number.isFinite(value));
        const window = Math.max(1, Math.floor(points.length * 0.2));
        const firstAverage = points.slice(0, window).reduce((sum, value) => sum + value, 0) / window;
        const lastAverage = points.slice(-window).reduce((sum, value) => sum + value, 0) / window;
        const energy = summary?.totalKwh ?? latestSample?.circuitEnergyKwh?.[id] ?? null;
        return {
          id,
          label: config?.circuitLabels?.[id] ?? summary?.label ?? text("Circuit {value}", { value: id }),
          watts: liveValue ?? latestSample?.circuitPowerW?.[id] ?? summary?.latestWatts ?? null,
          energy,
          share: energy != null && totalEnergy > 0 ? energy / totalEnergy * 100 : null,
          trend: points.length > 1 && firstAverage > 0 ? (lastAverage - firstAverage) / firstAverage * 100 : null,
        };
      });
  }, [config?.circuitDashboardVisibility, config?.circuitLabels, current, history.samples, history.summary.circuitTotalKwh, history.summary.circuits, latestSample, status?.meter?.channel_power?.decoded?.channels, text]);
  const effectiveCircuitSort = useMemo(() => circuitSort ?? (
    config?.circuitSortMode === "number"
      ? { key: "id" as const, direction: "ascending" as const }
      : config?.circuitSortMode === "accumulated"
        ? { key: "energy" as const, direction: "descending" as const }
        : { key: "watts" as const, direction: "descending" as const }
  ), [circuitSort, config?.circuitSortMode]);
  const activeCircuit = circuits.some((circuit) => circuit.id === selectedCircuit) ? selectedCircuit : (circuits[0]?.id ?? "");
  const sortedCircuits = useMemo(() => [...circuits].sort((left, right) => {
    const direction = effectiveCircuitSort.direction === "ascending" ? 1 : -1;
    if (effectiveCircuitSort.key === "id") return direction * (Number(left.id) - Number(right.id));
    if (effectiveCircuitSort.key === "label") return direction * left.label.localeCompare(right.label, undefined, { numeric: true });
    const leftValue = effectiveCircuitSort.key === "watts" ? left.watts : effectiveCircuitSort.key === "energy" ? left.energy : effectiveCircuitSort.key === "share" ? left.share : left.trend;
    const rightValue = effectiveCircuitSort.key === "watts" ? right.watts : effectiveCircuitSort.key === "energy" ? right.energy : effectiveCircuitSort.key === "share" ? right.share : right.trend;
    if (leftValue == null) return rightValue == null ? 0 : 1;
    if (rightValue == null) return -1;
    return direction * (leftValue - rightValue);
  }), [effectiveCircuitSort, circuits]);
  const sortCircuits = (key: CircuitSortKey) => setCircuitSort((currentSort) => ({
    key,
    direction: (currentSort ?? effectiveCircuitSort).key === key && (currentSort ?? effectiveCircuitSort).direction === "ascending" ? "descending" : "ascending",
  }));
  const toggleSeries = (key: EnergySeriesKey) => setSelected((currentSelection) => currentSelection.includes(key)
    ? (currentSelection.length === 1 ? currentSelection : currentSelection.filter((item) => item !== key))
    : [...currentSelection, key]);
  const periodLoading = rangeLoading || eneFarmRangeLoading;
  const includes = (section: EnergyPeriodSection) => sections.includes(section);

  return <div className={`period-results${periodLoading ? " is-loading" : ""}`} aria-busy={periodLoading}>
    {error ? <div className="status-banner" data-severity="critical"><T text={"History: "} />{formatDateTimesInText(error)}</div> : null}

    {includes("history") ? <section className="panel history-workspace" aria-labelledby={`${current ? "today" : "report"}-energy-history-heading`}>
      <div className="history-toolbar"><div><p className="eyebrow">{periodLabel}</p><h2 id={`${current ? "today" : "report"}-energy-history-heading`}><T text={"Power flows and storage"} /></h2></div></div>
      <fieldset className="series-picker">
        <legend><T text={"Visible metrics "} /><span><T text={"· Select to show or hide"} /></span></legend>
        {availableSeries.map((key) => <label key={key} style={{ "--series-color": energySeries[key].color } as CSSProperties}><input type="checkbox" checked={selected.includes(key)} onChange={() => toggleSeries(key)} /><i aria-hidden="true" />{text(energySeries[key].label)}</label>)}
      </fieldset>
      <CombinedEnergyChart samples={chartSamples} selected={visibleSelected} label={text("{value} energy history", { value: periodLabel })} showSeriesLegend={false} />
      <div className="quality-note"><strong><T text={"Data quality"} /></strong><span>{dataQualityDescription(history.summary.dataQuality)}</span></div>
    </section> : null}

    {includes("balance") ? <section className="energy-balance-grid" aria-label={text("Energy source and destination balance")} aria-busy={loading}>
      {loading && !history.summary.sampleCount ? <article className="telemetry-card"><p className="telemetry-empty"><T text={"Loading source composition…"} /></p></article> : <EnergySourcesBar sources={history.summary.energySources} period={periodLabel} />}
      <article className="telemetry-card destination-balance-card"><div className="section-heading"><div><p className="eyebrow">{periodLabel}</p><h2><T text={"Local generation destinations"} /></h2></div></div>
        {loading && !history.summary.sampleCount ? <p className="telemetry-empty"><T text={"Loading destination balance…"} /></p> : <dl>
          <div><dt><T text={"Used in the home"} /></dt><dd>{formatEnergy([history.summary.solarGenerationKwh, history.summary.fuelCellKwh, history.summary.gridExportKwh].some(Number.isFinite) ? Math.max(0, Number(history.summary.solarGenerationKwh ?? 0) + Number(history.summary.fuelCellKwh ?? 0) - Number(history.summary.gridExportKwh ?? 0)) : null)}</dd></div>
          <div><dt><T text={"Exported to the grid"} /></dt><dd>{formatEnergy(history.summary.gridExportKwh)}</dd></div>
          <div><dt><T text={"Local generation total"} /></dt><dd>{formatEnergy([history.summary.solarGenerationKwh, history.summary.fuelCellKwh].some(Number.isFinite) ? Number(history.summary.solarGenerationKwh ?? 0) + Number(history.summary.fuelCellKwh ?? 0) : null)}</dd></div>
        </dl>}
      </article>
    </section> : null}

    {includes("outcomes") ? <section className="outcome-section" aria-labelledby={`${current ? "today" : "period"}-outcomes-heading`}><div className="section-heading"><div><p className="eyebrow">{periodLabel}</p><h2 id={`${current ? "today" : "period"}-outcomes-heading`}><T text={"Energy outcomes"} /></h2></div><span className="sample-count">{history.summary.sampleCount ?? history.samples.length} <T text={" records"} /></span></div>{loading && !history.summary.sampleCount ? <p className="telemetry-empty" aria-busy="true"><T text={"Loading today's energy outcomes…"} /></p> : <OutcomeStrip summary={history.summary} compact={current} visible={visible} />}</section> : null}

    {includes("battery") ? <section className="panel battery-balance" aria-labelledby={`${current ? "today" : "period"}-battery-balance-heading`}><div><p className="eyebrow">{periodLabel}</p><h2 id={`${current ? "today" : "period"}-battery-balance-heading`}><T text={current ? "Battery today" : "Battery over this period"} /></h2></div><dl>
      <div><dt><T text={"Charged"} /></dt><dd>{formatEnergy(history.summary.batteryChargedKwh)}</dd></div><div><dt><T text={"Discharged"} /></dt><dd>{formatEnergy(history.summary.batteryDischargedKwh)}</dd></div><div><dt><T text={"Net"} /></dt><dd>{formatEnergy(history.summary.batteryNetKwh)}</dd></div><div><dt><T text={"Average SOC"} /></dt><dd>{formatPercent(history.summary.averageStateOfChargePercent)}</dd></div>
    </dl></section> : null}

    {includes("ene-farm") && config?.fuelCellEnabled !== false ? <section id={current ? "today-ene-farm" : "report-ene-farm"} className="panel ene-farm-panel" aria-labelledby={`${current ? "today" : "report"}-ene-farm-heading`}><div className="section-heading"><div><p className="eyebrow">{periodLabel}</p><h2 id={`${current ? "today" : "report"}-ene-farm-heading`}><T text={"Ene-Farm"} /></h2></div><span className="sample-count">{eneFarmSummary?.sampleCount ?? 0} <T text={" records"} /></span></div>{eneFarmError ? <p className="status-banner"><T text={"Ene-Farm summary: "} />{eneFarmError}</p> : null}<EneFarmActivity summary={eneFarmSummary} period={periodLabel} loading={eneFarmLoading} />{current && !eneFarmLoading ? <EneFarmDetails summary={eneFarmSummary} hotWaterLevel={metricValue(fuelCell?.hot_water_level)} /> : null}</section> : null}

    {includes("circuits") && config?.smartCosmoEnabled !== false ? <section id={current ? "today-circuits" : "report-circuits"} className="panel circuits-panel" aria-labelledby={`${current ? "today" : "report"}-circuits-heading`}><div className="section-heading"><div><p className="eyebrow"><T text={"Smart Cosmo"} /></p><h2 id={`${current ? "today" : "report"}-circuits-heading`}><T text={"Circuit history"} /></h2><p className="section-copy"><T text={"Select a circuit in the table to update the graph."} /></p></div><span className="sample-count">{circuits.length ? <>{circuits.length} <T text={"reporting"} /></> : <T text={"0 reporting"} />}</span></div>
      {activeCircuit ? <CircuitHistoryChart samples={history.samples} circuitId={activeCircuit} label={circuits.find((circuit) => circuit.id === activeCircuit)?.label ?? text("Circuit {value}", { value: activeCircuit })} /> : null}
      {circuits.length ? <div className="table-scroll"><table className="selectable-circuit-table"><thead><tr>
        <th aria-sort={["id", "label"].includes(effectiveCircuitSort.key) ? effectiveCircuitSort.direction : "none"}><button type="button" onClick={() => sortCircuits("label")}><T text={"Circuit"} /><span aria-hidden="true">↕</span></button></th>
        <th aria-sort={effectiveCircuitSort.key === "watts" ? effectiveCircuitSort.direction : "none"}><button type="button" onClick={() => sortCircuits("watts")}><T text={current ? "Power now" : "Latest power"} /><span aria-hidden="true">↕</span></button></th>
        <th aria-sort={effectiveCircuitSort.key === "energy" ? effectiveCircuitSort.direction : "none"}><button type="button" onClick={() => sortCircuits("energy")}><T text={"Period energy"} /><span aria-hidden="true">↕</span></button></th>
        <th aria-sort={effectiveCircuitSort.key === "share" ? effectiveCircuitSort.direction : "none"}><button type="button" onClick={() => sortCircuits("share")}><T text={"Share"} /><span aria-hidden="true">↕</span></button></th><th aria-sort={effectiveCircuitSort.key === "trend" ? effectiveCircuitSort.direction : "none"}><button type="button" onClick={() => sortCircuits("trend")}><T text={"Trend"} /><span aria-hidden="true">↕</span></button></th>
      </tr></thead><tbody>{sortedCircuits.map((circuit) => <tr key={circuit.id} data-interactive="true" data-selected={circuit.id === activeCircuit} aria-selected={circuit.id === activeCircuit} tabIndex={0} onClick={() => setSelectedCircuit(circuit.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCircuit(circuit.id); } }}><th><span className="circuit-row-label">{circuit.label}</span></th><td>{formatPower(circuit.watts)}</td><td>{formatEnergy(circuit.energy)}</td><td>{formatPercent(circuit.share)}</td><td>{circuit.trend == null ? "—" : `${circuit.trend > 0 ? "+" : ""}${formatPercent(circuit.trend)}`}</td></tr>)}</tbody></table></div> : <p className="empty-copy"><T text={"No circuit readings are available for this period."} /></p>}
    </section> : null}
  </div>;
}
