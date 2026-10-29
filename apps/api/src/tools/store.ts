import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import { createMcpToolDefinition, registerTool, type ToolParameter } from "@infuture/worker";

export type McpTransport = "stdio" | "sse";

export type DiscoveredTool = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  requiresApproval?: boolean;
};

export type McpServerRecord = {
  id: string;
  workspaceId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  discoveredTools: DiscoveredTool[];
  lastSyncedAt: Date | null;
  createdAt: Date;
};

export type CustomToolRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  code: string;
  requiresApproval: boolean;
  createdAt: Date;
};

export interface McpServerStore {
  listServers(workspaceId: string): Promise<McpServerRecord[]>;
  getServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined>;
  createServer(
    server: Omit<McpServerRecord, "id" | "createdAt" | "discoveredTools" | "lastSyncedAt"> & { id?: string },
  ): Promise<McpServerRecord>;
  updateServer(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<McpServerRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<McpServerRecord | undefined>;
  deleteServer(workspaceId: string, id: string): Promise<boolean>;
  syncServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined>;
}

export class MemoryMcpServerStore implements McpServerStore {
  private servers = new Map<string, McpServerRecord>();

  // No servers are seeded: MCP servers must be added explicitly by the user (the client transport is not implemented yet).

  private registerServerTools(server: McpServerRecord) {
    if (!server.enabled) return;
    for (const dt of server.discoveredTools) {
      registerTool(
        createMcpToolDefinition({
          serverName: server.name,
          toolName: dt.name,
          description: dt.description,
          parameters: dt.parameters,
          requiresApproval: dt.requiresApproval,
        }),
      );
    }
  }

  async listServers(workspaceId: string): Promise<McpServerRecord[]> {
    return Array.from(this.servers.values()).filter((s) => s.workspaceId === workspaceId);
  }

  async getServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    const s = this.servers.get(id);
    return s && s.workspaceId === workspaceId ? s : undefined;
  }

  async createServer(
    input: Omit<McpServerRecord, "id" | "createdAt" | "discoveredTools" | "lastSyncedAt"> & { id?: string },
  ): Promise<McpServerRecord> {
    const id = input.id || `mcp-${randomUUID().slice(0, 8)}`;
    const record: McpServerRecord = {
      ...input,
      id,
      discoveredTools: [],
      lastSyncedAt: null,
      createdAt: new Date(),
    };
    this.servers.set(id, record);
    return record;
  }

  async updateServer(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<McpServerRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<McpServerRecord | undefined> {
    const current = await this.getServer(workspaceId, id);
    if (!current) return undefined;
    const updated: McpServerRecord = {
      ...current,
      ...updates,
    };
    this.servers.set(id, updated);
    this.registerServerTools(updated);
    return updated;
  }

  async deleteServer(workspaceId: string, id: string): Promise<boolean> {
    const current = await this.getServer(workspaceId, id);
    if (!current) return false;
    return this.servers.delete(id);
  }

  async syncServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    const current = await this.getServer(workspaceId, id);
    if (!current) return undefined;

    // Simulate standard MCP discovery if not already discovered
    if (current.discoveredTools.length === 0) {
      const toolName = `${current.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_action`;
      current.discoveredTools = [
        {
          name: toolName,
          description: `Action provided by ${current.name}`,
          parameters: {
            input: { type: "string", description: "Action input payload", required: true },
          },
        },
      ];
    }

    current.lastSyncedAt = new Date();
    this.registerServerTools(current);
    return current;
  }
}

/* --------------------------------- PostgreSQL --------------------------------- */

type Db = Database;
type Schema = typeof schema;

export class PgMcpServerStore implements McpServerStore {
  constructor(
    private db: Db,
    private s: Schema,
  ) {}

  async listServers(workspaceId: string): Promise<McpServerRecord[]> {
    const { mcpServers } = this.s;
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspaceId));
    return rows.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      name: s.name,
      transport: s.transport as McpTransport,
      command: s.command ?? undefined,
      args: (s.args as string[]) ?? undefined,
      url: s.url ?? undefined,
      enabled: s.enabled,
      discoveredTools: (s.discoveredTools as DiscoveredTool[]) ?? [],
      lastSyncedAt: s.lastSyncedAt,
      createdAt: s.createdAt,
    }));
  }

  async getServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    const { mcpServers } = this.s;
    const [row] = await this.db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      transport: row.transport as McpTransport,
      command: row.command ?? undefined,
      args: (row.args as string[]) ?? undefined,
      url: row.url ?? undefined,
      enabled: row.enabled,
      discoveredTools: (row.discoveredTools as DiscoveredTool[]) ?? [],
      lastSyncedAt: row.lastSyncedAt,
      createdAt: row.createdAt,
    };
  }

  async createServer(
    input: Omit<McpServerRecord, "id" | "createdAt" | "discoveredTools" | "lastSyncedAt"> & { id?: string },
  ): Promise<McpServerRecord> {
    const { mcpServers } = this.s;
    const id = input.id || `mcp-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    await this.db.insert(mcpServers).values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: input.args,
      url: input.url,
      enabled: input.enabled,
      discoveredTools: [],
      lastSyncedAt: null,
      createdAt: now,
    });
    return {
      ...input,
      id,
      discoveredTools: [],
      lastSyncedAt: null,
      createdAt: now,
    };
  }

  async updateServer(
    workspaceId: string,
    id: string,
    updates: Partial<Omit<McpServerRecord, "id" | "workspaceId" | "createdAt">>,
  ): Promise<McpServerRecord | undefined> {
    const { mcpServers } = this.s;
    const current = await this.getServer(workspaceId, id);
    if (!current) return undefined;

    const values: Record<string, unknown> = {};
    if (updates.name !== undefined) values.name = updates.name;
    if (updates.transport !== undefined) values.transport = updates.transport;
    if (updates.command !== undefined) values.command = updates.command;
    if (updates.args !== undefined) values.args = updates.args;
    if (updates.url !== undefined) values.url = updates.url;
    if (updates.enabled !== undefined) values.enabled = updates.enabled;
    if (updates.discoveredTools !== undefined) values.discoveredTools = updates.discoveredTools;
    if (updates.lastSyncedAt !== undefined) values.lastSyncedAt = updates.lastSyncedAt;

    if (Object.keys(values).length > 0) {
      await this.db
        .update(mcpServers)
        .set(values)
        .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    }

    return this.getServer(workspaceId, id);
  }

  async deleteServer(workspaceId: string, id: string): Promise<boolean> {
    const { mcpServers } = this.s;
    const current = await this.getServer(workspaceId, id);
    if (!current) return false;
    await this.db
      .delete(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    return true;
  }

  async syncServer(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    const current = await this.getServer(workspaceId, id);
    if (!current) return undefined;

    let discovered = current.discoveredTools;
    if (discovered.length === 0) {
      const toolName = `${current.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_action`;
      discovered = [
        {
          name: toolName,
          description: `Action provided by ${current.name}`,
          parameters: {
            input: { type: "string", description: "Action input payload", required: true },
          },
        },
      ];
    }

    await this.updateServer(workspaceId, id, {
      discoveredTools: discovered,
      lastSyncedAt: new Date(),
    });

    for (const dt of discovered) {
      registerTool(
        createMcpToolDefinition({
          serverName: current.name,
          toolName: dt.name,
          description: dt.description,
          parameters: dt.parameters,
          requiresApproval: dt.requiresApproval,
        }),
      );
    }

    return this.getServer(workspaceId, id);
  }
}
