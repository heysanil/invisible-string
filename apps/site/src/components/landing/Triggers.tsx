import { Clock, Hash, MessageCircle, SquarePen, Webhook } from "lucide-react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef, type ComponentType } from "react";

import { LogoMark } from "../LogoMark";
import { EASE, Reveal, SectionHeading } from "./parts";

/* "Fired from anywhere." Five trigger chips fan in along hairline wires that
   converge on the workflow node; a single ink pulse sweeps each wire. Sublabels
   are the trigger editor's real microcopy. */

const TRIGGERS: ReadonlyArray<{
  label: string;
  sub: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { label: "Chat", sub: "Start runs from chat or the builder.", icon: MessageCircle },
  { label: "Webhook", sub: "An HTTP POST with a JSON payload starts a run.", icon: Webhook },
  { label: "Form", sub: "A shareable form submits fields to each run.", icon: SquarePen },
  { label: "Slack", sub: "Mentions and messages in Slack trigger runs.", icon: Hash },
  { label: "Schedule", sub: "A cron schedule runs the workflow automatically.", icon: Clock },
];

/* Wire start points: chip centers of five equal-height rows (percent of the
   column height); every wire converges on the node at the vertical center. */
const WIRE_YS = [10, 30, 50, 70, 90];

export function Triggers() {
  const sectionRef = useRef<HTMLElement>(null);
  // Only run the JS-driven wire pulses while the section is on-screen.
  const inView = useInView(sectionRef, { margin: "-80px" });

  return (
    <section ref={sectionRef} className="site-container section-block">
      <SectionHeading
        eyebrow="Triggers"
        title="Fired from anywhere."
        lede="The same compiled agent answers to five doors. Wire up as many as you like — each run carries its trigger's payload."
      />

      <div className="mt-12 grid items-center gap-4 md:grid-cols-[minmax(0,22rem)_1fr_auto] md:gap-0">
        <div className="flex flex-col gap-2.5">
          {TRIGGERS.map((t, i) => {
            const Icon = t.icon;
            return (
              <Reveal key={t.label} delay={i * 0.06}>
                <div className="glass-panel flex items-center gap-3 rounded-card-lg bg-white/45 px-3.5 py-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-card bg-black/[0.05] text-ink">
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink">{t.label}</span>
                    <span className="block text-[11.5px] leading-snug text-ink-3">{t.sub}</span>
                  </span>
                </div>
              </Reveal>
            );
          })}
        </div>

        <FanIn active={inView} />

        <Reveal delay={0.2} className="flex justify-center md:justify-start">
          <div className="glass-panel flex flex-col items-center gap-2 rounded-panel px-8 py-7 text-center">
            <span className="flex size-11 items-center justify-center rounded-panel-sm bg-ink text-white">
              <LogoMark size={22} />
            </span>
            <span className="text-[13px] font-semibold text-ink">Workflow</span>
            <span className="text-[11.5px] text-ink-4">one compiled agent</span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** The fan-in: one SVG spanning the gap, five hairline paths converging from
 *  the chip centers to the node. Each path carries a short ink pulse swept via
 *  strokeDashoffset (stroke props, not transform) on the one E1 easing, gated
 *  by `active` so the infinite repeats don't run off-screen; under reduced
 *  motion only the static hairlines render. `preserveAspectRatio="none"` +
 *  `vector-effect: non-scaling-stroke` keeps the strokes crisp 1px while the
 *  curves stretch to the layout. */
function FanIn({ active }: { active: boolean }) {
  const reduced = useReducedMotion() ?? false;
  return (
    // Absolutely positioned SVG inside a self-stretch wrapper: the fan always
    // matches the row height (set by the chip column) and can never drive
    // layout itself (a %-height SVG would fall back to its 1:1 viewBox ratio).
    <div aria-hidden className="relative hidden self-stretch px-1 md:block">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        fill="none"
      >
        {WIRE_YS.map((y, i) => {
          const d = `M 0 ${y} C 48 ${y}, 55 50, 100 50`;
          return (
            <g key={y}>
              <path d={d} stroke="var(--ink)" strokeOpacity={0.13} vectorEffect="non-scaling-stroke" />
              {reduced || !active ? null : (
                <motion.path
                  d={d}
                  pathLength={1}
                  stroke="var(--ink)"
                  strokeOpacity={0.55}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="0.07 0.93"
                  initial={{ strokeDashoffset: 1 }}
                  animate={{ strokeDashoffset: 0 }}
                  transition={{ duration: 2.2, ease: EASE, repeat: Infinity, delay: i * 0.28 }}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
