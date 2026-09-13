import type { HistorySummary } from "../api/contracts";
import { formatCurrency, formatEnergy } from "../core/format";

export function OutcomeStrip({ summary, compact = false }: { summary: HistorySummary; compact?: boolean }) {
  const localSources = [summary.energySources?.solarUsedKwh, summary.energySources?.fuelCellContributionKwh];
  const selfPowered = localSources.some((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    ? localSources.reduce<number>((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)
    : null;
  const values = [
    { label: "Used", value: formatEnergy(summary.houseDemandKwh) },
    { label: "Self-powered", value: formatEnergy(selfPowered) },
    { label: "Imported", value: formatEnergy(summary.gridImportKwh) },
    { label: "Exported", value: formatEnergy(summary.gridExportKwh) },
    { label: "Solar generated", value: formatEnergy(summary.solarGenerationKwh) },
    { label: "Est. solar saving", value: formatCurrency(summary.solarSavingYen) },
  ];
  return (
    <dl className={`outcome-strip${compact ? " outcome-strip-compact" : ""}`}>
      {values.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
    </dl>
  );
}
