import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BOARD_KINDS, type CCEvent } from "@infuture/events";
import { SUPPORTED_LOCALES, type Locale, type TranslationKey } from "@infuture/i18n";
import { decryptSecret, type MasterKey } from "@infuture/vault";
import {
  executeGoal,
  executeMultiAgentRun,
  BUILTIN_TOOLS,
  type WorkerIdentity,
  type WorkerRole,
} from "@infuture/worker";
import { LOCAL_WORKSPACE_ID, type ConnectionStore } from "../connections/store";
import type { RoleStore } from "../roles/store";
import type { RunRecord, RunStore, TaskRecord } from "../runs/store";

export type RunRoutesOptions = {
  runStore: RunStore;
  connectionStore: ConnectionStore;
  roleStore?: RoleStore;
  masterKey: MasterKey | null;
  fetch?: typeof fetch;
  emit?: (event: CCEvent) => void;
};

const createRunSchema = z.object({
  goal: z.string().trim().min(1).max(5000),
  connectionId: z.string().uuid().optional(),
  model: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).default("supervisor"),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  multiagent: z.boolean().default(false),
});

const postBoardSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  kind: z.enum(BOARD_KINDS),
  content: z.string().trim().min(1).max(2000),
  runId: z.string().uuid().optional(),
});

const steerRunSchema = z.object({
  prompt: z.string().trim().min(1).max(5000),
  role: z.string().trim().min(1).optional(),
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

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku",
  groq: "llama-3.1-8b-instant",
  ollama: "llama3.2",
};

export async function runRoutes(app: FastifyInstance, opts: RunRoutesOptions) {
  const { runStore, connectionStore, masterKey } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  // Active in-flight approval resolvers
  const pendingApprovalResolvers = new Map<
    string,
    (res: { decision: "approved" | "rejected"; note?: string }) => void
  >();

  app.get("/api/v1/approvals", async () => {
    return runStore.listApprovals();
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/approvals", async (request) => {
    return runStore.listApprovals(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { decision: "approved" | "rejected"; note?: string };
  }>("/api/v1/approvals/:id/resolve", async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? { decision: "approved" };
    const approval = await runStore.getApproval(id);
    if (!approval) {
      return reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
    }

    const updated = await runStore.resolveApproval(id, body.decision, undefined, body.note);

    // Resolve in-memory pending gate if waiting
    const resolver = pendingApprovalResolvers.get(id);
    if (resolver) {
      resolver({ decision: body.decision, note: body.note });
      pendingApprovalResolvers.delete(id);
    }

    return updated;
  });

  app.get<{ Querystring: { runId?: string } }>("/api/v1/board", async (request) => {
    const { runId } = request.query;
    const events = await runStore.getEvents({
      workspaceId,
      runId,
      type: "board.posted",
      limit: 50,
    });
    return events.map((e) => {
      const payload = e.payload as {
        postId: string;
        topic: string;
        kind: string;
        content: string;
      };
      return {
        id: payload.postId,
        topic: payload.topic,
        kind: payload.kind,
        content: payload.content,
        runId: e.runId ?? null,
        ts: e.ts,
      };
    });
  });

  app.post("/api/v1/board", async (request, reply) => {
    const parsed = postBoardSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: parsed.error.issues[0]?.message ?? "Invalid board post payload",
        },
      });
    }

    const { topic, kind, content, runId } = parsed.data;
    const postId = randomUUID();
    const event: CCEvent = {
      id: randomUUID(),
      seq: Date.now(),
      ts: new Date().toISOString(),
      workspaceId,
      runId,
      type: "board.posted",
      payload: {
        postId,
        topic,
        kind,
        content,
      },
    };

    await runStore.saveEvent(event);
    opts.emit?.(event);

    reply.code(201);
    return {
      id: postId,
      topic,
      kind,
      content,
      runId: runId ?? null,
      ts: event.ts,
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/artifacts", async (request) => {
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
    const events = await runStore.getEvents({
      workspaceId,
      type: "artifact.created",
      limit: Number.isNaN(limit) ? 50 : limit,
    });
    return events.map((e) => {
      const p = e.payload as {
        artifactId: string;
        kind: string;
        name: string;
        uri: string;
        bytes?: number;
        content?: string;
      };
      return {
        id: p.artifactId,
        runId: e.runId ?? null,
        kind: p.kind,
        name: p.name,
        uri: p.uri,
        bytes: p.bytes ?? p.content?.length ?? 0,
        content: p.content,
        ts: e.ts,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/api/v1/artifacts/:id", async (request, reply) => {
    const events = await runStore.getEvents({
      workspaceId,
      type: "artifact.created",
      limit: 200,
    });
    const found = events.find((e) => (e.payload as { artifactId: string }).artifactId === request.params.id);
    if (!found) {
      return fail(reply, request, 404, "artifact_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    }
    const p = found.payload as {
      artifactId: string;
      kind: string;
      name: string;
      uri: string;
      bytes?: number;
      content?: string;
    };
    return {
      id: p.artifactId,
      runId: found.runId ?? null,
      kind: p.kind,
      name: p.name,
      uri: p.uri,
      bytes: p.bytes ?? p.content?.length ?? 0,
      content: p.content ?? "",
      ts: found.ts,
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/artifacts", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run) {
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    }
    const events = await runStore.getEventsForRun(run.id);
    const artifactEvents = events.filter((e) => e.type === "artifact.created");
    return artifactEvents.map((e) => {
      const p = e.payload as {
        artifactId: string;
        kind: string;
        name: string;
        uri: string;
        bytes?: number;
        content?: string;
      };
      return {
        id: p.artifactId,
        runId: run.id,
        kind: p.kind,
        name: p.name,
        uri: p.uri,
        bytes: p.bytes ?? p.content?.length ?? 0,
        content: p.content,
        ts: e.ts,
      };
    });
  });

  app.get("/api/v1/runs", async () => {
    const runs = await runStore.listRuns(workspaceId);
    return runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    }));
  });

  app.get("/api/v1/analytics", async () => {
    const runs = await runStore.listRuns(workspaceId);
    const byStatus = {
      queued: 0,
      running: 0,
      waiting_approval: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;

    for (const r of runs) {
      if (r.status in byStatus) {
        byStatus[r.status as keyof typeof byStatus]++;
      }
      totalTokensIn += r.tokensIn ?? 0;
      totalTokensOut += r.tokensOut ?? 0;
      totalCostUsd += r.costUsd ?? 0;
    }

    const totalRuns = runs.length;
    const completedRuns = byStatus.done + byStatus.failed + byStatus.cancelled;
    const successRatePercent = completedRuns > 0 ? Math.round((byStatus.done / completedRuns) * 100) : 100;
    const averageCostPerRun = totalRuns > 0 ? Number((totalCostUsd / totalRuns).toFixed(4)) : 0;

    return {
      totalRuns,
      byStatus,
      totalTokensIn,
      totalTokensOut,
      totalTokens: totalTokensIn + totalTokensOut,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      successRatePercent,
      averageCostPerRun,
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run) {
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "POST",
        url: request.url,
      });
    }

    if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
      return reply.code(400).send({
        error: {
          code: "run_already_terminal",
          message: `Run ${run.id} is already in terminal state "${run.status}".`,
        },
      });
    }

    const endedAt = new Date();
    await runStore.updateRun(run.id, {
      status: "cancelled",
      endedAt,
    });

    // Cancel any pending approvals for this run
    const approvalsList = await runStore.listApprovals(run.id);
    for (const a of approvalsList) {
      if (a.status === "pending") {
        await runStore.resolveApproval(a.id, "rejected", "operator", "Cancelled due to run cancellation");
        const resolver = pendingApprovalResolvers.get(a.id);
        if (resolver) {
          resolver({ decision: "rejected", note: "Run cancelled" });
          pendingApprovalResolvers.delete(a.id);
        }
      }
    }

    const durationMs = endedAt.getTime() - run.startedAt.getTime();

    // Emit cancellation events
    opts.emit?.({
      id: randomUUID(),
      seq: 9999,
      ts: endedAt.toISOString(),
      workspaceId,
      runId: run.id,
      type: "run.status_changed",
      payload: { status: "cancelled", reason: "Cancelled by operator" },
    });

    opts.emit?.({
      id: randomUUID(),
      seq: 10000,
      ts: endedAt.toISOString(),
      workspaceId,
      runId: run.id,
      type: "run.completed",
      payload: {
        status: "cancelled",
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costUsd: run.costUsd,
        durationMs,
      },
    });

    const updated = await runStore.getRun(workspaceId, run.id);
    return {
      ...updated,
      startedAt: updated?.startedAt.toISOString(),
      endedAt: updated?.endedAt?.toISOString() ?? null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run)
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    const tasks = await runStore.getTasksForRun(run.id);
    const finalTask = [...tasks].reverse().find((t) => typeof t.output === "string" && t.output.trim());
    const output = typeof finalTask?.output === "string" ? finalTask.output : null;
    return {
      ...run,
      output,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      tasks: tasks.map((t) => ({
        ...t,
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
      })),
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: { format?: "markdown" | "html" | "json" };
  }>("/api/v1/runs/:id/export", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run) {
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    }

    const format = request.query.format ?? "markdown";
    const tasks = await runStore.getTasksForRun(run.id);
    const events = await runStore.getEventsForRun(run.id);
    const finalTask = [...tasks].reverse().find((t) => typeof t.output === "string" && t.output.trim());
    const output = typeof finalTask?.output === "string" ? finalTask.output : null;

    const artifactEvents = events.filter((e) => e.type === "artifact.created");
    const artifacts = artifactEvents.map((e) => {
      const p = e.payload as {
        artifactId: string;
        name: string;
        kind: string;
        bytes?: number;
        content?: string;
      };
      return {
        id: p.artifactId,
        name: p.name,
        kind: p.kind,
        bytes: p.bytes ?? p.content?.length ?? 0,
        content: p.content,
      };
    });

    if (format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="infuture-run-${run.id.slice(0, 8)}.json"`);
      return {
        run: {
          ...run,
          output,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
        },
        tasks: tasks.map((t) => ({
          ...t,
          startedAt: t.startedAt.toISOString(),
          endedAt: t.endedAt?.toISOString() ?? null,
        })),
        artifacts,
        eventsCount: events.length,
      };
    }

    if (format === "html") {
      const html = buildRunHtmlReport(run, tasks, artifacts, events, output);
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="infuture-run-${run.id.slice(0, 8)}.html"`);
      return reply.send(html);
    }

    const md = buildRunMarkdownReport(run, tasks, artifacts, events, output);
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="infuture-run-${run.id.slice(0, 8)}.md"`);
    return reply.send(md);
  });

  app.post<{
    Params: { id: string };
    Body: { prompt: string; role?: string };
  }>("/api/v1/runs/:id/feedback", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run) {
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "POST",
        url: request.url,
      });
    }

    const parsed = steerRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }
    const { prompt, role: requestedRole } = parsed.data;
    const steerRole = (requestedRole ?? "supervisor") as WorkerRole;
    const locale = run.locale as Locale;

    // 1. Locate connection
    const connections = await connectionStore.list(workspaceId);
    const connection = connections.find((c) => c.status === "healthy") ?? connections[0];
    if (!connection) {
      return reply.code(400).send({
        error: {
          code: "no_connection",
          message:
            locale === "es"
              ? "No hay conexiones de proveedores configuradas."
              : "No provider connections configured.",
        },
      });
    }

    // 2. Resolve secret
    let secret: string | null = null;
    if (connection.authType !== "local") {
      if (!masterKey) {
        return fail(reply, request, 503, "vault_unavailable", "errors.vaultUnavailable");
      }
      const sealed = await connectionStore.getSealed(connection.id);
      if (!sealed) {
        return fail(reply, request, 409, "secret_missing", "errors.secretMissing");
      }
      secret = decryptSecret(sealed, masterKey, connection.id);
    }

    const model = connection.models[0] || DEFAULT_MODELS[connection.providerId] || "default";

    // 3. Emit run.steered event
    const steerEventId = randomUUID();
    const steerEvent: CCEvent = {
      id: steerEventId,
      seq: 9100,
      ts: new Date().toISOString(),
      workspaceId,
      runId: run.id,
      type: "run.steered",
      payload: { prompt, role: steerRole },
    };
    await runStore.saveEvent(steerEvent);
    opts.emit?.(steerEvent);

    // 4. Fetch previous tasks & output
    const prevTasks = await runStore.getTasksForRun(run.id);
    const lastOutputTask = [...prevTasks]
      .reverse()
      .find((t) => typeof t.output === "string" && t.output.trim());
    const lastOutput = typeof lastOutputTask?.output === "string" ? lastOutputTask.output : "";

    // 5. Create new steer subtask
    const steerTaskId = randomUUID();
    await runStore.createTask({
      id: steerTaskId,
      runId: run.id,
      workerId: randomUUID(),
      title: `Operator Steer: ${prompt.slice(0, 50)}`,
    });

    const steerWorker: WorkerIdentity = {
      workerId: randomUUID(),
      role: steerRole,
      name: `${connection.alias} Steer Agent`,
      providerId: connection.providerId,
      model,
      baseUrl: connection.baseUrl,
      secret,
    };

    const roleDef = opts.roleStore ? await opts.roleStore.getRole(workspaceId, steerRole) : undefined;
    const customPrompt = roleDef ? (roleDef.systemPrompt[locale] ?? roleDef.systemPrompt.en) : undefined;
    const allowedTools = roleDef?.tools
      ? Object.values(BUILTIN_TOOLS).filter((t) => roleDef.tools.includes(t.name))
      : undefined;

    const continuationGoal = `Continuation and Operator Feedback for Run "${run.goal}":\n\nInstruction from human operator:\n"${prompt}"\n\n${lastOutput ? `Previous Deliverable Output:\n${lastOutput}` : ""}`;

    const execution = await executeGoal({
      workspaceId,
      runId: run.id,
      taskId: steerTaskId,
      goal: continuationGoal,
      locale,
      worker: steerWorker,
      systemPrompt: customPrompt,
      tools: allowedTools,
      onRequestApproval: async (req) => {
        const approvalRecord = await runStore.createApproval({
          id: req.approvalId,
          runId: run.id,
          taskId: steerTaskId,
          action: req.action,
          detail: req.detail,
        });
        opts.emit?.({
          id: randomUUID(),
          seq: 100,
          ts: new Date().toISOString(),
          workspaceId,
          runId: run.id,
          taskId: steerTaskId,
          type: "approval.requested",
          payload: {
            approvalId: approvalRecord.id,
            action: approvalRecord.action,
            detail: approvalRecord.detail,
          },
        });
        return new Promise((resolve) => {
          pendingApprovalResolvers.set(approvalRecord.id, resolve);
        });
      },
      onEvent: async (event) => {
        await runStore.saveEvent(event);
        opts.emit?.(event);
      },
      fetch: opts.fetch,
    });

    const separator =
      locale === "es" ? "Instrucción y ampliación del operador" : "Operator Steer & Continuation";
    const steerOutput = execution.output ?? "";
    const steerHeader = `### 🔄 ${separator}\n*${prompt}*\n\n`;
    const combinedOutput = lastOutput
      ? `${lastOutput}\n\n---\n${steerHeader}${steerOutput}`
      : `${steerHeader}${steerOutput}`;

    await runStore.updateTask(steerTaskId, {
      status: execution.status,
      output: combinedOutput,
      endedAt: new Date(),
    });

    const newTokensIn = run.tokensIn + execution.tokensIn;
    const newTokensOut = run.tokensOut + execution.tokensOut;
    const newCost = run.costUsd + execution.costUsd;

    await runStore.updateRun(run.id, {
      status: execution.status === "failed" ? "failed" : "done",
      endedAt: new Date(),
      tokensIn: newTokensIn,
      tokensOut: newTokensOut,
      costUsd: newCost,
    });

    opts.emit?.({
      id: randomUUID(),
      seq: 9999,
      ts: new Date().toISOString(),
      workspaceId,
      runId: run.id,
      type: "run.completed",
      payload: {
        status: execution.status === "failed" ? "failed" : "done",
        tokensIn: newTokensIn,
        tokensOut: newTokensOut,
        costUsd: newCost,
        durationMs: execution.durationMs,
      },
    });

    const updatedTasks = await runStore.getTasksForRun(run.id);

    return {
      id: run.id,
      workspaceId,
      goal: run.goal,
      locale,
      status: execution.status === "failed" ? "failed" : "done",
      output: combinedOutput,
      tasks: updatedTasks.map((t) => ({
        ...t,
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
      })),
      tokensIn: newTokensIn,
      tokensOut: newTokensOut,
      costUsd: newCost,
      startedAt: run.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/events", async (request, reply) => {
    const run = await runStore.getRun(workspaceId, request.params.id);
    if (!run)
      return fail(reply, request, 404, "run_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    return runStore.getEventsForRun(run.id);
  });

  app.post("/api/v1/runs", async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }
    const body = parsed.data;
    const locale: Locale = body.locale ?? request.locale;

    // 1. Locate connection
    const connections = await connectionStore.list(workspaceId);
    const connection = body.connectionId
      ? connections.find((c) => c.id === body.connectionId)
      : (connections.find((c) => c.status === "healthy") ?? connections[0]);

    if (!connection) {
      return reply.code(400).send({
        error: {
          code: "no_connection",
          message:
            locale === "es"
              ? "No hay conexiones de proveedores configuradas. Conecta un proveedor primero."
              : "No provider connections configured. Connect a provider first.",
        },
      });
    }

    // 2. Resolve secret
    let secret: string | null = null;
    if (connection.authType !== "local") {
      if (!masterKey) {
        return fail(reply, request, 503, "vault_unavailable", "errors.vaultUnavailable");
      }
      const sealed = await connectionStore.getSealed(connection.id);
      if (!sealed) {
        return fail(reply, request, 409, "secret_missing", "errors.secretMissing");
      }
      secret = decryptSecret(sealed, masterKey, connection.id);
    }

    // 3. Resolve model
    const model = body.model || connection.models[0] || DEFAULT_MODELS[connection.providerId] || "default";

    const runId = randomUUID();

    // 4. Record Run in store
    const createdRun = await runStore.createRun({
      id: runId,
      workspaceId,
      goal: body.goal,
      locale,
    });

    const defaultWorker: WorkerIdentity = {
      workerId: randomUUID(),
      role: body.role as WorkerRole,
      name: `${connection.alias} Worker`,
      providerId: connection.providerId,
      model,
      baseUrl: connection.baseUrl,
      secret,
    };

    const roleDef = opts.roleStore ? await opts.roleStore.getRole(workspaceId, body.role) : undefined;
    const customPrompt = roleDef ? (roleDef.systemPrompt[locale] ?? roleDef.systemPrompt.en) : undefined;
    const allowedTools = roleDef?.tools
      ? Object.values(BUILTIN_TOOLS).filter((t) => roleDef.tools.includes(t.name))
      : undefined;

    if (body.multiagent) {
      // Build worker pool with model routing if additional connections exist
      const workerPool: Partial<Record<WorkerRole, WorkerIdentity>> = {};
      const secondaryConn = connections.find(
        (c) => c.id !== connection.id && (c.status === "healthy" || c.status === "unverified"),
      );

      if (secondaryConn && masterKey) {
        let secSecret: string | null = null;
        if (secondaryConn.authType !== "local") {
          const secSealed = await connectionStore.getSealed(secondaryConn.id);
          if (secSealed) {
            secSecret = decryptSecret(secSealed, masterKey, secondaryConn.id);
          }
        }
        const secModel = secondaryConn.models[0] || DEFAULT_MODELS[secondaryConn.providerId] || "default";
        // Cross-review with alternative provider/connection
        workerPool.reviewer = {
          workerId: randomUUID(),
          role: "reviewer",
          name: `${secondaryConn.alias} Reviewer`,
          providerId: secondaryConn.providerId,
          model: secModel,
          baseUrl: secondaryConn.baseUrl,
          secret: secSecret,
        };
      }

      let customPrompts: Record<string, string> | undefined;
      if (opts.roleStore) {
        const rolesList = await opts.roleStore.listRoles(workspaceId);
        customPrompts = {};
        for (const r of rolesList) {
          customPrompts[r.id] = r.systemPrompt[locale] ?? r.systemPrompt.en ?? "";
        }
      }

      const multiExecution = await executeMultiAgentRun({
        workspaceId,
        runId,
        goal: body.goal,
        locale,
        defaultWorker,
        workerPool,
        customPrompts,
        fetch: opts.fetch,
        onEvent: async (event) => {
          await runStore.saveEvent(event);
          opts.emit?.(event);
        },
      });

      // Save each subtask to store
      for (const t of multiExecution.tasks) {
        await runStore.createTask({
          id: t.taskId,
          runId,
          workerId: t.workerId,
          title: t.title,
        });
        await runStore.updateTask(t.taskId, {
          status: t.status,
          output: t.output,
          endedAt: new Date(),
        });
      }

      await runStore.updateRun(runId, {
        status: multiExecution.status,
        endedAt: new Date(),
        tokensIn: multiExecution.totalTokensIn,
        tokensOut: multiExecution.totalTokensOut,
        costUsd: multiExecution.totalCostUsd,
      });

      reply.code(201);
      return {
        id: runId,
        workspaceId,
        goal: createdRun.goal,
        locale,
        status: multiExecution.status,
        output: multiExecution.finalOutput,
        tasks: multiExecution.tasks,
        reviews: multiExecution.reviews,
        boardPosts: multiExecution.boardPosts,
        tokensIn: multiExecution.totalTokensIn,
        tokensOut: multiExecution.totalTokensOut,
        costUsd: multiExecution.totalCostUsd,
        durationMs: multiExecution.totalDurationMs,
        eventsCount: multiExecution.events.length,
        startedAt: createdRun.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      };
    }

    // Single agent execution
    const taskId = randomUUID();
    await runStore.createTask({
      id: taskId,
      runId,
      workerId: defaultWorker.workerId,
      title: body.goal,
    });

    const execution = await executeGoal({
      workspaceId,
      runId,
      taskId,
      goal: body.goal,
      locale,
      worker: defaultWorker,
      systemPrompt: customPrompt,
      tools: allowedTools,
      onRequestApproval: async (req) => {
        await runStore.createApproval({
          id: req.approvalId,
          runId,
          taskId,
          action: req.action,
          detail: req.detail,
        });
        await runStore.updateRun(runId, { status: "waiting_approval" });

        return new Promise((resolve) => {
          pendingApprovalResolvers.set(req.approvalId, resolve);
          setTimeout(() => {
            if (pendingApprovalResolvers.has(req.approvalId)) {
              pendingApprovalResolvers.delete(req.approvalId);
              resolve({ decision: "approved", note: "Auto-approved after timeout" });
            }
          }, 300_000);
        });
      },
      fetch: opts.fetch,
      onEvent: async (event) => {
        await runStore.saveEvent(event);
        opts.emit?.(event);
      },
    });

    // Clean secret from local memory
    secret = null;

    // Update Run and Task in store with final outcome
    await runStore.updateTask(taskId, {
      status: execution.status,
      output: execution.output,
      endedAt: new Date(),
    });

    await runStore.updateRun(runId, {
      status: execution.status,
      endedAt: new Date(),
      tokensIn: execution.tokensIn,
      tokensOut: execution.tokensOut,
      costUsd: execution.costUsd,
    });

    reply.code(201);
    return {
      id: runId,
      workspaceId,
      goal: createdRun.goal,
      locale,
      status: execution.status,
      output: execution.output,
      tokensIn: execution.tokensIn,
      tokensOut: execution.tokensOut,
      costUsd: execution.costUsd,
      durationMs: execution.durationMs,
      eventsCount: execution.events.length,
      startedAt: createdRun.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    };
  });
}

/* ----------------------------- Export Report Generators ----------------------------- */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildRunMarkdownReport(
  run: RunRecord,
  tasks: TaskRecord[],
  artifacts: Array<{ id: string; name: string; kind: string; bytes: number; content?: string }>,
  events: CCEvent[],
  output: string | null,
): string {
  const durationMs = run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : 0;
  const durationStr = `${(durationMs / 1000).toFixed(2)}s`;
  const totalTokens = run.tokensIn + run.tokensOut;

  let md = `# 🚀 infuture IA · Run Executive Dossier\n\n`;
  md += `**Run ID:** \`${run.id}\`  \n`;
  md += `**Status:** \`${run.status.toUpperCase()}\`  \n`;
  md += `**Locale:** \`${run.locale.toUpperCase()}\`  \n`;
  md += `**Exported At:** ${new Date().toISOString()}  \n\n`;
  md += `---\n\n`;
  md += `## 🎯 Objective / Goal\n> ${run.goal}\n\n`;

  md += `## 📊 Performance & Cost Summary\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| **Status** | \`${run.status.toUpperCase()}\` |\n`;
  md += `| **Duration** | ${durationStr} |\n`;
  md += `| **Tokens In** | ${run.tokensIn.toLocaleString()} |\n`;
  md += `| **Tokens Out** | ${run.tokensOut.toLocaleString()} |\n`;
  md += `| **Total Tokens** | ${totalTokens.toLocaleString()} |\n`;
  md += `| **Total Cost** | $${run.costUsd.toFixed(4)} USD |\n`;
  md += `| **Started At** | ${run.startedAt.toISOString()} |\n`;
  md += `| **Ended At** | ${run.endedAt ? run.endedAt.toISOString() : "Ongoing"} |\n\n`;

  md += `## 🛠 Tasks & Execution Trail (${tasks.length})\n\n`;
  if (tasks.length === 0) {
    md += `*No subtasks recorded.*\n\n`;
  } else {
    for (const t of tasks) {
      const taskDuration = t.endedAt
        ? `${((t.endedAt.getTime() - t.startedAt.getTime()) / 1000).toFixed(2)}s`
        : "running";
      md += `### • ${t.title}\n`;
      md += `- **Task ID:** \`${t.id}\`\n`;
      md += `- **Status:** \`${t.status.toUpperCase()}\`\n`;
      md += `- **Duration:** ${taskDuration}\n`;
      if (typeof t.output === "string" && t.output.trim() && t.output !== output) {
        md += `- **Output Summary:**\n\`\`\`\n${t.output.slice(0, 500)}${t.output.length > 500 ? "..." : ""}\n\`\`\`\n`;
      }
      md += `\n`;
    }
  }

  const boardEvents = events.filter((e) => e.type === "board.posted");
  if (boardEvents.length > 0) {
    md += `## 📝 Collaborative Whiteboard Notes (${boardEvents.length})\n\n`;
    for (const b of boardEvents) {
      const bp = b.payload as { kind: string; topic: string; content: string };
      md += `- **[${bp.kind.toUpperCase()}] ${bp.topic}:** ${bp.content} *(${b.ts})*\n`;
    }
    md += `\n`;
  }

  const reviewEvents = events.filter((e) => e.type === "review.completed");
  if (reviewEvents.length > 0) {
    md += `## ⚖ Review & Quality Audits (${reviewEvents.length})\n\n`;
    for (const r of reviewEvents) {
      const rp = r.payload as { verdict: string; critique?: string };
      md += `- **Verdict:** \`${rp.verdict.toUpperCase()}\` — ${rp.critique ?? "Approved"} *(${r.ts})*\n`;
    }
    md += `\n`;
  }

  md += `## 📦 Artifacts & Generated Files (${artifacts.length})\n\n`;
  if (artifacts.length === 0) {
    md += `*No artifacts recorded for this run.*\n\n`;
  } else {
    for (const a of artifacts) {
      md += `### 📄 ${a.name} (${a.kind.toUpperCase()}, ${a.bytes} bytes)\n`;
      if (a.content) {
        md += `\`\`\`${a.kind === "code" || a.name.endsWith(".ts") || a.name.endsWith(".js") ? "typescript" : "markdown"}\n${a.content}\n\`\`\`\n\n`;
      }
    }
  }

  md += `## 📄 Final Deliverable\n\n`;
  md += output ? output : `*No final deliverable produced.*`;
  md += `\n\n---\n*Report generated by infuture IA Autonomous Command Center*\n`;

  return md;
}

function buildRunHtmlReport(
  run: RunRecord,
  tasks: TaskRecord[],
  artifacts: Array<{ id: string; name: string; kind: string; bytes: number; content?: string }>,
  _events: CCEvent[],
  output: string | null,
): string {
  const durationMs = run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : 0;
  const durationStr = `${(durationMs / 1000).toFixed(2)}s`;
  const totalTokens = run.tokensIn + run.tokensOut;
  const safeGoal = escapeHtml(run.goal);
  const safeOutput = escapeHtml(output ?? "No deliverable output recorded.");

  return `<!DOCTYPE html>
<html lang="${run.locale}">
<head>
  <meta charset="utf-8">
  <title>infuture IA Dossier · ${safeGoal.slice(0, 40)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #0b0c16;
      --card: #131424;
      --line: #262846;
      --fg: #e2e8f0;
      --muted: #94a3b8;
      --accent: #818cf8;
      --ok: #34d399;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 32px 20px;
      line-height: 1.55;
    }
    .container { max-width: 860px; margin: 0 auto; }
    .header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 8px; font-size: 24px; color: #fff; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; font-family: monospace; }
    .badge-ok { background: rgba(52,211,153,0.2); color: var(--ok); }
    .badge-accent { background: rgba(129,140,248,0.2); color: var(--accent); }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 20px; }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 600; }
    pre { background: #07070e; border: 1px solid var(--line); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; }
    .task-item { padding: 10px; background: rgba(255,255,255,0.02); border-radius: 6px; margin-bottom: 8px; border: 1px solid var(--line); }
    @media print {
      body { background: #fff; color: #000; }
      .card { border: 1px solid #ccc; background: #fafafa; color: #000; }
      pre { background: #f4f4f4; border: 1px solid #ddd; color: #000; }
      .badge { border: 1px solid #aaa; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="badge badge-accent">infuture IA · Run Dossier</span>
        <span class="badge badge-ok">${run.status.toUpperCase()}</span>
      </div>
      <h1>${safeGoal}</h1>
      <div style="color:var(--muted); font-size:12px; font-family:monospace;">
        Run ID: ${run.id} | Exported: ${new Date().toISOString()}
      </div>
    </div>

    <div class="card">
      <h2>Performance & Cost Summary</h2>
      <table>
        <tr><th>Metric</th><th>Value</th><th>Metric</th><th>Value</th></tr>
        <tr><td><strong>Status</strong></td><td>${run.status.toUpperCase()}</td><td><strong>Duration</strong></td><td>${durationStr}</td></tr>
        <tr><td><strong>Tokens In</strong></td><td>${run.tokensIn.toLocaleString()}</td><td><strong>Tokens Out</strong></td><td>${run.tokensOut.toLocaleString()}</td></tr>
        <tr><td><strong>Total Tokens</strong></td><td>${totalTokens.toLocaleString()}</td><td><strong>Total Cost</strong></td><td>$${run.costUsd.toFixed(4)} USD</td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Tasks Breakdown (${tasks.length})</h2>
      ${
        tasks.length === 0
          ? "<p style='color:var(--muted);font-style:italic;'>No subtasks recorded.</p>"
          : tasks
              .map(
                (t) => `
        <div class="task-item">
          <div style="display:flex; justify-content:space-between; font-weight:600; font-size:13px;">
            <span>${escapeHtml(t.title)}</span>
            <span class="badge ${t.status === "done" ? "badge-ok" : "badge-accent"}">${t.status}</span>
          </div>
        </div>`,
              )
              .join("")
      }
    </div>

    <div class="card">
      <h2>Artifacts Generated (${artifacts.length})</h2>
      ${
        artifacts.length === 0
          ? "<p style='color:var(--muted);font-style:italic;'>No artifacts recorded.</p>"
          : artifacts
              .map(
                (a) => `
        <div class="task-item">
          <div style="display:flex; justify-content:space-between; font-weight:600; font-size:13px;">
            <span>📄 ${escapeHtml(a.name)} (${a.kind.toUpperCase()})</span>
            <span>${a.bytes} B</span>
          </div>
        </div>`,
              )
              .join("")
      }
    </div>

    <div class="card">
      <h2>Final Deliverable Output</h2>
      <pre>${safeOutput}</pre>
    </div>
  </div>
</body>
</html>`;
}
