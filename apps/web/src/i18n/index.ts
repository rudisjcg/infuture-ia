import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next, useTranslation } from "react-i18next";
import { DEFAULT_LOCALE, resolveLocale, resources, SUPPORTED_LOCALES, type Locale } from "@infuture/i18n";

export const STORAGE_KEY = "infuture.locale";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: resources.en },
      es: { translation: resources.es },
    },
    supportedLngs: [...SUPPORTED_LOCALES],
    fallbackLng: DEFAULT_LOCALE,
    load: "languageOnly",
    detection: {
      // ?lang=es in the URL, then the saved choice, then the browser language.
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: STORAGE_KEY,
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
  });

const syncDocumentLanguage = (lng: string) => {
  document.documentElement.lang = resolveLocale(lng);
};
syncDocumentLanguage(i18n.resolvedLanguage ?? DEFAULT_LOCALE);
i18n.on("languageChanged", syncDocumentLanguage);

/** The active language, always one of the supported locales. */
export function useLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return resolveLocale(instance.resolvedLanguage ?? instance.language);
}

export default i18n;
