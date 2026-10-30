import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TranslationKey } from "@infuture/i18n";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import { BUILTIN_ROLE_IDS, type RoleDefinition, type RoleStore, type WorkerBinding } from "../roles/store";

export type RoleRoutesOptions = {
  roleStore: RoleStore;
};

const RoleInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_-]+$/, "id must be alphanumeric with dashes or underscores"),
  name: z.union([z.string().trim().min(1), z.record(z.string(), z.string().trim().min(1))]),
  description: z.union([z.string().trim(), z.record(z.string(), z.string().trim())]).optional(),
  systemPrompt: z.union([z.string().trim().min(1), z.record(z.string(), z.string().trim().min(1))]),
  tools: z.array(z.string()).default([]),
  limits: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
      maxIterations: z.number().int().positive().optional(),
    })
    .optional(),
  color: z.string().optional(),
  sprite: z.string().optional(),
});

const RoleUpdateSchema = z.object({
  name: z.union([z.string().trim().min(1), z.record(z.string(), z.string().trim().min(1))]).optional(),
  description: z.union([z.string().trim(), z.record(z.string(), z.string().trim())]).optional(),
  systemPrompt: z
    .union([z.string().trim().min(1), z.record(z.string(), z.string().trim().min(1))])
    .optional(),
  tools: z.array(z.string()).optional(),
  limits: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
      maxIterations: z.number().int().positive().optional(),
    })
    .optional(),
  color: z.string().optional(),
  sprite: z.string().optional(),
});

const WorkerInputSchema = z.object({
  id: z.string().min(1).optional(),
  roleId: z.string().min(1),
  name: z.string().trim().min(1),
  connectionId: z.string().nullable().optional(),
  modelKey: z.string().nullable().optional(),
  fallbackModelKeys: z.array(z.string()).optional(),
  pinned: z.boolean().default(false),
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

export async function roleRoutes(app: FastifyInstance, opts: RoleRoutesOptions) {
  const { roleStore } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  // Workspace Settings in-memory / cache
  let workspaceSettings = {
    workspaceId,
    name: "Local Workspace",
    defaultLocale: "en",
    maxBudgetUsd: 10.0,
    watchdogMode: "strict",
  };

  /**
   * GET /api/v1/roles
   * List all roles (built-in and custom)
   */
  app.get("/api/v1/roles", async (request) => {
    const roles = await roleStore.listRoles(workspaceId);
    const workers = await roleStore.listWorkers(workspaceId);

    return roles.map((role) => {
      const boundWorker = workers.find((w) => w.roleId === role.id);
      const localizedName =
        typeof role.name === "object"
          ? (role.name[request.locale] ?? role.name.en ?? Object.values(role.name)[0])
          : role.name;
      const localizedDescription =
        typeof role.description === "object"
          ? (role.description[request.locale] ?? role.description.en ?? Object.values(role.description)[0])
          : role.description;

      return {
        ...role,
        name: localizedName,
        names: role.name,
        description: localizedDescription,
        descriptions: role.description,
        worker: boundWorker
          ? {
              id: boundWorker.id,
              name: boundWorker.name,
              connectionId: boundWorker.connectionId,
              modelKey: boundWorker.modelKey,
              pinned: boundWorker.pinned,
              status: boundWorker.status,
            }
          : null,
      };
    });
  });

  /**
   * GET /api/v1/roles/:id
   * Get single role details
   */
  app.get<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const role = await roleStore.getRole(workspaceId, request.params.id);
    if (!role) {
      return fail(reply, request, 404, "not_found", "errors.notFound", {
        method: request.method,
        url: request.url,
      });
    }

    const workers = await roleStore.listWorkers(workspaceId);
    const boundWorker = workers.find((w) => w.roleId === role.id);

    return {
      ...role,
      worker: boundWorker ?? null,
    };
  });

  /**
   * POST /api/v1/roles
   * Create custom role
   */
  app.post("/api/v1/roles", async (request, reply) => {
    const parsed = RoleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: parsed.error.issues.map((i) => i.message).join(", "),
        },
      });
    }

    const body = parsed.data;
    const existing = await roleStore.getRole(workspaceId, body.id);
    if (existing) {
      return reply.code(409).send({
        error: {
          code: "role_exists",
          message: `Role with ID "${body.id}" already exists.`,
        },
      });
    }

    const nameObj: Record<string, string> =
      typeof body.name === "string" ? { en: body.name, es: body.name } : body.name;

    const descObj: Record<string, string> =
      typeof body.description === "string"
        ? { en: body.description, es: body.description }
        : (body.description ?? { en: "", es: "" });

    const promptObj: Record<string, string> =
      typeof body.systemPrompt === "string"
        ? { en: body.systemPrompt, es: body.systemPrompt }
        : body.systemPrompt;

    const newRole: RoleDefinition = {
      id: body.id,
      version: 1,
      name: nameObj,
      description: descObj,
      systemPrompt: promptObj,
      requires: ["reasoning"],
      prefers: {
        color: body.color ?? "#6366f1",
        sprite: body.sprite ?? "custom",
      },
      tools: body.tools,
      limits: body.limits ?? { maxTokens: 3000, maxCostUsd: 0.3, maxIterations: 8 },
      approval: { sensitiveTools: ["file_write"] },
      sprite: body.sprite ?? "custom",
      isCustom: true,
    };

    const saved = await roleStore.saveRole(workspaceId, newRole);
    return reply.code(201).send(saved);
  });

  /**
   * PUT /api/v1/roles/:id
   * Update role configuration
   */
  app.put<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const role = await roleStore.getRole(workspaceId, request.params.id);
    if (!role) {
      return fail(reply, request, 404, "not_found", "errors.notFound", {
        method: request.method,
        url: request.url,
      });
    }

    const parsed = RoleUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: parsed.error.issues.map((i) => i.message).join(", "),
        },
      });
    }

    const body = parsed.data;

    let updatedName = role.name;
    if (body.name) {
      updatedName =
        typeof body.name === "string"
          ? { ...role.name, [request.locale]: body.name, en: body.name }
          : { ...role.name, ...body.name };
    }

    let updatedDesc = role.description;
    if (body.description) {
      updatedDesc =
        typeof body.description === "string"
          ? { ...role.description, [request.locale]: body.description, en: body.description }
          : { ...role.description, ...body.description };
    }

    let updatedPrompt = role.systemPrompt;
    if (body.systemPrompt) {
      updatedPrompt =
        typeof body.systemPrompt === "string"
          ? { ...role.systemPrompt, [request.locale]: body.systemPrompt, en: body.systemPrompt }
          : { ...role.systemPrompt, ...body.systemPrompt };
    }

    const updatedRole: RoleDefinition = {
      ...role,
      name: updatedName,
      description: updatedDesc,
      systemPrompt: updatedPrompt,
      tools: body.tools ?? role.tools,
      limits: body.limits ? { ...(role.limits ?? {}), ...body.limits } : role.limits,
      prefers: {
        ...(role.prefers ?? {}),
        ...(body.color ? { color: body.color } : {}),
        ...(body.sprite ? { sprite: body.sprite } : {}),
      },
      sprite: body.sprite ?? role.sprite,
    };

    const saved = await roleStore.saveRole(workspaceId, updatedRole);
    return reply.send(saved);
  });

  /**
   * DELETE /api/v1/roles/:id
   * Delete custom role
   */
  app.delete<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const isBuiltin = (BUILTIN_ROLE_IDS as readonly string[]).includes(request.params.id);
    if (isBuiltin) {
      return reply.code(400).send({
        error: {
          code: "cannot_delete_builtin",
          message: "Built-in roles cannot be deleted. You can reset them instead.",
        },
      });
    }

    const deleted = await roleStore.deleteRole(workspaceId, request.params.id);
    if (!deleted) {
      return fail(reply, request, 404, "not_found", "errors.notFound", {
        method: request.method,
        url: request.url,
      });
    }

    return reply.send({ success: true, deleted: request.params.id });
  });

  /**
   * POST /api/v1/roles/:id/reset
   * Reset built-in role to factory default
   */
  app.post<{ Params: { id: string } }>("/api/v1/roles/:id/reset", async (request, reply) => {
    const reset = await roleStore.resetRole(workspaceId, request.params.id);
    if (!reset) {
      return reply.code(400).send({
        error: {
          code: "cannot_reset_custom",
          message: "Only built-in roles can be reset to default templates.",
        },
      });
    }
    return reply.send(reset);
  });

  /**
   * GET /api/v1/workers
   * List worker bindings
   */
  app.get("/api/v1/workers", async () => {
    return roleStore.listWorkers(workspaceId);
  });

  /**
   * POST /api/v1/workers
   * Create or update a worker binding
   */
  app.post("/api/v1/workers", async (request, reply) => {
    const parsed = WorkerInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: parsed.error.issues.map((i) => i.message).join(", "),
        },
      });
    }

    const body = parsed.data;
    const workerId = body.id ?? `worker-${body.roleId}`;
    const binding: WorkerBinding = {
      id: workerId,
      workspaceId,
      roleId: body.roleId,
      roleVersion: 1,
      name: body.name,
      connectionId: body.connectionId ?? null,
      modelKey: body.modelKey ?? null,
      fallbackModelKeys: body.fallbackModelKeys ?? [],
      pinned: body.pinned,
      status: "idle",
      createdAt: new Date(),
    };

    const saved = await roleStore.saveWorker(workspaceId, binding);
    return reply.code(201).send(saved);
  });

  /**
   * GET /api/v1/settings
   * Get workspace settings
   */
  app.get("/api/v1/settings", async () => {
    return workspaceSettings;
  });

  /**
   * PUT /api/v1/settings
   * Update workspace settings
   */
  app.put("/api/v1/settings", async (request, reply) => {
    const body = (request.body as Record<string, unknown>) ?? {};
    workspaceSettings = {
      ...workspaceSettings,
      defaultLocale:
        typeof body.defaultLocale === "string" ? body.defaultLocale : workspaceSettings.defaultLocale,
      maxBudgetUsd:
        typeof body.maxBudgetUsd === "number" ? body.maxBudgetUsd : workspaceSettings.maxBudgetUsd,
      watchdogMode:
        typeof body.watchdogMode === "string" ? body.watchdogMode : workspaceSettings.watchdogMode,
      name: typeof body.name === "string" ? body.name : workspaceSettings.name,
    };
    return reply.send(workspaceSettings);
  });
}
