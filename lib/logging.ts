export function logDetailedError(label: string, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const detail = err as Error & {
    automationContext?: unknown;
  };
  console.error(`${label}:`, err.stack || err.message);
  if (detail.automationContext) console.error(`${label} context: ${JSON.stringify(detail.automationContext)}`);
}
