import { formatPower } from "../core/format";

function batteryState(power: number | null) {
  if (power === null) return "Battery";
  if (power > 0) return "Battery charging";
  if (power < 0) return "Battery discharging";
  return "Battery idle";
}

export function EnergyFlow({ solar, fuelCell, battery, demand, gridImport, gridExport }: {
  solar: number | null;
  fuelCell: number | null;
  battery: number | null;
  demand: number | null;
  gridImport: number | null;
  gridExport: number | null;
}) {
  const exporting = gridExport !== null && gridExport > 0;
  return (
    <div className="energy-flow" aria-label="Current energy sources, storage, home demand, and grid exchange">
      <div className="flow-source flow-solar"><span>Solar</span><strong>{formatPower(solar)}</strong></div>
      <div className="flow-source flow-fuel"><span>Ene-Farm</span><strong>{formatPower(fuelCell)}</strong></div>
      <div className="flow-source flow-battery" data-direction={battery === null || battery === 0 ? "idle" : battery > 0 ? "in" : "out"}>
        <span>{batteryState(battery)}</span><strong>{formatPower(battery === null ? null : Math.abs(battery))}</strong>
      </div>
      <div className="flow-connector flow-connector-in" aria-hidden="true">→</div>
      <div className="flow-home"><span>Home</span><strong>{formatPower(demand)}</strong></div>
      <div className="flow-connector flow-connector-out" aria-hidden="true">{exporting ? "→" : "←"}</div>
      <div className="flow-source flow-grid"><span>{exporting ? "Grid export" : "Grid import"}</span><strong>{formatPower(exporting ? gridExport : gridImport)}</strong></div>
    </div>
  );
}
