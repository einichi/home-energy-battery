export interface JsonErrorLocation {
  line: number;
  column: number;
  position: number;
}

export class JsonParseError extends Error {
  readonly jsonSource: string;
  readonly jsonText: string;
  readonly jsonPosition: number | null;
  readonly jsonLocation: JsonErrorLocation | null;
  readonly jsonSnippet: string;

  constructor(source: string, text: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const position = jsonErrorPosition(message);
    const location = lineColumnForPosition(text, position);
    const locationText = location
      ? ` at line ${location.line}, column ${location.column}, position ${location.position}`
      : "";
    super(`Failed to parse JSON from ${source}${locationText}: ${message}`, { cause });
    this.name = "JsonParseError";
    this.jsonSource = source;
    this.jsonText = text;
    this.jsonPosition = position;
    this.jsonLocation = location;
    this.jsonSnippet = jsonSnippetNear(text, position);
  }
}

export function jsonSnippet(text: string, maxLength = 4000): string {
  if (text === "") return "(empty)";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated ${text.length - maxLength} chars>`;
}

export function jsonErrorPosition(message: string): number | null {
  const match = message.match(/position (\d+)/);
  return match ? Number(match[1]) : null;
}

export function lineColumnForPosition(text: string, position: number | null): JsonErrorLocation | null {
  if (!Number.isInteger(position) || position === null || position < 0) return null;
  const lines = text.slice(0, position).split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1, position };
}

export function jsonSnippetNear(text: string, position: number | null, radius = 280): string {
  if (!Number.isInteger(position) || position === null || position < 0) return jsonSnippet(text, radius * 2);
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  const prefix = start > 0 ? `...<${start} chars before>\n` : "";
  const suffix = end < text.length ? `\n...<${text.length - end} chars after>` : "";
  const pointer = `${" ".repeat(Math.max(0, position - start))}^`;
  return `${prefix}${text.slice(start, end)}\n${pointer}${suffix}`;
}

export function parseJsonWithContext<T = unknown>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause: unknown) {
    throw new JsonParseError(source, text, cause);
  }
}
