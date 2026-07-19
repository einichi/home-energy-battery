import assert from "node:assert/strict";
import {
  applicableGasDiscount,
  applicableGasTariffBand,
  gasTariffHash,
  importTokyoGasTariff,
  normalizeGasTariffPayload,
  parseTokyoGasTariffHtml,
  parseTokyoGasTariffApiPayload,
  tokyoGasSeasonForBillingMonth,
  tokyoGasTariffUrl,
} from "../lib/gas-tariffs.js";

const html = `
  <table>
    <tr><th>Usage</th><th>Base</th><th>Rate</th></tr>
    <tr><td>A | 0 m3 | 20 m3</td><td>759.00</td><td>145.31</td></tr>
    <tr><td>B | 20 m3 | 80 m3</td><td>1056.00</td><td>130.46</td></tr>
    <tr><td>C | 80 m3 | 999999 m3</td><td>1232.00</td><td>128.26</td></tr>
  </table>`;

const parsed = parseTokyoGasTariffHtml(html, { season: "winter" });
assert.equal(parsed.season, "winter");
assert.equal(parsed.bands.length, 3);
assert.equal(parsed.bands[2].maxM3, null);
assert.equal(applicableGasTariffBand(parsed, 35).yenPerM3, 130.46);
assert.equal(applicableGasTariffBand(parsed, 20).yenPerM3, 145.31);

const normalized = normalizeGasTariffPayload({
  ...parsed,
  discounts: [{ id: "floor", label: "Floor heating", percent: 3, capYen: 2619, seasons: ["winter"] }],
});
assert.equal(applicableGasDiscount(normalized, "floor").capYen, 2619);
assert.equal(applicableGasDiscount(normalized, "missing"), null);
assert.equal(gasTariffHash(normalized), gasTariffHash(normalized));
assert.match(tokyoGasTariffUrl("2026-07", 8), /ym=20260708$/);
assert.match(tokyoGasTariffUrl("2026-07", 8, "gunma"), /tik=6/);
assert.equal(tokyoGasSeasonForBillingMonth("2026-04"), "winter");
assert.equal(tokyoGasSeasonForBillingMonth("2026-05"), "other");
assert.equal(tokyoGasSeasonForBillingMonth("2026-12"), "winter");

function tariffPeriod(rate, upper = 0) {
  return {
    hyo: [{
      ryokinhyo: { val: "A表" },
      shiyoryo: { base_val_kagen: 0, base_val_jogen: upper },
      kihonryokin: { base_val: 759 },
      taniryokin: { genryohityoseigo: { base_val: rate } },
    }],
  };
}

const apiDocument = {
  kateiyo: {
    enefarm: {
      name: "家庭用燃料電池契約《エネファームで発電エコぷらん》",
      touki: tariffPeriod(118.4),
      sonotaki: tariffPeriod(136.54),
    },
  },
};
const julyTariff = parseTokyoGasTariffApiPayload(apiDocument, { billingMonth: "2026-07" });
assert.equal(julyTariff.season, "other");
assert.equal(julyTariff.bands[0].yenPerM3, 136.54);
assert.equal(applicableGasDiscount(julyTariff, "bath").percent, 3);
assert.equal(applicableGasDiscount(julyTariff, "floor"), null);
assert.equal(applicableGasDiscount(julyTariff, "set").percent, 3);
const januaryTariff = parseTokyoGasTariffApiPayload(apiDocument, { billingMonth: "2026-01" });
assert.equal(januaryTariff.season, "winter");
assert.equal(applicableGasDiscount(januaryTariff, "floor").percent, 10);
assert.equal(applicableGasDiscount(januaryTariff, "set").percent, 13);

let requestedUrl;
const imported = await importTokyoGasTariff({
  billingMonth: "2026-07",
  readingDay: 8,
  region: "gunma",
  fetchImpl: async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ ryokinhyoFileContent: JSON.stringify(apiDocument) }) };
  },
});
assert.equal(imported.billingMonth, "2026-07");
assert.equal(imported.payload.bands.length, 1);
assert.equal(imported.sourceHash, gasTariffHash(imported.payload));
assert.match(requestedUrl, /tik=6/);

await assert.rejects(
  importTokyoGasTariff({ billingMonth: "July", fetchImpl: async () => ({ ok: true, json: async () => apiDocument }) }),
  /YYYY-MM/,
);
await assert.rejects(
  importTokyoGasTariff({ billingMonth: "2026-07", region: "invalid", fetchImpl: async () => ({ ok: true, json: async () => apiDocument }) }),
  /Unknown Tokyo Gas region/,
);
assert.throws(() => parseTokyoGasTariffHtml("<html>No rates</html>"), /manually/);

console.log("gas tariff tests passed");
