/*
 * Pure helpers for the office dashboards' live data: turning the API's
 * /api/v1/system/metrics services into racks, mapping runs to characters and
 * computing KPIs. Kept free of React so they can be unit-tested.
 */

export type RackStatus = "ok" | "warn" | "down" | "unknown";

export type ApiService = {
  name: string;
  kind: "api" | "host" | "db" | "worker";
  status: RackStatus;
  cpu: number | null;
  mem: number | null;
  latencyMs: number | null;
  uptimeSec: number | null;
  detail?: string;
};

export type HistoryPoint = {
  at: string;
  apiCpu: number;
  apiMem: number;
  hostCpu: number;
  hostMem: number;
  dbLatencyMs: number | null;
  activeRuns: number | null;
};

export type Rack = {
  name: string;
  kind: ApiService["kind"];
  status: RackStatus;
  cpu: number | null;
  mem: number | null;
  latency: number | null;
  uptimeSec: number | null;
  detail?: string;
  /** False only for the offline simulation (API unreachable). */
  real: boolean;
  /** CPU history (percent) for the sparkline, when available. */
  cpuHistory?: number[];
};

export type Run = {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  /** Optional attribution stored by the API; null/absent for runs not assigned to a character. */
  officeId?: string | null;
  zone?: string | null;
  characterId?: string | null;
};

export const ACTIVE_RUN = new Set(["running", "queued", "waiting_approval"]);

/** Builds racks from the real service list; `apiLatency` is the round trip measured by the browser. */
export function racksFromServices(
  services: ApiService[],
  history: HistoryPoint[],
  apiLatency: number | null,
): Rack[] {
  return services.map((s) => {
    const cpuHistory =
      s.kind === "api"
        ? history.map((h) => h.apiCpu)
        : s.kind === "host"
          ? history.map((h) => h.hostCpu)
          : undefined;
    return {
      name: s.name,
      kind: s.kind,
      status: s.status,
      cpu: s.cpu,
      mem: s.mem,
      latency: s.kind === "api" ? apiLatency : s.latencyMs,
      uptimeSec: s.uptimeSec,
      detail: s.detail,
      real: true,
      cpuHistory: cpuHistory && cpuHistory.length > 1 ? cpuHistory : undefined,
    };
  });
}

/** What a character is doing: a real run (with its current step), idle, or a demo task (offline only). */
export type CharTask =
  | { kind: "run"; runId: string; goal: string; step: string | null }
  | { kind: "idle" }
  | { kind: "demo"; roleKey: string };

/** Characters are mapped to active runs in order (oldest first); the rest are available. */
export function taskForIndex(
  apiOk: boolean,
  runs: Run[],
  steps: Record<string, string>,
  index: number,
  roleKey: string,
  zone: string,
): CharTask {
  if (!apiOk) return zone === "coffee" ? { kind: "idle" } : { kind: "demo", roleKey };
  const active = runs
    .filter((r) => ACTIVE_RUN.has(r.status))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const run = active[index];
  if (!run) return { kind: "idle" };
  return { kind: "run", runId: run.id, goal: run.goal, step: steps[run.id] ?? null };
}

/**
 * Assigns active runs to characters of one office. Runs explicitly attributed to a character
 * (characterId + officeId) go to that character; unattributed runs fill the remaining
 * characters in start order (oldest first). Runs attributed to another office are ignored.
 */
export function assignTasks(
  apiOk: boolean,
  runs: Run[],
  steps: Record<string, string>,
  officeId: string,
  chars: { id: number; roleKey: string; zone: string }[],
): CharTask[] {
  if (!apiOk)
    return chars.map((c) => (c.zone === "coffee" ? { kind: "idle" } : { kind: "demo", roleKey: c.roleKey }));
  const active = runs
    .filter((r) => ACTIVE_RUN.has(r.status))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const toTask = (r: Run): CharTask => ({
    kind: "run",
    runId: r.id,
    goal: r.goal,
    step: steps[r.id] ?? null,
  });
  const explicit = chars.map((c) =>
    active.find((r) => r.characterId === String(c.id) && (r.officeId ?? officeId) === officeId),
  );
  const pool = active.filter((r) => !r.characterId && (!r.officeId || r.officeId === officeId));
  let next = 0;
  return chars.map((_, i) => {
    const own = explicit[i];
    if (own) return toTask(own);
    const r = pool[next];
    if (!r) return { kind: "idle" };
    next += 1;
    return toTask(r);
  });
}

/** Current step of a run: the running task, else the latest one. */
export function currentStep(tasks: { title: string; status: string }[]): string | null {
  if (tasks.length === 0) return null;
  const running = [...tasks].reverse().find((t) => t.status === "running");
  return (running ?? tasks[tasks.length - 1]!).title;
}

/** Default seats per zone, used when the office config does not define `zoneCapacity`. */
export const DEFAULT_ZONE_CAPACITY: Record<string, number> = {
  dev: 6,
  meeting: 6,
  coffee: 5,
  servers: 3,
  reception: 3,
};

export function zoneCapacity(zone: string, overrides?: Partial<Record<string, number>>): number {
  const v = overrides?.[zone];
  return typeof v === "number" && v > 0 ? v : (DEFAULT_ZONE_CAPACITY[zone] ?? 4);
}

export function occupancy(people: number, capacity: number): number {
  return capacity > 0 ? Math.round((people / capacity) * 100) : 0;
}

/** Runs finished today (local time). */
export function doneToday(runs: Run[], now = new Date()): Run[] {
  const today = now.toDateString();
  return runs.filter((r) => r.status === "done" && r.endedAt && new Date(r.endedAt).toDateString() === today);
}

/**
 * Completed runs per zone. Runs carry no agent/zone attribution, so for a zone this is an
 * estimate proportional to headcount; for the whole office it is exact.
 */
export function completedFor(
  done: number,
  peopleHere: number,
  peopleTotal: number,
  wholeOffice: boolean,
): { value: number; estimate: boolean } {
  if (wholeOffice) return { value: done, estimate: false };
  if (peopleTotal === 0) return { value: 0, estimate: true };
  return { value: Math.round((done * peopleHere) / peopleTotal), estimate: true };
}

/**
 * Completed runs from real data. Runs attributed to this office (and zone) are counted exactly;
 * only unattributed runs are shared by headcount, and only then is the value an estimate.
 */
export function completedFromRuns(
  done: Run[],
  officeId: string,
  zone: string | null,
  peopleHere: number,
  peopleTotal: number,
): { value: number; estimate: boolean } {
  const mine = done.filter((r) => r.officeId === officeId);
  const unattributed = done.filter((r) => !r.officeId && !r.zone);
  if (zone === null) return { value: mine.length + unattributed.length, estimate: false };
  const exact = mine.filter((r) => r.zone === zone).length;
  if (unattributed.length === 0) return { value: exact, estimate: false };
  const share = peopleTotal > 0 ? Math.round((unattributed.length * peopleHere) / peopleTotal) : 0;
  return { value: exact + share, estimate: true };
}
