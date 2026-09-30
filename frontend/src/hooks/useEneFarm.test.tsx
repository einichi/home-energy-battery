import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EneFarmSummary } from "../api/contracts";

const { getEneFarm } = vi.hoisted(() => ({ getEneFarm: vi.fn() }));

vi.mock("../api/queries", () => ({ getEneFarm }));

import { useEneFarm } from "./useEneFarm";

describe("useEneFarm", () => {
  beforeEach(() => getEneFarm.mockReset());

  it("keeps the last successful summary visible while the same range refreshes", async () => {
    const summary: EneFarmSummary = {
      sampleCount: 12,
      currentState: "generating",
      generatedKwh: 4.2,
    };
    let finishRefresh!: (value: EneFarmSummary) => void;
    getEneFarm
      .mockResolvedValueOnce(summary)
      .mockImplementationOnce(() => new Promise<EneFarmSummary>((resolve) => {
        finishRefresh = resolve;
      }));

    const { result, rerender } = renderHook(
      ({ refreshKey }) => useEneFarm(86_400_000, "2026-09-30T00:00:00.000Z", undefined, refreshKey),
      { initialProps: { refreshKey: "first-reading" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toEqual(summary);

    rerender({ refreshKey: "second-reading" });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.rangeLoading).toBe(false);
    expect(result.current.summary).toEqual(summary);

    await act(async () => finishRefresh({ ...summary, generatedKwh: 4.3 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary?.generatedKwh).toBe(4.3);
  });
});
