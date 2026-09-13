import { useId, useState } from "react";
import type { PointerEvent } from "react";
import type { EnergySample } from "../api/contracts";
import { formatChartTime, formatPower } from "../core/format";
import { energySeries } from "../core/energySeries";
import type { EnergySeriesKey, SeriesDefinition } from "../core/energySeries";

const chart = { width: 920, height: 320, left: 62, right: 50, top: 22, bottom: 42 };

export type TimelineOverlay = {
  start: string;
  end?: string;
  label: string;
  tone: "charge" | "discharge" | "schedule";
};

function downsample(samples: EnergySample[], limit = 360): EnergySample[] {
  if (samples.length <= limit) return samples;
  const output: EnergySample[] = [];
  const stride = (samples.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) output.push(samples[Math.round(index * stride)]);
  return output;
}

function pathFor(
  samples: EnergySample[],
  definition: SeriesDefinition,
  x: (timestamp: string) => number,
  y: (value: number) => number,
): string {
  let drawing = false;
  return samples.map((sample) => {
    const value = definition.value(sample);
    if (value === null || !Number.isFinite(new Date(sample.timestamp).getTime())) {
      drawing = false;
      return "";
    }
    const command = drawing ? "L" : "M";
    drawing = true;
    return `${command}${x(sample.timestamp).toFixed(1)},${y(value).toFixed(1)}`;
  }).join(" ");
}

export function CombinedEnergyChart({ samples, selected, label = "Energy history", overlays = [], reservePercent = null, showSeriesLegend = true }: {
  samples: EnergySample[];
  selected: EnergySeriesKey[];
  label?: string;
  overlays?: TimelineOverlay[];
  reservePercent?: number | null;
  showSeriesLegend?: boolean;
}) {
  const titleId = useId();
  const [hoveredTimestamp, setHoveredTimestamp] = useState<string | null>(null);
  const validSamples = downsample(samples.filter((sample) => Number.isFinite(new Date(sample.timestamp).getTime())));
  const timestamps = validSamples.map((sample) => new Date(sample.timestamp).getTime());
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const definitions = selected.map((key) => ({ key, ...energySeries[key] }));
  const hasPowerSeries = definitions.some((definition) => definition.axis === "power");
  const hasPercentSeries = definitions.some((definition) => definition.axis === "percent");
  const hasSelectedValues = definitions.some((definition) => validSamples.some((sample) => definition.value(sample) !== null));
  const powerValues = definitions
    .filter((definition) => definition.axis === "power")
    .flatMap((definition) => validSamples.map(definition.value))
    .filter((value): value is number => value !== null);
  const powerMin = Math.min(0, ...powerValues);
  const powerMax = Math.max(100, ...powerValues);
  const powerPadding = Math.max(100, (powerMax - powerMin) * 0.08);
  const domainMin = powerMin < 0 ? powerMin - powerPadding : 0;
  const domainMax = powerMax + powerPadding;
  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.height - chart.top - chart.bottom;
  const x = (timestamp: string) => chart.left + ((new Date(timestamp).getTime() - start) / Math.max(1, end - start)) * plotWidth;
  const powerY = (value: number) => chart.top + ((domainMax - value) / Math.max(1, domainMax - domainMin)) * plotHeight;
  const percentY = (value: number) => chart.top + ((100 - value) / 100) * plotHeight;
  const tableSamples = validSamples.length > 24
    ? downsample(validSamples, 24)
    : validSamples;
  const hoveredSample = hoveredTimestamp === null
    ? null
    : validSamples.find((sample) => sample.timestamp === hoveredTimestamp) ?? null;
  const hoveredX = hoveredSample ? x(hoveredSample.timestamp) : null;
  const tooltipWidth = 224;
  const tooltipHeight = 31 + definitions.length * 18;
  const tooltipX = hoveredX === null
    ? chart.left
    : hoveredX > chart.width / 2 ? hoveredX - tooltipWidth - 12 : hoveredX + 12;

  const showNearestSample = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
      : 0.5;
    const viewX = ratio * chart.width;
    const plotRatio = Math.max(0, Math.min(1, (viewX - chart.left) / plotWidth));
    const targetTime = start + plotRatio * (end - start);
    const nearest = validSamples.reduce((best, sample) => (
      Math.abs(new Date(sample.timestamp).getTime() - targetTime) < Math.abs(new Date(best.timestamp).getTime() - targetTime)
        ? sample
        : best
    ));
    setHoveredTimestamp(nearest.timestamp);
  };

  if (!validSamples.length || !hasSelectedValues) {
    return <div className="chart-empty" role="status">No readings are available for this period yet.</div>;
  }

  return (
    <div className="combined-chart">
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-labelledby={titleId} onPointerMove={showNearestSample} onPointerLeave={() => setHoveredTimestamp(null)}>
        <title id={titleId}>{label}</title>
        {overlays.map((overlay, index) => {
          const overlayStart = Math.max(start, new Date(overlay.start).getTime());
          const overlayEnd = Math.min(end, new Date(overlay.end ?? overlay.start).getTime());
          if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd) || overlayEnd < start || overlayStart > end) return null;
          const left = chart.left + ((overlayStart - start) / Math.max(1, end - start)) * plotWidth;
          const right = chart.left + ((overlayEnd - start) / Math.max(1, end - start)) * plotWidth;
          return <rect key={`${overlay.label}:${overlay.start}:${index}`} className="chart-time-overlay" data-tone={overlay.tone} x={left} y={chart.top} width={Math.max(3, right - left)} height={plotHeight}><title>{overlay.label}</title></rect>;
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = chart.top + ratio * plotHeight;
          const value = domainMax - ratio * (domainMax - domainMin);
          return (
            <g key={ratio}>
              <line className="chart-grid-line" x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} />
              <text className="chart-axis-label" x={chart.left - 10} y={y + 4} textAnchor="end">
                {hasPowerSeries ? formatPower(value) : `${Math.round((1 - ratio) * 100)}%`}
              </text>
            </g>
          );
        })}
        {domainMin < 0 ? <line className="chart-zero-line" x1={chart.left} x2={chart.width - chart.right} y1={powerY(0)} y2={powerY(0)} /> : null}
        {hasPercentSeries && reservePercent !== null ? (
          <g>
            <line className="chart-reserve-line" x1={chart.left} x2={chart.width - chart.right} y1={percentY(reservePercent)} y2={percentY(reservePercent)} />
            <text className="chart-axis-label chart-reserve-label" x={chart.width - chart.right - 5} y={percentY(reservePercent) - 5} textAnchor="end">Reserve {reservePercent}%</text>
          </g>
        ) : null}
        {hasPowerSeries && hasPercentSeries ? (
          <>
            <text className="chart-axis-label" x={chart.width - chart.right + 10} y={chart.top + 4}>100%</text>
            <text className="chart-axis-label" x={chart.width - chart.right + 10} y={chart.top + plotHeight}>0%</text>
          </>
        ) : null}
        {definitions.map((definition) => (
          <path
            key={definition.key}
            className="chart-series-line"
            d={pathFor(validSamples, definition, x, definition.axis === "power" ? powerY : percentY)}
            stroke={definition.color}
          />
        ))}
        {validSamples.length === 1 ? definitions.map((definition) => {
          const value = definition.value(validSamples[0]);
          return value === null ? null : (
            <circle key={definition.key} cx={chart.left + plotWidth / 2} cy={(definition.axis === "power" ? powerY : percentY)(value)} r="4" fill={definition.color} />
          );
        }) : null}
        {hoveredSample && hoveredX !== null ? (
          <g className="chart-tooltip" aria-hidden="true">
            <line className="chart-hover-line" x1={hoveredX} x2={hoveredX} y1={chart.top} y2={chart.top + plotHeight} />
            {definitions.map((definition) => {
              const value = definition.value(hoveredSample);
              return value === null ? null : <circle key={definition.key} cx={hoveredX} cy={(definition.axis === "power" ? powerY : percentY)(value)} r="4" fill={definition.color} />;
            })}
            <rect className="chart-tooltip-surface" x={tooltipX} y={chart.top + 6} width={tooltipWidth} height={tooltipHeight} rx="8" />
            <text className="chart-tooltip-time" x={tooltipX + 12} y={chart.top + 25}>{formatChartTime(hoveredSample.timestamp, true)}</text>
            {definitions.map((definition, index) => {
              const value = definition.value(hoveredSample);
              return (
                <g key={definition.key}>
                  <circle cx={tooltipX + 14} cy={chart.top + 44 + index * 18} r="3" fill={definition.color} />
                  <text className="chart-tooltip-value" x={tooltipX + 23} y={chart.top + 48 + index * 18}>{definition.label}: {value === null ? "—" : definition.display(value)}</text>
                </g>
              );
            })}
          </g>
        ) : null}
        <rect className="chart-pointer-target" x={chart.left} y={chart.top} width={plotWidth} height={plotHeight} />
        <text className="chart-axis-label" x={chart.left} y={chart.height - 12}>{formatChartTime(validSamples[0].timestamp, end - start > 86_400_000)}</text>
        <text className="chart-axis-label" x={chart.width - chart.right} y={chart.height - 12} textAnchor="end">{formatChartTime(validSamples.at(-1)?.timestamp ?? "", end - start > 86_400_000)}</text>
      </svg>
      {showSeriesLegend ? (
        <div className="chart-series-legend" aria-label="Chart series">
          {definitions.map((definition) => <span key={definition.key}><i style={{ background: definition.color }} aria-hidden="true" />{definition.label}</span>)}
        </div>
      ) : null}
      {overlays.length ? <div className="chart-overlay-legend" aria-label="Timeline overlays"><span data-tone="charge">Charge window</span><span data-tone="discharge">Discharge window</span><span data-tone="schedule">Scheduled command</span></div> : null}
      {hoveredSample ? <div className="chart-hover-summary" role="status" aria-label="Chart reading details">{formatChartTime(hoveredSample.timestamp, true)} · {definitions.map((definition) => { const value = definition.value(hoveredSample); return `${definition.label}: ${value === null ? "unavailable" : definition.display(value)}`; }).join(" · ")}</div> : null}
      <details className="chart-table-disclosure">
        <summary>View chart as data table</summary>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Time</th>{definitions.map((definition) => <th key={definition.key}>{definition.label}</th>)}</tr></thead>
            <tbody>
              {tableSamples.map((sample) => (
                <tr key={sample.timestamp}>
                  <th>{formatChartTime(sample.timestamp, true)}</th>
                  {definitions.map((definition) => {
                    const value = definition.value(sample);
                    return <td key={definition.key}>{value === null ? "—" : definition.display(value)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
