import assert from "node:assert/strict";
import test from "node:test";

import { buildFuelCellGenerationModel } from "../lib/domain/demand-forecast.js";

const config = {};

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

function shifted(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function sample(at: Date, values: Record<string, unknown> = {}) {
  return { timestamp: at.toISOString(), ...values };
}

function fixture(options: {
  now?: Date;
  leadHours?: number;
  matchingDays?: number;
  candidateDays?: number;
  duplicateMatchingObservations?: number;
  includeCurrentLevel?: boolean;
  currentLevel?: unknown;
  matchingLevel?: unknown;
  extraSamples?: ReturnType<typeof sample>[];
} = {}) {
  const now = options.now ?? localDate(2026, 6, 15, 12, 10);
  const target = new Date(now);
  target.setHours(target.getHours() + (options.leadHours ?? 2));
  const matchingDays = options.matchingDays ?? 4;
  const candidateDays = options.candidateDays ?? 8;
  const currentLevel = options.currentLevel ?? 2;
  const matchingLevel = options.matchingLevel ?? currentLevel;
  const samples: ReturnType<typeof sample>[] = [];

  for (let index = 0; index < candidateDays; index += 1) {
    const historicalTarget = shifted(target, -7 * (index + 1));
    // Each day has at least 16 distinct buckets and the target bucket,
    // independent of the machine's timezone.
    const targetBucket = Math.floor(target.getHours() * 2 + target.getMinutes() / 30);
    const buckets = new Set([...Array.from({ length: 16 }, (_, bucket) => bucket), targetBucket]);
    for (const bucket of buckets) {
      const at = new Date(historicalTarget);
      at.setHours(Math.floor(bucket / 2), bucket % 2 ? 30 : 0, 0, 0);
      samples.push(sample(at, {
        fuelCellPowerW: index < matchingDays ? 1_000 : 100,
      }));
    }
    const dayOffset = Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
      - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
    const historicalOrigin = shifted(historicalTarget, -dayOffset);
    historicalOrigin.setHours(now.getHours(), now.getMinutes() - 10, 0, 0);
    const level = index < matchingDays ? matchingLevel : (matchingLevel === 1 ? 2 : 1);
    samples.push(sample(historicalOrigin, { fuelCellHotWaterLevel: level }));
    if (index < matchingDays) {
      for (let duplicate = 0; duplicate < (options.duplicateMatchingObservations ?? 0); duplicate += 1) {
        samples.push(sample(historicalOrigin, { fuelCellHotWaterLevel: level }));
      }
    }
  }

  if (options.includeCurrentLevel !== false) {
    const currentObservation = new Date(now);
    currentObservation.setMinutes(currentObservation.getMinutes() - 10);
    samples.push(sample(currentObservation, { fuelCellHotWaterLevel: currentLevel }));
  }
  samples.push(...(options.extraSamples ?? []));
  return { now, target, samples };
}

test("fresh hot-water level conditions generation using at least four distinct historical days", () => {
  const data = fixture();
  const conditioned = buildFuelCellGenerationModel(config, data.samples, data.now).forecastAt(data.target);
  const baseline = buildFuelCellGenerationModel(config, data.samples, data.now, {
    hotWaterConditioning: false,
  }).forecastAt(data.target);

  assert.equal(conditioned.hotWaterConditioned, true);
  assert.equal(conditioned.medianW, 1_000);
  assert.ok(conditioned.medianW > baseline.medianW);
  assert.equal(baseline.hotWaterConditioned, false);
});

test("conditioning falls back unless four distinct candidate days match", () => {
  const fewerMatchingDays = fixture({ matchingDays: 3, duplicateMatchingObservations: 20 });
  const model = buildFuelCellGenerationModel(config, fewerMatchingDays.samples, fewerMatchingDays.now);
  const result = model.forecastAt(fewerMatchingDays.target);
  assert.equal(result.hotWaterConditioned, false);
  assert.equal(result.sampleCount, 8);

  const fewerCandidates = fixture({ candidateDays: 3 });
  assert.equal(
    buildFuelCellGenerationModel(config, fewerCandidates.samples, fewerCandidates.now)
      .forecastAt(fewerCandidates.target).hotWaterConditioned,
    false,
  );
});

test("missing, null, invalid, out-of-range, and stale current levels do not condition", () => {
  const cases: Array<{ label: string; level?: unknown; ageMinutes?: number; omit?: boolean }> = [
    { label: "missing", omit: true },
    { label: "null", level: null },
    { label: "non-integer", level: 2.5 },
    { label: "invalid", level: Number.NaN },
    { label: "out of range", level: 6 },
    { label: "stale", level: 2, ageMinutes: 46 },
  ];
  for (const entry of cases) {
    const data = fixture({ includeCurrentLevel: false });
    if (!entry.omit) {
      const observation = new Date(data.now);
      observation.setMinutes(observation.getMinutes() - (entry.ageMinutes ?? 10));
      data.samples.push(sample(observation, { fuelCellHotWaterLevel: entry.level }));
    }
    const result = buildFuelCellGenerationModel(config, data.samples, data.now).forecastAt(data.target);
    assert.equal(result.hotWaterConditioned, false, entry.label);
  }
});

test("future levels are ignored, unsorted inputs are safe, and samples without a level preserve freshness", () => {
  const data = fixture();
  data.samples.push(sample(new Date(data.now.getTime() + 60_000), { fuelCellHotWaterLevel: 5 }));
  data.samples.push(sample(data.now, { fuelCellPowerW: 0 })); // no hot-water property
  data.samples.reverse();

  const model = buildFuelCellGenerationModel(config, data.samples, data.now);
  assert.equal(model.recentHotWaterLevel, 2);
  assert.equal(model.forecastAt(data.target).hotWaterConditioned, true);
});

test("cross-midnight conditioning looks up the historical origin, not the future target level", () => {
  const now = localDate(2026, 6, 15, 23, 10);
  const data = fixture({ now, leadHours: 2 });
  // Put a different hot-water level at each historical target (the analog of
  // the future target time); the previous-date origin still matches level 2.
  for (let index = 0; index < 4; index += 1) {
    const historicalTarget = shifted(data.target, -7 * (index + 1));
    historicalTarget.setHours(data.target.getHours(), data.target.getMinutes() - 10, 0, 0);
    data.samples.push(sample(historicalTarget, { fuelCellHotWaterLevel: 1 }));
  }
  const model = buildFuelCellGenerationModel(config, data.samples, data.now);
  const conditioned = model.forecastAt(data.target);
  assert.equal(conditioned.hotWaterConditioned, true);
  assert.equal(conditioned.medianW, 1_000);
});

test("empty and full tank levels are valid, but horizons beyond six hours use the baseline", () => {
  for (const level of [0, 5]) {
    const data = fixture({ currentLevel: level });
    const model = buildFuelCellGenerationModel(config, data.samples, data.now);
    assert.equal(model.recentHotWaterLevel, level);
    assert.equal(model.forecastAt(data.target).hotWaterConditioned, true);
  }
  const data = fixture({ leadHours: 7 });
  const forecast = buildFuelCellGenerationModel(config, data.samples, data.now).forecastAt(data.target);
  const baseline = buildFuelCellGenerationModel(config, data.samples, data.now, {
    hotWaterConditioning: false,
  }).forecastAt(data.target);
  assert.deepEqual(forecast, baseline);
});

test("future power and tank readings cannot affect readiness, recent state, or predictions", () => {
  const data = fixture();
  const original = buildFuelCellGenerationModel(config, data.samples, data.now);
  data.samples.push(sample(new Date(data.now.getTime() + 60_000), {
    fuelCellPowerW: 99_999,
    fuelCellGenerationState: "generating",
    fuelCellHotWaterLevel: 5,
  }));
  const model = buildFuelCellGenerationModel(config, data.samples.reverse(), data.now);
  assert.equal(model.ready, original.ready);
  assert.equal(model.recentState, original.recentState);
  assert.deepEqual(model.forecastAt(data.target), original.forecastAt(data.target));
});

test("an explicit unavailable reading disables conditioning rather than reusing an earlier valid level", () => {
  const data = fixture();
  data.samples.push(sample(data.now, { fuelCellHotWaterLevel: null }));
  const model = buildFuelCellGenerationModel(config, data.samples, data.now);
  assert.equal(model.recentHotWaterLevel, null);
  assert.equal(model.forecastAt(data.target).hotWaterConditioned, false);
});
