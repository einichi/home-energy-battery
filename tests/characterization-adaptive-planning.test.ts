import assert from "node:assert/strict";
import { test } from "node:test";
import golden from "./fixtures/characterization/adaptive-planning.golden.json" with { type: "json" };
import { adaptivePlanningCharacterizationCases } from "./support/adaptive-planning-characterization.js";

for (const [name, run] of Object.entries(adaptivePlanningCharacterizationCases)) {
  test(`characterization: adaptive planning ${name}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(run())), golden[name as keyof typeof golden]);
  });
}
