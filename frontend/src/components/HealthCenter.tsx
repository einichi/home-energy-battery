import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatDateTime, formatDateTimesInText } from "../core/format";
import { useSystemHealth } from "../hooks/useSystemHealth";
import { useI18n } from "../i18n";

export function HealthCenter() {
  const health = useSystemHealth();
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="health-center">
      <button className="health-summary" data-severity={health.severity} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        <span className="health-dot" aria-hidden="true" />
        <span>
          <strong>{text(health.label)}</strong>
          <small>{text(health.detail)}</small>
        </span>
      </button>
      {open ? <section className="health-alert-center" id={panelId} aria-label={text("System alerts")}>
        <div className="health-alert-heading"><strong>{text("System alerts")}</strong><button type="button" onClick={() => setOpen(false)} aria-label={text("Close alerts")}>×</button></div>
        {health.alerts.length ? <ol>{health.alerts.map((alert) => <li key={alert.id} data-severity={alert.severity}>
          <div><strong>{text(alert.title)}</strong><time dateTime={alert.startedAt}>{formatDateTime(alert.startedAt)}</time></div>
          <div className="health-alert-meta">
            {alert.source ? <span className="health-alert-source">{text(alert.source)}</span> : null}
            <span className="health-alert-resolution">{text(alert.resolution === "resolved" ? "Resolved" : "Active")}</span>
          </div>
          <p>{formatDateTimesInText(text(alert.impact))}</p>
          <small>{formatDateTimesInText(text(alert.suggestedAction))}</small>
          {alert.href ? <Link to={alert.href} onClick={() => setOpen(false)}>{text("Review →")}</Link> : null}
        </li>)}</ol> : <p className="health-empty">{text("No active alerts. All configured systems are reporting normally.")}</p>}
      </section> : null}
    </div>
  );
}
