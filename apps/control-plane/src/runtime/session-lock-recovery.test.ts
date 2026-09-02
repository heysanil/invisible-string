/**
 * Session dispatch-lock recovery tests — gated on TEST_DATABASE_URL (skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * The recovery half of the dispatch-lock defect family (the entry-point half
 * is session-lock-defects.test.ts): the DURABLE remote-cancel obligation and
 * the extracted route bodies, proven against a real Postgres with a fake
 * worker client whose eve calls can be held in flight.
 *
 * D2 — DEFERRED CANCEL LOST ON CRASH: a Stop that could not remote-cancel
 *      synchronously (a dispatch held the session lock) scheduled an
 *      untracked promise; a crash before it ran left the accepted eve turn
 *      running forever. Now `runs.remote_cancel_pending_at` is set in the
 *      SAME CAS that settles the row, cleared once the guarded chase has run
 *      under the lock (issued / superseded / nothing to chase), and boot
 *      reconciliation finishes any marker it finds.
 *
 * D3 — LIVE-TAIL STOP without the lock: only a turn-QUALIFIED cancel may be
 *      issued (safe without the lock); an unqualified one is skipped, the
 *      obligation recorded, and the guarded chase finishes it once the lock
 *      frees — never an unscoped cancel that could reach a successor's turn.
 *
 * D4 — the chat follow-up route heals an abandoned eveless session it holds
 *      the lock for (closing it, permanent 409) instead of `session_busy`.
 *
 * D5 — HITL RESUME ERASES STOP: (1) the waiting→queued flip is a CAS on
 *      `status = 'waiting'` — a Stop committing in between makes it a 0-row
 *      update (409 `no_pending_input`), never a resurrected `queued` run with
 *      a tail; (2) a Stop landing during the ensure-agent boot is caught by
 *      the pre-eve marker fence — no continue is sent for a canceled run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger, TriggerEvent } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { RunEventBus } from "../runs/bus";
import { createDrizzleRunStore, type RunStore } from "../runs/store";
import { RunTailerManager } from "../runs/tailer";
import { loadRuntimeConfig } from "./config";
import { isRuntimeApiError } from "./errors";
import { MetricsRegistry } from "./metrics";
import { reconcileInterruptedRuns } from "./reconcile";
import { createPgSessionDispatchLocks } from "./session-lock";
import {
  cancelAgentRun,
  postSessionMessage,
  resumeRunInput,
  type RuntimeDeps,
} from "./routes";
import type { WorkerClient } from "./worker-client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[session-lock-recovery] skipped: TEST_DATABASE_URL not set");
}

const logger: Logger = createLogger({ sink: () => {}, minLevel: "error" });

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

class FakeWorkerClient {
  readonly continueCalls: Array<{ eveSessionId: string; body: unknown }> = [];
  readonly cancelCalls: Array<{ eveSessionId: string; turnId?: string }> = [];
  ensureGate: Deferred | null = null;
  ensureEntered: Deferred | null = null;
  streamTurnStarted = false;

  async ensureAgent(): Promise<void> {
    this.ensureEntered?.resolve();
    const gate = this.ensureGate;
    this.ensureGate = null;
    if (gate) await gate.promise;
  }
  async createEveSession(): Promise<{ sessionId: string }> {
    return { sessionId: `eve-fresh-${randomUUID().slice(0, 8)}` };
  }
  async continueEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
    body: unknown,
  ): Promise<{ sessionId: string; status: "accepted" }> {
    this.continueCalls.push({ eveSessionId, body });
    return { sessionId: eveSessionId, status: "accepted" };
  }
  async cancelEveTurn(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
    options?: { turnId?: string },
  ): Promise<Record<string, never>> {
    this.cancelCalls.push({ eveSessionId, ...(options?.turnId ? { turnId: options.turnId } : {}) });
    return {};
  }
  async openEventStream(
    _addr: string,
    _hash: string,
    _jwt: string,
    _eveSessionId: string,
    _startIndex: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const encoder = new TextEncoder();
    const emitTurn = this.streamTurnStarted;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (emitTurn) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "turn.started", data: { sequence: 0, turnId: "turn_observed" } })}\n`,
            ),
          );
        }
        signal.addEventListener(
          "abort",
          () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "x-eve-stream-tail-index": "-1" },
    });
  }
}

describe.skipIf(!GATE)("session dispatch lock recovery (D2, D3, D4, D5)", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;
  let workerId: string;
  const HASH = "e".repeat(64);
  const fakeWorker = new FakeWorkerClient();
  const tailStarts: string[] = [];
  let runStore: RunStore;
  let deps: RuntimeDeps;
  let liveDeps: RuntimeDeps;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 6, lockMax: 8 });
    const db = handle.db;
    orgId = `org-slr-${randomUUID()}`;
    userId = `user-slr-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Session Lock Recovery Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "slr",
      email: `${userId}@example.test`,
    });
    const agents = await db
      .insert(schema.agents)
      .values({ organizationId: orgId, name: "Lock Recovery Agent", runAsUserId: userId, draft: {} })
      .returning({ id: schema.agents.id });
    agentId = agents[0]!.id;
    const versions = await db
      .insert(schema.agentVersions)
      .values({
        agentId,
        definition: {
          persona: "p",
          model: { preset: "balanced" },
          context: { mcpConnectionIds: [], skillIds: [] },
        },
        contentHash: HASH,
        compilerVersion: "test",
        eveVersion: "test",
        modelProvider: "openrouter",
        modelId: "test/model",
        buildStatus: "succeeded",
      })
      .returning({ id: schema.agentVersions.id });
    versionId = versions[0]!.id;
    await db.insert(schema.modelAllowlist).values({
      organizationId: orgId,
      provider: "openrouter",
      modelId: "test/model",
      enabled: true,
    });
    const workers = await db
      .insert(schema.workers)
      .values({ address: "http://127.0.0.1:1", status: "live", lastHeartbeatAt: new Date(), capacity: {} })
      .returning({ id: schema.workers.id });
    workerId = workers[0]!.id;

    const runtime = loadRuntimeConfig({
      WORLD_DATABASE_URL: TEST_DATABASE_URL!,
      PLATFORM_JWT_SECRET: "slr-platform-jwt-secret-0000000000",
      WORKER_SHARED_SECRET: "slr-worker-shared-secret-000000000",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
      OPENROUTER_API_KEY: "test-openrouter-key",
      SESSION_TITLE_ENABLED: "0",
      MAX_CONCURRENT_RUNS_PER_WORKSPACE: "64",
    });
    runStore = createDrizzleRunStore(db);
    const bus = new RunEventBus();
    deps = {
      db,
      runtime,
      masterKey: undefined,
      artifacts: { presignGetUrl: () => "http://127.0.0.1:1/artifact" },
      buildStore: {
        get: async () => ({
          hash: HASH,
          status: "succeeded" as const,
          artifactKey: "artifacts/slr",
          errorLog: null,
        }),
      },
      workerClient: fakeWorker as unknown as WorkerClient,
      runStore,
      bus,
      tailers: {
        start: (options: { runId: string }) => {
          tailStarts.push(options.runId);
        },
        get: () => undefined,
        cancelRun: async () => false,
        cancelRunGuarded: async () => null,
      } as unknown as RunTailerManager,
      metrics: new MetricsRegistry(),
      logger,
    } as unknown as RuntimeDeps;
    liveDeps = {
      ...deps,
      tailers: new RunTailerManager({ store: runStore, bus, maxWallClockMs: 60_000, logger }),
    } as RuntimeDeps;
  }, 30_000);

  afterAll(async () => {
    await handle?.db.delete(schema.workers).where(eq(schema.workers.id, workerId));
    await handle?.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await handle?.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle?.close();
  }, 15_000);

  function triggerEvent(): TriggerEvent {
    return {
      agentId,
      workflowId: null,
      triggerType: "manual",
      message: "",
      data: {},
      principal: { workspaceId: orgId, userId, source: "chat" },
    };
  }

  async function insertSession(over: Partial<typeof schema.agentSessions.$inferInsert> = {}) {
    const rows = await handle.db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        agentId,
        agentVersionId: versionId,
        workflowId: null,
        eveSessionId: `eve-${randomUUID().slice(0, 8)}`,
        origin: "chat",
        principal: { workspaceId: orgId, userId, source: "chat" },
        affinityWorkerId: workerId,
        status: "active",
        ...over,
      })
      .returning();
    return rows[0]!;
  }

  async function insertRun(
    agentSessionId: string,
    over: Partial<typeof schema.runs.$inferInsert> = {},
  ) {
    const rows = await handle.db
      .insert(schema.runs)
      .values({
        agentSessionId,
        organizationId: orgId,
        mode: "agent",
        triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
        status: "queued",
        startedAt: new Date(),
        ...over,
      })
      .returning();
    return rows[0]!;
  }

  async function runRow(id: string) {
    const rows = await handle.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    return rows[0]!;
  }

  async function sessionRow(id: string) {
    const rows = await handle.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, id));
    return rows[0]!;
  }

  async function freshHeartbeat() {
    await handle.db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));
  }

  function testLocks() {
    return createPgSessionDispatchLocks(handle.lockSql);
  }

  const cancelsFor = (eveId: string) => fakeWorker.cancelCalls.filter((c) => c.eveSessionId === eveId);

  test("D2 — a no-tail Stop settles the row AND its remote-cancel obligation in one CAS; with the lock free the chase runs synchronously and clears it", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    await cancelAgentRun(deps, run, session, "stopped by user");
    const after = await runRow(run.id);
    expect(after.status).toBe("canceled");
    expect(after.remoteCancelPendingAt).toBeNull(); // issued ⇒ cleared
    expect(cancelsFor(session.eveSessionId!)).toHaveLength(1);
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("D2 — with a dispatch holding the lock the obligation stays DURABLE on the row until the deferred chase completes", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    const held = await testLocks().acquire(session.id);
    expect(held).not.toBeNull();
    try {
      await cancelAgentRun(deps, run, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      // The obligation is on the row — a crash here is finished at boot.
      expect(settled.remoteCancelPendingAt).not.toBeNull();
      expect(cancelsFor(session.eveSessionId!)).toHaveLength(0);
    } finally {
      await held!.release();
    }
    // The in-process deferred chase (the fast path) finishes it.
    await until(
      () => (cancelsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the deferred remote cancel",
    );
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("D2 — boot reconciliation finishes a pending remote cancel a crash left behind, and clears a SUPERSEDED one without touching eve", async () => {
    await freshHeartbeat();
    // (a) crash residue: canceled + obligation set, nothing else on the session.
    const orphaned = await insertSession();
    const orphanRun = await insertRun(orphaned.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    // (b) superseded: the same residue, but a newer run PROVABLY owns the
    // session — it is `running`, i.e. its tail started, which the dispatch
    // path does only after eve's 202 — and eve serializes turns, so the
    // settled turn is over. The obligation clears WITHOUT an unqualified
    // cancel that could hit the successor's turn. (A merely QUEUED successor
    // is no such proof and RETAINS the marker — remote-cancel-durability
    // .test.ts, G2.)
    const superseded = await insertSession();
    const supersededRun = await insertRun(superseded.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const successor = await insertRun(superseded.id, { status: "running" });

    const outcome = await reconcileInterruptedRuns(deps);
    expect(outcome.remoteCancels.settled).toBeGreaterThanOrEqual(2);
    expect(cancelsFor(orphaned.eveSessionId!)).toHaveLength(1);
    expect((await runRow(orphanRun.id)).remoteCancelPendingAt).toBeNull();
    expect(cancelsFor(superseded.eveSessionId!)).toHaveLength(0);
    expect((await runRow(supersededRun.id)).remoteCancelPendingAt).toBeNull();

    await runStore.markRun(successor.id, { status: "canceled", error: "test cleanup", completedAt: new Date() });
    await runStore.markSession(orphaned.id, "closed");
    await runStore.markSession(superseded.id, "closed");
  }, 20_000);

  test("D3 — a live-tail Stop that cannot take the lock issues NO unqualified cancel: the obligation is recorded and finished by the guarded chase once the lock frees", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    fakeWorker.streamTurnStarted = false; // no turn observed ⇒ unqualified
    liveDeps.tailers.start({
      runId: run.id,
      agentSessionId: session.id,
      openStream: (startIndex, signal) =>
        fakeWorker.openEventStream("", HASH, "", session.eveSessionId!, startIndex, signal),
      cancelRemoteTurn: async (options) => {
        await fakeWorker.cancelEveTurn("", HASH, "", session.eveSessionId!, options);
      },
    });
    await until(
      async () => ((await runStore.getRunStatus(run.id))?.status === "running" ? true : undefined),
      "the tail to adopt the run",
    );

    const held = await testLocks().acquire(session.id);
    expect(held).not.toBeNull();
    try {
      await cancelAgentRun(liveDeps, { id: run.id, status: "running" }, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      // No unscoped cancel went out without the lock…
      expect(cancelsFor(session.eveSessionId!)).toHaveLength(0);
      // …and the obligation is durable.
      expect(settled.remoteCancelPendingAt).not.toBeNull();
    } finally {
      await held!.release();
    }
    await until(
      () => (cancelsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the guarded chase after the lock freed",
    );
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("D3 — a live-tail Stop that cannot take the lock may still issue a turn-QUALIFIED cancel (scoped, so safe without the lock)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    fakeWorker.streamTurnStarted = true; // the tail observes turn.started
    liveDeps.tailers.start({
      runId: run.id,
      agentSessionId: session.id,
      openStream: (startIndex, signal) =>
        fakeWorker.openEventStream("", HASH, "", session.eveSessionId!, startIndex, signal),
      cancelRemoteTurn: async (options) => {
        await fakeWorker.cancelEveTurn("", HASH, "", session.eveSessionId!, options);
      },
    });
    await until(
      async () =>
        (await handle.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, run.id)))
          .length > 0
          ? true
          : undefined,
      "the tail to consume turn.started",
    );
    fakeWorker.streamTurnStarted = false;

    const held = await testLocks().acquire(session.id);
    expect(held).not.toBeNull();
    try {
      await cancelAgentRun(liveDeps, { id: run.id, status: "running" }, session, "stopped by user");
      expect(cancelsFor(session.eveSessionId!)).toEqual([
        { eveSessionId: session.eveSessionId!, turnId: "turn_observed" },
      ]);
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      expect(settled.remoteCancelPendingAt).toBeNull(); // issued ⇒ nothing owed
    } finally {
      await held!.release();
    }
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("D4 — the chat follow-up heals an abandoned eveless session it holds the lock for: permanent 409 + closed row, not session_busy until a restart", async () => {
    await freshHeartbeat();
    const session = await insertSession({ eveSessionId: null });
    await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      error: "stopped during the agent dispatch",
    });
    // The boot sweep ran while the lock was held → skipped.
    const held = await testLocks().acquire(session.id);
    try {
      await reconcileInterruptedRuns(deps);
      expect((await sessionRow(session.id)).status).toBe("active");
    } finally {
      await held!.release();
    }
    const tailsBefore = tailStarts.length;
    let thrown: unknown;
    try {
      await postSessionMessage(deps, {
        organizationId: orgId,
        userId,
        session: await sessionRow(session.id),
        message: "are you there?",
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRuntimeApiError(thrown)).toBeTrue();
    expect((thrown as { code: string }).code).toBe("session_not_continuable");
    expect((await sessionRow(session.id)).status).toBe("closed");
    expect(tailStarts.length).toBe(tailsBefore);
  }, 20_000);

  test("D5 (window 1) — a Stop committing between the resume's read and its flip: the waiting→queued CAS is a 0-row update, 409 no_pending_input, and the run stays canceled with no continue", async () => {
    await freshHeartbeat();
    const session = await insertSession({ status: "waiting" });
    const run = await insertRun(session.id, { status: "waiting" });
    // Pin the run row with a row lock from a side transaction: the resume's
    // UPDATE blocks on it; the side transaction then settles the row
    // `canceled` and commits, and the blocked UPDATE re-evaluates its WHERE
    // against the committed row (READ COMMITTED). Post-fix that WHERE says
    // `status = 'waiting'` and matches nothing; pre-fix it was by id alone
    // and wrote the canceled row back to `queued`.
    const pinned = deferred();
    const release = deferred();
    const side = handle.db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${schema.runs} where id = ${run.id} for update`);
      pinned.resolve();
      await release.promise;
      await tx
        .update(schema.runs)
        .set({ status: "canceled", error: "stopped by user", completedAt: new Date() })
        .where(eq(schema.runs.id, run.id));
    });
    await pinned.promise;
    const continuesBefore = fakeWorker.continueCalls.length;
    const tailsBefore = tailStarts.length;
    const resuming = resumeRunInput(deps, {
      organizationId: orgId,
      run,
      session,
      input: { requestId: "req_1", text: "yes" },
    });
    // Let the resume reach (and block on) the pinned row, then land the Stop.
    await Bun.sleep(400);
    release.resolve();
    await side;
    let thrown: unknown;
    try {
      await resuming;
    } catch (error) {
      thrown = error;
    }
    expect(isRuntimeApiError(thrown)).toBeTrue();
    expect((thrown as { code: string }).code).toBe("no_pending_input");
    expect((await runRow(run.id)).status).toBe("canceled");
    expect(fakeWorker.continueCalls.length).toBe(continuesBefore);
    expect(tailStarts.length).toBe(tailsBefore);
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("D5 (window 2) — a Stop landing during the resume's ensure-agent boot is caught by the pre-eve fence: no continue is sent, the run stays canceled, the obligation is finished", async () => {
    await freshHeartbeat();
    const session = await insertSession({ status: "waiting" });
    const run = await insertRun(session.id, { status: "waiting" });
    const ensureGate = deferred();
    const ensureEntered = deferred();
    fakeWorker.ensureGate = ensureGate;
    fakeWorker.ensureEntered = ensureEntered;
    const continuesBefore = fakeWorker.continueCalls.length;
    const tailsBefore = tailStarts.length;
    const resuming = resumeRunInput(deps, {
      organizationId: orgId,
      run,
      session,
      input: { requestId: "req_2", optionId: "approve" },
    });
    await ensureEntered.promise; // the CAS flipped waiting→queued; the boot is in flight
    expect((await runRow(run.id)).status).toBe("queued");
    // The Stop: no tail, the resume holds the session lock ⇒ the row settles
    // (obligation set) and the remote leg defers.
    await cancelAgentRun(deps, { id: run.id, status: "queued" }, session, "stopped by user");
    expect((await runRow(run.id)).status).toBe("canceled");
    ensureGate.resolve();
    const result = await resuming;
    expect(result.run.status).toBe("canceled");
    // The pre-eve fence held: no answer went to eve for a canceled run.
    expect(fakeWorker.continueCalls.length).toBe(continuesBefore);
    expect(tailStarts.length).toBe(tailsBefore);
    // …and the deferred chase (lock freed by the resume's finally) finished
    // the obligation.
    await until(
      () => (cancelsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the deferred remote cancel",
    );
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);
});
