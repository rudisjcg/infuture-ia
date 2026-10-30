import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LOCAL_WORKSPACE_ID } from "../connections/store";
import { OFFICE_ACCESSORIES, OFFICE_ZONE_KEYS, type OfficeRecord, type OfficeStore } from "../offices/store";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const characterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  roleKey: z.string().trim().min(1).max(40),
  color: hex,
  shirt: hex,
  hair: hex,
  skin: hex,
  accessory: z.enum(OFFICE_ACCESSORIES),
});

const zoneCapacitySchema = z
  .object(Object.fromEntries(OFFICE_ZONE_KEYS.map((k) => [k, z.number().int().min(1).max(50).optional()])))
  .strict();

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  theme: hex.default("#6366f1"),
  zones: z.array(z.enum(OFFICE_ZONE_KEYS)).min(1).max(OFFICE_ZONE_KEYS.length),
  characters: z.array(characterSchema).max(24).default([]),
  zoneCapacity: zoneCapacitySchema.default({}),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  theme: hex.optional(),
  zones: z.array(z.enum(OFFICE_ZONE_KEYS)).min(1).max(OFFICE_ZONE_KEYS.length).optional(),
  characters: z.array(characterSchema).max(24).optional(),
  zoneCapacity: zoneCapacitySchema.optional(),
});

const serialize = (o: OfficeRecord) => ({ ...o, createdAt: o.createdAt.toISOString() });

export async function officeRoutes(app: FastifyInstance, opts: { officeStore: OfficeStore }) {
  const { officeStore } = opts;
  const workspaceId = LOCAL_WORKSPACE_ID;

  const notFound = (url: string, method: string) => ({ method, url });

  app.get("/api/v1/offices", async () => (await officeStore.listOffices(workspaceId)).map(serialize));

  app.get<{ Params: { id: string } }>("/api/v1/offices/:id", async (request, reply) => {
    const o = await officeStore.getOffice(workspaceId, request.params.id);
    if (!o) {
      return reply.code(404).send({
        error: {
          code: "office_not_found",
          message: request.t("errors.notFound", notFound(request.url, "GET")),
        },
      });
    }
    return serialize(o);
  });

  app.post("/api/v1/offices", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: request.t("errors.validation", { details: parsed.error.issues[0]?.message ?? "" }),
        },
      });
    }
    const zones = [...new Set(parsed.data.zones)];
    const created = await officeStore.createOffice(workspaceId, { ...parsed.data, zones });
    return reply.code(201).send(serialize(created));
  });

  app.put<{ Params: { id: string } }>("/api/v1/offices/:id", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: request.t("errors.validation", { details: parsed.error.issues[0]?.message ?? "" }),
        },
      });
    }
    const updated = await officeStore.updateOffice(workspaceId, request.params.id, parsed.data);
    if (!updated) {
      return reply.code(404).send({
        error: {
          code: "office_not_found",
          message: request.t("errors.notFound", notFound(request.url, "PUT")),
        },
      });
    }
    return serialize(updated);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/offices/:id", async (request, reply) => {
    const existing = await officeStore.getOffice(workspaceId, request.params.id);
    if (!existing) {
      return reply.code(404).send({
        error: {
          code: "office_not_found",
          message: request.t("errors.notFound", notFound(request.url, "DELETE")),
        },
      });
    }
    if (existing.isDefault) {
      return reply.code(409).send({
        error: {
          code: "office_default",
          message: request.t("errors.validation", { details: "default office" }),
        },
      });
    }
    await officeStore.deleteOffice(workspaceId, request.params.id);
    return { ok: true };
  });
}
