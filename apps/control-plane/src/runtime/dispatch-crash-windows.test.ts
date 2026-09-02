/**
 * Dispatch crash-window integration tests — gated on TEST_DATABASE_URL (skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * The interlocking guarantees around the dispatch-attempt marker and the
 * cancel/eviction race, proven against a real Postgres with a fake worker
 * client whose eve calls can be held in flight:
 *
 * 1. CANCEL-DURING-CREATE (post-eve recheck): a Stop that settles the child
 *    run terminal WHILE createEveSession is in flight must not leave the
 *    accepted eve turn running unobserved — the dispatch persists the
 *    just-minted session id, re-reads the run, remote-cancels the accepted
 *    turn, closes the brand-new session (releasing its Slack thread claim),
 *    starts no tail, and reports a non-dispatched outcome. And while that
 *    create is STILL in flight, a concurrent dispatch for the same thread
 *    must NOT evict the claim (the holder's newest run carries the marker —
 *    it may be mid-dispatch) — it 409s `session_busy` instead of minting a
 *    second session.
 *
 * 2. MARKER-NULL EVICTION unchanged: a poisoned claim whose one dispatch
 *    died BEFORE the marker write (newest run failed, `started_at` NULL) is
 *    still evicted and the thread recovers with a fresh session.
 *
 * 3. BOOT RECONCILIATION: never tails a marker-null run (the send provably
 *    never happened — even when the session carries an eve id from earlier
 *    turns); re-tails marker-set runs on live workers as before; and closes
 *    abandoned EVELESS sessions whose newest run is terminal + marker-set
 *    (releasing their thread claims), while leaving runless eveless rows
 *    (the post-reset replacement shape) untouched.
 *
 * 4. PERSIST-THEN-RECHECK: the eve id lands on the session row BEFORE the
 *    post-eve terminal recheck, so a Stop landing in the read→act window
 *    finds the id and its own remote chase reaches eve.
 *
 * 5. CANCELED-MID-DISPATCH ADMISSION + BELT-AND-BRACES: a canceled run whose
 *    dispatch may still be in flight (marker set, session eveless) keeps the
 *    session `session_busy` — transiently, resolving when the dispatch
 *    persists the id or the session closes — and a canceled continuation's
 *    late abandon SKIPS its unqualified session-level cancel once a newer
 *    run owns the session.
 *
 * 6. GUARDED SWEEP-2 CLOSE: the boot sweep's eveless-session close re-reads
 *    the row inside the UPDATE's WHERE — a candidate that gained its eve id
 *    between snapshot and close is untouched.
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
import type { RunTailerManager } from "../runs/tailer";
import { loadRuntimeConfig } from "./config";
import {
  dispatchRenderedRun,
  type DispatchRenderedRunInput,
} from "./dispatch";
import { isRuntimeApiError } from "./errors";
import { MetricsRegistry } from "./metrics";
import {
  closeEvelessSessionIfStillAbandoned,
  reconcileInterruptedRuns,
} from "./reconcile";
import {
  cancelChildRun,
  countDispatchingRuns,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "./routes";
import type { WorkerClient } from "./worker-client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[dispatch-crash-windows] skipped: TEST_DATABASE_URL not set");
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

/** Fake eve plane: records calls; the NEXT create/continue can be held in flight. */
class FakeWorkerClient {
  readonly createCalls: string[] = [];
  readonly continueCalls: Array<{ eveSessionId: string }> = [];
  readonly cancelCalls: Array<{ eveSessionId: string }> = [];
  /** Set to hold the next createEveSession open; `entered` resolves on entry. */
  createGate: Deferred | null = null;
  createEntered: Deferred | null = null;
  /** Continuation twins of the create gates (held continueEveSession). */
  continueGate: Deferred | null = null;
  continueEntered: Deferred | null = null;
  private counter = 0;

  async ensureAgent(): Promise<void> {}
  async createEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    request: { message: string },
  ): Promise<{ sessionId: string }> {
    this.createCalls.push(request.message);
    this.createEntered?.resolve();
    const gate = this.createGate;
    this.createGate = null;
    if (gate) await gate.promise;
    return { sessionId: `eve-fresh-${++this.counter}` };
  }
  async continueEveSession(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
  ): Promise<{ sessionId: string; status: "accepted" }> {
    this.continueCalls.push({ eveSessionId });
    this.continueEntered?.resolve();
    const gate = this.continueGate;
    this.continueGate = null;
    if (gate) await gate.promise;
    return { sessionId: eveSessionId, status: "accepted" };
  }
  async cancelEveTurn(
    _addr: string,
    _hash: string,
    _jwt: string,
    eveSessionId: string,
  ): Promise<Record<string, never>> {
    this.cancelCalls.push({ eveSessionId });
    return {};
  }
}

describe.skipIf(!GATE)("dispatch crash windows (marker, recheck, eviction, boot sweeps)", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;
  let workflowId: string;
  let workerId: string;
  const HASH = "c".repeat(64);
  const fakeWorker = new FakeWorkerClient();
  const tailStarts: string[] = [];
  let runStore: RunStore;
  let deps: RuntimeDeps;
  let ready: ReadyAgentVersion;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 6 });
    const db = handle.db;
    orgId = `org-dcw-${randomUUID()}`;
    userId = `user-dcw-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Dispatch Crash Windows Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "dcw",
      email: `${userId}@example.test`,
    });
    const agents = await db
      .insert(schema.agents)
      .values({
        organizationId: orgId,
        name: "Crash Window Agent",
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
      .values({ organizationId: orgId, name: "Crash Window WF", draft: {} })
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
      PLATFORM_JWT_SECRET: "dcw-platform-jwt-secret-0000000000",
      WORKER_SHARED_SECRET: "dcw-worker-shared-secret-000000000",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
      OPENROUTER_API_KEY: "test-openrouter-key",
      SESSION_TITLE_ENABLED: "0",
    });
    runStore = createDrizzleRunStore(db);
    deps = {
      db,
      runtime,
      masterKey: undefined,
      artifacts: { presignGetUrl: () => "http://127.0.0.1:1/artifact" },
      // Enough of a BuildStore for cancelChildRun's best-effort remote leg
      // (sessionControlTarget → requireReadyAgentVersion reads it).
      buildStore: {
        get: async () => ({
          hash: HASH,
          status: "succeeded" as const,
          artifactKey: "artifacts/dcw",
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
      artifactKey: "artifacts/dcw",
    } as unknown as ReadyAgentVersion;
  }, 30_000);

  afterAll(async () => {
    await handle?.db
      .delete(schema.workers)
      .where(eq(schema.workers.id, workerId));
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

  async function threadSessions(threadKey: string) {
    return handle.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.slackThreadKey, threadKey));
  }

  test(
    "cancel-during-create: remote cancel with the fresh id, session closed, claim released — and no eviction (no second session) while the create is in flight",
    async () => {
      const threadKey = `int-dcw:C1:${randomUUID().slice(0, 8)}`;
      const createGate = deferred();
      const createEntered = deferred();
      fakeWorker.createGate = createGate;
      fakeWorker.createEntered = createEntered;

      let childRunId: string | undefined;
      const dispatching = dispatchRenderedRun(deps, {
        ...dispatchInput(threadKey),
        onRunCreated: async (_tx, run) => {
          childRunId = run.id;
        },
      });
      await createEntered.promise; // the create is now in flight

      // The Stop: the pipeline cancel route's child sweep CASes the linked
      // child terminal. The session has no eve id yet, so the route had
      // nothing to chase remotely — the classic no-op window.
      expect(childRunId).toBeDefined();
      expect(
        await runStore.markRun(childRunId!, {
          status: "canceled",
          error: "parent pipeline run canceled: stopped during the agent dispatch",
          completedAt: new Date(),
        }),
      ).toBeTrue();

      // EVICTION FENCE: a concurrent dispatch for the same thread sees a
      // live-status eveless holder with ZERO live runs — but its newest run
      // carries the dispatch-attempt marker, so the claim is NOT evicted
      // (the holder is provably possibly-mid-dispatch): session_busy, and
      // exactly ONE session row still holds the claim.
      let secondError: unknown;
      try {
        await dispatchRenderedRun(deps, dispatchInput(threadKey));
      } catch (error) {
        secondError = error;
      }
      expect(isRuntimeApiError(secondError)).toBeTrue();
      expect((secondError as { code: string }).code).toBe("session_busy");
      expect(await threadSessions(threadKey)).toHaveLength(1);

      // The create returns: the POST-EVE RECHECK sees the terminal run,
      // remote-cancels the accepted turn with the just-minted id, closes the
      // session (releasing the claim), and reports non-dispatched.
      createGate.resolve();
      const result = await dispatching;
      expect(result.dispatched).toBeFalse();
      expect(result.canceledBeforeDispatch).toBeTrue();
      expect(fakeWorker.cancelCalls).toEqual([{ eveSessionId: "eve-fresh-1" }]);
      const closed = await sessionRow(result.session.id);
      expect(closed.status).toBe("closed");
      expect(closed.slackThreadKey).toBeNull();
      expect(closed.eveSessionId).toBe("eve-fresh-1"); // audit trail
      expect(tailStarts).toHaveLength(0); // no tail on a canceled run

      // RECOVERY: with the claim released, the next message in the thread
      // mints a FRESH session and dispatches normally.
      const third = await dispatchRenderedRun(deps, dispatchInput(threadKey));
      expect(third.dispatched).toBeTrue();
      expect(third.session.id).not.toBe(result.session.id);
      expect((await sessionRow(third.session.id)).eveSessionId).toBe("eve-fresh-2");
      expect(tailStarts).toEqual([third.run.id]);
      // Settle the third run so later sweeps in this suite see no live work.
      await runStore.markRun(third.run.id, {
        status: "canceled",
        error: "test cleanup",
        completedAt: new Date(),
      });
    },
    20_000,
  );

  test("marker-null eviction unchanged: a claim whose one dispatch died BEFORE the marker is evicted and the thread recovers", async () => {
    const threadKey = `int-dcw:C2:${randomUUID().slice(0, 8)}`;
    const db = handle.db;
    const holderRows = await db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        agentId,
        agentVersionId: versionId,
        workflowId,
        eveSessionId: null,
        origin: "slack",
        principal: { workspaceId: orgId, source: "slack" },
        slackThreadKey: threadKey,
        affinityWorkerId: workerId,
        status: "active",
      })
      .returning();
    const holder = holderRows[0]!;
    await db.insert(schema.runs).values({
      agentSessionId: holder.id,
      organizationId: orgId,
      workflowId,
      mode: "agent",
      triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
      status: "failed",
      error: "control plane restarted before the run's message was sent",
      startedAt: null, // W1: died between the claim transaction and the marker
      completedAt: new Date(),
    });

    const result = await dispatchRenderedRun(deps, dispatchInput(threadKey));
    expect(result.dispatched).toBeTrue();
    expect(result.session.id).not.toBe(holder.id);
    expect((await sessionRow(holder.id)).slackThreadKey).toBeNull(); // evicted
    expect((await sessionRow(result.session.id)).slackThreadKey).toBe(threadKey);
    await runStore.markRun(result.run.id, {
      status: "canceled",
      error: "test cleanup",
      completedAt: new Date(),
    });
  }, 20_000);

  test("boot reconciliation: marker-null runs are failed (never tailed), marker-set runs re-tail, abandoned eveless marker-set sessions are closed, runless eveless rows survive", async () => {
    const db = handle.db;
    const insertSession = async (over: Partial<typeof schema.agentSessions.$inferInsert>) => {
      const rows = await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          agentId,
          agentVersionId: versionId,
          workflowId: null,
          eveSessionId: null,
          origin: "chat",
          principal: { workspaceId: orgId, source: "chat" },
          affinityWorkerId: workerId,
          status: "active",
          ...over,
        })
        .returning();
      return rows[0]!;
    };
    const insertRun = async (over: Partial<typeof schema.runs.$inferInsert>) => {
      const rows = await db
        .insert(schema.runs)
        .values({
          organizationId: orgId,
          mode: "agent",
          triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
          status: "running",
          ...over,
        })
        .returning();
      return rows[0]!;
    };
    // Keep the worker heartbeat fresh — liveness is TTL-based.
    await db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));

    // (a) a CONTINUATION that crashed before its send: eve id from earlier
    // turns, live worker — but marker NULL. Must be FAILED, never tailed.
    const contSession = await insertSession({ eveSessionId: "eve-earlier-turns" });
    const contRun = await insertRun({
      agentSessionId: contSession.id,
      startedAt: null,
    });
    // (b) a marker-SET orphan on a live worker: re-tailed as before.
    const tailSession = await insertSession({ eveSessionId: "eve-resumable" });
    const tailRun = await insertRun({
      agentSessionId: tailSession.id,
      startedAt: new Date(),
    });
    // (c) an abandoned EVELESS session: newest run terminal + marker-set
    // (cancel raced the create; the post-eve recheck never ran — crash).
    // Boot must close it, releasing its thread claim.
    const abandonedKey = `int-dcw:C3:${randomUUID().slice(0, 8)}`;
    const abandoned = await insertSession({
      workflowId,
      origin: "slack",
      slackThreadKey: abandonedKey,
    });
    await insertRun({
      agentSessionId: abandoned.id,
      workflowId,
      status: "canceled",
      error: "parent pipeline run canceled",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    // (d) a runless eveless row (the post-reset replacement shape): must
    // survive the sweep untouched — it is continuable by design.
    const replacement = await insertSession({});

    const before = tailStarts.length;
    const outcome = await reconcileInterruptedRuns(deps);
    expect(outcome.failed).toBeGreaterThanOrEqual(1);
    expect(outcome.sessionsClosed).toBeGreaterThanOrEqual(1);

    // (a) failed honest, never tailed.
    const cont = await runStore.getRunStatus(contRun.id);
    expect(cont?.status).toBe("failed");
    expect(cont?.error).toContain("never reached the agent");
    expect(tailStarts.slice(before)).not.toContain(contRun.id);
    // (b) re-tailed.
    expect(tailStarts.slice(before)).toContain(tailRun.id);
    // (c) closed + claim released.
    const closed = await sessionRow(abandoned.id);
    expect(closed.status).toBe("closed");
    expect(closed.slackThreadKey).toBeNull();
    // (d) untouched.
    expect((await sessionRow(replacement.id)).status).toBe("active");

    // Settle the re-tailed orphan so later suites see no live work.
    await runStore.markRun(tailRun.id, {
      status: "canceled",
      error: "test cleanup",
      completedAt: new Date(),
    });
  }, 20_000);

  async function freshHeartbeat() {
    await handle.db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.workers.id, workerId));
  }

  test(
    "persist-then-recheck: a Stop landing between the eve return and the recheck still reaches eve (the cancel finds the persisted id)",
    async () => {
      const threadKey = `int-dcw:C4:${randomUUID().slice(0, 8)}`;
      await freshHeartbeat();
      const createGate = deferred();
      const createEntered = deferred();
      fakeWorker.createGate = createGate;
      fakeWorker.createEntered = createEntered;

      let childRunId: string | undefined;
      const dispatching = dispatchRenderedRun(deps, {
        ...dispatchInput(threadKey),
        onRunCreated: async (_tx, run) => {
          childRunId = run.id;
        },
      });
      await createEntered.promise; // the create is now in flight
      expect(childRunId).toBeDefined();

      // Inject the Stop into the read→act window: the FIRST status re-read
      // after the create returns triggers the REAL cancel path
      // (cancelChildRun's no-tail branch: row CAS + best-effort remote
      // chase) and hands the dispatch back the PRE-cancel value — exactly a
      // Stop racing past the recheck. With the id persisted FIRST, the
      // Stop's own remote leg finds it on the row and cancels the accepted
      // turn; with the old read-then-persist order the chase read an
      // eveless session, no-oped, and the turn ran unobserved.
      const realStore = deps.runStore;
      const cancelsBefore = fakeWorker.cancelCalls.length;
      let injected = false;
      (deps as { runStore: RunStore }).runStore = {
        ...realStore,
        getRunStatus: async (runId: string) => {
          const value = await realStore.getRunStatus(runId);
          if (!injected && runId === childRunId) {
            injected = true;
            await cancelChildRun(deps, childRunId, "stop raced the id persist");
          }
          return value;
        },
      };
      let result;
      try {
        createGate.resolve();
        result = await dispatching;
      } finally {
        (deps as { runStore: RunStore }).runStore = realStore;
      }

      expect(injected).toBeTrue();
      const eveId = result.session.eveSessionId;
      expect(eveId).toBeTruthy();
      // THE invariant: the accepted turn was remote-canceled — by the Stop's
      // own chase (it found the persisted id) — never left running
      // unobserved.
      expect(
        fakeWorker.cancelCalls
          .slice(cancelsBefore)
          .map((c) => c.eveSessionId),
      ).toContain(eveId!);
      expect((await runStore.getRunStatus(childRunId!))?.status).toBe("canceled");
      // Hygiene: settle the session so later tests see no live claim.
      await runStore.markSession(result.session.id, "closed");
    },
    20_000,
  );

  test(
    "admission fence (D4): a canceled run whose create is still in flight keeps the eveless session busy; the retry lands cleanly after the abandon settles",
    async () => {
      const threadKey = `int-dcw:C5:${randomUUID().slice(0, 8)}`;
      await freshHeartbeat();
      const createGate = deferred();
      const createEntered = deferred();
      fakeWorker.createGate = createGate;
      fakeWorker.createEntered = createEntered;

      let childRunId: string | undefined;
      const dispatching = dispatchRenderedRun(deps, {
        ...dispatchInput(threadKey),
        onRunCreated: async (_tx, run) => {
          childRunId = run.id;
        },
      });
      await createEntered.promise;
      expect(childRunId).toBeDefined();

      // The Stop settles A terminal while its create is in flight.
      expect(
        await runStore.markRun(childRunId!, {
          status: "canceled",
          error: "stopped during the agent dispatch",
          completedAt: new Date(),
        }),
      ).toBeTrue();

      // B addresses the SAME session explicitly (a continuation): the busy
      // predicate must refuse it — a canceled run with the marker set on an
      // EVELESS session is a dispatch that may still be in flight, and
      // admitting B would open a second eve session on the row.
      const holder = (await threadSessions(threadKey))[0]!;
      let busyError: unknown;
      try {
        await dispatchRenderedRun(
          deps,
          dispatchInput(threadKey, { existingSession: holder }),
        );
      } catch (error) {
        busyError = error;
      }
      expect(isRuntimeApiError(busyError)).toBeTrue();
      expect((busyError as { code: string }).code).toBe("session_busy");

      // The create returns: A's abandon persists the id, remote-cancels the
      // accepted turn (no newer run was admitted), and closes the session —
      // the busy state resolves.
      const cancelsBefore = fakeWorker.cancelCalls.length;
      createGate.resolve();
      const result = await dispatching;
      expect(result.dispatched).toBeFalse();
      expect(result.canceledBeforeDispatch).toBeTrue();
      expect(
        fakeWorker.cancelCalls.slice(cancelsBefore).map((c) => c.eveSessionId),
      ).toContain(result.session.eveSessionId!);
      expect((await sessionRow(result.session.id)).status).toBe("closed");

      // B's retry now lands a CLEAN session (fresh claim under the released
      // key) — session_busy was transient, per the two-409s rule.
      const retry = await dispatchRenderedRun(deps, dispatchInput(threadKey));
      expect(retry.dispatched).toBeTrue();
      expect(retry.session.id).not.toBe(result.session.id);
      await runStore.markRun(retry.run.id, {
        status: "canceled",
        error: "test cleanup",
        completedAt: new Date(),
      });
      await runStore.markSession(retry.session.id, "closed");
    },
    20_000,
  );

  test(
    "belt-and-braces (D4): a canceled continuation's late abandon never fires its unqualified cancel once a newer run owns the session",
    async () => {
      const threadKey = `int-dcw:C6:${randomUUID().slice(0, 8)}`;
      const eveId = `eve-cont-${randomUUID().slice(0, 8)}`;
      await freshHeartbeat();
      const db = handle.db;
      const rows = await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          agentId,
          agentVersionId: versionId,
          workflowId,
          eveSessionId: eveId, // a live thread with earlier turns
          origin: "slack",
          principal: { workspaceId: orgId, source: "slack" },
          slackThreadKey: threadKey,
          affinityWorkerId: workerId,
          status: "waiting",
        })
        .returning();
      const thread = rows[0]!;

      const continueGate = deferred();
      const continueEntered = deferred();
      fakeWorker.continueGate = continueGate;
      fakeWorker.continueEntered = continueEntered;

      let aRunId: string | undefined;
      const dispatchingA = dispatchRenderedRun(deps, {
        ...dispatchInput(threadKey, { existingSession: thread }),
        onRunCreated: async (_tx, run) => {
          aRunId = run.id;
        },
      });
      await continueEntered.promise; // A's continue is now in flight
      expect(aRunId).toBeDefined();

      // Stop settles A terminal mid-flight. The session carries its eve id,
      // so the canceled-mid-dispatch busy arm deliberately does NOT block
      // continuations — B is admitted and its turn starts.
      expect(
        await runStore.markRun(aRunId!, {
          status: "canceled",
          error: "stopped during the continuation dispatch",
          completedAt: new Date(),
        }),
      ).toBeTrue();
      const b = await dispatchRenderedRun(
        deps,
        dispatchInput(threadKey, { existingSession: thread }),
      );
      expect(b.dispatched).toBeTrue();

      // A's continue returns: the abandon sees B's live run on the session
      // and SKIPS the unqualified session-level cancel — a late cancel would
      // kill B's turn, not A's.
      continueGate.resolve();
      const a = await dispatchingA;
      expect(a.dispatched).toBeFalse();
      expect(a.canceledBeforeDispatch).toBeTrue();
      expect(
        fakeWorker.cancelCalls.map((c) => c.eveSessionId),
      ).not.toContain(eveId);
      // The thread's session stays open — it belongs to B now.
      const after = await sessionRow(thread.id);
      expect(after.status).toBe("active");
      expect(after.slackThreadKey).toBe(threadKey);

      await runStore.markRun(b.run.id, {
        status: "canceled",
        error: "test cleanup",
        completedAt: new Date(),
      });
      await runStore.markSession(thread.id, "closed");
    },
    20_000,
  );

  test("countDispatchingRuns: the canceled-mid-dispatch arm counts marker-set canceled runs on EVELESS sessions only", async () => {
    const db = handle.db;
    const insertSession = async (eveSessionId: string | null) => {
      const rows = await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          agentId,
          agentVersionId: versionId,
          workflowId: null,
          eveSessionId,
          origin: "chat",
          principal: { workspaceId: orgId, source: "chat" },
          affinityWorkerId: workerId,
          status: "active",
        })
        .returning();
      return rows[0]!;
    };
    const insertCanceledRun = async (
      agentSessionId: string,
      startedAt: Date | null,
    ) => {
      await db.insert(schema.runs).values({
        agentSessionId,
        organizationId: orgId,
        mode: "agent",
        triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
        status: "canceled",
        startedAt,
        completedAt: new Date(),
      });
    };

    // Marker-set canceled run on an EVELESS session: possibly mid-dispatch → busy.
    const eveless = await insertSession(null);
    await insertCanceledRun(eveless.id, new Date());
    expect(await countDispatchingRuns(db, eveless.id)).toBe(1);

    // Same run shape on a session WITH an eve id: a racing Stop finds the id
    // and chases eve itself → not busy.
    const withId = await insertSession("eve-settled-1");
    await insertCanceledRun(withId.id, new Date());
    expect(await countDispatchingRuns(db, withId.id)).toBe(0);

    // Marker-NULL canceled run: the eve call was provably never issued → not busy.
    const unarmed = await insertSession(null);
    await insertCanceledRun(unarmed.id, null);
    expect(await countDispatchingRuns(db, unarmed.id)).toBe(0);

    for (const s of [eveless, withId, unarmed]) {
      await runStore.markSession(s.id, "closed");
    }
  }, 20_000);

  test("sweep-2 close is a guarded UPDATE (D5): a candidate that gained its eve id between snapshot and close is untouched", async () => {
    const db = handle.db;
    const insertCandidate = async () => {
      const rows = await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          agentId,
          agentVersionId: versionId,
          workflowId: null,
          eveSessionId: null,
          origin: "chat",
          principal: { workspaceId: orgId, source: "chat" },
          affinityWorkerId: workerId,
          status: "active",
        })
        .returning();
      const session = rows[0]!;
      await db.insert(schema.runs).values({
        agentSessionId: session.id,
        organizationId: orgId,
        mode: "agent",
        triggerEvent: triggerEvent() as unknown as Record<string, unknown>,
        status: "canceled",
        startedAt: new Date(), // marker set — a valid sweep-2 nominee
        completedAt: new Date(),
      });
      return session;
    };

    // The sweep snapshot nominates this row… and then it gains its eve id
    // (a live dispatch persisted one) before the close runs. The guarded
    // UPDATE re-reads the row and must leave it alone.
    const healed = await insertCandidate();
    await db
      .update(schema.agentSessions)
      .set({ eveSessionId: "eve-arrived-late" })
      .where(eq(schema.agentSessions.id, healed.id));
    expect(await closeEvelessSessionIfStillAbandoned(db, healed.id)).toBeFalse();
    expect((await sessionRow(healed.id)).status).toBe("active");

    // The still-abandoned twin closes exactly ONCE — only rows actually
    // updated are counted, so the double-call reports false the second time.
    const abandoned = await insertCandidate();
    expect(await closeEvelessSessionIfStillAbandoned(db, abandoned.id)).toBeTrue();
    expect((await sessionRow(abandoned.id)).status).toBe("closed");
    expect(await closeEvelessSessionIfStillAbandoned(db, abandoned.id)).toBeFalse();

    await runStore.markSession(healed.id, "closed");
  }, 20_000);
});
