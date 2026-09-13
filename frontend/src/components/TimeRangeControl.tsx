import { timeRanges } from "../core/timeRange";
import type { TimeRangeId } from "../core/timeRange";

export function TimeRangeControl({ value, onChange }: { value: TimeRangeId; onChange: (value: TimeRangeId) => void }) {
  return (
    <div className="segmented-control" aria-label="History period">
      {timeRanges.map((range) => (
        <button key={range.id} type="button" aria-pressed={value === range.id} onClick={() => onChange(range.id)}>
          {range.label}
        </button>
      ))}
    </div>
  );
}
