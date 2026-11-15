import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanAdaptiveChargingState } from "../lib/domain/adaptive-state.js";
import { cleanConfig } from "../lib/domain/configuration.js";
import { createSystemAlertService } from "../lib/services/system-alert-service.js";

test("the overview alert counts equipment once across failed reads and reported outages", async () => {
  const primary = "10.250.0.150";
  const meter = "10.250.0.135";
  const config = cleanConfig({ fuelCellPrimaryHost: primary, meterHost: meter, fuelCellProxyHosts: [meter] });
  const view = createSystemAlertService({
    readConfig: async () => config,
    readAdaptiveChargingState: async () => cleanAdaptiveChargingState({}),
    readAutomationRules: async () => [],
    readSchedules: async () => [],
    notificationView: async () => ({}),
    adaptiveChargingView: () => ({}),
    readCommandReceipts: () => [],
    getDatabaseOperation: () => ({ busy: false }),
  });
  const errors = ["c4", "cb", "c2", "c5", "c8", "d0", "f4"].map((epc) => ({
    host: primary,
    error: `${primary} 0x027C01 EPC 0x${epc} timed out after 15s`,
  }));
  const energy = { fuel_cells: [{ host: primary, source_role: "primary", error: errors[0].error }], errors };
  const [legacy] = await view({ energy });
  assert.match(legacy.title, /^1 equipment issue$/);
  assert.equal(legacy.impact, "Ene-Farm (10.250.0.150) did not respond");

  const [withQueuedMeterRead] = await view({
    energy,
    meter: { host: meter, error: "ECHONET meter-status timed out in the device command queue", grid_import_power: { value: 0 } },
  });
  assert.equal(withQueuedMeterRead.title, legacy.title);

  const [partial] = await view({ energy, unavailableEquipment: ["Ene-Farm", "Ene-Farm"] });
  assert.equal(partial.title, legacy.title);
  assert.equal(partial.impact, "Ene-Farm (10.250.0.150) unavailable");

  const [twoDevices] = await view({
    energy: { ...energy, fuel_cells: [...energy.fuel_cells, { host: meter, source_role: "proxy", error: "Proxy unavailable" }] },
    meter: { host: meter, errors: [{ host: meter, error: "Meter timed out" }] },
  });
  assert.equal(twoDevices.title, "2 equipment issues");
  assert.match(twoDevices.impact, /Smart Cosmo \(10\.250\.0\.135\)/);
});
