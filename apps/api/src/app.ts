import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { PROVIDERS } from "@infuture/providers";
import { loadMasterKey } from "@infuture/vault";
import type { Env } from "./env";
import { registerLocale } from "./locale";
import { systemRoutes } from "./routes/system";
import { connectionRoutes, type ConnectionRoutesOptions } from "./routes/connections";
import { runRoutes } from "./routes/runs";
import { roleRoutes } from "./routes/roles";
import { realtimeRoutes } from "./routes/realtime";
import { RealtimeHub } from "./realtime/hub";
import { MemoryConnectionStore, type ConnectionStore } from "./connections/store";
import { MemoryRunStore, type RunStore } from "./runs/store";
import { MemoryRoleStore, type RoleStore } from "./roles/store";
import { MemoryScheduleStore, type ScheduleStore } from "./schedules/store";
import { scheduleRoutes } from "./routes/schedules";
import { MemoryMcpServerStore, type McpServerStore } from "./tools/store";
import { toolRoutes } from "./routes/tools";
import { MemoryKnowledgeStore, type KnowledgeStore } from "./memory/store";
import { memoryRoutes } from "./routes/memory";
import { MemoryWorkspaceStore, type WorkspaceStore } from "./workspaces/store";
import { workspaceRoutes } from "./routes/workspaces";
import { MemoryOfficeStore, type OfficeStore } from "./offices/store";
import { officeRoutes } from "./routes/offices";
import { metricsRoutes } from "./routes/metrics";
import { MetricsCollector } from "./system/metrics";
import { LOCAL_WORKSPACE_ID } from "./connections/store";

export const VERSION = "0.1.0";

export type AppDeps = {
  /** Defaults to an in-memory store; the server passes the PostgreSQL one when DATABASE_URL is set. */
  store?: ConnectionStore;
  runStore?: RunStore;
  roleStore?: RoleStore;
  scheduleStore?: ScheduleStore;
  mcpStore?: McpServerStore;
  knowledgeStore?: KnowledgeStore;
  workspaceStore?: WorkspaceStore;
  /** Virtual offices (in memory only for now). */
  officeStore?: OfficeStore;
  hub?: RealtimeHub;
  /** Trivial DB query for health/latency in /api/v1/system/metrics (only when a DB is configured). */
  dbPing?: () => Promise<unknown>;
  /** Overrides INFUTURE_MASTER_KEY (null disables the vault). */
  masterKey?: ConnectionRoutesOptions["masterKey"];
  fetch?: typeof fetch;
  emit?: ConnectionRoutesOptions["emit"];
};

export async function buildApp(env: Env, options: FastifyServerOptions = {}, deps: AppDeps = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.LOG_LEVEL },
    ...options,
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN.split(",").map((origin) => origin.trim()),
    exposedHeaders: ["Content-Language"],
  });

  registerLocale(app, env.DEFAULT_LOCALE);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "not_found",
        message: request.t("errors.notFound", {
          method: request.method,
          url: request.url.split("?")[0] ?? "",
        }),
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: { code: "validation", message: request.t("errors.validation", { details: error.message }) },
      });
    }
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({
      error: {
        code: error.code ?? "internal",
        message: status >= 500 ? request.t("errors.internal") : error.message,
      },
    });
  });

  await app.register(systemRoutes, { version: VERSION, startedAt: Date.now() });
  await app.register(websocket);

  const store = deps.store ?? new MemoryConnectionStore();
  await store.init(PROVIDERS);

  const runStore = deps.runStore ?? new MemoryRunStore();
  const roleStore = deps.roleStore ?? new MemoryRoleStore();
  const scheduleStore = deps.scheduleStore ?? new MemoryScheduleStore();
  const mcpStore = deps.mcpStore ?? new MemoryMcpServerStore();
  const knowledgeStore = deps.knowledgeStore ?? new MemoryKnowledgeStore();
  const workspaceStore = deps.workspaceStore ?? new MemoryWorkspaceStore();
  const hub = deps.hub ?? new RealtimeHub(runStore);

  const resolvedMasterKey =
    deps.masterKey !== undefined
      ? deps.masterKey
      : env.INFUTURE_MASTER_KEY
        ? loadMasterKey(env.INFUTURE_MASTER_KEY)
        : null;

  const emit = (event: Parameters<NonNullable<ConnectionRoutesOptions["emit"]>>[0]) => {
    if (env.NODE_ENV !== "test") {
      app.log.info({ event }, event.type);
    }
    hub.broadcast(event);
    deps.emit?.(event);

    // Auto-dispatch matching webhooks asynchronously
    workspaceStore
      .listWebhooks(event.workspaceId)
      .then((hooks) => {
        for (const hook of hooks) {
          if (!hook.enabled) continue;
          if (hook.events.includes("*") || hook.events.includes(event.type)) {
            workspaceStore.dispatch(hook, event, deps.fetch).catch((err) => {
              if (env.NODE_ENV !== "test") {
                app.log.error({ err, hookId: hook.id }, "Failed to dispatch webhook");
              }
            });
          }
        }
      })
      .catch(() => {});
  };

  await app.register(connectionRoutes, {
    store,
    masterKey: resolvedMasterKey,
    fetch: deps.fetch,
    emit,
  });

  await app.register(runRoutes, {
    runStore,
    connectionStore: store,
    roleStore,
    masterKey: resolvedMasterKey,
    fetch: deps.fetch,
    emit,
  });

  await app.register(roleRoutes, { roleStore });

  await app.register(toolRoutes, { mcpStore, apiHost: env.API_HOST, apiToken: env.API_TOKEN });

  await app.register(memoryRoutes, { knowledgeStore, emit });

  await app.register(workspaceRoutes, { workspaceStore, emit, fetch: deps.fetch });

  await app.register(scheduleRoutes, {
    scheduleStore,
    runStore,
    connectionStore: store,
    emit,
  });

  await app.register(officeRoutes, { officeStore: deps.officeStore ?? new MemoryOfficeStore() });

  await app.register(realtimeRoutes, { hub });

  const activeStatuses = new Set(["queued", "running", "waiting_approval"]);
  const collector = new MetricsCollector({
    dbPing: deps.dbPing,
    activeRuns: async () =>
      (await runStore.listRuns(LOCAL_WORKSPACE_ID)).filter((r) => activeStatuses.has(r.status)).length,
  });
  if (env.NODE_ENV !== "test") collector.start();
  app.addHook("onClose", async () => collector.stop());
  await app.register(metricsRoutes, { collector });

  return app;
}
