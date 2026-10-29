import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/* ----------------------------------- Identity ----------------------------------- */

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    /** Language used for agent output and notifications when a member has not chosen one. */
    defaultLocale: text("default_locale").notNull().default("en"),
    createdAt: createdAt(),
  },
  (t) => [check("workspaces_locale_check", sql`${t.defaultLocale} in ('en', 'es')`)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    /** Interface language chosen by the user. */
    locale: text("locale").notNull().default("en"),
    createdAt: createdAt(),
  },
  (t) => [check("users_locale_check", sql`${t.locale} in ('en', 'es')`)],
);

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "operator", "viewer"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/* ---------------------------- Connections and secrets ---------------------------- */

/** Catalog of provider plugins, seeded from their manifests. */
export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  authTypes: text("auth_types").array().notNull(),
  manifest: jsonb("manifest").notNull(),
});

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    alias: text("alias").notNull(),
    authType: text("auth_type", { enum: ["api_key", "oauth", "local"] }).notNull(),
    baseUrl: text("base_url"),
    status: text("status", { enum: ["unverified", "healthy", "degraded", "invalid", "rate_limited"] })
      .notNull()
      .default("unverified"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    budgetUsdMonth: numeric("budget_usd_month", { precision: 10, scale: 2 }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("connections_workspace_idx").on(t.workspaceId)],
);

/** Kept apart from `connections` so a dedicated database role can be the only one allowed to read it. */
export const credentials = pgTable("credentials", {
  connectionId: uuid("connection_id")
    .primaryKey()
    .references(() => connections.id, { onDelete: "cascade" }),
  ciphertext: bytea("ciphertext").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  kekId: text("kek_id").notNull(),
  hint: text("hint"),
  oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    capabilities: text("capabilities").array().notNull(),
    contextWindow: integer("context_window"),
    priceInPerMtok: numeric("price_in_per_mtok", { precision: 10, scale: 4 }),
    priceOutPerMtok: numeric("price_out_per_mtok", { precision: 10, scale: 4 }),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [uniqueIndex("models_connection_key_idx").on(t.connectionId, t.modelKey)],
);

/* ------------------------------------ Agents ------------------------------------ */

export const roles = pgTable(
  "roles",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    version: integer("version").notNull(),
    /** Display name per language, e.g. { "en": "Researcher", "es": "Investigador" }. */
    name: jsonb("name").$type<Record<string, string>>().notNull(),
    /** System prompt per language; the worker uses the run's language and falls back to English. */
    systemPrompt: jsonb("system_prompt").$type<Record<string, string>>().notNull(),
    requires: text("requires").array().notNull(),
    prefers: jsonb("prefers"),
    tools: text("tools").array().notNull(),
    limits: jsonb("limits"),
    approval: jsonb("approval"),
    sprite: text("sprite"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id, t.version] })],
);

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull(),
  roleVersion: integer("role_version").notNull(),
  name: text("name").notNull(),
  modelId: uuid("model_id").references(() => models.id, { onDelete: "set null" }),
  fallbackModelIds: uuid("fallback_model_ids").array(),
  pinned: boolean("pinned").notNull().default(false),
  status: text("status").notNull().default("idle"),
  createdAt: createdAt(),
});

/* ---------------------------------- Execution ---------------------------------- */

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    /** Language the agents answer in. */
    locale: text("locale").notNull().default("en"),
    status: text("status", {
      enum: ["queued", "running", "waiting_approval", "done", "failed", "cancelled"],
    }).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    index("runs_workspace_idx").on(t.workspaceId),
    check("runs_locale_check", sql`${t.locale} in ('en', 'es')`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id"),
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: text("status").notNull(),
    dependsOn: uuid("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("tasks_run_idx").on(t.runId)],
);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  action: jsonb("action").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  meta: jsonb("meta"),
  createdAt: createdAt(),
});

/* ------------------------- Collaboration and supervision ------------------------- */

export const boardPosts = pgTable(
  "board_posts",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    kind: text("kind", { enum: ["finding", "idea", "question", "decision", "warning"] }).notNull(),
    authorWorkerId: uuid("author_worker_id").references(() => workers.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("board_posts_run_topic_idx").on(t.runId, t.topic, t.seq)],
);

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  reviewerWorkerId: uuid("reviewer_worker_id").references(() => workers.id, { onDelete: "set null" }),
  reviewerModelId: uuid("reviewer_model_id").references(() => models.id, { onDelete: "set null" }),
  round: integer("round").notNull(),
  verdict: text("verdict", { enum: ["approve", "request_changes", "reject"] }),
  critique: text("critique"),
  createdAt: createdAt(),
});

/* ------------------------------ Events and usage ------------------------------ */

/**
 * Append-only source of truth. Monthly partitioning will be added in a hand-written migration,
 * because Drizzle does not model partitions.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").notNull(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id"),
    taskId: uuid("task_id"),
    workerId: uuid("worker_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.id] }),
    index("events_run_seq_idx").on(t.runId, t.seq),
    index("events_worker_ts_idx").on(t.workerId, t.ts),
    index("events_type_ts_idx").on(t.type, t.ts),
  ],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id"),
    modelId: uuid("model_id"),
    runId: uuid("run_id"),
    workerId: uuid("worker_id"),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    latencyMs: integer("latency_ms"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_workspace_ts_idx").on(t.workspaceId, t.ts)],
);

/* -------------------------------------- UI -------------------------------------- */

export const dashboardLayouts = pgTable("dashboard_layouts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  layout: jsonb("layout").notNull(),
  widgets: jsonb("widgets").notNull(),
  theme: jsonb("theme"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id"),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------------------- Automations --------------------------------- */

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal").notNull(),
    role: text("role").notNull(),
    multiagent: boolean("multiagent").notNull().default(false),
    interval: text("interval", { enum: ["hourly", "daily", "weekly", "custom"] }).notNull(),
    cronExpr: text("cron_expr"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_workspace_idx").on(t.workspaceId)],
);

/* --------------------------------- Tools & MCP --------------------------------- */

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transport: text("transport", { enum: ["stdio", "sse"] })
      .notNull()
      .default("stdio"),
    command: text("command"),
    args: text("args").array(),
    url: text("url"),
    enabled: boolean("enabled").notNull().default(true),
    discoveredTools: jsonb("discovered_tools"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_servers_workspace_idx").on(t.workspaceId)],
);

export const customTools = pgTable(
  "custom_tools",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    parameters: jsonb("parameters").notNull(),
    code: text("code").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("custom_tools_workspace_idx").on(t.workspaceId)],
);

/* ----------------------------- Agent Memory & RAG ------------------------------ */

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("all"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default([]),
    importance: integer("importance").notNull().default(3),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_memories_workspace_idx").on(t.workspaceId),
    index("agent_memories_role_idx").on(t.workspaceId, t.role),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    category: text("category").notNull().default("general"),
    content: text("content").notNull(),
    chunks: jsonb("chunks").notNull().default([]),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_docs_workspace_idx").on(t.workspaceId),
    index("knowledge_docs_category_idx").on(t.workspaceId, t.category),
  ],
);

/* -------------------- Multi-tenant Tokens & Webhooks --------------------- */

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    role: text("role", { enum: ["admin", "operator", "viewer"] })
      .notNull()
      .default("operator"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_tokens_workspace_idx").on(t.workspaceId),
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").array().notNull().default(["*"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_workspace_idx").on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    statusCode: integer("status_code"),
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms").notNull(),
    error: text("error"),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_deliveries_webhook_idx").on(t.webhookId),
    index("webhook_deliveries_workspace_idx").on(t.workspaceId),
  ],
);

/** 3D offices (floor plans) with their zones and characters/sprites. */
export const offices = pgTable(
  "offices",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    theme: text("theme").notNull().default("#6366f1"),
    zones: text("zones").array().notNull(),
    characters: jsonb("characters").notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("offices_workspace_idx").on(t.workspaceId)],
);
