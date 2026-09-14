import { timeRanges } from "../core/timeRange";
import type { TimeRangeId } from "../core/timeRange";
import { useI18n } from "../i18n";

export function TimeRangeControl({ value, onChange }: { value: TimeRangeId; onChange: (value: TimeRangeId) => void }) {
  const { text } = useI18n();
  return (
    <div className="segmented-control" aria-label={text("History period")}>
      {timeRanges.map((range) => (
        <button key={range.id} type="button" aria-pressed={value === range.id} onClick={() => onChange(range.id)}>
          {text(range.label)}
        </button>
      ))}
    </div>
  );
}
