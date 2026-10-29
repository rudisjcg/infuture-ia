import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TranslationKey } from "@infuture/i18n";
import {
  createCustomSandboxTool,
  getAllTools,
  registerTool,
  testToolExecution,
  unregisterTool,
  type ToolParameter,
} from "@infuture/worker";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import type { McpServerStore } from "../tools/store";

export type ToolRoutesOptions = {
  mcpStore: McpServerStore;
  apiHost?: string;
  apiToken?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Custom tools run user-supplied code, so they are guarded: with API_TOKEN set a matching bearer
 * token is required; without it, only a loopback-bound API may accept them.
 */
function isAuthorizedForCode(request: FastifyRequest, opts: ToolRoutesOptions): boolean {
  if (opts.apiToken) {
    const header = request.headers.authorization ?? "";
    const expected = `Bearer ${opts.apiToken}`;
    return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }
  return LOOPBACK_HOSTS.has(opts.apiHost ?? "127.0.0.1");
}

const testToolSchema = z.object({
  args: z.record(z.unknown()).default({}),
});

const createCustomToolSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, "Name must be snake_case (e.g. currency_convert)"),
  description: z.string().trim().min(5).max(300),
  parameters: z.record(
    z.object({
      type: z.enum(["string", "number", "boolean", "object", "array"]),
      description: z.string().trim(),
      required: z.boolean().optional(),
    }),
  ),
  code: z.string().trim().min(5).max(5000),
  requiresApproval: z.boolean().default(false),
});

const createMcpServerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  command: z.string().trim().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().trim().optional(),
});

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  key: TranslationKey,
  values = {},
) {
  return reply.code(status).send({ error: { code, message: request.t(key, values) } });
}

export async function toolRoutes(app: FastifyInstance, opts: ToolRoutesOptions) {
  const { mcpStore } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  /**
   * GET /api/v1/tools
   * Lists all available tools (built-in, custom and MCP)
   */
  app.get("/api/v1/tools", async () => {
    const all = getAllTools();
    return all.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      requiresApproval: t.requiresApproval ?? false,
      isMcp: t.description.startsWith("[MCP:"),
    }));
  });

  /**
   * POST /api/v1/tools/:name/test
   * Safely execute and test any tool in the sandbox environment
   */
  app.post<{
    Params: { name: string };
    Body: { args?: Record<string, unknown> };
  }>("/api/v1/tools/:name/test", async (request, reply) => {
    const { name } = request.params;
    const parsed = testToolSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return fail(reply, request, 400, "validation", "errors.validation", {
        details: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }

    const result = await testToolExecution(name, parsed.data.args, {
      workspaceId,
      runId: "testbed",
    });

    if (!result.ok && result.error === "not_found") {
      return fail(reply, request, 404, "tool_not_found", "errors.notFound", {
        method: "POST",
        url: request.url,
      });
    }

    return result;
  });

  /**
   * POST /api/v1/tools/custom
   * Register a custom JavaScript sandbox tool
   */
  app.post("/api/v1/tools/custom", async (request, reply) => {
    if (!isAuthorizedForCode(request, opts)) {
      return fail(reply, request, 401, "unauthorized", "errors.unauthorized");
    }
    const parsed = createCustomToolSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }

    const { name, description, parameters, code, requiresApproval } = parsed.data;

    const toolDef = createCustomSandboxTool({
      name,
      description,
      parameters: parameters as Record<string, ToolParameter>,
      code,
      requiresApproval,
    });

    registerTool(toolDef);

    reply.code(201);
    return {
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters,
      requiresApproval: toolDef.requiresApproval ?? true,
      isCustom: true,
    };
  });

  /**
   * DELETE /api/v1/tools/custom/:name
   * Remove a custom sandbox tool
   */
  app.delete<{ Params: { name: string } }>("/api/v1/tools/custom/:name", async (request, reply) => {
    if (!isAuthorizedForCode(request, opts)) {
      return fail(reply, request, 401, "unauthorized", "errors.unauthorized");
    }
    const { name } = request.params;
    const deleted = unregisterTool(name);
    if (!deleted) {
      return fail(reply, request, 404, "tool_not_found", "errors.notFound", {
        method: "DELETE",
        url: request.url,
      });
    }
    return { ok: true, name };
  });

  /**
   * GET /api/v1/mcp/servers
   * List configured MCP servers
   */
  app.get("/api/v1/mcp/servers", async () => {
    const servers = await mcpStore.listServers(workspaceId);
    return servers.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
    }));
  });

  /**
   * POST /api/v1/mcp/servers
   * Connect a new MCP server
   */
  app.post("/api/v1/mcp/servers", async (request, reply) => {
    const parsed = createMcpServerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }

    const created = await mcpStore.createServer({
      workspaceId,
      name: parsed.data.name,
      transport: parsed.data.transport,
      command: parsed.data.command,
      args: parsed.data.args,
      url: parsed.data.url,
      enabled: true,
    });

    reply.code(201);
    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
      lastSyncedAt: null,
    };
  });

  /**
   * POST /api/v1/mcp/servers/:id/sync
   * Discover and register tools from an MCP server
   */
  app.post<{ Params: { id: string } }>("/api/v1/mcp/servers/:id/sync", async (request, reply) => {
    const { id } = request.params;
    const synced = await mcpStore.syncServer(workspaceId, id);
    if (!synced) {
      return fail(reply, request, 404, "server_not_found", "errors.notFound", {
        method: "POST",
        url: request.url,
      });
    }

    return {
      ...synced,
      createdAt: synced.createdAt.toISOString(),
      lastSyncedAt: synced.lastSyncedAt ? synced.lastSyncedAt.toISOString() : null,
      toolsCount: synced.discoveredTools.length,
    };
  });

  /**
   * DELETE /api/v1/mcp/servers/:id
   * Disconnect an MCP server
   */
  app.delete<{ Params: { id: string } }>("/api/v1/mcp/servers/:id", async (request, reply) => {
    const { id } = request.params;
    const deleted = await mcpStore.deleteServer(workspaceId, id);
    if (!deleted) {
      return fail(reply, request, 404, "server_not_found", "errors.notFound", {
        method: "DELETE",
        url: request.url,
      });
    }
    return { ok: true, id };
  });
}
