/**
 * One run rendered in the thread: the inbound user/trigger message bubble
 * (ink), the collapsible working block, the streamed assistant reply
 * (markdown), inline HITL approval cards, and a failure banner.
 */
import { memo, useCallback } from "react";
import { AlertCircle, X } from "lucide-react";

import type { RunInputRequest } from "@invisible-string/shared";

import type { RunView } from "../../lib/chat/run-view";
import { cn } from "../../lib/cn";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { WorkingBlock } from "./WorkingBlock";

export interface RunMessageProps {
  run: RunView;
  /** Trigger origin — a chat run shows the user bubble, others a trigger note. */
  isChatOrigin: boolean;
  /** Stable across renders so memoized rows bail out (runId is passed back). */
  onRespond: (runId: string, response: RunInputRequest) => void;
  /** Cancel an in-flight run (queued/running/waiting). Stable identity. */
  onCancel?: (runId: string) => void;
  /** True while this run's cancel request is in flight (disables the button). */
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
  const showReply = run.reply !== null;
  const isActive = run.status === "queued" || run.status === "running";
  // A parked (waiting) run can also be cancelled — it holds a slot until answered.
  const cancelable = isActive || run.status === "waiting";
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
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-[16px] rounded-br-md bg-ink px-3.5 py-2 text-sm text-white [overflow-wrap:anywhere]">
            {run.userMessage}
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
        {run.block !== null ? <WorkingBlock block={run.block} /> : null}

        {showReply ? (
          <div className={cn(run.reply?.streaming && "stream-caret")}>
            <Markdown text={run.reply!.text} />
          </div>
        ) : null}

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

        {/* An active run with no output yet still needs a presence cue. */}
        {run.block === null && !showReply && run.pendingInputs.length === 0 && run.error === null &&
        isActive ? (
          <p className="py-1 text-[12.5px] text-ink-4">Thinking…</p>
        ) : null}

        {onCancel && cancelable ? (
          <div className="pt-1">
            <button
              type="button"
              onClick={handleCancel}
              disabled={canceling}
              className={cn(
                "lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/60 px-2.5 py-1 text-[12px] font-medium text-ink-2",
                "hover:border-err/40 hover:text-err disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              <X size={12} aria-hidden="true" />
              {canceling ? "Cancelling…" : "Cancel run"}
            </button>
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
