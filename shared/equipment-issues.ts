type ReadError = { host?: string | null; error?: unknown };

export interface EquipmentIssueStatus {
  unavailableEquipment?: string[];
  hosts?: { battery?: string | null; solar?: string | null; meter?: string | null; fuel_cell_primary?: string | null };
  energy?: {
    error?: unknown;
    battery?: ReadError;
    solar?: ReadError | null;
    fuel_cells?: Array<ReadError & { source_role?: string }>;
    errors?: ReadError[];
  };
  meter?: ReadError & {
    errors?: ReadError[];
    grid_import_power?: { value?: unknown };
    branch_demand_power?: { value?: unknown };
  };
}

interface EquipmentHosts {
  batteryHost?: string;
  solarHost?: string;
  meterHost?: string;
  fuelCellPrimaryHost?: string;
}

interface EquipmentIssue {
  host: string | undefined;
  name: string | undefined;
  errors: Set<string>;
  unavailable: boolean;
}

export function summarizeEquipmentIssues(status: EquipmentIssueStatus, config?: EquipmentHosts | null) {
  const { energy, meter, hosts } = status;
  const fuelCells = energy?.fuel_cells ?? [];
  const equipmentHosts = new Map<string, string | undefined>([
    ["Battery", hosts?.battery || config?.batteryHost],
    ["Solar", hosts?.solar || config?.solarHost],
    ["Smart Cosmo", hosts?.meter || config?.meterHost],
    ["Ene-Farm", hosts?.fuel_cell_primary || config?.fuelCellPrimaryHost ||
      fuelCells.find((cell) => cell.source_role === "primary")?.host || undefined],
  ]);
  const issues = new Map<string, EquipmentIssue>();

  function add(reading: ReadError, name?: string, unavailable = false): void {
    const error = typeof reading.error === "string" ? reading.error.trim() : "";
    if (!error && !unavailable) return;
    // Older snapshots can identify the endpoint only in the ECHONET error text.
    const host = reading.host || (name && equipmentHosts.get(name)) ||
      error.match(/^(\S+)\s+0x[0-9a-f]{6}\b/i)?.[1];
    const key = host || name || "equipment";
    const issue = issues.get(key) ?? {
      host,
      name: name ?? [...equipmentHosts].find(([, address]) => host && address === host)?.[0],
      errors: new Set<string>(),
      unavailable: false,
    };
    if (error) issue.errors.add(error);
    if (unavailable) issue.unavailable = true;
    issues.set(key, issue);
  }

  for (const name of status.unavailableEquipment ?? []) add({}, name, true);
  if (energy?.battery) add(energy.battery, "Battery");
  if (energy?.solar) add(energy.solar, "Solar");
  if (meter) {
    const hasMeterReading = [meter.grid_import_power?.value, meter.branch_demand_power?.value]
      .some((value) => typeof value === "number" && Number.isFinite(value));
    // A queued command can expire before reaching a meter that still reports live power.
    if (!hasMeterReading || !/in the device command queue$/i.test(String(meter.error ?? ""))) add(meter, "Smart Cosmo");
  }
  for (const cell of fuelCells) add(cell, cell.source_role === "proxy" ? undefined : "Ene-Farm");
  for (const error of energy?.errors ?? []) add(error);
  for (const error of meter?.errors ?? []) add(error, "Smart Cosmo");
  if (issues.size === 0) add({ error: energy?.error });
  if (issues.size === 0) return null;

  const errors = [...issues.values()].flatMap((issue) => [...issue.errors]);
  const detail = [...issues.values()].map(({ name, host, unavailable, errors }) => {
    const equipment = name && host ? `${name} (${host})` : name ?? host;
    const firstError = errors.values().next().value;
    if (unavailable) return `${equipment} unavailable`;
    if (equipment && errors.size && [...errors].every((error) => /timed out|unreachable|EHOST|ENET/i.test(error))) {
      return `${equipment} did not respond`;
    }
    return equipment && host ? `${equipment} · ${firstError}` : firstError;
  }).join(" · ");
  return {
    title: `${issues.size} equipment issue${issues.size === 1 ? "" : "s"}`,
    detail,
    networkError: errors.some((error) => /timed out|timeout|unreachable|network|EHOST|ENET/i.test(error)),
  };
}
