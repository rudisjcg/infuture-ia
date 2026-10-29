import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CCEvent } from "@infuture/events";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import type { TokenRole, WorkspaceStore } from "../workspaces/store";

export type WorkspaceRoutesOptions = {
  workspaceStore: WorkspaceStore;
  emit?: (event: CCEvent) => void;
  fetch?: typeof fetch;
};

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  defaultLocale: z.enum(["en", "es"]).default("en"),
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "operator", "viewer"]).default("operator"),
  expiresAt: z.string().datetime().optional(),
});

const createWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().trim().min(8).max(128).optional(),
  events: z.array(z.string()).min(1).default(["*"]),
  enabled: z.boolean().default(true),
});

export function resolveWorkspaceId(request: FastifyRequest): string {
  const headerWorkspace = request.headers["x-workspace-id"];
  if (typeof headerWorkspace === "string" && headerWorkspace.trim()) {
    return headerWorkspace.trim();
  }
  return LOCAL_WORKSPACE_ID;
}

export async function workspaceRoutes(app: FastifyInstance, opts: WorkspaceRoutesOptions) {
  const { workspaceStore, emit, fetch: fetchFn } = opts;

  /**
   * GET /api/v1/workspaces
   * List all available workspaces
   */
  app.get("/api/v1/workspaces", async () => {
    const list = await workspaceStore.listWorkspaces();
    return {
      workspaces: list.map((w) => ({
        ...w,
        createdAt: w.createdAt.toISOString(),
      })),
    };
  });

  /**
   * POST /api/v1/workspaces
   * Create a new tenant workspace
   */
  app.post<{ Body: unknown }>("/api/v1/workspaces", async (request, reply) => {
    const parse = createWorkspaceSchema.safeParse(request.body);
    if (!parse.success) {
      reply.code(400);
      return { error: request.t("errors.validation", { details: parse.error.message }) };
    }

    const created = await workspaceStore.createWorkspace(parse.data);

    emit?.({
      id: `ev-${created.id}`,
      seq: 0,
      runId: "workspace",
      workspaceId: created.id,
      taskId: "workspaces",
      workerId: "supervisor",
      type: "workspace.created",
      payload: {
        workspaceId: created.id,
        name: created.name,
        defaultLocale: created.defaultLocale,
      },
      ts: new Date().toISOString(),
    });

    reply.code(201);
    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
    };
  });

  /**
   * GET /api/v1/workspaces/:id
   * Get metadata for a specific workspace
   */
  app.get<{ Params: { id: string } }>("/api/v1/workspaces/:id", async (request, reply) => {
    const { id } = request.params;
    const ws = await workspaceStore.getWorkspace(id);
    if (!ws) {
      reply.code(404);
      return { error: request.t("errors.notFound", { method: "GET", url: request.url }) };
    }
    return {
      ...ws,
      createdAt: ws.createdAt.toISOString(),
    };
  });

  /**
   * GET /api/v1/tokens
   * List active API access tokens for workspace
   */
  app.get("/api/v1/tokens", async (request) => {
    const workspaceId = resolveWorkspaceId(request);
    const tokens = await workspaceStore.listTokens(workspaceId);
    return {
      tokens: tokens.map((t) => ({
        id: t.id,
        workspaceId: t.workspaceId,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        role: t.role,
        lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
        expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  /**
   * POST /api/v1/tokens
   * Issue a new API access token
   */
  app.post<{ Body: unknown }>("/api/v1/tokens", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const parse = createTokenSchema.safeParse(request.body);
    if (!parse.success) {
      reply.code(400);
      return { error: request.t("errors.validation", { details: parse.error.message }) };
    }

    const { name, role, expiresAt } = parse.data;
    const created = await workspaceStore.createToken(workspaceId, {
      name,
      role: role as TokenRole,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    emit?.({
      id: `ev-${created.record.id}`,
      seq: 0,
      runId: "workspace",
      workspaceId,
      taskId: "tokens",
      workerId: "supervisor",
      type: "token.created",
      payload: {
        tokenId: created.record.id,
        name: created.record.name,
        role: created.record.role,
        prefix: created.record.tokenPrefix,
      },
      ts: new Date().toISOString(),
    });

    reply.code(201);
    return {
      token: created.token,
      record: {
        id: created.record.id,
        workspaceId: created.record.workspaceId,
        name: created.record.name,
        tokenPrefix: created.record.tokenPrefix,
        role: created.record.role,
        expiresAt: created.record.expiresAt ? created.record.expiresAt.toISOString() : null,
        createdAt: created.record.createdAt.toISOString(),
      },
    };
  });

  /**
   * DELETE /api/v1/tokens/:id
   * Revoke an API token
   */
  app.delete<{ Params: { id: string } }>("/api/v1/tokens/:id", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const { id } = request.params;
    const tokens = await workspaceStore.listTokens(workspaceId);
    const target = tokens.find((t) => t.id === id);

    const revoked = await workspaceStore.revokeToken(workspaceId, id);
    if (!revoked) {
      reply.code(404);
      return { error: request.t("errors.notFound", { method: "DELETE", url: request.url }) };
    }

    emit?.({
      id: `ev-revoke-${id}`,
      seq: 0,
      runId: "workspace",
      workspaceId,
      taskId: "tokens",
      workerId: "supervisor",
      type: "token.revoked",
      payload: {
        tokenId: id,
        name: target?.name ?? id,
      },
      ts: new Date().toISOString(),
    });

    return { ok: true, revokedId: id };
  });

  /**
   * GET /api/v1/webhooks
   * List webhooks for workspace
   */
  app.get("/api/v1/webhooks", async (request) => {
    const workspaceId = resolveWorkspaceId(request);
    const list = await workspaceStore.listWebhooks(workspaceId);
    return {
      webhooks: list.map((w) => ({
        id: w.id,
        workspaceId: w.workspaceId,
        url: w.url,
        secretPrefix: `${w.secret.slice(0, 10)}...`,
        events: w.events,
        enabled: w.enabled,
        createdAt: w.createdAt.toISOString(),
      })),
    };
  });

  /**
   * POST /api/v1/webhooks
   * Register a new webhook endpoint
   */
  app.post<{ Body: unknown }>("/api/v1/webhooks", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const parse = createWebhookSchema.safeParse(request.body);
    if (!parse.success) {
      reply.code(400);
      return { error: request.t("errors.validation", { details: parse.error.message }) };
    }

    const created = await workspaceStore.createWebhook(workspaceId, parse.data);

    reply.code(201);
    return {
      id: created.id,
      workspaceId: created.workspaceId,
      url: created.url,
      secret: created.secret,
      events: created.events,
      enabled: created.enabled,
      createdAt: created.createdAt.toISOString(),
    };
  });

  /**
   * DELETE /api/v1/webhooks/:id
   * Unregister a webhook
   */
  app.delete<{ Params: { id: string } }>("/api/v1/webhooks/:id", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const { id } = request.params;
    const deleted = await workspaceStore.deleteWebhook(workspaceId, id);
    if (!deleted) {
      reply.code(404);
      return { error: request.t("errors.notFound", { method: "DELETE", url: request.url }) };
    }
    return { ok: true, deletedId: id };
  });

  /**
   * POST /api/v1/webhooks/:id/test
   * Dispatch a ping / test payload to verify webhook connectivity
   */
  app.post<{ Params: { id: string } }>("/api/v1/webhooks/:id/test", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const { id } = request.params;
    const webhook = await workspaceStore.getWebhook(workspaceId, id);
    if (!webhook) {
      reply.code(404);
      return { error: request.t("errors.notFound", { method: "POST", url: request.url }) };
    }

    const testEvent = {
      id: `ev-ping-${Date.now()}`,
      seq: 0,
      runId: "test",
      workspaceId,
      type: "log" as const,
      payload: {
        level: "info" as const,
        message: "Infuture IA Webhook Ping Verification",
      },
      ts: new Date().toISOString(),
    };

    const res = await workspaceStore.dispatch(webhook, testEvent, fetchFn);

    emit?.({
      id: `ev-hook-${Date.now()}`,
      seq: 0,
      runId: "workspace",
      workspaceId,
      taskId: "webhooks",
      workerId: "supervisor",
      type: "webhook.dispatched",
      payload: {
        webhookId: webhook.id,
        eventType: "log",
        statusCode: res.statusCode ?? undefined,
        success: res.success,
        durationMs: res.durationMs,
      },
      ts: new Date().toISOString(),
    });

    return res;
  });

  /**
   * GET /api/v1/webhooks/:id/deliveries
   * List recent delivery attempts for webhook
   */
  app.get<{ Params: { id: string } }>("/api/v1/webhooks/:id/deliveries", async (request, reply) => {
    const workspaceId = resolveWorkspaceId(request);
    const { id } = request.params;
    const webhook = await workspaceStore.getWebhook(workspaceId, id);
    if (!webhook) {
      reply.code(404);
      return { error: request.t("errors.notFound", { method: "GET", url: request.url }) };
    }

    const list = await workspaceStore.listDeliveries(workspaceId, id, 50);
    return {
      deliveries: list.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  });
}
