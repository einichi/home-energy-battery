import type { HistorySummary } from "../api/contracts";
import { formatCurrency, formatEnergy } from "../core/format";
import { useI18n } from "../i18n";

export function OutcomeStrip({ summary, compact = false, visible }: { summary: HistorySummary; compact?: boolean; visible?: (id: string) => boolean }) {
  const { text } = useI18n();
  const localSources = [summary.energySources?.solarUsedKwh, summary.energySources?.fuelCellContributionKwh];
  const selfPowered = localSources.some((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    ? localSources.reduce<number>((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)
    : null;
  const values = [
    { id: "houseDemandPower", label: "Used", value: formatEnergy(summary.houseDemandKwh) },
    { id: "energySources", label: "Self-powered", value: formatEnergy(selfPowered) },
    { id: "powerImported", label: "Imported", value: formatEnergy(summary.gridImportKwh) },
    { id: "powerExported", label: "Exported", value: formatEnergy(summary.gridExportKwh) },
    { id: "solarPower", label: "Solar generated", value: formatEnergy(summary.solarGenerationKwh) },
    { id: "solarSavings", label: "Est. solar saving", value: formatCurrency(summary.solarSavingYen) },
    { id: "co2Savings", label: "Est. avoided CO₂", value: summary.co2SavingKg == null ? "—" : `${summary.co2SavingKg.toFixed(1)} kg` },
    { id: "guardTriggerCount", label: "Demand Guard triggers", value: summary.guardTriggerCount == null ? "—" : String(summary.guardTriggerCount) },
  ].filter((item) => visible?.(item.id) !== false);
  return (
    <dl className={`outcome-strip${compact ? " outcome-strip-compact" : ""}`}>
      {values.map((item) => <div key={item.label}><dt>{text(item.label)}</dt><dd>{item.value}</dd></div>)}
    </dl>
  );
}
