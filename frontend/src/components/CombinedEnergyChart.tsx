import { useId } from "react";
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

export function CombinedEnergyChart({ samples, selected, label = "Energy history", overlays = [], reservePercent = null }: {
  samples: EnergySample[];
  selected: EnergySeriesKey[];
  label?: string;
  overlays?: TimelineOverlay[];
  reservePercent?: number | null;
}) {
  const titleId = useId();
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

  if (!validSamples.length || !hasSelectedValues) {
    return <div className="chart-empty" role="status">No readings are available for this period yet.</div>;
  }

  return (
    <div className="combined-chart">
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-labelledby={titleId}>
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
        <text className="chart-axis-label" x={chart.left} y={chart.height - 12}>{formatChartTime(validSamples[0].timestamp, end - start > 86_400_000)}</text>
        <text className="chart-axis-label" x={chart.width - chart.right} y={chart.height - 12} textAnchor="end">{formatChartTime(validSamples.at(-1)?.timestamp ?? "", end - start > 86_400_000)}</text>
      </svg>
      {overlays.length ? <div className="chart-overlay-legend" aria-label="Timeline overlays"><span data-tone="charge">Charge window</span><span data-tone="discharge">Discharge window</span><span data-tone="schedule">Scheduled command</span></div> : null}
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
