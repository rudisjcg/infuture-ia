import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadEnv } from "./env";
import { MetricsCollector } from "./system/metrics";

describe("MetricsCollector", () => {
  it("reports real api/host metrics and an unknown worker without a DB", async () => {
    const snap = await new MetricsCollector().snapshot();
    expect(snap.services.map((s) => s.kind)).toEqual(["api", "host", "worker"]);
    const api = snap.services[0]!;
    expect(api.cpu).toBeGreaterThanOrEqual(0);
    expect(api.mem).toBeGreaterThan(0);
    expect(api.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(snap.services[2]!.status).toBe("unknown");
  });

  it("measures DB latency and reports down on failure", async () => {
    const ok = await new MetricsCollector({ dbPing: async () => 1 }).snapshot();
    const db = ok.services.find((s) => s.kind === "db")!;
    expect(db.status).toBe("ok");
    expect(db.latencyMs).toBeGreaterThanOrEqual(0);
    const bad = await new MetricsCollector({
      dbPing: async () => {
        throw new Error("boom");
      },
    }).snapshot();
    expect(bad.services.find((s) => s.kind === "db")!.status).toBe("down");
  });

  it("keeps a bounded history ring buffer", async () => {
    const c = new MetricsCollector({ activeRuns: async () => 2 }, 3);
    for (let i = 0; i < 5; i++) await c.snapshot();
    const h = c.getHistory();
    expect(h).toHaveLength(3);
    expect(h[2]!.activeRuns).toBe(2);
  });
});

describe("GET /api/v1/system/metrics", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(loadEnv({ NODE_ENV: "test" }), {}, { masterKey: null });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns services and records history", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/system/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { services: { kind: string; detail?: string }[] };
    expect(body.services.map((s) => s.kind)).toContain("api");
    expect(body.services.find((s) => s.kind === "worker")?.detail).toContain("0 active");
    const hist = await app.inject({ method: "GET", url: "/api/v1/system/metrics/history" });
    expect((hist.json() as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(1);
  });
});
