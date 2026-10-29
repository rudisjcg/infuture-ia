import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatNumber,
  parseAcceptLanguage,
  resolveLocale,
  resources,
  SUPPORTED_LOCALES,
  translate,
} from "./index";

function leafPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leafPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(node: unknown, path: string): string {
  return path
    .split(".")
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], node) as string;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe("catalogs", () => {
  const englishKeys = leafPaths(resources.en).sort();

  it.each(SUPPORTED_LOCALES)("%s has exactly the same keys as English", (locale) => {
    expect(leafPaths(resources[locale]).sort()).toEqual(englishKeys);
  });

  it.each(SUPPORTED_LOCALES)("%s uses the same placeholders as English", (locale) => {
    for (const key of englishKeys) {
      expect(placeholders(valueAt(resources[locale], key)), key).toEqual(
        placeholders(valueAt(resources.en, key)),
      );
    }
  });

  it.each(SUPPORTED_LOCALES)("%s has no empty strings", (locale) => {
    for (const key of englishKeys) {
      expect(valueAt(resources[locale], key).trim(), key).not.toBe("");
    }
  });
});

describe("resolveLocale", () => {
  it("reads Accept-Language headers by quality", () => {
    expect(resolveLocale("es-BO,es;q=0.9,en;q=0.8")).toBe("es");
    expect(resolveLocale("fr-FR,fr;q=0.9,es;q=0.5,en;q=0.7")).toBe("en");
  });

  it("takes the first candidate that matches", () => {
    expect(resolveLocale([undefined, "", "pt-BR", "ES"])).toBe("es");
  });

  it("falls back when nothing matches", () => {
    expect(resolveLocale("de-DE")).toBe("en");
    expect(resolveLocale(null, "es")).toBe("es");
  });

  it("ignores q=0 and wildcards", () => {
    expect(parseAcceptLanguage("es;q=0, *, en")).toEqual(["en"]);
  });
});

describe("translate", () => {
  it("translates and interpolates", () => {
    expect(translate("es", "errors.notFound", { method: "GET", url: "/x" })).toBe(
      "La ruta GET /x no existe.",
    );
    expect(translate("en", "home.apiOfflineHint", { command: "pnpm dev" })).toContain("pnpm dev");
  });

  it("returns the key when it does not exist", () => {
    // @ts-expect-error unknown keys are rejected at compile time
    expect(translate("en", "nope.missing")).toBe("nope.missing");
  });
});

describe("formatters", () => {
  it("formats numbers per language", () => {
    expect(formatNumber("en", 1284000)).toBe("1,284,000");
    expect(formatNumber("es", 1284000)).toBe("1.284.000");
  });

  it("keeps decimals for small costs", () => {
    expect(formatCurrency("en", 0.0042)).toBe("$0.0042");
    expect(formatCurrency("en", 4.18)).toBe("$4.18");
    expect(formatCurrency("es", 4.18)).toMatch(/^4,18\s?US\$$/);
  });
});
