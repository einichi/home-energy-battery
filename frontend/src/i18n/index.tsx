import { useEffect } from "react";
import type { ReactNode } from "react";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { setFormattingLocale } from "../core/format";
import i18n from "./instance";

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
