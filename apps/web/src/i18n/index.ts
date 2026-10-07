import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type {} from "../desktop/bridge";
import { en } from "./en";
import uiEn from "./ui.en.json";
import { zh } from "./zh-CN";
export type LanguagePreference = "system" | "zh-CN" | "en";
const key = "intrica:language";
export function languagePreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(key);
    return value === "en" || value === "zh-CN" ? value : "system";
  } catch {
    return "system";
  }
}
export function resolveLanguage(
  preference: LanguagePreference,
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
) {
  if (preference !== "system") return preference;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en, ui: uiEn },
    "zh-CN": {
      translation: zh,
      ui: Object.fromEntries(
        Object.keys(uiEn).map((key) => [key, key.replace(/_(one|other)$/, "")]),
      ),
    },
  },
  lng: resolveLanguage(languagePreference()),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  initAsync: false,
});
export async function setLanguage(preference: LanguagePreference) {
  try {
    localStorage.setItem(key, preference);
  } catch {}
  if (typeof window !== "undefined")
    await window.intricaDesktop?.preferences?.setLanguage(preference).catch(() => {});
  await i18n.changeLanguage(resolveLanguage(preference));
}
if (typeof window !== "undefined") {
  i18n.on("languageChanged", (language) => {
    document.documentElement.lang = language;
  });
  document.documentElement.lang = i18n.language;
  const sync = () => {
    void i18n.changeLanguage(resolveLanguage(languagePreference()));
  };
  window.addEventListener("languagechange", sync);
  window.addEventListener("focus", () => {
    if (languagePreference() === "system") sync();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key) sync();
  });
}
export const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
export const date = (value: string) =>
  new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
export { useTranslation } from "react-i18next";
export default i18n;

export function tr(key: string, values: Record<string, unknown> = {}) {
  return i18n.t(key, {
    ns: "ui",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: key,
    ...values,
    ...(typeof values.v0 === "number" ? { count: values.v0 } : {}),
  });
}
