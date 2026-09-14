let formattingLocale = "en";

export function setFormattingLocale(locale: "en" | "ja") {
  formattingLocale = locale === "ja" ? "ja" : "en";
}

export function localeName() { return formattingLocale === "ja" ? "ja-JP" : "en"; }
function numberFormat() { return new Intl.NumberFormat(localeName(), { maximumFractionDigits: 1 }); }

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(localeName(), { maximumFractionDigits }).format(Number(value));
}

export function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(localeName()).format(date) : "—";
}

export function metricValue(metric?: { value?: number | null }): number | null {
  if (metric?.value === null || metric?.value === undefined) return null;
  const value = Number(metric?.value);
  return Number.isFinite(value) ? value : null;
}

export function formatPower(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) >= 1000) return `${numberFormat().format(value / 1000)} kW`;
  return `${Math.round(value)} W`;
}

export function formatSoc(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function formatEnergy(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${numberFormat().format(Number(value))} kWh`;
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(localeName(), {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${numberFormat().format(Number(value))}%`;
}

export function formatChartTime(timestamp: string, includeDate = false): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return "—";
  return new Intl.DateTimeFormat(localeName(), includeDate
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" }).format(value);
}

export function formatFreshness(timestamp?: string, now = Date.now()): string {
  const readAt = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(readAt)) return formattingLocale === "ja" ? "最初の計測を待っています" : "Waiting for the first reading";
  const seconds = Math.max(0, Math.round((now - readAt) / 1000));
  if (seconds < 5) return formattingLocale === "ja" ? "たった今更新" : "Updated just now";
  if (seconds < 60) return formattingLocale === "ja" ? `${seconds}秒前に更新` : `Updated ${seconds} sec ago`;
  return formattingLocale === "ja" ? `${Math.round(seconds / 60)}分前に更新` : `Updated ${Math.round(seconds / 60)} min ago`;
}
