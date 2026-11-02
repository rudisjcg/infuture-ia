/**
 * In-memory login throttle keyed by client IP + e-mail. After `maxFailures` failed attempts inside
 * `windowMs`, further attempts are refused for a lockout that doubles with every extra failure
 * (capped at `maxLockMs`). A successful login clears the key. Single-process only: put a shared
 * limiter (e.g. at the proxy) in front when running several API replicas.
 */
export type LoginRateLimitOptions = {
  maxFailures?: number;
  windowMs?: number;
  baseLockMs?: number;
  maxLockMs?: number;
  now?: () => number;
};

type Entry = { failures: number[]; lockedUntil: number };

const MAX_KEYS = 10_000;

export class LoginRateLimiter {
  private entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly now: () => number;

  constructor(opts: LoginRateLimitOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.baseLockMs = opts.baseLockMs ?? 60_000;
    this.maxLockMs = opts.maxLockMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  static key(ip: string, email: string) {
    return `${ip}|${email.trim().toLowerCase()}`;
  }

  /** Seconds the caller must wait before trying again, or 0 when an attempt is allowed. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const wait = entry.lockedUntil - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  recordFailure(key: string) {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    entry.failures.push(now);
    const over = entry.failures.length - this.maxFailures;
    if (over >= 0) {
      entry.lockedUntil = now + Math.min(this.maxLockMs, this.baseLockMs * 2 ** over);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(now);
  }

  recordSuccess(key: string) {
    this.entries.delete(key);
  }

  private prune(now: number) {
    if (this.entries.size <= MAX_KEYS) return;
    for (const [key, entry] of this.entries) {
      const fresh = entry.failures.some((t) => now - t < this.windowMs) || entry.lockedUntil > now;
      if (!fresh) this.entries.delete(key);
    }
    // Still too many: drop the oldest-touched keys (Map keeps insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_KEYS) break;
      this.entries.delete(key);
    }
  }
}
