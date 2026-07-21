import { Check } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "../../lib/cn";
import { StatusChip } from "../ui";
import { EASE, Reveal, SectionHeading, Vignette } from "./parts";
import { useLoopPhase } from "./useLoopPhase";

/* Reliability, dramatized — it finishes what it starts. A run works on server
   one; server one goes down (desaturates, run parks amber); the run token
   slides to server two (shared-layout slide); it resumes exactly where it left
   off; green ✓. Every step is saved the moment it happens, so any server can
   pick a parked run back up. */

const PHASES = [2200, 1700, 1500, 2000, 2600] as const;

export function Durability() {
  const phase = useLoopPhase(PHASES);

  const aDown = phase >= 1;
  const runOnB = phase >= 2;
  const bStreaming = phase === 3;
  const done = phase >= 4;

  const session = ((): {
    tone: "ok" | "warn";
    label: string;
    kind: "pulse" | "check" | "dot";
  } => {
    if (phase === 0) return { tone: "ok", label: "Running", kind: "pulse" };
    if (phase === 1) return { tone: "warn", label: "Parked", kind: "dot" };
    if (phase === 2) return { tone: "warn", label: "Moving", kind: "dot" };
    if (phase === 3) return { tone: "ok", label: "Running", kind: "pulse" };
    return { tone: "ok", label: "Done", kind: "check" };
  })();

  return (
    <section className="site-container section-block">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <SectionHeading
          align="left"
          eyebrow="Reliability"
          title="It finishes what it starts."
          lede="Every step is saved the moment it happens. If the server running your agent dies mid-run, another picks up exactly where it left off — no lost work, no starting over."
        />

        <Reveal delay={0.1}>
          <Vignette
            label="A run in progress; the server running it goes down; the run moves to a healthy server, resumes where it left off, and finishes."
            className="p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-ink">
                Run · Issue triage
              </span>
              <StatusChip tone={session.tone} dot={session.kind === "dot"}>
                {session.kind === "pulse" ? (
                  <span
                    aria-hidden
                    className={cn(
                      "dot-pulse size-1.5 rounded-full",
                      session.tone === "ok" ? "bg-ok" : "bg-warn",
                    )}
                  />
                ) : null}
                {session.kind === "check" ? <Check size={11} aria-hidden /> : null}
                {session.label}
              </StatusChip>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <WorkerCard
                name="server one"
                down={aDown}
                active={!runOnB}
                streaming={phase === 0}
                done={false}
              />
              <WorkerCard
                name="server two"
                down={false}
                active={runOnB}
                streaming={bStreaming}
                done={done}
                idle={!runOnB}
              />
            </div>

            <p className="mt-3 min-h-[1.25rem] text-[12px] text-ink-3">
              {phase === 1
                ? "Server one just went down mid-run. The run is parked, safe — nothing lost."
                : phase === 2
                  ? "Handing the run to a healthy server…"
                  : done
                    ? "Picked up exactly where it left off — and finished. Nothing lost."
                    : "Working — every step saved as it goes."}
            </p>
          </Vignette>
        </Reveal>
      </div>
    </section>
  );
}

function WorkerCard({
  name,
  down,
  active,
  streaming,
  done,
  idle,
}: {
  name: string;
  down: boolean;
  active: boolean;
  streaming: boolean;
  done: boolean;
  idle?: boolean;
}) {
  return (
    <motion.div
      animate={{ opacity: down ? 0.5 : 1 }}
      transition={{ duration: 0.4, ease: EASE }}
      className={cn(
        // Opacity is the only animated prop; the "down" desaturation reads from
        // the warn border/bg swap, transitioned in CSS (no paint-filter tween).
        "rounded-card border p-3 transition-colors duration-300 ease-[var(--ease-out)]",
        down
          ? "border-warn/30 bg-warn/[0.05]"
          : active
            ? "border-ink/20 bg-white/70"
            : "border-black/[0.07] bg-white/35",
      )}
    >
      <div className="flex items-center gap-1.5">
        {active ? (
          <motion.span
            layoutId="run-token"
            transition={{ duration: 0.5, ease: EASE }}
            className="size-2 rounded-full bg-ink"
            aria-hidden
          />
        ) : null}
        <span className="font-mono text-[11.5px] text-ink-2">{name}</span>
      </div>
      <div className="mt-2 h-6">
        {down ? (
          <StatusChip tone="warn" dot>
            offline
          </StatusChip>
        ) : done ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ok">
            <Check size={12} aria-hidden /> done
          </span>
        ) : streaming ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <span aria-hidden className="dot-pulse size-1.5 rounded-full bg-ok" />
            working
          </span>
        ) : idle ? (
          <span className="text-[11.5px] text-ink-4">idle</span>
        ) : (
          <span className="text-[11.5px] text-ink-4">live</span>
        )}
      </div>
    </motion.div>
  );
}
