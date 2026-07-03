import { describe, expect, test } from "bun:test";

import { isWorkerLive, pickWorker, type SchedulableWorker } from "./scheduler";

const NOW = new Date("2026-07-02T12:00:00Z");
const TTL = 30_000;

function worker(
  id: string,
  ageMs: number,
  status: SchedulableWorker["status"] = "live",
): SchedulableWorker {
  return {
    id,
    address: `http://worker-${id}:8080`,
    status,
    lastHeartbeatAt: new Date(NOW.getTime() - ageMs),
  };
}

describe("isWorkerLive", () => {
  test("fresh live worker is live", () => {
    expect(isWorkerLive(worker("a", 1_000), NOW, TTL)).toBeTrue();
  });

  test("stale heartbeat (>= ttl) is not live", () => {
    expect(isWorkerLive(worker("a", 30_000), NOW, TTL)).toBeFalse();
    expect(isWorkerLive(worker("a", 90_000), NOW, TTL)).toBeFalse();
  });

  test("draining/dead workers are never live", () => {
    expect(isWorkerLive(worker("a", 1_000, "draining"), NOW, TTL)).toBeFalse();
    expect(isWorkerLive(worker("a", 1_000, "dead"), NOW, TTL)).toBeFalse();
  });
});

describe("pickWorker", () => {
  test("null when there are no workers", () => {
    expect(pickWorker([], NOW, TTL)).toBeNull();
  });

  test("null when every worker is stale or not live", () => {
    expect(
      pickWorker(
        [worker("a", 60_000), worker("b", 1_000, "draining"), worker("c", 500, "dead")],
        NOW,
        TTL,
      ),
    ).toBeNull();
  });

  test("picks the live worker with the freshest heartbeat", () => {
    const picked = pickWorker(
      [worker("a", 20_000), worker("b", 2_000), worker("c", 10_000)],
      NOW,
      TTL,
    );
    expect(picked?.id).toBe("b");
  });

  test("prefers the affinity worker while it is live", () => {
    const picked = pickWorker(
      [worker("a", 20_000), worker("b", 2_000)],
      NOW,
      TTL,
      "a",
    );
    expect(picked?.id).toBe("a");
  });

  test("falls back to freshest when the affinity worker is stale", () => {
    const picked = pickWorker(
      [worker("a", 45_000), worker("b", 2_000)],
      NOW,
      TTL,
      "a",
    );
    expect(picked?.id).toBe("b");
  });
});
