import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CCEvent } from "@infuture/events";
import { generateMasterKey, loadMasterKey } from "@infuture/vault";
import { buildTestApp as buildApp } from "./test-auth";
import { MemoryConnectionStore } from "./connections/store";
import { MemoryRunStore } from "./runs/store";
import { MemoryScheduleStore } from "./schedules/store";
import { loadEnv } from "./env";

const connectionStore = new MemoryConnectionStore();
const runStore = new MemoryRunStore();
const scheduleStore = new MemoryScheduleStore();
const events: CCEvent[] = [];

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" });
  app = await buildApp(
    env,
    {},
    {
      store: connectionStore,
      runStore,
      scheduleStore,
      masterKey: loadMasterKey(generateMasterKey()),
      emit: (e) => events.push(e),
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("schedules and recipes", () => {
  it("GET /api/v1/recipes returns the catalog of built-in playbooks", async () => {
    const resEn = await app.inject({ method: "GET", url: "/api/v1/recipes?lang=en" });
    expect(resEn.statusCode).toBe(200);
    const recipesEn = resEn.json();
    expect(recipesEn.length).toBeGreaterThanOrEqual(6);
    expect(recipesEn[0].name).toBe("System Architecture Review");

    const resEs = await app.inject({ method: "GET", url: "/api/v1/recipes?lang=es" });
    expect(resEs.statusCode).toBe(200);
    const recipesEs = resEs.json();
    expect(recipesEs[0].name).toBe("Revisión de Arquitectura de Sistemas");
  });

  it("manages scheduled automations lifecycle via API", async () => {
    // 1. List default schedules
    const listRes = await app.inject({ method: "GET", url: "/api/v1/schedules" });
    expect(listRes.statusCode).toBe(200);
    const initialList = listRes.json();
    expect(initialList.length).toBeGreaterThanOrEqual(2);

    // 2. Create new schedule
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      payload: {
        name: "Hourly Cache Invalidation & Status Probe",
        goal: "Check Redis cluster latency and probe worker availability.",
        role: "developer",
        multiagent: false,
        interval: "hourly",
        enabled: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.id).toBeDefined();
    expect(created.interval).toBe("hourly");
    expect(created.nextRunAt).not.toBeNull();

    // 3. Update schedule
    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/v1/schedules/${created.id}`,
      payload: {
        enabled: false,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().enabled).toBe(false);
    expect(updateRes.json().nextRunAt).toBeNull();

    // 4. Trigger schedule run
    const triggerRes = await app.inject({
      method: "POST",
      url: `/api/v1/schedules/${created.id}/trigger`,
    });
    expect(triggerRes.statusCode).toBe(200);
    const triggerBody = triggerRes.json();
    expect(triggerBody.ok).toBe(true);
    expect(triggerBody.scheduleId).toBe(created.id);
    expect(triggerBody.dispatch.goal).toContain("Check Redis cluster latency");

    // 5. Delete schedule
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/schedules/${created.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    // 6. Confirm 404 after deletion
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/schedules/${created.id}`,
    });
    expect(getRes.statusCode).toBe(404);
  });
});
