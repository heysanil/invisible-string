/**
 * Metrics + deep-health against a REAL Postgres — gated on TEST_DATABASE_URL
 * (skips cleanly when unset; the compose integration stage provides it).
 *
 * Exercises the drizzle-backed paths the pure unit tests can't:
 * `createDrizzleMetricsReader` (runs-by-status groupBy, active-sessions
 * inArray, worker capacity mapping), `collectMetrics` end-to-end through the
 * guarded route, and the deep-health DB ping + live-worker count. Assertions
 * are cross-test-safe: this file seeds its OWN worker rows (unique addresses,
 * no FK deps) and asserts on those rather than exact global totals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import { internalMetricsResponseSchema } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { healthPlugin } from "../health";
import { runMigrations } from "../migrate";
import {
  collectMetrics,
  createDrizzleMetricsReader,
  MetricsRegistry,
  metricsPlugin,
} from "./metrics";
import { isWorkerLive } from "./scheduler";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = "metrics-itest-secret-0123456789-0123456789";
const TTL = 30_000;

if (!TEST_DATABASE_URL) {
  console.log("[metrics] TEST_DATABASE_URL not set — skipping metrics integration tests");
}

describe.skipIf(!TEST_DATABASE_URL)("metrics + deep health (real DB)", () => {
  let handle: DbHandle;
  const liveWorkerId = randomUUID();
  const drainingWorkerId = randomUUID();
  const seededIds = [liveWorkerId, drainingWorkerId];

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!);
    await handle.db.insert(schema.workers).values([
      {
        id: liveWorkerId,
        address: `http://metrics-itest-${liveWorkerId}:8080`,
        status: "live",
        lastHeartbeatAt: new Date(),
        capacity: { maxAgents: 20, runningAgents: 4, activeRequests: 1 },
      },
      {
        id: drainingWorkerId,
        address: `http://metrics-itest-${drainingWorkerId}:8080`,
        status: "draining",
        lastHeartbeatAt: new Date(),
        capacity: { maxAgents: 20, runningAgents: 0, activeRequests: 0 },
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await handle?.db.delete(schema.workers).where(inArray(schema.workers.id, seededIds));
    await handle?.close();
  }, 30_000);

  test("reader maps worker capacity into utilization DTOs", async () => {
    const reader = createDrizzleMetricsReader(handle.db);
    const workers = await reader.workers();
    const mine = workers.find((w) => w.id === liveWorkerId);
    expect(mine).toBeDefined();
    expect(mine!.capacity.maxAgents).toBe(20);
    expect(mine!.status).toBe("live");
  });

  test("collectMetrics returns a schema-valid snapshot including seeded workers", async () => {
    const registry = new MetricsRegistry();
    registry.recordTrigger("manual", "dispatched");
    registry.recordBuildCache(true);
    const snapshot = await collectMetrics({
      registry,
      reader: createDrizzleMetricsReader(handle.db),
    });
    expect(internalMetricsResponseSchema.safeParse(snapshot).success).toBe(true);
    const live = snapshot.workers.find((w) => w.workerId === liveWorkerId);
    expect(live?.utilization).toBe(0.2); // 4 / 20
    expect(snapshot.buildCache.hits).toBe(1);
  });

  test("guarded /internal/metrics route: 401 without, 200 with the secret", async () => {
    const app = new Elysia().use(
      metricsPlugin({
        registry: new MetricsRegistry(),
        reader: createDrizzleMetricsReader(handle.db),
        workerSharedSecret: SECRET,
      }),
    );
    const unauth = await app.handle(new Request("http://localhost/internal/metrics"));
    expect(unauth.status).toBe(401);
    const authed = await app.handle(
      new Request("http://localhost/internal/metrics", {
        headers: { "x-worker-secret": SECRET },
      }),
    );
    expect(authed.status).toBe(200);
    expect(internalMetricsResponseSchema.safeParse(await authed.json()).success).toBe(true);
  });

  test("deep health is ok against a reachable DB + a live worker", async () => {
    const app = new Elysia().use(
      healthPlugin({
        pingDb: async () => {
          await handle.sql`select 1`;
        },
        countLiveWorkers: async () => {
          const rows = await handle.db
            .select({
              id: schema.workers.id,
              address: schema.workers.address,
              status: schema.workers.status,
              lastHeartbeatAt: schema.workers.lastHeartbeatAt,
            })
            .from(schema.workers)
            .where(eq(schema.workers.status, "live"));
          return rows.filter((r) => isWorkerLive(r, new Date(), TTL)).length;
        },
      }),
    );
    const res = await app.handle(
      new Request("http://localhost/api/health?deep=1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, { status: string }> };
    expect(body.ok).toBe(true);
    expect(body.checks.database?.status).toBe("ok");
    expect(body.checks.workers?.status).toBe("ok");
  });
});
