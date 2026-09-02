/**
 * Rendered-run dispatch — the shared path from an ALREADY-RENDERED task
 * message to a running eve session (workflow-pipelines redesign):
 *
 *   scheduler pick → session + run rows (cap-locked, provenance attached) →
 *   DISPATCH-TIME ALLOWLIST RE-VALIDATION → ensure-agent →
 *   createEveSession(request) | continueEveSession → persist eve ids →
 *   start the NDJSON tailer.
 *
 * WHO DISPATCHES WHAT. Workflow dispatch no longer flows through here as a
 * unit: a trigger event on a workflow ALWAYS starts a PIPELINE run
 * (`startPipelineRun`, pipeline/runner.ts) that the control plane interprets
 * itself. The one thing that still opens eve sessions on behalf of a workflow
 * is the pipeline's `agent` STEP (pipeline/steps/agent.ts), which renders its
 * instructions against the run scope and calls {@link dispatchRenderedRun} to
 * spawn a CHILD run — its own `runs` + `agent_sessions` rows, mode `agent`,
 * linked back via `run_steps.child_run_id`. Chat dispatch stays in
 * runtime/routes.ts (sessions target agents directly) and shares this file's
 * exported primitives (ensureAgentOnWorker/startTail/failDispatch/…) so both
 * paths keep one env contract, cap discipline, and tailer wiring.
 *
 * AGENTS-FIRST CONTRACT (2026-07-10 redesign, unchanged): compiled agents
 * expose ONLY eve's default channel — the TriggerEvent envelope is never sent
 * to the agent; the rendered message IS what it receives, and the envelope is
 * persisted on the run purely as provenance. Slack replies are delivered by
 * the control-plane DeliveryService off the PARENT pipeline run's explicit
 * `onComplete.slackReply` (runs/delivery.ts) — child runs never deliver.
 *
 * FLOATING BINDING: an agent step names an agent, not a version. A NEW
 * session runs the agent's CURRENT published version; a CONTINUATION (Slack
 * thread reply through a `session: "thread"` step) always runs the session's
 * PINNED version — republishing never migrates a live thread.
 *
 * DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7 / design correction):
 * a version's model was allowlisted at publish, but the workspace allowlist is
 * mutable — an admin may have removed or disabled the model since. Before
 * running we re-check the version's COMPILED (stored) provider+model against
 * the CURRENT allowlist; if it is now disallowed we FAIL the run with a clear
 * error and never dispatch it. {@link assertModelAllowlistedAtDispatch}.
 *
 * DISPATCH-ATTEMPT MARKER (crash-window bookkeeping). eve session ids are
 * SERVER-minted (the 202 create response carries the id; the strict create
 * body has no client-supplied id field), so the id cannot be persisted before
 * the create call. What CAN be persisted is the fact that a dispatch attempt
 * is about to reach eve: {@link armDispatchAttempt} CAS-writes `runs.started_at`
 * strictly BEFORE the create/continue call. The marker is the AUTHORITY on
 * whether THIS run's message ever left the platform — the session's
 * `eve_session_id` is not: a `session: "thread"` CONTINUATION already carries
 * an eve id from EARLIER turns, which proves nothing about this run's send.
 * Recovery reads three states:
 *
 *   - `started_at` NULL → the eve call was PROVABLY never issued (program
 *     order: the marker write is awaited before the call), whatever the
 *     session's — possibly pre-existing — eve id says. Boot reconciliation
 *     (runtime/reconcile.ts) refuses to tail such a run (there is no turn to
 *     tail) and fails it instead; the agent step's stillborn-child recovery
 *     then re-dispatches safely ({@link isProvablyUndispatched}) — a fresh
 *     child, or a re-sent continuation into the same session;
 *   - `started_at` set + session `eve_session_id` NULL → the create MAY have
 *     been issued (crash between the marker and the 202 persist) — recovery
 *     must fail honest, never re-dispatch. This narrow window is a DOCUMENTED
 *     deliberate residual: if eve did accept the create, that turn runs to
 *     completion unobserved (side effects happen at most once), and the child
 *     run reads `failed` from boot reconciliation;
 *   - `started_at` set + `eve_session_id` set → the normal resumable state.
 *
 * The marker CAS doubles as the PRE-EVE CANCEL FENCE: a run the pipeline
 * cancel route already settled `canceled` fails the CAS, and the dispatch
 * abandons before eve ever sees the message ({@link DispatchRenderedRunResult}
 * `canceledBeforeDispatch`). Callers may also pass an AbortSignal
 * (`input.signal`) that is honored at the same points. A Stop that lands
 * while the create/continue is ALREADY IN FLIGHT is caught one fence later:
 * the POST-EVE CANCEL RECHECK ({@link recheckCanceledDuringEve}) re-reads the
 * run AFTER the eve id / session update has been persisted —
 * persist-then-recheck, so a cancel landing after the persist finds the id on
 * the row and chases eve itself, while one that landed earlier is caught by
 * the recheck and the accepted turn remote-canceled with the just-obtained
 * session id instead of tailed. The remote leg is skipped when a NEWER run
 * already owns the session (an unqualified session-level cancel must never
 * stop a turn that is not this run's).
 */
import { and, desc, eq, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  workflowConfigSchema,
  type EveSessionMode,
  type ModelProvider,
  type RunStatus,
  type SessionOrigin,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import type { RunStore } from "../runs/store";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import { errors, isRuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import {
  countDispatchingRuns,
  ensureAgentOnWorker,
  failEveDispatch,
  startTail,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "./routes";
import { selectWorker } from "./scheduler";

type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

// ── Dispatch-time model-allowlist re-validation ──────────────────────────────

export interface AllowlistEntry {
  provider: ModelProvider;
  modelId: string;
  enabled: boolean;
}

/** Pure: is `provider/modelId` present AND enabled on the allowlist? */
export function isModelAllowlisted(
  allowlist: readonly AllowlistEntry[],
  provider: ModelProvider,
  modelId: string,
): boolean {
  return allowlist.some(
    (row) => row.enabled && row.provider === provider && row.modelId === modelId,
  );
}

/**
 * Re-check a version's compiled model against the CURRENT workspace allowlist.
 * Throws {@link errors.modelDisallowedAtDispatch} when the model is no longer
 * allowed (removed or disabled). `agent_versions.model_provider`/`model_id`
 * are NOT NULL — every version can be re-checked.
 */
export async function assertModelAllowlistedAtDispatch(
  db: Db,
  organizationId: string,
  version: { modelProvider: ModelProvider; modelId: string },
): Promise<void> {
  const rows = await db
    .select({
      provider: schema.modelAllowlist.provider,
      modelId: schema.modelAllowlist.modelId,
      enabled: schema.modelAllowlist.enabled,
    })
    .from(schema.modelAllowlist)
    .where(eq(schema.modelAllowlist.organizationId, organizationId));
  if (!isModelAllowlisted(rows, version.modelProvider, version.modelId)) {
    throw errors.modelDisallowedAtDispatch(version.modelId);
  }
}

// ── Published pipeline resolution ────────────────────────────────────────────

/**
 * `TriggerEvent.agentId` placeholder for PIPELINE PARENT runs. The envelope's
 * schema requires an agent uuid, but a pipeline run binds no single agent —
 * agents bind per STEP, and each `agent` step's CHILD run carries the real
 * id. The nil uuid keeps the shared schema satisfied while reading
 * unambiguously as "no agent" (it can never collide with a generated v4 id).
 */
export const PIPELINE_TRIGGER_AGENT_ID =
  "00000000-0000-0000-0000-000000000000";

/**
 * Parse a workflow row's PUBLISHED pipeline snapshot. Throws the typed
 * `workflow_not_published` both for a never-published row and for a published
 * jsonb that no longer parses (a pre-pipelines draft shape on a dev stack —
 * the PR notes those stacks reset via `docker compose down -v`).
 */
export function publishedPipelineConfigOf(workflow: WorkflowRow): WorkflowConfig {
  if (!workflow.published) throw errors.workflowNotPublished();
  const parsed = workflowConfigSchema.safeParse(workflow.published);
  if (!parsed.success) throw errors.workflowNotPublished();
  return parsed.data;
}

/**
 * The UNATTENDED-ingress variant: kill switch first, then the published
 * snapshot. The manual "Run now" route deliberately skips the `enabled`
 * check (an explicit member action) and calls
 * {@link publishedPipelineConfigOf} directly.
 */
export function resolveEnabledPipeline(workflow: WorkflowRow): WorkflowConfig {
  if (!workflow.enabled) throw errors.triggerDisabled();
  return publishedPipelineConfigOf(workflow);
}

// ── Rendered-run dispatch (the agent step's child-run path) ─────────────────

export interface DispatchRenderedRunInput {
  organizationId: string;
  /**
   * Workflow provenance for the child run — set on BOTH the session row and
   * the run row (`runs.workflow_id`), so a workflow's Runs surface can find
   * its children without walking run_steps. Null only for callers outside
   * any workflow (none today — chat has its own path).
   */
  workflowId: string | null;
  /**
   * The agent version to run. For a NEW session this is the agent's CURRENT
   * published version; for a CONTINUATION it MUST be the existing session's
   * pinned version (immutable — republishing never migrates a live session).
   */
  agent: ReadyAgentVersion;
  origin: SessionOrigin;
  /** Metrics bucket + TriggerEvent provenance type (e.g. "pipeline", "slack"). */
  triggerType: string;
  /**
   * The rendered message the agent receives VERBATIM as the eve session
   * message (an agent step's instructions rendered against the run scope).
   * Persisted on the run as `task_message`.
   */
  taskMessage: string;
  /** Provenance envelope persisted on `runs.trigger_event` (never sent). */
  triggerEvent: TriggerEvent;
  /** Continuation (a Slack thread reply via `session: "thread"`): reuse this session. */
  existingSession?: SessionRow;
  /**
   * Extra fields folded into a NEW session's stored `principal` jsonb (e.g.
   * `slackThreadKey` so future thread replies map back to this session).
   * Ignored for continuations.
   */
  sessionPrincipalExtra?: Record<string, unknown>;
  /**
   * Slack thread ↔ session key for a NEW slack session (see
   * {@link slackThreadKey}). Persisted on the indexed `slack_thread_key`
   * column; a per-key advisory lock + in-transaction re-check make two racing
   * first-messages of one thread resolve to ONE session (the loser gets a
   * typed `session_busy`, which the agent step retries). Only a LIVE
   * (active/waiting) holder blocks: a closed/error holder is evicted — its
   * key is released so the thread can start over (a terminal session can
   * never be continued). Ignored for continuations.
   *
   * That eviction is STATUS-driven and therefore only sees rows the platform
   * already knows are dead. eve 0.31 adds a second case — a row that still
   * reads `active` while its eve session is gone — which is released by the
   * 409 `session_not_active` handler in `failEveDispatch` instead. A THIRD
   * case is evicted here: a live-status holder with NO eve session id, NO
   * live run, and a newest child run that PROVABLY never dispatched
   * (dispatch-attempt marker NULL) — a claim whose one dispatch died between
   * the claim transaction and the marker write. An in-flight dispatch always
   * counts a queued run inside this same advisory lock, so it is never
   * mistaken for stale — and the marker check closes the residual race: a
   * Stop can settle the holder's run terminal WHILE its createEveSession is
   * still in flight (zero live runs, no eve id yet), and evicting THAT claim
   * would mint a second session for the thread before the first persists its
   * id. Marker-SET eveless holders are therefore left alone here; they are
   * closed by the in-flight dispatch's own post-eve cancel recheck, or — for
   * a crash — by boot reconciliation's eveless-session sweep
   * (runtime/reconcile.ts; at boot no in-flight create can exist).
   */
  newSessionSlackThreadKey?: string;
  /**
   * Cooperative cancellation from the caller (the agent step's attempt
   * signal). Honored at the pre-eve fences only — before the claim
   * transaction and again at the dispatch-attempt marker, strictly before the
   * eve call — never mid-flight: once the create/continue is issued the
   * caller's post-dispatch fence (cancel the child through the ordinary
   * cancel path) is the recovery. Aborting never throws; it yields
   * `canceledBeforeDispatch`.
   */
  signal?: AbortSignal;
  /**
   * eve create options for a NEW session (ignored for continuations): the
   * pipeline agent step sends `mode: "task"` for `session: "fresh"` children
   * and adds `outputSchema` when the step declares one (spike finding 36).
   * Thread sessions stay conversational — a human can answer them in Slack.
   */
  eveCreate?: {
    mode?: EveSessionMode;
    outputSchema?: Record<string, unknown>;
  };
  /**
   * Called INSIDE the session/run-creation transaction, after the run row is
   * inserted and before commit — so a caller can persist its linkage to the
   * new run ATOMICALLY with the run's creation, strictly before any eve
   * call. The agent step writes `run_steps.child_run_id` here: without it, a
   * crash between the eve dispatch and the runner's later `markWaiting`
   * leaves an agent step with no child link, and replay would re-dispatch —
   * duplicating the child agent's tool side effects. Throwing aborts the
   * transaction (no run row survives, nothing was dispatched).
   */
  onRunCreated?: (tx: DbClient, run: RunRow) => Promise<void>;
}

export interface DispatchRenderedRunResult {
  session: SessionRow;
  run: RunRow;
  /** False when the run was created but failed pre-flight (allowlist). */
  dispatched: boolean;
  /**
   * True when the run was created but a cancel (the run row already settled
   * terminal, or the caller's `signal` aborted) landed at one of the
   * dispatch's own fences. At a PRE-eve fence, NOTHING reached eve; at the
   * POST-eve recheck (the cancel raced the in-flight create/continue), the
   * accepted turn was immediately remote-canceled with the just-obtained
   * session id — either way no tail starts, the run row is terminal, and a
   * brand-new session was closed (releasing any Slack thread claim).
   */
  canceledBeforeDispatch?: boolean;
}

// ── Dispatch-attempt marker (F1 crash-window bookkeeping) ────────────────────

export type DispatchArmResult = "armed" | "canceled" | "terminal";

/**
 * CAS-write the dispatch-attempt marker (`runs.started_at`) — MUST be awaited
 * strictly before the eve create/continue call, so that recovery can read
 * "marker absent ⇒ the eve call was never issued" (see the module doc). The
 * CAS doubles as the pre-eve cancel fence: a run already settled terminal
 * (the pipeline cancel route's `cancelChildRun` on a queued child) refuses
 * the write and the caller abandons instead of dispatching.
 */
export async function armDispatchAttempt(
  runStore: RunStore,
  runId: string,
  now: Date = new Date(),
): Promise<DispatchArmResult> {
  const marked = await runStore.markRun(runId, {
    // Status stays `queued` — the tailer owns the queued→running flip; only
    // the startedAt marker matters here (and is overwritten by the tailer's
    // own first-event stamp, by which point eve_session_id is persisted and
    // the marker's job is done).
    status: "queued",
    startedAt: now,
  });
  if (marked) return "armed";
  const current = await runStore.getRunStatus(runId);
  return current?.status === "canceled" ? "canceled" : "terminal";
}

/** The child-run slice the stillborn probe reads (agent step, F1 recovery). */
export interface ChildDispatchState {
  status: RunStatus;
  startedAt: Date | null;
  /**
   * The child SESSION's eve id — NOT part of the stillborn predicate (a
   * thread continuation's session carries one from earlier turns, which says
   * nothing about THIS run's send). The agent step reads it to decide
   * whether the stillborn's session itself ever reached eve: an eveless
   * session is closed (releasing any thread claim), a continuation's
   * session stays open and is simply continued again.
   */
  eveSessionId: string | null;
}

/**
 * True iff the child run PROVABLY never reached eve: it is terminally
 * `failed` (boot reconciliation swept it, or a pre-eve failure marked it)
 * and the dispatch-attempt marker was never written. Program order
 * guarantees the implication: the marker write is awaited strictly before
 * the create/continue call, so marker-absent ⇒ the call was never issued ⇒
 * dispatching a replacement child cannot double-dispatch — including a
 * `session: "thread"` CONTINUATION, whose session already carries an eve id
 * from earlier turns (the id proves those turns, not this run's send; the
 * message never left, so re-sending it is safe). Anything less certain
 * (marker set, or a non-failed status) is NOT recoverable by re-dispatch —
 * fail honest.
 */
export function isProvablyUndispatched(state: ChildDispatchState): boolean {
  return state.status === "failed" && state.startedAt === null;
}

/**
 * True when the session's NEWEST run carries the dispatch-attempt marker
 * (`runs.started_at`). Read inside the thread-claim transaction: a
 * marker-SET newest run on an eveless holder means a dispatch got as far as
 * arming — its eve call may be in flight this instant — so the claim must
 * not be evicted. No runs at all reads as unarmed (a dispatch inserts its
 * run in the same transaction as the session, so a runless holder never
 * dispatched anything).
 */
async function latestRunMarkerArmed(
  tx: DbClient,
  agentSessionId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ startedAt: schema.runs.startedAt })
    .from(schema.runs)
    .where(eq(schema.runs.agentSessionId, agentSessionId))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return rows[0]?.startedAt != null;
}

/** Terminal run statuses (the sticky set markRun's CAS refuses to leave). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

/**
 * Dispatch one rendered task message: create (or continue) the session + a
 * run, re-validate the allowlist, ensure-agent the version on a live worker,
 * send the message to the agent's eve session, and start the tailer. Typed
 * RuntimeApiErrors propagate (the agent step classifies them); a
 * now-disallowed model is a FAILED run (`dispatched: false`), not a thrown
 * request error.
 *
 * Child runs NEVER owe a delivery (`delivery_status` stays null): pipelines
 * deliver explicitly via the PARENT run's `onComplete.slackReply`.
 */
export async function dispatchRenderedRun(
  deps: RuntimeDeps,
  input: DispatchRenderedRunInput,
): Promise<DispatchRenderedRunResult> {
  const { db, runtime } = deps;
  const version = input.agent.version;
  const hash = version.contentHash;

  // Observe every dispatch on the fleet metrics registry, keyed by the
  // caller's trigger type ("pipeline" for agent-step children).
  deps.metrics.recordTrigger(input.triggerType, "received");

  const { worker } = await selectWorker(db, {
    heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
    defaultMaxAgents: runtime.maxAgentsPerWorker,
    versionHash: hash,
    affinityWorkerId: input.existingSession?.affinityWorkerId,
  });

  // Session + run rows land BEFORE the eve dispatch (202-async window: a crash
  // mid-dispatch leaves a visible failed run, never an untracked, uncapped eve
  // session), inside one advisory-locked transaction so the per-workspace cap
  // is atomic and a busy session cannot double-dispatch.
  const { session, run } = await db.transaction(async (tx: DbClient) => {
    await lockWorkspaceRunCap(tx, input.organizationId);
    if (input.existingSession) {
      if ((await countDispatchingRuns(tx, input.existingSession.id)) > 0) {
        throw errors.sessionBusy();
      }
    }
    await assertUnderRunCap(
      tx,
      input.organizationId,
      runtime.maxConcurrentRunsPerWorkspace,
    );

    let sessionRow = input.existingSession;
    if (!sessionRow) {
      const principal = {
        ...input.triggerEvent.principal,
        ...(input.sessionPrincipalExtra ?? {}),
      };
      if (input.newSessionSlackThreadKey) {
        // The thread claim is scoped by workflow (partial unique index on
        // (workflow_id, slack_thread_key)) — a caller passing a thread key
        // without workflow provenance is a programming error, not a request
        // condition.
        const workflowId = input.workflowId;
        if (!workflowId) {
          throw new Error(
            "dispatchRenderedRun: newSessionSlackThreadKey requires a workflowId",
          );
        }
        // Serialize "first message of this Slack thread": two concurrent
        // agent-step dispatches with distinct parent runs would both see no
        // existing session and mint two. The advisory lock + re-check
        // (backed by the partial unique index on (workflow_id,
        // slack_thread_key)) picks one winner.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${input.newSessionSlackThreadKey})::bigint)`,
        );
        const existing = await tx
          .select({
            id: schema.agentSessions.id,
            status: schema.agentSessions.status,
            eveSessionId: schema.agentSessions.eveSessionId,
          })
          .from(schema.agentSessions)
          .where(
            and(
              eq(schema.agentSessions.workflowId, workflowId),
              eq(
                schema.agentSessions.slackThreadKey,
                input.newSessionSlackThreadKey,
              ),
            ),
          )
          .limit(1);
        const holder = existing[0];
        if (holder) {
          const holderDead =
            holder.status === "closed" || holder.status === "error";
          // POISONED claim: a live-status holder with no eve session id, no
          // live run, AND a newest run that provably never dispatched
          // (marker NULL) — its one dispatch died between the claim
          // transaction and the marker write (boot reconciliation failed the
          // run, nothing closed the session). A dispatch still in flight
          // always counts a queued run under this same advisory lock, so it
          // can never be mistaken for stale; and a marker-SET terminal run
          // means the holder may be MID-DISPATCH right now (a Stop settled
          // its run while createEveSession was in flight) — evicting it
          // would mint a second session for the thread before the first
          // persists its id, so those holders are treated as live here and
          // closed by the post-eve recheck / boot reconciliation instead.
          const holderStale =
            !holderDead &&
            holder.eveSessionId === null &&
            (await countDispatchingRuns(tx, holder.id)) === 0 &&
            !(await latestRunMarkerArmed(tx, holder.id));
          if (holderDead || holderStale) {
            // DEAD/POISONED holder: a terminal session can never continue
            // this thread (findSlackThreadSession skips closed/error rows,
            // and an eveless holder has nothing to continue), so treating it
            // as busy would silently brick the thread forever. Evict its
            // claim (markSession also releases the key on terminal
            // transitions; this covers rows poisoned before that, e.g. by a
            // failed or crashed first dispatch) and mint a fresh session
            // under the advisory lock.
            await tx
              .update(schema.agentSessions)
              .set({ slackThreadKey: null })
              .where(eq(schema.agentSessions.id, holder.id));
          } else {
            // LIVE holder (active/waiting) — a concurrent dispatch won the
            // race; this one is a duplicate turn, not a new thread.
            throw errors.sessionBusy();
          }
        }
      }
      const inserted = await tx
        .insert(schema.agentSessions)
        .values({
          organizationId: input.organizationId,
          agentId: version.agentId,
          agentVersionId: version.id,
          workflowId: input.workflowId,
          eveSessionId: null,
          origin: input.origin,
          principal,
          slackThreadKey: input.newSessionSlackThreadKey ?? null,
          affinityWorkerId: worker.id,
          status: "active",
        })
        .returning();
      sessionRow = inserted[0]!;
    }

    const runRows = await tx
      .insert(schema.runs)
      .values({
        agentSessionId: sessionRow.id,
        organizationId: input.organizationId,
        workflowId: input.workflowId,
        mode: "agent",
        triggerEvent: input.triggerEvent as unknown as Record<string, unknown>,
        taskMessage: input.taskMessage,
        // Child runs never deliver — the PARENT pipeline run's explicit
        // onComplete owns the reply.
        deliveryStatus: null,
        status: "queued",
      })
      .returning();
    const runRow = runRows[0]!;
    if (input.onRunCreated) await input.onRunCreated(tx, runRow);
    return { session: sessionRow, run: runRow };
  });

  const isNewSession = input.existingSession === undefined;

  // EARLY CANCEL FENCE: a Stop that raced the claim transaction (the abort
  // fired after the link hook's own in-transaction check passed) must not pay
  // for the allowlist read + agent boot only to be fenced at the marker.
  if (input.signal?.aborted) {
    return abandonCanceledBeforeEve(deps, input, session, run);
  }

  // DISPATCH-TIME ALLOWLIST RE-VALIDATION: fail the run (do not execute) when
  // the version's compiled model is no longer allowlisted.
  try {
    await assertModelAllowlistedAtDispatch(db, input.organizationId, version);
  } catch (error) {
    if (!isRuntimeApiError(error)) throw error;
    deps.metrics.recordTrigger(input.triggerType, "failed");
    const detail = error.message;
    await deps.runStore.markRun(run.id, {
      status: "failed",
      error: detail,
      completedAt: new Date(),
    });
    if (isNewSession) await deps.runStore.markSession(session.id, "error");
    deps.bus.publish(run.id, {
      kind: "status",
      frame: { runId: run.id, status: "failed", error: detail },
    });
    return {
      session,
      run: { ...run, status: "failed", error: detail },
      dispatched: false,
    };
  }

  const jwt = agentJwtParams(runtime.platformJwtSecret, hash);
  let eveSessionId: string;
  try {
    await ensureAgentOnWorker(
      deps,
      { id: worker.id, address: worker.address },
      input.agent,
      input.organizationId,
    );
    // DISPATCH-ATTEMPT MARKER + PRE-EVE CANCEL FENCE (module doc): the
    // marker write is awaited STRICTLY before the eve call — recovery reads
    // its absence as proof the call was never issued — and its CAS refuses a
    // run the cancel route already settled (a Stop landing during the long
    // ensure boot above aborts here instead of dispatching a canceled run).
    const armed = await armDispatchAttempt(deps.runStore, run.id);
    if (armed !== "armed" || input.signal?.aborted) {
      return await abandonCanceledBeforeEve(deps, input, session, run);
    }
    // 0.31: a session is continuable iff it HAS an eve session id and this
    // dispatch is a continuation — the old continuation-token term must not
    // come back (the column is never written; see routes.ts).
    if (isNewSession || !input.existingSession?.eveSessionId) {
      // New session (or a session eve never acked): the task message opens
      // the eve session (202 async), carrying the caller's create options —
      // `mode: "task"` (+ outputSchema) for fresh agent-step children.
      const created = await deps.workerClient.createEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        {
          message: input.taskMessage,
          ...(input.eveCreate?.mode ? { mode: input.eveCreate.mode } : {}),
          ...(input.eveCreate?.outputSchema
            ? { outputSchema: input.eveCreate.outputSchema }
            : {}),
        },
      );
      eveSessionId = created.sessionId;
      // PERSIST-THEN-RECHECK (the post-eve ordering): the just-minted eve id
      // lands on the session row STRICTLY BEFORE the terminal recheck. A
      // Stop landing from here on always finds the id on the row, so its own
      // remote leg (cancelEveTurnBestEffort via the cancel route /
      // cancelChildRun) reaches eve; one that landed while the create was in
      // flight is caught by the recheck below, which holds the id either
      // way. The reverse order (read status, then persist) left a window
      // where a cancel read an eveless session — its remote cancel no-oped —
      // the id then persisted, and the accepted turn ran unobserved.
      await db
        .update(schema.agentSessions)
        .set({
          eveSessionId: created.sessionId,
          status: "active",
          affinityWorkerId: worker.id,
        })
        .where(eq(schema.agentSessions.id, session.id));
      session.eveSessionId = created.sessionId;
      // POST-EVE CANCEL RECHECK: a Stop can settle the run terminal WHILE
      // the create was in flight — the marker fence has already passed and
      // the cancel route found no eve id to chase at the time. The recheck
      // remote-cancels the accepted turn with the just-persisted id, before
      // it is treated as live.
      const recheck = await recheckCanceledDuringEve(deps, run.id, session.id, {
        workerAddress: worker.address,
        hash,
        jwt,
        eveSessionId,
      });
      if (recheck !== "live") {
        return await abandonCanceledDuringEve(deps, input, session, run, recheck);
      }
    } else {
      // Continuation (Slack thread reply): the task message rides the SAME
      // eve session as a follow-up turn — continuity is native to eve's
      // session API. Addressed by id alone; the body is exactly `{message}`
      // (send XOR respond, and a stray `continuationToken` key would be a
      // hard 400).
      eveSessionId = input.existingSession.eveSessionId;
      await deps.workerClient.continueEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        eveSessionId,
        { message: input.taskMessage },
      );
      // PERSIST-THEN-RECHECK (the continuation twin of the create branch
      // above — same ordering discipline; here the session already carries
      // its id, so only the liveness update precedes the recheck).
      await db
        .update(schema.agentSessions)
        .set({ status: "active", affinityWorkerId: worker.id })
        .where(eq(schema.agentSessions.id, session.id));
      // POST-EVE CANCEL RECHECK: a Stop that landed while the continue was
      // in flight means the accepted turn must be told to stop here — no
      // tail will follow it, and the caller's cancelChildRun no-ops on the
      // terminal row. The recheck skips the remote leg when a NEWER run was
      // already admitted on the session (its turn must not be killed by this
      // run's late, session-level cancel).
      const recheck = await recheckCanceledDuringEve(deps, run.id, session.id, {
        workerAddress: worker.address,
        hash,
        jwt,
        eveSessionId,
      });
      if (recheck !== "live") {
        return await abandonCanceledDuringEve(deps, input, session, run, recheck);
      }
    }
  } catch (error) {
    deps.metrics.recordTrigger(input.triggerType, "failed");
    // EVE-DRIVEN EVICTION (the 0.31 half of the stuck-claim story) lives in
    // failEveDispatch: the status-driven eviction in the advisory-locked
    // insert above only fires for rows the PLATFORM already knows are dead,
    // and 0.31 lets eve's truth diverge from `agent_sessions.status`
    // indefinitely. Without an eve-driven release the continuation 409s
    // forever and the Slack thread is bricked. The NEXT agent-step attempt
    // finds no holder and mints a fresh session under the freed key.
    await failEveDispatch(
      deps,
      run.id,
      session.id,
      error,
      isNewSession ? { failSessionId: session.id } : {},
    );
    throw error; // unreachable — failEveDispatch always throws
  }

  startTail(deps, worker.address, hash, eveSessionId, run.id, session.id);

  deps.metrics.recordTrigger(input.triggerType, "dispatched");
  return { session, run, dispatched: true };
}

/**
 * Abandon a dispatch at a pre-eve fence: settle the run `canceled` (CAS —
 * the cancel route may already have), close a brand-NEW session so an
 * `active` eveless row cannot hold a Slack thread-key claim forever
 * (markSession releases the key), and report `canceledBeforeDispatch`.
 * Cancellation is a user decision, never an error — no trigger "failed"
 * metric, no throw.
 */
async function abandonCanceledBeforeEve(
  deps: RuntimeDeps,
  input: DispatchRenderedRunInput,
  session: SessionRow,
  run: RunRow,
): Promise<DispatchRenderedRunResult> {
  const reason = "canceled before the agent was dispatched";
  const marked = await deps.runStore.markRun(run.id, {
    status: "canceled",
    error: reason,
    completedAt: new Date(),
  });
  if (marked) {
    deps.bus.publish(run.id, {
      kind: "status",
      frame: { runId: run.id, status: "canceled", error: reason },
    });
  }
  if (input.existingSession === undefined) {
    // The session was born in this dispatch and never reached eve; a
    // CONTINUATION's session belongs to its thread and stays untouched.
    await deps.runStore.markSession(session.id, "closed");
  }
  const current = await deps.runStore.getRunStatus(run.id);
  return {
    session,
    run: {
      ...run,
      status: current?.status ?? "canceled",
      error: current?.error ?? reason,
    },
    dispatched: false,
    canceledBeforeDispatch: true,
  };
}

/** The remote target of an accepted eve turn (post-eve recheck plumbing). */
export interface EveTurnTarget {
  workerAddress: string;
  hash: string;
  jwt: { secret: string; audience: string };
  eveSessionId: string;
}

/**
 * The post-eve recheck's verdict: `live` — the run is still non-terminal,
 * proceed to tail; `canceled` — the run settled terminal while the eve call
 * was in flight and the accepted turn was remote-canceled (best-effort);
 * `superseded` — the run settled terminal but a NEWER run has already been
 * admitted on the session, so the remote leg was deliberately SKIPPED.
 */
export type PostEveRecheck = "live" | "canceled" | "superseded";

/**
 * POST-EVE CANCEL RECHECK, shared by every dispatch path (dispatchRenderedRun
 * and the chat routes' create branches): AFTER the eve id / session update
 * has been persisted — persist-then-recheck, never the reverse — re-read the
 * run. If it settled terminal while the create/continue was in flight (a
 * Stop racing the dispatch: the cancel route had no eve id to chase at the
 * time, and any later cancelChildRun no-ops on the terminal row), the remote
 * cancel happens here with the just-obtained session id — best-effort, like
 * every remote cancel (an unreachable worker must not turn a Stop into an
 * error).
 *
 * BELT-AND-BRACES: this cancel is UNQUALIFIED (session-level — no turnId
 * exists, since the tail that would learn one never starts), so it must
 * never fire once a NEWER run owns the session: delivered late, it would
 * reach eve after that run's turn started and kill it. Admission normally
 * cannot happen while this run is unresolved (`countDispatchingRuns` counts
 * a canceled run whose dispatch may still be in flight as busy), but a
 * continuation's session carries an eve id from earlier turns and stays
 * admittable — so the newer-run check here is what protects that path.
 */
export async function recheckCanceledDuringEve(
  deps: RuntimeDeps,
  runId: string,
  agentSessionId: string,
  target: EveTurnTarget,
): Promise<PostEveRecheck> {
  const current = await deps.runStore.getRunStatus(runId);
  if (current && !TERMINAL_RUN_STATUSES.has(current.status)) return "live";
  const newerLive = await countDispatchingRuns(deps.db, agentSessionId, {
    excludeRunId: runId,
  });
  if (newerLive > 0) {
    deps.logger.warn("dispatch.post_eve_cancel_skipped", {
      runId,
      fields: {
        sessionId: agentSessionId,
        reason: "a newer run was admitted on the session",
      },
    });
    return "superseded";
  }
  try {
    await deps.workerClient.cancelEveTurn(
      target.workerAddress,
      target.hash,
      await mintPlatformJwt(target.jwt.secret, { audience: target.jwt.audience }),
      target.eveSessionId,
    );
  } catch (error) {
    deps.logger.warn("dispatch.post_eve_cancel_failed", {
      runId,
      fields: {
        sessionId: agentSessionId,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return "canceled";
}

/**
 * Abandon a dispatch whose eve call ALREADY LANDED because the child run
 * settled terminal while the create/continue was in flight (a Stop racing
 * the dispatch). The remote leg already happened in
 * {@link recheckCanceledDuringEve} — with the eve id ALREADY persisted on
 * the session row (persist-then-recheck), so it doubles as the audit trail.
 * A brand-NEW session is closed (markSession releases any Slack thread-key
 * claim — the claim must not outlive the one dispatch that owned it) UNLESS
 * a newer run superseded this one (the session is then live property of that
 * run); a CONTINUATION's session belongs to its thread and stays untouched.
 * Reported as `canceledBeforeDispatch`: no tail starts.
 */
async function abandonCanceledDuringEve(
  deps: RuntimeDeps,
  input: DispatchRenderedRunInput,
  session: SessionRow,
  run: RunRow,
  recheck: Exclude<PostEveRecheck, "live">,
): Promise<DispatchRenderedRunResult> {
  if (input.existingSession === undefined && recheck === "canceled") {
    await deps.runStore.markSession(session.id, "closed");
  }
  const current = await deps.runStore.getRunStatus(run.id);
  return {
    session,
    run: {
      ...run,
      status: current?.status ?? "canceled",
      error: current?.error ?? run.error,
    },
    dispatched: false,
    canceledBeforeDispatch: true,
  };
}

// ── Slack thread ↔ session mapping ───────────────────────────────────────────

/**
 * Stable key mapping a Slack thread onto an agent_session, stored on the
 * session's `principal` jsonb as `slackThreadKey`. Namespaced by integration +
 * channel so a `thread_ts` (unique only within a channel) can't collide across
 * channels/teams. The Slack ingress stamps the SAME key into the pipeline
 * run's `TriggerEvent.data.slackThreadKey`, which is how it reaches the two
 * downstream consumers that need it: the `agent` step (`session: "thread"`
 * continuity) and the DeliveryService (routing `onComplete.slackReply`).
 */
export function slackThreadKey(
  integrationId: string,
  channel: string,
  threadTs: string,
): string {
  return `${integrationId}:${channel}:${threadTs}`;
}

/**
 * Find the continuable agent_session a Slack thread maps to (same workflow,
 * slack origin, matching the indexed `slack_thread_key` column, not
 * closed/errored, and carrying an eve session id). Null when the thread is
 * new. Indexed lookup — O(1) per agent-step dispatch, not a scan of the
 * org's slack sessions.
 *
 * The predicate is `eve_session_id` + non-terminal status; it deliberately
 * ignores the dead `continuation_token` column (never written since eve
 * 0.31). A row that is live here but dead inside eve is caught one layer
 * down: the dispatch's 409 `session_not_active` handler evicts the claim.
 */
export async function findSlackThreadSession(
  db: Db,
  organizationId: string,
  workflowId: string,
  threadKey: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.organizationId, organizationId),
        eq(schema.agentSessions.workflowId, workflowId),
        eq(schema.agentSessions.origin, "slack"),
        eq(schema.agentSessions.slackThreadKey, threadKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    row &&
    row.eveSessionId &&
    row.status !== "closed" &&
    row.status !== "error"
  ) {
    return row;
  }
  return null;
}

/**
 * Prefix under which per-agent DERIVATIVE claims of one Slack thread live:
 * `<bareKey>:agent:<agentId>` (the agent step's `agentQualifiedThreadKey`,
 * pipeline/steps/agent.ts, builds on this). Defined here so the ingress's
 * known-thread check and the step's claim logic share ONE shape — the extra
 * colons are load-bearing: `parseSlackThreadKey` (runs/delivery.ts) requires
 * exactly three `:`-segments, so a qualified key can never mis-parse into a
 * Slack reply target or collide with a bare key.
 */
export function agentQualifiedThreadKeyPrefix(threadKey: string): string {
  return `${threadKey}:agent:`;
}

/**
 * Is this Slack thread KNOWN to the workflow — i.e. does ANY continuable
 * session claim its bare key OR an agent-qualified derivative
 * (`<bareKey>:agent:<agentId>`)? The ingress gate uses this: a reply in a
 * known thread dispatches regardless of the binding (thread replies continue
 * conversations), and checking only the bare key would DROP unmentioned
 * replies the moment the bare holder terminates and releases its claim while
 * an agent-qualified session still carries the conversation. Same
 * continuability predicate as {@link findSlackThreadSession} (non-terminal +
 * eve session id), pushed into SQL because several derivative rows may
 * exist. `starts_with` (not LIKE) on purpose — thread keys carry arbitrary
 * Slack-provided characters and must never be read as a pattern.
 */
export async function isKnownSlackThread(
  db: Db,
  organizationId: string,
  workflowId: string,
  threadKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.organizationId, organizationId),
        eq(schema.agentSessions.workflowId, workflowId),
        eq(schema.agentSessions.origin, "slack"),
        isNotNull(schema.agentSessions.eveSessionId),
        notInArray(schema.agentSessions.status, ["closed", "error"]),
        or(
          eq(schema.agentSessions.slackThreadKey, threadKey),
          sql`starts_with(${schema.agentSessions.slackThreadKey}, ${agentQualifiedThreadKeyPrefix(threadKey)})`,
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
