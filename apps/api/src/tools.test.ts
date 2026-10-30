import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { buildTestApp } from "./test-auth";
import { MemoryMcpServerStore } from "./tools/store";
import { loadEnv } from "./env";

let app: FastifyInstance;
const mcpStore = new MemoryMcpServerStore();

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildTestApp(
    env,
    {},
    {
      mcpStore,
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Tools & MCP API", () => {
  it("GET /api/v1/tools lists all tools including built-in and MCP tools", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tools",
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(Array.isArray(tools)).toBe(true);

    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("calc");
    expect(names).toContain("web_search");
    expect(names).toContain("code_eval");
  });

  it("POST /api/v1/tools/:name/test tests tool execution in sandbox", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tools/calc/test",
      payload: {
        args: {
          expression: "15 * 4",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe(60);
    expect(typeof body.durationMs).toBe("number");
  });

  it("POST /api/v1/tools/:name/test returns 404 for unknown tool", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tools/non_existent_tool_xyz/test",
      payload: {
        args: {},
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("tool_not_found");
  });

  it("POST /api/v1/tools/custom registers and tests a custom JavaScript sandbox tool", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/tools/custom",
      payload: {
        name: "temperature_converter",
        description: "Converts Celsius to Fahrenheit",
        parameters: {
          celsius: {
            type: "number",
            description: "Temperature in Celsius",
            required: true,
          },
        },
        code: "const f = (Number(args.celsius) * 9) / 5 + 32; return { fahrenheit: f };",
        requiresApproval: false,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe("temperature_converter");
    expect(created.isCustom).toBe(true);
    expect(created.requiresApproval).toBe(true);

    // Test the newly created custom tool
    const testRes = await app.inject({
      method: "POST",
      url: "/api/v1/tools/temperature_converter/test",
      payload: {
        args: { celsius: 100 },
      },
    });

    expect(testRes.statusCode).toBe(200);
    const testBody = testRes.json();
    expect(testBody.ok).toBe(true);
    expect(testBody.data).toEqual({ fahrenheit: 212 });

    // Delete custom tool
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/tools/custom/temperature_converter",
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);
  });

  it("GET /api/v1/mcp/servers does not seed fake MCP servers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/mcp/servers" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((s: { id: string }) => s.id);
    expect(ids).not.toContain("mcp-sqlite-analytics");
    expect(ids).not.toContain("mcp-fetch-web");
  });

  it("POST /api/v1/mcp/servers connects a new MCP server and syncs its tools", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      payload: {
        name: "Docker Container Manager",
        transport: "stdio",
        command: "docker-mcp",
        args: ["--all"],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe("Docker Container Manager");
    expect(created.transport).toBe("stdio");
    const serverId = created.id;

    // Sync tools from server
    const syncRes = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/servers/${serverId}/sync`,
    });

    expect(syncRes.statusCode).toBe(200);
    const syncBody = syncRes.json();
    expect(syncBody.toolsCount).toBeGreaterThan(0);
    expect(syncBody.lastSyncedAt).toBeTruthy();

    // Verify discovered tool is in /api/v1/tools
    const toolsRes = await app.inject({
      method: "GET",
      url: "/api/v1/tools",
    });
    const tools = toolsRes.json();
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("docker_container_manager_action");

    // Clean up server
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/mcp/servers/${serverId}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);
  });

  it("POST /api/v1/tools/custom requires a bearer token when API_TOKEN is set or the host is public", async () => {
    const payload = {
      name: "guarded_tool",
      description: "Guarded custom tool",
      parameters: {},
      code: "return { ok: true };",
    };
    const tokenApp = await buildApp(loadEnv({ NODE_ENV: "test", API_TOKEN: "test-token-1234567890" }));
    const publicApp = await buildApp(loadEnv({ NODE_ENV: "test", API_HOST: "0.0.0.0" }));
    try {
      const noToken = await tokenApp.inject({ method: "POST", url: "/api/v1/tools/custom", payload });
      expect(noToken.statusCode).toBe(401);
      const withToken = await tokenApp.inject({
        method: "POST",
        url: "/api/v1/tools/custom",
        payload,
        headers: { authorization: "Bearer test-token-1234567890" },
      });
      expect(withToken.statusCode).toBe(201);
      const publicRes = await publicApp.inject({ method: "POST", url: "/api/v1/tools/custom", payload });
      expect(publicRes.statusCode).toBe(401);
    } finally {
      await tokenApp.inject({
        method: "DELETE",
        url: "/api/v1/tools/custom/guarded_tool",
        headers: { authorization: "Bearer test-token-1234567890" },
      });
      await tokenApp.close();
      await publicApp.close();
    }
  });
});
