import { z } from "zod";

/**
 * Every action an agent takes is an immutable event. The dashboard, the terminal and the 3D office are
 * all views over this same stream, so this package is the contract the rest of the system depends on.
 */

const id = z.string().min(1);
const money = z.number().nonnegative();
const tokens = z.number().int().nonnegative();

export const RUN_STATUSES = ["queued", "running", "waiting_approval", "done", "failed", "cancelled"] as const;
export const TASK_STATUSES = ["pending", "running", "blocked", "done", "failed", "cancelled"] as const;
export const WORKER_STATUSES = [
  "idle",
  "thinking",
  "calling_model",
  "using_tool",
  "writing",
  "reviewing",
  "waiting_approval",
  "paused",
  "done",
  "error",
] as const;
export const CONNECTION_HEALTH = ["unverified", "healthy", "degraded", "invalid", "rate_limited"] as const;
export const BOARD_KINDS = ["finding", "idea", "question", "decision", "warning"] as const;
export const REVIEW_VERDICTS = ["approve", "request_changes", "reject"] as const;
export const SEVERITIES = ["info", "warning", "critical"] as const;
export const INTERVENTIONS = ["notice", "pause", "reassign"] as const;

/** Payload schema for each event type. Keys are the event `type`. */
export const payloadSchemas = {
  "run.created": z.object({ goal: z.string().min(1), createdBy: id.optional() }),
  "run.status_changed": z.object({ status: z.enum(RUN_STATUSES), reason: z.string().optional() }),
  "run.completed": z.object({
    status: z.enum(["done", "failed", "cancelled"]),
    tokensIn: tokens,
    tokensOut: tokens,
    costUsd: money,
    durationMs: z.number().int().nonnegative(),
  }),
  "task.created": z.object({
    title: z.string().min(1),
    parentTaskId: id.optional(),
    dependsOn: z.array(id).default([]),
  }),
  "task.assigned": z.object({ workerId: id, role: z.string().min(1) }),
  "task.status_changed": z.object({ status: z.enum(TASK_STATUSES), reason: z.string().optional() }),
  "worker.status_changed": z.object({ status: z.enum(WORKER_STATUSES), activity: z.string().optional() }),
  "worker.model_assigned": z.object({
    modelId: id.nullable(),
    providerId: z.string().nullable(),
    pinned: z.boolean(),
    reason: z.string().optional(),
  }),
  "worker.intervention": z.object({ action: z.enum(INTERVENTIONS), reason: z.string() }),
  "agent.thought": z.object({ text: z.string().min(1) }),
  "llm.request.started": z.object({
    providerId: z.string(),
    model: z.string(),
    messages: z.number().int().nonnegative(),
  }),
  "llm.token": z.object({ delta: z.string() }),
  "llm.message.completed": z.object({
    providerId: z.string(),
    model: z.string(),
    text: z.string(),
    tokensIn: tokens,
    tokensOut: tokens,
    costUsd: money,
    latencyMs: z.number().int().nonnegative(),
  }),
  "tool.call.started": z.object({ callId: id, tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  "tool.call.completed": z.object({ callId: id, tool: z.string(), summary: z.string() }),
  "tool.call.failed": z.object({ callId: id, tool: z.string(), error: z.string() }),
  "approval.requested": z.object({
    approvalId: id,
    action: z.string(),
    detail: z.record(z.string(), z.unknown()),
  }),
  "approval.resolved": z.object({
    approvalId: id,
    decision: z.enum(["approved", "rejected"]),
    decidedBy: id.optional(),
    note: z.string().optional(),
  }),
  "usage.updated": z.object({ tokensIn: tokens, tokensOut: tokens, costUsd: money }),
  "connection.health_changed": z.object({
    connectionId: id,
    providerId: z.string(),
    status: z.enum(CONNECTION_HEALTH),
  }),
  "board.posted": z.object({
    postId: id,
    topic: z.string(),
    kind: z.enum(BOARD_KINDS),
    content: z.string().min(1),
  }),
  "review.requested": z.object({ reviewId: id, reviewerWorkerId: id, round: z.number().int().positive() }),
  "review.completed": z.object({
    reviewId: id,
    verdict: z.enum(REVIEW_VERDICTS),
    critique: z.string().optional(),
    round: z.number().int().positive(),
  }),
  "watchdog.alert": z.object({
    rule: z.string(),
    severity: z.enum(SEVERITIES),
    message: z.string(),
    evidence: z.array(id).default([]),
  }),
  "artifact.created": z.object({
    artifactId: id,
    kind: z.string(),
    name: z.string(),
    uri: z.string(),
    bytes: z.number().int().nonnegative().optional(),
    content: z.string().optional(),
  }),
  "run.steered": z.object({
    prompt: z.string().min(1),
    role: z.string().optional(),
  }),
  "memory.stored": z.object({
    memoryId: id,
    role: z.string(),
    snippet: z.string(),
    importance: z.number().int().min(1).max(5),
    tags: z.array(z.string()).default([]),
  }),
  "knowledge.ingested": z.object({
    documentId: id,
    title: z.string(),
    category: z.string(),
    chunksCount: z.number().int().nonnegative(),
  }),
  "workspace.created": z.object({
    workspaceId: id,
    name: z.string().min(1),
    defaultLocale: z.string(),
  }),
  "token.created": z.object({
    tokenId: id,
    name: z.string().min(1),
    role: z.enum(["admin", "operator", "viewer"]),
    prefix: z.string(),
  }),
  "token.revoked": z.object({
    tokenId: id,
    name: z.string().min(1),
  }),
  "webhook.dispatched": z.object({
    webhookId: id,
    eventType: z.string(),
    statusCode: z.number().int().optional(),
    success: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  }),
  log: z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string() }),
} as const;

export type EventType = keyof typeof payloadSchemas;
export const EVENT_TYPES = Object.keys(payloadSchemas) as EventType[];
export type EventPayload<T extends EventType> = z.output<(typeof payloadSchemas)[T]>;
export type EventPayloadInput<T extends EventType> = z.input<(typeof payloadSchemas)[T]>;

/** Live-only events: sent over the socket but not stored, so the `events` table does not grow per token. */
const LIVE_ONLY: ReadonlySet<EventType> = new Set<EventType>(["llm.token"]);
export const isPersisted = (type: EventType): boolean => !LIVE_ONLY.has(type);

const envelopeBase = z.object({
  id,
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  workspaceId: id,
  runId: id.optional(),
  taskId: id.optional(),
  workerId: id.optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
});

export type EventEnvelope = z.output<typeof envelopeBase>;
export type CCEvent<T extends EventType = EventType> = {
  [K in T]: EventEnvelope & { type: K; payload: EventPayload<K> };
}[T];

export const eventSchema = z
  .object({
    ...envelopeBase.shape,
    type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
    payload: z.unknown(),
  })
  .transform((event, ctx) => {
    const result = payloadSchemas[event.type].safeParse(event.payload);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ["payload", ...issue.path] });
      return z.NEVER;
    }
    return { ...event, payload: result.data } as CCEvent;
  });

/** Validates unknown input (from Redis, the socket or the database) into a typed event. */
export function parseEvent(input: unknown): CCEvent {
  return eventSchema.parse(input);
}

export function safeParseEvent(input: unknown) {
  return eventSchema.safeParse(input);
}

/** UUID v7: time-ordered, so ids sort by creation time in the database and in logs. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CreateEventInput<T extends EventType> = {
  type: T;
  payload: EventPayloadInput<T>;
  workspaceId: string;
  seq: number;
  runId?: string;
  taskId?: string;
  workerId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  ts?: Date;
};

/** Builds and validates an event. Throws if the payload does not match its schema. */
export function createEvent<T extends EventType>(input: CreateEventInput<T>): CCEvent<T> {
  const { ts, ...rest } = input;
  return parseEvent({ ...rest, id: uuidv7(), ts: (ts ?? new Date()).toISOString() }) as CCEvent<T>;
}

/** Translation key for an event type's label, e.g. "events.llm.message.completed". */
export const eventLabelKey = <T extends EventType>(type: T) => `events.${type}` as const;

/* ----------------------------- Realtime socket protocol ----------------------------- */

export const topicSchema = z
  .string()
  .regex(/^(workspace|run:[\w-]+|worker:[\w-]+)$/, "Topic must be workspace, run:<id> or worker:<id>");

export const clientMessageSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("subscribe"),
    topics: z.array(topicSchema).min(1),
    sinceSeq: z.number().int().optional(),
  }),
  z.object({ op: z.literal("unsubscribe"), topics: z.array(topicSchema).min(1) }),
  z.object({ op: z.literal("command"), id: id, text: z.string().min(1) }),
  z.object({
    op: z.literal("approval"),
    approvalId: id,
    decision: z.enum(["approve", "reject"]),
    note: z.string().optional(),
  }),
  z.object({ op: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { op: "event"; event: CCEvent }
  | { op: "batch"; events: CCEvent[] }
  | { op: "ack"; id: string; ok: boolean; error?: string }
  | { op: "snapshot"; topic: string; state: unknown }
  | { op: "pong" };
