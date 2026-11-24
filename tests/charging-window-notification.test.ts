import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanAdaptiveChargingState, finalizeAdaptiveChargingWindowExecution, recordAdaptiveChargingWindowInterruption,
  recordInitialGuardWait, settleInitialGuardWait, startAdaptiveChargeSession, syncAdaptiveChargingWindowExecution,
} from "../lib/domain/adaptive-state.js";
import { adaptiveChargingShortfallMessage } from "../lib/domain/adaptive-control/formatting.js";

const at = (time: string) => new Date(`2026-11-24T${time}+09:00`);
const window = { start: at("11:00:00").toISOString(), end: at("13:00:00").toISOString(), band: { label: "EVデイタイム" } };
const slot = { start: window.start, end: window.end, windowEnd: window.end, targetWh: 2002 };

test("the shortfall message retains the opening plan through a replan and restart", () => {
  let state = cleanAdaptiveChargingState();
  syncAdaptiveChargingWindowExecution(state, window, { slots: [slot] }, 10, at("11:00:07"));
  recordInitialGuardWait(state, at("11:00:07"), slot.end);
  state = cleanAdaptiveChargingState(JSON.parse(JSON.stringify(state)));
  settleInitialGuardWait(state, at("12:00:08"));
  syncAdaptiveChargingWindowExecution(state, window, { slots: [{ ...slot, targetWh: 1093 }] }, 10, at("12:00:08"), true);
  recordInitialGuardWait(state, at("12:00:08"), slot.end);
  startAdaptiveChargeSession(state, slot, 10, at("12:03:38"));
  state.activeWindowExecution!.deliveredWh = 841;
  recordAdaptiveChargingWindowInterruption(state, at("12:26:38"));
  recordInitialGuardWait(state, at("12:26:38"), slot.end);
  finalizeAdaptiveChargingWindowExecution(state, 26, at("13:00:08"));
  const [summary] = cleanAdaptiveChargingState(state).windowSummaries;
  const message = adaptiveChargingShortfallMessage(summary);
  assert.match(message, /delivered 841 Wh/);
  assert.match(message, /Opening plan 2,002 Wh \(1,161 Wh short\)/);
  assert.match(message, /Final plan 1,093 Wh \(252 Wh short\)/);
  assert.match(message, /63\.5 min.*33\.4 min/);
  assert.match(message, /Breaker interruptions 1.*Solar-headroom pauses 0.*SOC 10% to 26%/);
});

test("a blocked first start ends at its due slot even if the window closes later", () => {
  const state = cleanAdaptiveChargingState();
  syncAdaptiveChargingWindowExecution(state, window, { slots: [slot] }, 10, at("11:00:07"));
  recordInitialGuardWait(state, at("12:00:00"), at("12:15:00").toISOString());
  recordAdaptiveChargingWindowInterruption(state, at("12:00:00"));
  const summary = finalizeAdaptiveChargingWindowExecution(state, 10, at("13:01:00"))!;
  assert.equal(summary.initialGuardBlockedMs, 15 * 60_000);
  assert.equal(summary.postStartGuardInterruptedMs, 0);
  const [legacy] = cleanAdaptiveChargingState({ windowSummaries: [{ ...summary,
    openingPlannedWh: undefined, initialGuardBlockedMs: undefined, postStartGuardInterruptedMs: undefined,
  }] }).windowSummaries;
  assert.match(adaptiveChargingShortfallMessage(legacy), /Opening plan unavailable/);
  assert.match(adaptiveChargingShortfallMessage(legacy), /Pre-start timing unavailable/);
});
