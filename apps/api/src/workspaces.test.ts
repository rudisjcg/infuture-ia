import { describe, expect, it, vi } from "vitest";
import type { CCEvent } from "@infuture/events";
import { buildTestApp as buildApp } from "./test-auth";
import { loadEnv } from "./env";
import { MemoryWorkspaceStore } from "./workspaces/store";

describe("Workspaces, API Tokens & Webhooks", () => {
  it("creates and lists multi-tenant workspaces", async () => {
    const events: CCEvent[] = [];
    const app = await buildApp(
      loadEnv({ NODE_ENV: "test" }),
      {},
      {
        emit: (ev) => events.push(ev),
      },
    );

    const initialRes = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
    });
    expect(initialRes.statusCode).toBe(200);
    const initial = initialRes.json();
    expect(initial.workspaces).toBeDefined();
    expect(initial.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(initial.workspaces[0].name).toBe("Local");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      payload: {
        name: "Acme Corp Research",
        defaultLocale: "es",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe("Acme Corp Research");
    expect(created.defaultLocale).toBe("es");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${created.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().name).toBe("Acme Corp Research");

    expect(events.some((e) => e.type === "workspace.created")).toBe(true);
  });

  it("issues, verifies, and revokes scoped API access tokens", async () => {
    const events: CCEvent[] = [];
    const workspaceStore = new MemoryWorkspaceStore();
    const app = await buildApp(
      loadEnv({ NODE_ENV: "test" }),
      {},
      {
        workspaceStore,
        emit: (ev) => events.push(ev),
      },
    );

    const issueRes = await app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      payload: {
        name: "CI Runner",
        role: "admin",
      },
    });
    expect(issueRes.statusCode).toBe(201);
    const issued = issueRes.json();
    expect(issued.token).toMatch(/^ift_[0-9a-f]{48}$/);
    expect(issued.record.name).toBe("CI Runner");
    expect(issued.record.role).toBe("admin");
    expect(issued.record.tokenPrefix).toMatch(/^ift_/);

    const verified = await workspaceStore.verifyToken(issued.token);
    expect(verified).toBeDefined();
    expect(verified?.id).toBe(issued.record.id);
    expect(verified?.lastUsedAt).toBeDefined();

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.tokens.some((t: { id: string }) => t.id === issued.record.id)).toBe(true);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${issued.record.id}`,
    });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await workspaceStore.verifyToken(issued.token);
    expect(afterRevoke).toBeUndefined();

    expect(events.some((e) => e.type === "token.created")).toBe(true);
    expect(events.some((e) => e.type === "token.revoked")).toBe(true);
  });

  it("manages webhooks and dispatches signed test payload", async () => {
    const events: CCEvent[] = [];
    let receivedHeaders: Record<string, string> = {};
    let receivedBody = "";

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      receivedHeaders = (init?.headers as Record<string, string>) ?? {};
      receivedBody = (init?.body as string) ?? "";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"status":"ok"}',
      };
    });

    const app = await buildApp(
      loadEnv({ NODE_ENV: "test" }),
      {},
      {
        fetch: mockFetch as unknown as typeof fetch,
        emit: (ev) => events.push(ev),
      },
    );

    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: {
        url: "https://agent-ops.internal/webhook",
        events: ["run.completed", "run.failed", "log"],
      },
    });
    expect(regRes.statusCode).toBe(201);
    const webhook = regRes.json();
    expect(webhook.url).toBe("https://agent-ops.internal/webhook");
    expect(webhook.secret).toMatch(/^whsec_/);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks",
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().webhooks.length).toBeGreaterThanOrEqual(1);

    const testRes = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${webhook.id}/test`,
    });
    expect(testRes.statusCode).toBe(200);
    const testResult = testRes.json();
    expect(testResult.success).toBe(true);
    expect(testResult.statusCode).toBe(200);

    expect(receivedHeaders["Content-Type"]).toBe("application/json");
    expect(receivedHeaders["X-Infuture-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(receivedHeaders["X-Infuture-Event"]).toBe("log");
    expect(receivedBody).toContain("Infuture IA Webhook Ping Verification");

    const deliveriesRes = await app.inject({
      method: "GET",
      url: `/api/v1/webhooks/${webhook.id}/deliveries`,
    });
    expect(deliveriesRes.statusCode).toBe(200);
    const deliveries = deliveriesRes.json().deliveries;
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].success).toBe(true);
    expect(deliveries[0].statusCode).toBe(200);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/webhooks/${webhook.id}`,
    });
    expect(delRes.statusCode).toBe(200);

    expect(events.some((e) => e.type === "webhook.dispatched")).toBe(true);
  });
});
