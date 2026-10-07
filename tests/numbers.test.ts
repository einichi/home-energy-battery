import assert from "node:assert/strict";
import { finiteNumberOrNull } from "../lib/domain/numbers.js";

// Booleans must not be coerced to 0/1.
assert.equal(finiteNumberOrNull(true), null);
assert.equal(finiteNumberOrNull(false), null);

// Explicit zero and numeric strings stay valid.
assert.equal(finiteNumberOrNull(0), 0);
assert.equal(finiteNumberOrNull("12.5"), 12.5);

// Empty, missing, and non-numeric values map to null.
assert.equal(finiteNumberOrNull(""), null);
assert.equal(finiteNumberOrNull(null), null);
assert.equal(finiteNumberOrNull(undefined), null);
assert.equal(finiteNumberOrNull("abc"), null);
assert.equal(finiteNumberOrNull(Infinity), null);

console.log("number utility tests passed");
