import type { AutomationRunContext } from "./automation-orchestrator.js";

export interface ScheduledAutomationDependencies {
  discoveryInProgress(): boolean;
  discoveryLabel(): string | null;
  runAutomation(context: AutomationRunContext): Promise<void>;
  activeDeviceOperationLabel(): string;
  warn(message: string): void;
}

export function createScheduledAutomationService(dependencies: ScheduledAutomationDependencies) {
  let running = false;
  let context: AutomationRunContext | null = null;

  async function run(): Promise<void> {
    if (dependencies.discoveryInProgress()) {
      dependencies.warn(`automation: discovery is running (${dependencies.discoveryLabel()}); skipping this scheduled interval`);
      return;
    }
    if (running) {
      const elapsedMs = context?.startedAt ? Date.now() - new Date(context.startedAt).getTime() : null;
      const duration = Number.isFinite(elapsedMs) ? `; running for ${elapsedMs}ms` : "";
      const rules = context?.enabledRules?.join(", ") || "not loaded yet";
      const phase = context?.phase || "unknown phase";
      dependencies.warn(
        `automation: previous check still running${duration}; current phase: ${phase}; active ECHONET operation: ${dependencies.activeDeviceOperationLabel()}; enabled rules: ${rules}; skipping this scheduled interval`,
      );
      return;
    }
    running = true;
    context = {};
    try {
      await dependencies.runAutomation(context);
    } catch (caught: unknown) {
      const error = (caught instanceof Error ? caught : new Error(String(caught))) as Error & {
        automationContext?: AutomationRunContext;
      };
      error.automationContext = { ...context };
      throw error;
    } finally {
      running = false;
      context = null;
    }
  }

  return { active: () => running, run };
}
