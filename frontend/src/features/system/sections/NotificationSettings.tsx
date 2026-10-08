import { useState } from "react";
import type { FormEvent } from "react";
import type { NotificationView } from "../../../api/contracts";
import { saveNotifications, testNotifications } from "../../../api/system";
import { useEnergyStatus } from "../../../hooks/useEnergyStatus";
import { formatDateTime, formatDateTimesInText } from "../../../core/format";
import { useTranslation } from "react-i18next";
import type { Result } from "./types.js";
import { ResultMessage } from "./ResultMessage.js";
import { entries } from "./form-utils.js";

export function NotificationSettings({
  initial,
  setView,
  simulator,
}: {
  initial: NotificationView;
  setView: (value: NotificationView) => void;
  simulator: boolean;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const { config: appConfig, replaceConfig } = useEnergyStatus();
  const channel = initial.config.channels[0];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const config = {
        ...initial.config,
        enabled: data.has("enabled"),
        channels: [
          {
            ...channel,
            settings: {
              ...channel.settings,
              host: String(data.get("host")),
              port: Number(data.get("port")),
              security: String(data.get("security")),
              username: String(data.get("username")),
              from: String(data.get("from")),
              recipients: entries(data.get("recipients")),
            },
          },
        ],
        triggers: Object.fromEntries(
          Object.entries(initial.config.triggers).map(([key, trigger]) => [
            key,
            {
              ...trigger,
              enabled: data.has(`trigger:${key}`),
              cooldownMinutes: Number(data.get(`cooldown:${key}`)),
              ...(key === "lowBattery"
                ? { thresholdPercent: Number(data.get(`threshold:${key}`)) }
                : {}),
            },
          ]),
        ),
      };
      const view = await saveNotifications({
        config,
        password: String(data.get("password") || "") || undefined,
        clearPassword: data.has("clearPassword"),
      });
      setView(view);
      // Keep the shared config in sync so a later full-config save does not
      // overwrite the notification settings we just persisted.
      if (appConfig) replaceConfig({ ...appConfig, notifications: view.config });
      const warning = (view as unknown as { warning?: unknown }).warning;
      setResult({ ok: true, message: typeof warning === "string" ? `Notification settings saved. ${warning}` : "Notification settings saved." });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Save failed",
      });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await testNotifications();
      setResult({ ok: true, message: "Test email sent." });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Test failed",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="system-stack">
      <form
        className="panel system-form"
        key={JSON.stringify(initial.config)}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("emailNotifications")}
            </h2>
            <p>
              {simulator
                ? "Delivery tests are disabled by the simulator safety boundary."
                : "Send important equipment and automation events by email."}
            </p>
          </div>
          <span className="sample-count">
            {"" + t("password") + " "}
            {initial.passwordConfigured ? "stored" : "not stored"}
          </span>
        </div>
        <label className="automation-toggle">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={initial.config.enabled}
          />
          <span>
            <strong>
              {t("enableNotifications")}
            </strong>
          </span>
        </label>
        <div className="automation-form-grid">
          <label className="field">
            {t("smtpServer")}
            <input name="host" defaultValue={channel?.settings.host} />
          </label>
          <label className="field">
            {t("port")}
            <select name="port" defaultValue={channel?.settings.port ?? 587}>
              <option value="25">25 — SMTP / STARTTLS</option>
              <option value="465">465 — Implicit TLS</option>
              <option value="587">587 — Submission / STARTTLS</option>
            </select>
            <small>Use 465 with TLS; 25 and 587 normally use STARTTLS.</small>
          </label>
          <label className="field">
            {t("security")}
            <select
              name="security"
              defaultValue={channel?.settings.security ?? "starttls"}
            >
              <option value="starttls">
                {t("starttls")}
              </option>
              <option value="tls">
                {t("tls")}
              </option>
              <option value="none">
                {t("none")}
              </option>
            </select>
          </label>
          <label className="field">
            {t("username")}
            <input
              name="username"
              autoComplete="username"
              defaultValue={channel?.settings.username}
            />
          </label>
          <label className="field">
            {t("password")}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep saved password"
            />
          </label>
          <label className="field">
            {t("fromAddress")}
            <input
              name="from"
              type="email"
              defaultValue={channel?.settings.from}
            />
          </label>
          <label className="field span-two">
            {t("recipients")}
            <input
              name="recipients"
              defaultValue={channel?.settings.recipients?.join(", ")}
            />
          </label>
        </div>
        {initial.passwordConfigured ? (
          <label className="automation-toggle compact">
            <input name="clearPassword" type="checkbox" />
            <span>
              <strong>
                {t("removeSavedSMTPPassword")}
              </strong>
            </span>
          </label>
        ) : null}
        <fieldset>
          <legend>
            {t("eventTriggers")}
          </legend>
          <p className="field-help">{t("cooldownMin")}</p>
          <div className="trigger-grid">
            {Object.entries(initial.config.triggers).map(([key, trigger]) => (
              <div className="trigger-row" key={key}>
                <label>
                  <input
                    name={`trigger:${key}`}
                    type="checkbox"
                    defaultChecked={trigger.enabled}
                  />
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                </label>
                <label>
                  <input
                    aria-label={`${key} cooldown`}
                    name={`cooldown:${key}`}
                    type="number"
                    min="0"
                    max="10080"
                    defaultValue={trigger.cooldownMinutes}
                  />
                </label>
                {key === "lowBattery" ? (
                  <label>
                    <span>
                      {t("threshold")}
                    </span>
                    <div className="input-suffix">
                      <input
                        aria-label="Low battery threshold"
                        name={`threshold:${key}`}
                        type="number"
                        min="1"
                        max="95"
                        defaultValue={trigger.thresholdPercent ?? 20}
                      />
                      <span>%</span>
                    </div>
                  </label>
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>
        <div className="form-footer">
          <button className="button primary" disabled={busy}>
            {t("saveNotifications")}
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={busy || simulator}
            onClick={() => void test()}
          >
            {t("sendTestEmail")}
          </button>
          <ResultMessage result={result} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("recentDeliveries")}
            </h2>
            <p>
              {t("deliveryOutcomeEventDestinationChannelAndFailureDetail")}
            </p>
          </div>
          {initial.deliveries?.length ? <span className="sample-count">{initial.deliveries.length} {" " + t("records") + ""}</span> : null}
        </div>
        <div className="notification-deliveries">
          {initial.deliveries?.length ? (
            initial.deliveries.map((delivery, index) => (
              <article key={`${delivery.at}:${index}`} data-ok={delivery.ok}>
                <time>
                  {delivery.at
                    ? formatDateTime(delivery.at)
                    : "Unknown time"}
                </time>
                <strong>
                  {delivery.ok ? "Delivered" : "Failed"} ·{" "}
                  {delivery.event?.title ??
                    delivery.event?.type ??
                    "Notification"}
                </strong>
                <span>
                  {delivery.attempts
                    ?.map(
                      (attempt) => formatDateTimesInText(attempt.error) || attempt.channelId || "SMTP",
                    )
                    .join(" · ") || "No attempt detail"}
                </span>
              </article>
            ))
          ) : (
            <p>
              {t("noNotificationDeliveriesAreRecorded")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
