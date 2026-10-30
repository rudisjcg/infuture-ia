import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateMasterKey, loadMasterKey } from "@infuture/vault";
import { buildTestApp as buildApp } from "./test-auth";
import { MemoryConnectionStore } from "./connections/store";
import { MemoryRunStore } from "./runs/store";
import { MemoryOfficeStore } from "./offices/store";
import { loadEnv } from "./env";
import { WorkerStatusTracker } from "./system/workerStatus";
import { MetricsCollector } from "./system/metrics";

const fetch = vi.fn(async (url: string) => {
  if (url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof globalThis.fetch;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(
    loadEnv({ NODE_ENV: "test" }),
    {},
    {
      store: new MemoryConnectionStore(),
      runStore: new MemoryRunStore(),
      officeStore: new MemoryOfficeStore(),
      masterKey: loadMasterKey(generateMasterKey()),
      fetch,
    },
  );
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/v1/connections",
    payload: { providerId: "openai", alias: "A", secret: "sk-test-secret-value-12345" },
  });
});

afterAll(async () => {
  await app.close();
});

describe("run attribution", () => {
  it("stores office/zone/character on create and returns them in the list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { goal: "Fix bug", officeId: "office-hq", zone: "dev", characterId: "3" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ officeId: "office-hq", zone: "dev", characterId: "3" });
    const plain = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { goal: "Plain" } });
    expect(plain.json()).toMatchObject({ officeId: null, zone: null, characterId: null });
    const list = (await app.inject({ method: "GET", url: "/api/v1/runs" })).json() as Array<{
      goal: string;
      zone: string | null;
      characterId: string | null;
    }>;
    expect(list.find((r) => r.goal === "Fix bug")).toMatchObject({ zone: "dev", characterId: "3" });
    expect(list.find((r) => r.goal === "Plain")?.zone).toBeNull();
  });

  it("rejects an unknown zone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { goal: "x", zone: "roof" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports the real worker status after runs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/system/metrics" });
    const worker = (
      res.json() as {
        services: Array<{
          kind: string;
          status: string;
          worker?: { state: string; completed: number; lastActivityAt: string | null };
        }>;
      }
    ).services.find((s) => s.kind === "worker")!;
    expect(worker.status).toBe("ok");
    expect(worker.worker?.state).toBe("idle");
    expect(worker.worker?.completed).toBeGreaterThanOrEqual(2);
    expect(worker.worker?.lastActivityAt).not.toBeNull();
  });
});

describe("office zone capacity", () => {
  it("creates, updates and validates zoneCapacity", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/offices",
      payload: { name: "Cap", zones: ["dev", "coffee"], zoneCapacity: { dev: 9 } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().zoneCapacity).toEqual({ dev: 9 });
    const id = created.json().id as string;
    const upd = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${id}`,
      payload: { zoneCapacity: { dev: 4, coffee: 2 } },
    });
    expect(upd.json().zoneCapacity).toEqual({ dev: 4, coffee: 2 });
    const bad = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${id}`,
      payload: { zoneCapacity: { dev: 0 } },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${id}`,
      payload: { zoneCapacity: { roof: 3 } },
    });
    expect(unknown.statusCode).toBe(400);
    const def = (await app.inject({ method: "GET", url: "/api/v1/offices/office-hq" })).json();
    expect(def.zoneCapacity).toEqual({});
  });

  it("ships migration 0002 registered in the journal", async () => {
    const { readFile } = await import("node:fs/promises");
    const base = new URL("../../../packages/db/drizzle/", import.meta.url);
    const sql = await readFile(new URL("0002_run_attribution_zone_capacity.sql", base), "utf8");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "character_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "zone_capacity" jsonb');
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", base), "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain(
      "0002_run_attribution_zone_capacity",
    );
  });
});

describe("WorkerStatusTracker", () => {
  it("goes busy while executing, then idle, and flags errors", async () => {
    let t = 1000;
    const tracker = new WorkerStatusTracker(() => t, 10_000);
    expect(tracker.snapshot()).toMatchObject({ state: "idle", active: 0, lastActivityAt: null });
    let release!: () => void;
    const p = tracker.track(
      () => new Promise<{ status: string }>((r) => (release = () => r({ status: "done" }))),
    );
    expect(tracker.snapshot()).toMatchObject({ state: "busy", active: 1 });
    release();
    await p;
    expect(tracker.snapshot()).toMatchObject({ state: "idle", completed: 1 });
    await expect(tracker.track(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(tracker.snapshot()).toMatchObject({ state: "error", failed: 1, lastError: { message: "boom" } });
    t += 20_000;
    expect(tracker.snapshot().state).toBe("idle");
  });

  it("feeds the worker service in metrics", async () => {
    const tracker = new WorkerStatusTracker();
    const snap = await new MetricsCollector({ worker: () => tracker.snapshot() }).snapshot();
    const w = snap.services.find((s) => s.kind === "worker")!;
    expect(w.status).toBe("ok");
    expect(w.detail).toContain("idle");
  });
});
