/**
 * Dispatch crash-window integration tests — gated on TEST_DATABASE_URL (skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * The three interlocking guarantees around the dispatch-attempt marker and
 * the cancel/eviction race, proven against a real Postgres with a fake
 * worker client whose eve calls can be held in flight:
 *
 * 1. CANCEL-DURING-CREATE (post-eve recheck): a Stop that settles the child
 *    run terminal WHILE createEveSession is in flight must not leave the
 *    accepted eve turn running unobserved — the dispatch re-reads the run
 *    when the create returns, remote-cancels with the just-minted session
 *    id, closes the brand-new session (releasing its Slack thread claim),
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
import { reconcileInterruptedRuns } from "./reconcile";
import type { ReadyAgentVersion, RuntimeDeps } from "./routes";
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

/** Fake eve plane: records calls; the NEXT create can be held in flight. */
class FakeWorkerClient {
  readonly createCalls: string[] = [];
  readonly continueCalls: Array<{ eveSessionId: string }> = [];
  readonly cancelCalls: Array<{ eveSessionId: string }> = [];
  /** Set to hold the next createEveSession open; `entered` resolves on entry. */
  createGate: Deferred | null = null;
  createEntered: Deferred | null = null;
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
});
