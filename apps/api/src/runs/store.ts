import { and, desc, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import type { CCEvent, EventType } from "@infuture/events";

export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export type RunRecord = {
  id: string;
  workspaceId: string;
  goal: string;
  locale: string;
  status: RunStatus;
  startedAt: Date;
  endedAt: Date | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Optional attribution: which office / zone / character (agent) the run was assigned to. */
  officeId: string | null;
  zone: string | null;
  characterId: string | null;
};

export type RunAttribution = { officeId?: string | null; zone?: string | null; characterId?: string | null };

export type TaskRecord = {
  id: string;
  runId: string;
  workerId: string | null;
  title: string;
  output: unknown;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type ApprovalRecord = {
  id: string;
  runId: string;
  taskId?: string;
  action: string;
  detail: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: Date | null;
  note?: string;
  createdAt: Date;
};

export interface RunStore {
  createRun(
    input: { id: string; workspaceId: string; goal: string; locale: string } & RunAttribution,
  ): Promise<RunRecord>;
  getRun(workspaceId: string, runId: string): Promise<RunRecord | undefined>;
  listRuns(workspaceId: string): Promise<RunRecord[]>;
  updateRun(
    runId: string,
    updates: Partial<Pick<RunRecord, "status" | "endedAt" | "tokensIn" | "tokensOut" | "costUsd">>,
  ): Promise<void>;
  createTask(input: { id: string; runId: string; workerId: string; title: string }): Promise<TaskRecord>;
  updateTask(
    taskId: string,
    updates: Partial<Pick<TaskRecord, "status" | "output" | "endedAt">>,
  ): Promise<void>;
  getTasksForRun(runId: string): Promise<TaskRecord[]>;
  createApproval(input: {
    id: string;
    runId: string;
    taskId?: string;
    action: string;
    detail?: Record<string, unknown>;
  }): Promise<ApprovalRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  listApprovals(runId?: string): Promise<ApprovalRecord[]>;
  resolveApproval(
    approvalId: string,
    decision: ApprovalStatus,
    decidedBy?: string,
    note?: string,
  ): Promise<ApprovalRecord | undefined>;
  saveEvent(event: CCEvent): Promise<void>;
  getEventsForRun(runId: string): Promise<CCEvent[]>;
  getEvents(opts?: {
    workspaceId?: string;
    runId?: string;
    type?: string;
    limit?: number;
  }): Promise<CCEvent[]>;
}

/* --------------------------------- In memory --------------------------------- */

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private tasks = new Map<string, TaskRecord>();
  private approvals = new Map<string, ApprovalRecord>();
  private events: CCEvent[] = [];

  async createRun(
    input: {
      id: string;
      workspaceId: string;
      goal: string;
      locale: string;
    } & RunAttribution,
  ): Promise<RunRecord> {
    const record: RunRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      goal: input.goal,
      locale: input.locale,
      officeId: input.officeId ?? null,
      zone: input.zone ?? null,
      characterId: input.characterId ?? null,
      status: "running",
      startedAt: new Date(),
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    this.runs.set(input.id, record);
    return record;
  }

  async getRun(workspaceId: string, runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run && run.workspaceId === workspaceId ? run : undefined;
  }

  async listRuns(workspaceId: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async updateRun(
    runId: string,
    updates: Partial<Pick<RunRecord, "status" | "endedAt" | "tokensIn" | "tokensOut" | "costUsd">>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    Object.assign(run, updates);
  }

  async createTask(input: {
    id: string;
    runId: string;
    workerId: string;
    title: string;
  }): Promise<TaskRecord> {
    const task: TaskRecord = {
      ...input,
      output: null,
      status: "running",
      startedAt: new Date(),
      endedAt: null,
    };
    this.tasks.set(input.id, task);
    return task;
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<TaskRecord, "status" | "output" | "endedAt">>,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, updates);
  }

  async getTasksForRun(runId: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((t) => t.runId === runId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async createApproval(input: {
    id: string;
    runId: string;
    taskId?: string;
    action: string;
    detail?: Record<string, unknown>;
  }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: input.id,
      runId: input.runId,
      taskId: input.taskId,
      action: input.action,
      detail: input.detail ?? {},
      status: "pending",
      decidedBy: undefined,
      decidedAt: null,
      note: undefined,
      createdAt: new Date(),
    };
    this.approvals.set(input.id, record);
    return record;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(approvalId);
  }

  async listApprovals(runId?: string): Promise<ApprovalRecord[]> {
    const all = [...this.approvals.values()];
    return (runId ? all.filter((a) => a.runId === runId) : all).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalStatus,
    decidedBy?: string,
    note?: string,
  ): Promise<ApprovalRecord | undefined> {
    const record = this.approvals.get(approvalId);
    if (!record) return undefined;
    record.status = decision;
    record.decidedBy = decidedBy;
    record.decidedAt = new Date();
    record.note = note;
    return record;
  }

  async saveEvent(event: CCEvent): Promise<void> {
    this.events.push(event);
  }

  async getEventsForRun(runId: string): Promise<CCEvent[]> {
    return this.events.filter((e) => e.runId === runId).sort((a, b) => a.seq - b.seq);
  }

  async getEvents(opts?: {
    workspaceId?: string;
    runId?: string;
    type?: string;
    limit?: number;
  }): Promise<CCEvent[]> {
    let list = this.events;
    if (opts?.workspaceId) {
      list = list.filter((e) => e.workspaceId === opts.workspaceId);
    }
    if (opts?.runId) {
      list = list.filter((e) => e.runId === opts.runId);
    }
    if (opts?.type) {
      list = list.filter((e) => e.type === opts.type);
    }
    list = [...list].sort((a, b) => a.seq - b.seq);
    if (opts?.limit && opts.limit > 0) {
      list = list.slice(-opts.limit);
    }
    return list;
  }
}

/* --------------------------------- PostgreSQL --------------------------------- */

type Db = Database;
type Schema = typeof schema;

export class PgRunStore implements RunStore {
  constructor(
    private db: Db,
    private s: Schema,
  ) {}

  async createRun(
    input: {
      id: string;
      workspaceId: string;
      goal: string;
      locale: string;
    } & RunAttribution,
  ): Promise<RunRecord> {
    const { runs } = this.s;
    const now = new Date();
    await this.db.insert(runs).values({
      id: input.id,
      workspaceId: input.workspaceId,
      goal: input.goal,
      locale: input.locale,
      officeId: input.officeId ?? null,
      zone: input.zone ?? null,
      characterId: input.characterId ?? null,
      status: "running",
      startedAt: now,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: "0",
    });
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      goal: input.goal,
      locale: input.locale,
      status: "running",
      startedAt: now,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      officeId: input.officeId ?? null,
      zone: input.zone ?? null,
      characterId: input.characterId ?? null,
    };
  }

  async getRun(workspaceId: string, runId: string): Promise<RunRecord | undefined> {
    const { runs } = this.s;
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)));
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      goal: row.goal,
      locale: row.locale,
      status: row.status as RunStatus,
      startedAt: row.startedAt ?? new Date(),
      endedAt: row.endedAt,
      tokensIn: Number(row.tokensIn),
      tokensOut: Number(row.tokensOut),
      costUsd: Number(row.costUsd),
      officeId: row.officeId ?? null,
      zone: row.zone ?? null,
      characterId: row.characterId ?? null,
    };
  }

  async listRuns(workspaceId: string): Promise<RunRecord[]> {
    const { runs } = this.s;
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId))
      .orderBy(desc(runs.startedAt));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      goal: r.goal,
      locale: r.locale,
      status: r.status as RunStatus,
      startedAt: r.startedAt ?? new Date(),
      endedAt: r.endedAt,
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      costUsd: Number(r.costUsd),
      officeId: r.officeId ?? null,
      zone: r.zone ?? null,
      characterId: r.characterId ?? null,
    }));
  }

  async updateRun(
    runId: string,
    updates: Partial<Pick<RunRecord, "status" | "endedAt" | "tokensIn" | "tokensOut" | "costUsd">>,
  ): Promise<void> {
    const { runs } = this.s;
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.endedAt !== undefined) values.endedAt = updates.endedAt;
    if (updates.tokensIn !== undefined) values.tokensIn = updates.tokensIn;
    if (updates.tokensOut !== undefined) values.tokensOut = updates.tokensOut;
    if (updates.costUsd !== undefined) values.costUsd = updates.costUsd.toFixed(6);

    await this.db.update(runs).set(values).where(eq(runs.id, runId));
  }

  async createTask(input: {
    id: string;
    runId: string;
    workerId: string;
    title: string;
  }): Promise<TaskRecord> {
    const { tasks } = this.s;
    const now = new Date();
    await this.db.insert(tasks).values({
      id: input.id,
      runId: input.runId,
      workerId: input.workerId,
      title: input.title,
      status: "running",
      startedAt: now,
    });
    return {
      id: input.id,
      runId: input.runId,
      workerId: input.workerId,
      title: input.title,
      output: null,
      status: "running",
      startedAt: now,
      endedAt: null,
    };
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<TaskRecord, "status" | "output" | "endedAt">>,
  ): Promise<void> {
    const { tasks } = this.s;
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.output !== undefined) values.output = updates.output;
    if (updates.endedAt !== undefined) values.endedAt = updates.endedAt;

    await this.db.update(tasks).set(values).where(eq(tasks.id, taskId));
  }

  async getTasksForRun(runId: string): Promise<TaskRecord[]> {
    const { tasks } = this.s;
    const rows = await this.db.select().from(tasks).where(eq(tasks.runId, runId)).orderBy(tasks.startedAt);
    return rows.map((t) => ({
      id: t.id,
      runId: t.runId,
      workerId: t.workerId,
      title: t.title,
      output: t.output,
      status: t.status,
      startedAt: t.startedAt ?? new Date(),
      endedAt: t.endedAt,
    }));
  }

  async createApproval(input: {
    id: string;
    runId: string;
    taskId?: string;
    action: string;
    detail?: Record<string, unknown>;
  }): Promise<ApprovalRecord> {
    const { approvals } = this.s;
    await this.db.insert(approvals).values({
      id: input.id,
      taskId: input.taskId,
      action: { action: input.action, ...input.detail },
      status: "pending",
    });
    return {
      id: input.id,
      runId: input.runId,
      taskId: input.taskId,
      action: input.action,
      detail: input.detail ?? {},
      status: "pending",
      decidedBy: undefined,
      decidedAt: null,
      note: undefined,
      createdAt: new Date(),
    };
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const { approvals } = this.s;
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, approvalId));
    const a = rows[0];
    if (!a) return undefined;
    const actionObj = (a.action as Record<string, unknown>) ?? {};
    return {
      id: a.id,
      runId: "",
      taskId: a.taskId ?? undefined,
      action: String(actionObj.action ?? "action"),
      detail: actionObj,
      status: a.status as ApprovalStatus,
      decidedBy: a.decidedBy ?? undefined,
      decidedAt: a.decidedAt,
      note: a.note ?? undefined,
      createdAt: a.decidedAt ?? new Date(),
    };
  }

  async listApprovals(_runId?: string): Promise<ApprovalRecord[]> {
    const { approvals } = this.s;
    const rows = await this.db.select().from(approvals);
    return rows.map((a) => {
      const actionObj = (a.action as Record<string, unknown>) ?? {};
      return {
        id: a.id,
        runId: "",
        taskId: a.taskId ?? undefined,
        action: String(actionObj.action ?? "action"),
        detail: actionObj,
        status: a.status as ApprovalStatus,
        decidedBy: a.decidedBy ?? undefined,
        decidedAt: a.decidedAt,
        note: a.note ?? undefined,
        createdAt: a.decidedAt ?? new Date(),
      };
    });
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalStatus,
    decidedBy?: string,
    note?: string,
  ): Promise<ApprovalRecord | undefined> {
    const { approvals } = this.s;
    const now = new Date();
    await this.db
      .update(approvals)
      .set({
        status: decision,
        decidedBy,
        decidedAt: now,
        note,
      })
      .where(eq(approvals.id, approvalId));
    return this.getApproval(approvalId);
  }

  async saveEvent(event: CCEvent): Promise<void> {
    const { events } = this.s;
    await this.db.insert(events).values({
      id: event.id,
      workspaceId: event.workspaceId,
      runId: event.runId,
      taskId: event.taskId,
      workerId: event.workerId,
      type: event.type,
      payload: event.payload,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      ts: new Date(event.ts),
    });
  }

  async getEventsForRun(runId: string): Promise<CCEvent[]> {
    const { events } = this.s;
    const rows = await this.db.select().from(events).where(eq(events.runId, runId)).orderBy(events.seq);
    return rows.map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      ts: r.ts.toISOString(),
      workspaceId: r.workspaceId,
      runId: r.runId ?? undefined,
      taskId: r.taskId ?? undefined,
      workerId: r.workerId ?? undefined,
      type: r.type as EventType,
      payload: r.payload as CCEvent["payload"],
      traceId: r.traceId ?? undefined,
      spanId: r.spanId ?? undefined,
      parentSpanId: r.parentSpanId ?? undefined,
    })) as CCEvent[];
  }

  async getEvents(opts?: {
    workspaceId?: string;
    runId?: string;
    type?: string;
    limit?: number;
  }): Promise<CCEvent[]> {
    const { events } = this.s;
    const conditions = [];
    if (opts?.workspaceId) conditions.push(eq(events.workspaceId, opts.workspaceId));
    if (opts?.runId) conditions.push(eq(events.runId, opts.runId));
    if (opts?.type) conditions.push(eq(events.type, opts.type));

    const whereClause =
      conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    const query = whereClause
      ? this.db.select().from(events).where(whereClause).orderBy(desc(events.seq))
      : this.db.select().from(events).orderBy(desc(events.seq));

    const rows = opts?.limit ? await query.limit(opts.limit) : await query;
    return rows.reverse().map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      ts: r.ts.toISOString(),
      workspaceId: r.workspaceId,
      runId: r.runId ?? undefined,
      taskId: r.taskId ?? undefined,
      workerId: r.workerId ?? undefined,
      type: r.type as EventType,
      payload: r.payload as CCEvent["payload"],
      traceId: r.traceId ?? undefined,
      spanId: r.spanId ?? undefined,
      parentSpanId: r.parentSpanId ?? undefined,
    })) as CCEvent[];
  }
}
