import { and, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import {
  ROLE_COLORS,
  ROLE_DEFAULT_TOOLS,
  ROLE_LIMITS,
  ROLE_SYSTEM_PROMPTS,
  type WorkerRole,
} from "@infuture/worker";
import { LOCAL_WORKSPACE_ID } from "../connections/store";

export type RoleLimits = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxIterations?: number;
};

export type RoleDefinition = {
  id: string;
  version: number;
  name: Record<string, string>;
  description: Record<string, string>;
  systemPrompt: Record<string, string>;
  requires: string[];
  prefers?: Record<string, unknown>;
  tools: string[];
  limits?: RoleLimits;
  approval?: { sensitiveTools: string[] };
  sprite?: string;
  isCustom?: boolean;
};

export type WorkerBinding = {
  id: string;
  workspaceId: string;
  roleId: string;
  roleVersion: number;
  name: string;
  connectionId?: string | null;
  modelKey?: string | null;
  fallbackModelKeys?: string[];
  pinned: boolean;
  status: string;
  createdAt: Date;
};

export const BUILTIN_ROLE_IDS: readonly WorkerRole[] = [
  "supervisor",
  "researcher",
  "analyst",
  "developer",
  "writer",
  "reviewer",
  "receptionist",
] as const;

export const BUILTIN_ROLE_NAMES: Record<WorkerRole, Record<string, string>> = {
  supervisor: { en: "Supervisor", es: "Supervisor" },
  researcher: { en: "Researcher", es: "Investigador" },
  analyst: { en: "Analyst", es: "Analista" },
  developer: { en: "Developer", es: "Desarrollador" },
  writer: { en: "Writer", es: "Redactor" },
  reviewer: { en: "Reviewer", es: "Revisor" },
  receptionist: { en: "Receptionist", es: "Recepcionista" },
};

export const BUILTIN_ROLE_DESCRIPTIONS: Record<WorkerRole, Record<string, string>> = {
  supervisor: {
    en: "Breaks the goal into tasks and coordinates the team.",
    es: "Desglosa el objetivo en tareas y coordina al equipo.",
  },
  researcher: {
    en: "Searches, reads and summarizes sources.",
    es: "Busca, lee y sintetiza fuentes de información.",
  },
  analyst: {
    en: "Processes data and compares options.",
    es: "Procesa datos y compara opciones.",
  },
  developer: {
    en: "Writes and runs code in a sandbox.",
    es: "Escribe y ejecuta código en un entorno aislado.",
  },
  writer: {
    en: "Writes the final deliverable.",
    es: "Redacta el entregable final.",
  },
  reviewer: {
    en: "Checks other agents' work with a model from another provider.",
    es: "Revisa el trabajo de otros agentes con un modelo de otro proveedor.",
  },
  receptionist: {
    en: "Answers the terminal and reports the status.",
    es: "Responde en la terminal e informa del estado.",
  },
};

export function createDefaultRoleDefinition(id: WorkerRole): RoleDefinition {
  return {
    id,
    version: 1,
    name: { ...BUILTIN_ROLE_NAMES[id] },
    description: { ...BUILTIN_ROLE_DESCRIPTIONS[id] },
    systemPrompt: { ...ROLE_SYSTEM_PROMPTS[id] },
    requires: id === "supervisor" ? ["planning", "synthesis"] : ["reasoning"],
    prefers: {
      color: ROLE_COLORS[id],
      sprite: id,
      description: BUILTIN_ROLE_DESCRIPTIONS[id],
    },
    tools: [...ROLE_DEFAULT_TOOLS[id]],
    limits: { ...ROLE_LIMITS[id] },
    approval: { sensitiveTools: ["file_write"] },
    sprite: id,
    isCustom: false,
  };
}

export function getDefaultRoles(): RoleDefinition[] {
  return BUILTIN_ROLE_IDS.map(createDefaultRoleDefinition);
}

export interface RoleStore {
  listRoles(workspaceId: string): Promise<RoleDefinition[]>;
  getRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined>;
  saveRole(workspaceId: string, role: RoleDefinition): Promise<RoleDefinition>;
  deleteRole(workspaceId: string, roleId: string): Promise<boolean>;
  resetRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined>;

  listWorkers(workspaceId: string): Promise<WorkerBinding[]>;
  getWorker(workspaceId: string, workerId: string): Promise<WorkerBinding | undefined>;
  saveWorker(workspaceId: string, worker: WorkerBinding): Promise<WorkerBinding>;
  deleteWorker(workspaceId: string, workerId: string): Promise<boolean>;
}

/* --------------------------------- In Memory Store --------------------------------- */

export class MemoryRoleStore implements RoleStore {
  private roles = new Map<string, Map<string, RoleDefinition>>();
  private workers = new Map<string, Map<string, WorkerBinding>>();

  constructor() {
    this.ensureInitialized(LOCAL_WORKSPACE_ID);
  }

  private ensureInitialized(workspaceId: string): Map<string, RoleDefinition> {
    let wsRoles = this.roles.get(workspaceId);
    if (!wsRoles) {
      wsRoles = new Map<string, RoleDefinition>();
      for (const roleDef of getDefaultRoles()) {
        wsRoles.set(roleDef.id, { ...roleDef });
      }
      this.roles.set(workspaceId, wsRoles);

      // Seed default worker bindings
      let wsWorkers = this.workers.get(workspaceId);
      if (!wsWorkers) {
        wsWorkers = new Map<string, WorkerBinding>();
        this.workers.set(workspaceId, wsWorkers);
        for (const roleId of BUILTIN_ROLE_IDS) {
          const wId = `worker-${roleId}-default`;
          const name = BUILTIN_ROLE_NAMES[roleId]?.en ?? roleId;
          wsWorkers.set(wId, {
            id: wId,
            workspaceId,
            roleId,
            roleVersion: 1,
            name: `${name} Worker`,
            connectionId: null,
            modelKey: null,
            fallbackModelKeys: [],
            pinned: false,
            status: "idle",
            createdAt: new Date(),
          });
        }
      }
    }
    return wsRoles;
  }

  async listRoles(workspaceId: string): Promise<RoleDefinition[]> {
    const wsRoles = this.ensureInitialized(workspaceId);
    return Array.from(wsRoles.values());
  }

  async getRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined> {
    const wsRoles = this.ensureInitialized(workspaceId);
    return wsRoles.get(roleId);
  }

  async saveRole(workspaceId: string, role: RoleDefinition): Promise<RoleDefinition> {
    const wsRoles = this.ensureInitialized(workspaceId);
    const existing = wsRoles.get(role.id);
    const isBuiltin = BUILTIN_ROLE_IDS.includes(role.id as WorkerRole);
    const isCustom = existing ? (existing.isCustom ?? !isBuiltin) : !isBuiltin;

    const saved: RoleDefinition = {
      ...role,
      version: existing ? existing.version + 1 : 1,
      isCustom,
    };
    wsRoles.set(role.id, saved);
    return saved;
  }

  async deleteRole(workspaceId: string, roleId: string): Promise<boolean> {
    const wsRoles = this.ensureInitialized(workspaceId);
    if (BUILTIN_ROLE_IDS.includes(roleId as WorkerRole)) {
      return false; // Cannot delete built-in roles
    }
    return wsRoles.delete(roleId);
  }

  async resetRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined> {
    const wsRoles = this.ensureInitialized(workspaceId);
    if (!BUILTIN_ROLE_IDS.includes(roleId as WorkerRole)) {
      return undefined;
    }
    const fresh = createDefaultRoleDefinition(roleId as WorkerRole);
    wsRoles.set(roleId, fresh);
    return fresh;
  }

  async listWorkers(workspaceId: string): Promise<WorkerBinding[]> {
    this.ensureInitialized(workspaceId);
    const wsWorkers = this.workers.get(workspaceId);
    return wsWorkers ? Array.from(wsWorkers.values()) : [];
  }

  async getWorker(workspaceId: string, workerId: string): Promise<WorkerBinding | undefined> {
    this.ensureInitialized(workspaceId);
    const wsWorkers = this.workers.get(workspaceId);
    return wsWorkers?.get(workerId);
  }

  async saveWorker(workspaceId: string, worker: WorkerBinding): Promise<WorkerBinding> {
    this.ensureInitialized(workspaceId);
    let wsWorkers = this.workers.get(workspaceId);
    if (!wsWorkers) {
      wsWorkers = new Map<string, WorkerBinding>();
      this.workers.set(workspaceId, wsWorkers);
    }
    wsWorkers.set(worker.id, { ...worker });
    return worker;
  }

  async deleteWorker(workspaceId: string, workerId: string): Promise<boolean> {
    this.ensureInitialized(workspaceId);
    const wsWorkers = this.workers.get(workspaceId);
    return wsWorkers ? wsWorkers.delete(workerId) : false;
  }
}

/* --------------------------------- PostgreSQL Store --------------------------------- */

export class PgRoleStore implements RoleStore {
  constructor(
    private readonly db: Database,
    private readonly s: typeof schema,
  ) {}

  private async ensureSeeded(workspaceId: string): Promise<void> {
    const { roles } = this.s;
    const existing = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.workspaceId, workspaceId));

    if (existing.length === 0) {
      for (const def of getDefaultRoles()) {
        await this.db
          .insert(roles)
          .values({
            workspaceId,
            id: def.id,
            version: def.version,
            name: def.name,
            systemPrompt: def.systemPrompt,
            requires: def.requires,
            prefers: def.prefers,
            tools: def.tools,
            limits: def.limits,
            approval: def.approval,
            sprite: def.sprite,
          })
          .onConflictDoNothing();
      }
    }
  }

  async listRoles(workspaceId: string): Promise<RoleDefinition[]> {
    await this.ensureSeeded(workspaceId);
    const { roles } = this.s;
    const rows = await this.db.select().from(roles).where(eq(roles.workspaceId, workspaceId));
    return rows.map((r) => {
      const prefers = (r.prefers as Record<string, unknown>) ?? {};
      const description = (prefers.description as Record<string, string>) ??
        BUILTIN_ROLE_DESCRIPTIONS[r.id as WorkerRole] ?? { en: "", es: "" };
      const isBuiltin = BUILTIN_ROLE_IDS.includes(r.id as WorkerRole);
      return {
        id: r.id,
        version: r.version,
        name: r.name,
        description,
        systemPrompt: r.systemPrompt,
        requires: r.requires,
        prefers,
        tools: r.tools,
        limits: (r.limits as RoleLimits) ?? undefined,
        approval: (r.approval as { sensitiveTools: string[] }) ?? undefined,
        sprite: r.sprite ?? undefined,
        isCustom: !isBuiltin,
      };
    });
  }

  async getRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined> {
    await this.ensureSeeded(workspaceId);
    const { roles } = this.s;
    const rows = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, roleId)));
    const r = rows[0];
    if (!r) return undefined;
    const prefers = (r.prefers as Record<string, unknown>) ?? {};
    const description = (prefers.description as Record<string, string>) ??
      BUILTIN_ROLE_DESCRIPTIONS[r.id as WorkerRole] ?? { en: "", es: "" };
    const isBuiltin = BUILTIN_ROLE_IDS.includes(r.id as WorkerRole);
    return {
      id: r.id,
      version: r.version,
      name: r.name,
      description,
      systemPrompt: r.systemPrompt,
      requires: r.requires,
      prefers,
      tools: r.tools,
      limits: (r.limits as RoleLimits) ?? undefined,
      approval: (r.approval as { sensitiveTools: string[] }) ?? undefined,
      sprite: r.sprite ?? undefined,
      isCustom: !isBuiltin,
    };
  }

  async saveRole(workspaceId: string, role: RoleDefinition): Promise<RoleDefinition> {
    await this.ensureSeeded(workspaceId);
    const { roles } = this.s;
    const existing = await this.getRole(workspaceId, role.id);
    const version = existing ? existing.version + 1 : 1;
    const prefers = {
      ...(role.prefers ?? {}),
      description: role.description,
    };

    if (existing) {
      await this.db
        .update(roles)
        .set({
          version,
          name: role.name,
          systemPrompt: role.systemPrompt,
          requires: role.requires,
          prefers,
          tools: role.tools,
          limits: role.limits,
          approval: role.approval,
          sprite: role.sprite,
        })
        .where(
          and(eq(roles.workspaceId, workspaceId), eq(roles.id, role.id), eq(roles.version, existing.version)),
        );
    } else {
      await this.db.insert(roles).values({
        workspaceId,
        id: role.id,
        version,
        name: role.name,
        systemPrompt: role.systemPrompt,
        requires: role.requires,
        prefers,
        tools: role.tools,
        limits: role.limits,
        approval: role.approval,
        sprite: role.sprite,
      });
    }

    return (await this.getRole(workspaceId, role.id))!;
  }

  async deleteRole(workspaceId: string, roleId: string): Promise<boolean> {
    if (BUILTIN_ROLE_IDS.includes(roleId as WorkerRole)) {
      return false;
    }
    const { roles } = this.s;
    await this.db.delete(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, roleId)));
    return true;
  }

  async resetRole(workspaceId: string, roleId: string): Promise<RoleDefinition | undefined> {
    if (!BUILTIN_ROLE_IDS.includes(roleId as WorkerRole)) {
      return undefined;
    }
    const fresh = createDefaultRoleDefinition(roleId as WorkerRole);
    return this.saveRole(workspaceId, fresh);
  }

  async listWorkers(workspaceId: string): Promise<WorkerBinding[]> {
    const { workers } = this.s;
    const rows = await this.db.select().from(workers).where(eq(workers.workspaceId, workspaceId));
    return rows.map((w) => ({
      id: w.id,
      workspaceId: w.workspaceId,
      roleId: w.roleId,
      roleVersion: w.roleVersion,
      name: w.name,
      connectionId: null,
      modelKey: w.modelId ? String(w.modelId) : null,
      fallbackModelKeys: (w.fallbackModelIds as string[]) ?? [],
      pinned: w.pinned,
      status: w.status,
      createdAt: w.createdAt,
    }));
  }

  async getWorker(workspaceId: string, workerId: string): Promise<WorkerBinding | undefined> {
    const { workers } = this.s;
    const rows = await this.db
      .select()
      .from(workers)
      .where(and(eq(workers.workspaceId, workspaceId), eq(workers.id, workerId)));
    const w = rows[0];
    if (!w) return undefined;
    return {
      id: w.id,
      workspaceId: w.workspaceId,
      roleId: w.roleId,
      roleVersion: w.roleVersion,
      name: w.name,
      connectionId: null,
      modelKey: w.modelId ? String(w.modelId) : null,
      fallbackModelKeys: (w.fallbackModelIds as string[]) ?? [],
      pinned: w.pinned,
      status: w.status,
      createdAt: w.createdAt,
    };
  }

  async saveWorker(workspaceId: string, worker: WorkerBinding): Promise<WorkerBinding> {
    const { workers } = this.s;
    const existing = await this.getWorker(workspaceId, worker.id);
    if (existing) {
      await this.db
        .update(workers)
        .set({
          roleId: worker.roleId,
          roleVersion: worker.roleVersion,
          name: worker.name,
          pinned: worker.pinned,
          status: worker.status,
        })
        .where(and(eq(workers.workspaceId, workspaceId), eq(workers.id, worker.id)));
    } else {
      await this.db.insert(workers).values({
        id: worker.id,
        workspaceId,
        roleId: worker.roleId,
        roleVersion: worker.roleVersion,
        name: worker.name,
        pinned: worker.pinned,
        status: worker.status,
      });
    }
    return worker;
  }

  async deleteWorker(workspaceId: string, workerId: string): Promise<boolean> {
    const { workers } = this.s;
    await this.db.delete(workers).where(and(eq(workers.workspaceId, workspaceId), eq(workers.id, workerId)));
    return true;
  }
}
