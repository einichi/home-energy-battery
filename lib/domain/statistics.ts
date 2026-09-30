export function median(values: readonly unknown[] = []): number | null {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function weightedMedian(values: readonly { value: unknown; weight: unknown }[] = []): number | null {
  const sorted = values
    .filter((item) => Number.isFinite(Number(item.value)) && Number(item.weight) > 0)
    .map((item) => ({ value: Number(item.value), weight: Number(item.weight) }))
    .sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? null;
}

export function percentile(values: readonly unknown[], fraction: number): number | null {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * fraction)))]!;
}
