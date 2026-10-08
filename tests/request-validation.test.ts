import assert from "node:assert/strict";
import { test } from "node:test";
import { AppConfigSchema, DiscoveryJobRequestSchema } from "../shared/api-schemas.js";
import { validateRequestBody } from "../lib/http/request-validation.js";

function requestError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

test("request body schemas reject malformed fields with HTTP 400", () => {
  assert.throws(
    () => validateRequestBody({ timeout: "fast" }, DiscoveryJobRequestSchema, requestError),
    (error: unknown) => error instanceof Error && (error as Error & { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => validateRequestBody({
      updateIntervalSeconds: 15,
      language: 7,
      solarEnabled: true,
      smartCosmoEnabled: true,
      fuelCellEnabled: false,
    }, AppConfigSchema, requestError),
    /Invalid request body at language/,
  );
});

test("request validation preserves unknown config fields for downstream normalization", () => {
  const body = {
    language: "en" as const,
    updateIntervalSeconds: 15,
    solarEnabled: true,
    smartCosmoEnabled: true,
    fuelCellEnabled: false,
    futureFeature: { enabled: true },
  };
  const validated = validateRequestBody(body, AppConfigSchema, requestError);
  assert.equal(validated, body);
  assert.deepEqual(validated.futureFeature, { enabled: true });
});
