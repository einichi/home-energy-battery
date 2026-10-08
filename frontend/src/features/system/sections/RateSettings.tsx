import { useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig } from "../../../api/contracts";
import { importGasTariff } from "../../../api/system";
import { useTranslation } from "react-i18next";
import type { Result, SaveSettings } from "./types.js";
import { ResultMessage } from "./ResultMessage.js";
import { optionalNumber } from "./form-utils.js";

export function RateSettings({
  config,
  save,
}: {
  config: AppConfig;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [mode, setMode] = useState(config.rateMode ?? "simple");
  const [bands, setBands] = useState(config.rateBands ?? []);
  const [rateResult, setRateResult] = useState<Result>(null);
  const [fuelResult, setFuelResult] = useState<Result>(null);
  const [tariffResult, setTariffResult] = useState<Result>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const standard = Number(data.get("standardRate"));
    const offPeak = Number(data.get("offPeakRate"));
    setRateResult(
      await save(
        {
          rateMode: mode,
          standardRateYenPerKwh: standard,
          offPeakRateYenPerKwh: offPeak,
          offPeakSavingsEnabled: mode !== "simple",
          co2TonnesPerKwh: Number(data.get("co2")),
          rateBands:
            mode === "multi"
              ? bands
              : [
                  {
                    start: mode === "offPeak" ? "07:00" : "00:00",
                    end: mode === "offPeak" ? "23:00" : "00:00",
                    yenPerKwh: standard,
                    label: "Standard",
                  },
                  ...(mode === "offPeak"
                    ? [
                        {
                          start: "23:00",
                          end: "07:00",
                          yenPerKwh: offPeak,
                          label: "Off-peak",
                        },
                      ]
                    : []),
                ],
        },
        "Rate and emissions settings saved.",
      ),
    );
  };
  const fuel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setFuelResult(
      await save(
        {
          fuelCell: {
            includeInAdaptiveCharging: data.has("include"),
            gasCo2KgPerM3: Number(data.get("gasCo2")),
            tariff: {
              provider: "tokyo-gas",
              region: String(data.get("region")),
              plan: "enefarm",
              equipmentDiscount: String(data.get("discount")),
              meterReadingDay: Number(data.get("readingDay")),
              automaticUpdates: data.has("automatic"),
              marginalRateOverrideYenPerM3: optionalNumber(
                data.get("marginal"),
              ),
            },
          },
        },
        "Ene-Farm tariff assumptions saved.",
      ),
    );
  };
  const updateBand = (
    index: number,
    field: "start" | "end" | "label" | "yenPerKwh",
    value: string,
  ) =>
    setBands((current) =>
      current.map((band, bandIndex) =>
        bandIndex === index
          ? { ...band, [field]: field === "yenPerKwh" ? Number(value) : value }
          : band,
      ),
    );
  const tariffImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const month = String(new FormData(event.currentTarget).get("month"));
    if (config.runtime?.externalIoDisabled) {
      setTariffResult({
        ok: false,
        message:
          "Published tariff import is disabled in simulator development.",
      });
      return;
    }
    try {
      const imported = await importGasTariff(month);
      setTariffResult({
        ok: true,
        message: `${imported.billingMonth} tariff imported.`,
      });
    } catch (error) {
      setTariffResult({
        ok: false,
        message: error instanceof Error ? error.message : "Import failed",
      });
    }
  };
  return (
    <div className="system-stack">
      <form className="panel system-form" onSubmit={submit}>
        <div className="section-heading">
          <div>
            <h2>
              {t("electricityRates")}
            </h2>
            <p>
              {t("ratesDriveEstimatedSavingsAndAdaptiveChargingWindowSelec1cfa1e")}
            </p>
          </div>
        </div>
        <fieldset>
          <legend>
            {t("rateMode")}
          </legend>
          <div className="system-toggle-grid">
            {(["simple", "offPeak", "multi"] as const).map((item) => (
              <label key={item}>
                <input
                  name="rateMode"
                  type="radio"
                  value={item}
                  checked={mode === item}
                  onChange={() => setMode(item)}
                />{" "}
                {item === "offPeak"
                  ? "Off-peak"
                  : item === "multi"
                    ? "Multi-rate"
                    : "Simple"}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="automation-form-grid">
          <label className="field">
            {t("standardRate")}
            <div className="input-suffix">
              <input
                name="standardRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.standardRateYenPerKwh}
              />
              <span>
                {t("kwh")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("discountedRate")}
            <div className="input-suffix">
              <input
                name="offPeakRate"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.offPeakRateYenPerKwh}
              />
              <span>
                {t("kwh")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("gridEmissionsFactor")}
            <div className="input-suffix">
              <input
                name="co2"
                type="number"
                min="0"
                step=".000001"
                defaultValue={config.co2TonnesPerKwh}
              />
              <span>
                {t("tKWh")}
              </span>
            </div>
          </label>
        </div>
        {mode === "multi" ? (
          <fieldset>
            <legend>
              {t("rateBands")}
            </legend>
            <div className="rate-band-editor">
              {bands.map((band, index) => (
                <div key={index}>
                  <input
                    aria-label={`Band ${index + 1} label`}
                    value={band.label ?? ""}
                    onChange={(event) =>
                      updateBand(index, "label", event.target.value)
                    }
                    placeholder="Label"
                  />
                  <input
                    aria-label={`Band ${index + 1} start`}
                    type="time"
                    value={band.start}
                    onChange={(event) =>
                      updateBand(index, "start", event.target.value)
                    }
                  />
                  <input
                    aria-label={`Band ${index + 1} end`}
                    type="time"
                    value={band.end}
                    onChange={(event) =>
                      updateBand(index, "end", event.target.value)
                    }
                  />
                  <input
                    aria-label={`Band ${index + 1} rate`}
                    type="number"
                    min="0"
                    step=".01"
                    value={band.yenPerKwh}
                    onChange={(event) =>
                      updateBand(index, "yenPerKwh", event.target.value)
                    }
                  />
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() =>
                      setBands((current) =>
                        current.filter((_, bandIndex) => bandIndex !== index),
                      )
                    }
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
            <button
              className="quiet-button"
              type="button"
              onClick={() =>
                setBands((current) => [
                  ...current,
                  {
                    start: "23:00",
                    end: "07:00",
                    yenPerKwh: config.offPeakRateYenPerKwh ?? 25,
                    label: "Custom",
                  },
                ])
              }
            >
              {t("addRateBand")}
            </button>
          </fieldset>
        ) : null}
        <div className="form-footer">
          <button className="button primary">
            {t("saveRates")}
          </button>
          <ResultMessage result={rateResult} />
        </div>
      </form>
      <form
        className="panel system-form"
        key={`fuel:${JSON.stringify(config.fuelCell)}`}
        onSubmit={fuel}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("eneFarmAssumptions")}
            </h2>
            <p>
              {t("usedForGasCostAndCarbonEstimatesTheApplicationNeverContr5d9b66")}
            </p>
          </div>
        </div>
        <label className="automation-toggle compact">
          <input
            name="include"
            type="checkbox"
            defaultChecked={config.fuelCell?.includeInAdaptiveCharging}
          />
          <span>
            <strong>
              {t("includeObservedEneFarmGenerationInPlanning")}
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            {t("gasRegion")}
            <select
              name="region"
              defaultValue={config.fuelCell?.tariff?.region ?? "tokyo"}
            >
              <option value="tokyo">
                {t("tokyoDistrict")}
              </option>
              <option value="gunma">
                {t("gunmaDistrict")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("meterReadingDay")}
            <input
              name="readingDay"
              type="number"
              min="1"
              max="31"
              defaultValue={config.fuelCell?.tariff?.meterReadingDay ?? 1}
            />
          </label>
          <label className="field">
            {t("equipmentDiscount")}
            <select
              name="discount"
              defaultValue={config.fuelCell?.tariff?.equipmentDiscount ?? ""}
            >
              <option value="">
                {t("none")}
              </option>
              <option value="bath">
                {t("bathHeating")}
              </option>
              <option value="floor">
                {t("floorHeating")}
              </option>
              <option value="set">
                {t("combinedBathFloor")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("gasEmissions")}
            <div className="input-suffix">
              <input
                name="gasCo2"
                type="number"
                min="0"
                step=".01"
                defaultValue={config.fuelCell?.gasCo2KgPerM3 ?? 2.21}
              />
              <span>
                {t("kgM")}
              </span>
            </div>
          </label>
          <label className="field">
            {t("marginalRateOverride")}
            <input
              name="marginal"
              type="number"
              min="0"
              step=".01"
              defaultValue={
                config.fuelCell?.tariff?.marginalRateOverrideYenPerM3 ?? ""
              }
            />
          </label>
        </div>
        <label className="automation-toggle compact">
          <input
            name="automatic"
            type="checkbox"
            defaultChecked={config.fuelCell?.tariff?.automaticUpdates}
          />
          <span>
            <strong>
              {t("automaticallyImportMonthlyTariffs")}
            </strong>
            <small>
              {t("requiresExternalAccessOutsideSimulatorDevelopment")}
            </small>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            {t("saveEneFarmAssumptions")}
          </button>
          <ResultMessage result={fuelResult} />
        </div>
      </form>
      <form className="panel system-form" onSubmit={tariffImport}>
        <div className="section-heading">
          <div>
            <h2>
              {t("publishedGasTariff")}
            </h2>
            <p>
              {t("importTheSelectedBillingMonthFromTheConfiguredProvider")}
            </p>
          </div>
        </div>
        <label className="field">
          {t("billingMonth")}
          <input
            name="month"
            type="month"
            required
            defaultValue={new Date().toISOString().slice(0, 7)}
          />
        </label>
        <div className="form-footer">
          <button
            className="quiet-button"
            disabled={config.runtime?.externalIoDisabled}
          >
            {t("importPublishedTariff")}
          </button>
          <ResultMessage result={tariffResult} />
        </div>
      </form>
    </div>
  );
}
