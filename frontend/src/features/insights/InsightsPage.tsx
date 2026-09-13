import { useMemo, useState } from "react";
import type { EneFarmReport, EnergyReport, EnergyReportBucket } from "../../api/contracts";
import { formatEnergy, formatPercent, formatPower } from "../../core/format";
import { useReports } from "../../hooks/useReports";
import type { ReportBucket } from "../../hooks/useReports";

type Domain = "energy" | "ene-farm";
type Preset = "30d" | "90d" | "12m" | "custom";

function rangeFor(preset: Preset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === "30d") start.setDate(start.getDate() - 30);
  if (preset === "90d") start.setDate(start.getDate() - 90);
  if (preset === "12m") start.setFullYear(start.getFullYear() - 1);
  return { start, end };
}

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yen(value?: number | null) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value!) : "Unavailable";
}

function number(value?: number | null, suffix = "") {
  return Number.isFinite(value) ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value!)}${suffix}` : "Unavailable";
}

function Coverage({ bucket }: { bucket?: EnergyReportBucket | null }) {
  const values = Object.values(bucket?.dataQuality ?? {}).map((item) => item.coveragePercent).filter((item): item is number => Number.isFinite(item));
  if (!values.length) return <span>Coverage unavailable</span>;
  return <span>Lowest metric coverage {formatPercent(Math.min(...values))}</span>;
}

function Trend({ report }: { report: EnergyReport }) {
  const rows = report.buckets;
  const width = 900;
  const height = 250;
  const pad = 34;
  const values = rows.flatMap((row) => [row.houseDemandKwh, row.solarGenerationKwh, row.gridImportKwh]).filter((value): value is number => Number.isFinite(value));
  const max = Math.max(1, ...values);
  const x = (index: number) => pad + (rows.length <= 1 ? 0 : index / (rows.length - 1) * (width - pad * 2));
  const y = (value: number) => height - pad - value / max * (height - pad * 2);
  const segments = (key: keyof EnergyReportBucket) => {
    const result: string[] = [];
    let current: string[] = [];
    rows.forEach((row, index) => {
      if (Number(row.sampleCount ?? 0) > 0 && Number.isFinite(row[key])) {
        current.push(`${x(index)},${y(Number(row[key]))}`);
      } else if (current.length) {
        result.push(current.join(" "));
        current = [];
      }
    });
    if (current.length) result.push(current.join(" "));
    return result;
  };
  const series = [
    { key: "houseDemandKwh" as const, className: "series-demand", label: "demand" },
    { key: "solarGenerationKwh" as const, className: "series-solar", label: "solar" },
    { key: "gridImportKwh" as const, className: "series-grid", label: "grid import" },
  ];
  return <div className="insights-chart-wrap"><svg className="insights-chart" role="img" aria-label="Energy use, solar generation, and grid import by reporting period" viewBox={`0 0 ${width} ${height}`}>
    {[0, .5, 1].map((tick) => <g key={tick}><line x1={pad} x2={width - pad} y1={y(max * tick)} y2={y(max * tick)} /><text x={pad - 8} y={y(max * tick) + 4}>{number(max * tick)}</text></g>)}
    {series.flatMap((item) => segments(item.key).map((points, index) => <polyline key={`${item.key}-${index}`} className={item.className} points={points} />))}
    {rows.flatMap((row, index) => Number(row.sampleCount ?? 0) > 0 ? series.filter((item) => Number.isFinite(row[item.key])).map((item) => <circle key={`${row.key}-${item.key}`} className={item.className} tabIndex={0} cx={x(index)} cy={y(Number(row[item.key]))} r="4"><title>{row.label}: {item.label} {formatEnergy(Number(row[item.key]))}</title></circle>) : [])}
  </svg><div className="chart-legend" aria-label="Chart legend"><span className="demand">Demand</span><span className="solar">Solar</span><span className="grid">Grid import</span></div></div>;
}

function EnergyInsights({ report }: { report: EnergyReport }) {
  const totals = report.totals;
  const observed = report.buckets.filter((row) => Number(row.sampleCount ?? 0) > 0);
  const unobservedCount = report.buckets.length - observed.length;
  const prior = observed.length > 1 ? observed.at(-2) : null;
  const latest = observed.at(-1);
  return <>
    <section className="insight-kpis" aria-label="Energy outcomes"><article className="panel"><span>House demand</span><strong>{formatEnergy(totals.houseDemandKwh)}</strong><small>Recorded over selected period</small></article><article className="panel"><span>Grid import</span><strong>{formatEnergy(totals.gridImportKwh)}</strong><small>{formatEnergy(totals.gridExportKwh)} exported</small></article><article className="panel"><span>Solar contribution</span><strong>{formatEnergy(totals.solarGenerationKwh)}</strong><small>{formatPercent(totals.solarCoveragePercent)} of demand generated</small></article><article className="panel estimated"><span>Estimated savings</span><strong>{yen((totals.solarSavingYen ?? 0) + (totals.totalOffPeakSavingYen ?? 0))}</strong><small>Solar plus off-peak estimate</small></article></section>
    <section className="panel insight-comparison"><div className="section-heading"><div><h2>Period comparison</h2><p>Recorded energy outcomes at the selected grain.</p></div><Coverage bucket={latest} /></div>{observed.length ? <Trend report={report} /> : <p className="automation-empty">No observed report periods are available.</p>}<div className="comparison-note"><strong>{latest?.label ?? "Latest period"}</strong><span>{Number.isFinite(latest?.houseDemandDeltaPercent) ? `${latest!.houseDemandDeltaPercent! > 0 ? "+" : ""}${number(latest!.houseDemandDeltaPercent, "%")} demand versus the previous period.` : prior ? "A comparable demand delta is unavailable." : "Add another complete period to compare demand."}{unobservedCount ? ` ${unobservedCount} periods without samples are shown as gaps and omitted from the table.` : ""}</span></div></section>
    <section className="panel savings-detail"><div className="section-heading"><div><h2>Estimated savings breakdown</h2><p>Tariff-derived estimates; check provider statements for billed amounts.</p></div></div><div className="savings-breakdown"><article><span>Total off-peak</span><strong>{yen(totals.totalOffPeakSavingYen)}</strong></article><article><span>Grid use</span><strong>{yen(totals.gridOffPeakSavingYen)}</strong></article><article><span>Battery charging</span><strong>{yen(totals.batteryOffPeakSavingYen)}</strong></article><article><span>Solar</span><strong>{yen(totals.solarSavingYen)}</strong></article><article><span>Estimated avoided CO₂</span><strong>{number(totals.co2SavingKg, " kg")}</strong></article></div></section>
    <section className="panel report-table"><div className="section-heading"><div><h2>Energy detail</h2><p>Exact lookup for observed reporting periods. Energy values are sampled or counter-derived according to coverage metadata.</p></div>{unobservedCount ? <span className="sample-count">{unobservedCount} no-data periods omitted</span> : null}</div><div className="table-scroll"><table><thead><tr><th>Period</th><th>Demand</th><th>Change</th><th>Solar</th><th>Import</th><th>Export</th><th>Ene-Farm</th><th>Peak</th></tr></thead><tbody>{observed.map((row) => <tr key={row.key}><th>{row.label}</th><td>{formatEnergy(row.houseDemandKwh)}</td><td>{Number.isFinite(row.houseDemandDeltaPercent) ? number(row.houseDemandDeltaPercent, "%") : "—"}</td><td>{formatEnergy(row.solarGenerationKwh)}</td><td>{formatEnergy(row.gridImportKwh)}</td><td>{formatEnergy(row.gridExportKwh)}</td><td>{formatEnergy(row.fuelCellKwh)}</td><td>{formatPower(row.peakDemandW ?? null)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function EneFarmInsights({ report }: { report: EneFarmReport }) {
  const totals = report.totals;
  return <><section className="insight-kpis" aria-label="Ene-Farm outcomes"><article className="panel"><span>Electricity generated</span><strong>{formatEnergy(totals.generatedKwh)}</strong><small>{number(totals.operatingSeconds ? totals.operatingSeconds / 3600 : null, " h operating")}</small></article><article className="panel"><span>Gas used</span><strong>{number(totals.gasM3, " m³")}</strong><small>{number(totals.electricalYieldKwhPerM3, " kWh/m³ yield")}</small></article><article className="panel estimated"><span>Estimated marginal gas cost</span><strong>{yen(totals.estimatedGasCost?.marginalCostYen)}</strong><small>Excludes unrelated household gas use</small></article><article className="panel estimated"><span>Estimated carbon balance</span><strong>{number(totals.carbon?.electricityOnlyBalanceKg, " kg-CO₂")}</strong><small>Avoided grid emissions minus direct gas</small></article></section><section className="panel report-table"><div className="section-heading"><div><h2>Ene-Farm detail</h2><p>{report.estimateNotice}</p></div></div><div className="table-scroll"><table><thead><tr><th>Period</th><th>Generated</th><th>Gas</th><th>Yield</th><th>Operating</th><th>Starts</th><th>Marginal cost</th><th>Carbon balance</th></tr></thead><tbody>{report.buckets.map((row) => <tr key={row.key}><th>{row.label}</th><td>{formatEnergy(row.generatedKwh)}</td><td>{number(row.gasM3, " m³")}</td><td>{number(row.electricalYieldKwhPerM3, " kWh/m³")}</td><td>{number(row.operatingSeconds ? row.operatingSeconds / 3600 : null, " h")}</td><td>{row.startCount ?? "—"}</td><td>{yen(row.estimatedGasCost?.marginalCostYen)}</td><td>{number(row.carbon?.electricityOnlyBalanceKg, " kg")}</td></tr>)}</tbody></table></div></section></>;
}

export function InsightsPage() {
  const [domain, setDomain] = useState<Domain>("energy");
  const [preset, setPreset] = useState<Preset>("30d");
  const [bucket, setBucket] = useState<ReportBucket>("day");
  const initialRange = useMemo(() => rangeFor("30d"), []);
  const [customStart, setCustomStart] = useState(localDateValue(initialRange.start));
  const [customEnd, setCustomEnd] = useState(localDateValue(initialRange.end));
  const range = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    const start = new Date(`${customStart}T00:00:00`);
    const end = new Date(`${customEnd}T23:59:59.999`);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end ? { start, end } : initialRange;
  }, [preset, customStart, customEnd, initialRange]);
  const { energy, eneFarm, loading, error, refresh } = useReports(range.start, range.end, bucket);
  return <main className="page insights-page"><header className="page-heading"><div><p className="eyebrow">Understand</p><h1>Insights</h1><p>Compare recorded energy outcomes and clearly labeled cost and carbon estimates.</p></div><button className="quiet-button" type="button" onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button></header>{error ? <div className="status-banner" data-severity="critical">Insights: {error}</div> : null}<section className="panel insight-controls" aria-label="Report controls"><div className="segmented-control">{(["energy", "ene-farm"] as Domain[]).map((item) => <button key={item} type="button" aria-pressed={domain === item} onClick={() => setDomain(item)}>{item === "energy" ? "Energy" : "Ene-Farm"}</button>)}</div><label>Period<select value={preset} onChange={(event) => setPreset(event.target.value as Preset)}><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="12m">Last 12 months</option><option value="custom">Custom dates</option></select></label><label>Group by<select value={bucket} onChange={(event) => setBucket(event.target.value as ReportBucket)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label>{preset === "custom" ? <><label>Start date<input type="date" value={customStart} max={customEnd} onChange={(event) => setCustomStart(event.target.value)} /></label><label>End date<input type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} /></label></> : null}<span>{range.start.toLocaleDateString()}–{range.end.toLocaleDateString()}</span></section>{loading && !(domain === "energy" ? energy : eneFarm) ? <div className="panel automation-empty">Loading report evidence…</div> : domain === "energy" && energy ? <EnergyInsights report={energy} /> : domain === "ene-farm" && eneFarm ? <EneFarmInsights report={eneFarm} /> : !loading ? <div className="panel automation-empty">Report evidence is unavailable for this period.</div> : null}</main>;
}
