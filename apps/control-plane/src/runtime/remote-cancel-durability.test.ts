/**
 * Remote-cancel durability tests — gated on TEST_DATABASE_URL (skip cleanly
 * when unset; the compose integration stage provides it).
 *
 * The remote leg of a Stop is an OBLIGATION to eve (`runs.remote_cancel_
 * pending_at`) that is met ONLY by eve's OWN evidence. This file proves the
 * doctrine against a real Postgres, a real RunTailerManager, and a fake
 * worker plane whose eve stream is driven by the test:
 *
 * P1 — THE PRE-TURN 202 (review scenario 2): a Stop landing before eve
 *      started the turn used to fire an unqualified `{}` cancel, take eve's
 *      202 (which consumes such a cancel as a no-op) as "issued", finalize
 *      the row with NO marker, and let the turn run to completion unobserved.
 *      Now nothing is sent pre-turn, the row finalizes WITH the obligation,
 *      the tail stays on the stream, attributes its own `turn.started`, issues
 *      the turn-QUALIFIED cancel, and clears the obligation on `turn.cancelled`.
 *
 * P2 — SYNTHESIZED SUPERSESSION (review scenario 1): "superseded" used to be
 *      inferred from a successor's `running` status (synthesized by
 *      reconciliation re-tailing an unsent continuation) or from persisted
 *      `run_events` beyond seq 0 (a predecessor's drained leftovers). Now
 *      only a NEWER run whose `turn_id` is set — written when a tail observed
 *      that run's own `turn.started` — proves eve moved on; both old signals
 *      are asserted NOT to clear the marker.
 *
 * P3 — CRASH RECOVERY: a Stop whose observation died with the process is
 *      re-opened by the periodic sweep from the run's persisted seq (the same
 *      primitive), issues the qualified cancel, and clears on the boundary.
 *
 * P4 — THE HONEST RESIDUAL: an obligation past `REMOTE_CANCEL_OBSERVE_MS`
 *      with no confirmation is declared UNRESOLVED (`remote_cancel_unresolved_at`
 *      set, marker KEPT, warn logged) — by the live observation's clock and
 *      by the sweep's age check — never silently cleared.
 *
 * P5 — SESSION-TERMINAL ANSWERS: eve's 409 `session_not_active` / 200
 *      `no_active_turn` on the cancel, and the send/control routes' dead-
 *      session renderings, clear the obligation (nothing can be running).
 *
 * P6 — EVIDENCE ALREADY ON DISK: a never-sent run (marker null) and a parked
 *      run whose own turn boundary its tail persisted owe nothing; an armed
 *      eveless session retains; a closed eveless session settles.
 *
 * P7 — THE POST-EVE RECHECK hands a canceled dispatch to observation (marker
 *      set, no unqualified cancel), skips only behind a proven successor, and
 *      does NOT treat a synthesized `running` successor as proof.
 *
 * G1 — THE OBLIGATION RIDES THE FINALIZING CAS: a snapshot of the row the
 *      instant the tail's finalize returns already carries the marker.
 *
 * N2 — LOCK-POOL SATURATION: a Stop landing on a saturated session lock pool
 *      keeps its obligation and the deferred settlement genuinely retries
 *      across its bound (opening observation once the pool frees); the
 *      periodic sweep never fans out background waits.
 *
 * A1–A5 — ATTRIBUTION BY CONTENT (the round-11 defects): a turn is attributed
 *      by matching `runs.message_hash` against its `message.received`, never
 *      by send order. A1: a never-sent canceled run A cannot claim successor
 *      B's turn (different text) — no cancel ever hits B. A2: an UNRESOLVED
 *      obligation stays attributable — A's late turn clears both columns, B
 *      is untouched. A3: a clear/compact/reset while an observation tail is
 *      on the session is `session_busy` — one reader per stream, never a
 *      second drain. A4: `reset` (and `no_active_session` on it) is
 *      session-terminal evidence and settles every obligation on the row.
 *      A5: the wall-clock cap settles `failed` WITH the obligation and sends
 *      no unqualified cancel.
 *
 * Reversion proof: P1 and P2 use only pre-fix entry points (`cancelAgentRun`,
 * the tailer manager, `createRemoteCancelSweeper`, `recheckCanceledDuringEve`)
 * and FAIL verbatim against the pre-fix code — P1 on the marker-less finalize
 * and the unqualified `{}` cancel, P2 on the marker cleared behind a
 * `running`/evidenced successor that never reached eve.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger, StructuredLogEvent, TriggerEvent } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { RunEventBus } from "../runs/bus";
import { hashTurnMessage } from "../runs/message-hash";
import { createDrizzleRunStore, type RunStore } from "../runs/store";
import { RunTailerManager } from "../runs/tailer";
import { loadRuntimeConfig } from "./config";
import { MetricsRegistry } from "./metrics";
import { recheckCanceledDuringEve } from "./dispatch";
import { agentJwtParams } from "./jwt";
import { createRemoteCancelSweeper, reconcileInterruptedRuns } from "./reconcile";
import { createPgSessionDispatchLocks } from "./session-lock";
import { isRuntimeApiError } from "./errors";
import {
  cancelAgentRun,
  requireQuietControllableSession,
  resetSession,
  settleSessionRemoteCancelsTerminal,
  startTail,
  type RuntimeDeps,
} from "./routes";
import { EveSessionNotActiveError, type WorkerClient } from "./worker-client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[remote-cancel-durability] skipped: TEST_DATABASE_URL not set");
}

const logged: StructuredLogEvent[] = [];
const logger: Logger = createLogger({
  sink: (event) => {
    logged.push(event);
  },
  minLevel: "debug",
});
const warnedEvents = () => logged.filter((e) => e.level === "warn").map((e) => e.event);

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

type CancelMode = "ok" | "transport" | "not_active" | "no_active_turn";
type ResetMode = "reset" | "no_active_session";

/** The message the harness's runs are armed with — the correlator every fake turn echoes. */
const TASK = "durability probe";
const turnStarted = (turnId: string) => ({ type: "turn.started", data: { sequence: 0, turnId } });
/** eve's echo of the message that opened the turn — the tail's correlator. */
const messageReceived = (turnId: string, message = TASK) => ({
  type: "message.received",
  data: { message, parts: [{ type: "text", text: message }], sequence: 0, turnId },
});
const turnCompleted = (turnId: string) => ({ type: "turn.completed", data: { sequence: 0, turnId } });
const turnCancelled = (turnId: string) => ({ type: "turn.cancelled", data: { sequence: 0, turnId } });
const sessionWaiting = () => ({ type: "session.waiting", data: { wait: "next-user-message" } });

/**
 * Fake eve plane: a per-session NDJSON stream the TEST drives (events pushed
 * before a connect are delivered on it; later pushes stream live; an abort
 * errors the connection and later pushes wait for the next one), and a
 * cancel that can fail the way a real one does — `transport` rejects like a
 * refused connection (nothing reached eve), `not_active` answers eve's 409,
 * `no_active_turn` eve's 200 dead-session rendering, `ok` a plain 202.
 */
class FakeWorkerClient {
  readonly cancelAttempts: Array<{ eveSessionId: string; turnId?: string; mode: CancelMode }> = [];
  readonly opens: Array<{ eveSessionId: string; startIndex: number }> = [];
  cancelMode: CancelMode = "ok";
  resetMode: ResetMode = "reset";
  readonly resets: string[] = [];
  private readonly streams = new Map<
    string,
    { controller: ReadableStreamDefaultController<Uint8Array> | null; backlog: string[] }
  >();

  private stream(eveSessionId: string) {
    let entry = this.streams.get(eveSessionId);
    if (!entry) {
      entry = { controller: null, backlog: [] };
      this.streams.set(eveSessionId, entry);
    }
    return entry;
  }

  push(eveSessionId: string, event: object): void {
    const entry = this.stream(eveSessionId);
    const line = JSON.stringify(event);
    if (!entry.controller) {
      entry.backlog.push(line);
      return;
    }
    try {
      entry.controller.enqueue(new TextEncoder().encode(`${line}\n`));
    } catch {
      entry.backlog.push(line);
    }
  }

  async ensureAgent(): Promise<void> {}
  async resetEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
  ): Promise<
    | { ok: true; status: "reset"; previousSessionId: string }
    | { ok: true; status: "no_active_session" }
  > {
    this.resets.push(eveSessionId);
    return this.resetMode === "reset"
      ? { ok: true, status: "reset", previousSessionId: eveSessionId }
      : { ok: true, status: "no_active_session" };
  }
  async cancelEveTurn(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
    options?: { turnId?: string },
  ): Promise<{ ok: true; status: "accepted" | "no_active_turn" }> {
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
    if (mode === "no_active_turn") return { ok: true, status: "no_active_turn" };
    return { ok: true, status: "accepted" };
  }
  async openEventStream(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
    startIndex: number,
    signal: AbortSignal,
  ): Promise<Response> {
    if (signal.aborted) throw new Error("aborted before connect");
    this.opens.push({ eveSessionId, startIndex });
    const entry = this.stream(eveSessionId);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry.controller = controller;
        for (const line of entry.backlog.splice(0)) controller.enqueue(encoder.encode(`${line}\n`));
        signal.addEventListener(
          "abort",
          () => {
            if (entry.controller === controller) entry.controller = null;
            try {
              controller.error(new Error("aborted"));
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

describe.skipIf(!GATE)("remote-cancel durability (P1–P7, G1, N2)", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;
  let workerId: string;
  // Not `"f".repeat(64)`: connection-token-route.test.ts mints a JWT for that
  // "ghost" hash expecting NO version row, and a crashed run of this suite
  // would otherwise leave one behind.
  const HASH = "a5".repeat(32);
  const WORKER_ADDRESS = "http://127.0.0.1:1";
  const fakeWorker = new FakeWorkerClient();
  let runStore: RunStore;
  let deps: RuntimeDeps;

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
      .values({ address: WORKER_ADDRESS, status: "live", lastHeartbeatAt: new Date(), capacity: {} })
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
      REMOTE_CANCEL_OBSERVE_MS: "60000",
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
      tailers: new RunTailerManager({
        store: runStore,
        bus,
        maxWallClockMs: 60_000,
        remoteCancelObserveMs: runtime.remoteCancelObserveMs,
        logger,
      }),
      metrics: new MetricsRegistry(),
      logger,
    } as unknown as RuntimeDeps;
  }, 30_000);

  afterAll(async () => {
    await deps?.tailers.stopAll();
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
        // The send's correlator (the dispatch-attempt CAS writes it): the
        // tail attributes a turn by matching this against the turn's
        // `message.received`, never by send order.
        messageHash: hashTurnMessage(TASK),
        ...over,
      })
      .returning();
    return rows[0]!;
  }

  /** eve opens a turn: `turn.started` then its `message.received` correlator. */
  function openTurn(eveSessionId: string, turnId: string, message = TASK) {
    fakeWorker.push(eveSessionId, turnStarted(turnId));
    fakeWorker.push(eveSessionId, messageReceived(turnId, message));
  }

  async function sessionRow(id: string) {
    const rows = await handle.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, id));
    return rows[0]!;
  }

  async function runRow(id: string) {
    const rows = await handle.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    return rows[0]!;
  }

  async function runEvents(id: string) {
    return handle.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, id));
  }

  async function freshHeartbeat() {
    await handle.db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));
  }

  const attemptsFor = (eveId: string) =>
    fakeWorker.cancelAttempts.filter((c) => c.eveSessionId === eveId);

  /** Start a live tail on `run` through the real wiring (routes.ts startTail). */
  function startLiveTail(run: { id: string }, session: { id: string; eveSessionId: string | null }) {
    startTail(deps, WORKER_ADDRESS, HASH, session.eveSessionId!, run.id, session.id);
  }

  async function untilObserving(runId: string) {
    await until(
      () => (deps.tailers.get(runId)?.observing ? true : undefined),
      `an observation tail for ${runId}`,
    );
  }

  /** Hygiene: end any tail this test left on the session. */
  async function endTail(runId: string) {
    await deps.tailers.detach(runId);
  }

  // ── A1–A5: attribution by content ──────────────────────────────────────────

  test("A1 — a never-sent canceled run cannot steal a successor's turn: B's message.received attributes to B only, A never claims it, no cancel hits B (pre-fix: A, the oldest open obligation, claimed B's turn.started and a qualified cancel killed B's turn)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    // A: armed, then canceled; its send failed/crashed before eve.
    const a = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
      messageHash: hashTurnMessage("alpha"),
    });
    // B: sent DIFFERENT text on the same session.
    const b = await insertRun(session.id, { messageHash: hashTurnMessage("beta") });
    startLiveTail(b, session);
    await until(
      async () => ((await runRow(b.id)).status === "running" ? true : undefined),
      "B's tail to adopt the run",
    );
    openTurn(session.eveSessionId!, "turn_b", "beta");
    await until(
      async () => ((await runRow(b.id)).turnId === "turn_b" ? true : undefined),
      "B's own turn, attributed by content",
    );
    expect((await runRow(a.id)).turnId).toBeNull(); // pre-fix: "turn_b"
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0); // pre-fix: [{turnId: "turn_b"}]
    // A newer run's proven turn supersedes A: nothing owed, nothing cancelled.
    expect((await runRow(a.id)).remoteCancelPendingAt).toBeNull();
    fakeWorker.push(session.eveSessionId!, turnCompleted("turn_b"));
    fakeWorker.push(session.eveSessionId!, sessionWaiting());
    await until(
      async () => ((await runRow(b.id)).status === "succeeded" ? true : undefined),
      "B to succeed",
    );
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("A2 — an UNRESOLVED obligation stays attributable: A's late turn (matching content) is attributed to A, cancelled qualified, and clears BOTH columns; B is untouched (pre-fix: unresolved rows were excluded, so B claimed A's turn as its own)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const a = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(Date.now() - 120_000),
      remoteCancelPendingAt: new Date(Date.now() - 120_000),
      remoteCancelUnresolvedAt: new Date(Date.now() - 1_000),
      messageHash: hashTurnMessage("alpha"),
    });
    const b = await insertRun(session.id, { messageHash: hashTurnMessage("beta") });
    startLiveTail(b, session);
    await until(
      async () => ((await runRow(b.id)).status === "running" ? true : undefined),
      "B's tail to adopt the run",
    );
    // A's turn arrives late, before B's.
    openTurn(session.eveSessionId!, "turn_a", "alpha");
    await until(
      () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "A's qualified cancel",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_a", mode: "ok" },
    ]);
    expect((await runRow(a.id)).turnId).toBe("turn_a");
    expect((await runRow(b.id)).turnId).toBeNull(); // pre-fix: "turn_a"
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_a"));
    await until(
      async () => ((await runRow(a.id)).remoteCancelPendingAt === null ? true : undefined),
      "A's obligation to clear on its boundary",
    );
    const resolved = await runRow(a.id);
    expect(resolved.remoteCancelUnresolvedAt).toBeNull(); // both columns
    fakeWorker.push(session.eveSessionId!, sessionWaiting());
    openTurn(session.eveSessionId!, "turn_b", "beta");
    await until(
      async () => ((await runRow(b.id)).turnId === "turn_b" ? true : undefined),
      "B's own turn",
    );
    fakeWorker.push(session.eveSessionId!, turnCompleted("turn_b"));
    fakeWorker.push(session.eveSessionId!, sessionWaiting());
    await until(
      async () => ((await runRow(b.id)).status === "succeeded" ? true : undefined),
      "B to succeed",
    );
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(1); // B was never cancelled
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("A3 — a context control while an OBSERVATION tail is on the session is `session_busy` (one reader per stream — the drain never opens a second one), and quiet again once the observation ends", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    startLiveTail(run, session);
    await until(
      async () => ((await runRow(run.id)).status === "running" ? true : undefined),
      "the tail to adopt the run",
    );
    await cancelAgentRun(deps, { id: run.id, status: "running" }, session, "stopped by user");
    expect(deps.tailers.get(run.id)?.observing).toBeTrue();
    // The ledger reads quiet (the row is canceled) — the observation does not.
    const opensBefore = fakeWorker.opens.filter((o) => o.eveSessionId === session.eveSessionId).length;
    let thrown: unknown;
    try {
      await requireQuietControllableSession(deps, await sessionRow(session.id));
    } catch (error) {
      thrown = error;
    }
    expect(isRuntimeApiError(thrown) && thrown.code === "session_busy").toBeTrue();
    // Exactly one reader on the stream: no drain opened a second cursor.
    expect(fakeWorker.opens.filter((o) => o.eveSessionId === session.eveSessionId)).toHaveLength(
      opensBefore,
    );
    expect(opensBefore).toBe(1);
    // The observation ends on eve's own confirmation — then the session is quiet.
    openTurn(session.eveSessionId!, "turn_q");
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_q"));
    await until(() => (deps.tailers.get(run.id) ? undefined : true), "the observation to close");
    expect(await requireQuietControllableSession(deps, await sessionRow(session.id))).toBe(
      session.eveSessionId!,
    );
    // Every persisted (run_id, seq) is unique — the single reader wrote each once.
    const seqs = (await runEvents(run.id)).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("A4 — reset RETIRES the eve id: every obligation on the row (unresolved ones included) is settled as session-terminal, the row is closed, a replacement is minted; `no_active_session` on reset settles the same way without a replacement", async () => {
    await freshHeartbeat();
    for (const mode of ["reset", "no_active_session"] as const) {
      const session = await insertSession();
      const pending = await insertRun(session.id, {
        status: "canceled",
        completedAt: new Date(),
        remoteCancelPendingAt: new Date(),
      });
      const unresolved = await insertRun(session.id, {
        status: "canceled",
        completedAt: new Date(),
        remoteCancelPendingAt: new Date(Date.now() - 120_000),
        remoteCancelUnresolvedAt: new Date(),
      });
      fakeWorker.resetMode = mode;
      let result;
      try {
        result = await resetSession(deps, await sessionRow(session.id), {});
      } finally {
        fakeWorker.resetMode = "reset";
      }
      expect(fakeWorker.resets).toContain(session.eveSessionId!);
      expect(result.status).toBe(mode);
      expect((await sessionRow(session.id)).status).toBe("closed");
      for (const run of [pending, unresolved]) {
        const after = await runRow(run.id);
        expect(after.remoteCancelPendingAt).toBeNull(); // pre-fix: kept, rode the sweeper against a retired id
        expect(after.remoteCancelUnresolvedAt).toBeNull();
      }
      if (mode === "reset") {
        expect(result.status === "reset" && result.session.eveSessionId).toBeNull();
        expect(result.status === "reset" && result.session.status).toBe("active");
      }
    }
  }, 20_000);

  test("A5 — the wall-clock cap settles `failed` WITH the obligation and sends no unqualified cancel; the turn's late start is attributed by content, cancelled QUALIFIED, and the boundary clears it (pre-fix: an unqualified `{}` cancel and a failed row owing nothing)", async () => {
    await freshHeartbeat();
    const capped = {
      ...deps,
      tailers: new RunTailerManager({
        store: runStore,
        bus: deps.bus,
        maxWallClockMs: 150,
        remoteCancelObserveMs: deps.runtime.remoteCancelObserveMs,
        logger,
      }),
    } as RuntimeDeps;
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    startTail(capped, WORKER_ADDRESS, HASH, session.eveSessionId!, run.id, session.id);
    await until(
      async () => ((await runRow(run.id)).status === "failed" ? true : undefined),
      "the cap to settle the row",
      5_000,
    );
    const failed = await runRow(run.id);
    expect(failed.error).toContain("wall-clock cap");
    expect(failed.remoteCancelPendingAt).not.toBeNull(); // pre-fix: null
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0); // pre-fix: one `{}` cancel
    expect(capped.tailers.get(run.id)?.observing).toBeTrue();
    openTurn(session.eveSessionId!, "turn_cap");
    await until(
      () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the qualified cancel",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_cap", mode: "ok" },
    ]);
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_cap"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await until(() => (capped.tailers.get(run.id) ? undefined : true), "the observation to close");
    expect((await runRow(run.id)).status).toBe("failed"); // never re-marked
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── P1 ────────────────────────────────────────────────────────────────────

  test("P1 — a Stop BEFORE eve started the turn sends nothing, keeps the obligation, then cancels its own turn QUALIFIED once it starts and clears on turn.cancelled (pre-fix: an unqualified `{}` cancel, eve's 202 taken as issued, no marker, the turn ran on unobserved)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    startLiveTail(run, session);
    await until(
      async () => ((await runRow(run.id)).status === "running" ? true : undefined),
      "the tail to adopt the run",
    );

    await cancelAgentRun(deps, { id: run.id, status: "running" }, session, "stopped by user");
    const settled = await runRow(run.id);
    expect(settled.status).toBe("canceled"); // the user's Stop is never held behind eve
    expect(settled.turnId).toBeNull();
    // NOTHING went to eve pre-turn (pre-fix: one unqualified `{}` cancel)…
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    // …and the obligation is on the row (pre-fix: null — "issued").
    expect(settled.remoteCancelPendingAt).not.toBeNull();
    expect(settled.remoteCancelPendingAt).toEqual(settled.completedAt);
    expect(deps.tailers.get(run.id)?.observing).toBeTrue();

    // eve starts the turn: eve's acceptance proof lands and the QUALIFIED
    // cancel goes out.
    openTurn(session.eveSessionId!, "turn_p1");
    await until(
      () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the qualified cancel",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_p1", mode: "ok" },
    ]);
    expect((await runRow(run.id)).turnId).toBe("turn_p1");
    // A 202 is not confirmation: still owed.
    expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();

    // eve's OWN confirmation.
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_p1"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear on the boundary",
    );
    await until(() => (deps.tailers.get(run.id) ? undefined : true), "the observation to close");
    expect((await runRow(run.id)).status).toBe("canceled");
    expect((await runEvents(run.id)).map((e) => (e.event as { type: string }).type)).toEqual([
      "turn.started",
      "message.received",
      "turn.cancelled",
    ]);
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── P2 ────────────────────────────────────────────────────────────────────

  test("P2 — supersession needs the successor's OWN turn_id: a synthesized `running` successor and a successor with leftover events do NOT clear the marker; the successor's turn_id does (pre-fix: cleared on either)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const settled = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    // (a) the successor reconciliation re-tailed: `running`, marker set, NO
    // turn observed — exactly what an unsent continuation looks like.
    const successor = await insertRun(session.id, { status: "running", startedAt: new Date() });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    let outcome = await sweeper.tick();
    expect(outcome).not.toBeNull();
    expect(outcome!.settled).toBe(0);
    expect(outcome!.observing).toBeGreaterThanOrEqual(1);
    // Pre-fix: settled + cleared here on the `running` status alone.
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0); // never an unqualified cancel
    await endTail(settled.id);

    // (b) leftover events persisted under the successor (a predecessor's
    // drained turn) — `seq > 0`, still no turn of its own.
    await runStore.appendEvent(successor.id, 0, turnCompleted("turn_old") as never);
    await runStore.appendEvent(successor.id, 1, sessionWaiting() as never);
    outcome = await sweeper.tick();
    expect(outcome!.settled).toBe(0);
    // Pre-fix: "evidenced" ⇒ cleared.
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    await endTail(settled.id);

    // (c) eve's own proof: the successor's tail observed ITS turn.started.
    expect(await runStore.setRunTurnId(successor.id, "turn_succ")).toBeTrue();
    outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect((await runRow(settled.id)).remoteCancelPendingAt).toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0); // superseded, never cancelled

    await runStore.markRun(successor.id, { status: "canceled", error: "test cleanup", completedAt: new Date() });
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("P2 — a PREDECESSOR's turn_id is not proof (age by created_at), and a successor whose turn_id is set only through observation attribution counts", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const predecessor = await insertRun(session.id, {
      status: "succeeded",
      completedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 60_000),
      turnId: "turn_pred",
    });
    const settled = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome!.settled).toBe(0);
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    await endTail(settled.id);
    expect((await runRow(predecessor.id)).turnId).toBe("turn_pred");
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── P3 ────────────────────────────────────────────────────────────────────

  test("P3 — crash after a Stop: the periodic sweep RE-OPENS observation from the run's persisted seq; the turn starts, the qualified cancel goes out, the boundary clears the marker", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    // Crash residue: canceled + obligation, no turn observed, nothing tailing.
    const run = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    const outcome = await sweeper.tick();
    expect(outcome!.observing).toBeGreaterThanOrEqual(1);
    await untilObserving(run.id);
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);
    // The observation reads from the session's persisted cursor.
    await until(
      () =>
        fakeWorker.opens.some((o) => o.eveSessionId === session.eveSessionId) ? true : undefined,
      "the observation to open the stream",
    );
    expect(fakeWorker.opens.filter((o) => o.eveSessionId === session.eveSessionId)).toEqual([
      { eveSessionId: session.eveSessionId!, startIndex: 0 },
    ]);
    // A second tick does not open a second reader.
    const again = await sweeper.tick();
    expect(again!.observing).toBeGreaterThanOrEqual(1);
    expect(fakeWorker.opens.filter((o) => o.eveSessionId === session.eveSessionId)).toHaveLength(1);

    openTurn(session.eveSessionId!, "turn_p3");
    await until(
      () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the qualified cancel",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_p3", mode: "ok" },
    ]);
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_p3"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await until(() => (deps.tailers.get(run.id) ? undefined : true), "the observation to close");
    expect((await runRow(run.id)).turnId).toBe("turn_p3");
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  test("P3 — boot reconciliation re-opens observation the same way (never a normal tail on a canceled run)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
      turnId: "turn_boot", // the turn was already known: the qualified cancel is re-issued at once
    });
    const outcome = await reconcileInterruptedRuns(deps);
    expect(outcome.remoteCancels.observing).toBeGreaterThanOrEqual(1);
    await untilObserving(run.id);
    await until(
      () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
      "the re-issued qualified cancel",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_boot", mode: "ok" },
    ]);
    expect((await runRow(run.id)).status).toBe("canceled"); // never resurrected to running
    fakeWorker.push(session.eveSessionId!, turnCompleted("turn_boot"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── P4 ────────────────────────────────────────────────────────────────────

  test("P4 — the observation window elapsing declares the obligation UNRESOLVED (marker kept, warn logged) — a live observation's clock and the sweep's age check alike; never a silent clear", async () => {
    await freshHeartbeat();
    // (a) the sweep's age check: an obligation older than the window.
    const aged = await insertSession();
    const agedRun = await insertRun(aged.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(Date.now() - deps.runtime.remoteCancelObserveMs - 1_000),
    });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    logged.length = 0;
    const outcome = await sweeper.tick();
    expect(outcome!.unresolved).toBeGreaterThanOrEqual(1);
    const agedAfter = await runRow(agedRun.id);
    expect(agedAfter.remoteCancelPendingAt).not.toBeNull(); // honestly unmet
    expect(agedAfter.remoteCancelUnresolvedAt).not.toBeNull();
    expect(warnedEvents()).toContain("run.remote_cancel_unresolved");
    expect(attemptsFor(aged.eveSessionId!)).toHaveLength(0);
    // The sweep leaves unresolved rows alone from then on.
    const next = await sweeper.tick();
    expect(next!.unresolved).toBe(0);
    expect(deps.tailers.get(agedRun.id)).toBeUndefined();

    // (b) a LIVE observation's own clock: a short window, no turn ever starts.
    const shortDeps = {
      ...deps,
      runtime: { ...deps.runtime, remoteCancelObserveMs: 300 },
      tailers: new RunTailerManager({
        store: runStore,
        bus: deps.bus,
        maxWallClockMs: 60_000,
        remoteCancelObserveMs: 300,
        logger,
      }),
    } as RuntimeDeps;
    const live = await insertSession();
    const liveRun = await insertRun(live.id, { status: "queued", startedAt: null });
    startTail(shortDeps, WORKER_ADDRESS, HASH, live.eveSessionId!, liveRun.id, live.id);
    await until(
      async () => ((await runRow(liveRun.id)).status === "running" ? true : undefined),
      "the tail to adopt the run",
    );
    logged.length = 0;
    await cancelAgentRun(shortDeps, { id: liveRun.id, status: "running" }, live, "stopped by user");
    expect(shortDeps.tailers.get(liveRun.id)?.observing).toBeTrue();
    await until(
      async () => ((await runRow(liveRun.id)).remoteCancelUnresolvedAt !== null ? true : undefined),
      "the live observation to declare the residual",
      5_000,
    );
    const liveAfter = await runRow(liveRun.id);
    expect(liveAfter.remoteCancelPendingAt).not.toBeNull();
    expect(warnedEvents()).toContain("run.remote_cancel_unresolved");
    await until(() => (shortDeps.tailers.get(liveRun.id) ? undefined : true), "the observation to close");

    // (c) a late confirmation still resolves it (session-terminal on a route).
    expect(await settleSessionRemoteCancelsTerminal(deps, live.id, "test: late terminal")).toBe(1);
    const resolved = await runRow(liveRun.id);
    expect(resolved.remoteCancelPendingAt).toBeNull();
    expect(resolved.remoteCancelUnresolvedAt).toBeNull();

    await runStore.markSession(aged.id, "closed");
    await runStore.markSession(live.id, "closed");
  }, 30_000);

  // ── P5 ────────────────────────────────────────────────────────────────────

  test("P5 — eve's session-terminal answers to the qualified cancel (409 session_not_active, 200 no_active_turn) confirm the obligation; a 202 does not", async () => {
    await freshHeartbeat();
    for (const mode of ["not_active", "no_active_turn"] as const) {
      const session = await insertSession();
      const run = await insertRun(session.id, {
        status: "canceled",
        completedAt: new Date(),
        remoteCancelPendingAt: new Date(),
        turnId: `turn_${mode}`,
      });
      fakeWorker.cancelMode = mode;
      try {
        const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
        await sweeper.tick();
        await until(
          async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
          `the ${mode} answer to confirm`,
        );
      } finally {
        fakeWorker.cancelMode = "ok";
      }
      expect(attemptsFor(session.eveSessionId!)).toEqual([
        { eveSessionId: session.eveSessionId!, turnId: `turn_${mode}`, mode },
      ]);
      await until(() => (deps.tailers.get(run.id) ? undefined : true), "the observation to close");
      await runStore.markSession(session.id, "closed");
    }
  }, 20_000);

  test("P5 — a transport failure of the qualified cancel RETAINS the obligation (never recorded as done); the stream's boundary still confirms it", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
      turnId: "turn_tf",
    });
    fakeWorker.cancelMode = "transport";
    try {
      const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
      await sweeper.tick();
      await untilObserving(run.id);
      await until(
        () => (attemptsFor(session.eveSessionId!).length > 0 ? true : undefined),
        "the attempted cancel",
      );
      await Bun.sleep(100);
      expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();
    } finally {
      fakeWorker.cancelMode = "ok";
    }
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_tf"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the boundary to confirm",
    );
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── P6 ────────────────────────────────────────────────────────────────────

  test("P6 — evidence already on disk: a never-sent run and a parked run whose own boundary its tail persisted owe nothing; an armed eveless session retains; a closed eveless session settles", async () => {
    await freshHeartbeat();
    // (a) never sent: marker null.
    const neverSent = await insertSession();
    const neverSentRun = await insertRun(neverSent.id, { status: "queued", startedAt: null });
    await cancelAgentRun(deps, neverSentRun, neverSent, "stopped by user");
    expect((await runRow(neverSentRun.id)).status).toBe("canceled");
    expect((await runRow(neverSentRun.id)).remoteCancelPendingAt).toBeNull();
    expect(deps.tailers.get(neverSentRun.id)).toBeUndefined();

    // (b) parked: the tail saw turn.started → turn.completed → session.waiting.
    const parked = await insertSession({ status: "waiting" });
    const parkedRun = await insertRun(parked.id, { status: "waiting", turnId: "turn_park" });
    await runStore.appendEvent(parkedRun.id, 0, turnStarted("turn_park") as never);
    await runStore.appendEvent(parkedRun.id, 1, turnCompleted("turn_park") as never);
    await runStore.appendEvent(parkedRun.id, 2, sessionWaiting() as never);
    await cancelAgentRun(deps, parkedRun, parked, "stopped by user");
    expect((await runRow(parkedRun.id)).status).toBe("canceled");
    expect((await runRow(parkedRun.id)).remoteCancelPendingAt).toBeNull();
    expect(attemptsFor(parked.eveSessionId!)).toHaveLength(0);
    expect(deps.tailers.get(parkedRun.id)).toBeUndefined();

    // (c) armed + eveless + live: a dispatch may be in flight — retained.
    const armed = await insertSession({ eveSessionId: null });
    const armedRun = await insertRun(armed.id, {
      status: "canceled",
      completedAt: new Date(),
      remoteCancelPendingAt: new Date(),
    });
    const sweeper = createRemoteCancelSweeper(deps, { intervalMs: 60_000 });
    let outcome = await sweeper.tick();
    expect(outcome!.retained).toBeGreaterThanOrEqual(1);
    expect((await runRow(armedRun.id)).remoteCancelPendingAt).not.toBeNull();
    // (d) …and once the eveless sweep closed it, nothing ever ran: settled.
    await runStore.markSession(armed.id, "closed");
    outcome = await sweeper.tick();
    expect(outcome!.settled).toBeGreaterThanOrEqual(1);
    expect((await runRow(armedRun.id)).remoteCancelPendingAt).toBeNull();

    await runStore.markSession(neverSent.id, "closed");
    await runStore.markSession(parked.id, "closed");
  }, 20_000);

  // ── P7 ────────────────────────────────────────────────────────────────────

  test("P7 — the post-eve recheck hands a canceled dispatch to OBSERVATION (marker set, no unqualified cancel), skips only behind a successor with turn_id, and never behind a synthesized `running` one", async () => {
    await freshHeartbeat();
    const jwt = agentJwtParams(deps.runtime.platformJwtSecret, HASH);
    const targetFor = (eveSessionId: string) => ({
      workerAddress: WORKER_ADDRESS,
      hash: HASH,
      jwt,
      eveSessionId,
    });

    // (a) no successor: observing — marker re-asserted, observation opened.
    const alone = await insertSession();
    const aloneSettled = await insertRun(alone.id, { status: "canceled", completedAt: new Date() });
    expect(
      await recheckCanceledDuringEve(deps, aloneSettled.id, alone.id, targetFor(alone.eveSessionId!)),
    ).toBe("observing");
    expect(attemptsFor(alone.eveSessionId!)).toHaveLength(0); // pre-fix: one unqualified cancel
    expect((await runRow(aloneSettled.id)).remoteCancelPendingAt).not.toBeNull();
    await untilObserving(aloneSettled.id);
    await endTail(aloneSettled.id);

    // (b) a `running` successor WITHOUT turn_id: not proof — still observing.
    const session = await insertSession();
    const settled = await insertRun(session.id, { status: "canceled", completedAt: new Date() });
    const successor = await insertRun(session.id, { status: "running", startedAt: new Date() });
    expect(
      await recheckCanceledDuringEve(deps, settled.id, session.id, targetFor(session.eveSessionId!)),
    ).toBe("observing"); // pre-fix: "superseded", marker dropped
    expect((await runRow(settled.id)).remoteCancelPendingAt).not.toBeNull();
    await endTail(settled.id);

    // (c) the successor's turn_id: proof ⇒ superseded, marker cleared, no cancel.
    await runStore.setRunTurnId(successor.id, "turn_b");
    expect(
      await recheckCanceledDuringEve(deps, settled.id, session.id, targetFor(session.eveSessionId!)),
    ).toBe("superseded");
    expect((await runRow(settled.id)).remoteCancelPendingAt).toBeNull();
    expect(attemptsFor(session.eveSessionId!)).toHaveLength(0);

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

  // ── G1 ────────────────────────────────────────────────────────────────────

  test("G1 — the live-tail Stop's obligation rides the finalizing CAS: the instant the row reads canceled, the marker is on it (a crash there leaves an owner for the turn)", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id, { status: "queued", startedAt: null });
    const captured = new Map<string, Awaited<ReturnType<typeof runRow>>>();
    const store: RunStore = {
      ...runStore,
      async markRun(runId, patch) {
        const marked = await runStore.markRun(runId, patch);
        if (marked && patch.status === "canceled") captured.set(runId, await runRow(runId));
        return marked;
      },
    };
    const snapDeps = {
      ...deps,
      runStore: store,
      tailers: new RunTailerManager({ store, bus: deps.bus, maxWallClockMs: 60_000, logger }),
    } as RuntimeDeps;
    startTail(snapDeps, WORKER_ADDRESS, HASH, session.eveSessionId!, run.id, session.id);
    await until(
      async () => ((await runRow(run.id)).status === "running" ? true : undefined),
      "the tail to adopt the run",
    );
    await cancelAgentRun(snapDeps, { id: run.id, status: "running" }, session, "stopped by user");
    const snapshot = captured.get(run.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.status).toBe("canceled");
    expect(snapshot!.remoteCancelPendingAt).not.toBeNull();
    expect(snapshot!.remoteCancelPendingAt).toEqual(snapshot!.completedAt);
    await snapDeps.tailers.stopAll();
    await runStore.markSession(session.id, "closed");
  }, 20_000);

  // ── N2 ────────────────────────────────────────────────────────────────────

  test("N2(a) — a Stop landing on a SATURATED session lock pool keeps its obligation, and the deferred settlement genuinely retries across its bound: observation opens once the pool frees, without a restart", async () => {
    await freshHeartbeat();
    const session = await insertSession();
    const run = await insertRun(session.id);
    const starved = createDb(TEST_DATABASE_URL!, { max: 3, lockMax: 1 });
    const pinned = await starved.lockSql.reserve();
    const starvedDeps = { ...deps, db: starved.db } as RuntimeDeps;
    try {
      await cancelAgentRun(starvedDeps, run, session, "stopped by user");
      const settled = await runRow(run.id);
      expect(settled.status).toBe("canceled");
      expect(settled.remoteCancelPendingAt).not.toBeNull();
      expect(deps.tailers.get(run.id)).toBeUndefined();
      // Keep the pool pinned PAST one full reserve timeout (2 s) of the
      // background attempt: it must back off and reserve again.
      await Bun.sleep(5_000);
      pinned.release();
      await until(
        () => (deps.tailers.get(run.id)?.observing ? true : undefined),
        "the deferred settlement to open observation after the pool freed",
        15_000,
      );
    } finally {
      await starved.close();
    }
    openTurn(session.eveSessionId!, "turn_n2");
    fakeWorker.push(session.eveSessionId!, turnCancelled("turn_n2"));
    await until(
      async () => ((await runRow(run.id)).remoteCancelPendingAt === null ? true : undefined),
      "the obligation to clear",
    );
    expect(attemptsFor(session.eveSessionId!)).toEqual([
      { eveSessionId: session.eveSessionId!, turnId: "turn_n2", mode: "ok" },
    ]);
    await runStore.markSession(session.id, "closed");
  }, 40_000);

  test("N2(b) — the sweep never fans out background waits: a held session lock counts `deferred` and is simply retried on the next tick", async () => {
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
    await Bun.sleep(500);
    expect(deps.tailers.get(run.id)).toBeUndefined(); // nothing spawned on its own
    expect((await runRow(run.id)).remoteCancelPendingAt).not.toBeNull();
    const next = await sweeper.tick();
    expect(next!.observing).toBeGreaterThanOrEqual(1);
    await untilObserving(run.id);
    await endTail(run.id);
    await runStore.markSession(session.id, "closed");
  }, 20_000);
});
