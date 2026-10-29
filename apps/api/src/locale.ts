import type { FastifyInstance } from "fastify";
import {
  getTranslator,
  isLocale,
  resolveLocale,
  type InterpolationValues,
  type Locale,
  type TranslationKey,
} from "@infuture/i18n";

export type Translator = (key: TranslationKey, values?: InterpolationValues) => string;

declare module "fastify" {
  interface FastifyRequest {
    /** Language negotiated for this request. */
    locale: Locale;
    /** Translates into the request's language. */
    t: Translator;
  }
}

/**
 * Negotiates the response language, in this order:
 * 1. `?lang=es` query parameter
 * 2. `X-Infuture-Locale` header (sent by the web app and the terminal)
 * 3. `Accept-Language` header
 * 4. DEFAULT_LOCALE
 */
export function registerLocale(app: FastifyInstance, defaultLocale: Locale) {
  app.decorateRequest("locale", defaultLocale);
  app.decorateRequest("t", null as unknown as Translator);

  app.addHook("onRequest", async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const fromQuery = typeof query?.lang === "string" ? query.lang : undefined;
    const fromHeader = request.headers["x-infuture-locale"];
    const explicit = [fromQuery, Array.isArray(fromHeader) ? fromHeader[0] : fromHeader].filter(isLocale);

    request.locale = resolveLocale([...explicit, request.headers["accept-language"]], defaultLocale);
    request.t = getTranslator(request.locale);
    reply.header("Content-Language", request.locale);
    reply.header("Vary", "Accept-Language, X-Infuture-Locale");
  });
}
