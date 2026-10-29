import en from "./locales/en.json";
import es from "./locales/es.json";

/** Languages infuture IA ships with. Add a locale here and a JSON file in ./locales to support a new one. */
export const SUPPORTED_LOCALES = ["en", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** English is the source of truth for the shape of every catalog. */
export type Messages = typeof en;

export const resources: Record<Locale, Messages> = { en, es };

/** Native names, shown in language pickers regardless of the active language. */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = { en: "English", es: "Español" };

/** Locale tags used for Intl formatting (numbers, currency, dates). */
export const INTL_TAGS: Record<Locale, string> = { en: "en-US", es: "es-ES" };

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid translation key, e.g. "home.title" or "events.run.created". */
export type TranslationKey = Leaves<Messages>;

export type InterpolationValues = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the best supported locale from candidates such as a `?lang=` value, a stored preference
 * or an `Accept-Language` header ("es-BO,es;q=0.9,en;q=0.8"). Falls back to `fallback`.
 */
export function resolveLocale(
  candidates: ReadonlyArray<string | null | undefined> | string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of list) {
    if (!candidate) continue;
    for (const tag of parseAcceptLanguage(candidate)) {
      const base = tag.split("-")[0]?.toLowerCase();
      if (isLocale(base)) return base;
    }
  }
  return fallback;
}

/** Returns the language tags of an Accept-Language value ordered by quality, highest first. */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isNaN(quality) ? 0 : quality, index };
    })
    .filter((entry) => entry.tag !== "" && entry.tag !== "*" && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.tag);
}

function lookup(messages: unknown, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Replaces `{{name}}` placeholders. Uses the same syntax as i18next, so catalogs work on both sides. */
export function interpolate(template: string, values: InterpolationValues = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/**
 * Server-side translator (API, workers, terminal). The web app uses react-i18next with the same catalogs.
 * Falls back to English, then to the key itself, so a missing string never breaks a response.
 */
export function translate(locale: Locale, key: TranslationKey, values?: InterpolationValues): string {
  const template = lookup(resources[locale], key) ?? lookup(resources[DEFAULT_LOCALE], key) ?? key;
  return interpolate(template, values);
}

/** Returns a translator bound to one locale. */
export function getTranslator(locale: Locale) {
  return (key: TranslationKey, values?: InterpolationValues) => translate(locale, key, values);
}

/** True when the key exists in the given locale's catalog. */
export function hasKey(locale: Locale, key: string): boolean {
  return lookup(resources[locale], key) !== undefined;
}

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(INTL_TAGS[locale], options).format(value);
}

/** Formats a cost. Small amounts keep more decimals so a USD 0.0042 model call does not show as 0.00. */
export function formatCurrency(locale: Locale, value: number, currency = "USD"): string {
  const maximumFractionDigits = Math.abs(value) > 0 && Math.abs(value) < 1 ? 4 : 2;
  return new Intl.NumberFormat(INTL_TAGS[locale], {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
}

export function formatDateTime(
  locale: Locale,
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(INTL_TAGS[locale], options).format(new Date(value));
}
