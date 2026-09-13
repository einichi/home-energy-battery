export const timeRanges = [
  { id: "live", label: "Live", milliseconds: 15 * 60_000 },
  { id: "1h", label: "1h", milliseconds: 60 * 60_000 },
  { id: "8h", label: "8h", milliseconds: 8 * 60 * 60_000 },
  { id: "24h", label: "24h", milliseconds: 24 * 60 * 60_000 },
  { id: "3d", label: "3d", milliseconds: 3 * 24 * 60 * 60_000 },
  { id: "7d", label: "7d", milliseconds: 7 * 24 * 60 * 60_000 },
  { id: "30d", label: "30d", milliseconds: 30 * 24 * 60 * 60_000 },
] as const;

export type TimeRangeId = typeof timeRanges[number]["id"];

export function timeRangeMilliseconds(id: TimeRangeId): number {
  return timeRanges.find((range) => range.id === id)?.milliseconds ?? 24 * 60 * 60_000;
}
