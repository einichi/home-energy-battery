import { finiteNumberOrNull } from "./numbers.js";


type DateInput = string | number | Date;

export function localMonthKey(value: DateInput): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}


export function clampedReadingDate(year: number, month: number, readingDay: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(readingDay, lastDay));
}


export function completeBillingPeriod(start: DateInput, end: DateInput, readingDay: number): boolean {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const expectedStart = clampedReadingDate(startDate.getFullYear(), startDate.getMonth(), readingDay);
  const expectedEnd = clampedReadingDate(startDate.getFullYear(), startDate.getMonth() + 1, readingDay);
  return startDate.getTime() === expectedStart.getTime() && endDate.getTime() === expectedEnd.getTime();
}


export function billingPeriodKey(value: DateInput, readingDay: number): string {
  const date = new Date(value);
  const boundary = clampedReadingDate(date.getFullYear(), date.getMonth(), readingDay);
  const periodStart = date.getTime() < boundary.getTime()
    ? clampedReadingDate(date.getFullYear(), date.getMonth() - 1, readingDay)
    : boundary;
  return localMonthKey(periodStart);
}


export function billingPeriodBounds(billingMonth: string, readingDay: number): { start: Date; end: Date } {
  const [year, month] = String(billingMonth).split("-").map(Number);
  return {
    start: clampedReadingDate(year, month - 1, readingDay),
    end: clampedReadingDate(year, month, readingDay),
  };
}


export function fuelCellGasUsageByBillingPeriod(
  samples: Array<{ fuelCellGasM3?: unknown; timestamp: DateInput }>,
  readingDay: number,
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const sample of samples) {
    const gasM3 = finiteNumberOrNull(sample.fuelCellGasM3);
    if (gasM3 === null) continue;
    const billingMonth = billingPeriodKey(sample.timestamp, readingDay);
    usage.set(billingMonth, Number(usage.get(billingMonth) ?? 0) + Math.max(0, gasM3));
  }
  return usage;
}
