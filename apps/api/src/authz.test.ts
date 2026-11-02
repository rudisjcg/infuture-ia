import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadEnv } from "./env";
import { MemoryAuthStore, type UserRole } from "./auth/store";
import { LoginRateLimiter } from "./auth/rateLimit";
import { requiredRole } from "./auth/permissions";

const TOKEN = "service-token-0123456789";
const SERVICE = { authorization: `Bearer ${TOKEN}` };
const ZONE = "dev" as const;

async function makeApp(extra: Record<string, string> = {}, authStore = new MemoryAuthStore()) {
  const app = await buildApp(
    loadEnv({ NODE_ENV: "test", API_TOKEN: TOKEN, AUTH_SIGNUP_OPEN: "true", ...extra }),
    {},
    { masterKey: null, authStore },
  );
  return { app, authStore };
}

type App = Awaited<ReturnType<typeof makeApp>>["app"];

/** Signs up `email` (the first one with the service token, so it becomes owner), sets its role and returns a bearer header. */
async function userWithRole(app: App, store: MemoryAuthStore, email: string, role: UserRole | null) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    headers: SERVICE,
    payload: { email, password: "long-enough-password" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; user: { id: string } };
  store.setRole(body.user.id, role);
  return { authorization: `Bearer ${body.token}` };
}

describe("role policy table", () => {
  it("maps routes to minimum roles", () => {
    expect(requiredRole("GET", "/api/v1/offices")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/knowledge/query")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/runs")).toBe("operator");
    expect(requiredRole("PUT", "/api/v1/offices/:id")).toBe("operator");
    expect(requiredRole("DELETE", "/api/v1/offices/:id")).toBe("admin");
    expect(requiredRole("GET", "/api/v1/tokens")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/connections")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/schedules")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/mcp/servers")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/unknown-thing")).toBe("admin");
    expect(requiredRole("GET", "/api/v1/offices", "owner")).toBe("owner");
  });
});

describe("role enforcement", () => {
  it("lets viewers read only, operators run and edit offices, admins administer", async () => {
    const { app, authStore } = await makeApp();
    try {
      const owner = await userWithRole(app, authStore, "owner@example.com", "owner");
      const admin = await userWithRole(app, authStore, "admin@example.com", "admin");
      const operator = await userWithRole(app, authStore, "op@example.com", "operator");
      const viewer = await userWithRole(app, authStore, "viewer@example.com", "viewer");
      const office = { name: "HQ", zones: [ZONE] };

      // Viewer: GET only.
      expect((await app.inject({ url: "/api/v1/offices", headers: viewer })).statusCode).toBe(200);
      const vPost = await app.inject({
        method: "POST",
        url: "/api/v1/offices",
        headers: viewer,
        payload: office,
      });
      expect(vPost.statusCode).toBe(403);
      expect(vPost.json().error.code).toBe("forbidden");
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/runs", headers: viewer, payload: {} })).statusCode,
      ).toBe(403);
      expect((await app.inject({ url: "/api/v1/tokens", headers: viewer })).statusCode).toBe(403);

      // Operator: create/edit offices and runs, but no admin areas or office deletion.
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/offices",
        headers: operator,
        payload: office,
      });
      expect(created.statusCode).toBe(201);
      const officeId = created.json().id as string;
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/runs", headers: operator, payload: {} }))
          .statusCode,
      ).not.toBe(403);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/v1/offices/${officeId}`, headers: operator }))
          .statusCode,
      ).toBe(403);
      for (const [method, url] of [
        ["POST", "/api/v1/connections"],
        ["POST", "/api/v1/workspaces"],
        ["POST", "/api/v1/tokens"],
        ["POST", "/api/v1/webhooks"],
        ["POST", "/api/v1/roles"],
        ["POST", "/api/v1/mcp/servers"],
        ["POST", "/api/v1/schedules"],
      ] as const) {
        const res = await app.inject({ method, url, headers: operator, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }

      // Admin and owner: administrative routes pass the guard.
      const tok = await app.inject({
        method: "POST",
        url: "/api/v1/tokens",
        headers: admin,
        payload: { name: "ci", role: "viewer" },
      });
      expect(tok.statusCode).toBe(201);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/v1/offices/${officeId}`, headers: owner }))
          .statusCode,
      ).not.toBe(403);

      // API_TOKEN keeps full access.
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: SERVICE,
            payload: { name: "X" },
          })
        ).statusCode,
      ).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("denies users without a membership (no default role)", async () => {
    const { app, authStore } = await makeApp();
    try {
      await userWithRole(app, authStore, "owner@example.com", "owner");
      const orphan = await userWithRole(app, authStore, "orphan@example.com", null);
      const res = await app.inject({ url: "/api/v1/offices", headers: orphan });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("no_membership");
      // They can still see who they are (so the UI can explain).
      const me = await app.inject({ url: "/api/v1/auth/me", headers: orphan });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.role).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("first-owner setup", () => {
  const payload = { email: "first@example.com", password: "long-enough-password" };

  it("requires API_TOKEN when one is configured", async () => {
    const { app } = await makeApp({ AUTH_SIGNUP_OPEN: "false" });
    try {
      const status = await app.inject({ url: "/api/v1/auth/status" });
      expect(status.json().setupRequires).toBe("api_token");
      const anon = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload });
      expect(anon.statusCode).toBe(403);
      expect(anon.json().error.code).toBe("setup_forbidden");
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload,
        headers: { authorization: "Bearer wrong-token-0123456789" },
      });
      expect(wrong.statusCode).toBe(403);
      const ok = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload, headers: SERVICE });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().user.role).toBe("owner");
    } finally {
      await app.close();
    }
  });

  it("only accepts loopback requests when no API_TOKEN is set", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test" }), {}, { masterKey: null });
    try {
      expect((await app.inject({ url: "/api/v1/auth/status" })).json().setupRequires).toBe("loopback");
      const remote = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload,
        remoteAddress: "203.0.113.7",
      });
      expect(remote.statusCode).toBe(403);
      expect(remote.json().error.code).toBe("setup_forbidden");
      const local = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload,
        remoteAddress: "127.0.0.1",
      });
      expect(local.statusCode).toBe(201);
      expect(local.json().user.role).toBe("owner");
    } finally {
      await app.close();
    }
  });

  it("yields exactly one owner under concurrent sign-ups", async () => {
    const { app } = await makeApp();
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/api/v1/auth/signup",
            headers: SERVICE,
            payload: { email: `u${i}@example.com`, password: "long-enough-password" },
          }),
        ),
      );
      const roles = results.map((r) => (r.json() as { user: { role: string } }).user.role);
      expect(roles.filter((r) => r === "owner")).toHaveLength(1);
      expect(roles.filter((r) => r === "operator")).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it("with sign-up closed, concurrent first sign-ups create one account", async () => {
    const { app } = await makeApp({ AUTH_SIGNUP_OPEN: "false" });
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/api/v1/auth/signup",
            headers: SERVICE,
            payload: { email: `c${i}@example.com`, password: "long-enough-password" },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 403)).toHaveLength(3);
    } finally {
      await app.close();
    }
  });
});

describe("login rate limiting", () => {
  it("returns 429 with Retry-After after 5 failures for the same IP + e-mail", async () => {
    const { app, authStore } = await makeApp();
    try {
      await userWithRole(app, authStore, "owner@example.com", "owner");
      const attempt = (password: string, remoteAddress = "198.51.100.1") =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress,
          payload: { email: "owner@example.com", password },
        });
      for (let i = 0; i < 5; i++) expect((await attempt("wrong-password")).statusCode).toBe(401);
      const blocked = await attempt("long-enough-password");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("too_many_attempts");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      // Another client IP is not affected.
      expect((await attempt("long-enough-password", "198.51.100.2")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("backs off exponentially, forgets old failures and resets on success", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ now: () => now });
    const key = LoginRateLimiter.key("1.2.3.4", "A@b.c");
    for (let i = 0; i < 4; i++) limiter.recordFailure(key);
    expect(limiter.retryAfter(key)).toBe(0);
    limiter.recordFailure(key);
    expect(limiter.retryAfter(key)).toBe(60);
    now += 61_000;
    expect(limiter.retryAfter(key)).toBe(0);
    limiter.recordFailure(key);
    expect(limiter.retryAfter(key)).toBe(120);
    now += 16 * 60_000; // whole window elapsed: count starts over
    limiter.recordFailure(key);
    expect(limiter.retryAfter(key)).toBe(0);
    limiter.recordSuccess(key);
    expect(limiter.retryAfter(key)).toBe(0);
  });
});

describe("stored API tokens", () => {
  async function issue(app: App, role: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: SERVICE,
      payload: { name: `${role}-token`, role, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; record: { id: string } };
  }

  it("authenticates with the token's role and workspace, and stops after revocation", async () => {
    const { app } = await makeApp();
    try {
      const viewer = await issue(app, "viewer");
      const auth = { authorization: `Bearer ${viewer.token}` };
      const me = await app.inject({ url: "/api/v1/auth/me", headers: auth });
      expect(me.json()).toMatchObject({ kind: "apiToken", role: "viewer" });
      expect((await app.inject({ url: "/api/v1/offices", headers: auth })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/offices", headers: auth, payload: { name: "x" } }))
          .statusCode,
      ).toBe(403);

      const operator = await issue(app, "operator");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/offices",
            headers: { authorization: `Bearer ${operator.token}` },
            payload: { name: "x", zones: [ZONE] },
          })
        ).statusCode,
      ).toBe(201);

      const listed = await app.inject({ url: "/api/v1/tokens", headers: SERVICE });
      expect(
        listed.json().tokens.find((t: { id: string }) => t.id === viewer.record.id).lastUsedAt,
      ).not.toBeNull();

      const mismatch = await app.inject({
        url: "/api/v1/offices",
        headers: { ...auth, "x-workspace-id": "00000000-0000-0000-0000-00000000beef" },
      });
      expect(mismatch.statusCode).toBe(403);

      await app.inject({ method: "DELETE", url: `/api/v1/tokens/${viewer.record.id}`, headers: SERVICE });
      expect((await app.inject({ url: "/api/v1/offices", headers: auth })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: "/api/v1/offices", headers: { authorization: "Bearer ift_bogus" } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects expired tokens", async () => {
    const { app } = await makeApp();
    try {
      const expired = await issue(app, "admin", { expiresAt: new Date(Date.now() - 60_000).toISOString() });
      const res = await app.inject({
        url: "/api/v1/offices",
        headers: { authorization: `Bearer ${expired.token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
