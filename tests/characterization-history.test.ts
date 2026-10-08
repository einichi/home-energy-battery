import assert from "node:assert/strict";
import { test } from "node:test";
import golden from "./fixtures/characterization/history-samples.golden.json" with { type: "json" };
import { historyCharacterizationCases } from "./support/history-characterization-cases.js";

const expected: Record<string, unknown> = golden;

for (const testCase of historyCharacterizationCases) {
  test(`characterization: ${testCase.name}`, () => {
    assert.ok(testCase.name in expected, `missing golden entry for ${testCase.name}`);
    assert.deepEqual(JSON.parse(JSON.stringify(testCase.run())), expected[testCase.name]);
  });
}
