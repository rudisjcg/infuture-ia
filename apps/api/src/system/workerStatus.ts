/*
 * In-process status of the agent worker. The worker (executeGoal / executeMultiAgentRun from
 * @infuture/worker) runs inside the API process, so the API tracks each execution itself:
 * busy/idle, how many are active, the last activity (heartbeat) and recent errors.
 */

export type WorkerState = "idle" | "busy" | "error";

export type WorkerStatusSnapshot = {
  state: WorkerState;
  active: number;
  completed: number;
  failed: number;
  startedAt: string;
  /** Last start, end or heartbeat of any execution; null when nothing ran yet. */
  lastActivityAt: string | null;
  lastError: { message: string; at: string } | null;
};

export class WorkerStatusTracker {
  private active = 0;
  private completed = 0;
  private failed = 0;
  private lastActivity: number | null = null;
  private lastError: { message: string; at: number } | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly now: () => number = Date.now,
    /** A failure shows as "error" for this long while the worker is idle. */
    private readonly errorWindowMs = 5 * 60_000,
  ) {
    this.startedAt = now();
  }

  /** Marks activity without changing counters (e.g. on every worker event). */
  heartbeat() {
    this.lastActivity = this.now();
  }

  /** Wraps one worker execution; a resolved result with status "failed" also counts as a failure. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.heartbeat();
    try {
      const result = await fn();
      const status = (result as { status?: unknown } | null)?.status;
      if (status === "failed") this.recordError("run failed");
      else this.completed += 1;
      return result;
    } catch (error) {
      this.recordError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.active -= 1;
      this.heartbeat();
    }
  }

  private recordError(message: string) {
    this.failed += 1;
    this.lastError = { message: message.slice(0, 200), at: this.now() };
  }

  snapshot(): WorkerStatusSnapshot {
    const recentError = this.lastError !== null && this.now() - this.lastError.at < this.errorWindowMs;
    return {
      state: this.active > 0 ? "busy" : recentError ? "error" : "idle",
      active: this.active,
      completed: this.completed,
      failed: this.failed,
      startedAt: new Date(this.startedAt).toISOString(),
      lastActivityAt: this.lastActivity === null ? null : new Date(this.lastActivity).toISOString(),
      lastError: this.lastError
        ? { message: this.lastError.message, at: new Date(this.lastError.at).toISOString() }
        : null,
    };
  }
}
