/**
 * NDJSON event tailer (docs/PLAN.md Phase 1 task 5) — one tail per active
 * run:
 *
 *   GET <worker>/agents/<hash>/eve/v1/session/<id>/stream?startIndex=<n>
 *
 * parses NDJSON lines → appends `run_events` (per-run monotonic `seq`) →
 * publishes frames on the in-process bus for SSE followers → marks the run's
 * status from terminal events → stops cleanly.
 *
 * CURSOR vs DEDUPE KEY — they are different things and must stay so:
 * - `startIndex` is the CURSOR: eve's absolute count of session events already
 *   consumed. Ours is the number of run_events persisted across the session's
 *   runs. It is the only lossless resume mechanism eve offers.
 * - eve 0.31's `meta.id` (an `evt_`-prefixed ULID, stamped once before the
 *   durable write and therefore stable across reconnects, rewinds and full
 *   replays) is the DEDUPE KEY. A re-read event is recognized and skipped
 *   instead of being persisted a second time under a fresh `seq`.
 *   It is NOT a cursor: ULIDs are time-ordered but not totally ordered across
 *   steps running in different processes, so `where id > $cursor` is lossy.
 *   It also does NOT suppress durable-step RETRIES — eve re-runs a step up to
 *   four times and the retry emits NEW ids for the same logical work.
 *
 * BOUNDED CATCH-UP READ (0.27.7): the first connect of a tail asks for
 * `includeTailIndex=1` and reads `x-eve-stream-tail-index` — eve's own count
 * of durably recorded events at attach time. Two uses:
 * - DRIFT REPAIR: if our persisted count is somehow ahead of eve's tail, the
 *   cursor is clamped instead of sending a startIndex past the end (which eve
 *   answers with an immediately-closed stream, i.e. an infinite reconnect
 *   loop that ends in a spurious `failed`).
 * - An explicit, LOGGED bound on the leftover drain below, instead of an
 *   unlabeled prefix of the live read.
 * `follow: false` and `streamReconnectPolicy: {reconnect:false}` are
 * `eve/client` SDK constructs, not wire parameters — this tailer speaks raw
 * HTTP and is the single owner of reconnection, which is what those options
 * buy. Never introduce a second cursor owner on the same stream.
 *
 * TERMINAL MAPPING (REPORT finding 14: parks close the turn —
 * `turn.completed` then `session.waiting`; resumes run as a new turn):
 * - turn.failed / session.failed → run failed (session → error on
 *   session.failed)
 * - turn.cancelled → NOT terminal on its own (eve always follows it with
 *   `session.waiting`) but latches cancellation, so the following
 *   `session.waiting` lands the run `canceled`, session stays `active`.
 *   Cancellation is a USER DECISION, never an error: it must never classify
 *   as `failed`, and — the likelier bug — never as `succeeded`, which would
 *   settle the run's Slack delivery obligation and post a truncated reply.
 * - session.waiting + a pending input.requested in THIS run → run waiting
 *   (parked approval; session → waiting)
 * - session.waiting + a pending authorization.required in THIS run → run
 *   waiting too (mid-run MCP consent challenge; same Slack-truncation hazard
 *   as an unlatched approval). NOTE this latch is DORMANT on eve 0.31.3 for
 *   platform connections: a getToken-only strategy surfaces a mid-run 401 as
 *   a plain failed action.result and `authorization.required` is emitted only
 *   by interactive auth strategies the platform does not author (spike
 *   REPORT finding 34). Implemented defensively against eve's declared wire
 *   types (`authorization.*` in eve-events.ts).
 * - session.waiting otherwise → run succeeded (chat sessions always park on
 *   next-user-message after a completed turn)
 * - session.completed → run succeeded, session closed (task-mode)
 * - context.cleared → not terminal; invalidates any pending input request
 *   (0.31 declares a response stale once its context is cleared).
 * - LEFTOVER events of a previous, early-stopped turn (drained by a fresh
 *   run's first connect) are persisted but never classified as terminals —
 *   see the `sawOwnTurn` gate in the consume loop. The tail-index bound
 *   makes that drain observable but cannot replace the gate: eve may have
 *   durably recorded THIS run's own `turn.started` before we attach, so the
 *   bound alone would swallow our own turn.
 *
 * WALL-CLOCK CAP (task 6): MAX_RUN_WALL_CLOCK_MS starts when tailing starts;
 * expiry marks the run failed and aborts the tail. It is no longer merely
 * platform-side bookkeeping: eve 0.31 ships `POST /eve/v1/session/:id/cancel`,
 * so the tail issues a REAL remote cancel (`cancelRemoteTurn`) before it stops
 * reading — for the wall-clock cap and for a user Stop alike. That cancel is
 * cooperative (it lands at the next durable step boundary, and an in-flight
 * tool call still runs to completion); eve's trailing `turn.cancelled` /
 * `session.waiting` are drained by the next tail on this session.
 *
 * AWAITED vs FIRED (the wrong-turn race). A user Stop through the cancel
 * route holds the session's dispatch lock and asks the tail to AWAIT its
 * remote cancel before finalizing the row (`cancel(…, {awaitRemote: true})`):
 * finalizing reopens admission, and an unqualified cancel (no `turn.started`
 * observed yet, so no turnId to scope it) still airborne when a follow-up's
 * turn started would kill THAT turn instead. When the route could not take
 * the lock, it asks for a turn-QUALIFIED cancel only
 * (`allowUnqualifiedRemote: false`) — safe without the lock — and an
 * unqualified one is SKIPPED and reported, so the route can record the
 * obligation durably for the guarded chase. Shutdown and the wall-clock cap
 * keep the fire-and-forget shape (the row is finalized immediately).
 */
import {
  EVE_STREAM_TAIL_INDEX_HEADER,
  parseEveStreamTailIndex,
  type AgentSessionStatus,
  type EveStreamEvent,
  type Logger,
  type RunStatus,
} from "@invisible-string/shared";

import type { RunEventBus } from "./bus";
import type { RunStore } from "./store";

/**
 * Terminal-run notification (metrics + outbound-delivery seam): status,
 * wall-clock of the tail, and the run's final assistant reply.
 */
export type RunFinishedHook = (info: {
  runId: string;
  status: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">;
  durationMs: number;
  /**
   * Text of the last `message.completed` with `finishReason: "stop"` seen in
   * THIS run's own turn (leftover events drained from a previous turn never
   * count — same gate as terminal classification). Null when the run produced
   * no terminal reply. The DeliveryService posts this back to the trigger
   * surface (Slack) for runs owing a `delivery_status = pending` reply.
   */
  lastAssistantMessage: string | null;
}) => void;

// ── NDJSON parsing ──────────────────────────────────────────────────────────

/**
 * Parse an NDJSON byte stream into events. Malformed lines are skipped
 * (defensive — the eve contract is one JSON object per line); a trailing
 * unterminated line is flushed at stream end.
 */
export async function* ndjsonEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EveStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    const event = parseLine(tail);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): EveStreamEvent | null {
  if (line.length === 0) return null;
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    if (typeof parsed.type !== "string") return null;
    return parsed as EveStreamEvent;
  } catch {
    return null;
  }
}

// ── Terminal classification (pure) ──────────────────────────────────────────

export interface TerminalDecision {
  runStatus: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">;
  sessionStatus: AgentSessionStatus;
  error?: string;
}

/** Latched observations that change what a boundary event MEANS. */
export interface TerminalContext {
  /**
   * An input.requested was seen in THIS run without a subsequent action.result
   * resolving it.
   */
  pendingInputRequest: boolean;
  /**
   * An `authorization.required` was seen in THIS run without a subsequent
   * `authorization.completed` resolving it (mid-run MCP consent challenge).
   * Latched exactly like {@link pendingInputRequest}: while set, a settling
   * `session.waiting` means the run is WAITING on the user's consent — never
   * succeeded, which would settle its delivery obligation with a truncated
   * reply. Dormant on eve 0.31.3 for platform connections (finding 34).
   */
  pendingAuthorization?: boolean;
  /**
   * A `turn.cancelled` was seen in THIS run. eve always follows it with
   * `session.waiting`, and that pair means CANCELED — not succeeded (the
   * default reading of a bare `session.waiting`) and not failed.
   */
  canceledTurn?: boolean;
}

/**
 * Is `event` a tail-stopping boundary for the current run, and what does it
 * mean?
 *
 * Ordering inside `session.waiting` is load-bearing: cancellation outranks a
 * pending approval, because 0.31 declares a parked input request STALE once
 * its turn is cancelled — answering it would post a dead requestId, and
 * leaving the run `waiting` would park it on an approval eve has discarded.
 */
export function classifyTerminal(
  event: EveStreamEvent,
  context: TerminalContext | boolean,
): TerminalDecision | null {
  // Back-compat with the boolean-only signature used across the tests and the
  // older call sites: a bare boolean is `pendingInputRequest`.
  const {
    pendingInputRequest,
    pendingAuthorization = false,
    canceledTurn = false,
  } = typeof context === "boolean"
    ? { pendingInputRequest: context, canceledTurn: false }
    : context;
  switch (event.type) {
    case "turn.failed":
      return {
        runStatus: "failed",
        sessionStatus: "active",
        error: `${event.data.code}: ${event.data.message}`,
      };
    case "session.failed":
      return {
        runStatus: "failed",
        sessionStatus: "error",
        error: `${event.data.code}: ${event.data.message}`,
      };
    case "session.completed":
      return { runStatus: "succeeded", sessionStatus: "closed" };
    case "session.waiting":
      if (canceledTurn) {
        // The session is untouched by a cancel and takes the next message
        // normally — hence `active`, not `waiting`/`closed`. No `error`:
        // cancellation is a user decision, and writing one here would render
        // a red failure banner over a deliberate Stop.
        return { runStatus: "canceled", sessionStatus: "active" };
      }
      // A pending consent challenge parks the run exactly like a pending
      // approval — both mean "eve is waiting on the user, not done".
      return pendingInputRequest || pendingAuthorization
        ? { runStatus: "waiting", sessionStatus: "waiting" }
        : { runStatus: "succeeded", sessionStatus: "active" };
    default:
      // Notably NOT `turn.cancelled`: it is not a boundary in eve's own sense
      // either (`isCurrentTurnBoundaryEvent` covers only the three session.*
      // events). Treating it as terminal would finish the run and drop the
      // trailing `session.waiting`, desynchronizing the session's startIndex
      // and corrupting the NEXT run's resume point.
      return null;
  }
}

/**
 * Track whether an approval/input request is still unanswered in this run.
 *
 * `turn.cancelled` and `context.cleared` both invalidate a parked request:
 * eve declares a response stale once its turn is cancelled or its context
 * cleared, so a run left `waiting` on one would park forever on an approval
 * eve has already discarded.
 */
export function nextPendingInputRequest(
  current: boolean,
  event: EveStreamEvent,
): boolean {
  if (event.type === "input.requested") return true;
  if (
    event.type === "action.result" ||
    event.type === "turn.cancelled" ||
    event.type === "context.cleared"
  ) {
    return false;
  }
  return current;
}

/**
 * Track whether a mid-run MCP consent challenge (`authorization.required`) is
 * still unresolved in this run — the authorization latch, mirroring
 * {@link nextPendingInputRequest}.
 *
 * Cleared ONLY by `authorization.completed` or the same invalidation
 * boundaries as an input request (`turn.cancelled`, `context.cleared`).
 * Deliberately NOT cleared by `action.result`: a tool result never resolves a
 * consent challenge — eve declares that resolution with its own
 * `authorization.completed` event.
 *
 * DORMANT on eve 0.31.3 for platform connections: getToken-only strategies
 * surface a mid-run 401 as a plain failed action.result, and
 * `authorization.required` is reachable only via interactive auth strategies
 * the platform does not author (spike REPORT finding 34). The latch stays in
 * defensively — the types are on eve's wire contract, and an eve upgrade that
 * starts emitting them must park the run, not mark it succeeded.
 */
export function nextPendingAuthorization(
  current: boolean,
  event: EveStreamEvent,
): boolean {
  if (event.type === "authorization.required") return true;
  if (
    event.type === "authorization.completed" ||
    event.type === "turn.cancelled" ||
    event.type === "context.cleared"
  ) {
    return false;
  }
  return current;
}

// ── The tailer ──────────────────────────────────────────────────────────────

export interface OpenRunStreamOptions {
  /**
   * Ask eve for the `x-eve-stream-tail-index` response header. Requested on
   * the FIRST open of a tail only — re-requesting it on every reconnect
   * re-pins the bound and turns a bounded read into a moving target.
   */
  includeTailIndex?: boolean;
}

export type OpenRunStream = (
  startIndex: number,
  signal: AbortSignal,
  options?: OpenRunStreamOptions,
) => Promise<Response>;

/**
 * Ask eve to cancel this session's in-flight turn (`POST .../cancel`).
 * Fire-and-forget: it is cooperative and its response never proves a turn was
 * stopped, so the tail neither awaits its effect nor fails on its error.
 */
export type CancelRemoteTurn = (options?: {
  /**
   * The turn this tail actually observed (`turn.started.data.turnId`), used as
   * eve's stale-request guard.
   *
   * REQUIRED for correctness, not merely nice: the cancel is fire-and-forget
   * and the run is finalized without awaiting it, so the request can still be
   * in flight after the turn ends. Finalizing frees the session's one run
   * slot, so a follow-up message can legitimately start a NEW turn in that
   * window — and an unguarded cancel arriving then would stop the user's new
   * turn instead of the one they asked to stop. With the guard, a late
   * request is a no-op.
   */
  turnId?: string;
}) => Promise<void>;

export interface TailRunOptions {
  runId: string;
  agentSessionId: string;
  openStream: OpenRunStream;
  /** Optional so focused unit fixtures need not model the control plane. */
  cancelRemoteTurn?: CancelRemoteTurn;
  store: RunStore;
  bus: RunEventBus;
  /** Per-run wall-clock cap in ms (MAX_RUN_WALL_CLOCK_MS). */
  maxWallClockMs: number;
  /** Reconnect attempts after unexpected drops (default 5). */
  maxReconnectAttempts?: number;
  /** Base reconnect backoff in ms (default 500; ×2 per attempt). */
  reconnectDelayMs?: number;
  /** Metrics seam: called once when the run reaches a terminal state. */
  onFinish?: RunFinishedHook;
  /**
   * Health seam: called once per (non-duplicate) `authorization.required`
   * event with eve's connection name — the per-version SLUG the compiler
   * emitted, which the wiring resolves to a `connections` row via the agent
   * version's `connection_slugs` map and flips to `health: "auth_required"`.
   * Fired even for a leftover challenge drained from a previous turn:
   * connection health is a fact about the connection, not about this run.
   * Exceptions are swallowed (logged) — a health flip must never kill a tail.
   */
  onAuthorizationRequired?: (info: { connectionName: string }) => void;
  /** Structured run-lifecycle logging (started/terminal). Optional. */
  logger?: Logger;
}

export interface CancelOptions {
  /**
   * Terminal status to mark the run with when the tail stops. Default
   * `failed` (wall-clock expiry / shutdown interruption); the run-cancel API
   * passes `canceled` so a user abort is recorded as a clean cancellation,
   * not a failure.
   */
  status?: "failed" | "canceled";
  /**
   * AWAIT the remote cancel's request before aborting the tail (and so
   * before the row finalizes). Used by the cancel route while it holds the
   * session's dispatch lock, so admission cannot reopen under an airborne
   * cancel. Default false: fire-and-forget (shutdown, wall-clock cap).
   */
  awaitRemote?: boolean;
  /**
   * Whether an UNQUALIFIED remote cancel (no `turn.started` observed yet —
   * no turnId to scope it to) may be issued. Default true. The cancel route
   * passes false when it does NOT hold the session lock: unscoped, a late
   * cancel can stop a successor's turn; the outcome `skipped` tells the
   * route to record the obligation durably instead.
   */
  allowUnqualifiedRemote?: boolean;
}

/**
 * What became of the remote cancel: `issued` (request completed, or fired
 * when not awaited), `failed` (awaited and rejected — logged, best-effort),
 * `skipped` (unqualified and not allowed), `unavailable` (no remote seam).
 * A user cancel ending `failed` or `skipped` finalizes the row WITH
 * `remote_cancel_pending_at` in the same CAS (the durable obligation the
 * guarded chase / sweep / boot reconciliation finish) — the caller never
 * needs, and must never add, a second statement for it.
 */
export type RemoteCancelOutcome = "issued" | "failed" | "skipped" | "unavailable";

export interface RunTailHandle {
  runId: string;
  /** Resolves when the tail has fully stopped (terminal, canceled, or dead). */
  done: Promise<void>;
  /**
   * Stop tailing and mark the run (`canceled` UI action or shutdown). The
   * abort is immediate unless `awaitRemote` is set, in which case the remote
   * cancel request is awaited first; the returned promise resolves with the
   * remote outcome once the abort has been issued. Callers that do not care
   * (shutdown) may ignore it.
   */
  cancel(reason?: string, options?: CancelOptions): Promise<RemoteCancelOutcome>;
  /**
   * Stop tailing WITHOUT marking the run terminal — used by the dead-worker
   * sweeper to detach a stale tail (its worker died) so the run can be
   * re-tailed against a freshly scheduled worker. The run keeps its current
   * DB status (e.g. `running`); the durable eve turn continues and the new
   * tail resumes from the persisted seq.
   */
  detach(): void;
}

export function tailRun(options: TailRunOptions): RunTailHandle {
  const {
    runId,
    agentSessionId,
    openStream,
    cancelRemoteTurn,
    store,
    bus,
    maxWallClockMs,
    maxReconnectAttempts = 5,
    reconnectDelayMs = 500,
    onFinish,
    onAuthorizationRequired,
    logger,
  } = options;

  const log = logger?.child({ runId, sessionId: agentSessionId });
  const tailStartedAt = Date.now();
  const abort = new AbortController();
  let cancelReason: string | null = null;
  /**
   * `turn.started.data.turnId` for the turn THIS tail is following, kept at
   * function scope so it survives reconnects (the per-connection flags below
   * are rebuilt on each attach). Null until the turn boundary is seen — a
   * cancel fired before then is correctly unguarded, since there is no
   * observed turn it could be confused with.
   */
  let observedTurnId: string | null = null;
  // An ABORT-driven stop marks the run "failed" (wall-clock expiry / shutdown)
  // unless a user cancel flipped this flag, which marks it "canceled".
  let canceledByUser = false;
  // A user cancel whose remote leg did NOT reach eve (`skipped`: unqualified
  // and disallowed; `failed`: awaited and rejected in transport). The
  // obligation is then written INTO the finalizing CAS (`finishRun`) as
  // `remoteCancelPendingAt` — never as a second statement after it, which is
  // exactly the crash window that left an accepted turn with no owner.
  let remoteCancelObligation = false;
  let finished = false;
  // Final assistant reply of THIS run (see RunFinishedHook). Only tracked
  // once the run's own turn boundary has been seen — a leftover stop-message
  // drained from a previous turn must never be delivered as this run's reply.
  let lastAssistantMessage: string | null = null;
  // Detach (dead-worker failover) aborts the loop but leaves the run's status
  // untouched so a re-tail on another worker can pick it up.
  let detaching = false;

  const publishStatus = (status: RunStatus, error?: string | null) => {
    bus.publish(runId, {
      kind: "status",
      frame: { runId, status, ...(error !== undefined ? { error } : {}) },
    });
  };

  const finishRun = async (
    status: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">,
    sessionStatus: AgentSessionStatus | null,
    error?: string,
  ) => {
    if (finished) return;
    finished = true;
    // Compare-and-swap: markRun refuses to overwrite a terminal status. When
    // another actor (run-cancel API, sweeper) already finalized this run, the
    // tail steps aside — no session stomp, no duplicate status frame.
    const now = new Date();
    const marked = await store.markRun(runId, {
      status,
      error: error ?? null,
      ...(status === "waiting" ? {} : { completedAt: now }),
      // ONE statement: a canceled row whose remote cancel never reached eve
      // is born carrying its obligation (see `remoteCancelObligation`).
      ...(status === "canceled" && remoteCancelObligation
        ? { remoteCancelPendingAt: now }
        : {}),
    });
    if (!marked) {
      log?.info("run.finish_skipped", {
        fields: { attemptedStatus: status, reason: "run already terminal" },
      });
      return;
    }
    if (sessionStatus) await store.markSession(agentSessionId, sessionStatus);
    publishStatus(status, error ?? null);
    const durationMs = Date.now() - tailStartedAt;
    onFinish?.({ runId, status, durationMs, lastAssistantMessage });
    const level = status === "failed" ? "warn" : "info";
    log?.emit(level, `run.${status}`, {
      durationMs,
      ...(error !== undefined ? { fields: { reason: error } } : {}),
    });
  };

  /**
   * Fire eve's real turn cancel and forget it. Cooperative + idempotent, and
   * its response cannot distinguish "stopped a turn" from "this session is
   * dead", so nothing downstream may branch on it. Never allowed to reject
   * into the tail: a Stop must not become a failure.
   */
  const requestRemoteCancel = (why: string): void => {
    if (!cancelRemoteTurn) return;
    // Scope it to the turn we actually observed. Read at CALL time, not
    // capture time, so a cancel fired after the turn boundary carries the id.
    const turnId = observedTurnId;
    void cancelRemoteTurn(turnId === null ? undefined : { turnId }).catch(
      (error: unknown) => {
        log?.warn("run.remote_cancel_failed", {
          fields: {
            why,
            turnId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
  };

  const wallClockTimer = setTimeout(() => {
    cancelReason ??= `run exceeded the wall-clock cap (${maxWallClockMs}ms)`;
    // Real enforcement now: stop eve's turn instead of only stopping to read
    // it (which used to leave the turn burning tokens against nobody).
    requestRemoteCancel("wall-clock cap");
    abort.abort();
  }, maxWallClockMs);

  const done = (async () => {
    // Resume points derived from what is already persisted (crash-safe).
    let seq = await store.countRunEvents(runId);
    let startIndex = await store.countSessionEvents(agentSessionId);
    // Stable eve event ids already persisted for THIS run. A reconnect that
    // re-reads an overlapping window recognizes them and skips the write —
    // the correctness guarantee index arithmetic alone could not give, since
    // an unparseable line (or any event we consumed without persisting)
    // silently undercounts `startIndex` forever and turns every later
    // reconnect into a duplicate-row generator.
    const seenEventIds = new Set(await store.listEventIds(runId));
    let pendingInput = false;
    let pendingAuthorization = false;
    let canceledTurn = false;
    // Tail index eve reported at attach (null = header absent/not requested).
    let requestTailIndex = true;
    let catchUpBound: number | null = null;
    // TERMINAL GATE: a FRESH run's tail may first drain leftover events of
    // the session's PREVIOUS turn (early-stopped tail: wall-clock abort,
    // cancel, reconnect exhaustion, crash — eve durably finishes the turn
    // anyway and startIndex therefore undercounts). Those leftovers include
    // the old turn's `turn.completed`/`session.waiting`, which must be
    // persisted (keeping counts aligned) but NOT classified as THIS run's
    // terminal — otherwise the new run is instantly marked succeeded before
    // its own turn emits anything. Terminals only count once this run's own
    // turn boundary (`turn.started`) has been seen; a resuming tail
    // (seq > 0) already consumed its own turn.started. `session.failed` is
    // session-fatal and always classified.
    let sawOwnTurn = seq > 0;

    // CAS: a run another actor already finalized (sweeper failed it while the
    // dispatch was still in flight, or the user canceled it) must NOT be
    // resurrected to `running` — the tail simply never starts.
    const adopted = await store.markRun(runId, {
      status: "running",
      ...(seq === 0 ? { startedAt: new Date() } : {}),
    });
    if (!adopted) {
      finished = true;
      clearTimeout(wallClockTimer);
      log?.info("run.tail_refused", {
        fields: { reason: "run already terminal — not resurrecting" },
      });
      return;
    }
    publishStatus("running");
    log?.info("run.started", { fields: { resumed: seq > 0 } });

    let attempt = 0;
    try {
      for (;;) {
        let consumedThisConnect = 0;
        try {
          const response = await openStream(
            startIndex,
            abort.signal,
            requestTailIndex ? { includeTailIndex: true } : undefined,
          );
          if (!response.ok || response.body === null) {
            throw new Error(`stream returned ${response.status}`);
          }
          if (requestTailIndex) {
            requestTailIndex = false;
            const tailIndex = parseEveStreamTailIndex(
              response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER),
            );
            // Absent header (older agent / proxy that drops it) → keep the
            // count-derived cursor. `-1` is a REAL value meaning "empty
            // stream", not "unknown".
            if (tailIndex !== null) {
              if (startIndex > tailIndex + 1) {
                // Our persisted count is ahead of eve's durable truth (pruned
                // rows, a restored DB, an impossible state). Sending a cursor
                // past the end makes eve close the stream immediately, which
                // this loop can only read as a drop — reconnect forever, then
                // a spurious `failed`. Clamp to eve's truth and reconnect.
                log?.warn("run.cursor_clamped", {
                  fields: { from: startIndex, to: tailIndex + 1 },
                });
                startIndex = tailIndex + 1;
                throw new Error("cursor ahead of eve tail index — reopening");
              }
              // Only a FRESH tail can be draining a previous turn's leftovers;
              // a resuming tail's cursor already sits inside its own turn, so
              // bounding it would suppress its own terminal.
              if (seq === 0 && tailIndex >= startIndex) {
                catchUpBound = tailIndex;
                log?.info("run.catch_up", {
                  fields: { from: startIndex, throughIndex: tailIndex },
                });
              }
            }
          }
          for await (const event of ndjsonEvents(response.body)) {
            // Absolute index of THIS event in eve's session stream.
            const eventIndex = startIndex;
            const eventId = event.meta?.id;
            // Reconnect-overlap guard. A re-read of an already-persisted
            // event advances the cursor and still drives the latches (the
            // classification may not have run before the drop) but is never
            // written or published twice.
            const duplicate = eventId !== undefined && seenEventIds.has(eventId);

            if (!duplicate) {
              // Persist FIRST, count after: if appendEvent throws (transient
              // Postgres error), the reconnect resumes from the same
              // startIndex and re-consumes this event instead of silently
              // skipping it forever.
              const stored = await store.appendEvent(runId, seq, event);
              if (eventId !== undefined) seenEventIds.add(eventId);
              bus.publish(runId, {
                kind: "event",
                frame: {
                  runId,
                  seq,
                  event,
                  at: stored.at,
                  ...(eventId !== undefined ? { eventId } : {}),
                },
              });
              seq += 1;
            }
            consumedThisConnect += 1;
            startIndex += 1;

            if (event.type === "turn.started") {
              // This run's own turn boundary: leftover pending-input state
              // from a drained previous turn is historical, not ours — and it
              // ends the catch-up drain even if eve's tail index reached
              // further (eve may already have recorded our own turn).
              sawOwnTurn = true;
              pendingInput = false;
              pendingAuthorization = false;
              canceledTurn = false;
              catchUpBound = null;
              // Remember which turn we are following so a late remote cancel
              // cannot land on a later one (see CancelRemoteTurn).
              observedTurnId = event.data.turnId;
            }
            pendingInput = nextPendingInputRequest(pendingInput, event);
            pendingAuthorization = nextPendingAuthorization(
              pendingAuthorization,
              event,
            );
            if (!duplicate && event.type === "authorization.required") {
              // Health flip seam: a re-read duplicate never re-fires (its
              // first consume already did), and a throwing hook must never
              // become a stream error the reconnect loop misreads as a drop.
              try {
                onAuthorizationRequired?.({ connectionName: event.data.name });
              } catch (hookError) {
                log?.warn("run.authorization_hook_failed", {
                  fields: {
                    connectionName: event.data.name,
                    reason:
                      hookError instanceof Error
                        ? hookError.message
                        : String(hookError),
                  },
                });
              }
            }
            if (sawOwnTurn && event.type === "turn.cancelled") {
              // Latched, not terminal: `session.waiting` always follows and is
              // what actually finishes the run.
              canceledTurn = true;
            }
            if (
              sawOwnTurn &&
              event.type === "message.completed" &&
              event.data.finishReason === "stop" &&
              typeof event.data.message === "string"
            ) {
              lastAssistantMessage = event.data.message;
            }

            // The catch-up window closes either at eve's attach-time tail
            // index or at our own `turn.started`, whichever comes first. It is
            // logged, not enforced: the TURN gate below is what actually
            // suppresses classification, because eve may already have durably
            // recorded this run's own turn before we attached — a bound-only
            // rule would swallow our own terminal and hang the run.
            if (catchUpBound !== null && eventIndex >= catchUpBound) {
              log?.info("run.catch_up_complete", {
                fields: { drained: eventIndex - (catchUpBound ?? 0) + 1 },
              });
              catchUpBound = null;
            }

            // LEFTOVER GATE: until this run's own `turn.started` lands, every
            // event is a previous turn's leftover — persisted (counts stay
            // aligned) but never classified, or the drained
            // `turn.completed`/`session.waiting` would instantly mark this run
            // succeeded. `session.failed` is session-fatal and always counts.
            const terminal =
              sawOwnTurn || event.type === "session.failed"
                ? classifyTerminal(event, {
                    pendingInputRequest: pendingInput,
                    pendingAuthorization,
                    canceledTurn,
                  })
                : null;
            if (terminal) {
              await finishRun(
                terminal.runStatus,
                terminal.sessionStatus,
                terminal.error,
              );
              return;
            }
          }
          // Stream ended without a terminal event → treat like a drop.
          throw new Error("stream ended before a terminal event");
        } catch (error) {
          if (detaching) return; // failover: leave the run for a re-tail
          if (abort.signal.aborted) {
            await finishRun(
              canceledByUser ? "canceled" : "failed",
              canceledByUser ? "active" : null,
              cancelReason ?? "run tail aborted",
            );
            return;
          }
          attempt = consumedThisConnect > 0 ? 1 : attempt + 1;
          if (attempt > maxReconnectAttempts) {
            await finishRun(
              "failed",
              null,
              `event stream lost after ${maxReconnectAttempts} reconnect attempts: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
          await sleepAbortable(
            reconnectDelayMs * 2 ** (attempt - 1),
            abort.signal,
          );
          if (detaching) return; // failover during backoff
          if (abort.signal.aborted) {
            await finishRun(
              canceledByUser ? "canceled" : "failed",
              canceledByUser ? "active" : null,
              cancelReason ?? "run tail aborted",
            );
            return;
          }
        }
      }
    } finally {
      clearTimeout(wallClockTimer);
    }
  })();

  return {
    runId,
    done,
    async cancel(reason, options) {
      cancelReason ??= reason ?? "run canceled";
      if (options?.status === "canceled") canceledByUser = true;
      const why = options?.status === "canceled" ? "user cancel" : "shutdown";
      // Stop eve's turn for real (0.31), not just our reading of it. Issued
      // BEFORE the abort so the request goes out even though the tail stops
      // immediately; the trailing `turn.cancelled` → `session.waiting` are
      // drained by the next tail on this session. Read the turn id at CALL
      // time so a cancel after the turn boundary is scoped to it.
      const turnId = observedTurnId;
      let outcome: RemoteCancelOutcome;
      if (!cancelRemoteTurn) {
        outcome = "unavailable";
      } else if (turnId === null && options?.allowUnqualifiedRemote === false) {
        // Unscoped and the caller holds no lock: a late delivery could stop
        // a successor's turn. Leave it to the guarded chase.
        outcome = "skipped";
        log?.info("run.remote_cancel_skipped", {
          fields: { why, reason: "unqualified cancel without the session lock" },
        });
      } else if (options?.awaitRemote) {
        try {
          await cancelRemoteTurn(turnId === null ? undefined : { turnId });
          outcome = "issued";
        } catch (error) {
          outcome = "failed";
          log?.warn("run.remote_cancel_failed", {
            fields: {
              why,
              turnId,
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else {
        requestRemoteCancel(why);
        outcome = "issued";
      }
      // Record the unmet obligation BEFORE the abort so the finalizing CAS
      // the abort triggers carries it (see `finishRun`). An `unavailable`
      // seam has nothing to owe.
      if (options?.status === "canceled" && (outcome === "skipped" || outcome === "failed")) {
        remoteCancelObligation = true;
      }
      abort.abort();
      return outcome;
    },
    detach() {
      detaching = true;
      abort.abort();
    },
  };
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Manager: one tail per active run + graceful shutdown ───────────────────

export class RunTailerManager {
  private readonly handles = new Map<string, RunTailHandle>();

  constructor(
    private readonly defaults: {
      store: RunStore;
      bus: RunEventBus;
      maxWallClockMs: number;
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
      /** Metrics seam propagated to every tail (run-duration histogram). */
      onFinish?: RunFinishedHook;
      /** Structured run-lifecycle logger propagated to every tail. */
      logger?: Logger;
    },
  ) {}

  start(options: {
    runId: string;
    agentSessionId: string;
    openStream: OpenRunStream;
    cancelRemoteTurn?: CancelRemoteTurn;
    /** Per-run health seam (see {@link TailRunOptions.onAuthorizationRequired}). */
    onAuthorizationRequired?: (info: { connectionName: string }) => void;
  }): RunTailHandle {
    const existing = this.handles.get(options.runId);
    if (existing) return existing;
    const handle = tailRun({ ...this.defaults, ...options });
    this.handles.set(options.runId, handle);
    void handle.done.finally(() => {
      this.handles.delete(options.runId);
    });
    return handle;
  }

  get(runId: string): RunTailHandle | undefined {
    return this.handles.get(runId);
  }

  /**
   * Detach a tail (dead-worker failover) WITHOUT marking its run terminal, and
   * wait for it to fully stop so the caller can start a fresh tail for the same
   * run without the manager returning the stale handle. No-op when absent.
   */
  async detach(runId: string): Promise<void> {
    const handle = this.handles.get(runId);
    if (!handle) return;
    handle.detach();
    await handle.done; // `done.finally` removes it from the map
  }

  /**
   * Cancel a specific run's live tail (user abort), marking it `canceled` and
   * awaiting a clean stop. Returns true when a live tail was cancelled; false
   * when the run had no active tail (parked/queued/terminal — the caller marks
   * the row directly).
   *
   * eve's turn is genuinely cancelled too (0.31 `POST .../cancel`, issued by
   * the tail before it stops reading) — but COOPERATIVELY, at the next durable
   * step boundary, and a tool call already in flight still runs to completion.
   * So "stopped" never means "undone", and the run row is finalized here
   * without waiting for eve's `turn.cancelled`.
   */
  async cancelRun(runId: string, reason?: string): Promise<boolean> {
    const handle = this.handles.get(runId);
    if (!handle) return false;
    void handle.cancel(reason, { status: "canceled" });
    await handle.done;
    return true;
  }

  /**
   * The cancel route's shape of {@link cancelRun}: the remote cancel is
   * awaited (or skipped when unqualified and disallowed — see
   * {@link CancelOptions}) BEFORE the tail aborts and the row finalizes, and
   * the remote outcome is reported. Null when the run had no live tail.
   */
  async cancelRunGuarded(
    runId: string,
    reason: string,
    options: Pick<CancelOptions, "awaitRemote" | "allowUnqualifiedRemote">,
  ): Promise<RemoteCancelOutcome | null> {
    const handle = this.handles.get(runId);
    if (!handle) return null;
    const outcome = await handle.cancel(reason, { status: "canceled", ...options });
    await handle.done;
    return outcome;
  }

  /** Number of live tails (observability/tests). */
  get activeCount(): number {
    return this.handles.size;
  }

  async stopAll(reason = "control plane shutting down"): Promise<void> {
    const all = [...this.handles.values()];
    for (const handle of all) void handle.cancel(reason);
    await Promise.allSettled(all.map((handle) => handle.done));
  }
}
