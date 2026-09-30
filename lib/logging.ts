import { jsonSnippet } from "./domain/json.js";

export function logDetailedError(label: string, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const detail = err as Error & {
    automationContext?: unknown;
    jsonSource?: unknown;
    jsonLocation?: { line?: unknown; column?: unknown; position?: unknown };
    jsonSnippet?: unknown;
    jsonText?: unknown;
  };
  console.error(`${label}:`, err.stack || err.message);
  if (detail.automationContext) console.error(`${label} context: ${JSON.stringify(detail.automationContext)}`);
  if (detail.jsonSource !== undefined) {
    console.error(`${label} JSON source: ${detail.jsonSource}`);
    if (detail.jsonLocation) {
      console.error(`${label} JSON location: line ${detail.jsonLocation.line}, column ${detail.jsonLocation.column}, position ${detail.jsonLocation.position}`);
    }
    if (detail.jsonSnippet !== undefined) console.error(`${label} JSON near error:\n${detail.jsonSnippet}`);
    console.error(`${label} JSON payload:\n${jsonSnippet(String(detail.jsonText ?? ""))}`);
  }
}
