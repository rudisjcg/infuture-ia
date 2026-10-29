import type { FastifyInstance } from "fastify";
import { EVENT_TYPES, eventLabelKey, isPersisted } from "@infuture/events";
import {
  isLocale,
  resources,
  SUPPORTED_LOCALES,
  LOCALE_NATIVE_NAMES,
  type TranslationKey,
} from "@infuture/i18n";

export const DEFAULT_ROLES = [
  "supervisor",
  "researcher",
  "analyst",
  "developer",
  "writer",
  "reviewer",
  "receptionist",
] as const;

export async function systemRoutes(app: FastifyInstance, opts: { version: string; startedAt: number }) {
  app.get("/health", async (request) => ({
    status: "ok",
    message: request.t("api.healthy"),
    uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
  }));

  app.get("/api/v1/info", async (request) => ({
    name: "infuture IA",
    version: opts.version,
    locale: request.locale,
    message: request.t("api.welcome"),
    supportedLocales: SUPPORTED_LOCALES.map((code) => ({ code, name: LOCALE_NATIVE_NAMES[code] })),
  }));

  /** Full catalog for one language, for clients that do not bundle the translations (terminal, agents). */
  app.get<{ Params: { locale: string } }>("/api/v1/i18n/:locale", async (request, reply) => {
    const { locale } = request.params;
    if (!isLocale(locale)) {
      return reply.code(404).send({
        error: {
          code: "unsupported_locale",
          message: request.t("errors.unsupportedLocale", { locale, supported: SUPPORTED_LOCALES.join(", ") }),
        },
      });
    }
    reply.header("Cache-Control", "public, max-age=300");
    return resources[locale];
  });

  app.get("/api/v1/events/catalog", async (request) =>
    EVENT_TYPES.map((type) => ({
      type,
      label: request.t(eventLabelKey(type) as TranslationKey),
      persisted: isPersisted(type),
    })),
  );
}
