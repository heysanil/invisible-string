/**
 * In-memory fixed-window rate limiter for public ingress (`POST /t/:token`,
 * `POST /integrations/slack/events`). Two independent budgets protect the
 * ingress (docs/PLAN.md Phase 3 task 3.1 "rate-limit per-token + per-IP"): a
 * per-token budget caps abuse of one credential; a per-IP budget caps a single
 * source hammering many tokens.
 *
 * Fixed-window (not sliding) is intentionally simple — this is a coarse abuse
 * cap in front of the real work, not a billing meter. Single-process only; a
 * multi-node deployment would move this to Redis, but the interface stays.
 * Injectable clock keeps it unit-testable without real time.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets (for a Retry-After header). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Max requests per key per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Cap on tracked keys (evicts oldest windows). Defaults to 10_000. */
  maxKeys?: number;
}

interface WindowState {
  count: number;
  /** Window start (ms). */
  windowStart: number;
}

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Record one hit for `key`; returns whether it is within budget. */
  hit(key: string): RateLimitDecision {
    const now = this.now();
    let state = this.windows.get(key);
    if (!state || now - state.windowStart >= this.windowMs) {
      state = { count: 0, windowStart: now };
      this.windows.set(key, state);
      this.evictIfNeeded();
    }
    state.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.windowStart + this.windowMs - now) / 1000),
    );
    return { allowed: state.count <= this.limit, retryAfterSeconds };
  }

  /** Drop the oldest windows once the map exceeds its cap (bounded memory). */
  private evictIfNeeded(): void {
    if (this.windows.size <= this.maxKeys) return;
    const excess = this.windows.size - this.maxKeys;
    const iterator = this.windows.keys();
    for (let i = 0; i < excess; i += 1) {
      const next = iterator.next();
      if (next.done) break;
      this.windows.delete(next.value);
    }
  }
}
