import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { formatPower } from "../core/format";
import { useTranslation } from "react-i18next";

type FlowTone = "solar" | "fuel" | "battery" | "home" | "grid";
type NodeId = FlowTone;
type ConnectorId = Exclude<NodeId, "home">;
type FlowTarget = ".flow-home" | ".flow-battery" | ".flow-grid";

type Rect = { left: number; top: number; right: number; bottom: number };

export type FlowVisibility = {
  solar: number | null;
  fuelCell: number | null;
  battery: number | null;
  gridImport: number | null;
  gridExport: number | null;
  showSolar: boolean;
  showFuelCell: boolean;
  showBattery: boolean;
  showGrid: boolean;
};

export type FlowConnector = {
  id: ConnectorId;
  className: string;
  target: FlowTarget;
  path: string;
  active: boolean;
  weight: number;
};

/** Breakpoint must stay in sync with the `.energy-flow` media query in components.css. */
const MOBILE_QUERY = "(max-width: 680px)";

function batteryState(power: number | null) {
  if (power === null) return "Battery";
  if (power > 0) return "Battery charging";
  if (power < 0) return "Battery discharging";
  return "Battery idle";
}

function flowWeight(power: number | null) {
  if (power === null || power === 0) return 1.75;
  return Math.min(4.25, 1.75 + Math.abs(power) / 1_350);
}

const round = (value: number) => Math.round(value * 100) / 100;
const center = (rect: Rect) => ({ x: round((rect.left + rect.right) / 2), y: round((rect.top + rect.bottom) / 2) });
const height = (rect: Rect) => round(rect.bottom - rect.top);

/** Horizontal cubic that leaves the first point moving horizontally and enters the second the same way. */
function horizontalCurve(x1: number, y1: number, x2: number, y2: number) {
  const mid = round((x1 + x2) / 2);
  return `M ${round(x1)} ${round(y1)} C ${mid} ${round(y1)}, ${mid} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}

/** Vertical cubic that leaves the first point moving vertically and enters the second the same way. */
function verticalCurve(x1: number, y1: number, x2: number, y2: number) {
  const mid = round((y1 + y2) / 2);
  return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${mid}, ${round(x2)} ${mid}, ${round(x2)} ${round(y2)}`;
}

/**
 * Builds the connector geometry from the measured node rectangles. Using real measurements
 * (instead of hard-coded viewBox fractions) keeps arrows anchored to their nodes at every
 * width, locale, and content-wrap combination.
 */
export function computeFlowConnectors(rects: Partial<Record<NodeId, Rect>>, state: FlowVisibility, mobile: boolean): FlowConnector[] {
  const home = rects.home;
  if (!home) return [];
  const homeCenter = center(home);
  const homeTop = home.top;
  const homeBottom = home.bottom;
  const homeLeft = home.left;
  const homeRight = home.right;
  const connectors: FlowConnector[] = [];
  const add = (id: ConnectorId, className: string, target: FlowTarget, path: string, power: number | null) => {
    connectors.push({ id, className, target, path, active: power !== null && Math.abs(power) > 0, weight: flowWeight(power) });
  };

  const solar = rects.solar;
  if (state.showSolar && solar) {
    const source = center(solar);
    add(
      "solar",
      "flow-path-solar",
      ".flow-home",
      mobile
        ? verticalCurve(source.x, solar.bottom, source.x, homeTop)
        : horizontalCurve(solar.right, source.y, homeLeft, homeTop + height(home) * 0.3),
      state.solar,
    );
  }

  const fuel = rects.fuel;
  if (state.showFuelCell && fuel) {
    const source = center(fuel);
    add(
      "fuel",
      "flow-path-fuel",
      ".flow-home",
      mobile
        ? verticalCurve(source.x, fuel.bottom, source.x, homeTop)
        : horizontalCurve(fuel.right, source.y, homeLeft, homeTop + height(home) * 0.5),
      state.fuelCell,
    );
  }

  const battery = rects.battery;
  if (state.showBattery && battery) {
    const source = center(battery);
    const charging = state.battery !== null && state.battery > 0;
    if (mobile) {
      add(
        "battery",
        "flow-path-battery",
        charging ? ".flow-battery" : ".flow-home",
        charging
          ? verticalCurve(source.x, homeBottom, source.x, battery.top)
          : verticalCurve(source.x, battery.top, source.x, homeBottom),
        state.battery,
      );
    } else {
      const batteryPort = homeTop + height(home) * 0.7;
      add(
        "battery",
        "flow-path-battery",
        charging ? ".flow-battery" : ".flow-home",
        charging
          ? horizontalCurve(homeLeft, batteryPort, battery.right, source.y)
          : horizontalCurve(battery.right, source.y, homeLeft, batteryPort),
        state.battery,
      );
    }
  }

  const grid = rects.grid;
  if (state.showGrid && grid) {
    const source = center(grid);
    const exporting = state.gridExport !== null && state.gridExport > 0;
    const power = exporting ? state.gridExport : state.gridImport;
    if (mobile) {
      add(
        "grid",
        "flow-path-grid",
        exporting ? ".flow-grid" : ".flow-home",
        exporting
          ? verticalCurve(source.x, homeBottom, source.x, grid.top)
          : verticalCurve(source.x, grid.top, source.x, homeBottom),
        power,
      );
    } else {
      add(
        "grid",
        "flow-path-grid",
        exporting ? ".flow-grid" : ".flow-home",
        exporting
          ? horizontalCurve(homeRight, homeCenter.y, grid.left, source.y)
          : horizontalCurve(grid.left, source.y, homeRight, homeCenter.y),
        power,
      );
    }
  }

  return connectors;
}

function FlowIcon({ type }: { type: FlowTone }) {
  const common = { viewBox: "0 0 24 24", "aria-hidden": true } as const;
  if (type === "solar") {
    return <svg {...common}><circle cx="12" cy="12" r="3.25" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>;
  }
  if (type === "fuel") {
    return <svg {...common}><path d="M13.1 2.8c.7 3.7-2.9 4.8-2.2 8.1.5-1.3 1.5-2.2 2.9-2.9 1.7 2 3.2 4.1 3.2 6.8a5 5 0 0 1-10 0c0-3.4 2.5-6.2 6.1-12Z" /><path d="M12.1 12.4c1.2 1.4 2 2.4 2 3.7a2.1 2.1 0 0 1-4.2 0c0-1.2.8-2.4 2.2-3.7Z" /></svg>;
  }
  if (type === "battery") {
    return <svg {...common}><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M21 10v4M7 12h8" /></svg>;
  }
  if (type === "grid") {
    return <svg {...common}><path d="M8 21 11.2 3h1.6L16 21M6.8 10h10.4M5.8 15h12.4M8.5 6h7M3 21h18" /></svg>;
  }
  return <svg {...common}><path d="m3.5 11 8.5-7 8.5 7" /><path d="M5.5 9.5V21h13V9.5M9.5 21v-6h5v6" /></svg>;
}

function FlowNode({ node, className, tone, label, value, title, children }: {
  node: NodeId;
  className: string;
  tone: FlowTone;
  label?: ReactNode;
  value: number | null;
  title?: string;
  children?: ReactNode;
}) {
  const formatted = formatPower(value === null ? null : Math.abs(value));
  return (
    <div className={`flow-node ${className}`} data-tone={tone} data-flow-node={node} title={title}>
      <div className="flow-node-heading"><FlowIcon type={tone} /><span>{label ?? children}</span></div>
      <strong key={formatted}>{formatted}</strong>
    </div>
  );
}

function Marker({ id, color, size }: { id: string; color: string; size: number }) {
  return <marker id={id} viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth={size} markerHeight={size} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker>;
}

export function EnergyFlow({ solar, fuelCell, battery, demand, gridImport, gridExport, showSolar = true, showFuelCell = true, showBattery = true, showDemand = true, showGrid = true, demandLabel, demandTitle }: {
  solar: number | null;
  fuelCell: number | null;
  battery: number | null;
  demand: number | null;
  gridImport: number | null;
  gridExport: number | null;
  showSolar?: boolean;
  showFuelCell?: boolean;
  showBattery?: boolean;
  showDemand?: boolean;
  showGrid?: boolean;
  demandLabel?: string;
  demandTitle?: string;
}) {
  const { t } = useTranslation("common");
  const exporting = gridExport !== null && gridExport > 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const lastSignature = useRef("");
  const [, setRevision] = useState(0);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
  const [geometry, setGeometry] = useState<{ width: number; height: number; connectors: FlowConnector[] }>({ width: 0, height: 0, connectors: [] });

  const visible: FlowVisibility = {
    solar,
    fuelCell,
    battery,
    gridImport,
    gridExport,
    showSolar: showSolar && showDemand,
    showFuelCell: showFuelCell && showDemand,
    showBattery: showBattery && showDemand,
    showGrid: showGrid && showDemand,
  };

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRevision((value) => value + 1));
    observer.observe(root);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    let cancelled = false;
    fonts?.ready.then(() => {
      if (!cancelled) setRevision((value) => value + 1);
    }).catch(() => {});
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, []);

  // Re-measure after every render (inputs, locale, wrapping, revision) and only commit when the
  // resulting geometry actually changed, so the signature guard converges instead of looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-measures after every render
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width < 1 || rootRect.height < 1) return;
    const rects: Partial<Record<NodeId, Rect>> = {};
    root.querySelectorAll<HTMLElement>("[data-flow-node]").forEach((element) => {
      const id = element.dataset.flowNode as NodeId | undefined;
      if (!id) return;
      const rect = element.getBoundingClientRect();
      rects[id] = { left: rect.left - rootRect.left, top: rect.top - rootRect.top, right: rect.right - rootRect.left, bottom: rect.bottom - rootRect.top };
    });
    const connectors = computeFlowConnectors(rects, visible, mobile);
    const signature = `${Math.round(rootRect.width)}x${Math.round(rootRect.height)}|${connectors.map((connector) => `${connector.id}:${connector.active ? 1 : 0}:${connector.weight}:${connector.path}`).join(";")}`;
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    setGeometry({ width: rootRect.width, height: rootRect.height, connectors });
  });

  const markerSize = mobile ? 18 : 14;

  return (
    <div ref={rootRef} className="energy-flow" aria-label={t("currentEnergySourcesStorageHomeDemandAndGridExchange")}>
      {geometry.width > 0 && geometry.height > 0 ? (
        <svg
          className="flow-lines"
          width="100%"
          height="100%"
          viewBox={`0 0 ${round(geometry.width)} ${round(geometry.height)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <Marker id="flow-arrow-solar" color="var(--solar)" size={markerSize} />
            <Marker id="flow-arrow-fuel" color="var(--fuel-cell)" size={markerSize} />
            <Marker id="flow-arrow-battery" color="var(--battery)" size={markerSize} />
            <Marker id="flow-arrow-grid" color="var(--grid)" size={markerSize} />
          </defs>
          {geometry.connectors.map((connector) => (
            <path
              key={connector.id}
              className={`flow-path ${connector.className}`}
              data-active={connector.active || undefined}
              data-target={connector.target}
              d={connector.path}
              style={{ "--flow-width": connector.weight } as CSSProperties}
              markerEnd={connector.active ? `url(#flow-arrow-${connector.id})` : undefined}
            />
          ))}
        </svg>
      ) : null}
      {showSolar ? <FlowNode node="solar" className="flow-solar" tone="solar" value={solar}>{t("solar")}</FlowNode> : null}
      {showFuelCell ? <FlowNode node="fuel" className="flow-fuel" tone="fuel" value={fuelCell}>{t("eneFarm")}</FlowNode> : null}
      {showBattery ? <FlowNode node="battery" className="flow-battery" tone="battery" label={t(batteryState(battery))} value={battery} /> : null}
      {showDemand ? <FlowNode node="home" className="flow-home" tone="home" value={demand} label={t(demandLabel ?? "Home")} title={demandTitle} /> : null}
      {showGrid ? <FlowNode node="grid" className="flow-grid" tone="grid" label={t(exporting ? "Grid export" : "Grid import")} value={exporting ? gridExport : gridImport} /> : null}
    </div>
  );
}
