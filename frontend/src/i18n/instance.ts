import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import english from "./locales/en.json";
import japanese from "./locales/ja.json";

void i18n
  .use(initReactI18next)
  .init({
    resources: { en: english, ja: japanese },
    lng: "en",
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common", "legacy"],
    interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
    returnNull: false,
  });

export default i18n;
