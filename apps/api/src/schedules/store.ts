import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import { LOCAL_WORKSPACE_ID } from "../connections/store";

export type ScheduleInterval = "hourly" | "daily" | "weekly" | "custom";

export type ScheduleRecord = {
  id: string;
  workspaceId: string;
  name: string;
  goal: string;
  role: string;
  multiagent: boolean;
  interval: ScheduleInterval;
  cronExpr?: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
};

export interface ScheduleStore {
  listSchedules(workspaceId: string): Promise<ScheduleRecord[]>;
  getSchedule(workspaceId: string, id: string): Promise<ScheduleRecord | undefined>;
  createSchedule(schedule: Omit<ScheduleRecord, "createdAt">): Promise<ScheduleRecord>;
  updateSchedule(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<ScheduleRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<ScheduleRecord | undefined>;
  deleteSchedule(workspaceId: string, id: string): Promise<boolean>;
}

export function computeNextRunAt(interval: ScheduleInterval, from: Date = new Date()): Date {
  const next = new Date(from.getTime());
  switch (interval) {
    case "hourly":
      next.setHours(next.getHours() + 1);
      break;
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "custom":
    default:
      next.setHours(next.getHours() + 12);
      break;
  }
  return next;
}

export class MemoryScheduleStore implements ScheduleStore {
  private schedules = new Map<string, ScheduleRecord>();

  constructor() {
    this.seedDefaultSchedules();
  }

  private seedDefaultSchedules() {
    const s1: ScheduleRecord = {
      id: "sched-audit-daily",
      workspaceId: LOCAL_WORKSPACE_ID,
      name: "Daily Autonomous Agent Health & Provider Audit",
      goal: "Verify connected AI model providers, check status and report system readiness.",
      role: "receptionist",
      multiagent: false,
      interval: "daily",
      enabled: true,
      lastRunAt: null,
      nextRunAt: computeNextRunAt("daily"),
      createdAt: new Date(),
    };
    const s2: ScheduleRecord = {
      id: "sched-security-weekly",
      workspaceId: LOCAL_WORKSPACE_ID,
      name: "Weekly Zero-Trust Security & Workspace Scan",
      goal: "Review workspace secrets encryption, audit watchdog alert logs and check tool approval rules.",
      role: "reviewer",
      multiagent: true,
      interval: "weekly",
      enabled: true,
      lastRunAt: null,
      nextRunAt: computeNextRunAt("weekly"),
      createdAt: new Date(),
    };
    this.schedules.set(s1.id, s1);
    this.schedules.set(s2.id, s2);
  }

  async listSchedules(workspaceId: string): Promise<ScheduleRecord[]> {
    return Array.from(this.schedules.values()).filter((s) => s.workspaceId === workspaceId);
  }

  async getSchedule(workspaceId: string, id: string): Promise<ScheduleRecord | undefined> {
    const s = this.schedules.get(id);
    return s && s.workspaceId === workspaceId ? s : undefined;
  }

  async createSchedule(input: Omit<ScheduleRecord, "createdAt">): Promise<ScheduleRecord> {
    const record: ScheduleRecord = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: new Date(),
    };
    this.schedules.set(record.id, record);
    return record;
  }

  async updateSchedule(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<ScheduleRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<ScheduleRecord | undefined> {
    const current = await this.getSchedule(workspaceId, id);
    if (!current) return undefined;
    const updated: ScheduleRecord = {
      ...current,
      ...updates,
    };
    this.schedules.set(id, updated);
    return updated;
  }

  async deleteSchedule(workspaceId: string, id: string): Promise<boolean> {
    const current = await this.getSchedule(workspaceId, id);
    if (!current) return false;
    return this.schedules.delete(id);
  }
}

/* --------------------------------- PostgreSQL --------------------------------- */

type Db = Database;
type Schema = typeof schema;

export class PgScheduleStore implements ScheduleStore {
  constructor(
    private db: Db,
    private s: Schema,
  ) {}

  async listSchedules(workspaceId: string): Promise<ScheduleRecord[]> {
    const { schedules } = this.s;
    const rows = await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId));
    return rows.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      name: s.name,
      goal: s.goal,
      role: s.role,
      multiagent: s.multiagent,
      interval: s.interval as ScheduleInterval,
      cronExpr: s.cronExpr ?? undefined,
      enabled: s.enabled,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
      createdAt: s.createdAt,
    }));
  }

  async getSchedule(workspaceId: string, id: string): Promise<ScheduleRecord | undefined> {
    const { schedules } = this.s;
    const [row] = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, id)));
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      goal: row.goal,
      role: row.role,
      multiagent: row.multiagent,
      interval: row.interval as ScheduleInterval,
      cronExpr: row.cronExpr ?? undefined,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      createdAt: row.createdAt,
    };
  }

  async createSchedule(input: Omit<ScheduleRecord, "createdAt">): Promise<ScheduleRecord> {
    const { schedules } = this.s;
    const now = new Date();
    const id = input.id || randomUUID();
    await this.db.insert(schedules).values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      goal: input.goal,
      role: input.role,
      multiagent: input.multiagent,
      interval: input.interval,
      cronExpr: input.cronExpr,
      enabled: input.enabled,
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      createdAt: now,
    });
    return {
      ...input,
      id,
      createdAt: now,
    };
  }

  async updateSchedule(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<ScheduleRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<ScheduleRecord | undefined> {
    const { schedules } = this.s;
    const current = await this.getSchedule(workspaceId, id);
    if (!current) return undefined;

    const values: Record<string, unknown> = {};
    if (updates.name !== undefined) values.name = updates.name;
    if (updates.goal !== undefined) values.goal = updates.goal;
    if (updates.role !== undefined) values.role = updates.role;
    if (updates.multiagent !== undefined) values.multiagent = updates.multiagent;
    if (updates.interval !== undefined) values.interval = updates.interval;
    if (updates.cronExpr !== undefined) values.cronExpr = updates.cronExpr;
    if (updates.enabled !== undefined) values.enabled = updates.enabled;
    if (updates.lastRunAt !== undefined) values.lastRunAt = updates.lastRunAt;
    if (updates.nextRunAt !== undefined) values.nextRunAt = updates.nextRunAt;

    if (Object.keys(values).length > 0) {
      await this.db
        .update(schedules)
        .set(values)
        .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, id)));
    }

    return this.getSchedule(workspaceId, id);
  }

  async deleteSchedule(workspaceId: string, id: string): Promise<boolean> {
    const { schedules } = this.s;
    const current = await this.getSchedule(workspaceId, id);
    if (!current) return false;
    await this.db.delete(schedules).where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, id)));
    return true;
  }
}
