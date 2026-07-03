/**
 * Worker-registry endpoints — Phase-3 per-worker identity wiring (gated on
 * TEST_DATABASE_URL). Proves: register mints a session token in worker-token
 * mode; heartbeat authenticates with that token and ROTATES it; a bad token is
 * rejected; the bootstrap secret still works; deregister → dead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  verifyWorkerSessionToken,
  WORKER_BOOTSTRAP_SECRET_HEADER,
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import { workerRegistryPlugin } from "./workers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = "registry-bootstrap-secret-0123456789";

if (!TEST_DATABASE_URL) {
  console.warn(
    "[workers] TEST_DATABASE_URL not set — skipping worker-registry identity tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("worker registry — per-worker identity", () => {
  let handle: DbHandle;
  let app: { handle(request: Request): Promise<Response> };
  const createdWorkerIds: string[] = [];
  function newWorkerId(): string {
    const id = randomUUID();
    createdWorkerIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 4 });
    app = new Elysia().use(
      workerRegistryPlugin({
        db: handle.db,
        workerSharedSecret: SECRET,
        allowInsecureWorkerTransport: true, // http:// worker urls in tests
        heartbeatIntervalMs: 10_000,
      }),
    );
  });

  afterAll(async () => {
    // Remove this suite's worker rows so sibling suites' schedulers don't pick
    // a phantom worker address.
    if (createdWorkerIds.length > 0) {
      await handle.db
        .delete(schema.workers)
        .where(inArray(schema.workers.id, createdWorkerIds));
    }
    await handle?.close();
  });

  function call(
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    return app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  const capacity = { maxAgents: 20, runningAgents: 0, activeRequests: 0, runningHashes: [] };

  test("register (worker-token) mints a valid session token; heartbeat rotates it", async () => {
    const id = newWorkerId();
    const reg = await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "worker-token" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { authMode: string; workerToken?: string };
    expect(regBody.authMode).toBe("worker-token");
    expect(regBody.workerToken).toBeString();
    expect(verifyWorkerSessionToken(SECRET, id, regBody.workerToken!).ok).toBe(true);

    // Heartbeat authenticated with the session token (no bootstrap secret).
    const hb = await call(
      "/internal/workers/heartbeat",
      { id, capacity },
      { [WORKER_TOKEN_HEADER]: regBody.workerToken!, [WORKER_ID_HEADER]: id },
    );
    expect(hb.status).toBe(200);
    const hbBody = (await hb.json()) as { workerToken?: string };
    // Rotated: a fresh, valid token is returned.
    expect(hbBody.workerToken).toBeString();
    expect(hbBody.workerToken).not.toBe(regBody.workerToken);
    expect(verifyWorkerSessionToken(SECRET, id, hbBody.workerToken!).ok).toBe(true);
  });

  test("heartbeat with a bad token is rejected; bootstrap secret still works", async () => {
    const id = newWorkerId();
    await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "worker-token" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );

    const bad = await call(
      "/internal/workers/heartbeat",
      { id, capacity },
      { [WORKER_TOKEN_HEADER]: "not.a.validtoken", [WORKER_ID_HEADER]: id },
    );
    expect(bad.status).toBe(401);

    // The bootstrap secret remains a valid credential on heartbeat too.
    const good = await call(
      "/internal/workers/heartbeat",
      { id, capacity },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(good.status).toBe(200);
  });

  test("deregister marks the worker dead (sweeper then reschedules its sessions)", async () => {
    const id = newWorkerId();
    await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "shared-secret" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    const dereg = await call(
      "/internal/workers/deregister",
      { id },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(dereg.status).toBe(200);
    const row = await handle.db
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.id, id));
    expect(row[0]!.status).toBe("dead");
  });

  test("unauthenticated calls are rejected", async () => {
    const res = await call("/internal/workers/heartbeat", { id: randomUUID(), capacity }, {});
    expect(res.status).toBe(401);
  });

  test("heartbeat from a DEAD worker is fenced (404), never silently 200", async () => {
    const id = newWorkerId();
    await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "shared-secret" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    // Sweeper marks it dead (heartbeat gap) — simulate directly.
    await handle.db
      .update(schema.workers)
      .set({ status: "dead" })
      .where(eq(schema.workers.id, id));

    const hb = await call(
      "/internal/workers/heartbeat",
      { id, capacity },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(hb.status).toBe(404);
    const body = (await hb.json()) as { error: { code: string } };
    expect(body.error.code).toBe("worker_fenced");
    // Status must NOT be resurrected by the heartbeat.
    const row = await handle.db.select().from(schema.workers).where(eq(schema.workers.id, id));
    expect(row[0]!.status).toBe("dead");

    // Re-register (the worker's fencing response) revives it as a fresh epoch.
    const reg = await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "shared-secret" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(reg.status).toBe(200);
    const revived = await handle.db.select().from(schema.workers).where(eq(schema.workers.id, id));
    expect(revived[0]!.status).toBe("live");
  });

  test("heartbeat with draining:true flips live → draining (drain starts at t≈0)", async () => {
    const id = newWorkerId();
    await call(
      "/internal/workers/register",
      { id, url: `http://worker-${id}:8080`, capacity, identity: { mode: "shared-secret" } },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    const hb = await call(
      "/internal/workers/heartbeat",
      { id, capacity, draining: true },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    expect(hb.status).toBe(200);
    const row = await handle.db.select().from(schema.workers).where(eq(schema.workers.id, id));
    expect(row[0]!.status).toBe("draining");

    // A later plain heartbeat must NOT un-drain it.
    await call(
      "/internal/workers/heartbeat",
      { id, capacity },
      { [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET },
    );
    const after = await handle.db.select().from(schema.workers).where(eq(schema.workers.id, id));
    expect(after[0]!.status).toBe("draining");
  });

  test("registration allowlist rejects unprovisioned worker ids (403)", async () => {
    const allowed = newWorkerId();
    const rogue = newWorkerId();
    const guarded = new Elysia().use(
      workerRegistryPlugin({
        db: handle.db,
        workerSharedSecret: SECRET,
        allowInsecureWorkerTransport: true,
        allowedWorkerIds: [allowed],
      }),
    );
    const callGuarded = (body: unknown) =>
      guarded.handle(
        new Request("http://localhost/internal/workers/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WORKER_BOOTSTRAP_SECRET_HEADER]: SECRET,
          },
          body: JSON.stringify(body),
        }),
      );

    const rejected = await callGuarded({
      id: rogue,
      url: `http://worker-${rogue}:8080`,
      capacity,
      identity: { mode: "shared-secret" },
    });
    expect(rejected.status).toBe(403);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      "worker_not_allowed",
    );

    const ok = await callGuarded({
      id: allowed,
      url: `http://worker-${allowed}:8080`,
      capacity,
      identity: { mode: "shared-secret" },
    });
    expect(ok.status).toBe(200);
  });
});
