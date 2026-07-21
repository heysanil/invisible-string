import { AnimatePresence, motion } from "motion/react";
import { Check, Gauge, Plug, Rocket, UserRound } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { StatusChip } from "../ui";
import { EASE } from "./parts";
import { useLoopPhase } from "./useLoopPhase";

/*
 * Hero centerpiece — a hand-built, vector-sharp miniature of the real agent
 * editor, looping autonomously (~12s, calm): an agent comes together as its three
 * definition cards (Persona · Model · Context) fill in one by one and flip to
 * a green ✓, "Publish" presses itself → "Published and built." → the agent
 * goes on duty and a chat panel streams a working block that folds to a
 * "Worked for 6s · 4 steps" receipt. Built entirely from E1 primitives — no
 * screenshots.
 */

// Phase timeline (ms). Parked on the last phase under reduced motion.
const PHASES = [900, 1000, 1000, 1100, 1400, 1500, 2200, 2600] as const;

type SectionKey = "persona" | "model" | "context";

const SECTIONS: ReadonlyArray<{
  key: SectionKey;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** phase at which this card fills in */
  fillAt: number;
  summary: ReactNode;
}> = [
  {
    key: "persona",
    label: "Persona",
    icon: UserRound,
    fillAt: 1,
    summary: (
      <span className="block truncate text-ink-3">
        Pragmatic senior engineer. Reads before it writes.
      </span>
    ),
  },
  {
    key: "model",
    label: "Model",
    icon: Gauge,
    fillAt: 2,
    summary: (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ink-2">Balanced</span>
        <span className="text-[11px] text-ink-3">good for everyday work</span>
      </span>
    ),
  },
  {
    key: "context",
    label: "Context",
    icon: Plug,
    fillAt: 3,
    summary: (
      <span className="flex flex-wrap gap-1">
        <span className="rounded-capsule bg-black/[0.06] px-1.5 py-0.5 text-[11px] text-ink">
          GitHub
        </span>
        <span className="rounded-capsule bg-black/[0.06] px-1.5 py-0.5 text-[11px] text-ink">
          web-search
        </span>
      </span>
    ),
  },
];

export function AgentVignette() {
  const phase = useLoopPhase(PHASES);

  const publishReady = phase >= 3;
  const building = phase === 4;
  const published = phase >= 5;
  const streaming = phase === 6;
  const worked = phase >= 7;

  return (
    <div className="grid gap-3 p-3 sm:p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      {/* Left: agent editor rail + publish */}
      <div className="glass-panel flex flex-col gap-2 rounded-panel-sm bg-white/45 p-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[13px] font-semibold text-ink">
            Software engineer
          </span>
          <StatusChip tone={published ? "ok" : "neutral"} dot>
            {published ? "Published" : "Draft"}
          </StatusChip>
        </div>

        <div className="flex flex-col gap-2">
          {SECTIONS.map((s) => (
            <SectionCard key={s.key} section={s} filled={phase >= s.fillAt} />
          ))}
        </div>

        <PublishRow building={building} published={published} ready={publishReady} />
      </div>

      {/* Right: chat / run stream */}
      <div className="glass-panel flex flex-col gap-2.5 rounded-panel-sm bg-white/45 p-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-[12px] font-medium text-ink-3">Chat</span>
          {/* Always mounted (opacity fade) so the agent going on duty never
              reflows the header row. */}
          <motion.span
            animate={{ opacity: published ? 1 : 0 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <StatusChip tone="ok" dot>
              On duty
            </StatusChip>
          </motion.span>
        </div>

        <div className="ml-auto max-w-[85%] rounded-card rounded-br-sm bg-ink px-3 py-1.5 text-[12.5px] text-white">
          A GitHub issue came in — triage it.
        </div>

        {/* All three states stacked in one grid cell: the tallest ("worked")
            reserves the region's height permanently, so phase swaps are pure
            opacity — the panel (and the page below it) never moves. */}
        <div className="grid">
          <motion.div
            animate={{ opacity: streaming ? 1 : 0, y: streaming ? 0 : 6 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="col-start-1 row-start-1 h-fit max-w-[90%] rounded-card rounded-bl-sm border border-black/[0.06] bg-white/60 px-3 py-2 text-[12.5px] text-ink-2"
          >
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
              <span aria-hidden className="dot-pulse size-1.5 rounded-full bg-ok" />
              Working
            </div>
            <span className={cn(streaming && "stream-caret")}>
              Read the issue, searched the repo, drafted a reply
            </span>
          </motion.div>
          <motion.div
            animate={{ opacity: worked ? 1 : 0, y: worked ? 0 : 6 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="col-start-1 row-start-1 flex flex-col gap-2"
          >
            <div className="inline-flex w-fit items-center gap-1.5 rounded-capsule border border-black/[0.06] bg-white/55 px-2.5 py-1 text-[11.5px] text-ink-3">
              <Check size={12} className="text-ok" aria-hidden />
              Worked for 6s · 4 steps
            </div>
            <div className="max-w-[90%] rounded-card rounded-bl-sm border border-black/[0.06] bg-white/60 px-3 py-2 text-[12.5px] leading-snug text-ink-2">
              Replied in-thread and labelled the issue{" "}
              <span className="mono-chip">needs-repro</span>.
            </div>
          </motion.div>
          <motion.div
            animate={{ opacity: streaming || worked ? 0 : 1 }}
            className="col-start-1 row-start-1 flex items-start px-1 pt-1 text-[12px] text-ink-4"
          >
            Building the agent…
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  section,
  filled,
}: {
  section: (typeof SECTIONS)[number];
  filled: boolean;
}) {
  const Icon = section.icon;
  return (
    <div
      className={cn(
        "rounded-card border p-2.5 transition-colors duration-200 ease-[var(--ease-out)]",
        filled
          ? "border-black/10 bg-white/70"
          : "border-dashed border-black/10 bg-white/25",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} aria-hidden />
        <span className="flex-1 text-[12.5px] font-semibold text-ink">
          {section.label}
        </span>
        <AnimatePresence mode="wait">
          {filled ? (
            <motion.span
              key="check"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="text-ok"
            >
              <Check size={14} aria-hidden />
            </motion.span>
          ) : (
            <span
              key="dot"
              className="size-1.5 rounded-full bg-ink-4/40"
              aria-hidden
            />
          )}
        </AnimatePresence>
      </div>
      {/* Always mounted so the card's height never changes — the summary slot
          is reserved up front and only fades in (no height animation, which
          would shift the whole page as the loop fills cards in). */}
      <motion.div
        animate={{ opacity: filled ? 1 : 0, y: filled ? 0 : 4 }}
        transition={{ duration: 0.28, ease: EASE }}
        className="pt-1.5 text-[11.5px] leading-snug text-ink-3"
      >
        {section.summary}
      </motion.div>
    </div>
  );
}

function PublishRow({
  building,
  published,
  ready,
}: {
  building: boolean;
  published: boolean;
  ready: boolean;
}) {
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-black/[0.06] pt-2.5">
      {/* Banner slot is always mounted (fades in) so publishing never grows
          the panel and shifts the page. */}
      <motion.div
        animate={{ opacity: published ? 1 : 0, y: published ? 0 : 4 }}
        transition={{ duration: 0.28, ease: EASE }}
        className="flex items-center gap-1.5 rounded-card border border-ok/30 bg-ok/[0.06] px-2.5 py-1.5"
      >
        <Check size={13} className="text-ok" aria-hidden />
        <span className="text-[12px] text-ink-2">Published and built.</span>
      </motion.div>
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden
        animate={building ? { scale: [1, 0.96, 1] } : { scale: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
        className={cn(
          "inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-capsule text-[12.5px] font-medium",
          published
            ? "bg-ok/12 text-ok"
            : ready
              ? "bg-ink text-white"
              : "bg-black/[0.06] text-ink-4",
        )}
      >
        {building ? (
          <span aria-hidden className="spinner size-3.5" />
        ) : (
          <Rocket size={13} aria-hidden />
        )}
        {published ? "Published" : building ? "Building…" : "Publish"}
      </motion.button>
    </div>
  );
}
