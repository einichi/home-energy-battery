import * as v from "valibot";

export function validateRequestBody(
  body: Record<string, unknown>,
  schema: v.GenericSchema,
  requestError: (status: number, message: string) => Error,
): Record<string, unknown> {
  const result = v.safeParse(schema, body);
  if (!result.success) {
    const issue = result.issues[0];
    const path = issue?.path?.map((item) => String(item.key)).join(".");
    throw requestError(400, `Invalid request body${path ? ` at ${path}` : ""}: ${issue?.message ?? "schema mismatch"}`);
  }
  return body;
}
