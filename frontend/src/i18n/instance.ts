import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import english from "./locales/en.json" with { type: "json" };
import japanese from "./locales/ja.json" with { type: "json" };

void i18n
  .use(initReactI18next)
  .init({
    resources: { en: english, ja: japanese },
    lng: "en",
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common", "legacy", "overview", "battery", "automation", "system", "insights"],
    fallbackNS: "common",
    nsSeparator: false,
    interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
    returnNull: false,
  });

export default i18n;
