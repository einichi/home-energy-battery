import assert from "node:assert/strict";

import {
  decimateTimeSeries,
  nextHalfHourBoundary,
  pruneTrendPoints,
  trendSamplePoints,
} from "../public/chart-utils.js";

const points = Array.from({ length: 100 }, (_, index) => ({
  time: index * 1000,
  value: index === 42 ? 9000 : 100 + (index % 7),
}));
const decimated = decimateTimeSeries(points, 10, 3000);
assert.ok(decimated.length <= 40, "decimation keeps bounded endpoints and extrema per pixel");
assert.ok(decimated.some((point) => point.value === 9000), "decimation preserves spikes");

const withGap = [
  { time: 0, value: 100 },
  { time: 1000, value: 200 },
  { time: 10_000, value: 300 },
  { time: 11_000, value: 400 },
  ...Array.from({ length: 30 }, (_, index) => ({
    time: 12_000 + index * 1000,
    value: 500 + index,
  })),
];
const gapResult = decimateTimeSeries(withGap, 5, 3000);
assert.ok(gapResult.some((point) => point.value === null), "time gaps remain disconnected");

const explicitMissing = Array.from({ length: 30 }, (_, index) => ({
  time: index * 1000,
  value: index === 15 ? null : index,
}));
const missingResult = decimateTimeSeries(explicitMissing, 5, 3000);
assert.ok(missingResult.some((point) => point.value === null), "missing readings remain disconnected");

const small = points.slice(0, 10);
assert.equal(decimateTimeSeries(small, 10), small, "small data sets are not copied or reduced");

const rangeStart = Date.parse("2026-07-15T05:05:00.000Z");
const rangeEnd = Date.parse("2026-07-15T05:35:00.000Z");
assert.deepEqual(
  trendSamplePoints(
    {
      timestamp: "2026-07-15T05:29:58.000Z",
      rollupStart: "2026-07-15T05:00:00.000Z",
      rollupEnd: "2026-07-15T05:30:00.000Z",
    },
    rangeStart,
    rangeEnd,
  ),
  [
    { time: rangeStart, continuousFromPrevious: false },
    { time: Date.parse("2026-07-15T05:30:00.000Z"), continuousFromPrevious: true },
  ],
  "rollups become clipped coverage segments",
);
assert.deepEqual(
  trendSamplePoints({ timestamp: "2026-07-15T05:31:00.000Z" }, rangeStart, rangeEnd),
  [{ time: Date.parse("2026-07-15T05:31:00.000Z"), continuousFromPrevious: false }],
  "raw samples remain exact points",
);

const rollingSegment = [
  { time: 0, value: 400, continuousFromPrevious: false },
  { time: 100, value: 400, continuousFromPrevious: true },
  { time: 110, value: 500, continuousFromPrevious: false },
];
assert.deepEqual(
  pruneTrendPoints(rollingSegment, 50),
  [
    { time: 50, value: 400, continuousFromPrevious: false },
    { time: 100, value: 400, continuousFromPrevious: true },
    { time: 110, value: 500, continuousFromPrevious: false },
  ],
  "pruning clips a rollup segment at the moving window boundary",
);
assert.deepEqual(
  pruneTrendPoints(rollingSegment, 105),
  [{ time: 110, value: 500, continuousFromPrevious: false }],
  "pruning drops a rollup after its coverage ends",
);
assert.deepEqual(
  pruneTrendPoints(rollingSegment, 0),
  rollingSegment,
  "pruning keeps an unchanged in-range series",
);

assert.equal(
  nextHalfHourBoundary(new Date(2026, 6, 15, 16, 22, 45)).getTime(),
  new Date(2026, 6, 15, 16, 30).getTime(),
  "Now rounds up to the next half-hour point",
);
assert.equal(
  nextHalfHourBoundary(new Date(2026, 6, 15, 16, 31)).getTime(),
  new Date(2026, 6, 15, 17, 0).getTime(),
  "Now advances to the following hour after a half-hour point",
);
assert.equal(
  nextHalfHourBoundary(new Date(2026, 6, 15, 16, 30)).getTime(),
  new Date(2026, 6, 15, 17, 0).getTime(),
  "Now always selects a future boundary",
);

console.log("chart utility tests passed");
