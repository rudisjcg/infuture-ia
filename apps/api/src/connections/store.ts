import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import type { SealedSecret } from "@infuture/vault";
import type { AuthType, ConnectionHealth, ProviderManifest } from "@infuture/providers";

/** Single local workspace until accounts arrive. */
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export type Connection = {
  id: string;
  workspaceId: string;
  providerId: string;
  alias: string;
  authType: AuthType;
  baseUrl: string | null;
  status: ConnectionHealth;
  lastCheckedAt: Date | null;
  budgetUsdMonth: string | null;
  createdAt: Date;
  /** Last characters of the secret, never the secret itself. */
  hint: string | null;
  models: string[];
};

export type NewConnection = {
  id: string;
  workspaceId: string;
  providerId: string;
  alias: string;
  authType: AuthType;
  baseUrl: string | null;
  budgetUsdMonth: string | null;
  sealed: SealedSecret | null;
};

/** Persistence for connections. Secrets go in and come out sealed; decryption happens in the routes. */
export interface ConnectionStore {
  init(providers: readonly ProviderManifest[]): Promise<void>;
  list(workspaceId: string): Promise<Connection[]>;
  get(workspaceId: string, id: string): Promise<Connection | undefined>;
  getSealed(id: string): Promise<SealedSecret | undefined>;
  create(input: NewConnection): Promise<Connection>;
  recordCheck(id: string, status: ConnectionHealth, models: string[] | null): Promise<void>;
  revoke(workspaceId: string, id: string): Promise<boolean>;
}

/* --------------------------------- In memory --------------------------------- */

export class MemoryConnectionStore implements ConnectionStore {
  private rows = new Map<string, Connection & { sealed: SealedSecret | null; revoked: boolean }>();

  async init() {}

  async list(workspaceId: string) {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && !r.revoked)
      .map(({ sealed: _s, revoked: _r, ...c }) => ({ ...c, models: [...c.models] }));
  }

  async get(workspaceId: string, id: string) {
    return (await this.list(workspaceId)).find((c) => c.id === id);
  }

  async getSealed(id: string) {
    const row = this.rows.get(id);
    return row && !row.revoked ? (row.sealed ?? undefined) : undefined;
  }

  async create(input: NewConnection) {
    const { sealed, ...rest } = input;
    const row = {
      ...rest,
      status: "unverified" as const,
      lastCheckedAt: null,
      createdAt: new Date(),
      hint: sealed?.hint ?? null,
      models: [],
      sealed,
      revoked: false,
    };
    this.rows.set(input.id, row);
    return (await this.get(input.workspaceId, input.id))!;
  }

  async recordCheck(id: string, status: ConnectionHealth, models: string[] | null) {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = status;
    row.lastCheckedAt = new Date();
    if (models) row.models = [...models];
  }

  async revoke(workspaceId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.revoked) return false;
    row.revoked = true;
    row.sealed = null;
    return true;
  }
}

/* --------------------------------- PostgreSQL --------------------------------- */

type Db = Database;
type Schema = typeof schema;

export class PgConnectionStore implements ConnectionStore {
  constructor(
    private db: Db,
    private s: Schema,
  ) {}

  async init(providers: readonly ProviderManifest[]) {
    const { workspaces, providers: providersTable } = this.s;
    await this.db.insert(workspaces).values({ id: LOCAL_WORKSPACE_ID, name: "Local" }).onConflictDoNothing();
    for (const p of providers) {
      const row = { displayName: p.displayName, authTypes: [...p.authTypes], manifest: p };
      await this.db
        .insert(providersTable)
        .values({ id: p.id, ...row })
        .onConflictDoUpdate({ target: providersTable.id, set: row });
    }
  }

  async list(workspaceId: string) {
    return this.query(workspaceId);
  }

  async get(workspaceId: string, id: string) {
    return (await this.query(workspaceId, id))[0];
  }

  private async query(workspaceId: string, id?: string): Promise<Connection[]> {
    const { connections: c, credentials: cr, models: m } = this.s;
    const rows = await this.db
      .select({
        id: c.id,
        workspaceId: c.workspaceId,
        providerId: c.providerId,
        alias: c.alias,
        authType: c.authType,
        baseUrl: c.baseUrl,
        status: c.status,
        lastCheckedAt: c.lastCheckedAt,
        budgetUsdMonth: c.budgetUsdMonth,
        createdAt: c.createdAt,
        hint: cr.hint,
      })
      .from(c)
      .leftJoin(cr, eq(cr.connectionId, c.id))
      .where(and(eq(c.workspaceId, workspaceId), isNull(c.revokedAt), id ? eq(c.id, id) : undefined))
      .orderBy(c.createdAt);
    if (rows.length === 0) return [];
    const modelRows = await this.db
      .select({ connectionId: m.connectionId, key: m.modelKey })
      .from(m)
      .where(
        inArray(
          m.connectionId,
          rows.map((r) => r.id),
        ),
      );
    return rows.map((r) => ({
      ...r,
      models: modelRows
        .filter((x) => x.connectionId === r.id)
        .map((x) => x.key)
        .sort(),
    }));
  }

  async getSealed(id: string) {
    const { credentials: cr, connections: c } = this.s;
    const [row] = await this.db
      .select({ ciphertext: cr.ciphertext, wrappedDek: cr.wrappedDek, kekId: cr.kekId, hint: cr.hint })
      .from(cr)
      .innerJoin(c, eq(c.id, cr.connectionId))
      .where(and(eq(cr.connectionId, id), isNull(c.revokedAt)));
    return row ? { ...row, hint: row.hint ?? "" } : undefined;
  }

  async create(input: NewConnection) {
    const { sealed, ...rest } = input;
    await this.db.transaction(async (tx) => {
      await tx.insert(this.s.connections).values(rest);
      if (sealed) await tx.insert(this.s.credentials).values({ connectionId: input.id, ...sealed });
    });
    return (await this.get(input.workspaceId, input.id))!;
  }

  async recordCheck(id: string, status: ConnectionHealth, models: string[] | null) {
    const { connections: c, models: m } = this.s;
    await this.db.transaction(async (tx) => {
      await tx.update(c).set({ status, lastCheckedAt: new Date() }).where(eq(c.id, id));
      if (!models) return;
      await tx.delete(m).where(eq(m.connectionId, id));
      if (models.length > 0) {
        await tx
          .insert(m)
          .values(
            models.map((modelKey) => ({ id: randomUUID(), connectionId: id, modelKey, capabilities: [] })),
          );
      }
    });
  }

  async revoke(workspaceId: string, id: string) {
    const { connections: c, credentials: cr } = this.s;
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(c)
        .set({ revokedAt: new Date() })
        .where(and(eq(c.id, id), eq(c.workspaceId, workspaceId), isNull(c.revokedAt)))
        .returning({ id: c.id });
      if (updated.length === 0) return false;
      // The secret is useless once revoked, so it is destroyed rather than kept.
      await tx.delete(cr).where(eq(cr.connectionId, id));
      return true;
    });
  }
}
