import { useTranslation } from "react-i18next";
import type { AwayFuelCellSummary } from "../../api/contracts";
import { formatDateTime } from "../../core/format";

const regimeLabels = {
  "provisional-off": "awayFuelCellProvisional",
  "off-supported": "awayFuelCellOffSupported",
  "normal-model": "awayFuelCellNormal",
  uncertain: "awayFuelCellUncertain",
} as const;
const reasonLabels = {
  observing: "awayFuelCellObserving",
  "quiet-cycle": "awayFuelCellQuietCycle",
  "sustained-generation": "awayFuelCellSustainedGeneration",
  "generation-detected": "awayFuelCellGenerationDetected",
  "insufficient-coverage": "awayFuelCellInsufficientCoverage",
  "stale-readings": "awayFuelCellStaleReadings",
} as const;

export function AwayFuelCellForecast({ forecasts }: { forecasts: AwayFuelCellSummary[] }) {
  const { t } = useTranslation();
  if (!forecasts.length) return null;
  return <div className="away-fuel-cell-forecast">
    <h3>{t("awayFuelCellHeading")}</h3>
    {forecasts.map((forecast) => <div key={forecast.periodId}>
      <p><strong>{t(regimeLabels[forecast.regime])}</strong></p>
      <p>{t(reasonLabels[forecast.reason])}</p>
      <p className="panel-note">{t("awayFuelCellPeriod", { from: formatDateTime(forecast.from), until: formatDateTime(forecast.until) })}</p>
      <p className="panel-note">{t("awayFuelCellEvidence", {
        coverage: Math.round(forecast.coveragePercent),
        at: forecast.lastReadingAt ? formatDateTime(forecast.lastReadingAt) : t("unavailable"),
      })}</p>
      <p className="panel-note">{t(forecast.headroomAllowanceRetained ? "awayFuelCellHeadroom" : "awayFuelCellHeadroomReleased")}</p>
    </div>)}
  </div>;
}
