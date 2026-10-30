import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule } from "../../api/contracts";
import { DemandGuardRestoreControl } from "./DemandGuardRestoreControl";

const api = vi.hoisted(() => ({ restore: vi.fn(), backup: vi.fn() }));
vi.mock("../../api/automation", () => ({ restoreDemandGuard: api.restore }));
vi.mock("../../api/battery", () => ({ getBackupPreparation: api.backup }));
vi.mock("../../hooks/useEnergyStatus", () => ({
  useEnergyStatus: () => ({ status: null, refresh: () => undefined }),
}));

const intervened: AutomationRule[] = [{
  id: "guard", type: "backup-demand-guard", enabled: true,
  conditions: { breakerAmps: 40, restoreBelowAmps: 30, restoreDelaySeconds: 300 },
  state: { awaitingRestore: true },
}];
const monitoring: AutomationRule[] = [{ ...intervened[0], state: { awaitingRestore: false } }];

async function mount(rules = intervened) {
  const focusRef = createRef<HTMLButtonElement>();
  const tree = (next: AutomationRule[]) => <MemoryRouter>
    <button ref={focusRef}>Refresh</button>
    <DemandGuardRestoreControl rules={next} onRestored={(restored) => update(restored)} refreshRules={() => undefined} returnFocusRef={focusRef} />
    <button>Elsewhere</button>
  </MemoryRouter>;
  const view = render(tree(rules));
  const update = (next: AutomationRule[]) => view.rerender(tree(next));
  await act(async () => undefined);
  return { ...view, update };
}

async function restore() {
  const button = screen.getByRole("button", { name: "Return to Auto now" });
  button.focus();
  await act(async () => { fireEvent.click(button); });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.backup.mockResolvedValue({ active: false, allowDemandGuard: true });
  api.restore.mockResolvedValue(monitoring);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("Demand Guard restore lifecycle", () => {
  it("occupies no region before rules load, while monitoring, or when disabled", async () => {
    const view = await mount([]);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    view.update(monitoring);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    view.update([{ ...intervened[0], enabled: false }]);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps success for 30 seconds across polling updates, then hides and preserves keyboard orientation", async () => {
    const view = await mount();
    await restore();
    expect(screen.getByRole("button", { name: "Auto restored" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Auto charging control restored" })).toHaveFocus();
    act(() => vi.advanceTimersByTime(15_000));
    view.update(monitoring.map((rule) => ({ ...rule })));
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.getByRole("region")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("does not steal focus from elsewhere when the success expires", async () => {
    await mount();
    await restore();
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("a new intervention cancels old success dismissal and does not resurrect the old message on recovery", async () => {
    const view = await mount();
    await restore();
    act(() => vi.advanceTimersByTime(29_000));
    await act(async () => view.update(intervened));
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByRole("button", { name: "Return to Auto now" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Auto restored" })).not.toBeInTheDocument();
    view.update(monitoring);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps a failed restoration actionable beyond the success timeout and allows a successful retry", async () => {
    api.restore.mockRejectedValueOnce(new Error("Device did not confirm Auto"));
    await mount();
    await restore();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry restoration" });
    expect(retry).toBeEnabled();
    await act(async () => fireEvent.click(retry));
    expect(screen.getByRole("button", { name: "Auto restored" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers policy review rather than a restore action when Backup Preparation blocks restoration", async () => {
    api.backup.mockResolvedValue({ active: true, allowDemandGuard: false });
    await mount();
    expect(screen.getByRole("link", { name: "Review Backup Preparation" })).toHaveAttribute("href", "/battery/backup");
    expect(screen.queryByRole("button", { name: "Return to Auto now" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("region")).toBeVisible();
  });

  it("starts a recovery countdown from the current clock after a long hidden period", async () => {
    const view = await mount(monitoring);
    act(() => vi.advanceTimersByTime(600_000));
    await act(async () => view.update([{ ...intervened[0], state: { awaitingRestore: true, restoreSince: new Date().toISOString() } }]));
    expect(screen.getByText("5:00")).toBeVisible();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("4:59")).toBeVisible();
  });

  it("rechecks Backup Preparation when refreshed rules arrive without a new status timestamp", async () => {
    const view = await mount();
    api.backup.mockResolvedValue({ active: true, allowDemandGuard: false });
    await act(async () => view.update(intervened.map((rule) => ({ ...rule }))));
    expect(screen.getByRole("link", { name: "Review Backup Preparation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Return to Auto now" })).not.toBeInTheDocument();
  });
});
