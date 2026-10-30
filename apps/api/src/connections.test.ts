import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CCEvent } from "@infuture/events";
import { generateMasterKey, loadMasterKey } from "@infuture/vault";
import { buildTestApp as buildApp } from "./test-auth";
import { MemoryConnectionStore } from "./connections/store";
import { loadEnv } from "./env";

const SECRET = "sk-test-0123456789abcdefWXYZ";
const store = new MemoryConnectionStore();
const events: CCEvent[] = [];
const fetch = vi.fn(async (url: string, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>)?.authorization;
  if (url.includes("openai") && auth !== `Bearer ${SECRET}`) return new Response("{}", { status: 401 });
  const body = url.endsWith("/api/tags") ? { models: [{ name: "llama3.2" }] } : { data: [{ id: "gpt-4o" }] };
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof globalThis.fetch;

let app: FastifyInstance;
let noVault: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildApp(
    env,
    {},
    { store, masterKey: loadMasterKey(generateMasterKey()), fetch, emit: (e) => events.push(e) },
  );
  noVault = await buildApp(env, {}, { masterKey: null, fetch });
});

afterAll(async () => {
  await app.close();
  await noVault.close();
});

describe("connections", () => {
  it("lists the providers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.json().map((p: { id: string }) => p.id)).toEqual(["openai", "anthropic", "groq", "ollama"]);
  });

  it("creates, verifies and never returns the key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: { providerId: "openai", alias: "Work", secret: SECRET, budgetUsdMonth: 25 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SECRET);
    expect(res.json()).toMatchObject({
      status: "healthy",
      hint: "…WXYZ",
      models: ["gpt-4o"],
      budgetUsdMonth: 25,
    });
    expect(events.at(-1)).toMatchObject({
      type: "connection.health_changed",
      payload: { status: "healthy" },
    });

    const sealed = await store.getSealed(res.json().id);
    expect(sealed?.ciphertext.toString("utf8")).not.toContain(SECRET);
  });

  it("marks a rejected key as invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connections?lang=es",
      payload: { providerId: "openai", alias: "Bad", secret: "sk-wrong-key-000000000000" },
    });
    expect(res.json().status).toBe("invalid");
    const check = await app.inject({
      method: "POST",
      url: `/api/v1/connections/${res.json().id}/verify?lang=es`,
    });
    expect(check.json().check.message).toBe("El proveedor rechazó la clave.");
  });

  it("adds Ollama without a key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: { providerId: "ollama", alias: "Local", baseUrl: "http://localhost:11434" },
    });
    expect(res.json()).toMatchObject({ authType: "local", hint: null, models: ["llama3.2"] });
  });

  it("validates input in the caller's language", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/connections?lang=es",
      payload: { providerId: "groq", alias: "G" },
    });
    expect(missing.json().error).toEqual({
      code: "secret_required",
      message: "Groq necesita una clave de API.",
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: { providerId: "x", alias: "X", secret: "s" },
    });
    expect(unknown.json().error.code).toBe("unknown_provider");

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: { providerId: "openai" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses keys when the vault is off", async () => {
    const res = await noVault.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: { providerId: "openai", alias: "W", secret: SECRET },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("vault_unavailable");
  });

  it("revokes a connection and destroys its key", async () => {
    const [first] = (await app.inject({ method: "GET", url: "/api/v1/connections" })).json();
    expect((await app.inject({ method: "DELETE", url: `/api/v1/connections/${first.id}` })).statusCode).toBe(
      204,
    );
    expect(await store.getSealed(first.id)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/api/v1/connections/${first.id}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "DELETE", url: `/api/v1/connections/${first.id}` })).statusCode).toBe(
      404,
    );
  });
});
