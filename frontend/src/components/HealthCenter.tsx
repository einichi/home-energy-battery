import { useSystemHealth } from "../hooks/useSystemHealth";
import { useI18n } from "../i18n";

export function HealthCenter() {
  const health = useSystemHealth();
  const { text } = useI18n();
  return (
    <div className="health-summary" data-severity={health.severity} role="status">
      <span className="health-dot" aria-hidden="true" />
      <span>
        <strong>{text(health.label)}</strong>
        <small>{text(health.detail)}</small>
      </span>
    </div>
  );
}
