import { useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig } from "../../../api/contracts";
import { useTranslation } from "react-i18next";
import { widgetLabels } from "./widget-labels.js";
import type { Result, SaveSettings } from "./types.js";
import { ResultMessage } from "./ResultMessage.js";

export function Preferences({
  config,
  save,
}: {
  config: AppConfig;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setResult(
      await save(
        {
          updateIntervalSeconds: Number(data.get("interval")),
          language: String(data.get("language")) as "en" | "ja",
          dashboardWidgets: config.dashboardWidgets?.map((widget) => ({
            ...widget,
            visible: data.has(`widget:${widget.id}`),
          })),
        },
        "Preferences saved.",
      ),
    );
  };
  return (
    <form
      className="panel system-form"
      key={JSON.stringify(config.dashboardWidgets)}
      onSubmit={submit}
    >
      <div className="section-heading">
        <div>
          <h2>
            {t("applicationPreferences")}
          </h2>
          <p>
            {t("languageAndRegionalNumberAndDateFormattingApplyAfterSavi6572af")}
          </p>
        </div>
      </div>
      <div className="automation-form-grid">
        <label className="field">
          {t("language")}
          <select name="language" defaultValue={config.language}>
            <option value="en">
              {t("english")}
            </option>
            <option value="ja">
              {t("message")}
            </option>
          </select>
        </label>
        <label className="field">
          {t("refreshInterval")}
          <div className="input-suffix">
            <input
              name="interval"
              type="number"
              min="5"
              max="3600"
              defaultValue={config.updateIntervalSeconds}
            />
            <span>
              {t("sec")}
            </span>
          </div>
        </label>
      </div>
      <fieldset>
        <legend>
          {t("overviewVisibility")}
        </legend>
        <p className="field-help">
          {t("chooseWhichOptionalItemsAppearOnOverview")}
        </p>
        <div className="widget-visibility-grid">
          {config.dashboardWidgets?.map((widget) => (
            <label key={widget.id}>
              <input
                name={`widget:${widget.id}`}
                type="checkbox"
                defaultChecked={widget.visible}
              />
              <span>
                {t(
                  widgetLabels[widget.id] ??
                    widget.id.replace(/([A-Z])/g, " $1"),
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-footer">
        <button className="button primary">
          {t("savePreferences")}
        </button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
