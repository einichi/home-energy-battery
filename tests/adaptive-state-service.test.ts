import assert from "node:assert/strict";

import { createAdaptiveStateService } from "../lib/services/adaptive-state-service.js";

type Dependencies = Parameters<typeof createAdaptiveStateService>[0];

const store = { value: {} as Record<string, unknown> };
const documents = {
  readDocument: (_key: string, fallback: Record<string, unknown>) => store.value ?? fallback,
  writeDocument: (_key: string, value: Record<string, unknown>) => { store.value = value; },
} as unknown as Dependencies["documents"];

const service = createAdaptiveStateService({
  documents,
  history: { isReady: () => false, recordEvent: () => undefined },
  synchronizeDeadline: () => undefined,
  now: () => new Date("2026-07-11T00:00:00.000Z"),
});

// Two writers that both read the same base revision must not surface a
// stale-revision error; the second rebases onto the first.
const firstRead = await service.read();
const secondRead = await service.read();
const [first, second] = await Promise.all([
  service.write({ ...firstRead }),
  service.write({ ...secondRead }),
]);
assert.equal(first.revision, 1);
assert.equal(second.revision, 2);
assert.equal((await service.read()).revision, 2);
