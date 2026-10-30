import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp as buildApp } from "./test-auth";
import { MemoryRoleStore } from "./roles/store";
import { loadEnv } from "./env";

let app: FastifyInstance;
const roleStore = new MemoryRoleStore();

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildApp(
    env,
    {},
    {
      roleStore,
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Roles and Workers API", () => {
  it("GET /api/v1/roles lists the 7 default built-in roles", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(7);

    const roleIds = body.map((r: { id: string }) => r.id);
    expect(roleIds).toContain("supervisor");
    expect(roleIds).toContain("researcher");
    expect(roleIds).toContain("analyst");
    expect(roleIds).toContain("developer");
    expect(roleIds).toContain("writer");
    expect(roleIds).toContain("reviewer");
    expect(roleIds).toContain("receptionist");

    const developer = body.find((r: { id: string }) => r.id === "developer");
    expect(developer.tools).toContain("code_eval");
    expect(developer.isCustom).toBe(false);
  });

  it("GET /api/v1/roles/:id returns full role definition", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/roles/supervisor",
    });
    expect(res.statusCode).toBe(200);
    const role = res.json();
    expect(role.id).toBe("supervisor");
    expect(role.systemPrompt.en).toContain("Supervisor");
    expect(role.systemPrompt.es).toContain("Supervisor");
  });

  it("PUT /api/v1/roles/:id updates prompts and tools", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/roles/developer",
      payload: {
        systemPrompt: {
          en: "Custom Developer prompt in English.",
          es: "Prompt de desarrollador personalizado en Español.",
        },
        tools: ["code_eval", "file_read"],
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.systemPrompt.en).toBe("Custom Developer prompt in English.");
    expect(updated.tools).toEqual(["code_eval", "file_read"]);

    // Verify persisted
    const check = await app.inject({ method: "GET", url: "/api/v1/roles/developer" });
    expect(check.json().systemPrompt.en).toBe("Custom Developer prompt in English.");
  });

  it("POST /api/v1/roles creates a custom role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: {
        id: "qa-engineer",
        name: { en: "QA Engineer", es: "Ingeniero de QA" },
        description: { en: "Tests and validates features", es: "Prueba y valida funcionalidades" },
        systemPrompt: {
          en: "You are a QA Engineer testing software rigorously.",
          es: "Eres un Ingeniero de QA que prueba software rigurosamente.",
        },
        tools: ["code_eval", "calc"],
        color: "#a855f7",
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.id).toBe("qa-engineer");
    expect(created.isCustom).toBe(true);

    // Verify it now appears in list
    const listRes = await app.inject({ method: "GET", url: "/api/v1/roles" });
    const list = listRes.json();
    expect(list.length).toBe(8);
  });

  it("DELETE /api/v1/roles/:id prevents deleting built-in roles", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/roles/supervisor",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("cannot_delete_builtin");
  });

  it("DELETE /api/v1/roles/:id deletes custom roles", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/roles/qa-engineer",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const getRes = await app.inject({ method: "GET", url: "/api/v1/roles/qa-engineer" });
    expect(getRes.statusCode).toBe(404);
  });

  it("POST /api/v1/roles/:id/reset resets built-in role to default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles/developer/reset",
    });
    expect(res.statusCode).toBe(200);
    const resetRole = res.json();
    expect(resetRole.tools).toContain("file_write");
    expect(resetRole.systemPrompt.en).toContain("Principal Software Developer");
  });

  it("GET /api/v1/tools lists all available builtin tools", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tools",
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(5);
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("code_eval");
    expect(names).toContain("file_write");
    expect(names).toContain("file_read");
    expect(names).toContain("calc");

    const fileWrite = tools.find((t: { name: string }) => t.name === "file_write");
    expect(fileWrite.requiresApproval).toBe(true);
  });

  it("GET /api/v1/workers and POST /api/v1/workers manages worker bindings", async () => {
    const getRes = await app.inject({ method: "GET", url: "/api/v1/workers" });
    expect(getRes.statusCode).toBe(200);
    const workers = getRes.json();
    expect(workers.length).toBeGreaterThanOrEqual(7);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/v1/workers",
      payload: {
        roleId: "developer",
        name: "Pinned Dev Worker",
        modelKey: "gpt-4o",
        pinned: true,
      },
    });
    expect(postRes.statusCode).toBe(201);
    const created = postRes.json();
    expect(created.name).toBe("Pinned Dev Worker");
    expect(created.modelKey).toBe("gpt-4o");
    expect(created.pinned).toBe(true);
  });

  it("GET /api/v1/settings and PUT /api/v1/settings manages workspace settings", async () => {
    const getRes = await app.inject({ method: "GET", url: "/api/v1/settings" });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().name).toBe("Local Workspace");

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        name: "Enterprise Command Center",
        maxBudgetUsd: 25.0,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().name).toBe("Enterprise Command Center");
    expect(putRes.json().maxBudgetUsd).toBe(25.0);
  });
});
