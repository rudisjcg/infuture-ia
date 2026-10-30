import { buildApp } from "./app";
import type { FastifyInstance } from "fastify";

/** API_TOKEN used by tests; long enough for the env schema. */
export const TEST_API_TOKEN = "test-api-token-0123456789";

/**
 * Makes every `app.inject({...})` call send the test service token unless the call sets its own
 * Authorization header, so route tests keep exercising the protected API.
 */
export function withTestAuth<T extends FastifyInstance>(app: T): T {
  const inject = app.inject.bind(app) as (opts: Record<string, unknown>) => unknown;
  (app as unknown as { inject: unknown }).inject = (opts: Record<string, unknown> | string) => {
    const o = typeof opts === "string" ? { url: opts } : opts;
    const headers = (o.headers as Record<string, string> | undefined) ?? {};
    const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
    return inject({
      ...o,
      headers: hasAuth ? headers : { ...headers, authorization: `Bearer ${TEST_API_TOKEN}` },
    });
  };
  return app;
}

/** `buildApp` for tests: sets API_TOKEN (unless given) and authenticates every inject call with it. */
export async function buildTestApp(...[env, options, deps]: Parameters<typeof buildApp>) {
  const app = await buildApp({ ...env, API_TOKEN: env.API_TOKEN ?? TEST_API_TOKEN }, options, deps);
  return withTestAuth(app);
}
