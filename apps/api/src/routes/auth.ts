import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TranslationKey } from "@infuture/i18n";
import {
  EmailTakenError,
  hashPassword,
  newSessionToken,
  sessionId,
  SetupForbiddenError,
  SignupClosedError,
  verifyPassword,
  type AuthStore,
  type UserRecord,
  type UserRole,
} from "../auth/store";
import { hasRole, requiredRole } from "../auth/permissions";
import { LoginRateLimiter } from "../auth/rateLimit";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import type { ApiTokenRecord } from "../workspaces/store";

export const SESSION_COOKIE = "infuture_session";

export type AuthContext =
  | { kind: "token" }
  | { kind: "user"; user: UserRecord; sessionId: string }
  | { kind: "apiToken"; tokenId: string; workspaceId: string; role: ApiTokenRecord["role"] };

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
  /** Looks up a stored workspace API token (`ift_...`); revoked/expired ones resolve to undefined. */
  verifyApiToken?: (raw: string) => Promise<ApiTokenRecord | undefined>;
  /** Allow sign-ups after the first (owner) account. */
  signupOpen: boolean;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** Browser origins allowed to use the session cookie (WEB_ORIGIN). Empty = no check. */
  allowedOrigins?: string[];
  /** Overrides the login throttle (tests). */
  loginLimiter?: LoginRateLimiter;
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

/** Routes any authenticated caller may use regardless of role (so the UI can show "no access"). */
const ANY_ROLE_ROUTES = new Set(["/api/v1/auth/me", "/api/v1/realtime/ticket"]);

/**
 * The realtime WebSocket may live on another host than the web app (e.g. Render static sites
 * cannot proxy WebSockets), where the session cookie is not sent. The web app first asks for a
 * short-lived, single-use ticket over HTTP (same origin, cookie auth) and passes it as `?ticket=`.
 */
const REALTIME_ROUTE = "/api/v1/realtime";
const TICKET_TTL_MS = 30_000;

/** Routes that read the workspace from X-Workspace-Id; the rest only serve the local workspace. */
const WORKSPACE_AWARE = ["/api/v1/tokens", "/api/v1/webhooks"];

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLoopback = (ip: string) => LOOPBACK.has(ip);

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

/** Role of the caller; the API_TOKEN service token is treated as owner. */
export function authRole(auth: AuthContext | null): UserRole | null {
  if (!auth) return null;
  if (auth.kind === "token") return "owner";
  if (auth.kind === "apiToken") return auth.role;
  return auth.user.role;
}

/** Installs the global auth hook plus /api/v1/auth/* routes. Register before the other routes. */
export async function authRoutes(app: FastifyInstance, opts: AuthOptions) {
  const { authStore } = opts;
  const limiter = opts.loginLimiter ?? new LoginRateLimiter();

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

  const hasServiceToken = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    return Boolean(
      opts.apiToken && header?.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), opts.apiToken),
    );
  };

  const tickets = new Map<string, { auth: AuthContext; expiresAt: number }>();

  /** Consumes a realtime ticket (single use) when the request is the WebSocket upgrade. */
  function ticketAuth(request: FastifyRequest): AuthContext | null {
    if (request.routeOptions.url !== REALTIME_ROUTE) return null;
    const ticket = (request.query as { ticket?: unknown } | undefined)?.ticket;
    if (typeof ticket !== "string" || !ticket) return null;
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expiresAt < Date.now()) return null;
    // Tickets are only handed to the web app, so the socket must come from an allowed origin.
    const origin = request.headers.origin;
    if (opts.allowedOrigins?.length && (!origin || !opts.allowedOrigins.includes(origin))) return null;
    return entry.auth;
  }

  async function authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const fromTicket = ticketAuth(request);
    if (fromTicket) return fromTicket;
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const bearer = header.slice(7).trim();
      if (opts.apiToken && safeEqual(bearer, opts.apiToken)) return { kind: "token" };
      if (bearer.startsWith("ift_") && opts.verifyApiToken) {
        const record = await opts.verifyApiToken(bearer);
        return record
          ? { kind: "apiToken", tokenId: record.id, workspaceId: record.workspaceId, role: record.role }
          : null;
      }
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

  const forbidden = (request: FastifyRequest, reply: FastifyReply, code: string, key: TranslationKey) =>
    reply.code(403).send({ error: { code, message: request.t(key) } });

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    // Decide from the route template Fastify matched, not the raw URL, so encoded or
    // case-variant paths cannot slip past the check. Unmatched requests just 404.
    const path = request.routeOptions.url;
    if (path === undefined || isPublic(path)) return;
    request.auth = await authenticate(request);
    const auth = request.auth;
    if (!auth) {
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: request.t("errors.authRequired") } });
    }
    if (auth.kind === "token" || ANY_ROLE_ROUTES.has(path)) return;

    if (auth.kind === "apiToken") {
      // A stored token is scoped to its workspace: pin X-Workspace-Id to it, and keep tokens of
      // other workspaces off the routes that only serve the local workspace.
      const asked = request.headers["x-workspace-id"];
      if (typeof asked === "string" && asked.trim() && asked.trim() !== auth.workspaceId) {
        return forbidden(request, reply, "workspace_mismatch", "errors.workspaceMismatch");
      }
      request.headers["x-workspace-id"] = auth.workspaceId;
      if (auth.workspaceId !== LOCAL_WORKSPACE_ID && !WORKSPACE_AWARE.some((p) => path.startsWith(p))) {
        return forbidden(request, reply, "workspace_mismatch", "errors.workspaceMismatch");
      }
    }

    const role = authRole(auth);
    if (!role) return forbidden(request, reply, "no_membership", "errors.noMembership");
    const needed = requiredRole(request.method, path, request.routeOptions.config?.minRole);
    if (!hasRole(role, needed)) {
      return reply.code(403).send({
        error: { code: "forbidden", message: request.t("errors.forbiddenRole", { role, needed }) },
      });
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

  /** The first (owner) account needs API_TOKEN, or a loopback request when no API_TOKEN is set. */
  const mayCreateFirst = (request: FastifyRequest) =>
    opts.apiToken ? hasServiceToken(request) : isLoopback(request.ip);

  app.get("/api/v1/auth/status", async () => {
    const users = await authStore.countUsers();
    return {
      needsSetup: users === 0,
      signupOpen: users === 0 || opts.signupOpen,
      setupRequires: users === 0 ? (opts.apiToken ? "api_token" : "loopback") : null,
    };
  });

  app.post("/api/v1/auth/signup", async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const user = await authStore.registerUser(
        {
          email: parsed.data.email,
          displayName: parsed.data.displayName || null,
          locale: request.locale,
          passwordHash: await hashPassword(parsed.data.password),
        },
        { allowFirst: mayCreateFirst(request), allowMore: opts.signupOpen, laterRole: "operator" },
      );
      reply.code(201);
      return await startSession(reply, user);
    } catch (error) {
      if (error instanceof SetupForbiddenError) {
        const key = opts.apiToken ? "errors.setupNeedsToken" : "errors.setupNeedsLoopback";
        return forbidden(request, reply, "setup_forbidden", key);
      }
      if (error instanceof SignupClosedError) {
        return forbidden(request, reply, "signup_closed", "errors.signupClosed");
      }
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
    const key = LoginRateLimiter.key(request.ip, parsed.data.email);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header("Retry-After", String(wait))
        .send({
          error: {
            code: "too_many_attempts",
            message: request.t("errors.tooManyAttempts", { seconds: wait }),
          },
        });
    }
    const found = await authStore.findByEmail(parsed.data.email);
    const ok = await verifyPassword(parsed.data.password, found?.passwordHash ?? (await DUMMY_HASH));
    if (!found || !found.passwordHash || !ok) {
      limiter.recordFailure(key);
      return reply
        .code(401)
        .send({ error: { code: "invalid_credentials", message: request.t("errors.invalidCredentials") } });
    }
    limiter.recordSuccess(key);
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
    if (auth?.kind === "apiToken") {
      return { kind: "apiToken", user: null, role: auth.role, workspaceId: auth.workspaceId };
    }
    return { kind: "token", user: null };
  });

  app.post("/api/v1/realtime/ticket", async (request) => {
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expiresAt < now) tickets.delete(key);
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, { auth: request.auth as AuthContext, expiresAt: now + TICKET_TTL_MS });
    return { ticket, expiresInSec: TICKET_TTL_MS / 1000 };
  });
}

// Let the hook and decorator apply to the whole app, not just this plugin's encapsulation context.
(authRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
