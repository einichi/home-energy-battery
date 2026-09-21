export type DeviceCommand = {
  id: string;
  label: string;
  target: "battery";
  action?: string;
  payload?: Record<string, unknown>;
  impact?: string;
};

export type CommandState =
  | { phase: "idle" }
  | { phase: "confirming"; command: DeviceCommand }
  | { phase: "sending"; command: DeviceCommand }
  | { phase: "acknowledged"; command: DeviceCommand }
  | { phase: "verifying"; command: DeviceCommand }
  | { phase: "succeeded"; command: DeviceCommand; verifiedAt: string }
  | { phase: "failed"; command: DeviceCommand; error: string }
  | { phase: "timed-out"; command: DeviceCommand; error: string }
  | { phase: "mismatched"; command: DeviceCommand; expected: string; actual: string };

export type CommandAction =
  | { type: "review"; command: DeviceCommand }
  | { type: "send" }
  | { type: "acknowledge" }
  | { type: "verify" }
  | { type: "succeed"; verifiedAt: string }
  | { type: "fail"; error: string }
  | { type: "timeout"; error: string }
  | { type: "mismatch"; expected: string; actual: string }
  | { type: "observe"; phase: "sending" | "acknowledged" | "verifying" | "succeeded" | "failed" | "timed-out" | "mismatched"; message?: string; at?: string }
  | { type: "reset" };

function activeCommand(state: CommandState): DeviceCommand {
  if (state.phase === "idle") throw new Error("A command must be selected before its lifecycle can advance");
  return state.command;
}

export function commandReducer(state: CommandState, action: CommandAction): CommandState {
  switch (action.type) {
    case "review":
      return { phase: "confirming", command: action.command };
    case "send":
      if (state.phase !== "confirming") throw new Error("Only a confirmed command can be sent");
      return { phase: "sending", command: activeCommand(state) };
    case "acknowledge":
      if (state.phase !== "sending") throw new Error("Only a sent command can be acknowledged");
      return { phase: "acknowledged", command: activeCommand(state) };
    case "verify":
      if (state.phase !== "acknowledged") throw new Error("Only an acknowledged command can be verified");
      return { phase: "verifying", command: activeCommand(state) };
    case "succeed":
      if (state.phase !== "verifying") throw new Error("Only a verified command can succeed");
      return { phase: "succeeded", command: activeCommand(state), verifiedAt: action.verifiedAt };
    case "fail":
      return { phase: "failed", command: activeCommand(state), error: action.error };
    case "timeout":
      if (state.phase !== "sending" && state.phase !== "acknowledged" && state.phase !== "verifying") {
        throw new Error("Only an active command can time out");
      }
      return { phase: "timed-out", command: activeCommand(state), error: action.error };
    case "mismatch":
      if (state.phase !== "sending" && state.phase !== "acknowledged" && state.phase !== "verifying") {
        throw new Error("Only an active command can report a mismatch");
      }
      return {
        phase: "mismatched",
        command: activeCommand(state),
        expected: action.expected,
        actual: action.actual,
      };
    case "observe": {
      const command = activeCommand(state);
      if (action.phase === "succeeded") return { phase: "succeeded", command, verifiedAt: action.at ?? new Date().toISOString() };
      if (action.phase === "failed") return { phase: "failed", command, error: action.message ?? "Command failed" };
      if (action.phase === "timed-out") return { phase: "timed-out", command, error: action.message ?? "Command timed out" };
      if (action.phase === "mismatched") return { phase: "mismatched", command, expected: "requested state", actual: action.message ?? "readback mismatch" };
      return { phase: action.phase, command };
    }
    case "reset":
      return { phase: "idle" };
  }
}
