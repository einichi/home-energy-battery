import { useEffect } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { setFormattingLocale } from "../core/format";
import i18n from "./instance";

type Values = Record<string, string | number | null | undefined>;
export type Locale = "en" | "ja";

export function I18nProvider({ children }: { children: ReactNode }) {
  const { config } = useEnergyStatus();
  const locale: Locale = config?.language === "ja" ? "ja" : "en";
  setFormattingLocale(locale);
  useEffect(() => {
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  return children;
}

export function useI18n() {
  const { t, i18n: instance } = useTranslation("common");
  const locale = (instance.resolvedLanguage === "ja" ? "ja" : "en") as Locale;
  const translate = (key: string, values?: Values) => String(t(key, { ...values, defaultValue: key }));
  return {
    locale,
    t: translate,
    text: (english = "", values?: Values) => translate(english, values),
  };
}

export function T({ text, values }: { text: string; values?: Values }) {
  return useI18n().text(text, values);
}
