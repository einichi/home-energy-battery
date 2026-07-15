export function decimateTimeSeries(points, pixelColumns, gapThresholdMs = Infinity) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const columns = Math.max(1, Math.floor(Number(pixelColumns) || 1));
  if (points.length <= columns * 2) return points;

  const timedPoints = points.filter((point) => Number.isFinite(point?.time));
  if (timedPoints.length <= columns * 2) return timedPoints;

  const start = timedPoints[0].time;
  const end = timedPoints[timedPoints.length - 1].time;
  const duration = Math.max(1, end - start);
  const output = [];
  let bucket = null;
  let previousValid = null;

  const flushBucket = () => {
    if (!bucket) return;
    const candidates = [bucket.first, bucket.min, bucket.max, bucket.last];
    const retained = candidates.filter(
      (point, index) => candidates.findIndex((candidate) => candidate === point) === index,
    );
    retained.sort((left, right) => left.time - right.time);
    output.push(...retained);
    bucket = null;
  };

  const addGap = (time) => {
    flushBucket();
    if (output.at(-1)?.value !== null) output.push({ time, value: null });
  };

  for (const point of timedPoints) {
    if (!Number.isFinite(point.value)) {
      addGap(point.time);
      previousValid = null;
      continue;
    }

    if (
      previousValid &&
      !point.continuousFromPrevious &&
      Number.isFinite(gapThresholdMs) &&
      point.time - previousValid.time > gapThresholdMs
    ) {
      addGap(previousValid.time + (point.time - previousValid.time) / 2);
    }

    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((point.time - start) / duration) * columns)),
    );
    if (!bucket || bucket.column !== column) {
      flushBucket();
      bucket = { column, first: point, min: point, max: point, last: point };
    } else {
      if (point.value < bucket.min.value) bucket.min = point;
      if (point.value > bucket.max.value) bucket.max = point;
      bucket.last = point;
    }
    previousValid = point;
  }

  flushBucket();
  return output;
}

export function trendSamplePoints(sample, rangeStartMs = -Infinity, rangeEndMs = Infinity) {
  const timestamp = new Date(sample?.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return [];
  const rollupStart = new Date(sample?.rollupStart).getTime();
  const rollupEnd = new Date(sample?.rollupEnd).getTime();
  if (!Number.isFinite(rollupStart) || !Number.isFinite(rollupEnd)) {
    return [{ time: timestamp, continuousFromPrevious: false }];
  }

  const start = Math.max(rollupStart, Number.isFinite(rangeStartMs) ? rangeStartMs : rollupStart);
  const end = Math.min(rollupEnd, Number.isFinite(rangeEndMs) ? rangeEndMs : rollupEnd);
  if (start > end) return [];
  if (start === end) return [{ time: start, continuousFromPrevious: false }];
  return [
    { time: start, continuousFromPrevious: false },
    { time: end, continuousFromPrevious: true },
  ];
}

export function pruneTrendPoints(points, cutoffMs) {
  if (!Array.isArray(points) || !Number.isFinite(cutoffMs)) return [];
  const firstRetainedIndex = points.findIndex(
    (point) => Number.isFinite(point?.time) && point.time >= cutoffMs,
  );
  if (firstRetainedIndex < 0) return [];

  const retained = points.slice(firstRetainedIndex);
  const first = retained[0];
  if (!first?.continuousFromPrevious) return retained;

  const previous = points[firstRetainedIndex - 1];
  if (previous && previous.time < cutoffMs && first.time > cutoffMs) {
    return [
      { ...first, time: cutoffMs, continuousFromPrevious: false },
      ...retained,
    ];
  }

  retained[0] = { ...first, continuousFromPrevious: false };
  return retained;
}

export function nextHalfHourBoundary(value = new Date()) {
  const next = new Date(value);
  if (!Number.isFinite(next.getTime())) return null;
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() < 30 ? 30 : 60);
  return next;
}
