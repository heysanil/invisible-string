/**
 * One WORK SEGMENT of a copilot turn: a collapsible glass box whose body is a
 * chronological rail of thought and tool-step rows (2026-08-11 spec D7.1).
 *
 * This is deliberately the SAME visual grammar as the main chat's
 * `components/chat/WorkingBlock.tsx` — rail-in-box, open while live, auto-fold
 * on seal, a manual toggle that wins for the life of the mount — rendered at
 * the dock's tighter scale (a 260–320px rail, not a thread column). The two
 * are separate components rather than one shared primitive on purpose for now:
 * they read different view models (`WorkSegment` vs {@link CopilotThreadItem}),
 * their headers differ (the chat's counts elapsed seconds from run frames; the
 * copilot has no run), and the chat's copy is being reworked in parallel.
 * Extracting the shared rail geometry is a follow-up, not a fork.
 *
 * What the rail shows is what has NO card: the model's thinking, and tool
 * calls the server rejected and the model then self-corrected. Mutation steps
 * are filtered out upstream (`visibleTimelineItems`) because their suggestion
 * card is a strictly richer rendering of the same call.
 */
import { Check, ChevronRight, Circle, Loader2, Minus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  CopilotStepItem,
  CopilotThoughtItem,
  CopilotTimelineItem,
} from "../../lib/copilot/thread";
import { cn } from "../../lib/cn";

const STEP_STATE_LABEL: Record<CopilotStepItem["state"], string> = {
  ok: "succeeded",
  error: "failed",
  canceled: "stopped",
  pending: "running",
};

function StepIcon({ state }: { state: CopilotStepItem["state"] }) {
  switch (state) {
    case "ok":
      return <Check size={12} strokeWidth={2.4} className="text-ok" aria-hidden="true" />;
    case "error":
      return <X size={12} strokeWidth={2.4} className="text-err" aria-hidden="true" />;
    // Stopped before it settled — a user decision, so neutral ink, never red.
    case "canceled":
      return <Minus size={12} strokeWidth={2.4} className="text-ink-4" aria-hidden="true" />;
    default:
      return <Loader2 size={12} className="animate-spin text-ink-4" aria-hidden="true" />;
  }
}

/** Shared rail geometry: a 1px spine at left-1.5 with a wash-filled node. */
function RailRow({
  node,
  children,
}: {
  node: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pl-[19px] before:absolute before:left-[5px] before:top-0 before:bottom-0 before:w-px before:bg-black/10 first:before:top-2 last:before:bottom-auto last:before:h-2">
      <span className="absolute left-0 top-0.5 flex size-[12px] items-center justify-center rounded-full bg-[#f2f2f5]">
        {node}
      </span>
      {children}
    </li>
  );
}

function ThoughtRow({ item }: { item: CopilotThoughtItem }) {
  return (
    <RailRow
      node={<Circle size={8} className="fill-ink-4 text-ink-4" aria-hidden="true" />}
    >
      <div className="pb-2.5">
        <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-4">
          {item.streaming ? "Thinking" : "Thought"}
        </p>
        <p className="text-[12px] leading-relaxed text-ink-3">{item.text}</p>
      </div>
    </RailRow>
  );
}

function StepRow({ item }: { item: CopilotStepItem }) {
  return (
    <RailRow node={<StepIcon state={item.state} />}>
      <span className="flex flex-col gap-0.5 pb-2.5">
        <span className="text-[12px] text-ink">{item.label}</span>
        <span className="sr-only">{STEP_STATE_LABEL[item.state]}</span>
        {item.resultPreview !== null ? (
          <span
            className={cn(
              "text-[11.5px] leading-snug",
              item.state === "error" ? "text-err" : "text-ink-3",
            )}
          >
            {item.resultPreview}
          </span>
        ) : null}
      </span>
    </RailRow>
  );
}

export interface CopilotWorkBlockProps {
  items: readonly CopilotTimelineItem[];
  /** Still accepting rows — spinner, open by default, capped + tail-following. */
  active: boolean;
}

export function CopilotWorkBlock({ items, active }: CopilotWorkBlockProps) {
  const [open, setOpen] = useState(active);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Auto-fold when the segment seals (the copilot started speaking, or the
  // turn ended) — unless the reader has taken manual control.
  useEffect(() => {
    if (touched) return;
    setOpen(active);
  }, [active, touched]);

  // Tail-follow while live, but never yank a reader who scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || !active || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, active]);

  const stepCount = items.filter((item) => item.kind === "step").length;
  const summary = active
    ? "Thinking"
    : stepCount === 0
      ? "Thought"
      : `Worked · ${stepCount === 1 ? "1 step" : `${stepCount} steps`}`;

  return (
    <div
      data-testid="copilot-work"
      className="overflow-hidden rounded-card border border-black/[0.06] bg-white/35"
    >
      <button
        type="button"
        onClick={() => {
          setTouched(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="lift flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-black/[0.02]"
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-4 transition-transform duration-200 ease-out",
            open && "rotate-90",
          )}
        />
        {active ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
        ) : null}
        <span className="text-[12px] font-medium text-ink-2">{summary}</span>
      </button>

      {/* grid-rows 0fr↔1fr so the block eases closed instead of popping out of
          the tree. The global prefers-reduced-motion guard zeroes it. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className={cn(
              "border-t border-black/[0.05] px-2.5 pb-2 pt-1.5",
              // The cap serves STREAMING (it stops a long thought shoving the
              // composer down). Reading a finished turn gets full height.
              active && "thin-scroll max-h-[170px] overflow-y-auto",
            )}
          >
            <ul className="flex flex-col">
              {items.map((item) =>
                item.kind === "thought" ? (
                  <ThoughtRow key={item.key} item={item} />
                ) : (
                  <StepRow key={item.key} item={item} />
                ),
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
