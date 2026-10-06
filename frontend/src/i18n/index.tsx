import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { setFormattingLocale } from "../core/format";
import { messages } from "./messages";
import type { Locale, MessageKey } from "./messages";
import { reactJapanese } from "./reactMessages";

type Values = Record<string, string | number | null | undefined>;
type I18nContextValue = {
  locale: Locale;
  t: (key: MessageKey | string, values?: Values) => string;
  text: (english?: string, values?: Values) => string;
};

const defaultI18n: I18nContextValue = {
  locale: "en",
  t: (key, values) => interpolate(String(messages.en[key as MessageKey] ?? key), values),
  text: (english = "", values) => interpolate(english, values),
};
const I18nContext = createContext<I18nContextValue>(defaultI18n);
// Build the English->key fallback, but exclude English strings that map to more
// than one key: choosing one arbitrarily mistranslates the other (e.g. "Time" is
// both clock time and a duration axis). Ambiguous strings fall back to English.
const legacyEnglishToKey = (() => {
  const map = new Map<string, MessageKey>();
  const ambiguous = new Set<string>();
  for (const [key, value] of Object.entries(messages.en)) {
    const english = String(value).replace(/<[^>]+>/g, "");
    if (map.has(english)) ambiguous.add(english);
    else map.set(english, key as MessageKey);
  }
  for (const english of ambiguous) map.delete(english);
  return map;
})();

function interpolate(message: string, values?: Values) {
  return values ? message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? "")) : message;
}

function translate(locale: Locale, english = "", values?: Values) {
  if (locale === "en") return interpolate(english, values);
  const leading = english.match(/^\s*/)?.[0] ?? "";
  const trailing = english.match(/\s*$/)?.[0] ?? "";
  const source = english.trim();
  const direct = reactJapanese[source];
  const legacyKey = legacyEnglishToKey.get(source);
  const legacy = legacyKey ? messages.ja[legacyKey] : undefined;
  return `${leading}${interpolate(direct ?? legacy ?? source, values)}${trailing}`;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { config } = useEnergyStatus();
  const locale: Locale = config?.language === "ja" ? "ja" : "en";
  setFormattingLocale(locale);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t: (key, values) => interpolate(String(messages[locale][key as MessageKey] ?? key), values),
    text: (english, values) => translate(locale, english, values),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function T({ text, values }: { text: string; values?: Values }) {
  return useI18n().text(text, values);
}
