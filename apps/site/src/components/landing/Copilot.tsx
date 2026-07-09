import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Sparkles, Zap } from "lucide-react";

import { cn } from "../../lib/cn";
import { EASE, Reveal, SectionHeading, Vignette } from "./parts";
import { useLoopPhase } from "./useLoopPhase";

/* "Build it by talking." The user asks to trigger the workflow from Slack; the
   copilot replies with a structured mutation card (Manual → Slack) with Apply /
   Dismiss capsules; Apply presses itself; the card collapses to a receipt and
   the Trigger pillar card flashes (the app's real pillar-flash keyframe). */

const PHASES = [1500, 1400, 2200, 900, 2800] as const;

export function Copilot() {
  const phase = useLoopPhase(PHASES);

  const typing = phase === 1;
  const cardVisible = phase >= 2;
  const applying = phase === 3;
  const applied = phase >= 4;

  return (
    <section className="site-container section-block">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <SectionHeading
          align="left"
          eyebrow="Copilot"
          title="Build it by talking."
          lede="Tell the copilot what you want changed, in plain language. It proposes the edit, shows you the before and after, and waits — you Apply or Dismiss. Nothing changes behind your back."
        />

        <Reveal delay={0.1}>
          <Vignette
            label="A user asks the copilot to trigger the workflow from Slack; the copilot proposes the change, Apply is pressed, and the Trigger card updates to Slack."
            className="flex flex-col gap-3 p-4"
          >
            <div className="ml-auto max-w-[80%] rounded-card rounded-br-sm bg-ink px-3 py-1.5 text-[12.5px] text-white">
              Trigger this from Slack instead.
            </div>

            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-2">
                <Sparkles size={13} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="wait">
                  {typing ? (
                    <motion.div
                      key="typing"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="stream-caret pt-1 text-[12.5px] text-ink-3"
                    >
                      Sure — switching the trigger
                    </motion.div>
                  ) : cardVisible ? (
                    <motion.div
                      key="card"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, ease: EASE }}
                    >
                      {applied ? (
                        <div className="flex items-center gap-1.5 rounded-card border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[12px] text-ink-3">
                          <Check size={13} className="shrink-0 text-ok" aria-hidden />
                          <span>Applied — Set trigger to Slack</span>
                        </div>
                      ) : (
                        <MutationCard applying={applying} />
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="think"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="pt-1 text-[12.5px] text-ink-4"
                    >
                      Thinking…
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* The Trigger pillar card that flashes when the mutation lands. */}
            <div className="mt-1 border-t border-hairline pt-3">
              <div
                key={applied ? "flash" : "idle"}
                className={cn(
                  "flex items-center gap-2 rounded-card border border-black/10 bg-white/55 p-2.5",
                  applied && "pillar-flash",
                )}
              >
                <Zap size={14} aria-hidden />
                <span className="flex-1 text-[12.5px] font-semibold text-ink">Trigger</span>
                <span
                  className={cn(
                    "rounded-capsule px-2 py-0.5 text-[11px] font-medium transition-colors ease-[var(--ease-out)]",
                    applied ? "bg-ink text-white" : "bg-black/[0.06] text-ink-3",
                  )}
                >
                  {applied ? "Slack" : "Manual"}
                </span>
              </div>
            </div>
          </Vignette>
        </Reveal>
      </div>
    </section>
  );
}

function MutationCard({ applying }: { applying: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-black/[0.09] bg-white/60 p-3 shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-2">
          <Zap size={13} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-ink">Set trigger to Slack</p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            Runs will start from Slack mentions and messages.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-card border border-black/[0.07] bg-white/45 px-2.5 py-1.5 text-[12px]">
        <span className="text-ink-3 line-through decoration-ink-3/50">Manual</span>
        <ArrowRight size={12} aria-hidden className="text-ink-4" />
        <span className="font-medium text-ink">Slack</span>
      </div>

      <div className="flex items-center gap-2">
        <motion.span
          animate={applying ? { scale: [1, 0.94, 1] } : { scale: 1 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="inline-flex h-7 items-center gap-1 rounded-capsule bg-ink px-3 text-[12px] font-medium text-white"
        >
          <Check size={12} aria-hidden /> Apply
        </motion.span>
        <span className="inline-flex h-7 items-center gap-1 rounded-capsule border border-black/10 bg-white/50 px-3 text-[12px] font-medium text-ink-2">
          Dismiss
        </span>
      </div>
    </div>
  );
}
