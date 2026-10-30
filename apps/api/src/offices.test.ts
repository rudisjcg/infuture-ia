import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp as buildApp } from "./test-auth";
import { loadEnv } from "./env";
import { DEFAULT_OFFICE_ID, MemoryOfficeStore } from "./offices/store";
import { LOCAL_WORKSPACE_ID } from "./connections/store";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(
    loadEnv({ NODE_ENV: "test" }),
    {},
    { officeStore: new MemoryOfficeStore(), masterKey: null },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("MemoryOfficeStore", () => {
  it("seeds a default office that cannot be deleted", async () => {
    const store = new MemoryOfficeStore();
    const list = await store.listOffices(LOCAL_WORKSPACE_ID);
    expect(list[0]?.id).toBe(DEFAULT_OFFICE_ID);
    expect(list[0]?.isDefault).toBe(true);
    expect(await store.deleteOffice(LOCAL_WORKSPACE_ID, DEFAULT_OFFICE_ID)).toBe(false);
    expect(await store.listOffices("other")).toHaveLength(0);
  });
});

describe("offices routes", () => {
  it("lists the default office", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/offices" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0].id).toBe(DEFAULT_OFFICE_ID);
    expect(body[0].zones).toContain("servers");
    expect(body[0].characters.length).toBeGreaterThan(0);
  });

  it("runs the CRUD lifecycle", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/offices",
      payload: {
        name: "Lab",
        theme: "#10b981",
        zones: ["dev", "servers", "dev"],
        characters: [
          {
            name: "Ana",
            roleKey: "qa",
            color: "#06b6d4",
            shirt: "#0891b2",
            hair: "#0f172a",
            skin: "#fcd34d",
            accessory: "cap",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const office = created.json();
    expect(office.zones).toEqual(["dev", "servers"]);
    expect(office.isDefault).toBe(false);

    const got = await app.inject({ method: "GET", url: `/api/v1/offices/${office.id}` });
    expect(got.json().name).toBe("Lab");

    const upd = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${office.id}`,
      payload: { name: "Lab 2" },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe("Lab 2");
    expect(upd.json().theme).toBe("#10b981");

    const del = await app.inject({ method: "DELETE", url: `/api/v1/offices/${office.id}` });
    expect(del.json().ok).toBe(true);
    const gone = await app.inject({ method: "GET", url: `/api/v1/offices/${office.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("validates input and protects the default office", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/offices",
      payload: { name: "X", zones: [] },
    });
    expect(bad.statusCode).toBe(400);
    const badZone = await app.inject({
      method: "POST",
      url: "/api/v1/offices",
      payload: { name: "X", zones: ["kitchen"] },
    });
    expect(badZone.statusCode).toBe(400);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/offices/${DEFAULT_OFFICE_ID}` });
    expect(del.statusCode).toBe(409);
    const missing = await app.inject({ method: "PUT", url: "/api/v1/offices/nope", payload: { name: "Y" } });
    expect(missing.statusCode).toBe(404);
  });
});

describe("office characters persistence", () => {
  const sprite = {
    name: "Carlos #5",
    roleKey: "fullstack",
    color: "#6366f1",
    shirt: "#4f46e5",
    hair: "#1e1b4b",
    skin: "#fcd34d",
    accessory: "glasses",
  };

  it("saves sprites added to an office and restores them on reload", async () => {
    const before = (await app.inject({ method: "GET", url: `/api/v1/offices/${DEFAULT_OFFICE_ID}` })).json();
    const characters = [...before.characters, sprite];
    const upd = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${DEFAULT_OFFICE_ID}`,
      payload: { characters, name: "HQ edit", theme: "#0ea5e9", zones: ["dev", "coffee"] },
    });
    expect(upd.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/api/v1/offices/${DEFAULT_OFFICE_ID}` })).json();
    expect(after.characters).toHaveLength(characters.length);
    expect(after.characters.at(-1)).toEqual(sprite);
    expect(after).toMatchObject({
      name: "HQ edit",
      theme: "#0ea5e9",
      zones: ["dev", "coffee"],
      isDefault: true,
    });
  });

  it("rejects invalid characters and more than 24 sprites", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${DEFAULT_OFFICE_ID}`,
      payload: { characters: [{ ...sprite, accessory: "wings" }] },
    });
    expect(bad.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: "PUT",
      url: `/api/v1/offices/${DEFAULT_OFFICE_ID}`,
      payload: { characters: Array.from({ length: 25 }, () => sprite) },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe("offices migration", () => {
  it("ships a migration for the offices table registered in the journal", async () => {
    const { readFile } = await import("node:fs/promises");
    const base = new URL("../../../packages/db/drizzle/", import.meta.url);
    const sql = await readFile(new URL("0001_offices.sql", base), "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "offices"');
    expect(sql).toContain('"characters" jsonb');
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", base), "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain("0001_offices");
  });
});

// Runs against a real PostgreSQL only when TEST_DATABASE_URL is set (migrations applied).
describe.skipIf(!process.env.TEST_DATABASE_URL)("PgOfficeStore", () => {
  it("seeds office-hq, persists characters and protects the default", async () => {
    const { createDb, schema } = await import("@infuture/db");
    const { PgOfficeStore } = await import("./offices/store");
    const { db, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      const store = new PgOfficeStore(db, schema);
      const list = await store.listOffices(LOCAL_WORKSPACE_ID);
      expect(list[0]?.id).toBe(DEFAULT_OFFICE_ID);
      expect(await store.deleteOffice(LOCAL_WORKSPACE_ID, DEFAULT_OFFICE_ID)).toBe(false);
      const created = await store.createOffice(LOCAL_WORKSPACE_ID, {
        name: "Pg",
        theme: "#10b981",
        zones: ["dev"],
        characters: [],
      });
      const upd = await store.updateOffice(LOCAL_WORKSPACE_ID, created.id, {
        characters: [{ ...DEFAULT_CHAR }],
      });
      expect(upd?.characters).toHaveLength(1);
      expect(await store.deleteOffice(LOCAL_WORKSPACE_ID, created.id)).toBe(true);
    } finally {
      await close();
    }
  });
});

const DEFAULT_CHAR = {
  name: "Pg",
  roleKey: "qa",
  color: "#06b6d4",
  shirt: "#0891b2",
  hair: "#0f172a",
  skin: "#fcd34d",
  accessory: "cap" as const,
};
