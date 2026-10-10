import { readFile } from "node:fs/promises";
import { buildFuelCellGenerationModel } from "../dist/lib/domain/demand-forecast.js";

// Offline, rolling-origin comparison. Input is an /api/history interval export
// (or { samples, awayPeriods, temperatureByDay: { "YYYY-MM-DD": degreesC } }).
// No HTTP/device calls or changes to charging configuration are made here.
const file = process.argv[2];
if (!file) throw new Error("Usage: TZ=Asia/Tokyo node scripts/backtest-fuel-cell.mjs history.json");
const input = JSON.parse(await readFile(file, "utf8"));
const inputSamples = Array.isArray(input) ? input : input.samples;
if (!Array.isArray(inputSamples)) throw new Error("Input must be an array of samples or an object containing samples");
const samples = inputSamples
  .filter((sample) => Number.isFinite(new Date(sample.timestamp).getTime()))
  .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
const options = {
  awayPeriods: input.awayPeriods ?? [],
  temperatureByDay: new Map(Object.entries(input.temperatureByDay ?? {})),
};
const config = { fuelCell: { includeInAdaptiveCharging: true } };
const halfHourMs = 30 * 60_000;
const dayMs = 24 * 60 * 60_000;
const targets = samples.flatMap((sample) => {
  const start = new Date(sample.rollupStart ?? "").getTime();
  const end = new Date(sample.rollupEnd ?? "").getTime();
  const watts = sample.intervalAveragePowerW?.fuelCellPowerW ?? sample.fuelCellPowerW;
  const coverage = sample.powerCoverageSeconds?.fuelCellPowerW;
  return Number.isFinite(start) && end - start === halfHourMs
    && typeof watts === "number" && Number.isFinite(watts)
    && typeof coverage === "number" && coverage >= 0.8 * halfHourMs / 1000
    ? [{ start, end, watts, sample }]
    : [];
});
if (!targets.length) throw new Error("Input needs half-hour rollups with fuelCellPowerW and powerCoverageSeconds.fuelCellPowerW");
const byStart = new Map(targets.map((target) => [target.start, target]));
const pinball = (actual, predicted, quantile) => {
  const error = actual - predicted;
  return error >= 0 ? quantile * error : (quantile - 1) * error;
};
const rows = [];
const seenOrigins = new Set();
for (const previous of targets) {
  const origin = previous.end;
  if (seenOrigins.has(origin)) continue;
  seenOrigins.add(origin);
  const now = new Date(origin);
  // Only observations already available at the origin, within the live
  // model's 90-day history window. No target interval enters the training set.
  const training = samples.filter((sample) => {
    const at = new Date(sample.timestamp).getTime();
    const end = new Date(sample.rollupEnd ?? sample.timestamp).getTime();
    return at <= origin && end <= origin && at >= origin - 90 * dayMs;
  });
  const baseline = buildFuelCellGenerationModel(config, training, now, { ...options, hotWaterConditioning: false });
  if (!baseline.ready) continue;
  const conditioned = buildFuelCellGenerationModel(config, training, now, options);
  for (let lead = 0; lead < 48; lead += 1) {
    const target = byStart.get(origin + lead * halfHourMs);
    if (!target) continue;
    const date = new Date(target.start);
    const base = baseline.forecastAt(date);
    const water = conditioned.forecastAt(date);
    rows.push({
      origin: now.toISOString(),
      hours: (lead + 1) / 2,
      changed: water.hotWaterConditioned,
      crossMidnight: date.toDateString() !== now.toDateString(),
      actualW: target.watts,
      baselineMaeW: Math.abs(target.watts - base.medianW),
      conditionedMaeW: Math.abs(target.watts - water.medianW),
      baselineP20LossW: pinball(target.watts, base.p20W, 0.2),
      conditionedP20LossW: pinball(target.watts, water.p20W, 0.2),
      baselineP80LossW: pinball(target.watts, base.p80W, 0.8),
      conditionedP80LossW: pinball(target.watts, water.p80W, 0.8),
      baselineP80Covered: target.watts <= base.p80W,
      conditionedP80Covered: target.watts <= water.p80W,
    });
  }
}
const summarize = (selection) => {
  const mean = (key) => selection.length
    ? selection.reduce((sum, row) => sum + Number(row[key]), 0) / selection.length
    : null;
  const baselineP80LossW = mean("baselineP80LossW");
  const conditionedP80LossW = mean("conditionedP80LossW");
  const baselineMaeW = mean("baselineMaeW");
  const conditionedMaeW = mean("conditionedMaeW");
  return {
    intervals: selection.length,
    originDays: new Set(selection.map((row) => row.origin.slice(0, 10))).size,
    conditionedIntervals: selection.filter((row) => row.changed).length,
    baselineMaeW, conditionedMaeW,
    medianMaeImprovementPercent: baselineMaeW ? 100 * (1 - conditionedMaeW / baselineMaeW) : null,
    baselineP20LossW: mean("baselineP20LossW"),
    conditionedP20LossW: mean("conditionedP20LossW"),
    baselineP80LossW, conditionedP80LossW,
    p80LossImprovementPercent: baselineP80LossW ? 100 * (1 - conditionedP80LossW / baselineP80LossW) : null,
    baselineP80Coverage: mean("baselineP80Covered"),
    conditionedP80Coverage: mean("conditionedP80Covered"),
  };
};
const periods = [
  ["all", () => true],
  ["0–6h", (row) => row.hours <= 6],
  ["0–2h", (row) => row.hours <= 2],
  ["2–6h", (row) => row.hours > 2 && row.hours <= 6],
  ["6–12h", (row) => row.hours > 6 && row.hours <= 12],
  ["12–24h", (row) => row.hours > 12],
  ["conditioned only", (row) => row.changed],
  ["cross-midnight conditioned", (row) => row.changed && row.crossMidnight],
];
const midpoint = rows.length ? rows[Math.floor(rows.length / 2)].origin : null;
console.log(JSON.stringify({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  samples: samples.length,
  hotWaterSamples: samples.filter((sample) => Number.isInteger(sample.fuelCellHotWaterLevel)
    && sample.fuelCellHotWaterLevel >= 0 && sample.fuelCellHotWaterLevel <= 5).length,
  first: samples[0]?.timestamp,
  last: samples.at(-1)?.timestamp,
  note: "Overlapping forecasts are correlated; interval counts are not independent trials. Missing weather/away data uses the same fallback in both models.",
  metrics: Object.fromEntries(periods.map(([name, predicate]) => [name, summarize(rows.filter(predicate))])),
  chronologicalHalves: {
    midpoint,
    first: summarize(rows.filter((row) => row.origin < midpoint)),
    second: summarize(rows.filter((row) => row.origin >= midpoint)),
    firstConditioned: summarize(rows.filter((row) => row.origin < midpoint && row.changed)),
    secondConditioned: summarize(rows.filter((row) => row.origin >= midpoint && row.changed)),
  },
}, null, 2));
