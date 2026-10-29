import { and, desc, eq } from "drizzle-orm";
import { uuidv7 } from "@infuture/events";
import type { Database, schema } from "@infuture/db";
import {
  chunkText,
  getWorkspaceKnowledgeMap,
  getWorkspaceMemoriesMap,
  searchKnowledgeDocuments,
  searchWorkspaceMemories,
  type KnowledgeChunk,
  type KnowledgeDocument,
  type MemoryItem,
  type ScoredKnowledgeResult,
} from "@infuture/worker";

export interface KnowledgeStore {
  listMemories(
    workspaceId: string,
    filter?: { role?: string; tag?: string; query?: string; limit?: number },
  ): Promise<MemoryItem[]>;
  createMemory(
    workspaceId: string,
    item: Omit<MemoryItem, "id" | "workspaceId" | "createdAt">,
  ): Promise<MemoryItem>;
  deleteMemory(workspaceId: string, id: string): Promise<boolean>;

  listDocuments(workspaceId: string, category?: string): Promise<KnowledgeDocument[]>;
  getDocument(workspaceId: string, id: string): Promise<KnowledgeDocument | undefined>;
  ingestDocument(
    workspaceId: string,
    input: {
      title: string;
      category?: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<KnowledgeDocument>;
  deleteDocument(workspaceId: string, id: string): Promise<boolean>;
  searchKnowledge(
    workspaceId: string,
    query: string,
    options?: { category?: string; limit?: number },
  ): Promise<ScoredKnowledgeResult[]>;
}

/* --------------------------------- In-Memory --------------------------------- */

export class MemoryKnowledgeStore implements KnowledgeStore {
  async listMemories(
    workspaceId: string,
    filter: { role?: string; tag?: string; query?: string; limit?: number } = {},
  ): Promise<MemoryItem[]> {
    const map = getWorkspaceMemoriesMap(workspaceId);
    let items = Array.from(map.values());

    if (filter.role && filter.role !== "all") {
      items = items.filter((m) => m.role === "all" || m.role === filter.role);
    }
    if (filter.tag) {
      const targetTag = filter.tag.toLowerCase();
      items = items.filter((m) => m.tags.some((t) => t.toLowerCase() === targetTag));
    }
    if (filter.query) {
      items = searchWorkspaceMemories(items, filter.query, {
        role: filter.role,
        limit: filter.limit ?? 50,
      });
    } else {
      items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (filter.limit) items = items.slice(0, filter.limit);
    }

    return items;
  }

  async createMemory(
    workspaceId: string,
    item: Omit<MemoryItem, "id" | "workspaceId" | "createdAt">,
  ): Promise<MemoryItem> {
    const map = getWorkspaceMemoriesMap(workspaceId);
    const id = `mem-${uuidv7().slice(0, 8)}`;
    const record: MemoryItem = {
      ...item,
      id,
      workspaceId,
      createdAt: new Date(),
    };
    map.set(id, record);
    return record;
  }

  async deleteMemory(workspaceId: string, id: string): Promise<boolean> {
    const map = getWorkspaceMemoriesMap(workspaceId);
    return map.delete(id);
  }

  async listDocuments(workspaceId: string, category?: string): Promise<KnowledgeDocument[]> {
    const map = getWorkspaceKnowledgeMap(workspaceId);
    let docs = Array.from(map.values());
    if (category && category !== "all") {
      docs = docs.filter((d) => d.category.toLowerCase() === category.toLowerCase());
    }
    return docs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async getDocument(workspaceId: string, id: string): Promise<KnowledgeDocument | undefined> {
    const map = getWorkspaceKnowledgeMap(workspaceId);
    return map.get(id);
  }

  async ingestDocument(
    workspaceId: string,
    input: {
      title: string;
      category?: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<KnowledgeDocument> {
    const map = getWorkspaceKnowledgeMap(workspaceId);
    const id = `kb-${uuidv7().slice(0, 8)}`;
    const chunks = chunkText(input.content);
    const now = new Date();
    const doc: KnowledgeDocument = {
      id,
      workspaceId,
      title: input.title,
      category: input.category || "general",
      content: input.content,
      chunks,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    map.set(id, doc);
    return doc;
  }

  async deleteDocument(workspaceId: string, id: string): Promise<boolean> {
    const map = getWorkspaceKnowledgeMap(workspaceId);
    return map.delete(id);
  }

  async searchKnowledge(
    workspaceId: string,
    query: string,
    options: { category?: string; limit?: number } = {},
  ): Promise<ScoredKnowledgeResult[]> {
    const map = getWorkspaceKnowledgeMap(workspaceId);
    const docs = Array.from(map.values());
    return searchKnowledgeDocuments(docs, query, options);
  }
}

/* --------------------------------- PostgreSQL --------------------------------- */

type Db = Database;
type Schema = typeof schema;

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(
    private db: Db,
    private s: Schema,
  ) {}

  async listMemories(
    workspaceId: string,
    filter: { role?: string; tag?: string; query?: string; limit?: number } = {},
  ): Promise<MemoryItem[]> {
    const { agentMemories } = this.s;
    const rows = await this.db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.workspaceId, workspaceId))
      .orderBy(desc(agentMemories.createdAt));

    let items: MemoryItem[] = rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      role: r.role,
      content: r.content,
      tags: r.tags ?? [],
      importance: r.importance,
      runId: r.runId ?? undefined,
      createdAt: r.createdAt,
    }));

    if (filter.role && filter.role !== "all") {
      items = items.filter((m) => m.role === "all" || m.role === filter.role);
    }
    if (filter.tag) {
      const targetTag = filter.tag.toLowerCase();
      items = items.filter((m) => m.tags.some((t) => t.toLowerCase() === targetTag));
    }
    if (filter.query) {
      items = searchWorkspaceMemories(items, filter.query, {
        role: filter.role,
        limit: filter.limit ?? 50,
      });
    } else if (filter.limit) {
      items = items.slice(0, filter.limit);
    }

    return items;
  }

  async createMemory(
    workspaceId: string,
    item: Omit<MemoryItem, "id" | "workspaceId" | "createdAt">,
  ): Promise<MemoryItem> {
    const { agentMemories } = this.s;
    const id = `mem-${uuidv7().slice(0, 8)}`;
    const now = new Date();
    await this.db.insert(agentMemories).values({
      id,
      workspaceId,
      role: item.role,
      content: item.content,
      tags: item.tags,
      importance: item.importance,
      runId: item.runId,
      createdAt: now,
    });
    return {
      ...item,
      id,
      workspaceId,
      createdAt: now,
    };
  }

  async deleteMemory(workspaceId: string, id: string): Promise<boolean> {
    const { agentMemories } = this.s;
    await this.db
      .delete(agentMemories)
      .where(and(eq(agentMemories.workspaceId, workspaceId), eq(agentMemories.id, id)));
    return true;
  }

  async listDocuments(workspaceId: string, category?: string): Promise<KnowledgeDocument[]> {
    const { knowledgeDocuments } = this.s;
    const rows = await this.db
      .select()
      .from(knowledgeDocuments)
      .where(
        category && category !== "all"
          ? and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.category, category))
          : eq(knowledgeDocuments.workspaceId, workspaceId),
      )
      .orderBy(desc(knowledgeDocuments.createdAt));

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      title: r.title,
      category: r.category,
      content: r.content,
      chunks: (r.chunks as KnowledgeChunk[]) ?? [],
      metadata: (r.metadata as Record<string, unknown>) ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async getDocument(workspaceId: string, id: string): Promise<KnowledgeDocument | undefined> {
    const { knowledgeDocuments } = this.s;
    const [r] = await this.db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)));
    if (!r) return undefined;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      title: r.title,
      category: r.category,
      content: r.content,
      chunks: (r.chunks as KnowledgeChunk[]) ?? [],
      metadata: (r.metadata as Record<string, unknown>) ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async ingestDocument(
    workspaceId: string,
    input: {
      title: string;
      category?: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<KnowledgeDocument> {
    const { knowledgeDocuments } = this.s;
    const id = `kb-${uuidv7().slice(0, 8)}`;
    const chunks = chunkText(input.content);
    const now = new Date();
    await this.db.insert(knowledgeDocuments).values({
      id,
      workspaceId,
      title: input.title,
      category: input.category || "general",
      content: input.content,
      chunks,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      workspaceId,
      title: input.title,
      category: input.category || "general",
      content: input.content,
      chunks,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteDocument(workspaceId: string, id: string): Promise<boolean> {
    const { knowledgeDocuments } = this.s;
    await this.db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)));
    return true;
  }

  async searchKnowledge(
    workspaceId: string,
    query: string,
    options: { category?: string; limit?: number } = {},
  ): Promise<ScoredKnowledgeResult[]> {
    const docs = await this.listDocuments(workspaceId, options.category);
    return searchKnowledgeDocuments(docs, query, options);
  }
}
