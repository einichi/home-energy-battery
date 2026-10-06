import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnergyFlow, computeFlowConnectors } from "./EnergyFlow";
import type { FlowVisibility } from "./EnergyFlow";

type Rect = { left: number; top: number; right: number; bottom: number };

function endpoints(path: string) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return {
    start: { x: numbers[0], y: numbers[1] },
    end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] },
  };
}

const desktopRects: Record<string, Rect> = {
  solar: { left: 0, top: 0, right: 100, bottom: 60 },
  fuel: { left: 0, top: 100, right: 100, bottom: 160 },
  battery: { left: 0, top: 200, right: 100, bottom: 260 },
  home: { left: 250, top: 50, right: 350, bottom: 250 },
  grid: { left: 500, top: 50, right: 600, bottom: 250 },
};

const mobileRects: Record<string, Rect> = {
  solar: { left: 0, top: 0, right: 150, bottom: 80 },
  fuel: { left: 170, top: 0, right: 320, bottom: 80 },
  home: { left: 0, top: 160, right: 320, bottom: 260 },
  battery: { left: 0, top: 320, right: 150, bottom: 400 },
  grid: { left: 170, top: 320, right: 320, bottom: 400 },
};

const visible: FlowVisibility = {
  solar: 850,
  fuelCell: 650,
  battery: -480,
  gridImport: 920,
  gridExport: 0,
  showSolar: true,
  showFuelCell: true,
  showBattery: true,
  showGrid: true,
};

function connector(result: ReturnType<typeof computeFlowConnectors>, id: string) {
  const found = result.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id} connector`);
  return found;
}

describe("computeFlowConnectors", () => {
  it("anchors every desktop arrow to the measured node edges", () => {
    const connectors = computeFlowConnectors(desktopRects, visible, false);
    const home = desktopRects.home;

    expect(endpoints(connector(connectors, "solar").path).end).toEqual({ x: home.left, y: home.top + (home.bottom - home.top) * 0.3 });
    expect(endpoints(connector(connectors, "fuel").path).end).toEqual({ x: home.left, y: home.top + (home.bottom - home.top) * 0.5 });
    expect(endpoints(connector(connectors, "battery").path)).toEqual({
      start: { x: desktopRects.battery.right, y: (desktopRects.battery.top + desktopRects.battery.bottom) / 2 },
      end: { x: home.left, y: home.top + (home.bottom - home.top) * 0.7 },
    });
    expect(endpoints(connector(connectors, "grid").path)).toEqual({
      start: { x: desktopRects.grid.left, y: (desktopRects.grid.top + desktopRects.grid.bottom) / 2 },
      end: { x: home.right, y: (home.top + home.bottom) / 2 },
    });
    expect(connector(connectors, "grid").target).toBe(".flow-home");
  });

  it("reverses the desktop battery connector for charging", () => {
    const charging = computeFlowConnectors(desktopRects, { ...visible, battery: 480 }, false);
    const battery = connector(charging, "battery");
    expect(battery.target).toBe(".flow-battery");
    expect(endpoints(battery.path).start).toEqual({ x: desktopRects.home.left, y: desktopRects.home.top + (desktopRects.home.bottom - desktopRects.home.top) * 0.7 });
    expect(endpoints(battery.path).end).toEqual({ x: desktopRects.battery.right, y: (desktopRects.battery.top + desktopRects.battery.bottom) / 2 });
  });

  it("anchors every mobile arrow to the measured node edges", () => {
    const connectors = computeFlowConnectors(mobileRects, { ...visible, battery: 480, gridImport: 0, gridExport: 3000 }, true);
    const home = mobileRects.home;
    const solarCenter = (mobileRects.solar.left + mobileRects.solar.right) / 2;
    const fuelCenter = (mobileRects.fuel.left + mobileRects.fuel.right) / 2;
    const batteryCenter = (mobileRects.battery.left + mobileRects.battery.right) / 2;
    const gridCenter = (mobileRects.grid.left + mobileRects.grid.right) / 2;

    expect(endpoints(connector(connectors, "solar").path)).toEqual({
      start: { x: solarCenter, y: mobileRects.solar.bottom },
      end: { x: solarCenter, y: home.top },
    });
    expect(endpoints(connector(connectors, "fuel").path)).toEqual({
      start: { x: fuelCenter, y: mobileRects.fuel.bottom },
      end: { x: fuelCenter, y: home.top },
    });
    expect(connector(connectors, "battery").target).toBe(".flow-battery");
    expect(endpoints(connector(connectors, "battery").path)).toEqual({
      start: { x: batteryCenter, y: home.bottom },
      end: { x: batteryCenter, y: mobileRects.battery.top },
    });
    expect(connector(connectors, "grid").target).toBe(".flow-grid");
    expect(endpoints(connector(connectors, "grid").path)).toEqual({
      start: { x: gridCenter, y: home.bottom },
      end: { x: gridCenter, y: mobileRects.grid.top },
    });
  });

  it("reverses the mobile battery and grid connectors when power flows in", () => {
    const connectors = computeFlowConnectors(mobileRects, { ...visible, battery: -480, gridImport: 920, gridExport: 0 }, true);
    const batteryCenter = (mobileRects.battery.left + mobileRects.battery.right) / 2;
    const gridCenter = (mobileRects.grid.left + mobileRects.grid.right) / 2;
    expect(connector(connectors, "battery").target).toBe(".flow-home");
    expect(endpoints(connector(connectors, "battery").path)).toEqual({
      start: { x: batteryCenter, y: mobileRects.battery.top },
      end: { x: batteryCenter, y: mobileRects.home.bottom },
    });
    expect(connector(connectors, "grid").target).toBe(".flow-home");
    expect(endpoints(connector(connectors, "grid").path)).toEqual({
      start: { x: gridCenter, y: mobileRects.grid.top },
      end: { x: gridCenter, y: mobileRects.home.bottom },
    });
  });

  it("marks a connector active only while power is flowing", () => {
    const idle = computeFlowConnectors(mobileRects, { ...visible, battery: 0, gridImport: 0 }, true);
    expect(connector(idle, "battery").active).toBe(false);
    expect(connector(idle, "grid").active).toBe(false);
    expect(connector(idle, "battery").path.length).toBeGreaterThan(0);
  });

  it("omits connectors when the destination node is not rendered", () => {
    expect(computeFlowConnectors({ solar: desktopRects.solar }, visible, false)).toEqual([]);
  });
});

function domRect(rect: Rect): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    toJSON: () => rect,
  } as DOMRect;
}

function mockLayout(rects: Record<string, Rect>, container: Rect, mobile = false) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
    if (this.classList.contains("energy-flow")) return domRect(container);
    for (const id of ["solar", "fuel", "battery", "home", "grid"]) {
      if (this.classList.contains(`flow-${id}`)) return domRect(rects[id]);
    }
    return domRect({ left: 0, top: 0, right: 0, bottom: 0 });
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const baseProps = {
  solar: 850,
  fuelCell: 650,
  demand: 1400,
  gridImport: 920,
  gridExport: 0,
};

describe("EnergyFlow", () => {
  it("renders fixed-size, self-consistent arrowheads once the layout is measured", () => {
    mockLayout(desktopRects, { left: 0, top: 0, right: 600, bottom: 300 });
    const { container } = render(<EnergyFlow {...baseProps} battery={480} />);
    const markers = container.querySelectorAll(".flow-lines marker");

    expect(markers).toHaveLength(4);
    markers.forEach((marker) => {
      expect(marker).toHaveAttribute("markerUnits", "userSpaceOnUse");
      expect(marker).toHaveAttribute("markerWidth", "14");
      expect(marker).toHaveAttribute("markerHeight", "14");
      expect(marker).toHaveAttribute("refX", "10");
    });
  });

  it("points imported grid power toward the home and scales active paths by magnitude", () => {
    mockLayout(desktopRects, { left: 0, top: 0, right: 600, bottom: 300 });
    const { container } = render(<EnergyFlow {...baseProps} battery={0} />);
    const solar = container.querySelector(".flow-lines .flow-path-solar");
    const grid = container.querySelector(".flow-lines .flow-path-grid");

    expect(grid).toHaveAttribute("marker-end", "url(#flow-arrow-grid)");
    expect(grid).not.toHaveAttribute("marker-start");
    expect(grid).toHaveAttribute("data-target", ".flow-home");
    expect(endpoints(grid?.getAttribute("d") ?? "").end).toEqual({ x: desktopRects.home.right, y: 150 });
    expect(Number.parseFloat((grid as SVGPathElement).style.getPropertyValue("--flow-width"))).toBeGreaterThan(
      Number.parseFloat((solar as SVGPathElement).style.getPropertyValue("--flow-width")),
    );
  });

  it("reverses the battery connector for charging and discharging", () => {
    mockLayout(desktopRects, { left: 0, top: 0, right: 600, bottom: 300 });
    const { container, rerender } = render(<EnergyFlow {...baseProps} battery={480} />);
    let battery = container.querySelector(".flow-lines .flow-path-battery");
    expect(screen.getByText("Battery charging")).toBeInTheDocument();
    expect(battery).toHaveAttribute("marker-end", "url(#flow-arrow-battery)");
    expect(battery).toHaveAttribute("data-target", ".flow-battery");

    rerender(<EnergyFlow {...baseProps} battery={-480} />);
    battery = container.querySelector(".flow-lines .flow-path-battery");
    expect(screen.getByText("Battery discharging")).toBeInTheDocument();
    expect(battery).toHaveAttribute("marker-end", "url(#flow-arrow-battery)");
    expect(battery).toHaveAttribute("data-target", ".flow-home");
  });

  it("uses the mobile anchors below the responsive breakpoint", () => {
    mockLayout(mobileRects, { left: 0, top: 0, right: 320, bottom: 420 }, true);
    const { container } = render(<EnergyFlow {...baseProps} battery={480} />);
    const battery = container.querySelector(".flow-lines .flow-path-battery");
    expect(battery).toHaveAttribute("data-target", ".flow-battery");
    const batteryCenter = (mobileRects.battery.left + mobileRects.battery.right) / 2;
    expect(endpoints(battery?.getAttribute("d") ?? "").start).toEqual({ x: batteryCenter, y: mobileRects.home.bottom });
  });
});
