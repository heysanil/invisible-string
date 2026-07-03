/**
 * Thread main pane: header + virtualized run list + composer. The run list
 * is virtualized (design requirement — the glass panes must not repaint per
 * streamed token) via @tanstack/react-virtual with dynamic measurement, and
 * pins to the bottom while the newest run streams.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { RunInputRequest } from "@invisible-string/shared";

import type { RunView } from "../../lib/chat/run-view";
import { Composer } from "./Composer";
import { RunMessage } from "./RunMessage";
import { ThreadHeader, type ThreadHeaderProps } from "./ThreadHeader";

export interface ThreadViewProps {
  header: ThreadHeaderProps;
  runs: readonly RunView[];
  isChatOrigin: boolean;
  onRespond: (runId: string, response: RunInputRequest) => void;
  pendingInput?: {
    runId: string;
    requestId: string;
    optionId?: string;
    text?: string;
  } | null;
  inputError?: string | null;
  // Composer
  onSend: (message: string) => void;
  composerDisabledReason?: string | null;
  sending?: boolean;
  failedDraft?: string;
}

export function ThreadView({
  header,
  runs,
  isChatOrigin,
  onRespond,
  pendingInput,
  inputError,
  onSend,
  composerDisabledReason,
  sending,
  failedDraft,
}: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 4,
    getItemKey: (index) => runs[index]?.runId ?? index,
    // Fallback viewport size so the first range is non-empty before the
    // ResizeObserver reports real dimensions (browsers correct it on the
    // next frame; happy-dom reports 0 for layout boxes, so tests need this).
    initialRect: { width: 800, height: 600 },
  });

  // Track whether the user is pinned to the bottom (so streaming autoscrolls
  // but scrolling up to read history is respected).
  function onScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
  }

  // Autoscroll to the newest content while pinned. Runs on every render of the
  // run set (new frames grow the last item) — measurement drives real height.
  const lastRun = runs[runs.length - 1];
  const streamSignature =
    (lastRun?.reply?.text.length ?? 0) +
    (lastRun?.block?.steps.length ?? 0) * 1000 +
    (lastRun?.pendingInputs.length ?? 0) * 100;
  useLayoutEffect(() => {
    if (stickToBottom.current && runs.length > 0) {
      virtualizer.scrollToIndex(runs.length - 1, { align: "end" });
    }
  }, [runs.length, streamSignature, virtualizer]);

  // On first mount of a thread, jump to the bottom.
  useEffect(() => {
    stickToBottom.current = true;
    if (runs.length > 0) {
      virtualizer.scrollToIndex(runs.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.title]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col">
      <ThreadHeader {...header} />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div
          className="relative mx-auto w-full max-w-3xl px-5 py-4"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {items.map((item) => {
            const run = runs[item.index];
            if (run === undefined) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full px-5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className="pb-5">
                  <RunMessage
                    run={run}
                    isChatOrigin={isChatOrigin}
                    onRespond={(response) => onRespond(run.runId, response)}
                    pendingInput={
                      pendingInput?.runId === run.runId ? pendingInput : null
                    }
                    inputError={
                      pendingInput?.runId === run.runId ? inputError : null
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <Composer
          onSend={onSend}
          disabledReason={composerDisabledReason}
          sending={sending}
          initialValue={failedDraft}
        />
      </div>
    </div>
  );
}
