/**
 * Session dispatch-lock defect tests — gated on TEST_DATABASE_URL (skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * Six defects the per-session dispatch lock introduced or exposed (the
 * crash-window review's follow-up), proven against a real Postgres. This
 * file uses ONLY entry points that predate the fixes (`dispatchRenderedRun`,
 * `cancelChildRun`, `reconcileInterruptedRuns`, the lock factory), so it runs
 * verbatim against the pre-fix code and FAILS there — the reversion proof.
 * The recovery-side twins (durable cancel marker, the extracted route
 * bodies) live in session-lock-recovery.test.ts.
 *
 * D1 — POOL DEADLOCK: a lock holder pins a connection for its whole eve
 *      round-trip while its own queries keep drawing from the pool; on ONE
 *      shared pool, `max` concurrent dispatches wedge forever. The lock now
 *      rides a dedicated lock pool: more concurrent dispatches than the ROOT
 *      pool has connections all complete.
 *
 * D3 — LIVE-TAIL STOP WRONG-TURN RACE: a Stop on a running run fired the
 *      tail's remote cancel WITHOUT awaiting it — unqualified before
 *      `turn.started` — finalized the row, admission reopened, and the late
 *      `{}` cancel could kill the successor's turn. The Stop now holds the
 *      session lock, AWAITS the remote cancel, THEN finalizes: a follow-up
 *      admitted while the cancel is airborne is refused (`session_busy`), and
 *      the run row is still live until the cancel has reached eve.
 *
 * D4 — SWEEP CANDIDATE STUCK UNTIL RESTART: the boot sweep skips an abandoned
 *      eveless session whose lock is held and never retries; every later
 *      dispatch then answered `session_busy` (the canceled marker-set eveless
 *      run counts as dispatching). A dispatch that HOLDS the lock is the
 *      exclusive owner and heals the abandoned row itself.
 *
 * D6 — FRESH-LOCK TIMEOUT MUTATES A SESSION IT DOES NOT OWN: (a) the lock is
 *      now taken BEFORE the claim transaction on a pre-minted id (a hook
 *      inside the claim transaction finds it already held; a saturated lock
 *      pool creates NOTHING); (b) a continuation re-reads its session UNDER
 *      the lock, so a stale `active` snapshot of a since-closed row is
 *      refused instead of inserting a run and resurrecting the row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger, TriggerEvent } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { RunEventBus } from "../runs/bus";
import { createDrizzleRunStore, type RunStore } from "../runs/store";
import { RunTailerManager } from "../runs/tailer";
import { loadRuntimeConfig } from "./config";
import {
  dispatchRenderedRun,
  type DispatchRenderedRunInput,
} from "./dispatch";
import { isRuntimeApiError } from "./errors";
import { MetricsRegistry } from "./metrics";
import { reconcileInterruptedRuns } from "./reconcile";
import { createPgSessionDispatchLocks } from "./session-lock";
import {
  cancelChildRun,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "./routes";
import type { WorkerClient } from "./worker-client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[session-lock-defects] skipped: TEST_DATABASE_URL not set");
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

/** Poll until `probe` returns a value. */
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

/** Reject after `ms` — the deadlock detector for D1. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

/**
 * Fake eve plane: records calls; individual calls can be held in flight, and
 * `holdAllContinues` holds EVERY continue until released (the D1 shape: many
 * dispatches parked mid-eve-call at once). `openEventStream` answers a
 * stream that never emits (no `turn.started` ⇒ an unqualified cancel) and
 * closes on abort, so a real tailer can follow it.
 */
class FakeWorkerClient {
  readonly createCalls: string[] = [];
  readonly continueCalls: Array<{ eveSessionId: string }> = [];
  readonly cancelCalls: Array<{ eveSessionId: string; turnId?: string }> = [];
  cancelGate: Deferred | null = null;
  cancelEntered: Deferred | null = null;
  holdAllContinues: Deferred | null = null;
  streamTurnStarted = false;
  private counter = 0;

  async ensureAgent(): Promise<void> {}
  async createEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    request: { message: string },
  ): Promise<{ sessionId: string }> {
    this.createCalls.push(request.message);
    return { sessionId: `eve-fresh-${++this.counter}` };
  }
  async continueEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
  ): Promise<{ sessionId: string; status: "accepted" }> {
    this.continueCalls.push({ eveSessionId });
    if (this.holdAllContinues) await this.holdAllContinues.promise;
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
    this.cancelEntered?.resolve();
    const gate = this.cancelGate;
    this.cancelGate = null;
    if (gate) await gate.promise;
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

describe.skipIf(!GATE)("session dispatch lock defects (D1, D3, D4, D6)", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;
  let workflowId: string;
  let workerId: string;
  const HASH = "d".repeat(64);
  const fakeWorker = new FakeWorkerClient();
  const tailStarts: string[] = [];
  let runStore: RunStore;
  let deps: RuntimeDeps;
  let ready: ReadyAgentVersion;

  // A deliberately SMALL root pool: the D1 deadlock needs more concurrent
  // lock holders than root connections.
  const ROOT_POOL = 3;
  const CONCURRENT_DISPATCHES = ROOT_POOL + 5;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: ROOT_POOL, lockMax: 16 });
    const db = handle.db;
    orgId = `org-sld-${randomUUID()}`;
    userId = `user-sld-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Session Lock Defects Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "sld",
      email: `${userId}@example.test`,
    });
    const agents = await db
      .insert(schema.agents)
      .values({
        organizationId: orgId,
        name: "Lock Defect Agent",
        runAsUserId: userId,
        draft: {},
      })
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
    const workflows = await db
      .insert(schema.workflows)
      .values({ organizationId: orgId, name: "Lock Defect WF", draft: {} })
      .returning({ id: schema.workflows.id });
    workflowId = workflows[0]!.id;
    const workers = await db
      .insert(schema.workers)
      .values({
        address: "http://127.0.0.1:1",
        status: "live",
        lastHeartbeatAt: new Date(),
        capacity: {},
      })
      .returning({ id: schema.workers.id });
    workerId = workers[0]!.id;

    const runtime = loadRuntimeConfig({
      WORLD_DATABASE_URL: TEST_DATABASE_URL!,
      PLATFORM_JWT_SECRET: "sld-platform-jwt-secret-0000000000",
      WORKER_SHARED_SECRET: "sld-worker-shared-secret-000000000",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
      OPENROUTER_API_KEY: "test-openrouter-key",
      SESSION_TITLE_ENABLED: "0",
      // Plenty of headroom for the D1 fan-out.
      MAX_CONCURRENT_RUNS_PER_WORKSPACE: "64",
    });
    runStore = createDrizzleRunStore(db);
    deps = {
      db,
      runtime,
      masterKey: undefined,
      artifacts: { presignGetUrl: () => "http://127.0.0.1:1/artifact" },
      buildStore: {
        get: async () => ({
          hash: HASH,
          status: "succeeded" as const,
          artifactKey: "artifacts/sld",
          errorLog: null,
        }),
      },
      workerClient: fakeWorker as unknown as WorkerClient,
      runStore,
      bus: new RunEventBus(),
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
    ready = {
      version: {
        id: versionId,
        agentId,
        contentHash: HASH,
        modelProvider: "openrouter",
        modelId: "test/model",
      },
      definition: {
        persona: "p",
        model: { preset: "balanced" },
        context: { mcpConnectionIds: [], skillIds: [] },
      },
      artifactKey: "artifacts/sld",
    } as unknown as ReadyAgentVersion;
  }, 30_000);

  afterAll(async () => {
    await handle?.db.delete(schema.workers).where(eq(schema.workers.id, workerId));
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle?.close();
  }, 15_000);

  function triggerEvent(): TriggerEvent {
    return {
      agentId,
      workflowId,
      triggerType: "pipeline",
      message: "",
      data: {},
      principal: { workspaceId: orgId, source: "slack" },
    };
  }

  function dispatchInput(
    threadKey: string,
    over: Partial<DispatchRenderedRunInput> = {},
  ): DispatchRenderedRunInput {
    return {
      organizationId: orgId,
      workflowId,
      agent: ready,
      origin: "slack",
      triggerType: "pipeline",
      taskMessage: "hello thread",
      triggerEvent: triggerEvent(),
      sessionPrincipalExtra: { slackThreadKey: threadKey },
      newSessionSlackThreadKey: threadKey,
      ...over,
    };
  }

  async function sessionRow(id: string) {
    const rows = await handle.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, id));
    return rows[0]!;
  }

  async function runsOf(sessionId: string) {
    return handle.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.agentSessionId, sessionId));
  }

  async function insertThreadSession(
    threadKey: string,
    over: Partial<typeof schema.agentSessions.$inferInsert> = {},
  ) {
    const rows = await handle.db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        agentId,
        agentVersionId: versionId,
        workflowId,
        eveSessionId: `eve-${randomUUID().slice(0, 8)}`,
        origin: "slack",
        principal: { workspaceId: orgId, source: "slack" },
        slackThreadKey: threadKey,
        affinityWorkerId: workerId,
        status: "active",
        ...over,
      })
      .returning();
    return rows[0]!;
  }

  async function freshHeartbeat() {
    await handle.db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));
  }

  async function settle(runId: string) {
    await runStore.markRun(runId, {
      status: "canceled",
      error: "test cleanup",
      completedAt: new Date(),
    });
  }

  /** The lock factory a TEST uses to contend with the dispatch path. */
  function testLocks() {
    return createPgSessionDispatchLocks(
      (handle.db as { $lockClient?: typeof handle.sql }).$lockClient ?? handle.sql,
    );
  }

  test(
    "D1 — more concurrent dispatches than ROOT-pool connections all complete: lock holders never consume root-pool capacity",
    async () => {
      await freshHeartbeat();
      const threads = await Promise.all(
        Array.from({ length: CONCURRENT_DISPATCHES }, () =>
          insertThreadSession(`int-sld:D1:${randomUUID().slice(0, 8)}`),
        ),
      );
      // Every continue parks in flight: each dispatch holds its session lock
      // (a pinned connection) while the OTHERS still need root connections
      // for their admission transactions and marker writes. Pre-fix the lock
      // lived on the root pool: ROOT_POOL holders pinned every connection,
      // their own admission transactions waited for a connection that could
      // never come, and nothing ever reached its `finally`.
      const hold = deferred();
      fakeWorker.holdAllContinues = hold;
      const continuesBefore = fakeWorker.continueCalls.length;
      const dispatching = threads.map((thread) =>
        dispatchRenderedRun(deps, dispatchInput(thread.slackThreadKey!, { existingSession: thread })),
      );
      try {
        await withDeadline(
          until(
            () =>
              fakeWorker.continueCalls.length - continuesBefore >= CONCURRENT_DISPATCHES
                ? true
                : undefined,
            "every dispatch to reach its eve call",
            15_000,
          ),
          16_000,
          "fan-out to the eve plane",
        );
      } finally {
        hold.resolve();
        fakeWorker.holdAllContinues = null;
      }
      const results = await withDeadline(Promise.all(dispatching), 15_000, "the fan-out settling");
      expect(results.every((r) => r.dispatched)).toBeTrue();
      expect(new Set(results.map((r) => r.session.id)).size).toBe(CONCURRENT_DISPATCHES);
      for (const result of results) await settle(result.run.id);
      for (const thread of threads) await runStore.markSession(thread.id, "closed");
    },
    40_000,
  );

  test(
    "D3 — a Stop on a live tail is AWAITED under the session lock before the row finalizes: a follow-up during the airborne cancel is refused, never admitted under it",
    async () => {
      await freshHeartbeat();
      const threadKey = `int-sld:D3:${randomUUID().slice(0, 8)}`;
      const thread = await insertThreadSession(threadKey);
      // A REAL tailer this time: the run must be `running` with a live tail
      // that has NOT observed `turn.started` (so the cancel is unqualified —
      // exactly the shape that could kill a successor's turn).
      const tailers = new RunTailerManager({
        store: runStore,
        bus: deps.bus,
        maxWallClockMs: 60_000,
        logger,
      });
      const liveDeps = { ...deps, tailers } as RuntimeDeps;
      fakeWorker.streamTurnStarted = false;
      const a = await dispatchRenderedRun(liveDeps, dispatchInput(threadKey, { existingSession: thread }));
      expect(a.dispatched).toBeTrue();
      await until(
        async () =>
          (await runStore.getRunStatus(a.run.id))?.status === "running" ? true : undefined,
        "A's tail to adopt the run",
      );

      // Hold the remote cancel in flight and Stop A through the child-run
      // cancel path (the same primitive the cancel route uses).
      const cancelGate = deferred();
      const cancelEntered = deferred();
      fakeWorker.cancelGate = cancelGate;
      fakeWorker.cancelEntered = cancelEntered;
      const stopping = cancelChildRun(liveDeps, a.run.id, "stopped by user");
      await cancelEntered.promise; // A's unqualified cancel is airborne

      // THE FIX, two halves. (1) The row is NOT finalized yet — the cancel is
      // awaited first (pre-fix: canceled already, admission open).
      expect((await runStore.getRunStatus(a.run.id))?.status).toBe("running");
      // (2) A follow-up B on the same session is refused while the cancel is
      // airborne — the Stop holds the session lock (pre-fix: B was admitted
      // here and A's late `{}` cancel would have stopped B's turn).
      let busyError: unknown;
      try {
        await dispatchRenderedRun(deps, dispatchInput(threadKey, { existingSession: await sessionRow(thread.id) }));
      } catch (error) {
        busyError = error;
      }
      expect(isRuntimeApiError(busyError)).toBeTrue();
      expect((busyError as { code: string }).code).toBe("session_busy");

      // The cancel lands; only THEN does A finalize and admission reopen.
      cancelGate.resolve();
      await stopping;
      expect((await runStore.getRunStatus(a.run.id))?.status).toBe("canceled");
      const cancelsAfterA = fakeWorker.cancelCalls.length;
      const b = await dispatchRenderedRun(deps, dispatchInput(threadKey, { existingSession: await sessionRow(thread.id) }));
      expect(b.dispatched).toBeTrue();
      // No further cancel ever reached eve after B was admitted.
      expect(fakeWorker.cancelCalls.length).toBe(cancelsAfterA);

      await settle(b.run.id);
      await runStore.markSession(thread.id, "closed");
    },
    30_000,
  );

  test(
    "D4 — an abandoned eveless thread holder the boot sweep skipped (lock held) is healed by the next dispatch instead of answering session_busy until a restart",
    async () => {
      await freshHeartbeat();
      const threadKey = `int-sld:D4:${randomUUID().slice(0, 8)}`;
      // The stuck shape: an eveless, live-status holder of the thread claim
      // whose newest run is canceled with the dispatch-attempt marker SET
      // (a Stop raced the create, then the process died before the recheck).
      const holder = await insertThreadSession(threadKey, { eveSessionId: null });
      await handle.db.insert(schema.runs).values({
        agentSessionId: holder.id,
        organizationId: orgId,
        workflowId,
        mode: "agent",
        triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
        status: "canceled",
        error: "stopped during the agent dispatch",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Boot reconciliation runs while SOME dispatch holds the holder's lock
      // — the sweep skips the candidate (correctly), and never retries.
      const held = await testLocks().acquire(holder.id);
      expect(held).not.toBeNull();
      try {
        await reconcileInterruptedRuns(deps);
        expect((await sessionRow(holder.id)).status).toBe("active");
      } finally {
        await held!.release();
      }

      // THE FIX: the next message in the thread heals the abandoned holder
      // itself (under the holder's lock, which proves nothing is in flight)
      // and dispatches a FRESH session. Pre-fix: session_busy — and again on
      // every retry until the next boot's sweep happened to find the lock free.
      const next = await dispatchRenderedRun(deps, dispatchInput(threadKey));
      expect(next.dispatched).toBeTrue();
      expect(next.session.id).not.toBe(holder.id);
      const healed = await sessionRow(holder.id);
      expect(healed.status).toBe("closed");
      expect(healed.slackThreadKey).toBeNull();
      expect((await sessionRow(next.session.id)).slackThreadKey).toBe(threadKey);

      await settle(next.run.id);
      await runStore.markSession(next.session.id, "closed");
    },
    20_000,
  );

  test(
    "D6a — a fresh session's dispatch lock is taken BEFORE the claim transaction (pre-minted id): a hook inside the claim finds it already held",
    async () => {
      await freshHeartbeat();
      const threadKey = `int-sld:D6a:${randomUUID().slice(0, 8)}`;
      let contended: boolean | undefined;
      const result = await dispatchRenderedRun(deps, {
        ...dispatchInput(threadKey),
        onRunCreated: async (_tx, run) => {
          // Inside the claim transaction. Post-fix the creator already holds
          // its (pre-minted) session's lock, so a try-acquire fails; pre-fix
          // the lock was taken only after commit and this succeeds — the
          // window a follow-up could slip into.
          const lock = await testLocks().acquire(run.agentSessionId!);
          contended = lock === null;
          await lock?.release();
        },
      });
      expect(contended).toBeTrue();
      await settle(result.run.id);
      await runStore.markSession(result.session.id, "closed");
    },
    20_000,
  );

  test(
    "D6a — when the fresh-session lock cannot be had (lock pool saturated), NOTHING is created: no session row, no run row, no thread claim",
    async () => {
      await freshHeartbeat();
      const threadKey = `int-sld:D6a2:${randomUUID().slice(0, 8)}`;
      // A deps whose LOCK pool has exactly one connection — and the test pins
      // it, so the creator's reserve times out. Pre-fix the lock came from
      // the root pool (never saturated here) and the dispatch went through,
      // leaving rows behind on what should have been a no-op refusal.
      const starved = createDb(TEST_DATABASE_URL!, { max: 3, lockMax: 1 });
      const lockSql = (starved as { lockSql?: typeof starved.sql }).lockSql ?? starved.sql;
      const pinned = await lockSql.reserve();
      try {
        const starvedDeps = { ...deps, db: starved.db } as RuntimeDeps;
        let thrown: unknown;
        try {
          await dispatchRenderedRun(starvedDeps, dispatchInput(threadKey));
        } catch (error) {
          thrown = error;
        }
        expect(isRuntimeApiError(thrown)).toBeTrue();
        expect((thrown as { code: string }).code).toBe("session_busy");
        const claims = await handle.db
          .select({ id: schema.agentSessions.id })
          .from(schema.agentSessions)
          .where(
            and(
              eq(schema.agentSessions.workflowId, workflowId),
              eq(schema.agentSessions.slackThreadKey, threadKey),
            ),
          );
        expect(claims).toHaveLength(0);
      } finally {
        pinned.release();
        await starved.close();
      }
    },
    20_000,
  );

  test(
    "D6b — a continuation dispatched from a STALE `active` snapshot of a since-closed session is refused: no orphan run, no resurrected row",
    async () => {
      await freshHeartbeat();
      const threadKey = `int-sld:D6b:${randomUUID().slice(0, 8)}`;
      const snapshot = await insertThreadSession(threadKey); // active, eve id set
      // The session closes under the follow-up's feet (the pre-fix creator's
      // lock-timeout close, a reset, eve's own eviction — any of them).
      await runStore.markSession(snapshot.id, "closed");
      expect(snapshot.status).toBe("active"); // the caller still holds this

      let thrown: unknown;
      try {
        await dispatchRenderedRun(deps, dispatchInput(threadKey, { existingSession: snapshot }));
      } catch (error) {
        thrown = error;
      }
      // Permanent, not transient: the caller mints a fresh session.
      expect(isRuntimeApiError(thrown)).toBeTrue();
      expect((thrown as { code: string }).code).toBe("session_not_active");
      // Pre-fix: a run was inserted onto the closed row, its continue sent,
      // and the post-eve status write set the row back to `active`.
      expect(await runsOf(snapshot.id)).toHaveLength(0);
      expect((await sessionRow(snapshot.id)).status).toBe("closed");
    },
    20_000,
  );
});
