import { describe, expect, it } from "vitest";
import { commandReducer } from "./commands";
import type { CommandState, DeviceCommand } from "./commands";

const command: DeviceCommand = { id: "backup", label: "Start backup preparation", target: "battery" };

describe("command lifecycle", () => {
  it("requires review, send, acknowledgement, and verification before success", () => {
    let state: CommandState = { phase: "idle" };
    state = commandReducer(state, { type: "review", command });
    state = commandReducer(state, { type: "send" });
    state = commandReducer(state, { type: "acknowledge" });
    state = commandReducer(state, { type: "verify" });
    state = commandReducer(state, { type: "succeed", verifiedAt: "2026-09-12T12:00:00.000Z" });
    expect(state).toEqual({ phase: "succeeded", command, verifiedAt: "2026-09-12T12:00:00.000Z" });
  });

  it("fails closed when a command skips a lifecycle stage", () => {
    expect(() => commandReducer({ phase: "idle" }, { type: "send" })).toThrow(/confirmed command/);
  });

  it("retains timeout and readback-mismatch receipts", () => {
    const sending: CommandState = { phase: "sending", command };
    expect(commandReducer(sending, { type: "timeout", error: "Device did not acknowledge" })).toEqual({
      phase: "timed-out",
      command,
      error: "Device did not acknowledge",
    });

    const verifying: CommandState = { phase: "verifying", command };
    expect(commandReducer(verifying, { type: "mismatch", expected: "charge", actual: "standby" })).toEqual({
      phase: "mismatched",
      command,
      expected: "charge",
      actual: "standby",
    });
  });

  it("accepts server-observed lifecycle progress without inventing skipped success", () => {
    const sending: CommandState = { phase: "sending", command };
    expect(commandReducer(sending, { type: "observe", phase: "acknowledged" })).toEqual({ phase: "acknowledged", command });
    expect(commandReducer(sending, { type: "observe", phase: "mismatched", message: "read back auto" })).toEqual({
      phase: "mismatched",
      command,
      expected: "requested state",
      actual: "read back auto",
    });
  });
});
