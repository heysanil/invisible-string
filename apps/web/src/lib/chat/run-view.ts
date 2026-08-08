/**
 * The chat thread's run state machine — a PURE reduction from a run row +
 * its ordered `run_events` frames to the view model the thread renders:
 *
 *   user message → working block (tool steps ✓/⏸/✗, narration, reasoning)
 *               → pending HITL inputs → final assistant reply → error
 *
 * Everything here is deterministic and side-effect free so the same code
 * path serves the live SSE stream, replayed history, tests and the fixture
 * mode. Frames are deduped + ordered by `seq` in {@link FrameStore} — seq is
 * authoritative (SSE resume can re-deliver frames; reducers never double
 * apply).
 *
 * CANCELLATION IS NOT FAILURE (eve 0.31). A stopped turn emits
 * `turn.cancelled` → `session.waiting` and NEVER `turn.failed` /
 * `session.failed`, so `turn.cancelled` must never reach the failure arm:
 * it freezes the run's output in place (whatever streamed before the stop
 * stays rendered), retires every unanswered input request, and lets the
 * session accept the next message normally.
 */
import {
  EVE_INPUT_REQUEST_KINDS,
  isRunSettledStatus,
  type EveInputRequest,
  type EveInputRequestKind,
  type EveJsonValue,
  type EveStreamEvent,
  type RunDto,
  type RunEventFrame,
  type RunStatus,
} from "@invisible-string/shared";

// ── Frame store (seq-deduped, ordered) ──────────────────────────────────────

export interface FrameStore {
  /** Sorted by seq ascending; one frame per seq. */
  readonly frames: readonly RunEventFrame[];
  /** Highest seq seen; -1 when empty. The SSE resume cursor. */
  readonly maxSeq: number;
}

export const EMPTY_FRAME_STORE: FrameStore = { frames: [], maxSeq: -1 };

/**
 * Insert a frame, ignoring duplicates by seq. Returns the SAME store object
 * when the frame was already present, so React state setters and memos can
 * bail out on identity.
 */
export function addFrame(store: FrameStore, frame: RunEventFrame): FrameStore {
  if (frame.seq > store.maxSeq) {
    // Fast path: in-order append (the common streaming case).
    return { frames: [...store.frames, frame], maxSeq: frame.seq };
  }
  if (store.frames.some((existing) => existing.seq === frame.seq)) return store;
  const frames = [...store.frames, frame].sort((a, b) => a.seq - b.seq);
  return { frames, maxSeq: store.maxSeq };
}

export function addFrames(
  store: FrameStore,
  frames: readonly RunEventFrame[],
): FrameStore {
  let next = store;
  for (const frame of frames) next = addFrame(next, frame);
  return next;
}

// ── View model ──────────────────────────────────────────────────────────────

export type StepState =
  | "pending"
  | "awaiting"
  | "ok"
  | "error"
  | "rejected"
  /** The turn was stopped before this call settled — no result will arrive. */
  | "canceled";

export interface StepRowView {
  /** Tool call id — stable row identity. */
  key: string;
  toolName: string;
  state: StepState;
  /** One-line result preview (truncated at render). Null until resolved. */
  resultPreview: string | null;
}

export interface PendingInputView {
  requestId: string;
  prompt: string;
  /**
   * eve's framework-owned discriminator (0.31) — the ONLY thing presentation
   * may route on. Never re-infer intent from `toolName`: a session-limit
   * prompt rides a synthetic `session_limit_continuation` "tool" that must not
   * render as a tool approval.
   */
  kind: EveInputRequestKind;
  /** Tool the approval gates (null for questions and session-limit prompts). */
  toolName: string | null;
  /** Tool input args, pre-rendered as compact JSON for the card. */
  argsPreview: string | null;
  options: readonly {
    id: string;
    label: string;
    /** eve's per-option help text (used by the session-limit prompt). */
    description?: string;
    style?: string;
  }[];
  allowFreeform: boolean;
  display: "confirmation" | "select" | "text";
}

export interface WorkingBlockView {
  steps: readonly StepRowView[];
  /** Interim assistant narration (non-terminal message completions). */
  narration: readonly string[];
  /** Latest reasoning text (rendered as one subtle truncated line). */
  reasoning: string | null;
  /** Wall-clock seconds from first to last frame (null with <2 frames). */
  elapsedSeconds: number | null;
  /** True while the run may still append to this block. */
  active: boolean;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  /** The inbound user/trigger message that started this run. */
  userMessage: string;
  /** Working block; null when the run produced no tool/interim activity. */
  block: WorkingBlockView | null;
  /** Assistant prose (streaming while `streaming`). */
  reply: { text: string; streaming: boolean } | null;
  /** Unanswered `input.requested` entries (approval cards / questions). */
  pendingInputs: readonly PendingInputView[];
  error: string | null;
  /** Resolved model id from session.started (thread header chip). */
  modelId: string | null;
  /**
   * The run's turn was STOPPED by a user (`turn.cancelled`). Derived from the
   * event stream, so it is true the instant the frame lands — a beat before
   * the `run_status: canceled` frame — and it is never an error state.
   */
  canceled: boolean;
  /**
   * A `context.cleared` landed inside this run's frames: the agent's durable
   * model history was dropped while this run's tail was attached. The
   * transcript above stays readable; the agent simply no longer remembers it.
   */
  contextCleared: boolean;
}

// ── Reduction ───────────────────────────────────────────────────────────────

const PREVIEW_MAX = 200;

/** Compact one-line preview of a tool result / args value. */
export function previewValue(value: EveJsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

const KNOWN_INPUT_KINDS: ReadonlySet<string> = new Set(EVE_INPUT_REQUEST_KINDS);

/**
 * eve's synthetic "tool" behind a session-limit continuation prompt
 * (`session-limit-continuation.js`). It is an implementation detail of the
 * budget guardrail, never a tool the user asked for, so it must not surface
 * as a tool chip.
 */
const SESSION_LIMIT_TOOL_NAME = "session_limit_continuation";

/**
 * Read the request's `kind`. eve 0.31 makes it REQUIRED, but `run_events`
 * rows persisted by 0.19-era agents are still replayed forever (SSE history,
 * an old thread reopened), and those carry no discriminator — so fall back to
 * the only signal those rows have rather than mislabelling every one of them
 * as a tool approval.
 */
export function inputRequestKindOf(
  request: EveInputRequest,
): EveInputRequestKind {
  const raw: unknown = (request as { kind?: unknown }).kind;
  if (typeof raw === "string" && KNOWN_INPUT_KINDS.has(raw)) {
    return raw as EveInputRequestKind;
  }
  return request.action?.toolName === "ask_question"
    ? "question"
    : "tool-approval";
}

function pendingInputFromRequest(request: EveInputRequest): PendingInputView {
  const kind = inputRequestKindOf(request);
  const toolName = request.action?.toolName ?? null;
  // A question's gating "tool" is `ask_question` and a session-limit prompt's
  // is eve's budget shim — neither is a tool call the user is approving, so
  // neither gets the tool chip + args preview treatment.
  const showsTool =
    kind === "tool-approval" && toolName !== SESSION_LIMIT_TOOL_NAME;
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    kind,
    toolName: showsTool ? toolName : null,
    argsPreview: showsTool ? previewValue(request.action?.input ?? null) : null,
    options: (request.options ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      style: option.style,
    })),
    allowFreeform: request.allowFreeform ?? false,
    display: request.display ?? (request.options?.length ? "select" : "text"),
  };
}

/**
 * Reduce a run + its frames to the thread view model.
 *
 * `statusOverride` lets the live layer apply a fresher `run_status` frame than
 * the fetched row carries — but ONLY while the row is unsettled. A SETTLED row
 * always wins, because the live layer cannot be fresher than one: the server
 * closes the tail at every stream-terminal status, so nothing can arrive after
 * it.
 *
 * The case that forces this: a run parked on HITL input closes its stream at
 * `waiting`, freezing the live status there permanently. Stopping that run
 * settles the ROW to `canceled` with no stream left to announce it — so a
 * naive `statusOverride ?? run.status` would keep rendering the stale
 * `waiting` forever (approval card still answerable, composer stuck disabled,
 * no stopped-notice) until the user navigates away. See isRunSettledStatus.
 */
export function reduceRunView(
  run: Pick<RunDto, "id" | "status" | "triggerEvent" | "error">,
  store: FrameStore,
  statusOverride?: RunStatus,
): RunView {
  const status = isRunSettledStatus(run.status)
    ? run.status
    : (statusOverride ?? run.status);
  const stepsByCall = new Map<string, StepRowView>();
  const narration: string[] = [];
  const pendingByRequest = new Map<
    string,
    { view: PendingInputView; callId: string | null }
  >();

  let userMessage = run.triggerEvent.message;
  let reasoning: string | null = null;
  let streamText: string | null = null;
  let reply: { text: string; streaming: boolean } | null = null;
  let error: string | null = run.error;
  let modelId: string | null = null;
  let canceled = false;
  let contextCleared = false;

  const resolveInputsForCall = (callId: string) => {
    for (const [requestId, entry] of pendingByRequest) {
      if (entry.callId === callId) pendingByRequest.delete(requestId);
    }
  };

  /**
   * Every unanswered request is stale once the turn is cancelled or the
   * context is cleared — answering one would post a dead requestId that eve
   * replays to the model as an ordinary user message.
   */
  const retirePendingInputs = () => {
    pendingByRequest.clear();
  };

  for (const frame of store.frames) {
    const event = frame.event as EveStreamEvent;
    switch (event.type) {
      case "session.started":
        modelId = event.data.runtime?.modelId ?? modelId;
        break;
      case "message.received":
        userMessage = event.data.message;
        break;
      case "actions.requested":
        for (const action of event.data.actions) {
          stepsByCall.set(action.callId, {
            key: action.callId,
            toolName: action.toolName,
            state: "pending",
            resultPreview: null,
          });
        }
        break;
      case "input.requested":
        for (const request of event.data.requests) {
          const callId = request.action?.callId ?? null;
          pendingByRequest.set(request.requestId, {
            view: pendingInputFromRequest(request),
            callId,
          });
          if (callId !== null) {
            const step = stepsByCall.get(callId);
            if (step !== undefined && step.state === "pending") {
              stepsByCall.set(callId, { ...step, state: "awaiting" });
            }
          }
        }
        break;
      // Preliminary tool output while a long call is still running:
      // last-write-wins per callId, never terminal for the step.
      case "action.partial": {
        const { result } = event.data;
        const step = stepsByCall.get(result.callId);
        // Never walk a settled step backwards. eve emits partials before the
        // result, but a durable step RETRY re-emits the whole sequence, so a
        // partial can legitimately arrive after this call already resolved.
        if (step !== undefined && step.state !== "pending" && step.state !== "awaiting") {
          break;
        }
        stepsByCall.set(result.callId, {
          key: result.callId,
          toolName: result.toolName,
          state: step?.state ?? "pending",
          resultPreview: previewValue(result.output),
        });
        break;
      }
      case "action.result": {
        const { result, status: resultStatus, error: resultError } = event.data;
        const state: StepState =
          resultStatus === "completed"
            ? "ok"
            : resultStatus === "rejected"
              ? "rejected"
              : "error";
        const preview =
          state === "ok"
            ? previewValue(result.output)
            : (resultError?.message ?? previewValue(result.output) ?? "Failed");
        stepsByCall.set(result.callId, {
          key: result.callId,
          toolName: result.toolName,
          state,
          resultPreview: preview,
        });
        resolveInputsForCall(result.callId);
        break;
      }
      case "reasoning.appended":
        reasoning = event.data.reasoningSoFar;
        break;
      case "reasoning.completed":
        reasoning = event.data.reasoning;
        break;
      case "message.appended":
        streamText = event.data.messageSoFar;
        break;
      case "message.completed": {
        const text = event.data.message;
        if (event.data.finishReason === "stop") {
          if (text !== null && text.length > 0) {
            reply = { text, streaming: false };
          }
        } else if (text !== null && text.trim().length > 0) {
          narration.push(text);
        }
        streamText = null;
        break;
      }
      // A USER DECISION, NEVER AN ERROR — deliberately its own arm, far from
      // the failure arm below, so it can never leak into `error`. eve stops
      // at the next durable step boundary (a tool already in flight still
      // lands its `action.result`), then emits `session.waiting`; whatever
      // streamed before the stop stays on screen, frozen.
      case "turn.cancelled": {
        canceled = true;
        retirePendingInputs();
        for (const [callId, step] of stepsByCall) {
          if (step.state === "pending" || step.state === "awaiting") {
            stepsByCall.set(callId, { ...step, state: "canceled" });
          }
        }
        break;
      }
      // Durable model history dropped (the Clear context action). The
      // transcript stays readable; only the agent's memory of it is gone.
      case "context.cleared":
        contextCleared = true;
        retirePendingInputs();
        break;
      case "step.failed":
      case "turn.failed":
      case "session.failed":
        error = event.data.message;
        break;
      default:
        break;
    }
  }

  // A stream still in flight at the end of the frames IS the reply so far.
  // A cancelled turn's partial text is FINAL — freeze it (no blinking caret)
  // the moment `turn.cancelled` lands, without waiting for the status frame.
  if (streamText !== null && reply === null) {
    reply = {
      text: streamText,
      streaming: !canceled && (status === "running" || status === "queued"),
    };
  }

  const active = !canceled && (status === "queued" || status === "running");
  const steps = [...stepsByCall.values()];
  const hasBlock =
    steps.length > 0 || narration.length > 0 || reasoning !== null;

  let elapsedSeconds: number | null = null;
  const first = store.frames[0];
  const last = store.frames[store.frames.length - 1];
  if (first !== undefined && last !== undefined && first !== last) {
    const ms = Date.parse(last.at) - Date.parse(first.at);
    if (Number.isFinite(ms) && ms >= 0) {
      elapsedSeconds = Math.max(1, Math.round(ms / 1000));
    }
  }

  // Pending inputs only matter while the run is parked or still active —
  // a terminal run has nothing left to answer. `turn.cancelled` already
  // retired them above; this also covers a run whose status settled first.
  const pendingInputs =
    !canceled && (status === "waiting" || active)
      ? [...pendingByRequest.values()].map((entry) => entry.view)
      : [];

  return {
    runId: run.id,
    status,
    userMessage,
    block: hasBlock
      ? { steps, narration, reasoning, elapsedSeconds, active }
      : null,
    reply,
    pendingInputs,
    // Error surfaces only when the run actually failed — a step that failed
    // mid-run but recovered must not leave a stale banner, and a CANCELLED
    // run is not a failure at all (it emits no failure event to read).
    error: status === "failed" ? (error ?? "Run failed") : null,
    modelId,
    canceled: canceled || status === "canceled",
    contextCleared,
  };
}
