import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatDateTime, formatDateTimesInText } from "../core/format";
import { useSystemHealth } from "../hooks/useSystemHealth";
import { useTranslation } from "react-i18next";

export function HealthCenter() {
  const health = useSystemHealth();
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="health-center">
      <button className="health-summary" data-severity={health.severity} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        <span className="health-dot" aria-hidden="true" />
        <span>
          <strong>{t(health.label)}</strong>
          <small>{t(health.detail)}</small>
        </span>
      </button>
      {open ? <section className="health-alert-center" id={panelId} aria-label={t("systemAlerts")}>
        <div className="health-alert-heading"><strong>{t("systemAlerts")}</strong><button type="button" onClick={() => setOpen(false)} aria-label={t("closeAlerts")}>{t("×")}</button></div>
        {health.alerts.length ? <ol>{health.alerts.map((alert) => <li key={alert.id} data-severity={alert.severity}>
          <div><strong>{t(alert.title)}</strong><time dateTime={alert.startedAt}>{formatDateTime(alert.startedAt)}</time></div>
          <div className="health-alert-meta">
            {alert.source ? <span className="health-alert-source">{t(alert.source)}</span> : null}
            <span className="health-alert-resolution">{t("active")}</span>
          </div>
          <p>{formatDateTimesInText(t(alert.impact))}</p>
          <small>{formatDateTimesInText(t(alert.suggestedAction))}</small>
          {alert.href ? <Link to={alert.href} onClick={() => setOpen(false)}>{t("review")}</Link> : null}
        </li>)}</ol> : <p className="health-empty">{t("noActiveAlertsAllConfiguredSystemsAreReportingNormally")}</p>}
      </section> : null}
    </div>
  );
}
