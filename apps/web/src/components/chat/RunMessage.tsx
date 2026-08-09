/**
 * One run rendered in the thread: the inbound user/trigger message bubble
 * (ink), then the run's segments IN THE ORDER THE AGENT PRODUCED THEM — a
 * work segment as a collapsible rail box, a speech segment as markdown prose
 * — then inline HITL cards, a failure banner, and the Stop control. Mid-run
 * narration therefore renders where it happened instead of being hoisted
 * below every tool call.
 *
 * STOP IS NOT A FAILURE. eve 0.31 answers a stop with `turn.cancelled` →
 * `session.waiting`, never a failure event, so a stopped run renders in
 * neutral ink (E1: color only as meaning) with whatever it had already
 * produced left intact and readable.
 */
import { memo, useCallback } from "react";
import { AlertCircle, Ban, Square } from "lucide-react";

import type { RunInputRequest } from "@invisible-string/shared";

import type { RunView } from "../../lib/chat/run-view";
import { Button } from "../ui/Button";
import { ApprovalCard } from "./ApprovalCard";
import { ContextDivider } from "./ContextDivider";
import { Markdown } from "./Markdown";
import { WorkingBlock } from "./WorkingBlock";

export interface RunMessageProps {
  run: RunView;
  /** Trigger origin — a chat run shows the user bubble, others a trigger note. */
  isChatOrigin: boolean;
  /** Stable across renders so memoized rows bail out (runId is passed back). */
  onRespond: (runId: string, response: RunInputRequest) => void;
  /** Stop the in-flight turn (queued/running/waiting). Stable identity. */
  onCancel?: (runId: string) => void;
  /** True while this run's stop request is in flight (disables the button). */
  canceling?: boolean;
  /** requestId → the response being submitted (optimistic). */
  pendingInput?: { requestId: string; optionId?: string; text?: string } | null;
  inputError?: string | null;
}

function RunMessageImpl({
  run,
  isChatOrigin,
  onRespond,
  onCancel,
  canceling,
  pendingInput,
  inputError,
}: RunMessageProps) {
  // `run.canceled` comes off the event stream, so it flips a beat BEFORE the
  // run_status frame — the spinner, caret and Stop button all settle together
  // rather than lingering for a round trip.
  const isActive = !run.canceled && (run.status === "queued" || run.status === "running");
  // A parked (waiting) run can also be stopped — it holds the session's one
  // run slot until it is answered. The ONE exception is a session-limit
  // prompt: its own "Stop" option already cancels this turn through the same
  // path, and two adjacent Stops that mean the same thing is worse than one.
  const onLimitPrompt = run.pendingInputs.some(
    (input) => input.kind === "session-limit",
  );
  const cancelable =
    !run.canceled && !onLimitPrompt && (isActive || run.status === "waiting");
  const handleRespond = useCallback(
    (response: RunInputRequest) => onRespond(run.runId, response),
    [onRespond, run.runId],
  );
  const handleCancel = useCallback(
    () => onCancel?.(run.runId),
    [onCancel, run.runId],
  );
  return (
    <div className="flex flex-col gap-1.5">
      {/* Inbound message */}
      {isChatOrigin ? (
        <div className="flex justify-end">
          {/* The composer is a markdown editor, so the author's own text has
              to come back as prose — echoing raw `**stars**` at the person who
              typed bold would be the migration's most visible regression.
              `.md-on-ink` inverts the renderer's tokens for the dark bubble;
              the margin trims collapse the prose's outer block spacing into
              the bubble's own padding. */}
          <div className="max-w-[80%] break-words rounded-[16px] rounded-br-md bg-ink px-3.5 py-2 text-white [overflow-wrap:anywhere]">
            <Markdown
              text={run.userMessage}
              className="md-on-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-ink-3">
          Triggered · <span className="text-ink-2">{run.userMessage}</span>
        </p>
      )}

      {/* Agent activity — announced to assistive tech while the run streams so a
          screen-reader user hears the working-block status and the reply as
          they arrive. Polite = never interrupts; aria-busy = still producing. */}
      <div
        className="flex flex-col"
        aria-live={isActive ? "polite" : undefined}
        aria-busy={isActive || undefined}
        aria-relevant="additions text"
      >
        {run.segments.map((segment) =>
          segment.kind === "work" ? (
            <WorkingBlock key={segment.key} segment={segment} />
          ) : (
            <Markdown key={segment.key} text={segment.text} streaming={segment.streaming} />
          ),
        )}

        {run.pendingInputs.map((input) => (
          <ApprovalCard
            key={input.requestId}
            input={input}
            onRespond={handleRespond}
            pending={
              pendingInput?.requestId === input.requestId
                ? { optionId: pendingInput.optionId, text: pendingInput.text }
                : null
            }
            error={pendingInput?.requestId === input.requestId ? inputError : null}
          />
        ))}

        {run.error !== null ? (
          <div
            role="alert"
            className="my-1.5 flex items-start gap-2 rounded-card border border-err/35 bg-err/[0.05] px-3 py-2 text-[13px] text-ink"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0 text-err" aria-hidden="true" />
            <span className="min-w-0">{run.error}</span>
          </div>
        ) : null}

        {/* Stopping is a deliberate user action, not an error — confirm it in
            neutral ink (E1: color only as meaning) so a half-finished reply
            never reads as a glitch. eve stops at the next durable step
            boundary, so a tool already running finishes; the session itself
            stays usable, which is the reassurance that matters here. */}
        {run.canceled ? (
          <div className="my-1.5 flex items-start gap-2 rounded-card border border-black/[0.08] bg-black/[0.03] px-3 py-2 text-[13px] text-ink-2">
            <Ban size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
            <span className="min-w-0">
              You stopped this run. A step already underway finished, and
              anything above is kept — send another message to carry on.
            </span>
          </div>
        ) : null}

        {/* Clear/compact landed while this run's tail was attached. */}
        {run.contextCleared ? <ContextDivider kind="cleared" /> : null}

        {/* An active run with no output yet still needs a presence cue. */}
        {run.segments.length === 0 && run.pendingInputs.length === 0 && run.error === null &&
        isActive ? (
          <p className="py-1 text-[12.5px] text-ink-4">Thinking…</p>
        ) : null}

        {onCancel && cancelable ? (
          <div className="pt-1">
            <Button variant="ghost" size="sm" loading={canceling} onClick={handleCancel}>
              {!canceling ? <Square size={11} strokeWidth={2.6} aria-hidden="true" /> : null}
              {canceling ? "Stopping…" : "Stop"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Memoized so a settled row does not re-render on every streamed token of the
 * newest run. Bails out when its RunView (referentially stable per run via
 * ThreadContainer's cache) and its optimistic-input props are unchanged.
 */
export const RunMessage = memo(RunMessageImpl);
