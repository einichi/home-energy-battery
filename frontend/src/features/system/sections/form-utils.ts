export function entries(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function optionalNumber(value: FormDataEntryValue | null): number | null {
  return String(value ?? "") === "" ? null : Number(value);
}

export function positiveNumberOr(value: FormDataEntryValue | null, fallback: number | null | undefined): number | null | undefined {
  const number = Number(value);
  // Keep the current value (including an explicit null = unlimited) on blank input.
  return Number.isFinite(number) && number >= 1 ? Math.round(number) : fallback;
}

export function bytes(value?: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value!;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function duration(days?: number): string {
  return Number.isFinite(days) ? `${days!.toFixed(1)} days` : "Unavailable";
}
