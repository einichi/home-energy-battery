import { formatPower } from "../core/format";
import { T, useI18n } from "../i18n";

function batteryState(power: number | null) {
  if (power === null) return "Battery";
  if (power > 0) return "Battery charging";
  if (power < 0) return "Battery discharging";
  return "Battery idle";
}

export function EnergyFlow({ solar, fuelCell, battery, demand, gridImport, gridExport, showSolar = true, showFuelCell = true, showBattery = true, showDemand = true, showGrid = true }: {
  solar: number | null;
  fuelCell: number | null;
  battery: number | null;
  demand: number | null;
  gridImport: number | null;
  gridExport: number | null;
  showSolar?: boolean;
  showFuelCell?: boolean;
  showBattery?: boolean;
  showDemand?: boolean;
  showGrid?: boolean;
}) {
  const { text } = useI18n();
  const exporting = gridExport !== null && gridExport > 0;
  return (
    <div className="energy-flow" aria-label={text("Current energy sources, storage, home demand, and grid exchange")}>
      {showSolar ? <div className="flow-source flow-solar"><span><T text={"Solar"} /></span><strong>{formatPower(solar)}</strong></div> : null}
      {showFuelCell ? <div className="flow-source flow-fuel"><span><T text={"Ene-Farm"} /></span><strong>{formatPower(fuelCell)}</strong></div> : null}
      {showBattery ? <div className="flow-source flow-battery" data-direction={battery === null || battery === 0 ? "idle" : battery > 0 ? "in" : "out"}>
        <span>{text(batteryState(battery))}</span><strong>{formatPower(battery === null ? null : Math.abs(battery))}</strong>
      </div> : null}
      {showDemand && (showSolar || showFuelCell || showBattery) ? <div className="flow-connector flow-connector-in" aria-hidden="true">→</div> : null}
      {showDemand ? <div className="flow-home"><span><T text={"Home"} /></span><strong>{formatPower(demand)}</strong></div> : null}
      {showDemand && showGrid ? <div className="flow-connector flow-connector-out" aria-hidden="true">{exporting ? "→" : "←"}</div> : null}
      {showGrid ? <div className="flow-source flow-grid"><span>{text(exporting ? "Grid export" : "Grid import")}</span><strong>{formatPower(exporting ? gridExport : gridImport)}</strong></div> : null}
    </div>
  );
}
