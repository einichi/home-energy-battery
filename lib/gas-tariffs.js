import { createHash } from "node:crypto";

const TOKYO_GAS_PLAN_URL = "https://home.tokyo-gas.co.jp/gas_power/plan/gas/enefarm.html";

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function validBillingMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ""));
}

export function normalizeGasTariffPayload(value = {}) {
  const bands = (Array.isArray(value.bands) ? value.bands : [])
    .map((band) => ({
      minM3: Math.max(0, finite(band.minM3, 0)),
      maxM3: band.maxM3 === null || band.maxM3 === "" || band.maxM3 === undefined ? null : Math.max(0, finite(band.maxM3, 0)),
      baseChargeYen: Math.max(0, finite(band.baseChargeYen, 0)),
      yenPerM3: Math.max(0, finite(band.yenPerM3, 0)),
      label: String(band.label ?? "").trim().slice(0, 100),
    }))
    .filter((band) => band.maxM3 === null || band.maxM3 > band.minM3)
    .sort((left, right) => left.minM3 - right.minM3);
  if (!bands.length) throw new Error("At least one gas tariff usage band is required");
  const discounts = (Array.isArray(value.discounts) ? value.discounts : [])
    .map((discount) => ({
      id: String(discount.id ?? discount.label ?? "discount").trim().slice(0, 80),
      label: String(discount.label ?? discount.id ?? "Discount").trim().slice(0, 100),
      seasons: (Array.isArray(discount.seasons) ? discount.seasons : ["winter", "other"]).filter((season) => ["winter", "other"].includes(season)),
      percent: Math.max(0, Math.min(100, finite(discount.percent, 0))),
      capYen: discount.capYen === null || discount.capYen === undefined || discount.capYen === "" ? null : Math.max(0, finite(discount.capYen, 0)),
    }))
    .filter((discount) => discount.id && discount.percent > 0);
  return {
    season: value.season === "winter" ? "winter" : "other",
    currency: "JPY",
    bands,
    discounts,
    notes: String(value.notes ?? "").trim().slice(0, 1000),
    providerPlanUrl: String(value.providerPlanUrl ?? TOKYO_GAS_PLAN_URL),
  };
}

export function gasTariffHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function tokyoGasTariffUrl(billingMonth, readingDay = 1) {
  const compact = billingMonth.replace("-", "");
  return `https://reception.tokyo-gas.co.jp/ryokin?tik=1&ym=${compact}${String(readingDay).padStart(2, "0")}`;
}

function textRows(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(td|th)>/gi, "|")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&yen;|&#165;/g, "¥")
    .split("\n")
    .map((row) => row.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function parseTokyoGasTariffHtml(html, { season = "other" } = {}) {
  const bands = [];
  for (const row of textRows(html)) {
    if (!/m(?:3|³)|㎥/.test(row)) continue;
    const numericRow = row.replace(/m(?:3|³)|㎥/g, "");
    const values = [...numericRow.matchAll(/([\d,]+(?:\.\d+)?)/g)].map((match) => Number(match[1].replace(/,/g, "")));
    if (values.length < 4) continue;
    const [minM3, maxM3, baseChargeYen, yenPerM3] = values.slice(-4);
    if (yenPerM3 <= 0 || baseChargeYen < 0 || maxM3 <= minM3) continue;
    bands.push({ minM3, maxM3: maxM3 >= 999999 ? null : maxM3, baseChargeYen, yenPerM3, label: row.split("|")[0] ?? "" });
  }
  if (!bands.length) {
    throw new Error("Tokyo Gas did not expose a readable tariff table; import the published rates manually");
  }
  return normalizeGasTariffPayload({ season, bands, providerPlanUrl: TOKYO_GAS_PLAN_URL });
}

export async function importTokyoGasTariff({ billingMonth, readingDay = 1, season = "other", fetchImpl = fetch } = {}) {
  if (!validBillingMonth(billingMonth)) throw new Error("billingMonth must be YYYY-MM");
  const sourceUrl = tokyoGasTariffUrl(billingMonth, readingDay);
  const response = await fetchImpl(sourceUrl, { headers: { Accept: "text/html", "User-Agent": "home-energy-battery/0.1" } });
  if (!response.ok) throw new Error(`Tokyo Gas tariff request failed (${response.status})`);
  const payload = parseTokyoGasTariffHtml(await response.text(), { season });
  return { provider: "tokyo-gas", billingMonth, sourceUrl, payload, sourceHash: gasTariffHash(payload) };
}

export const GAS_TARIFF_PROVIDERS = Object.freeze({
  "tokyo-gas": {
    id: "tokyo-gas",
    label: "Tokyo Gas",
    importMonthly: importTokyoGasTariff,
  },
});

export async function importGasTariff(provider, options = {}) {
  const adapter = GAS_TARIFF_PROVIDERS[provider];
  if (!adapter) throw new Error(`No automatic tariff adapter is available for ${provider}`);
  return adapter.importMonthly(options);
}

export function applicableGasTariffBand(tariff, expectedMonthlyM3) {
  const usage = Math.max(0, finite(expectedMonthlyM3, 0));
  return tariff?.bands?.find((band) => usage >= band.minM3 && (band.maxM3 === null || usage < band.maxM3))
    ?? tariff?.bands?.at(-1)
    ?? null;
}

export function applicableGasDiscount(tariff, discountId) {
  return tariff?.discounts?.find((discount) => discount.id === discountId && discount.seasons.includes(tariff.season)) ?? null;
}
