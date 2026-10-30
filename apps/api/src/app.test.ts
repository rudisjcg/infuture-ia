import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp as buildApp } from "./test-auth";
import { loadEnv } from "./env";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadEnv({ NODE_ENV: "test", DEFAULT_LOCALE: "en" }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("language negotiation", () => {
  it("answers in English by default", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/info" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-language"]).toBe("en");
    expect(res.json().message).toBe("Welcome to the infuture IA API.");
  });

  it("follows Accept-Language", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/info",
      headers: { "accept-language": "es-BO,es;q=0.9,en;q=0.5" },
    });
    expect(res.headers["content-language"]).toBe("es");
    expect(res.json().message).toBe("Bienvenido a la API de infuture IA.");
  });

  it("lets ?lang= override Accept-Language", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/info?lang=en",
      headers: { "accept-language": "es" },
    });
    expect(res.json().locale).toBe("en");
  });

  it("accepts the X-Infuture-Locale header", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { "x-infuture-locale": "es" } });
    expect(res.json()).toMatchObject({
      status: "ok",
      message: "Todos los sistemas funcionan con normalidad.",
    });
  });
});

describe("routes", () => {
  it("serves a translation catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/i18n/es" });
    expect(res.statusCode).toBe(200);
    expect(res.json().nav.agents).toBe("Agentes");
  });

  it("rejects unsupported languages in the visitor's language", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/i18n/fr?lang=es" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe("El idioma fr no está disponible. Usa uno de: en, es.");
  });

  it("labels every event type", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/events/catalog?lang=es" });
    const catalog = res.json() as { type: string; label: string; persisted: boolean }[];
    expect(catalog.find((e) => e.type === "approval.requested")?.label).toBe("Aprobación solicitada");
    expect(catalog.find((e) => e.type === "llm.token")?.persisted).toBe(false);
    for (const entry of catalog) expect(entry.label).not.toBe(`events.${entry.type}`);
  });

  it("lists default roles", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/roles?lang=es" });
    expect(res.json()).toContainEqual(expect.objectContaining({ id: "researcher", name: "Investigador" }));
  });

  it("returns a translated 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope?lang=es" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: "not_found", message: "La ruta GET /nope no existe." });
  });
});
