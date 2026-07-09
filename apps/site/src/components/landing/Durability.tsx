import { Check } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "../../lib/cn";
import { StatusChip } from "../ui";
import { EASE, Reveal, SectionHeading, Vignette } from "./parts";
import { useLoopPhase } from "./useLoopPhase";

/* Durability theater — the platform's hardest-won feature, dramatized. A run
   streams on worker A; worker A dies (desaturates, run parks amber); the run
   token reroutes to worker B (shared-layout slide); the stream resumes; green
   ✓. Postgres-backed durability = any worker can resume a parked run. */

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
    if (phase === 2) return { tone: "warn", label: "Rerouting", kind: "dot" };
    if (phase === 3) return { tone: "ok", label: "Running", kind: "pulse" };
    return { tone: "ok", label: "Succeeded", kind: "check" };
  })();

  return (
    <section className="site-container section-block">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <SectionHeading
          align="left"
          eyebrow="Durability"
          title="Kill a worker mid-run. The run survives."
          lede="Runs are durable in Postgres, not pinned to a process. When a worker dies, another picks the run up exactly where it parked — no lost steps, no restart."
        />

        <Reveal delay={0.1}>
          <Vignette
            label="A run streaming on worker A; worker A dies and the run parks; it reroutes to worker B and resumes, finishing successfully."
            className="p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-ink">
                Run · issue-triage #128
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
                name="worker-a"
                down={aDown}
                active={!runOnB}
                streaming={phase === 0}
                done={false}
              />
              <WorkerCard
                name="worker-b"
                down={false}
                active={runOnB}
                streaming={bStreaming}
                done={done}
                idle={!runOnB}
              />
            </div>

            <p className="mt-3 min-h-[1.25rem] text-[12px] text-ink-3">
              {phase === 1
                ? "worker-a stopped heartbeating — the run is fenced and parked."
                : phase === 2
                  ? "Scheduler hands the parked run to a live worker…"
                  : done
                    ? "Resumed on worker-b and finished. No steps lost."
                    : "Streaming steps, checkpointed to Postgres."}
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
            parked
          </StatusChip>
        ) : done ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ok">
            <Check size={12} aria-hidden /> done
          </span>
        ) : streaming ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <span aria-hidden className="dot-pulse size-1.5 rounded-full bg-ok" />
            streaming
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
