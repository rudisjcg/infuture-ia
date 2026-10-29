import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CCEvent } from "@infuture/events";
import { generateMasterKey, loadMasterKey } from "@infuture/vault";
import { buildApp } from "./app";
import { MemoryConnectionStore } from "./connections/store";
import { MemoryRunStore } from "./runs/store";
import { loadEnv } from "./env";

const connectionStore = new MemoryConnectionStore();
const runStore = new MemoryRunStore();
const events: CCEvent[] = [];

const fetch = vi.fn(async (url: string) => {
  if (url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Microservices design proposal created." } }],
      usage: { prompt_tokens: 42, completion_tokens: 21 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof globalThis.fetch;

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildApp(
    env,
    {},
    {
      store: connectionStore,
      runStore,
      masterKey: loadMasterKey(generateMasterKey()),
      fetch,
      emit: (e) => events.push(e),
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("runs and workers", () => {
  it("rejects running a goal when no connection exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs?lang=es",
      payload: { goal: "Haz una investigación" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("no_connection");
  });

  it("executes a run with worker events and tracks usage", async () => {
    // 1. Setup a connection
    await app.inject({
      method: "POST",
      url: "/api/v1/connections",
      payload: {
        providerId: "openai",
        alias: "Work OpenAI",
        secret: "sk-test-secret-value-12345",
      },
    });

    // 2. Post a run
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs?lang=en",
      payload: {
        goal: "Plan cloud architecture",
        role: "developer",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      goal: "Plan cloud architecture",
      status: "done",
      output: "Microservices design proposal created.",
      tokensIn: 42,
      tokensOut: 21,
    });
    expect(body.costUsd).toBeGreaterThan(0);
    expect(body.eventsCount).toBeGreaterThan(5);

    // 3. List runs
    const listRes = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0]?.id).toBe(body.id);

    // 4. Get run details with tasks
    const detailRes = await app.inject({ method: "GET", url: `/api/v1/runs/${body.id}` });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().tasks).toHaveLength(1);
    expect(detailRes.json().tasks[0].status).toBe("done");

    // 5. Get run events stream
    const eventsRes = await app.inject({ method: "GET", url: `/api/v1/runs/${body.id}/events` });
    expect(eventsRes.statusCode).toBe(200);
    const runEvents = eventsRes.json() as CCEvent[];
    expect(runEvents.map((e) => e.type)).toContain("run.created");
    expect(runEvents.map((e) => e.type)).toContain("agent.thought");
    expect(runEvents.map((e) => e.type)).toContain("llm.request.started");
    expect(runEvents.map((e) => e.type)).toContain("llm.message.completed");
    expect(runEvents.map((e) => e.type)).toContain("run.completed");

    // Ensure secrets are never in the event payloads
    expect(JSON.stringify(runEvents)).not.toContain("sk-test-secret-value-12345");
  });

  it("executes a multi-agent run with decomposition, board posts and review", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: {
        goal: "Build distributed payment system",
        multiagent: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("done");
    expect(body.tasks).toHaveLength(3);
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].verdict).toBe("approve");
    expect(body.boardPosts).toHaveLength(3);

    const eventsRes = await app.inject({ method: "GET", url: `/api/v1/runs/${body.id}/events` });
    const runEvents = eventsRes.json() as CCEvent[];
    expect(runEvents.map((e) => e.type)).toContain("board.posted");
    expect(runEvents.map((e) => e.type)).toContain("review.requested");
    expect(runEvents.map((e) => e.type)).toContain("review.completed");
  });

  it("returns 404 for unknown run", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/00000000-0000-4000-8000-000000000099",
    });
    expect(res.statusCode).toBe(404);
  });

  it("manages human approvals lifecycle via API", async () => {
    // 1. Create approval
    const approval = await runStore.createApproval({
      id: "00000000-0000-4000-8000-000000000088",
      runId: "00000000-0000-4000-8000-000000000001",
      action: "file_write",
      detail: { filename: "schema.sql" },
    });
    expect(approval.status).toBe("pending");

    // 2. List approvals
    const listRes = await app.inject({ method: "GET", url: "/api/v1/approvals" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().some((a: { id: string }) => a.id === approval.id)).toBe(true);

    // 3. Resolve approval
    const resolveRes = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval.id}/resolve`,
      payload: { decision: "approved", note: "Verified by lead dev" },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe("approved");
    expect(resolveRes.json().note).toBe("Verified by lead dev");
  });

  it("GET /api/v1/analytics calculates aggregated metrics", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/analytics" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRuns).toBeGreaterThanOrEqual(1);
    expect(typeof body.totalTokens).toBe("number");
    expect(typeof body.totalCostUsd).toBe("number");
    expect(typeof body.successRatePercent).toBe("number");
    expect(body.byStatus).toBeDefined();
  });

  it("POST /api/v1/runs/:id/cancel cancels active run", async () => {
    // Create an in-flight run in store
    const testRun = await runStore.createRun({
      id: "00000000-0000-4000-8000-000000000077",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Long running simulation",
      locale: "en",
    });
    await runStore.updateRun(testRun.id, { status: "running" });

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${testRun.id}/cancel`,
    });
    expect(cancelRes.statusCode).toBe(200);
    const body = cancelRes.json();
    expect(body.status).toBe("cancelled");
    expect(body.endedAt).not.toBeNull();

    // Calling cancel again returns 400
    const retryRes = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${testRun.id}/cancel`,
    });
    expect(retryRes.statusCode).toBe(400);
    expect(retryRes.json().error.code).toBe("run_already_terminal");
  });

  it("posts and retrieves whiteboard notes via /api/v1/board", async () => {
    // 1. Post a new whiteboard finding
    const postRes = await app.inject({
      method: "POST",
      url: "/api/v1/board",
      payload: {
        topic: "Architecture Decision",
        kind: "decision",
        content: "Adopt Event Sourcing for audit logging across workers.",
      },
    });
    expect(postRes.statusCode).toBe(201);
    const postBody = postRes.json();
    expect(postBody.id).toBeDefined();
    expect(postBody.topic).toBe("Architecture Decision");
    expect(postBody.kind).toBe("decision");
    expect(postBody.content).toContain("Adopt Event Sourcing");

    // 2. Validate rejection of invalid kind
    const badRes = await app.inject({
      method: "POST",
      url: "/api/v1/board",
      payload: {
        topic: "Bad Note",
        kind: "invalid_kind_123",
        content: "Some content",
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.code).toBe("validation_error");

    // 3. Retrieve board posts
    const listRes = await app.inject({ method: "GET", url: "/api/v1/board" });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((p: { id: string }) => p.id === postBody.id)).toBe(true);
  });

  it("registers, lists and retrieves artifacts via /api/v1/artifacts", async () => {
    const artifactId = "00000000-0000-4000-8000-000000000099";
    const runId = "00000000-0000-4000-8000-000000000095";
    await runStore.createRun({
      id: runId,
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Architecture design",
      locale: "en",
    });

    await runStore.saveEvent({
      id: "00000000-0000-4000-8000-000000000098",
      seq: 50,
      ts: new Date().toISOString(),
      workspaceId: "00000000-0000-4000-8000-000000000001",
      runId,
      type: "artifact.created",
      payload: {
        artifactId,
        kind: "markdown",
        name: "architecture-summary.md",
        uri: "workspace://00000000-0000-4000-8000-000000000001/architecture-summary.md",
        bytes: 142,
        content: "# Architecture Summary\nMicroservices pattern verified with Zero-Trust authorization.",
      },
    });

    // 1. List workspace artifacts
    const listRes = await app.inject({ method: "GET", url: "/api/v1/artifacts" });
    expect(listRes.statusCode).toBe(200);
    const artifacts = listRes.json();
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts.some((a: { id: string }) => a.id === artifactId)).toBe(true);

    // 2. Retrieve single artifact by ID
    const singleRes = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifactId}` });
    expect(singleRes.statusCode).toBe(200);
    const single = singleRes.json();
    expect(single.name).toBe("architecture-summary.md");
    expect(single.content).toContain("Microservices pattern verified");

    // 3. List artifacts for specific run
    const runArtifactsRes = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/artifacts`,
    });
    expect(runArtifactsRes.statusCode).toBe(200);
    const runArtifacts = runArtifactsRes.json();
    expect(runArtifacts.some((a: { id: string }) => a.id === artifactId)).toBe(true);
  });

  it("exports run dossier in markdown, html and json formats", async () => {
    // 1. Get existing run ID from previous tests
    const listRes = await app.inject({ method: "GET", url: "/api/v1/runs" });
    const runId = listRes.json()[0].id;

    // 2. Export Markdown
    const mdRes = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/export?format=markdown`,
    });
    expect(mdRes.statusCode).toBe(200);
    expect(mdRes.headers["content-type"]).toContain("text/markdown");
    expect(mdRes.headers["content-disposition"]).toContain("attachment");
    expect(mdRes.body).toContain("# 🚀 infuture IA · Run Executive Dossier");
    expect(mdRes.body).toContain("## 🎯 Objective / Goal");

    // 3. Export HTML
    const htmlRes = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/export?format=html`,
    });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers["content-type"]).toContain("text/html");
    expect(htmlRes.body).toContain("<!DOCTYPE html>");
    expect(htmlRes.body).toContain("Performance & Cost Summary");

    // 4. Export JSON
    const jsonRes = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/export?format=json`,
    });
    expect(jsonRes.statusCode).toBe(200);
    expect(jsonRes.headers["content-type"]).toContain("application/json");
    const json = jsonRes.json();
    expect(json.run.id).toBe(runId);
    expect(Array.isArray(json.tasks)).toBe(true);
  });

  it("steers an existing run with interactive human feedback", async () => {
    const listRes = await app.inject({ method: "GET", url: "/api/v1/runs" });
    const run = listRes.json().find((r: { goal: string }) => r.goal.includes("cloud architecture"))!;
    const runId = run.id;

    const steerRes = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/feedback`,
      payload: {
        prompt: "Add unit test suite and OpenAPI specification",
        role: "developer",
      },
    });

    expect(steerRes.statusCode).toBe(200);
    const body = steerRes.json();
    expect(body.id).toBe(runId);
    expect(body.status).toBe("done");
    expect(body.output).toContain("Operator Steer");
    expect(body.tasks.length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === "run.steered")).toBe(true);
  });
});
