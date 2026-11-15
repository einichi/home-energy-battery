import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanConfig } from "../lib/domain/configuration.js";
import { asRecord } from "../lib/domain/values.js";
import { createStatusCollectionService } from "../lib/services/status-collection-service.js";

test("live readings are available during a partial outage while automation waits for the full snapshot", { timeout: 3000 }, async () => {
  const config = cleanConfig({
    batteryHost: "10.250.0.152",
    meterHost: "10.250.0.135",
    fuelCellPrimaryHost: "10.250.0.150",
    fuelCellProxyHosts: ["10.250.0.135"],
  });
  let resolveDetails!: () => void;
  const details = new Promise<void>((resolve) => { resolveDetails = resolve; });
  let primaryAvailable = false;
  let records = 0;
  const primary = () => ({
    host: config.fuelCellPrimaryHost, source_role: "primary", instant_power: primaryAvailable ? { value: 150 } : {},
  });
  const service = createStatusCollectionService({
    readConfig: async () => config,
    updateConfig: async (update) => update(config),
    async runDeviceCommand(command) {
      if (command === "live-power") return {
        completed_at: new Date().toISOString(),
        energy: { battery: { instant_power: { value: -200 } }, solar: { instant_power: { value: 30 } }, fuel_cells: [primary()] },
        meter: { grid_net_power: { value: 270 }, grid_import_power: { value: 270 }, branch_demand_power: { value: 450 } },
      };
      if (command === "energy-status") {
        await details;
        return {
          battery: { remaining_percent: { value: 45 } },
          fuel_cells: [primary(), { host: config.meterHost, source_role: "proxy", instant_power: { value: 0 } }],
        };
      }
      return {};
    },
    async recordStatusSample() { records += 1; },
    async readHistoryRange() { return {}; },
    readCalendarSavings: () => ({}),
    observeNotification: async () => {},
  });

  const completeRead = service.get();
  const early = await service.get({ display: true });
  assert.equal(early.statusDetailsPending, true);
  assert.equal(asRecord(asRecord(early.meter).grid_import_power).value, 270);
  assert.deepEqual(early.unavailableEquipment, ["Ene-Farm"]);
  assert.equal(records, 0);

  resolveDetails();
  const complete = await completeRead;
  assert.equal(complete.statusDetailsPending, undefined);
  assert.deepEqual(complete.unavailableEquipment, ["Ene-Farm"], "a proxy reply does not restore the primary");
  assert.equal(asRecord(asRecord(asRecord(complete.energy).battery).remaining_percent).value, 45);
  assert.equal(records, 1);

  primaryAvailable = true;
  const recovered = await service.get({ force: true });
  assert.deepEqual(recovered.unavailableEquipment, []);
});
