import { describe, expect, test } from "bun:test";

import {
  clearAgentReservations,
  isWorkerLive,
  pickWorker,
  reserveAgentSlot,
  reservedAgentsOf,
  toSchedulableWorker,
  type SchedulableWorker,
  type WorkerCapacitySnapshot,
} from "./scheduler";

const NOW = new Date("2026-07-02T12:00:00Z");
const TTL = 30_000;
const HASH = "hash-target-00";

function worker(
  id: string,
  ageMs: number,
  extra: {
    status?: SchedulableWorker["status"];
    capacity?: WorkerCapacitySnapshot;
  } = {},
): SchedulableWorker {
  return {
    id,
    address: `http://worker-${id}:8080`,
    status: extra.status ?? "live",
    lastHeartbeatAt: new Date(NOW.getTime() - ageMs),
    capacity: extra.capacity ?? {},
  };
}

function pick(workers: SchedulableWorker[], opts: Partial<Parameters<typeof pickWorker>[1]> = {}) {
  return pickWorker(workers, {
    now: NOW,
    heartbeatTtlMs: TTL,
    defaultMaxAgents: 20,
    versionHash: HASH,
    ...opts,
  });
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
    expect(isWorkerLive(worker("a", 1_000, { status: "draining" }), NOW, TTL)).toBeFalse();
    expect(isWorkerLive(worker("a", 1_000, { status: "dead" }), NOW, TTL)).toBeFalse();
  });
});

describe("pickWorker — no eligible workers", () => {
  test("no_live_worker when the list is empty", () => {
    expect(pick([])).toEqual({ ok: false, reason: "no_live_worker" });
  });

  test("no_live_worker when every worker is stale/draining/dead", () => {
    const result = pick([
      worker("a", 60_000),
      worker("b", 1_000, { status: "draining" }),
      worker("c", 500, { status: "dead" }),
    ]);
    expect(result).toEqual({ ok: false, reason: "no_live_worker" });
  });

  test("no_capacity when live workers exist but all are at their agent cap", () => {
    const full = { maxAgents: 2, runningAgents: 2 };
    const result = pick([
      worker("a", 1_000, { capacity: full }),
      worker("b", 2_000, { capacity: full }),
    ]);
    expect(result).toEqual({ ok: false, reason: "no_capacity" });
  });
});

describe("pickWorker — ordering: affinity > warm > cold", () => {
  test("cold placement picks the freshest live worker with headroom", () => {
    const result = pick([
      worker("a", 20_000, { capacity: { runningAgents: 1 } }),
      worker("b", 2_000, { capacity: { runningAgents: 1 } }),
      worker("c", 10_000, { capacity: { runningAgents: 1 } }),
    ]);
    expect(result).toEqual(expect.objectContaining({ ok: true, reason: "cold" }));
    expect(result.ok && result.worker.id).toBe("b");
  });

  test("artifact-warm beats a fresher cold worker", () => {
    // b is fresher but cold; a is warm on the hash → a wins.
    const result = pick([
      worker("a", 20_000, { capacity: { runningHashes: [HASH], runningAgents: 5 } }),
      worker("b", 2_000, { capacity: { runningAgents: 0 } }),
    ]);
    expect(result.ok && result.reason).toBe("warm");
    expect(result.ok && result.worker.id).toBe("a");
  });

  test("warm prefers the freshest among warm workers", () => {
    const result = pick([
      worker("a", 20_000, { capacity: { runningHashes: [HASH] } }),
      worker("c", 3_000, { capacity: { runningHashes: [HASH] } }),
    ]);
    expect(result.ok && result.worker.id).toBe("c");
  });

  test("affinity beats warm and cold while the sticky worker can host it", () => {
    const result = pick(
      [
        worker("home", 25_000, { capacity: { runningHashes: [HASH], runningAgents: 3 } }),
        worker("warm", 2_000, { capacity: { runningHashes: [HASH] } }),
        worker("cold", 1_000, { capacity: { runningAgents: 0 } }),
      ],
      { affinityWorkerId: "home" },
    );
    expect(result.ok && result.reason).toBe("affinity");
    expect(result.ok && result.worker.id).toBe("home");
  });

  test("affinity is honoured on headroom even when not warm", () => {
    const result = pick(
      [
        worker("home", 25_000, { capacity: { runningAgents: 1, maxAgents: 20 } }),
        worker("cold", 1_000, { capacity: { runningAgents: 0 } }),
      ],
      { affinityWorkerId: "home" },
    );
    expect(result.ok && result.reason).toBe("affinity");
    expect(result.ok && result.worker.id).toBe("home");
  });

  test("a dead/stale affinity worker falls through to warm/cold", () => {
    const result = pick(
      [
        worker("home", 60_000, { capacity: { runningHashes: [HASH] } }), // stale
        worker("warm", 2_000, { capacity: { runningHashes: [HASH] } }),
      ],
      { affinityWorkerId: "home" },
    );
    expect(result.ok && result.reason).toBe("warm");
    expect(result.ok && result.worker.id).toBe("warm");
  });

  test("a full, cold affinity worker is bypassed for a worker with headroom", () => {
    const result = pick(
      [
        worker("home", 1_000, { capacity: { maxAgents: 2, runningAgents: 2 } }), // full + cold
        worker("cold", 2_000, { capacity: { runningAgents: 0 } }),
      ],
      { affinityWorkerId: "home" },
    );
    expect(result.ok && result.reason).toBe("cold");
    expect(result.ok && result.worker.id).toBe("cold");
  });
});

describe("placement reservations (thundering-herd guard)", () => {
  test("a burst of cold placements spreads instead of stampeding one worker", () => {
    clearAgentReservations();
    const fleet = [
      worker("res-a", 1_000, { capacity: { runningAgents: 0, maxAgents: 2 } }),
      worker("res-b", 2_000, { capacity: { runningAgents: 0, maxAgents: 2 } }),
    ];
    // Simulate what selectWorker does: pick, then reserve the booted hash.
    const picks: string[] = [];
    for (const hash of ["h1", "h2", "h3", "h4"]) {
      const result = pickWorker(fleet, {
        now: NOW,
        heartbeatTtlMs: TTL,
        defaultMaxAgents: 2,
        versionHash: hash,
        reservedOf: (w) => reservedAgentsOf(w, NOW),
      });
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      picks.push(result.worker.id);
      reserveAgentSlot(result.worker.id, hash, NOW.getTime());
    }
    // With reservations counted, the 4 placements fill BOTH workers (2+2)
    // instead of all landing on the freshest one.
    expect(picks.filter((id) => id === "res-a").length).toBe(2);
    expect(picks.filter((id) => id === "res-b").length).toBe(2);

    // A 5th placement finds no headroom anywhere.
    const overflow = pickWorker(fleet, {
      now: NOW,
      heartbeatTtlMs: TTL,
      defaultMaxAgents: 2,
      versionHash: "h5",
      reservedOf: (w) => reservedAgentsOf(w, NOW),
    });
    expect(overflow).toEqual({ ok: false, reason: "no_capacity" });
    clearAgentReservations();
  });

  test("a reservation clears when the heartbeat reports the hash running", () => {
    clearAgentReservations();
    reserveAgentSlot("res-c", "hash-x", NOW.getTime());
    const cold = worker("res-c", 1_000, { capacity: { runningAgents: 1 } });
    expect(reservedAgentsOf(cold, NOW)).toBe(1);
    const warm = worker("res-c", 1_000, {
      capacity: { runningAgents: 1, runningHashes: ["hash-x"] },
    });
    expect(reservedAgentsOf(warm, NOW)).toBe(0); // reported → no longer reserved
    clearAgentReservations();
  });

  test("a reservation expires after its TTL (failed boot self-heals)", () => {
    clearAgentReservations();
    reserveAgentSlot("res-d", "hash-y", NOW.getTime() - 120_000, 60_000);
    const w = worker("res-d", 1_000, { capacity: { runningAgents: 0 } });
    expect(reservedAgentsOf(w, NOW)).toBe(0);
    clearAgentReservations();
  });
});

describe("toSchedulableWorker", () => {
  test("normalizes an opaque capacity jsonb (dropping non-string hashes)", () => {
    const w = toSchedulableWorker({
      id: "a",
      address: "http://a",
      status: "live",
      lastHeartbeatAt: NOW,
      capacity: { maxAgents: 20, runningAgents: 3, runningHashes: [HASH, 5, null] },
    });
    expect(w.capacity).toEqual({
      maxAgents: 20,
      runningAgents: 3,
      runningHashes: [HASH],
    });
  });

  test("tolerates a null/empty capacity", () => {
    expect(toSchedulableWorker({
      id: "a",
      address: "http://a",
      status: "live",
      lastHeartbeatAt: NOW,
      capacity: null,
    }).capacity).toEqual({});
  });
});
