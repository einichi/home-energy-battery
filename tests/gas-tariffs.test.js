import assert from "node:assert/strict";
import {
  applicableGasDiscount,
  applicableGasTariffBand,
  gasTariffHash,
  importTokyoGasTariff,
  normalizeGasTariffPayload,
  parseTokyoGasTariffHtml,
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

const normalized = normalizeGasTariffPayload({
  ...parsed,
  discounts: [{ id: "floor", label: "Floor heating", percent: 3, capYen: 2619, seasons: ["winter"] }],
});
assert.equal(applicableGasDiscount(normalized, "floor").capYen, 2619);
assert.equal(applicableGasDiscount(normalized, "missing"), null);
assert.equal(gasTariffHash(normalized), gasTariffHash(normalized));
assert.match(tokyoGasTariffUrl("2026-07", 8), /ym=20260708$/);

const imported = await importTokyoGasTariff({
  billingMonth: "2026-07",
  readingDay: 8,
  season: "other",
  fetchImpl: async (url) => ({ ok: true, text: async () => html, url }),
});
assert.equal(imported.billingMonth, "2026-07");
assert.equal(imported.payload.bands.length, 3);
assert.equal(imported.sourceHash, gasTariffHash(imported.payload));

await assert.rejects(
  importTokyoGasTariff({ billingMonth: "July", fetchImpl: async () => ({ ok: true, text: async () => html }) }),
  /YYYY-MM/,
);
assert.throws(() => parseTokyoGasTariffHtml("<html>No rates</html>"), /manually/);

console.log("gas tariff tests passed");
