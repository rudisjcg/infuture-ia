import { describe, expect, it } from "vitest";
import {
  completedFor,
  currentStep,
  doneToday,
  occupancy,
  racksFromServices,
  taskForIndex,
  zoneCapacity,
  type ApiService,
  type Run,
} from "./officeLive";

const run = (id: string, status: string, startedAt: string, endedAt: string | null = null): Run => ({
  id,
  goal: `goal ${id}`,
  status,
  startedAt,
  endedAt,
});

describe("racksFromServices", () => {
  it("builds one real rack per service with the browser-measured API latency", () => {
    const services: ApiService[] = [
      { name: "api", kind: "api", status: "ok", cpu: 3, mem: 2, latencyMs: null, uptimeSec: 10 },
      { name: "worker", kind: "worker", status: "unknown", cpu: null, mem: null, latencyMs: null, uptimeSec: null },
    ];
    const history = [1, 2].map((v) => ({
      at: "",
      apiCpu: v,
      apiMem: 1,
      hostCpu: 1,
      hostMem: 1,
      dbLatencyMs: null,
      activeRuns: 0,
    }));
    const racks = racksFromServices(services, history, 12);
    expect(racks.map((r) => r.name)).toEqual(["api", "worker"]);
    expect(racks.every((r) => r.real)).toBe(true);
    expect(racks[0]!.latency).toBe(12);
    expect(racks[0]!.cpuHistory).toEqual([1, 2]);
    expect(racks[1]!.status).toBe("unknown");
  });
});

describe("taskForIndex", () => {
  const runs = [run("b", "running", "2026-01-02"), run("a", "queued", "2026-01-01"), run("c", "done", "2026-01-01")];
  it("maps active runs to characters in start order, with the current step", () => {
    expect(taskForIndex(true, runs, { a: "Plan" }, 0, "qa", "dev")).toEqual({
      kind: "run",
      runId: "a",
      goal: "goal a",
      step: "Plan",
    });
    expect(taskForIndex(true, runs, {}, 1, "qa", "dev")).toMatchObject({ kind: "run", runId: "b", step: null });
  });
  it("shows idle when online without a run, and demo tasks only offline", () => {
    expect(taskForIndex(true, runs, {}, 2, "qa", "dev")).toEqual({ kind: "idle" });
    expect(taskForIndex(false, runs, {}, 0, "qa", "dev")).toEqual({ kind: "demo", roleKey: "qa" });
    expect(taskForIndex(false, runs, {}, 0, "qa", "coffee")).toEqual({ kind: "idle" });
  });
});

describe("KPIs", () => {
  it("computes current step, capacity and occupancy", () => {
    expect(currentStep([])).toBeNull();
    expect(
      currentStep([
        { title: "a", status: "running" },
        { title: "b", status: "queued" },
      ]),
    ).toBe("a");
    expect(currentStep([{ title: "x", status: "done" }])).toBe("x");
    expect(zoneCapacity("dev")).toBe(6);
    expect(zoneCapacity("dev", { dev: 10 })).toBe(10);
    expect(zoneCapacity("dev", { dev: 0 })).toBe(6);
    expect(occupancy(3, 6)).toBe(50);
    expect(occupancy(1, 0)).toBe(0);
  });
  it("counts runs done today and flags zone shares as estimates", () => {
    const now = new Date("2026-03-10T12:00:00");
    const runs = [
      run("1", "done", "2026-03-10T10:00:00", "2026-03-10T11:00:00"),
      run("2", "done", "2026-03-09T10:00:00", "2026-03-09T11:00:00"),
      run("3", "failed", "2026-03-10T10:00:00", "2026-03-10T11:00:00"),
    ];
    expect(doneToday(runs, now).map((r) => r.id)).toEqual(["1"]);
    expect(completedFor(4, 1, 4, true)).toEqual({ value: 4, estimate: false });
    expect(completedFor(4, 1, 4, false)).toEqual({ value: 1, estimate: true });
    expect(completedFor(4, 0, 0, false)).toEqual({ value: 0, estimate: true });
  });
});
