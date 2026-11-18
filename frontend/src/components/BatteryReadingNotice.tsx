import { useTranslation } from "react-i18next";
import type { BatteryReading } from "../core/battery-readings";
import { formatDateTime } from "../core/format";
import { useEnergyStatus } from "../hooks/useEnergyStatus";

export function BatteryReadingNotice({ reading }: { reading?: BatteryReading<string | number> }) {
  const { t } = useTranslation("common");
  const { batteryReadingsStale } = useEnergyStatus();
  if (!reading || (!reading.stale && !batteryReadingsStale)) return null;
  return <small className="reading-stale">
    {reading.readAt
      ? <time dateTime={reading.readAt}>{t("staleLastRead", { value: formatDateTime(reading.readAt) })}</time>
      : t("Stale")}
  </small>;
}
