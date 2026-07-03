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
 */
import type {
  EveInputRequest,
  EveJsonValue,
  EveStreamEvent,
  RunDto,
  RunEventFrame,
  RunStatus,
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

export type StepState = "pending" | "awaiting" | "ok" | "error" | "rejected";

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
  /** Tool the approval gates (null for pure questions). */
  toolName: string | null;
  /** Tool input args, pre-rendered as compact JSON for the card. */
  argsPreview: string | null;
  options: readonly { id: string; label: string; style?: string }[];
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

function pendingInputFromRequest(request: EveInputRequest): PendingInputView {
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    toolName: request.action?.toolName ?? null,
    argsPreview: previewValue(request.action?.input ?? null),
    options: (request.options ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      style: option.style,
    })),
    allowFreeform: request.allowFreeform ?? false,
    display: request.display ?? (request.options?.length ? "select" : "text"),
  };
}

/**
 * Reduce a run + its frames to the thread view model.
 *
 * `statusOverride` lets the live layer apply a fresher `run_status` frame
 * than the fetched row carries.
 */
export function reduceRunView(
  run: Pick<RunDto, "id" | "status" | "triggerEvent" | "error">,
  store: FrameStore,
  statusOverride?: RunStatus,
): RunView {
  const status = statusOverride ?? run.status;
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

  const resolveInputsForCall = (callId: string) => {
    for (const [requestId, entry] of pendingByRequest) {
      if (entry.callId === callId) pendingByRequest.delete(requestId);
    }
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
  if (streamText !== null && reply === null) {
    reply = { text: streamText, streaming: status === "running" || status === "queued" };
  }

  const active = status === "queued" || status === "running";
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
  // a terminal run has nothing left to answer.
  const pendingInputs =
    status === "waiting" || active
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
    // mid-run but recovered must not leave a stale banner.
    error: status === "failed" ? (error ?? "Run failed") : null,
    modelId,
  };
}
