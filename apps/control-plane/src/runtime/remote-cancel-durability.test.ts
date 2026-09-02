/**
 * Remote-cancel durability tests (N1, N2) — gated on TEST_DATABASE_URL
 * (skip cleanly when unset; the compose integration stage provides it).
 *
 * The remote leg of a Stop is an OBLIGATION to eve (`runs.remote_cancel_
 * pending_at`), and this file proves it is met or kept — never recorded as
 * met on a guess — against a real Postgres with a fake worker client whose
 * cancel can fail in transport, answer eve's 409, or succeed.
 *
 * N1 — TRANSPORT FAILURES RECORDED AS SUCCESS: a refused connection / DNS
 *      failure / HTTP error before any cancel reached eve still CLEARED the
 *      marker on the no-tail path (the best-effort swallow), and on the
 *      live-tail path a `failed` remote outcome finalized the row WITHOUT
 *      creating one — the accepted eve turn kept running with nobody owing
 *      it. Now the marker is cleared ONLY on a confirmed outcome (eve
 *      acknowledged; eve 409 `session_not_active` = provably terminal; a
 *      newer run provably owns the session; nothing to chase), a transport
 *      failure RETAINS it, and a live-tail `failed` SETS it exactly like
 *      `skipped` — so the chase / sweep / boot reconciliation retry.
 *      This closes the D2/D3 partials in session-lock-recovery.test.ts:
 *      "issued ⇒ cleared" held only when the request succeeded.
 *
 * N2 — LOCK-POOL SATURATION STRANDED A STOP UNTIL RESTART: the "5-minute"
 *      deferred chase gave up after ONE 2 s reserve timeout, and the only
 *      other actor was boot reconciliation. Now (a) the deferred chase backs
 *      off and reserves again across its whole bound, and (b) a PERIODIC
 *      sweep (`createRemoteCancelSweeper`, `REMOTE_CANCEL_SWEEP_MS`) re-runs
 *      reconciliation's sweep 2b in a healthy process — without spawning
 *      background chases of its own, and idempotently under the session
 *      lock (the marker is re-read under the lock before any cancel).
 *
 * G1 — THE LIVE-TAIL OBLIGATION WAS A SECOND STATEMENT: a live-tail Stop
 *      whose remote leg was skipped/failed finalized the row `canceled`
 *      (admission reopened, the session lock released) and only THEN wrote
 *      `remote_cancel_pending_at` — a crash in between left the accepted
 *      turn with no durable obligation. Now the tail's finalizing CAS
 *      carries the marker (runs/tailer.ts `finishRun` →
 *      `RunStatusPatch.remoteCancelPendingAt`), one statement, the no-tail
 *      path's `settleRunCanceledPendingRemote` shape. The proof snapshots
 *      the row the instant the finalize statement returns — the state a
 *      crash there would leave — and finds the marker already on it.
 *
 * G2 — "SUPERSEDED" WAS NOT PROOF: the marker was cleared whenever ANY
 *      queued/running/waiting successor row existed, but a successor
 *      committed `queued` and never armed/sent (a crash) is no evidence the
 *      settled turn ended — another replica's sweep cleared the obligation,
 *      the turn ran on, the successor later failed undispatched. Superseded
 *      now needs a successor that PROVABLY reached eve (routes.ts
 *      `classifySessionSuccessor`: running/waiting, or terminal with
 *      persisted events beyond its first seq); a queued successor RETAINS
 *      the marker and the chase retries, in both the guarded cancel and the
 *      post-eve recheck.
 *
 * Only pre-fix entry points are used (`cancelAgentRun`, the tailer manager,
 * `createDb`, the lock factory, the sweeper, `recheckCanceledDuringEve`),
 * so the N1, N2(a), G1 and G2 cases run verbatim against the pre-fix code
 * and FAIL there — the reversion proof; N2(b)'s sweeper is new surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger, TriggerEvent } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { RunEventBus } from "../runs/bus";
import { createDrizzleRunStore, type RunStore } from "../runs/store";
import { RunTailerManager } from "../runs/tailer";
import { loadRuntimeConfig } from "./config";
import { MetricsRegistry } from "./metrics";
import { recheckCanceledDuringEve } from "./dispatch";
import { agentJwtParams } from "./jwt";
import { createRemoteCancelSweeper, reconcileInterruptedRuns } from "./reconcile";
import { createPgSessionDispatchLocks } from "./session-lock";
import { cancelAgentRun, type RuntimeDeps } from "./routes";
import { EveSessionNotActiveError, type WorkerClient } from "./worker-client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[remote-cancel-durability] skipped: TEST_DATABASE_URL not set");
}

const logger: Logger = createLogger({ sink: () => {}, minLevel: "error" });

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

type CancelMode = "ok" | "transport" | "not_active";

/**
 * Fake eve plane whose cancel can be made to fail the way a real one does:
 * `transport` rejects like a refused connection (nothing reached eve),
 * `not_active` answers eve's 409 (provably terminal), `ok` acknowledges.
 */
class FakeWorkerClient {
  readonly cancelAttempts: Array<{ eveSessionId: string; turnId?: string; mode: CancelMode }> = [];
  cancelMode: CancelMode = "ok";
  streamTurnStarted = false;

  async ensureAgent(): Promise<void> {}
  async cancelEveTurn(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
    options?: { turnId?: string },
  ): Promise<Record<string, never>> {
    const mode = this.cancelMode;
    this.cancelAttempts.push({
      eveSessionId,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      mode,
    });
    if (mode === "transport") {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.9:8080");
    }
    if (mode === "not_active") throw new EveSessionNotActiveError(eveSessionId, "409");
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

describe.skipIf(!GATE)("remote-cancel durability (N1, N2)", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;
  let workerId: string;
  const HASH = "f".repeat(64);
  const fakeWorker = new FakeWorkerClient();
  let runStore: RunStore;
  let deps: RuntimeDeps;
  let liveDeps: RuntimeDeps;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 6, lockMax: 8 });
    const db = handle.db;
    orgId = `org-rcd-${randomUUID()}`;
    userId = `user-rcd-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Remote Cancel Durability Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "rcd",
      email: `${userId}@example.test`,
    });
    const agents = await db
      .insert(schema.agents)
      .values({ organizationId: orgId, name: "Remote Cancel Agent", runAsUserId: userId, draft: {} })
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
      PLATFORM_JWT_SECRET: "rcd-platform-jwt-secret-0000000000",
      WORKER_SHARED_SECRET: "rcd-worker-shared-secret-000000000",
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
          artifactKey: "artifacts/rcd",
          errorLog: null,
        }),
      },
      workerClient: fakeWorker as unknown as WorkerClient,
      runStore,
      bus,
      tailers: {
        start: () => {},
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

  async function freshHeartbeat() {
    await handle.db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));
  }

  const attemptsFor = (eveId: string) =>
    fakeWorker.cancelAttempts.filter((c) => c.eveSessionId === eveId);
  const acknowledgedFor = (eveId: string) => attemptsFor(eveId).filter((c) => c.mode === "ok");

  /** Start a live tail on `run` whose remote cancel rides the fake plane. */
  function startLiveTail(run: { id: string }, session: { id: string; eveSessionId: string | null }) {
    liveDeps.tailers.start({
      runId: run.id,
      agentSessionId: session.id,
      openStream: (startIndex, signal) =>
        fakeWorker.openEventStream("", HASH, "", session.eveSessionId!, startIndex, signal),
      cancelRemoteTurn: async (options) => {
        await fakeWorker.cancelEveTurn("", HASH, "", session.eveSessionId!, options);
      },
    });
  }

  // ── N1 ────────────────────────────────────────────────────────────────────

  test("N1 — a no-tail Stop whose remote cancel FAILS in transport keeps the obligation on the row; the periodic sweep finishes it once eve is reachable", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    fakeWorker.cancelMode = "transport";
    try {
      await cancelAgentRun(deps, run, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled"); // the user's Stop is never held behind eve
      // The cancel was ATTEMPTED and provably did not reach eve…
      expect(attemptsFor(session.eveSessionId!)).toHaveLength(1);
      // …so the obligation is RETAINED (pre-fix: cleared — recorded as done).
      expect(settled.remoteCancelPendingAt).not.toBeNull();
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    // eve becomes reachable; the periodic sweep (defer: false — the tick IS
    // the retry) chases it under the session lock and clears the marker.
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome).not.toBeNull();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
    expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("N1 — boot reconciliation RETAINS a marker whose chase fails in transport (counted `retained`, never cleared on a guess)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    fakeWorker.cancelMode = "transport";
    try {
      const outcome = await reconcileInterruptedRuns(deps);
      expect(outcome.remoteCancels.retained).toBeGreaterThanOrEqual(1);
      expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    const outcome = await reconcileInterruptedRuns(deps);
    expect(outcome.remoteCancels.settled).toBeGreaterThanOrEqual(1);
    expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("N1 — eve's 409 session_not_active is a CONFIRMED terminal outcome: the obligation clears without retention", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    fakeWorker.cancelMode = "not_active";
    try {
      await cancelAgentRun(deps, run, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      expect(attemptsFor(session.eveSessionId!)).toHaveLength(1);
      expect(settled.remoteCancelPendingAt).toBeNull(); // terminal ⇒ met
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("N1 — a LIVE-tail Stop whose awaited remote cancel FAILS sets the obligation exactly like `skipped` (pre-fix: finalized as if issued, no marker), and the sweep finishes it", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    fakeWorker.streamTurnStarted = true; // qualified cancel — the transport still fails
    startLiveTail(run, session);
    await until(
      async () =>
        (await handle.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, run.id)))
          .length > 0
          ? true
          : undefined,
      "the tail to consume turn.started",
    );
    fakeWorker.streamTurnStarted = false;

    fakeWorker.cancelMode = "transport";
    try {
      await cancelAgentRun(liveDeps, { id: run.id, status: "running" }, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      // The tail's awaited cancel was attempted (qualified) and failed; the
      // guarded chase then attempted again (unqualified, under the lock) and
      // failed too — nothing reached eve.
      expect(attemptsFor(session.eveSessionId!).length).toBeGreaterThanOrEqual(1);
      expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(0);
      expect(settled.remoteCancelPendingAt).not.toBeNull();
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
    expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── N2 ────────────────────────────────────────────────────────────────────

  test("N2(a) — a Stop landing on a SATURATED session lock pool keeps its obligation, and the deferred chase genuinely retries across its bound: the cancel lands once the pool frees, without a restart", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    // A deps whose LOCK pool has exactly one connection — pinned by the test,
    // so every reserve times out until it is released.
    const starved = createDb(TEST_DATABASE_URL!, { max: 3, lockMax: 1 });
    const pinned = await starved.lockSql.reserve();
    const starvedDeps = { ...deps, db: starved.db } as RuntimeDeps;
    try {
      await cancelAgentRun(starvedDeps, run, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      expect(settled.remoteCancelPendingAt).not.toBeNull();
      expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
      // Keep the pool pinned PAST one full reserve timeout of the background
      // chase (2 s each): pre-fix the chase gave up after that single
      // timeout (`run.cancel_remote_abandoned`) and the marker stayed until
      // a restart. Post-fix it backs off and reserves again.
      await Bun.sleep(5_000);
      pinned.release();
      await until(
        () => (acknowledgedFor(session.eveSessionId!).length > 0 ? true : undefined),
        "the deferred chase to issue the cancel after the pool freed",
        15_000,
      );
      await until(
        async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
        "the obligation to clear",
      );
    } finally {
      await starved.close();
    }
    await runStore.markSession(session.id, "closed");
  }, 40_000);

  test("N2(b) — with the Stop's lock pool STILL saturated, the periodic sweep (its own pool) issues the cancel; the late chase then finds the marker cleared under the lock and sends nothing", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    const starved = createDb(TEST_DATABASE_URL!, { max: 3, lockMax: 1 });
    const pinned = await starved.lockSql.reserve();
    const starvedDeps = { ...deps, db: starved.db } as RuntimeDeps;
    try {
      await cancelAgentRun(starvedDeps, run, session, "stopped by user");
      expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();
      expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);

      // The healthy process's sweep tick — invoked directly — finishes it.
      const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
      const outcome = await sweeper.tick();
      expect(outcome).not.toBeNull();
      expect(outcome!.settled).toBeGreaterThanOrEqual(1);
      expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
      expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();

      // The starved chase is still retrying in the background; once its
      // pool frees it takes the lock, re-reads the obligation, finds it met
      // and sends NOTHING — no duplicate cancel.
      pinned.release();
      await Bun.sleep(3_500);
      expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
    } finally {
      await starved.close();
    }
    await runStore.markSession(session.id, "closed");
  }, 30_000);

  test("N2(b) — the sweep never fans out background chases: a held session lock counts `deferred` and is simply retried on the next tick", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const held = await createPgSessionDispatchLocks(handle.lockSql).acquire(session.id);
    expect(held).not.toBeNull();
    try {
      const outcome = await sweeper.tick();
      expect(outcome!.deferred).toBeGreaterThanOrEqual(1);
    } finally {
      await held!.release();
    }
    // No chase was spawned: nothing lands on its own after the release.
    await Bun.sleep(1_000);
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();
    // The next tick is the retry.
    const next = await sweeper.tick();
    expect(next!.settled).toBeGreaterThanOrEqual(1);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
    expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── G1 ────────────────────────────────────────────────────────────────────

  /**
   * A tailer manager whose store SNAPSHOTS the run row the instant the
   * tail's finalizing `markRun` statement returns — before control goes back
   * to the tail, let alone to the cancel route. That snapshot is exactly
   * what a crash at that instant would leave behind.
   */
  type Snapshot = {
    row: Awaited<ReturnType<typeof runRow>>;
    /** The fake plane's cancel log as it stood at that instant (a copy). */
    attempts: FakeWorkerClient["cancelAttempts"];
  };
  function snapshotDeps(): { deps: RuntimeDeps; captured: Map<string, Snapshot> } {
    const captured = new Map<string, Snapshot>();
    const store: RunStore = {
      ...runStore,
      async markRun(runId, patch) {
        const marked = await runStore.markRun(runId, patch);
        if (marked && patch.status === "canceled") {
          captured.set(runId, {
            row: await runRow(runId),
            attempts: fakeWorker.cancelAttempts.slice(),
          });
        }
        return marked;
      },
    };
    const tailers = new RunTailerManager({ store, bus: deps.bus, maxWallClockMs: 60_000, logger });
    return { deps: { ...deps, runStore: store, tailers } as RuntimeDeps, captured };
  }

  function startLiveTailOn(
    target: RuntimeDeps,
    run: { id: string },
    session: { id: string; eveSessionId: string | null },
  ) {
    target.tailers.start({
      runId: run.id,
      agentSessionId: session.id,
      openStream: (startIndex, signal) =>
        fakeWorker.openEventStream("", HASH, "", session.eveSessionId!, startIndex, signal),
      cancelRemoteTurn: async (options) => {
        await fakeWorker.cancelEveTurn("", HASH, "", session.eveSessionId!, options);
      },
    });
  }

  test("G1 — a live-tail Stop whose remote leg is SKIPPED (no lock, unqualified) finalizes the row WITH its obligation in the SAME statement: the instant the row reads canceled, the marker is on it", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    const { deps: snapDeps, captured } = snapshotDeps();
    fakeWorker.streamTurnStarted = false; // no turn observed ⇒ unqualified
    startLiveTailOn(snapDeps, run, session);
    await until(
      async () => ((await runRow(run.id)).status === "running" ? true : undefined),
      "the tail to adopt the run",
    );
    const held = await createPgSessionDispatchLocks(handle.lockSql).acquire(session.id);
    expect(held).not.toBeNull();
    try {
      await cancelAgentRun(snapDeps, { id: run.id, status: "running" }, session, "stopped by user");
    } finally {
      await held!.release();
    }
    const snapshot = captured.get(run.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.row.status).toBe("canceled");
    // Nothing had reached eve when the row was finalized…
    expect(snapshot!.attempts.filter((c) => c.eveSessionId === session.eveSessionId)).toHaveLength(0);
    // …and the obligation was ALREADY on it (pre-fix: null here — it was
    // written by a second UPDATE after the tail finalized and the route
    // resumed; a crash in between left no owner for the accepted turn).
    expect(snapshot!.row.remoteCancelPendingAt).not.toBeNull();
    expect(snapshot!.row.remoteCancelPendingAt).toEqual(snapshot!.row.completedAt);
    // The deferred chase finishes it once the lock frees.
    await until(
      () => (acknowledgedFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the deferred remote cancel",
    );
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("G1 — a live-tail Stop whose awaited remote cancel FAILS in transport finalizes the row WITH its obligation in the SAME statement", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    const { deps: snapDeps, captured } = snapshotDeps();
    fakeWorker.streamTurnStarted = true; // qualified — the transport still fails
    startLiveTailOn(snapDeps, run, session);
    await until(
      async () =>
        (await handle.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, run.id)))
          .length > 0
          ? true
          : undefined,
      "the tail to consume turn.started",
    );
    fakeWorker.streamTurnStarted = false;
    fakeWorker.cancelMode = "transport";
    try {
      await cancelAgentRun(snapDeps, { id: run.id, status: "running" }, session, "stopped by user");
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    const snapshot = captured.get(run.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.row.status).toBe("canceled");
    // The awaited cancel was attempted (and provably failed) BEFORE the
    // finalize — and the finalize itself carried the obligation.
    expect(snapshot!.attempts.filter((c) => c.eveSessionId === session.eveSessionId)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_observed", mode: "transport" },
    ]);
    expect(snapshot!.row.remoteCancelPendingAt).not.toBeNull();
    expect(snapshot!.row.remoteCancelPendingAt).toEqual(snapshot!.row.completedAt);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(0);
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1);
    expect((await runRow(run.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── G2 ────────────────────────────────────────────────────────────────────

  test("G2 — a QUEUED successor is no proof: the sweep RETAINS the marker and sends nothing; once the successor is RUNNING, superseded is proven and the marker clears without a cancel", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const settled = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    // The crash residue: a successor committed `queued`, never armed/sent.
    const successor = await insertRun(session.id, { status: "queued", startedAt: null });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    let outcome = await sweeper.tick();
    expect(outcome!.retained).toBeGreaterThanOrEqual(1);
    // Pre-fix: settled + cleared here, on no evidence — and no cancel ever
    // sent, so the settled turn ran on with nobody owing it.
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    // The chase retries: still queued ⇒ still retained.
    outcome = await sweeper.tick();
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    // The successor reaches eve (its tail started ⇒ `running`): PROOF.
    await runStore.markRun(successor.id, { status: "running", startedAt: new Date() });
    outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect((await runRow(settled.id)).remoteCancelPendingAt).toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0); // superseded, never cancelled
    await runStore.markRun(successor.id, { status: "canceled", error: "test cleanup", completedAt: new Date() });
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("G2 — the successor instead FAILS undispatched after the crash: no live successor remains, so the settled run's cancel is ISSUED on the next chase", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const settled = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const successor = await insertRun(session.id, { status: "queued", startedAt: null });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    expect((await sweeper.tick())!.retained).toBeGreaterThanOrEqual(1);
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    // Boot reconciliation fails the marker-null row ("dispatch never reached
    // the agent") — it has no persisted events, so it is no evidence either.
    await runStore.markRun(successor.id, {
      status: "failed",
      error: "control plane restarted before the run's message was sent",
      completedAt: new Date(),
    });
    const outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect(acknowledgedFor(session.eveSessionId!)).toHaveLength(1); // the chase proceeded
    expect((await runRow(settled.id)).remoteCancelPendingAt).toBeNull();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("G2 — a TERMINAL successor counts as proof only with persisted events beyond its first seq (its tail observed eve); an event-less one does not", async () => {
    await freshHeartbeat();
    // (a) evidenced: the successor ran and completed — superseded.
    const evidenced = await insertSession();
    const evidencedSettled = await insertRun(evidenced.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const evidencedSuccessor = await insertRun(evidenced.id, {
      status: "succeeded",
      completedAt: new Date(),
    });
    await runStore.appendEvent(evidencedSuccessor.id, 0, {
      type: "turn.started",
      data: { sequence: 0, turnId: "turn_b" },
    } as never);
    await runStore.appendEvent(evidencedSuccessor.id, 1, {
      type: "turn.completed",
      data: { sequence: 0, turnId: "turn_b" },
    } as never);
    // (b) a terminal successor with NO events (failed before eve) — chase.
    const bare = await insertSession();
    const bareSettled = await insertRun(bare.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    await insertRun(bare.id, { status: "failed", completedAt: new Date() });
    // (c) a PREDECESSOR that ran to completion says nothing — chase.
    const older = await insertSession();
    const predecessor = await insertRun(older.id, {
      status: "succeeded",
      completedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 60_000),
    });
    await runStore.appendEvent(predecessor.id, 0, { type: "turn.started", data: { sequence: 0, turnId: "turn_p" } } as never);
    await runStore.appendEvent(predecessor.id, 1, { type: "turn.completed", data: { sequence: 0, turnId: "turn_p" } } as never);
    const olderSettled = await insertRun(older.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });

    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(3);
    expect(attemptsFor(evidenced.eveSessionId!)).toHaveLength(0);
    expect((await runRow(evidencedSettled.id)).remoteCancelPendingAt).toBeNull();
    expect(acknowledgedFor(bare.eveSessionId!)).toHaveLength(1);
    expect((await runRow(bareSettled.id)).remoteCancelPendingAt).toBeNull();
    expect(acknowledgedFor(older.eveSessionId!)).toHaveLength(1);
    expect((await runRow(olderSettled.id)).remoteCancelPendingAt).toBeNull();
    for (const s of [evidenced, bare, older]) await runStore.markSession(s.id, "closed");
  }, 20_000);

  test("G2 — the post-eve recheck WITHHOLDS its unqualified cancel behind a queued successor (`deferred`, marker kept) and skips only behind a PROVEN one (`superseded`)", async () => {
    await freshHeartbeat();
    const jwt = agentJwtParams(deps.runtime.platformJwtSecret, HASH);
    const targetFor = (eveSessionId: string) => ({
      workerAddress: "http://127.0.0.1:1",
      hash: HASH,
      jwt,
      eveSessionId,
    });

    // (a) queued successor: withheld + obligation durable.
    const session = await insertSession();
    const settled = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      // Settled by an actor that left NO marker — the recheck re-asserts it.
      remoteCancelPendingAt: null,
    });
    const successor = await insertRun(session.id, { status: "queued", startedAt: null });
    expect(
      await recheckCanceledDuringEve(deps, settled.id, session.id, targetFor(session.eveSessionId!)),
    ).toBe("deferred");
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();

    // (b) the successor is running: proof ⇒ superseded, no cancel.
    await runStore.markRun(successor.id, { status: "running", startedAt: new Date() });
    expect(
      await recheckCanceledDuringEve(deps, settled.id, session.id, targetFor(session.eveSessionId!)),
    ).toBe("superseded");
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);

    // (c) no successor at all: the accepted turn is cancelled right here.
    const alone = await insertSession();
    const aloneSettled = await insertRun(alone.id, { status: "canceled", completedAt: new Date() });
    expect(
      await recheckCanceledDuringEve(deps, aloneSettled.id, alone.id, targetFor(alone.eveSessionId!)),
    ).toBe("canceled");
    expect(acknowledgedFor(alone.eveSessionId!)).toHaveLength(1);

    // (d) a live run is simply live.
    const live = await insertRun(alone.id, { status: "running" });
    expect(
      await recheckCanceledDuringEve(deps, live.id, alone.id, targetFor(alone.eveSessionId!)),
    ).toBe("live");

    await runStore.markRun(successor.id, { status: "canceled", error: "test cleanup", completedAt: new Date() });
    await runStore.markRun(live.id, { status: "canceled", error: "test cleanup", completedAt: new Date() });
    await runStore.markSession(session.id, "closed");
    await runStore.markSession(alone.id, "closed");
  }, 20_000);
});
