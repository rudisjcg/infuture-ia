import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createEvent, type CCEvent } from "@infuture/events";
import type { TranslationKey } from "@infuture/i18n";
import { checkConnection, getProvider, PROVIDERS, requiresSecret } from "@infuture/providers";
import { decryptSecret, encryptSecret, type MasterKey } from "@infuture/vault";
import { LOCAL_WORKSPACE_ID, type Connection, type ConnectionStore } from "../connections/store";

export type ConnectionRoutesOptions = {
  store: ConnectionStore;
  masterKey: MasterKey | null;
  /** Injected in tests so no real provider is called. */
  fetch?: typeof fetch;
  /** Receives events such as connection.health_changed. */
  emit?: (event: CCEvent) => void;
};

const createSchema = z.object({
  providerId: z.string().min(1),
  alias: z.string().trim().min(1).max(80),
  secret: z.string().trim().min(1).max(4096).optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
  budgetUsdMonth: z.number().nonnegative().max(1_000_000).optional(),
  /** Check the connection right after saving it. */
  verify: z.boolean().default(true),
});

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  key: TranslationKey,
  values = {},
) {
  return reply.code(status).send({ error: { code, message: request.t(key, values) } });
}

/** Public shape of a connection. Has a hint of the key, never the key. */
const present = (c: Connection) => ({
  id: c.id,
  providerId: c.providerId,
  alias: c.alias,
  authType: c.authType,
  baseUrl: c.baseUrl,
  status: c.status,
  lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
  budgetUsdMonth: c.budgetUsdMonth === null ? null : Number(c.budgetUsdMonth),
  createdAt: c.createdAt.toISOString(),
  hint: c.hint,
  models: c.models,
});

export async function connectionRoutes(app: FastifyInstance, opts: ConnectionRoutesOptions) {
  const { store, masterKey } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  async function verify(connection: Connection) {
    let secret: string | null = null;
    if (connection.authType !== "local") {
      const sealed = await store.getSealed(connection.id);
      if (!sealed || !masterKey) return null;
      secret = decryptSecret(sealed, masterKey, connection.id);
    }
    const result = await checkConnection({
      providerId: connection.providerId,
      baseUrl: connection.baseUrl,
      secret,
      fetch: opts.fetch,
    });
    secret = null;
    await store.recordCheck(connection.id, result.status, result.status === "healthy" ? result.models : null);
    if (result.status !== connection.status) {
      opts.emit?.(
        createEvent({
          type: "connection.health_changed",
          workspaceId,
          // Real sequence numbers are assigned when events are persisted (phase 2).
          seq: 0,
          payload: { connectionId: connection.id, providerId: connection.providerId, status: result.status },
        }),
      );
    }
    return result;
  }

  app.get("/api/v1/providers", async () =>
    PROVIDERS.map((p) => ({ ...p, requiresSecret: requiresSecret(p) })),
  );

  app.get("/api/v1/connections", async () => (await store.list(workspaceId)).map(present));

  app.get<{ Params: { id: string } }>("/api/v1/connections/:id", async (request, reply) => {
    const connection = await store.get(workspaceId, request.params.id);
    if (!connection) return fail(reply, request, 404, "connection_not_found", "errors.connectionNotFound");
    return present(connection);
  });

  app.post("/api/v1/connections", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail(reply, request, 400, "validation", "errors.validation", { details });
    }
    const body = parsed.data;
    const provider = getProvider(body.providerId);
    if (!provider) {
      return fail(reply, request, 400, "unknown_provider", "errors.unknownProvider", {
        provider: body.providerId,
        supported: PROVIDERS.map((p) => p.id).join(", "),
      });
    }
    const needsSecret = requiresSecret(provider);
    if (needsSecret && !body.secret) {
      return fail(reply, request, 400, "secret_required", "errors.secretRequired", {
        provider: provider.displayName,
      });
    }
    if (needsSecret && !masterKey) {
      return fail(reply, request, 503, "vault_unavailable", "errors.vaultUnavailable");
    }

    const id = randomUUID();
    const created = await store.create({
      id,
      workspaceId,
      providerId: provider.id,
      alias: body.alias,
      authType: needsSecret ? "api_key" : "local",
      baseUrl: body.baseUrl ?? null,
      budgetUsdMonth: body.budgetUsdMonth === undefined ? null : body.budgetUsdMonth.toFixed(2),
      sealed: needsSecret ? encryptSecret(body.secret!, masterKey!, id) : null,
    });
    if (body.verify) await verify(created);
    reply.code(201);
    return present((await store.get(workspaceId, id)) ?? created);
  });

  app.post<{ Params: { id: string } }>("/api/v1/connections/:id/verify", async (request, reply) => {
    const connection = await store.get(workspaceId, request.params.id);
    if (!connection) return fail(reply, request, 404, "connection_not_found", "errors.connectionNotFound");
    if (connection.authType !== "local" && !masterKey) {
      return fail(reply, request, 503, "vault_unavailable", "errors.vaultUnavailable");
    }
    const result = await verify(connection);
    if (!result) return fail(reply, request, 409, "secret_missing", "errors.secretMissing");
    return {
      ...present((await store.get(workspaceId, connection.id))!),
      check: {
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        message: request.t(`connections.check.${result.status}`),
      },
    };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/connections/:id", async (request, reply) => {
    const revoked = await store.revoke(workspaceId, request.params.id);
    if (!revoked) return fail(reply, request, 404, "connection_not_found", "errors.connectionNotFound");
    return reply.code(204).send();
  });
}
