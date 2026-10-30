import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule } from "../api/contracts";
import { useAutomation } from "./useAutomation";
import { useAutomationRules } from "./useAutomationRules";

const api = vi.hoisted(() => ({ rules: vi.fn() }));
vi.mock("../api/automation", () => ({
  getAutomationRules: api.rules,
  getAdaptiveCharging: async () => ({}),
  getAwayPeriods: async () => ({ periods: [], active: null, next: null, state: "home" }),
}));
vi.mock("../api/battery", () => ({ getCommandReceipts: async () => ({ receipts: [] }) }));
vi.mock("./useEnergyStatus", () => ({ useEnergyStatus: () => ({ config: { updateIntervalSeconds: 15 } }) }));

const intervened: AutomationRule[] = [{ id: "guard", type: "backup-demand-guard", enabled: true, state: { awaitingRestore: true } }];
const restored: AutomationRule[] = [{ ...intervened[0], state: { awaitingRestore: false } }];

beforeEach(() => { vi.useFakeTimers(); api.rules.mockReset(); });
afterEach(() => vi.useRealTimers());

describe.each([
  ["Overview rules", useAutomationRules],
  ["Automation rules", useAutomation],
] as const)("%s polling", (_label, useRules) => {
  it("does not let a pre-restore poll overwrite the command result, but accepts a later intervention", async () => {
    api.rules.mockResolvedValueOnce(intervened);
    const view = renderHook(() => useRules());
    await act(async () => undefined);
    let finishOldPoll!: (rules: AutomationRule[]) => void;
    api.rules.mockImplementationOnce(() => new Promise<AutomationRule[]>((resolve) => { finishOldPoll = resolve; }));
    await act(async () => view.result.current.refresh());
    act(() => view.result.current.replaceRules(restored));
    await act(async () => finishOldPoll(intervened));
    expect(view.result.current.rules[0].state?.awaitingRestore).toBe(false);

    api.rules.mockResolvedValueOnce(intervened);
    await act(async () => view.result.current.refresh());
    expect(view.result.current.rules[0].state?.awaitingRestore).toBe(true);
  });
});
