import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CCEvent } from "@infuture/events";
import { buildTestApp as buildApp } from "./test-auth";
import { MemoryKnowledgeStore } from "./memory/store";
import { loadEnv } from "./env";

let app: FastifyInstance;
const knowledgeStore = new MemoryKnowledgeStore();
const emittedEvents: CCEvent[] = [];

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildApp(
    env,
    {},
    {
      knowledgeStore,
      emit: (e) => emittedEvents.push(e),
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Agent Memory & RAG Knowledge API", () => {
  it("GET /api/v1/memory lists seeded memories", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(3);

    const contents = body.map((m: { content: string }) => m.content);
    expect(contents.some((c: string) => c.includes("Envelope encryption"))).toBe(true);
  });

  it("POST /api/v1/memory stores a new memory and emits memory.stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory",
      payload: {
        content: "When analyzing data anomalies, check standard deviation thresholds first.",
        role: "analyst",
        tags: ["statistics", "data", "quality"],
        importance: 4,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^mem-/);
    expect(body.role).toBe("analyst");
    expect(body.importance).toBe(4);

    const memoryEvent = emittedEvents.find((e) => e.type === "memory.stored");
    expect(memoryEvent).toBeDefined();

    // Query with filter
    const queryRes = await app.inject({
      method: "GET",
      url: "/api/v1/memory?q=standard+deviation",
    });
    expect(queryRes.statusCode).toBe(200);
    const queryList = queryRes.json();
    expect(queryList.some((m: { id: string }) => m.id === body.id)).toBe(true);

    // Delete memory
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${body.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);
  });

  it("GET /api/v1/knowledge lists seeded documents", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/knowledge",
    });

    expect(res.statusCode).toBe(200);
    const docs = res.json();
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThanOrEqual(2);

    const titles = docs.map((d: { title: string }) => d.title);
    expect(titles.some((t: string) => t.includes("Zero Trust"))).toBe(true);
  });

  it("POST /api/v1/knowledge ingests and queries documents with semantic RAG retrieval", async () => {
    const ingestRes = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge",
      payload: {
        title: "Database Indexing & Query Tuning Guidelines",
        category: "engineering",
        content: `
# Database Indexing Guide
Always create composite indexes for query patterns that filter on workspace_id and created_at.
B-Tree indexes are optimal for equality and range filters.

# JSONB Query Performance
For large JSONB documents, use GIN indexes on extracted keys to avoid full table scans.
Keep payload schemas compact and avoid deeply nested unbounded arrays.
        `.trim(),
        metadata: { author: "DBA Team", version: "1.0" },
      },
    });

    expect(ingestRes.statusCode).toBe(201);
    const doc = ingestRes.json();
    expect(doc.id).toMatch(/^kb-/);
    expect(doc.chunksCount).toBeGreaterThanOrEqual(1);

    const ingestEvent = emittedEvents.find((e) => e.type === "knowledge.ingested");
    expect(ingestEvent).toBeDefined();

    // GET /api/v1/knowledge/:id
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/knowledge/${doc.id}`,
    });
    expect(detailRes.statusCode).toBe(200);
    const fullDoc = detailRes.json();
    expect(fullDoc.chunks.length).toBe(doc.chunksCount);

    // POST /api/v1/knowledge/query
    const queryRes = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/query",
      payload: {
        query: "GIN indexes on jsonb full table scans",
        limit: 3,
      },
    });

    expect(queryRes.statusCode).toBe(200);
    const queryResult = queryRes.json();
    expect(queryResult.count).toBeGreaterThan(0);
    expect(queryResult.results[0].text).toContain("JSONB Query Performance");
    expect(queryResult.results[0].score).toBeGreaterThan(0.3);

    // Cleanup
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/knowledge/${doc.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);
  });
});
