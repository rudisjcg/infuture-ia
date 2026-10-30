import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  EmailTakenError,
  hashPassword,
  newSessionToken,
  sessionId,
  verifyPassword,
  type AuthStore,
  type UserRecord,
} from "../auth/store";

export const SESSION_COOKIE = "infuture_session";

export type AuthContext = { kind: "token" } | { kind: "user"; user: UserRecord; sessionId: string };

declare module "fastify" {
  interface FastifyRequest {
    /** Who made the request; set by the auth hook on protected routes. */
    auth: AuthContext | null;
  }
}

export type AuthOptions = {
  authStore: AuthStore;
  /** Static admin/service token (API_TOKEN). */
  apiToken?: string;
  /** Allow sign-ups after the first (owner) account. */
  signupOpen: boolean;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** Browser origins allowed to use the session cookie (WEB_ORIGIN). Empty = no check. */
  allowedOrigins?: string[];
};

/** Routes reachable without credentials. Everything else under /api/ needs a session or token. */
const PUBLIC_ROUTES = new Set([
  "/api/v1/info",
  "/api/v1/auth/status",
  "/api/v1/auth/login",
  "/api/v1/auth/signup",
  "/api/v1/auth/logout",
]);
const isPublic = (path: string) =>
  !path.startsWith("/api/") || PUBLIC_ROUTES.has(path) || path.startsWith("/api/v1/i18n/");

// Pre-computed so logins for unknown e-mails cost the same as for known ones.
const DUMMY_HASH = hashPassword("infuture-dummy-password");

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});
const signupSchema = credentialsSchema.extend({
  displayName: z.string().trim().max(100).optional(),
});

const publicUser = (u: UserRecord) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  locale: u.locale,
  role: u.role,
});

/** Installs the global auth hook plus /api/v1/auth/* routes. Register before the other routes. */
export async function authRoutes(app: FastifyInstance, opts: AuthOptions) {
  const { authStore } = opts;

  async function resolveSession(token: string): Promise<AuthContext | null> {
    const id = sessionId(token);
    const session = await authStore.getSession(id);
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await authStore.deleteSession(id);
      return null;
    }
    const user = await authStore.getUser(session.userId);
    return user ? { kind: "user", user, sessionId: id } : null;
  }

  async function authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const bearer = header.slice(7).trim();
      if (opts.apiToken && safeEqual(bearer, opts.apiToken)) return { kind: "token" };
      // Session tokens also work as bearer tokens (terminal / scripts).
      return resolveSession(bearer);
    }
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!cookie) return null;
    // The cookie is ambient, so a foreign page could ride it (notably on the realtime
    // WebSocket, which CORS does not cover). Only honour it from allowed origins.
    const origin = request.headers.origin;
    if (origin && opts.allowedOrigins?.length && !opts.allowedOrigins.includes(origin)) return null;
    return resolveSession(cookie);
  }

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    // Decide from the route template Fastify matched, not the raw URL, so encoded or
    // case-variant paths cannot slip past the check. Unmatched requests just 404.
    const path = request.routeOptions.url;
    if (path === undefined || isPublic(path)) return;
    request.auth = await authenticate(request);
    if (!request.auth) {
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: request.t("errors.authRequired") } });
    }
  });

  function setSessionCookie(reply: FastifyReply, token: string, maxAgeSec: number) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSec}`,
    ];
    if (opts.cookieSecure) parts.push("Secure");
    reply.header("Set-Cookie", parts.join("; "));
  }

  async function startSession(reply: FastifyReply, user: UserRecord) {
    const token = newSessionToken();
    const ttlSec = Math.round(opts.sessionTtlHours * 3600);
    await authStore.createSession(sessionId(token), user.id, new Date(Date.now() + ttlSec * 1000));
    setSessionCookie(reply, token, ttlSec);
    return { user: publicUser(user), token };
  }

  const validationError = (request: FastifyRequest, reply: FastifyReply, error: z.ZodError) =>
    reply.code(400).send({
      error: {
        code: "validation",
        message: request.t("errors.validation", {
          details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        }),
      },
    });

  app.get("/api/v1/auth/status", async () => {
    const users = await authStore.countUsers();
    return { needsSetup: users === 0, signupOpen: users === 0 || opts.signupOpen };
  });

  app.post("/api/v1/auth/signup", async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const isFirst = (await authStore.countUsers()) === 0;
    if (!isFirst && !opts.signupOpen) {
      return reply
        .code(403)
        .send({ error: { code: "signup_closed", message: request.t("errors.signupClosed") } });
    }
    try {
      const user = await authStore.createUser({
        email: parsed.data.email,
        displayName: parsed.data.displayName || null,
        locale: request.locale,
        passwordHash: await hashPassword(parsed.data.password),
        role: isFirst ? "owner" : "operator",
      });
      reply.code(201);
      return await startSession(reply, user);
    } catch (error) {
      if (error instanceof EmailTakenError) {
        return reply
          .code(409)
          .send({ error: { code: "email_taken", message: request.t("errors.emailTaken") } });
      }
      throw error;
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const found = await authStore.findByEmail(parsed.data.email);
    const ok = await verifyPassword(parsed.data.password, found?.passwordHash ?? (await DUMMY_HASH));
    if (!found || !found.passwordHash || !ok) {
      return reply
        .code(401)
        .send({ error: { code: "invalid_credentials", message: request.t("errors.invalidCredentials") } });
    }
    return startSession(reply, found.user);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (cookie) await authStore.deleteSession(sessionId(cookie));
    setSessionCookie(reply, "", 0);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (request) => {
    const auth = request.auth;
    if (auth?.kind === "user") return { kind: "user", user: publicUser(auth.user) };
    return { kind: "token", user: null };
  });
}

// Let the hook and decorator apply to the whole app, not just this plugin's encapsulation context.
(authRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
