import { createHash } from "node:crypto";

const TOKYO_GAS_PLAN_URL = "https://home.tokyo-gas.co.jp/gas_power/plan/gas/enefarm.html";
const TOKYO_GAS_TARIFF_API = "https://tw-api.tokyo-gas.co.jp/bff/web/gasryokin/v1/get-ryokinhyo-data";
// This key is published in Tokyo Gas's public tariff web client. If it rotates,
// imports fail closed and previously stored monthly snapshots remain available.
const TOKYO_GAS_API_SUBSCRIPTION_KEY = "deb2ee15793f4d59876797fc13424bae";

export const TOKYO_GAS_REGIONS = Object.freeze({
  tokyo: Object.freeze({ id: "tokyo", label: "Tokyo district and surrounding areas", tik: 1 }),
  gunma: Object.freeze({ id: "gunma", label: "Gunma district", tik: 6 }),
});

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

export function tokyoGasSeasonForBillingMonth(billingMonth) {
  if (!validBillingMonth(billingMonth)) throw new Error("billingMonth must be YYYY-MM");
  const month = Number(billingMonth.slice(5, 7));
  return month === 12 || month <= 4 ? "winter" : "other";
}

function tokyoGasRegion(region = "tokyo") {
  return TOKYO_GAS_REGIONS[region] ?? TOKYO_GAS_REGIONS.tokyo;
}

export function tokyoGasTariffUrl(billingMonth, readingDay = 1, region = "tokyo") {
  const compact = billingMonth.replace("-", "");
  return `https://reception.tokyo-gas.co.jp/ryokin/?tik=${tokyoGasRegion(region).tik}&ym=${compact}${String(readingDay).padStart(2, "0")}`;
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

function tokyoGasDiscounts(season) {
  return [
    { id: "bath", label: "Ene-Farm + Bath heating discount", percent: 3, capYen: 2619, seasons: [season] },
    ...(season === "winter"
      ? [{ id: "floor", label: "Ene-Farm + Floor heating discount", percent: 10, capYen: 7857, seasons: [season] }]
      : []),
    {
      id: "set",
      label: "Ene-Farm + Combined bath/floor discount",
      percent: season === "winter" ? 13 : 3,
      capYen: season === "winter" ? 10476 : 2619,
      seasons: [season],
    },
  ];
}

export function parseTokyoGasTariffApiPayload(value, { billingMonth, plan = "enefarm" } = {}) {
  if (!validBillingMonth(billingMonth)) throw new Error("billingMonth must be YYYY-MM");
  if (plan !== "enefarm") throw new Error(`Tokyo Gas tariff plan is not supported: ${plan}`);
  const document = typeof value?.ryokinhyoFileContent === "string"
    ? JSON.parse(value.ryokinhyoFileContent)
    : value;
  const season = tokyoGasSeasonForBillingMonth(billingMonth);
  const period = season === "winter" ? document?.kateiyo?.enefarm?.touki : document?.kateiyo?.enefarm?.sonotaki;
  const bands = (Array.isArray(period?.hyo) ? period.hyo : []).map((row) => {
    const upper = finite(row?.shiyoryo?.base_val_jogen, 0);
    return {
      minM3: Math.max(0, Math.floor(finite(row?.shiyoryo?.base_val_kagen, 0))),
      maxM3: upper > 0 ? upper : null,
      baseChargeYen: finite(row?.kihonryokin?.base_val, 0),
      yenPerM3: finite(row?.taniryokin?.genryohityoseigo?.base_val, 0),
      label: String(row?.ryokinhyo?.val ?? ""),
    };
  }).filter((band) => band.yenPerM3 > 0);
  if (!bands.length) throw new Error("Tokyo Gas did not return Ene-Farm rates for this billing month");
  return normalizeGasTariffPayload({
    season,
    bands,
    discounts: tokyoGasDiscounts(season),
    notes: String(document?.kateiyo?.enefarm?.name ?? period?.title ?? ""),
    providerPlanUrl: TOKYO_GAS_PLAN_URL,
  });
}

export async function importTokyoGasTariff({ billingMonth, readingDay = 1, region = "tokyo", plan = "enefarm", fetchImpl = fetch } = {}) {
  if (!validBillingMonth(billingMonth)) throw new Error("billingMonth must be YYYY-MM");
  const selectedRegion = tokyoGasRegion(region);
  if (selectedRegion.id !== region) throw new Error(`Unknown Tokyo Gas region: ${region}`);
  const sourceUrl = tokyoGasTariffUrl(billingMonth, readingDay, region);
  const apiUrl = new URL(TOKYO_GAS_TARIFF_API);
  apiUrl.searchParams.set("tik", String(selectedRegion.tik));
  apiUrl.searchParams.set("ym", billingMonth.replace("-", ""));
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/json",
      "Ocp-Apim-Subscription-Key": TOKYO_GAS_API_SUBSCRIPTION_KEY,
      "User-Agent": "home-energy-battery/0.1",
    },
  });
  if (!response.ok) throw new Error(`Tokyo Gas tariff request failed (${response.status})`);
  const responsePayload = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
  const payload = parseTokyoGasTariffApiPayload(responsePayload, { billingMonth, plan });
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
  return tariff?.bands?.find((band) => usage >= band.minM3 && (band.maxM3 === null || usage <= band.maxM3))
    ?? tariff?.bands?.at(-1)
    ?? null;
}

export function applicableGasDiscount(tariff, discountId) {
  return tariff?.discounts?.find((discount) => discount.id === discountId && discount.seasons.includes(tariff.season)) ?? null;
}
