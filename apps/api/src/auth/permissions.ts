import type { UserRole } from "./store";

/** Minimum role a route needs. "owner" sits above "admin"; the API_TOKEN service token passes all. */
export type MinRole = "viewer" | "operator" | "admin" | "owner";

const RANK: Record<MinRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export const hasRole = (role: UserRole | null | undefined, needed: MinRole) =>
  role != null && RANK[role] >= RANK[needed];

declare module "fastify" {
  interface FastifyContextConfig {
    /** Overrides the default role policy for this route (see `requiredRole`). */
    minRole?: MinRole;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Administrative areas: owner/admin for every method (token and webhook listings leak secrets' metadata). */
const ADMIN_ALWAYS = ["/api/v1/tokens", "/api/v1/webhooks"];

/** Areas an operator may change: runs and their approvals, the board, memory and offices. */
const OPERATOR_WRITES = [
  "/api/v1/runs",
  "/api/v1/approvals",
  "/api/v1/board",
  "/api/v1/memory",
  "/api/v1/knowledge",
  "/api/v1/offices",
];

/** Read-only endpoints that use POST for their body. */
const VIEWER_POSTS = new Set(["/api/v1/knowledge/query"]);

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Default policy, keyed on the matched route template: viewers read, operators run and edit
 * offices/memory, admins manage everything else (connections, workspaces, tokens, webhooks,
 * roles, tools/MCP, schedules, settings, office deletion). Unknown writes default to admin.
 */
export function requiredRole(method: string, path: string, override?: MinRole): MinRole {
  if (override) return override;
  if (ADMIN_ALWAYS.some((p) => under(path, p))) return "admin";
  if (SAFE_METHODS.has(method)) return "viewer";
  if (method === "POST" && VIEWER_POSTS.has(path)) return "viewer";
  if (method === "DELETE" && under(path, "/api/v1/offices")) return "admin";
  if (OPERATOR_WRITES.some((p) => under(path, p))) return "operator";
  return "admin";
}
