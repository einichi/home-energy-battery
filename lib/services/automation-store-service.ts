import {
  cleanAutomationRuleConfig,
  cleanAutomationRuleState,
  mergeAutomationRule,
} from "../domain/automation-rules.js";

type AutomationRule = ReturnType<typeof mergeAutomationRule>;

export interface AutomationDocumentStore {
  readDocument(key: "automationRules", fallback: unknown[]): unknown[];
  readDocument(key: "automationRuleState", fallback: Record<string, unknown>): Record<string, unknown>;
  writeDocument(key: "automationRules", value: unknown[]): unknown;
  writeDocument(key: "automationRuleState", value: Record<string, unknown>): unknown;
}

export interface AutomationEventStore {
  isReady(): boolean;
  recordEvent(event: Record<string, unknown>): unknown;
}

function normalizeStateDocument(value: unknown): Record<string, unknown> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([id]) => Boolean(id))
      .map(([id, state]) => [id, cleanAutomationRuleState(state)]),
  );
}

export function createAutomationStoreService(
  documents: AutomationDocumentStore,
  events: AutomationEventStore,
) {
  async function readConfigs() {
    return documents.readDocument("automationRules", []).map(cleanAutomationRuleConfig);
  }

  async function readStates() {
    return normalizeStateDocument(documents.readDocument("automationRuleState", {}));
  }

  async function read(): Promise<AutomationRule[]> {
    const [configs, states] = await Promise.all([readConfigs(), readStates()]);
    return configs.map((config) => mergeAutomationRule(
      config,
      states[String(config.id)] ?? {},
    ));
  }

  async function writeConfigs(rules: AutomationRule[]) {
    const cleaned = rules.map(cleanAutomationRuleConfig);
    documents.writeDocument("automationRules", cleaned);
    return cleaned;
  }

  async function writeStates(rules: AutomationRule[]) {
    const states = Object.fromEntries(
      rules.map((rule) => [String(rule.id), cleanAutomationRuleState(rule)]),
    );
    documents.writeDocument("automationRuleState", states);
    if (events.isReady()) {
      for (const rule of rules) {
        for (const entry of rule.log ?? []) {
          events.recordEvent({
            eventKey: `automation:${rule.id}:${entry.at}:${entry.kind ?? "log"}:${entry.message}`,
            at: entry.at,
            category: "automation",
            type: entry.kind ?? "log",
            message: entry.message,
            payload: { ruleId: rule.id, ruleType: rule.type },
          });
        }
      }
    }
    return states;
  }

  return { read, readConfigs, readStates, writeConfigs, writeStates };
}
