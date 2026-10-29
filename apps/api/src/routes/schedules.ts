import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CCEvent } from "@infuture/events";
import { type TranslationKey } from "@infuture/i18n";
import { BUILTIN_RECIPES } from "../recipes/catalog";
import { LOCAL_WORKSPACE_ID, type ConnectionStore } from "../connections/store";
import { computeNextRunAt, type ScheduleInterval, type ScheduleStore } from "../schedules/store";
import type { RunStore } from "../runs/store";

export type ScheduleRoutesOptions = {
  scheduleStore: ScheduleStore;
  runStore?: RunStore;
  connectionStore?: ConnectionStore;
  emit?: (event: CCEvent) => void;
};

const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(5000),
  role: z.string().trim().min(1).default("supervisor"),
  multiagent: z.boolean().default(false),
  interval: z.enum(["hourly", "daily", "weekly", "custom"] as const).default("daily"),
  cronExpr: z.string().optional(),
  enabled: z.boolean().default(true),
});

const updateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(1).max(5000).optional(),
  role: z.string().trim().min(1).optional(),
  multiagent: z.boolean().optional(),
  interval: z.enum(["hourly", "daily", "weekly", "custom"] as const).optional(),
  cronExpr: z.string().optional(),
  enabled: z.boolean().optional(),
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

export async function scheduleRoutes(app: FastifyInstance, opts: ScheduleRoutesOptions) {
  const { scheduleStore } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  // Catalog of built-in agent recipes
  app.get("/api/v1/recipes", async (request) => {
    const loc = request.locale;
    return BUILTIN_RECIPES.map((r) => ({
      id: r.id,
      name: r.names[loc] ?? r.names.en ?? r.id,
      names: r.names,
      description: r.descriptions[loc] ?? r.descriptions.en ?? "",
      descriptions: r.descriptions,
      goal: r.goalTemplate[loc] ?? r.goalTemplate.en ?? "",
      goalTemplate: r.goalTemplate,
      defaultRole: r.defaultRole,
      multiagent: r.multiagent,
      tags: r.tags,
    }));
  });

  // List all scheduled automations
  app.get("/api/v1/schedules", async () => {
    const list = await scheduleStore.listSchedules(workspaceId);
    return list.map((s) => ({
      ...s,
      lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
      nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  // Get single schedule
  app.get<{ Params: { id: string } }>("/api/v1/schedules/:id", async (request, reply) => {
    const s = await scheduleStore.getSchedule(workspaceId, request.params.id);
    if (!s) {
      return fail(reply, request, 404, "schedule_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    }
    return {
      ...s,
      lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
      nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
    };
  });

  // Create scheduled automation
  app.post("/api/v1/schedules", async (request, reply) => {
    const parsed = createScheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: parsed.error.issues[0]?.message ?? "Invalid schedule configuration",
        },
      });
    }

    const { name, goal, role, multiagent, interval, cronExpr, enabled } = parsed.data;
    const nextRunAt = enabled ? computeNextRunAt(interval as ScheduleInterval) : null;

    const created = await scheduleStore.createSchedule({
      id: `sched-${randomUUID()}`,
      workspaceId,
      name,
      goal,
      role,
      multiagent,
      interval: interval as ScheduleInterval,
      cronExpr,
      enabled,
      lastRunAt: null,
      nextRunAt,
    });

    reply.code(201);
    return {
      ...created,
      lastRunAt: null,
      nextRunAt: created.nextRunAt ? created.nextRunAt.toISOString() : null,
      createdAt: created.createdAt.toISOString(),
    };
  });

  // Update schedule
  app.put<{ Params: { id: string } }>("/api/v1/schedules/:id", async (request, reply) => {
    const parsed = updateScheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: parsed.error.issues[0]?.message ?? "Invalid schedule update payload",
        },
      });
    }

    const current = await scheduleStore.getSchedule(workspaceId, request.params.id);
    if (!current) {
      return fail(reply, request, 404, "schedule_not_found", "errors.notFound", {
        method: "PUT",
        url: request.url,
      });
    }

    const updates: Partial<Parameters<ScheduleStore["updateSchedule"]>[2]> = {
      ...parsed.data,
    };

    if (parsed.data.interval || parsed.data.enabled !== undefined) {
      const active = parsed.data.enabled ?? current.enabled;
      const intv = (parsed.data.interval ?? current.interval) as ScheduleInterval;
      updates.nextRunAt = active ? computeNextRunAt(intv) : null;
    }

    const updated = await scheduleStore.updateSchedule(workspaceId, request.params.id, updates);
    return {
      ...updated,
      lastRunAt: updated?.lastRunAt ? updated.lastRunAt.toISOString() : null,
      nextRunAt: updated?.nextRunAt ? updated.nextRunAt.toISOString() : null,
      createdAt: updated?.createdAt.toISOString(),
    };
  });

  // Delete schedule
  app.delete<{ Params: { id: string } }>("/api/v1/schedules/:id", async (request, reply) => {
    const success = await scheduleStore.deleteSchedule(workspaceId, request.params.id);
    if (!success) {
      return fail(reply, request, 404, "schedule_not_found", "errors.notFound", {
        method: "DELETE",
        url: request.url,
      });
    }
    return { ok: true, id: request.params.id };
  });

  // Trigger immediate execution of scheduled automation
  app.post<{ Params: { id: string } }>("/api/v1/schedules/:id/trigger", async (request, reply) => {
    const schedule = await scheduleStore.getSchedule(workspaceId, request.params.id);
    if (!schedule) {
      return fail(reply, request, 404, "schedule_not_found", "errors.notFound", {
        method: "POST",
        url: request.url,
      });
    }

    // Update lastRunAt and nextRunAt
    const now = new Date();
    const nextRun = computeNextRunAt(schedule.interval, now);
    await scheduleStore.updateSchedule(workspaceId, schedule.id, {
      lastRunAt: now,
      nextRunAt: schedule.enabled ? nextRun : null,
    });

    // Broadcast schedule triggered event
    opts.emit?.({
      id: randomUUID(),
      seq: Date.now(),
      ts: now.toISOString(),
      workspaceId,
      type: "log",
      payload: {
        level: "info",
        message: `Scheduled automation "${schedule.name}" triggered (${schedule.role}, interval: ${schedule.interval}).`,
      },
    });

    return {
      ok: true,
      scheduleId: schedule.id,
      name: schedule.name,
      triggeredAt: now.toISOString(),
      nextRunAt: schedule.enabled ? nextRun.toISOString() : null,
      dispatch: {
        goal: schedule.goal,
        role: schedule.role,
        multiagent: schedule.multiagent,
      },
    };
  });
}
