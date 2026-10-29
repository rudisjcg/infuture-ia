import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CCEvent } from "@infuture/events";
import type { TranslationKey } from "@infuture/i18n";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import type { KnowledgeStore } from "../memory/store";

export type MemoryRoutesOptions = {
  knowledgeStore: KnowledgeStore;
  emit?: (event: CCEvent) => void;
};

const createMemorySchema = z.object({
  content: z.string().trim().min(3).max(5000),
  role: z.string().trim().default("all"),
  tags: z.array(z.string().trim()).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  runId: z.string().uuid().optional(),
});

const ingestDocumentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  category: z.string().trim().default("general"),
  content: z.string().trim().min(10).max(100000),
  metadata: z.record(z.unknown()).optional(),
});

const queryKnowledgeSchema = z.object({
  query: z.string().trim().min(1).max(500),
  category: z.string().trim().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  key: TranslationKey,
  values = {},
) {
  return reply.code(status).send({ error: { code, message: request.t(key, values) } });
}

export async function memoryRoutes(app: FastifyInstance, opts: MemoryRoutesOptions) {
  const { knowledgeStore, emit } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  /**
   * GET /api/v1/memory
   * List or search agent memories in workspace
   */
  app.get<{
    Querystring: { role?: string; tag?: string; q?: string; limit?: string };
  }>("/api/v1/memory", async (request) => {
    const { role, tag, q, limit } = request.query;
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const memories = await knowledgeStore.listMemories(workspaceId, {
      role,
      tag,
      query: q,
      limit: limitNum,
    });
    return memories.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    }));
  });

  /**
   * POST /api/v1/memory
   * Record a new agent memory / key insight
   */
  app.post("/api/v1/memory", async (request, reply) => {
    const parsed = createMemorySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }

    const { content, role, tags, importance, runId } = parsed.data;
    const created = await knowledgeStore.createMemory(workspaceId, {
      role,
      content,
      tags,
      importance,
      runId,
    });

    emit?.({
      id: `ev-${created.id}`,
      seq: 0,
      runId: runId ?? "workspace",
      workspaceId,
      taskId: "memory",
      workerId: role,
      type: "memory.stored",
      payload: {
        memoryId: created.id,
        role: created.role,
        snippet: created.content.slice(0, 100),
        importance: created.importance,
        tags: created.tags,
      },
      ts: new Date().toISOString(),
    });

    reply.code(201);
    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
    };
  });

  /**
   * DELETE /api/v1/memory/:id
   * Remove a specific agent memory
   */
  app.delete<{ Params: { id: string } }>("/api/v1/memory/:id", async (request, reply) => {
    const { id } = request.params;
    const deleted = await knowledgeStore.deleteMemory(workspaceId, id);
    if (!deleted) {
      return fail(reply, request, 404, "memory_not_found", "errors.notFound", {
        method: "DELETE",
        url: request.url,
      });
    }
    return { ok: true, id };
  });

  /**
   * GET /api/v1/knowledge
   * List ingested workspace documents
   */
  app.get<{
    Querystring: { category?: string };
  }>("/api/v1/knowledge", async (request) => {
    const { category } = request.query;
    const docs = await knowledgeStore.listDocuments(workspaceId, category);
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      chunksCount: d.chunks.length,
      totalTokensEstimate: d.chunks.reduce((acc, c) => acc + c.tokenEstimate, 0),
      preview: d.content.slice(0, 180),
      metadata: d.metadata,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    }));
  });

  /**
   * GET /api/v1/knowledge/:id
   * Get full document with its parsed chunks
   */
  app.get<{ Params: { id: string } }>("/api/v1/knowledge/:id", async (request, reply) => {
    const { id } = request.params;
    const doc = await knowledgeStore.getDocument(workspaceId, id);
    if (!doc) {
      return fail(reply, request, 404, "document_not_found", "errors.notFound", {
        method: "GET",
        url: request.url,
      });
    }
    return {
      ...doc,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/knowledge
   * Ingest a new document into the workspace RAG knowledge base
   */
  app.post("/api/v1/knowledge", async (request, reply) => {
    const parsed = ingestDocumentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }

    const { title, category, content, metadata } = parsed.data;
    const doc = await knowledgeStore.ingestDocument(workspaceId, {
      title,
      category,
      content,
      metadata,
    });

    emit?.({
      id: `ev-${doc.id}`,
      seq: 0,
      runId: "workspace",
      workspaceId,
      taskId: "knowledge",
      workerId: "researcher",
      type: "knowledge.ingested",
      payload: {
        documentId: doc.id,
        title: doc.title,
        category: doc.category,
        chunksCount: doc.chunks.length,
      },
      ts: new Date().toISOString(),
    });

    reply.code(201);
    return {
      ...doc,
      chunksCount: doc.chunks.length,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/knowledge/query
   * Semantic retrieval query across workspace knowledge base
   */
  app.post("/api/v1/knowledge/query", async (request, reply) => {
    const parsed = queryKnowledgeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }

    const { query, category, limit } = parsed.data;
    const results = await knowledgeStore.searchKnowledge(workspaceId, query, {
      category,
      limit,
    });

    return {
      query,
      count: results.length,
      results,
    };
  });

  /**
   * DELETE /api/v1/knowledge/:id
   * Remove a document from the knowledge base
   */
  app.delete<{ Params: { id: string } }>("/api/v1/knowledge/:id", async (request, reply) => {
    const { id } = request.params;
    const deleted = await knowledgeStore.deleteDocument(workspaceId, id);
    if (!deleted) {
      return fail(reply, request, 404, "document_not_found", "errors.notFound", {
        method: "DELETE",
        url: request.url,
      });
    }
    return { ok: true, id };
  });
}
