import { useTranslation } from "react-i18next";
import { LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES } from "@infuture/i18n";
import { useLocale } from "../i18n";

/** Segmented control showing each language in its own name, so it is findable in either language. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = useLocale();

  return (
    <div className="lang" role="group" aria-label={t("common.language")}>
      {SUPPORTED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className="lang-btn"
          aria-pressed={current === code}
          title={t(`common.languages.${code}`)}
          onClick={() => void i18n.changeLanguage(code)}
        >
          <span className="lang-code">{code.toUpperCase()}</span>
          <span className="lang-name">{LOCALE_NATIVE_NAMES[code]}</span>
        </button>
      ))}
    </div>
  );
}
