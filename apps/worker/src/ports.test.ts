import { describe, expect, test } from "bun:test";

import { createPortPool, PortPoolExhaustedError } from "./ports";

describe("port pool", () => {
  test("allocates every port in the range exactly once", () => {
    const pool = createPortPool(5000, 5002);
    expect(pool.size).toBe(3);
    expect([pool.allocate(), pool.allocate(), pool.allocate()]).toEqual([
      5000, 5001, 5002,
    ]);
    expect(pool.allocatedCount()).toBe(3);
  });

  test("throws PortPoolExhaustedError when full, reuses released ports", () => {
    const pool = createPortPool(6000, 6000);
    const port = pool.allocate();
    expect(port).toBe(6000);
    expect(() => pool.allocate()).toThrow(PortPoolExhaustedError);
    pool.release(port);
    expect(pool.allocate()).toBe(6000);
  });

  test("rejects an inverted range", () => {
    expect(() => createPortPool(5, 4)).toThrow();
  });
});
