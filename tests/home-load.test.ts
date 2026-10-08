import assert from "node:assert/strict";
import { deriveHomeLoad } from "../lib/services/status-collection-service.js";

const none = { enabled: false, value: null };

// Derived only when every required component is present.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 1100, battery: 0, solar: none, fuelCell: none, branchDemand: 1000 }),
  { value: 1100, source: "derived", missing: [] },
);

// Battery charging is a load: it reduces home consumption below grid import.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 920, battery: 300, solar: none, fuelCell: none, branchDemand: 800 }),
  { value: 620, source: "derived", missing: [] },
);

// Battery discharge supplies the home.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 60, battery: -347, solar: none, fuelCell: none, branchDemand: 344 }),
  { value: 407, source: "derived", missing: [] },
);

// Solar + fuel cell are generation sources and add to home consumption.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 100, battery: 0, solar: { enabled: true, value: 850 }, fuelCell: { enabled: true, value: 650 }, branchDemand: 0 }),
  { value: 1600, source: "derived", missing: [] },
);

// Small negative balance is clamped to zero (measurement noise), not flagged.
assert.deepEqual(
  deriveHomeLoad({ gridNet: -50, battery: 0, solar: none, fuelCell: none, branchDemand: 0 }),
  { value: 0, source: "derived", missing: [] },
);

// A substantially negative balance is inconsistent, not an ordinary zero.
assert.deepEqual(
  deriveHomeLoad({ gridNet: -650, battery: 0, solar: none, fuelCell: none, branchDemand: 0 }),
  { value: 0, source: "inconsistent", missing: [] },
);

// An enabled component that is missing falls back to the independent branch sum.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 1100, battery: 0, solar: { enabled: true, value: null }, fuelCell: none, branchDemand: 1000 }),
  { value: 1000, source: "branch_fallback", missing: ["solar"] },
);

// A disabled component contributes zero and is not "missing".
assert.deepEqual(
  deriveHomeLoad({ gridNet: 1100, battery: 0, solar: none, fuelCell: none, branchDemand: 1000 }),
  { value: 1100, source: "derived", missing: [] },
);

// Missing required readings with no branch reading is unavailable.
assert.deepEqual(
  deriveHomeLoad({ gridNet: null, battery: 0, solar: none, fuelCell: none, branchDemand: null }),
  { value: null, source: "unavailable", missing: ["grid"] },
);

// Missing battery falls back when branch is available.
assert.deepEqual(
  deriveHomeLoad({ gridNet: 1100, battery: null, solar: none, fuelCell: none, branchDemand: 990 }),
  { value: 990, source: "branch_fallback", missing: ["battery"] },
);

console.log("home load derivation tests passed");
