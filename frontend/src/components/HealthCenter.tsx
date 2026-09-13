import { useSystemHealth } from "../hooks/useSystemHealth";

export function HealthCenter() {
  const health = useSystemHealth();
  return (
    <div className="health-summary" data-severity={health.severity} role="status">
      <span className="health-dot" aria-hidden="true" />
      <span>
        <strong>{health.label}</strong>
        <small>{health.detail}</small>
      </span>
    </div>
  );
}
