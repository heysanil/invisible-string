/**
 * One WORK SEGMENT of a run: a collapsible glass box whose body is a
 * chronological rail of thought and tool items. Live segments default open,
 * cap their body height and tail-follow; a segment auto-folds the moment a
 * later segment exists (`sealed` — i.e. the agent started speaking) or the
 * run stops being live. A manual toggle wins for the life of the mount.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Circle, Loader2, Minus, Pause, X } from "lucide-react";

import type { ThoughtItem, ToolItem, WorkSegment } from "../../lib/chat/run-view";
import { cn } from "../../lib/cn";

const STEP_STATE_LABEL: Record<ToolItem["state"], string> = {
  ok: "succeeded",
  error: "failed",
  rejected: "rejected",
  awaiting: "awaiting approval",
  canceled: "stopped",
  pending: "running",
};

function ToolIcon({ state }: { state: ToolItem["state"] }) {
  switch (state) {
    case "ok":
      return <Check size={13} strokeWidth={2.4} className="text-ok" aria-hidden="true" />;
    case "error":
      return <X size={13} strokeWidth={2.4} className="text-err" aria-hidden="true" />;
    case "rejected":
      return <X size={13} strokeWidth={2.4} className="text-ink-4" aria-hidden="true" />;
    case "awaiting":
      return <Pause size={13} strokeWidth={2.2} className="text-warn" aria-hidden="true" />;
    // Stopped before it settled — a user decision, so neutral ink, never red.
    case "canceled":
      return <Minus size={13} strokeWidth={2.4} className="text-ink-4" aria-hidden="true" />;
    default:
      return <Loader2 size={13} className="animate-spin text-ink-4" aria-hidden="true" />;
  }
}

/** Shared rail geometry: a 1px spine at left-1.5 with a wash-filled node. */
function RailRow({ node, children }: { node: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="relative pl-[21px] before:absolute before:left-[6px] before:top-0 before:bottom-0 before:w-px before:bg-black/10 first:before:top-2 last:before:bottom-auto last:before:h-2">
      <span className="absolute left-0 top-0.5 flex size-[13px] items-center justify-center rounded-full bg-[#f2f2f5]">
        {node}
      </span>
      {children}
    </li>
  );
}

function ThoughtRow({ item }: { item: ThoughtItem }) {
  const label = item.streaming
    ? "Thinking"
    : item.seconds !== null
      ? `Thought for ${item.seconds}s`
      : "Thought";
  return (
    <RailRow node={<Circle size={9} className="fill-ink-4 text-ink-4" aria-hidden="true" />}>
      <div className="pb-3">
        <p className="mb-0.5 text-[11px] font-semibold text-ink-3">{label}</p>
        <p className="text-[12.5px] leading-relaxed text-ink-3">{item.text}</p>
      </div>
    </RailRow>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  return (
    <RailRow node={<ToolIcon state={item.state} />}>
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pb-3">
        <span className="font-mono text-[12px] text-ink">{item.toolName}</span>
        <span className="sr-only">{STEP_STATE_LABEL[item.state]}</span>
        {item.resultPreview !== null ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12px]",
              item.state === "error" ? "text-err"
                : item.state === "awaiting" ? "text-warn-ink"
                  : "text-ink-3",
            )}
          >
            {item.resultPreview}
          </span>
        ) : null}
      </span>
    </RailRow>
  );
}

/** Live elapsed counter. The reducer is pure and only re-runs on frames, so a
 *  silently-thinking model would freeze a frame-derived clock — this ticks
 *  from the segment's own start instead. Client-clock skew is accepted. */
function useElapsed(startedAt: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || startedAt === null) return null;
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function WorkingBlock({ segment }: { segment: WorkSegment }) {
  const [open, setOpen] = useState(segment.active);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Auto-fold when a later segment appears (the agent started speaking) or the
  // run stops being live — unless the reader has taken manual control.
  useEffect(() => {
    if (touched) return;
    setOpen(segment.active);
  }, [segment.active, touched]);

  // Tail-follow while live, but never yank a reader who scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || !segment.active || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [segment.items, segment.active]);

  const elapsed = useElapsed(segment.startedAt, segment.active);
  const stepLabel = segment.items.length === 1 ? "1 step" : `${segment.items.length} steps`;
  const summary = segment.active
    ? "Working"
    : segment.waiting
      ? "Waiting on you"
      : segment.elapsedSeconds !== null
        ? `Worked for ${segment.elapsedSeconds}s · ${stepLabel}`
        : `Worked · ${stepLabel}`;

  return (
    <div className="my-1.5 overflow-hidden rounded-card border border-black/[0.06] bg-white/35">
      <button
        type="button"
        onClick={() => { setTouched(true); setOpen((v) => !v); }}
        aria-expanded={open}
        className="lift flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.02]"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn("shrink-0 text-ink-4 transition-transform duration-200 ease-out", open && "rotate-90")}
        />
        {segment.active ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
        ) : null}
        <span className="text-[12.5px] font-medium text-ink-2">{summary}</span>
        {elapsed !== null ? (
          <span className="ml-auto text-[11.5px] tabular-nums text-ink-4">{elapsed}</span>
        ) : null}
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
              "border-t border-black/[0.05] px-3 pb-2.5 pt-2",
              // The cap serves STREAMING (it stops a long thought shoving the
              // composer down). Reading a finished run gets full height.
              segment.active && "max-h-[210px] overflow-y-auto",
            )}
          >
            <ul className="flex flex-col">
              {segment.items.map((item) =>
                item.kind === "thought" ? (
                  <ThoughtRow key={item.key} item={item} />
                ) : (
                  <ToolRow key={item.key} item={item} />
                ),
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
