import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, FileText, Plug, Rocket, Zap } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { StatusChip } from "../ui";
import { EASE } from "./parts";
import { useLoopPhase } from "./useLoopPhase";

/*
 * Hero centerpiece — a hand-built, vector-sharp miniature of the real builder,
 * looping autonomously (~13s, calm): a workflow comes together as the four
 * pillar cards fill in one by one and flip to a green ✓, "Publish" presses
 * itself → "Published and built." → a chat panel streams a working block that
 * folds to a "Worked for 6s · 4 steps" receipt. Built entirely from E1
 * primitives — no screenshots.
 */

// Phase timeline (ms). Parked on the last phase under reduced motion.
const PHASES = [900, 900, 900, 900, 1100, 1400, 1500, 2200, 2600] as const;

type PillarKey = "trigger" | "context" | "agent" | "instructions";

const PILLARS: ReadonlyArray<{
  key: PillarKey;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** phase at which this card fills in */
  fillAt: number;
  summary: ReactNode;
}> = [
  {
    key: "trigger",
    label: "Trigger",
    icon: Zap,
    fillAt: 1,
    summary: (
      <span className="flex items-center gap-1.5">
        <StatusChip tone="ink">Slack</StatusChip>
        <span className="truncate text-ink-3">mentions &amp; messages</span>
      </span>
    ),
  },
  {
    key: "context",
    label: "Context",
    icon: Plug,
    fillAt: 2,
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
  {
    key: "agent",
    label: "Agent",
    icon: Bot,
    fillAt: 3,
    summary: (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ink-2">Balanced</span>
        <span className="text-[11px] text-ink-3">good for everyday work</span>
      </span>
    ),
  },
  {
    key: "instructions",
    label: "Instructions",
    icon: FileText,
    fillAt: 4,
    summary: (
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-ink-3">Triage the issue, reply in-thread.</span>
        <span className="text-[11px] text-ink-4">3 lines · 1 @ref</span>
      </span>
    ),
  },
];

export function BuilderVignette() {
  const phase = useLoopPhase(PHASES);

  const publishReady = phase >= 4;
  const building = phase === 5;
  const published = phase >= 6;
  const streaming = phase === 7;
  const worked = phase >= 8;

  return (
    <div className="grid gap-3 p-3 sm:p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      {/* Left: pillar rail + publish */}
      <div className="glass-panel flex flex-col gap-2 rounded-panel-sm bg-white/45 p-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[13px] font-semibold text-ink">Issue triage</span>
          <StatusChip tone={published ? "ok" : "neutral"} dot>
            {published ? "Published" : "Draft"}
          </StatusChip>
        </div>

        <div className="flex flex-col gap-2">
          {PILLARS.map((p) => (
            <PillarCard key={p.key} pillar={p} filled={phase >= p.fillAt} />
          ))}
        </div>

        <PublishRow building={building} published={published} ready={publishReady} />
      </div>

      {/* Right: chat / run stream */}
      <div className="glass-panel flex flex-col gap-2.5 rounded-panel-sm bg-white/45 p-3">
        <div className="px-1 text-[12px] font-medium text-ink-3">Chat</div>

        <div className="ml-auto max-w-[85%] rounded-card rounded-br-sm bg-ink px-3 py-1.5 text-[12.5px] text-white">
          A GitHub issue came in — triage it.
        </div>

        <div className="min-h-[92px]">
          <AnimatePresence mode="wait">
            {streaming ? (
              <motion.div
                key="streaming"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.24, ease: EASE }}
                className="max-w-[90%] rounded-card rounded-bl-sm border border-black/[0.06] bg-white/60 px-3 py-2 text-[12.5px] text-ink-2"
              >
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
                  <span aria-hidden className="dot-pulse size-1.5 rounded-full bg-ok" />
                  Working
                </div>
                <span className="stream-caret">
                  Read the issue, searched the repo, drafted a reply
                </span>
              </motion.div>
            ) : worked ? (
              <motion.div
                key="worked"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: EASE }}
                className="flex flex-col gap-2"
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
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full items-center px-1 text-[12px] text-ink-4"
              >
                Describing the workflow…
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function PillarCard({
  pillar,
  filled,
}: {
  pillar: (typeof PILLARS)[number];
  filled: boolean;
}) {
  const Icon = pillar.icon;
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
          {pillar.label}
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
      <AnimatePresence>
        {filled ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: 0.28, ease: EASE }}
            className="overflow-hidden pt-1.5 text-[11.5px] leading-snug text-ink-3"
          >
            {pillar.summary}
          </motion.div>
        ) : null}
      </AnimatePresence>
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
      <AnimatePresence>
        {published ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="flex items-center gap-1.5 rounded-card border border-ok/30 bg-ok/[0.06] px-2.5 py-1.5"
          >
            <Check size={13} className="text-ok" aria-hidden />
            <span className="text-[12px] text-ink-2">Published and built.</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
