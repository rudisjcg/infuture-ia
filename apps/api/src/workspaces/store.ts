import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import { LOCAL_WORKSPACE_ID } from "../connections/store";

export type WorkspaceRecord = {
  id: string;
  name: string;
  defaultLocale: string;
  createdAt: Date;
};

export type TokenRole = "admin" | "operator" | "viewer";

export type ApiTokenRecord = {
  id: string;
  workspaceId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  role: TokenRole;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type CreatedApiToken = {
  token: string;
  record: ApiTokenRecord;
};

export type WebhookRecord = {
  id: string;
  workspaceId: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: Date;
};

export type WebhookDeliveryRecord = {
  id: string;
  webhookId: string;
  workspaceId: string;
  eventType: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  error: string | null;
  payload: unknown;
  createdAt: Date;
};

export type WebhookDispatchResult = {
  success: boolean;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
};

export function generateToken(): { rawToken: string; prefix: string; hash: string } {
  const secret = randomBytes(24).toString("hex");
  const rawToken = `ift_${secret}`;
  const prefix = `ift_${secret.slice(0, 6)}...`;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, prefix, hash };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export interface WorkspaceStore {
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  getWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
  createWorkspace(data: { id?: string; name: string; defaultLocale?: string }): Promise<WorkspaceRecord>;
  listTokens(workspaceId: string): Promise<ApiTokenRecord[]>;
  createToken(
    workspaceId: string,
    data: { name: string; role?: TokenRole; expiresAt?: Date | null },
  ): Promise<CreatedApiToken>;
  revokeToken(workspaceId: string, id: string): Promise<boolean>;
  verifyToken(rawToken: string): Promise<ApiTokenRecord | undefined>;
  listWebhooks(workspaceId: string): Promise<WebhookRecord[]>;
  getWebhook(workspaceId: string, id: string): Promise<WebhookRecord | undefined>;
  createWebhook(
    workspaceId: string,
    data: { url: string; secret?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookRecord>;
  deleteWebhook(workspaceId: string, id: string): Promise<boolean>;
  recordDelivery(delivery: Omit<WebhookDeliveryRecord, "id" | "createdAt">): Promise<WebhookDeliveryRecord>;
  listDeliveries(workspaceId: string, webhookId?: string, limit?: number): Promise<WebhookDeliveryRecord[]>;
  dispatch(
    webhook: WebhookRecord,
    event: { type: string; payload: unknown; [key: string]: unknown },
    fetchFn?: typeof fetch,
  ): Promise<WebhookDispatchResult>;
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private workspaces = new Map<string, WorkspaceRecord>();
  private tokens = new Map<string, ApiTokenRecord>();
  private webhooks = new Map<string, WebhookRecord>();
  private deliveries: WebhookDeliveryRecord[] = [];

  constructor() {
    this.workspaces.set(LOCAL_WORKSPACE_ID, {
      id: LOCAL_WORKSPACE_ID,
      name: "Local",
      defaultLocale: "en",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return Array.from(this.workspaces.values());
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    return this.workspaces.get(id);
  }

  async createWorkspace(data: {
    id?: string;
    name: string;
    defaultLocale?: string;
  }): Promise<WorkspaceRecord> {
    const id = data.id ?? randomUUID();
    const record: WorkspaceRecord = {
      id,
      name: data.name.trim(),
      defaultLocale: data.defaultLocale ?? "en",
      createdAt: new Date(),
    };
    this.workspaces.set(id, record);
    return record;
  }

  async listTokens(workspaceId: string): Promise<ApiTokenRecord[]> {
    return Array.from(this.tokens.values()).filter((t) => t.workspaceId === workspaceId && !t.revokedAt);
  }

  async createToken(
    workspaceId: string,
    data: { name: string; role?: TokenRole; expiresAt?: Date | null },
  ): Promise<CreatedApiToken> {
    const id = randomUUID();
    const { rawToken, prefix, hash } = generateToken();
    const record: ApiTokenRecord = {
      id,
      workspaceId,
      name: data.name.trim(),
      tokenPrefix: prefix,
      tokenHash: hash,
      role: data.role ?? "operator",
      lastUsedAt: null,
      expiresAt: data.expiresAt ?? null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.tokens.set(id, record);
    return { token: rawToken, record };
  }

  async revokeToken(workspaceId: string, id: string): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token || token.workspaceId !== workspaceId) return false;
    token.revokedAt = new Date();
    return true;
  }

  async verifyToken(rawToken: string): Promise<ApiTokenRecord | undefined> {
    const hash = hashToken(rawToken);
    for (const token of this.tokens.values()) {
      if (token.tokenHash === hash && !token.revokedAt) {
        if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
          return undefined;
        }
        token.lastUsedAt = new Date();
        return token;
      }
    }
    return undefined;
  }

  async listWebhooks(workspaceId: string): Promise<WebhookRecord[]> {
    return Array.from(this.webhooks.values()).filter((w) => w.workspaceId === workspaceId);
  }

  async getWebhook(workspaceId: string, id: string): Promise<WebhookRecord | undefined> {
    const w = this.webhooks.get(id);
    return w && w.workspaceId === workspaceId ? w : undefined;
  }

  async createWebhook(
    workspaceId: string,
    data: { url: string; secret?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookRecord> {
    const id = randomUUID();
    const record: WebhookRecord = {
      id,
      workspaceId,
      url: data.url.trim(),
      secret: data.secret?.trim() || generateWebhookSecret(),
      events: data.events && data.events.length > 0 ? data.events : ["*"],
      enabled: data.enabled ?? true,
      createdAt: new Date(),
    };
    this.webhooks.set(id, record);
    return record;
  }

  async deleteWebhook(workspaceId: string, id: string): Promise<boolean> {
    const w = this.webhooks.get(id);
    if (!w || w.workspaceId !== workspaceId) return false;
    return this.webhooks.delete(id);
  }

  async recordDelivery(
    delivery: Omit<WebhookDeliveryRecord, "id" | "createdAt">,
  ): Promise<WebhookDeliveryRecord> {
    const record: WebhookDeliveryRecord = {
      ...delivery,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.deliveries.unshift(record);
    if (this.deliveries.length > 200) this.deliveries.pop();
    return record;
  }

  async listDeliveries(
    workspaceId: string,
    webhookId?: string,
    limit = 50,
  ): Promise<WebhookDeliveryRecord[]> {
    return this.deliveries
      .filter((d) => d.workspaceId === workspaceId && (!webhookId || d.webhookId === webhookId))
      .slice(0, limit);
  }

  async dispatch(
    webhook: WebhookRecord,
    event: { type: string; payload: unknown; [key: string]: unknown },
    fetchFn: typeof fetch = globalThis.fetch,
  ): Promise<WebhookDispatchResult> {
    const started = Date.now();
    const payloadStr = JSON.stringify(event);
    const signature = signPayload(webhook.secret, payloadStr);
    const deliveryId = randomUUID();

    try {
      const response = await fetchFn(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Signature": `sha256=${signature}`,
          "X-Infuture-Event": event.type,
          "X-Infuture-Delivery": deliveryId,
          "User-Agent": "Infuture-Webhook-Dispatcher/1.0",
        },
        body: payloadStr,
        signal: AbortSignal.timeout(10000),
      });

      const durationMs = Date.now() - started;
      const success = response.ok;
      const statusCode = response.status;
      const error = success ? null : `HTTP ${statusCode}: ${response.statusText}`;

      await this.recordDelivery({
        webhookId: webhook.id,
        workspaceId: webhook.workspaceId,
        eventType: event.type,
        statusCode,
        success,
        durationMs,
        error,
        payload: event,
      });

      return { success, statusCode, durationMs, error };
    } catch (err: unknown) {
      const durationMs = Date.now() - started;
      const error = err instanceof Error ? err.message : String(err);

      await this.recordDelivery({
        webhookId: webhook.id,
        workspaceId: webhook.workspaceId,
        eventType: event.type,
        statusCode: null,
        success: false,
        durationMs,
        error,
        payload: event,
      });

      return { success: false, statusCode: null, durationMs, error };
    }
  }
}

export class PgWorkspaceStore implements WorkspaceStore {
  constructor(
    private db: Database,
    private s: typeof schema,
  ) {}

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const { workspaces } = this.s;
    const rows = await this.db.select().from(workspaces);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      defaultLocale: r.defaultLocale,
      createdAt: r.createdAt,
    }));
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    const { workspaces } = this.s;
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      defaultLocale: row.defaultLocale,
      createdAt: row.createdAt,
    };
  }

  async createWorkspace(data: {
    id?: string;
    name: string;
    defaultLocale?: string;
  }): Promise<WorkspaceRecord> {
    const { workspaces } = this.s;
    const id = data.id ?? randomUUID();
    const [row] = await this.db
      .insert(workspaces)
      .values({
        id,
        name: data.name.trim(),
        defaultLocale: data.defaultLocale ?? "en",
      })
      .returning();

    if (!row) throw new Error("Failed to insert workspace");

    return {
      id: row.id,
      name: row.name,
      defaultLocale: row.defaultLocale,
      createdAt: row.createdAt,
    };
  }

  async listTokens(workspaceId: string): Promise<ApiTokenRecord[]> {
    const { apiTokens } = this.s;
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      tokenPrefix: r.tokenPrefix,
      tokenHash: r.tokenHash,
      role: r.role as TokenRole,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      createdAt: r.createdAt,
    }));
  }

  async createToken(
    workspaceId: string,
    data: { name: string; role?: TokenRole; expiresAt?: Date | null },
  ): Promise<CreatedApiToken> {
    const { apiTokens } = this.s;
    const id = randomUUID();
    const { rawToken, prefix, hash } = generateToken();
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        id,
        workspaceId,
        name: data.name.trim(),
        tokenPrefix: prefix,
        tokenHash: hash,
        role: data.role ?? "operator",
        expiresAt: data.expiresAt ?? null,
      })
      .returning();

    if (!row) throw new Error("Failed to insert api token");

    return {
      token: rawToken,
      record: {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        tokenPrefix: row.tokenPrefix,
        tokenHash: row.tokenHash,
        role: row.role as TokenRole,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
      },
    };
  }

  async revokeToken(workspaceId: string, id: string): Promise<boolean> {
    const { apiTokens } = this.s;
    const tokens = await this.listTokens(workspaceId);
    const target = tokens.find((t) => t.id === id);
    if (!target) return false;
    await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.workspaceId, workspaceId), eq(apiTokens.id, id)));
    return true;
  }

  async verifyToken(rawToken: string): Promise<ApiTokenRecord | undefined> {
    const { apiTokens } = this.s;
    const hash = hashToken(rawToken);
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)));

    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined;

    await this.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      tokenHash: row.tokenHash,
      role: row.role as TokenRole,
      lastUsedAt: new Date(),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  async listWebhooks(workspaceId: string): Promise<WebhookRecord[]> {
    const { webhooks } = this.s;
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.workspaceId, workspaceId))
      .orderBy(desc(webhooks.createdAt));

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      url: r.url,
      secret: r.secret,
      events: r.events,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }));
  }

  async getWebhook(workspaceId: string, id: string): Promise<WebhookRecord | undefined> {
    const { webhooks } = this.s;
    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)));

    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      url: row.url,
      secret: row.secret,
      events: row.events,
      enabled: row.enabled,
      createdAt: row.createdAt,
    };
  }

  async createWebhook(
    workspaceId: string,
    data: { url: string; secret?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookRecord> {
    const { webhooks } = this.s;
    const id = randomUUID();
    const [row] = await this.db
      .insert(webhooks)
      .values({
        id,
        workspaceId,
        url: data.url.trim(),
        secret: data.secret?.trim() || generateWebhookSecret(),
        events: data.events && data.events.length > 0 ? data.events : ["*"],
        enabled: data.enabled ?? true,
      })
      .returning();

    if (!row) throw new Error("Failed to insert webhook");

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      url: row.url,
      secret: row.secret,
      events: row.events,
      enabled: row.enabled,
      createdAt: row.createdAt,
    };
  }

  async deleteWebhook(workspaceId: string, id: string): Promise<boolean> {
    const { webhooks } = this.s;
    const current = await this.getWebhook(workspaceId, id);
    if (!current) return false;
    await this.db.delete(webhooks).where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)));
    return true;
  }

  async recordDelivery(
    delivery: Omit<WebhookDeliveryRecord, "id" | "createdAt">,
  ): Promise<WebhookDeliveryRecord> {
    const { webhookDeliveries } = this.s;
    const id = randomUUID();
    const [row] = await this.db
      .insert(webhookDeliveries)
      .values({
        id,
        webhookId: delivery.webhookId,
        workspaceId: delivery.workspaceId,
        eventType: delivery.eventType,
        statusCode: delivery.statusCode,
        success: delivery.success,
        durationMs: delivery.durationMs,
        error: delivery.error,
        payload: delivery.payload,
      })
      .returning();

    if (!row) throw new Error("Failed to insert webhook delivery");

    return {
      id: row.id,
      webhookId: row.webhookId,
      workspaceId: row.workspaceId,
      eventType: row.eventType,
      statusCode: row.statusCode,
      success: row.success,
      durationMs: row.durationMs,
      error: row.error,
      payload: row.payload,
      createdAt: row.createdAt,
    };
  }

  async listDeliveries(
    workspaceId: string,
    webhookId?: string,
    limit = 50,
  ): Promise<WebhookDeliveryRecord[]> {
    const { webhookDeliveries } = this.s;
    const query = webhookId
      ? and(eq(webhookDeliveries.workspaceId, workspaceId), eq(webhookDeliveries.webhookId, webhookId))
      : eq(webhookDeliveries.workspaceId, workspaceId);

    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(query)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      workspaceId: r.workspaceId,
      eventType: r.eventType,
      statusCode: r.statusCode,
      success: r.success,
      durationMs: r.durationMs,
      error: r.error,
      payload: r.payload,
      createdAt: r.createdAt,
    }));
  }

  async dispatch(
    webhook: WebhookRecord,
    event: { type: string; payload: unknown; [key: string]: unknown },
    fetchFn: typeof fetch = globalThis.fetch,
  ): Promise<WebhookDispatchResult> {
    const started = Date.now();
    const payloadStr = JSON.stringify(event);
    const signature = signPayload(webhook.secret, payloadStr);
    const deliveryId = randomUUID();

    try {
      const response = await fetchFn(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Signature": `sha256=${signature}`,
          "X-Infuture-Event": event.type,
          "X-Infuture-Delivery": deliveryId,
          "User-Agent": "Infuture-Webhook-Dispatcher/1.0",
        },
        body: payloadStr,
        signal: AbortSignal.timeout(10000),
      });

      const durationMs = Date.now() - started;
      const success = response.ok;
      const statusCode = response.status;
      const error = success ? null : `HTTP ${statusCode}: ${response.statusText}`;

      await this.recordDelivery({
        webhookId: webhook.id,
        workspaceId: webhook.workspaceId,
        eventType: event.type,
        statusCode,
        success,
        durationMs,
        error,
        payload: event,
      });

      return { success, statusCode, durationMs, error };
    } catch (err: unknown) {
      const durationMs = Date.now() - started;
      const error = err instanceof Error ? err.message : String(err);

      await this.recordDelivery({
        webhookId: webhook.id,
        workspaceId: webhook.workspaceId,
        eventType: event.type,
        statusCode: null,
        success: false,
        durationMs,
        error,
        payload: event,
      });

      return { success: false, statusCode: null, durationMs, error };
    }
  }
}
