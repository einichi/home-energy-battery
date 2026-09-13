import type { ReactNode } from "react";

type MetricProps = {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "solar" | "battery" | "grid" | "fuel-cell";
  children?: ReactNode;
};

export function Metric({ label, value, detail, tone = "default", children }: MetricProps) {
  return (
    <article className="metric" data-tone={tone}>
      <span className="metric-accent" aria-hidden="true" />
      <p>{label}</p>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
      {children}
    </article>
  );
}
