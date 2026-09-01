/**
 * `agent` step executor — a real eve session against a bound published
 * Agent, run as a CHILD run through the ordinary dispatch machinery
 * (`dispatchRenderedRun`: scheduler → ensure-agent → eve session → tailer),
 * so tailer/SSE/reconcile/409-handling/wall-clock all apply unchanged. The
 * runner renders the step's instructions against the run scope and hands
 * them here as `input` ({@link agentStepRenderedInputSchema}); this executor
 * never re-renders.
 *
 * SESSION SHAPE (plan §agent + amendment A3, spike finding 36):
 * - `session: "fresh"` — a brand-new eve session per step instance, sent
 *   `mode: "task"` unconditionally (nobody watches it in chat, so a budget
 *   crossing must fail the call, not park forever) and — spike-proven —
 *   `outputSchema` on create when the step declares one. Task mode
 *   TERMINATES the session with a data-less `session.completed` (the tailer
 *   already classifies that as run succeeded).
 * - `session: "thread"` — Slack thread continuity: the thread key stamped
 *   into the parent run's `TriggerEvent.data.slackThreadKey` resolves an
 *   existing thread-keyed session (`findSlackThreadSession`) whose PINNED
 *   version takes the message as a follow-up turn — but ONLY when that
 *   session's agent IS the step's agent. A thread established by a step
 *   bound to Agent A must not execute a later Agent-B step's instructions on
 *   A: on mismatch the claim moves to an AGENT-QUALIFIED key
 *   ({@link agentQualifiedThreadKey}), so each agent in one Slack thread
 *   gets its own session (with its own cross-run continuity) and the
 *   `(workflow_id, slack_thread_key)` unique index stays respected. No
 *   session under the step's key means a fresh conversational session
 *   claimed under the same advisory-locked thread-key machinery. Never
 *   `mode: "task"` (a human answers these in Slack) and never an output
 *   schema (the publish gate forbids the combination).
 *
 * CHILD LINKING IS PRE-DISPATCH: the dispatch's run-creation transaction
 * invokes `onRunCreated`, which persists `run_steps.child_run_id` ATOMICALLY
 * with the child run row — strictly before any eve call. A crash at ANY
 * point after eve is reached therefore replays onto a ledger row that
 * already carries the child id (the runner re-attaches via `ctx.childRunId`,
 * including from a `running`-status row), never a second dispatch that would
 * duplicate the child agent's tool side effects. The executor still returns
 * `{status: "waiting", childRunId}` immediately after dispatch — the RUNNER
 * owns the status transition (markWaiting) and the park/bounce that
 * re-invokes this executor with `ctx.childRunId` to watch the child.
 *
 * COMPLETION is keyed on the child RUN ROW's status (which the tailer settles
 * from the stream's terminal events) — NEVER on a follow-up send or a 409
 * probe: eve answers a follow-up to a COMPLETED task session 202-and-drops it
 * (spike finding 36 trap 5). While the child runs, the executor waits on a
 * RunEventBus subscription plus a poll cadence.
 *
 * RETRY POLICY (executor's half — the runner owns budgets/backoff): only
 * DISPATCH-phase failures are retryable — `session_busy` (transient claim
 * race) and `session_not_active` (the dispatch already evicted the dead
 * thread claim, so the retry mints a fresh session). A failed/canceled child
 * TURN is never retried.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  compileOutputSchema,
  triggerEventSchema,
  type EveStreamEvent,
  type OutputSchemaNode,
  type RunStatus,
  type SessionOrigin,
  type TriggerEvent,
} from "@invisible-string/shared";

import type { DbClient } from "../../db";
import {
  dispatchRenderedRun,
  findSlackThreadSession,
  type DispatchRenderedRunResult,
} from "../../runtime/dispatch";
import { isRuntimeApiError } from "../../runtime/errors";
import {
  requireReadyAgentVersion,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "../../runtime/routes";
import { lastStopMessageFrom } from "../../runs/delivery";
import type { StepExecutor, StepOutcome } from "../types";

/** Bus-miss safety net: poll the child run's status row at this cadence. */
export const AGENT_STEP_POLL_MS = 5_000;

/** Failure messages are bounded like every other `run_steps.error` writer. */
const MAX_STEP_ERROR_CHARS = 500;

/**
 * The DECREED rendered-input shape the runner persists to `run_steps.input`
 * for an `agent` step: the instructions markdown after `@reference` rendering
 * — exactly what the child agent receives as its eve session message.
 */
export const agentStepRenderedInputSchema = z.object({
  instructions: z.string(),
});
export type AgentStepRenderedInput = z.infer<typeof agentStepRenderedInputSchema>;

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Child-session origin from the PARENT run's trigger type — provenance for
 * the session row's origin chip. Unknown/manual types read as "chat" (the
 * catch-all interactive origin).
 */
export function sessionOriginForTriggerType(triggerType: string): SessionOrigin {
  switch (triggerType) {
    case "slack":
      return "slack";
    case "webhook":
      return "webhook";
    case "form":
      return "form";
    case "schedule":
      return "schedule";
    default:
      return "chat";
  }
}

/**
 * The Slack thread key the ingress stamped into the parent run's
 * `TriggerEvent.data` (`slackThreadKey` — see integrations/routes.ts). The
 * pipeline scope's `trigger` IS that data record, so a `session: "thread"`
 * step reads it straight off `ctx.scope.trigger`. Null when absent (a
 * non-slack trigger — the publish gate should have refused the combination).
 */
export function slackThreadKeyFromTriggerData(
  data: Record<string, unknown>,
): string | null {
  const value = data["slackThreadKey"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Thread-claim key for an agent whose Slack thread's BARE key is already
 * held by a DIFFERENT agent's session: the first `session: "thread"` step to
 * touch a thread claims the bare ingress key; any later step binding another
 * agent claims `<bareKey>:agent:<agentId>` instead, so each agent in one
 * thread gets its own session (own continuity, own pinned version) without
 * violating the `(workflow_id, slack_thread_key)` unique index.
 *
 * The suffix adds colons ON PURPOSE: `parseSlackThreadKey`
 * (runs/delivery.ts) requires exactly three `:`-segments, so a qualified key
 * can never silently mis-parse into a reply target (child runs never owe a
 * delivery anyway — their `delivery_status` stays null), and a qualified key
 * can never collide with any bare `integrationId:channel:threadTs` key.
 */
export function agentQualifiedThreadKey(
  threadKey: string,
  agentId: string,
): string {
  return `${threadKey}:agent:${agentId}`;
}

/**
 * Extract the agent step's output from the child run's persisted events
 * (amendment A3 — ALWAYS extracted + locally validated, whether or not
 * `outputSchema` rode the create):
 *
 * - `result.completed` present (schema-enforced task turns emit exactly one)
 *   → its `data.result`;
 * - else the last stop-message text — with a declared schema it must PARSE
 *   as JSON before validating (the model answered in prose ⇒
 *   `validation_failed`).
 *
 * With a declared schema the value is validated by the SHARED compiled
 * validator (belt-and-braces over eve's own enforcement); a miss is
 * `validation_failed`, never retried (the turn already happened).
 */
export function extractAgentStepOutput(
  events: readonly EveStreamEvent[],
  schemaNode: OutputSchemaNode | undefined,
):
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; errorClass: string; error: string } {
  let result: unknown;
  let hasResult = false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "result.completed") {
      result = event.data.result;
      hasResult = true;
      break;
    }
  }

  if (!schemaNode) {
    if (hasResult) return { ok: true, output: { result } };
    return { ok: true, output: { text: lastStopMessageFrom(events) } };
  }

  let candidate: unknown = result;
  if (!hasResult) {
    const text = lastStopMessageFrom(events);
    if (text === null) {
      return {
        ok: false,
        errorClass: "validation_failed",
        error:
          "the agent produced no structured result and no final reply to validate against the output schema",
      };
    }
    try {
      candidate = JSON.parse(text);
    } catch {
      return {
        ok: false,
        errorClass: "validation_failed",
        error:
          "the agent's final reply is not parseable as JSON, so it cannot satisfy the output schema",
      };
    }
  }
  const checked = compileOutputSchema(schemaNode)(candidate);
  if (!checked.ok) {
    return {
      ok: false,
      errorClass: "validation_failed",
      error: `agent output failed schema validation: ${checked.errors.join("; ")}`.slice(
        0,
        MAX_STEP_ERROR_CHARS,
      ),
    };
  }
  return { ok: true, output: { result: checked.value } };
}

/**
 * Classify a thrown dispatch failure into a step outcome. Retryable ONLY for
 * the two session-plane conditions the plan names:
 * - `session_busy` — a transient claim race (a racing dispatch owns the
 *   thread's turn); the retry waits out the backoff and goes again.
 * - `session_not_active` — eve's PERMANENT verdict on the OLD session id,
 *   but the dispatch's failEveDispatch already evicted the claim (closed the
 *   row, released the thread key), so the RETRY mints a fresh session — the
 *   plan's "permanent → fresh session".
 * Everything else (no live worker, build not ready, unpublished agent, …) is
 * a real dispatch failure the runner must not spin on.
 */
export function classifyAgentDispatchError(error: unknown): StepOutcome {
  if (isRuntimeApiError(error)) {
    return {
      status: "failed",
      errorClass: error.code,
      error: error.message.slice(0, MAX_STEP_ERROR_CHARS),
      retryable: error.code === "session_busy" || error.code === "session_not_active",
    };
  }
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    status: "failed",
    errorClass: "dispatch_failed",
    error: message.slice(0, MAX_STEP_ERROR_CHARS),
    retryable: false,
  };
}

// ── child watching ───────────────────────────────────────────────────────────

/** The narrow IO surface the child watch runs on (tests fake exactly this). */
export interface ChildWatchIo {
  getRunStatus(
    runId: string,
  ): Promise<{ status: RunStatus; error: string | null } | null>;
  /** RunEventBus.subscribe shape — any frame on the child wakes the watch. */
  subscribe(runId: string, listener: () => void): () => void;
  sleep(ms: number): Promise<void>;
}

export type ChildWatchResult =
  | { kind: "terminal"; status: "succeeded" | "failed" | "canceled"; error: string | null }
  | { kind: "waiting" }
  | { kind: "missing" }
  | { kind: "aborted" };

/**
 * Wait until the child run leaves the live statuses: terminal → extract,
 * `waiting` → the parent parks with it (the runner resumes the watch when
 * the child moves again), row gone → missing. Wakes on any bus frame for the
 * child OR the poll cadence (the bus is in-process best-effort; the status
 * row is truth), and aborts promptly on the attempt signal.
 */
export async function watchChildRun(
  io: ChildWatchIo,
  childRunId: string,
  signal: AbortSignal,
  pollMs: number,
): Promise<ChildWatchResult> {
  while (true) {
    if (signal.aborted) return { kind: "aborted" };
    const status = await io.getRunStatus(childRunId);
    if (!status) return { kind: "missing" };
    if (
      status.status === "succeeded" ||
      status.status === "failed" ||
      status.status === "canceled"
    ) {
      return { kind: "terminal", status: status.status, error: status.error };
    }
    if (status.status === "waiting") return { kind: "waiting" };
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener("abort", done);
        resolve();
      };
      const unsubscribe = io.subscribe(childRunId, done);
      signal.addEventListener("abort", done, { once: true });
      void io.sleep(pollMs).then(done);
    });
  }
}

// ── the executor ─────────────────────────────────────────────────────────────

/**
 * Persist `run_steps.child_run_id` on this step instance's ledger row —
 * called from the dispatch's `onRunCreated` hook, INSIDE the transaction
 * that creates the child run row and strictly BEFORE any eve call. That
 * atomicity is the at-most-once guarantee: there is no instant at which a
 * dispatched (side-effectful) child exists without its ledger link, so a
 * crash anywhere in the dispatch/park window replays into a RE-ATTACH
 * (`ctx.childRunId`), never a second dispatch. Zero rows updated means the
 * runner's claim contract was violated — throw so the transaction aborts and
 * nothing is dispatched.
 */
export async function linkChildRunToStep(
  tx: DbClient,
  parentRunId: string,
  path: string,
  childRunId: string,
): Promise<void> {
  const updated = await tx
    .update(schema.runSteps)
    .set({ childRunId })
    .where(
      and(
        eq(schema.runSteps.runId, parentRunId),
        eq(schema.runSteps.path, path),
      ),
    )
    .returning({ id: schema.runSteps.id });
  if (updated.length === 0) {
    throw new Error(
      `agent step has no claimed run_steps row to link (run ${parentRunId}, path ${path})`,
    );
  }
}

/** Injectable seams so the lifecycle unit-tests run against fakes. */
export interface AgentStepExecutorOptions {
  pollMs?: number;
  dispatchImpl?: typeof dispatchRenderedRun;
  /** In-transaction `run_steps.child_run_id` writer ({@link linkChildRunToStep}). */
  linkChildRunImpl?: typeof linkChildRunToStep;
  /** Agent → CURRENT published, build-ready version (fresh / new-thread). */
  resolveReadyAgentImpl?: (
    deps: RuntimeDeps,
    organizationId: string,
    agentId: string,
  ) => Promise<ReadyAgentVersion>;
  /** Version id → build-ready version (a thread session's PINNED version). */
  requireReadyVersionImpl?: (
    deps: RuntimeDeps,
    versionId: string,
  ) => Promise<ReadyAgentVersion>;
  findThreadSessionImpl?: typeof findSlackThreadSession;
  /** Parent run's provenance envelope (principal + trigger type). */
  loadParentTriggerEventImpl?: (
    deps: RuntimeDeps,
    runId: string,
  ) => Promise<TriggerEvent | null>;
}

/**
 * Resolve the step's bound agent to its CURRENT published, build-ready
 * version (floating binding — the child pins the exact version it ran).
 * Throws the same typed errors the chat path uses; the executor classifies.
 */
async function resolveReadyAgent(
  deps: RuntimeDeps,
  organizationId: string,
  agentId: string,
): Promise<ReadyAgentVersion> {
  const rows = await deps.db
    .select({ publishedVersionId: schema.agents.publishedVersionId })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Typed like a 404 but surfaced as a step failure — the runner persists
    // the class, never an HTTP response.
    throw Object.assign(new Error("the step's agent no longer exists"), {
      stepErrorClass: "agent_missing",
    });
  }
  if (!row.publishedVersionId) {
    throw Object.assign(new Error("the step's agent has no published version"), {
      stepErrorClass: "agent_not_published",
    });
  }
  return requireReadyAgentVersion(deps, row.publishedVersionId);
}

async function loadParentTriggerEvent(
  deps: RuntimeDeps,
  runId: string,
): Promise<TriggerEvent | null> {
  const rows = await deps.db
    .select({ triggerEvent: schema.runs.triggerEvent })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1);
  const raw = rows[0]?.triggerEvent;
  if (!raw) return null;
  const parsed = triggerEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createAgentStepExecutor(
  options: AgentStepExecutorOptions = {},
): StepExecutor {
  const pollMs = options.pollMs ?? AGENT_STEP_POLL_MS;
  const dispatch = options.dispatchImpl ?? dispatchRenderedRun;
  const linkChildRun = options.linkChildRunImpl ?? linkChildRunToStep;
  const resolveAgent = options.resolveReadyAgentImpl ?? resolveReadyAgent;
  const requireReadyVersion =
    options.requireReadyVersionImpl ?? requireReadyAgentVersion;
  const findThreadSession =
    options.findThreadSessionImpl ?? findSlackThreadSession;
  const loadParentEvent =
    options.loadParentTriggerEventImpl ?? loadParentTriggerEvent;

  return async (ctx): Promise<StepOutcome> => {
    const { deps, step } = ctx;
    if (step.kind !== "agent") {
      return failed("internal", `executeAgentStep received a "${step.kind}" step`);
    }
    const parsedInput = agentStepRenderedInputSchema.safeParse(ctx.input);
    if (!parsedInput.success) {
      return failed(
        "internal",
        "rendered agent input is malformed — expected { instructions: string }",
      );
    }
    const runtimeDeps = deps.runtimeDeps;
    if (!runtimeDeps) {
      return failed(
        "runtime_unavailable",
        "agent steps need the runtime dependency graph (workers + dispatch) and this process has none wired",
      );
    }

    // ── phase 2: re-attached to an already-dispatched child ────────────────
    if (ctx.childRunId) {
      return watchAndExtract(runtimeDeps, ctx.childRunId, step.output?.schema, {
        pollMs,
        signal: ctx.signal,
      });
    }

    // ── phase 1: dispatch the child run ────────────────────────────────────
    if (!step.agentId) {
      return failed(
        "agent_not_bound",
        "this agent step names no agent — bind one and republish the workflow",
      );
    }
    const parentEvent = await loadParentEvent(runtimeDeps, ctx.run.id);
    const principal = parentEvent?.principal ?? {
      workspaceId: ctx.orgId,
      source: "pipeline",
    };

    // Persisted INSIDE the dispatch's run-creation transaction (before any
    // eve call) so a crash can only ever replay into a re-attach — see the
    // module doc's CHILD LINKING IS PRE-DISPATCH.
    const onRunCreated = (tx: DbClient, childRun: { id: string }): Promise<void> =>
      linkChildRun(tx, ctx.run.id, ctx.path, childRun.id);

    let result: DispatchRenderedRunResult;
    try {
      if (step.session === "thread") {
        const threadKey = slackThreadKeyFromTriggerData(ctx.scope.trigger);
        if (!threadKey) {
          return failed(
            "thread_key_missing",
            'session: "thread" needs a Slack-triggered run (no slackThreadKey on the trigger data)',
          );
        }
        // The bare ingress key first (the common one-agent-per-thread case,
        // and back-compat with sessions claimed before agent qualification).
        // A holder bound to a DIFFERENT agent is never reused — the step
        // must run on ITS agent — so the lookup/claim moves to the
        // agent-qualified key instead (module doc, session shape).
        let claimKey = threadKey;
        let existing = await findThreadSession(
          runtimeDeps.db,
          ctx.orgId,
          ctx.run.workflowId,
          threadKey,
        );
        if (existing && existing.agentId !== step.agentId) {
          claimKey = agentQualifiedThreadKey(threadKey, step.agentId);
          existing = await findThreadSession(
            runtimeDeps.db,
            ctx.orgId,
            ctx.run.workflowId,
            claimKey,
          );
        }
        // Continuation runs the SESSION's pinned version (immutable —
        // republishing never migrates a live thread); a new thread claim
        // runs the agent's CURRENT published version.
        const ready = existing
          ? await requireReadyVersion(runtimeDeps, existing.agentVersionId)
          : await resolveAgent(runtimeDeps, ctx.orgId, step.agentId);
        result = await dispatch(runtimeDeps, {
          organizationId: ctx.orgId,
          workflowId: ctx.run.workflowId,
          agent: ready,
          origin: "slack",
          triggerType: "pipeline",
          taskMessage: parsedInput.data.instructions,
          triggerEvent: childTriggerEvent(ready, ctx.run, step.id, ctx.path, principal),
          onRunCreated,
          ...(existing
            ? { existingSession: existing }
            : {
                // The principal keeps the BARE key — the session's true
                // Slack-thread identity; the CLAIM column carries the
                // (possibly agent-qualified) key.
                sessionPrincipalExtra: { slackThreadKey: threadKey },
                newSessionSlackThreadKey: claimKey,
              }),
          // Thread sessions stay conversation-mode: a human can answer a
          // session-limit park (or any HITL request) in Slack/chat.
        });
      } else {
        const ready = await resolveAgent(runtimeDeps, ctx.orgId, step.agentId);
        result = await dispatch(runtimeDeps, {
          organizationId: ctx.orgId,
          workflowId: ctx.run.workflowId,
          agent: ready,
          origin: sessionOriginForTriggerType(parentEvent?.triggerType ?? "manual"),
          triggerType: "pipeline",
          taskMessage: parsedInput.data.instructions,
          triggerEvent: childTriggerEvent(ready, ctx.run, step.id, ctx.path, principal),
          onRunCreated,
          eveCreate: {
            // Unconditional for fresh agent steps (amendment A3): nobody
            // watches this session in chat, so a budget crossing must fail
            // the call, never park on a prompt nobody will answer.
            mode: "task",
            // Spike finding 36: eve accepts + enforces this on create; the
            // extraction still validates locally (belt-and-braces).
            ...(step.output
              ? {
                  outputSchema: step.output.schema as unknown as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
          },
        });
      }
    } catch (error) {
      const classified = classifyAgentDispatchError(error);
      // Custom-tagged resolution failures carry their own class.
      const tagged = (error as { stepErrorClass?: unknown }).stepErrorClass;
      if (classified.status === "failed" && typeof tagged === "string") {
        return { ...classified, errorClass: tagged };
      }
      return classified;
    }
    if (!result.dispatched) {
      // Run row exists and is already failed (dispatch-time allowlist).
      return failed(
        "model_disallowed_at_dispatch",
        result.run.error ?? "the agent's model is no longer allowlisted",
      );
    }

    // The ledger already carries the child id (pre-dispatch, in-transaction
    // — see onRunCreated above). Return `waiting` IMMEDIATELY so the RUNNER
    // owns the status transition (markWaiting), notices the child is not
    // actually parked, and re-invokes with `ctx.childRunId` to watch it.
    return { status: "waiting", childRunId: result.run.id };
  };

  async function watchAndExtract(
    runtimeDeps: RuntimeDeps,
    childRunId: string,
    schemaNode: OutputSchemaNode | undefined,
    opts: { pollMs: number; signal: AbortSignal },
  ): Promise<StepOutcome> {
    const io: ChildWatchIo = {
      getRunStatus: (id) => runtimeDeps.runStore.getRunStatus(id),
      subscribe: (id, listener) => runtimeDeps.bus.subscribe(id, listener),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const watched = await watchChildRun(io, childRunId, opts.signal, opts.pollMs);
    switch (watched.kind) {
      case "aborted":
        // The runner's raced abort wins; this outcome is discarded there.
        return failed("canceled", "the run was canceled");
      case "missing":
        return failed(
          "child_run_missing",
          "the agent step's child run disappeared while being watched",
        );
      case "waiting":
        return { status: "waiting", childRunId };
      case "terminal":
        break;
    }
    if (watched.status === "failed") {
      // Never retried: the turn itself failed (plan — dispatch-phase
      // failures only).
      return failed(
        "agent_run_failed",
        watched.error ?? "the agent's run failed",
      );
    }
    if (watched.status === "canceled") {
      return failed(
        "agent_run_canceled",
        watched.error ?? "the agent's run was canceled",
      );
    }
    const events = await runtimeDeps.runStore.listEventsAfter(childRunId, -1);
    const extracted = extractAgentStepOutput(
      events.map((row) => row.event),
      schemaNode,
    );
    if (!extracted.ok) {
      return failed(extracted.errorClass, extracted.error);
    }
    return { status: "succeeded", output: extracted.output };
  }
}

function childTriggerEvent(
  ready: ReadyAgentVersion,
  run: { id: string; workflowId: string },
  stepId: string,
  path: string,
  principal: TriggerEvent["principal"],
): TriggerEvent {
  return {
    agentId: ready.version.agentId,
    workflowId: run.workflowId,
    triggerType: "pipeline",
    // The rendered instructions ride `runs.task_message`; the envelope's
    // model-facing message is unused for child runs.
    message: "",
    data: { parentRunId: run.id, stepId, path },
    principal,
  };
}

function failed(errorClass: string, error: string): StepOutcome {
  return {
    status: "failed",
    errorClass,
    error: error.slice(0, MAX_STEP_ERROR_CHARS),
    retryable: false,
  };
}

/** The registry entry index.ts wires (`agent: executeAgentStep`). */
export const executeAgentStep: StepExecutor = createAgentStepExecutor();
