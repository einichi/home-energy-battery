import type { ReactNode } from "react";

type MetricProps = {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "solar" | "battery" | "grid" | "fuel-cell";
  state?: "live" | "stale" | "unavailable";
  stateLabel?: string;
  children?: ReactNode;
};

export function Metric({ label, value, detail, tone = "default", state = "live", stateLabel, children }: MetricProps) {
  return (
    <article className="metric" data-tone={tone} data-reading-state={state}>
      <span className="metric-accent" aria-hidden="true" />
      <p>{label}{state !== "live" ? <em>{stateLabel ?? state}</em> : null}</p>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
      {children}
    </article>
  );
}
