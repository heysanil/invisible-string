import { describe, expect, test } from "bun:test";

import { FixedWindowRateLimiter } from "./rate-limit";

describe("FixedWindowRateLimiter", () => {
  test("allows up to the limit, then blocks within the window", () => {
    let now = 1_000_000;
    const rl = new FixedWindowRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(rl.hit("k").allowed).toBe(true);
    expect(rl.hit("k").allowed).toBe(true);
    expect(rl.hit("k").allowed).toBe(true);
    const blocked = rl.hit("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("independent budgets per key", () => {
    let now = 0;
    const rl = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(rl.hit("a").allowed).toBe(true);
    expect(rl.hit("b").allowed).toBe(true); // different key, own budget
    expect(rl.hit("a").allowed).toBe(false);
  });

  test("resets after the window elapses", () => {
    let now = 0;
    const rl = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(rl.hit("k").allowed).toBe(true);
    expect(rl.hit("k").allowed).toBe(false);
    now += 1000; // new window
    expect(rl.hit("k").allowed).toBe(true);
  });

  test("evicts oldest keys past maxKeys (bounded memory)", () => {
    let now = 0;
    const rl = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: () => now,
      maxKeys: 2,
    });
    rl.hit("a");
    rl.hit("b");
    rl.hit("c"); // evicts "a"
    // "a" was evicted → its budget resets, so it is allowed again.
    expect(rl.hit("a").allowed).toBe(true);
  });
});
