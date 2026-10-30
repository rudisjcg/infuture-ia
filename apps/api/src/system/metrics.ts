import os from "node:os";
import type { WorkerStatusSnapshot } from "./workerStatus";

/*
 * Real system metrics for the office dashboards: this API process, the host it runs on,
 * the database (when configured) and the worker. The worker runs in-process (executeGoal
 * from @infuture/worker); its real status comes from a WorkerStatusTracker. Without one
 * the status is reported as "unknown" instead of being invented.
 */

export type ServiceStatus = "ok" | "warn" | "down" | "unknown";

export type ServiceMetrics = {
  name: string;
  kind: "api" | "host" | "db" | "worker";
  status: ServiceStatus;
  /** Percent 0-100, null when not measurable for this service. */
  cpu: number | null;
  mem: number | null;
  latencyMs: number | null;
  uptimeSec: number | null;
  detail?: string;
  /** Real in-process worker status (only on the worker service when tracked). */
  worker?: WorkerStatusSnapshot;
};

export type MetricsSnapshot = {
  at: string;
  services: ServiceMetrics[];
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

export type MetricsDeps = {
  /** Runs a trivial query against the database; undefined when no DATABASE_URL is configured. */
  dbPing?: () => Promise<unknown>;
  /** Counts active runs (queued/running/waiting); optional. */
  activeRuns?: () => Promise<number>;
  /** In-process worker status (busy/idle, active count, last activity, errors). */
  worker?: () => WorkerStatusSnapshot;
  now?: () => number;
};

const round1 = (v: number) => Math.round(v * 10) / 10;
const clampPct = (v: number) => Math.max(0, Math.min(100, round1(v)));

type CpuTimes = { idle: number; total: number };
function hostCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

export class MetricsCollector {
  private lastHost = hostCpuTimes();
  private lastProc = process.cpuUsage();
  private lastProcAt = process.hrtime.bigint();
  private readonly history: HistoryPoint[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: MetricsDeps = {},
    private readonly capacity = 120,
  ) {}

  /** CPU percentages since the previous call (first call: since construction). */
  private cpuDeltas() {
    const host = hostCpuTimes();
    const dTotal = host.total - this.lastHost.total;
    const dIdle = host.idle - this.lastHost.idle;
    const hostCpu = dTotal > 0 ? clampPct((1 - dIdle / dTotal) * 100) : 0;
    this.lastHost = host;

    const nowNs = process.hrtime.bigint();
    const usage = process.cpuUsage(this.lastProc);
    const elapsedUs = Number(nowNs - this.lastProcAt) / 1000;
    const cores = Math.max(1, os.cpus().length);
    const procCpu = elapsedUs > 0 ? clampPct(((usage.user + usage.system) / elapsedUs / cores) * 100) : 0;
    this.lastProc = process.cpuUsage();
    this.lastProcAt = nowNs;
    return { hostCpu, procCpu };
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const { hostCpu, procCpu } = this.cpuDeltas();
    const total = os.totalmem();
    const hostMem = total > 0 ? clampPct(((total - os.freemem()) / total) * 100) : 0;
    const procMem = total > 0 ? clampPct((process.memoryUsage().rss / total) * 100) : 0;

    const services: ServiceMetrics[] = [
      {
        name: "api",
        kind: "api",
        status: procCpu > 90 ? "warn" : "ok",
        cpu: procCpu,
        mem: procMem,
        latencyMs: null,
        uptimeSec: Math.round(process.uptime()),
        detail: `node ${process.version} · pid ${process.pid}`,
      },
      {
        name: os.hostname() || "host",
        kind: "host",
        status: hostCpu > 90 || hostMem > 92 ? "warn" : "ok",
        cpu: hostCpu,
        mem: hostMem,
        latencyMs: null,
        uptimeSec: Math.round(os.uptime()),
        detail: `${os.platform()} · ${os.cpus().length} CPU`,
      },
    ];

    if (this.deps.dbPing) {
      const t0 = performance.now();
      try {
        await this.deps.dbPing();
        const latency = Math.round(performance.now() - t0);
        services.push({
          name: "db",
          kind: "db",
          status: latency > 500 ? "warn" : "ok",
          cpu: null,
          mem: null,
          latencyMs: latency,
          uptimeSec: null,
          detail: "postgres",
        });
      } catch (error) {
        services.push({
          name: "db",
          kind: "db",
          status: "down",
          cpu: null,
          mem: null,
          latencyMs: null,
          uptimeSec: null,
          detail: error instanceof Error ? error.message.slice(0, 120) : "error",
        });
      }
    }

    let activeRuns: number | null = null;
    if (this.deps.activeRuns) {
      try {
        activeRuns = await this.deps.activeRuns();
      } catch {
        activeRuns = null;
      }
    }
    const worker = this.deps.worker?.();
    const nowMs = this.deps.now?.() ?? Date.now();
    services.push({
      name: "worker",
      kind: "worker",
      status: worker ? (worker.state === "error" ? "warn" : "ok") : "unknown",
      cpu: null,
      mem: null,
      latencyMs: null,
      uptimeSec: worker ? Math.max(0, Math.round((nowMs - Date.parse(worker.startedAt)) / 1000)) : null,
      detail: worker
        ? `in-process · ${worker.state} · ${worker.active} active`
        : activeRuns === null
          ? "in-process"
          : `in-process · ${activeRuns} active`,
      ...(worker ? { worker } : {}),
    });

    const at = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    this.push({
      at,
      apiCpu: procCpu,
      apiMem: procMem,
      hostCpu,
      hostMem,
      dbLatencyMs: services.find((s) => s.kind === "db")?.latencyMs ?? null,
      activeRuns,
    });
    return { at, services };
  }

  private push(point: HistoryPoint) {
    this.history.push(point);
    if (this.history.length > this.capacity) this.history.splice(0, this.history.length - this.capacity);
  }

  getHistory(): HistoryPoint[] {
    return [...this.history];
  }

  /** Samples periodically so the history is available when a dashboard opens. */
  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.snapshot().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
