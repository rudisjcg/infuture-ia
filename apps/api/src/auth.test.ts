import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadEnv } from "./env";
import { hashPassword, verifyPassword } from "./auth/store";
import { SESSION_COOKIE } from "./routes/auth";

const TOKEN = "service-token-0123456789";

async function makeApp(extra: Record<string, string> = {}) {
  return buildApp(loadEnv({ NODE_ENV: "test", API_TOKEN: TOKEN, ...extra }), {}, { masterKey: null });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = raw?.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  if (!match?.[1]) throw new Error("no session cookie");
  return `${SESSION_COOKIE}=${match[1]}`;
}

const owner = { email: "Owner@Example.com", password: "correct horse battery", displayName: "Owner" };

describe("password hashing", () => {
  it("verifies scrypt hashes and rejects wrong passwords", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret-pass", hash)).toBe(true);
    expect(await verifyPassword("wrong-pass", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("auth routes", () => {
  it("keeps /health and auth status public but protects /api/v1 routes", async () => {
    const app = await makeApp();
    try {
      expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/info" })).statusCode).toBe(200);
      const status = await app.inject({ url: "/api/v1/auth/status" });
      expect(status.json()).toEqual({ needsSetup: true, signupOpen: true });
      for (const url of ["/api/v1/system/metrics", "/api/v1/offices", "/api/v1/runs", "/api/v1/auth/me"]) {
        const res = await app.inject({ url });
        expect(res.statusCode, url).toBe(401);
        expect(res.json().error.code).toBe("unauthenticated");
      }
      const wrong = await app.inject({ url: "/api/v1/offices", headers: { authorization: "Bearer nope" } });
      expect(wrong.statusCode).toBe(401);
      const service = await app.inject({
        url: "/api/v1/system/metrics",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(service.statusCode).toBe(200);
      const me = await app.inject({ url: "/api/v1/auth/me", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(me.json()).toEqual({ kind: "token", user: null });
    } finally {
      await app.close();
    }
  });

  it("signs up the first user as owner, then logs in, uses the session and logs out", async () => {
    const app = await makeApp();
    try {
      const signup = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: owner });
      expect(signup.statusCode).toBe(201);
      expect(signup.json().user).toMatchObject({ email: "owner@example.com", role: "owner" });
      const setCookie = String(signup.headers["set-cookie"]);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");

      // Sign-up is closed after the first account by default.
      const status = await app.inject({ url: "/api/v1/auth/status" });
      expect(status.json()).toEqual({ needsSetup: false, signupOpen: false });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email: "other@example.com", password: "another-password" },
      });
      expect(second.statusCode).toBe(403);
      expect(second.json().error.code).toBe("signup_closed");

      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: owner.email, password: "not-the-password" },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe("invalid_credentials");
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "ghost@example.com", password: "whatever-pass" },
      });
      expect(unknown.statusCode).toBe(401);

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "owner@example.com", password: owner.password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = sessionCookie(login.headers["set-cookie"]);

      const me = await app.inject({ url: "/api/v1/auth/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ kind: "user", user: { email: "owner@example.com", role: "owner" } });
      expect((await app.inject({ url: "/api/v1/offices", headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/system/metrics", headers: { cookie } })).statusCode).toBe(200);

      // The session token also works as a bearer token.
      const token = login.json().token as string;
      const bearer = await app.inject({
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.statusCode).toBe(200);

      const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
      expect(logout.statusCode).toBe(200);
      expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
      expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("allows more sign-ups when AUTH_SIGNUP_OPEN=true and rejects duplicate e-mails", async () => {
    const app = await makeApp({ AUTH_SIGNUP_OPEN: "true" });
    try {
      await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: owner });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email: "member@example.com", password: "member-password" },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().user.role).toBe("operator");
      const dup = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: owner });
      expect(dup.statusCode).toBe(409);
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: { email: "not-an-email", password: "short" },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("keeps custom code tools loopback/API_TOKEN-only even for logged-in users on a public host", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", API_HOST: "0.0.0.0" }), {}, { masterKey: null });
    try {
      const signup = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: owner });
      const cookie = sessionCookie(signup.headers["set-cookie"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tools/custom",
        headers: { cookie },
        payload: {
          name: "blocked_tool",
          description: "Should not register",
          parameters: {},
          code: "return 1;",
        },
      });
      expect(res.statusCode).toBe(401);
      expect((await app.inject({ url: "/api/v1/tools", headers: { cookie } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
