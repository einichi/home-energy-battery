import { readFile } from "node:fs/promises";
import { buildFuelCellGenerationModel } from "../dist/lib/domain/demand-forecast.js";
import { activeAwayFuelCellEvidence } from "../dist/lib/domain/away-fuel-cell.js";

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
const inferredPrimaryHost = samples.find((sample) => sample.fuelCellSourceHost)?.fuelCellSourceHost
  ?? samples.flatMap((sample) => Object.keys(sample.fuelCellSourceHosts ?? {}))[0];
const config = {
  fuelCell: { includeInAdaptiveCharging: true },
  fuelCellEnabled: true,
  fuelCellPrimaryHost: input.fuelCellPrimaryHost ?? inferredPrimaryHost ?? "offline",
  fuelCellProxyHosts: input.fuelCellProxyHosts ?? [],
};
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
let awayEvidence = null;
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
  awayEvidence = activeAwayFuelCellEvidence(config, options.awayPeriods, training, now, awayEvidence);
  const baseline = buildFuelCellGenerationModel(config, training, now, { ...options, hotWaterConditioning: false, awayRegimeInference: false });
  const conditioned = buildFuelCellGenerationModel(config, training, now, { ...options, awayRegimeInference: false });
  const awayModel = buildFuelCellGenerationModel(config, training, now, { ...options, awayFuelCell: awayEvidence });
  if (!baseline.ready && !awayModel.ready) continue;
  for (let lead = 0; lead < 48; lead += 1) {
    const target = byStart.get(origin + lead * halfHourMs);
    if (!target) continue;
    const date = new Date(target.start);
    const base = baseline.forecastAt(date);
    const water = conditioned.forecastAt(date);
    const away = awayModel.forecastAt(date);
    const period = options.awayPeriods.find((entry) => target.start >= Date.parse(entry.from) && target.end <= Date.parse(entry.until));
    rows.push({
      origin: now.toISOString(),
      targetStart: target.start,
      periodId: period ? period.id ?? period.from : null,
      tripDay: period ? Math.floor((target.start - Date.parse(period.from)) / dayMs) + 1 : null,
      awayRegime: away.awayRegime,
      awayModelReady: awayModel.ready && away.sampleCount >= 4,
      baselineReady: baseline.ready,
      awayMedianW: away.medianW,
      baselineMedianW: water.medianW,
      awayMaeW: Math.abs(target.watts - away.medianW),
      awayP20LossW: pinball(target.watts, away.p20W, 0.2),
      awayP80LossW: pinball(target.watts, away.p80W, 0.8),
      awayP80Covered: target.watts <= away.p80W,
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
const hotWaterRows = rows.filter((row) => row.baselineReady);
const midpoint = hotWaterRows.length ? hotWaterRows[Math.floor(hotWaterRows.length / 2)].origin : null;
const awayRows = rows.filter((row) => row.periodId !== null && row.awayModelReady);
const summarizeAway = (selection) => {
  const mean = (key) => selection.length ? selection.reduce((sum, row) => sum + Number(row[key]), 0) / selection.length : null;
  return {
    intervals: selection.length,
    distinctPeriods: new Set(selection.map((row) => row.periodId)).size,
    baselineMaeW: mean("conditionedMaeW"), awayMaeW: mean("awayMaeW"),
    baselineP20LossW: mean("conditionedP20LossW"), awayP20LossW: mean("awayP20LossW"),
    baselineP80LossW: mean("conditionedP80LossW"), awayP80LossW: mean("awayP80LossW"),
    baselineP80Coverage: mean("conditionedP80Covered"), awayP80Coverage: mean("awayP80Covered"),
  };
};
// One prediction per target, issued at least 30 minutes beforehand. Do not add
// overlapping forecasts together when reporting daily generation energy.
const canonical = new Map();
for (const row of awayRows) {
  if (Date.parse(row.origin) <= row.targetStart - halfHourMs) canonical.set(row.targetStart, row);
}
const dailyEnergy = new Map();
for (const row of canonical.values()) {
  const key = `${row.periodId}:day-${row.tripDay}`;
  const total = dailyEnergy.get(key) ?? { periodId: row.periodId, tripDay: row.tripDay, measuredIntervals: 0, actualKwh: 0, baselineKwh: 0, awayKwh: 0 };
  total.measuredIntervals += 1;
  total.actualKwh += row.actualW * 0.5 / 1000;
  total.baselineKwh += row.baselineMedianW * 0.5 / 1000;
  total.awayKwh += row.awayMedianW * 0.5 / 1000;
  dailyEnergy.set(key, total);
}
console.log(JSON.stringify({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  samples: samples.length,
  hotWaterSamples: samples.filter((sample) => Number.isInteger(sample.fuelCellHotWaterLevel)
    && sample.fuelCellHotWaterLevel >= 0 && sample.fuelCellHotWaterLevel <= 5).length,
  first: samples[0]?.timestamp,
  last: samples.at(-1)?.timestamp,
  note: "Overlapping forecasts are correlated; interval counts are not independent trials. Missing weather/away data uses the same fallback in both models.",
  metrics: Object.fromEntries(periods.map(([name, predicate]) => [name, summarize(hotWaterRows.filter(predicate))])),
  chronologicalHalves: {
    midpoint,
    first: summarize(hotWaterRows.filter((row) => row.origin < midpoint)),
    second: summarize(hotWaterRows.filter((row) => row.origin >= midpoint)),
    firstConditioned: summarize(hotWaterRows.filter((row) => row.origin < midpoint && row.changed)),
    secondConditioned: summarize(hotWaterRows.filter((row) => row.origin >= midpoint && row.changed)),
  },
  awayRegimeComparison: {
    note: "Forecast-only replay; period counts are the independent comparison unit. Energy totals cover only measured canonical intervals, not necessarily complete days. Charging outcomes require planner backtests.",
    all: summarizeAway(awayRows),
    byPeriod: Object.fromEntries([...new Set(awayRows.map((row) => row.periodId))].map((id) => [id, summarizeAway(awayRows.filter((row) => row.periodId === id))])),
    byTripDay: Object.fromEntries([...new Set(awayRows.map((row) => row.tripDay))].map((day) => [day, summarizeAway(awayRows.filter((row) => row.tripDay === day))])),
    byRegime: Object.fromEntries([...new Set(awayRows.map((row) => row.awayRegime))].map((regime) => [regime, summarizeAway(awayRows.filter((row) => row.awayRegime === regime))])),
    canonicalEnergy: [...dailyEnergy.values()].map((entry) => ({ ...entry,
      baselineErrorKwh: entry.baselineKwh - entry.actualKwh,
      awayErrorKwh: entry.awayKwh - entry.actualKwh,
    })),
  },
}, null, 2));
