import { useId, useMemo, useState } from "react";
import type { PointerEvent } from "react";
import type { EneFarmSummary, EnergySample, EnergySources, SavingsSummary, StatusSnapshot } from "../api/contracts";
import { formatChartTime, formatCurrency, formatEnergy, formatPercent, formatPower } from "../core/format";

const sourceDefinitions = [
  { key: "peak", label: "Peak grid", value: "peakGridKwh", percent: "peakGridPercent" },
  { key: "off-peak", label: "Off-peak grid", value: "offPeakGridKwh", percent: "offPeakGridPercent" },
  { key: "solar", label: "Solar contribution", value: "solarUsedKwh", percent: "solarUsedPercent" },
  { key: "fuel-cell", label: "Ene-Farm contribution", value: "fuelCellContributionKwh", percent: "fuelCellContributionPercent" },
] as const;

export function EnergySourcesBar({ sources, period = "Today", showPeriod = true }: { sources?: EnergySources; period?: string; showPeriod?: boolean }) {
  const values = sourceDefinitions.map((item) => Number(sources?.[item.value])).map((value) => Number.isFinite(value) ? Math.max(0, value) : null);
  const measuredTotal = values.some((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const total = Number.isFinite(Number(sources?.totalKwh)) ? Number(sources?.totalKwh) : measuredTotal;
  const segments = sourceDefinitions.map((item, index) => {
    const suppliedPercent = Number(sources?.[item.percent]);
    const percent = Number.isFinite(suppliedPercent) ? suppliedPercent : total && values[index] !== null ? values[index]! / total * 100 : null;
    return { ...item, value: values[index], percent: percent === null ? null : Math.max(0, Math.min(100, percent)) };
  });
  const hasData = total !== null && total > 0;

  return (
    <section className="telemetry-card energy-sources-card" aria-labelledby="energy-sources-heading">
      <div className="section-heading"><div>{showPeriod ? <p className="eyebrow">{period}</p> : null}<h2 id="energy-sources-heading">Energy Sources</h2></div><strong>{formatEnergy(hasData ? total : null)}</strong></div>
      {hasData ? <div className="energy-sources-bar" role="img" aria-label={segments.map((item) => `${item.label} ${formatPercent(item.percent)}`).join(", ")}>
        {segments.map((item) => <i key={item.key} data-source={item.key} style={{ width: `${item.percent ?? 0}%` }} title={`${item.label}: ${formatEnergy(item.value)} (${formatPercent(item.percent)})`} />)}
      </div> : <p className="telemetry-empty">No source-composition data is available for this period.</p>}
      <dl className="energy-source-legend">
        {segments.map((item) => <div key={item.key}><dt><i data-source={item.key} />{item.label}</dt><dd>{formatEnergy(hasData ? item.value : null)} <small>{formatPercent(hasData ? item.percent : null)}</small></dd></div>)}
      </dl>
    </section>
  );
}

export function EneFarmActivity({ summary, compact = false, period = "Today", loading = false, showPeriod = true }: { summary: EneFarmSummary | null; compact?: boolean; period?: string; loading?: boolean; showPeriod?: boolean }) {
  const [activeIntervalIndex, setActiveIntervalIndex] = useState<number | null>(null);
  const start = new Date(summary?.start ?? "").getTime();
  const end = new Date(summary?.end ?? "").getTime();
  const validRange = Number.isFinite(start) && Number.isFinite(end) && end > start;
  let elapsedWidth = 0;
  const intervals = (summary?.sampleCount ?? 0) < 2 ? [] : (summary?.stateIntervals ?? []).map((interval) => {
    const intervalStart = Math.max(start, new Date(interval.start).getTime());
    const intervalEnd = Math.min(end, new Date(interval.end).getTime());
    const width = validRange && intervalEnd > intervalStart ? (intervalEnd - intervalStart) / (end - start) * 100 : 0;
    const left = elapsedWidth;
    elapsedWidth += width;
    return {
      ...interval,
      start: new Date(intervalStart).toISOString(),
      end: new Date(intervalEnd).toISOString(),
      durationSeconds: Math.round((intervalEnd - intervalStart) / 1000),
      width,
      left,
    };
  }).filter((interval) => interval.width > 0);
  const activeInterval = activeIntervalIndex === null ? null : intervals[activeIntervalIndex] ?? null;
  const activeCenter = activeInterval ? activeInterval.left + activeInterval.width / 2 : 50;
  return (
    <section className={`telemetry-card ene-farm-activity${compact ? " compact" : ""}`} aria-labelledby={compact ? "overview-ene-farm-heading" : "ene-farm-activity-heading"}>
      <div className="section-heading"><div>{showPeriod ? <p className="eyebrow">{period}</p> : null}<h2 id={compact ? "overview-ene-farm-heading" : "ene-farm-activity-heading"}>Ene-Farm Activity</h2></div><strong>{summary?.currentState?.replaceAll("_", " ") ?? "Unavailable"}</strong></div>
      {loading ? <p className="telemetry-empty">Loading Ene-Farm activity…</p> : intervals.length ? <><div className="ene-farm-state-visual"><div className="ene-farm-state-strip" role="group" aria-label={`Ene-Farm operating states for ${period.toLowerCase()}`}>{intervals.map((interval, index) => {
        const state = formatState(interval.state);
        const detail = `${state}. Start ${formatExactDateTime(interval.start)}. Finish ${formatExactDateTime(interval.end)}. Duration ${formatPreciseDuration(interval.durationSeconds)}.`;
        return <i key={`${interval.start}:${index}`} data-state={interval.state ?? "unknown"} style={{ width: `${interval.width}%` }} tabIndex={0} role="img" aria-label={detail} onPointerEnter={() => setActiveIntervalIndex(index)} onPointerLeave={() => setActiveIntervalIndex(null)} onFocus={() => setActiveIntervalIndex(index)} onBlur={() => setActiveIntervalIndex(null)} />;
      })}</div>{activeInterval ? <div className="ene-farm-segment-tooltip" role="tooltip" data-align={activeCenter < 18 ? "start" : activeCenter > 82 ? "end" : "center"} style={{ left: `${activeCenter}%` }}><strong>{formatState(activeInterval.state)}</strong><span>{formatExactDateTime(activeInterval.start)} → {formatExactDateTime(activeInterval.end)}</span><span>{formatPreciseDuration(activeInterval.durationSeconds)}</span></div> : null}</div>
      <div className="state-axis"><time>{formatChartTime(summary?.start ?? "")}</time><time>{formatChartTime(summary?.end ?? "")}</time></div>
      <div className="state-legend">{["generating", "starting", "stopping", "idling", "stopped"].map((state) => <span key={state}><i data-state={state} />{state === "idling" ? "Idle" : state[0].toUpperCase() + state.slice(1)}</span>)}</div></> : <p className="telemetry-empty">No Ene-Farm state history is available today.</p>}
    </section>
  );
}

export function EneFarmDetails({ summary, hotWaterLevel }: { summary: EneFarmSummary | null; hotWaterLevel?: number | null }) {
  const metrics = [
    ["Electricity generated", formatEnergy(summary?.generatedKwh)],
    ["Gas used", formatGas(summary?.gasM3)],
    ["Operating time", formatDuration(summary?.operatingSeconds)],
    ["Starts", summary?.startCount == null ? "—" : String(summary.startCount)],
    ["Time in current state", formatDuration(summary?.timeInStateSeconds)],
    ["Last stop", summary?.lastStopAt ? new Date(summary.lastStopAt).toLocaleString() : "—"],
    ["Average while generating", formatPower(summary?.averageGeneratingW ?? null)],
    ["Electrical yield", summary?.electricalYieldKwhPerM3 == null ? "—" : `${summary.electricalYieldKwhPerM3.toFixed(2)} kWh/m³`],
    ["Hot-water level", hotWaterLevel == null ? "—" : `${hotWaterLevel}/5`],
    ["Data quality", summary?.dataQuality ?? "Unavailable"],
  ];
  return <dl className="ene-farm-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

const savingViews = {
  total: { label: "Total", key: "totalOffPeakSavingYen", description: "Grid-use savings plus savings attributed to off-peak battery charging." },
  grid: { label: "Grid use", key: "gridOffPeakSavingYen", description: "Savings from household grid use shifted into the discounted period." },
  battery: { label: "Battery charging", key: "batteryOffPeakSavingYen", description: "Estimated savings created by charging the battery during discounted periods." },
} as const;

export function OffPeakSavings({ status }: { status: StatusSnapshot | null }) {
  const [view, setView] = useState<keyof typeof savingViews>("total");
  const definition = savingViews[view];
  const periods: Array<[string, SavingsSummary | undefined]> = [
    ["Today", status?.savingsPeriods?.today ?? status?.savings],
    ["Last month", status?.savingsPeriods?.lastMonth],
    ["Month to date", status?.savingsPeriods?.month],
    ["Year to date", status?.savingsPeriods?.year],
  ];
  return <section className="telemetry-card off-peak-card" aria-labelledby="off-peak-heading">
    <div className="section-heading"><div><h2 id="off-peak-heading">Estimated Off-Peak Savings</h2></div></div>
    <div className="segmented-control savings-view" aria-label="Off-peak savings view">{Object.entries(savingViews).map(([key, item]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key as keyof typeof savingViews)}>{item.label}</button>)}</div>
    <p className="savings-definition">{definition.description}</p>
    <dl className="savings-periods">{periods.map(([label, summary]) => <div key={label}><dt>{label}</dt><dd>{formatCurrency(summary?.[definition.key])}</dd></div>)}</dl>
    <p className="estimate-note">Estimates use the configured electricity rates. Provider bills remain authoritative.</p>
  </section>;
}

export function CircuitHistoryChart({ samples, circuitId, label }: { samples: EnergySample[]; circuitId: string; label: string }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const points = useMemo(() => samples.map((sample) => ({ timestamp: sample.timestamp, value: sample.circuitPowerW?.[circuitId] })).filter((point): point is { timestamp: string; value: number } => Number.isFinite(point.value) && Number.isFinite(new Date(point.timestamp).getTime())), [samples, circuitId]);
  if (!points.length) return <div className="chart-empty" role="status">No history is available for {label} in this period.</div>;
  const width = 920, height = 260, left = 60, right = 24, top = 20, bottom = 38;
  const start = new Date(points[0].timestamp).getTime(), end = new Date(points.at(-1)!.timestamp).getTime();
  const max = Math.max(100, ...points.map((point) => point.value));
  const x = (timestamp: string) => left + (new Date(timestamp).getTime() - start) / Math.max(1, end - start) * (width - left - right);
  const y = (value: number) => top + (max - Math.max(0, value)) / max * (height - top - bottom);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.timestamp).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (end - start);
    setHovered(points.reduce((best, point, index) => Math.abs(new Date(point.timestamp).getTime() - target) < Math.abs(new Date(points[best].timestamp).getTime() - target) ? index : best, 0));
  };
  const active = hovered === null ? null : points[hovered];
  return <div className="circuit-history-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} onPointerMove={pointer} onPointerLeave={() => setHovered(null)}><title id={titleId}>{label} circuit power history</title>{[0, .5, 1].map((ratio) => <g key={ratio}><line className="chart-grid-line" x1={left} x2={width - right} y1={top + ratio * (height - top - bottom)} y2={top + ratio * (height - top - bottom)} /><text className="chart-axis-label" x={left - 9} y={top + ratio * (height - top - bottom) + 4} textAnchor="end">{formatPower(max * (1 - ratio))}</text></g>)}<path className="circuit-series-line" d={path} />{active ? <><line className="chart-hover-line" x1={x(active.timestamp)} x2={x(active.timestamp)} y1={top} y2={height - bottom} /><circle cx={x(active.timestamp)} cy={y(active.value)} r="4" className="circuit-hover-point"><title>{formatChartTime(active.timestamp, true)} · {formatPower(active.value)}</title></circle></> : null}<rect className="chart-pointer-target" x={left} y={top} width={width-left-right} height={height-top-bottom} /><text className="chart-axis-label" x={left} y={height-10}>{formatChartTime(points[0].timestamp, end-start > 86_400_000)}</text><text className="chart-axis-label" x={width-right} y={height-10} textAnchor="end">{formatChartTime(points.at(-1)!.timestamp, end-start > 86_400_000)}</text></svg>{active ? <p className="circuit-hover-readout" role="status">{formatChartTime(active.timestamp, true)} · {formatPower(active.value)}</p> : null}<details className="chart-table-disclosure"><summary>View circuit chart as data table</summary><div className="table-scroll"><table><thead><tr><th>Time</th><th>Power</th></tr></thead><tbody>{points.slice(-48).map((point) => <tr key={point.timestamp}><th>{formatChartTime(point.timestamp, true)}</th><td>{formatPower(point.value)}</td></tr>)}</tbody></table></div></details></div>;
}

function formatDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const minutes = Math.max(0, Math.round(Number(seconds) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function formatPreciseDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "Duration unavailable";
  const totalSeconds = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const remainingSeconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${remainingSeconds}s`].filter(Boolean).join(" ");
}

function formatExactDateTime(timestamp?: string | null) {
  const value = new Date(timestamp ?? "");
  if (!Number.isFinite(value.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

function formatState(state?: string | null) {
  if (!state) return "Unknown";
  const normalized = state.replaceAll("_", " ");
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function formatGas(value?: number | null) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(2)} m³`;
}
