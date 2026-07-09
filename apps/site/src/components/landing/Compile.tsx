import { Check } from "lucide-react";
import { motion } from "motion/react";

import { EASE, Reveal, SectionHeading } from "./parts";

/* A monospace glass terminal that "types on" as it scrolls into view: the real
   build pipeline (compile → eve build → tarball → content hash) ending in the
   app's real microcopy, "Published and built.", with a green status dot. The
   version chip ws_v_a1b2c3 is where the thread exits this section. */

const STEPS = [
  "compile pillars → agent project",
  "eve build → .output/server",
  "tarball → object store",
  "content hash → ws_v_a1b2c3",
] as const;

const list = {
  hidden: {},
  show: { transition: { staggerChildren: 0.32, delayChildren: 0.15 } },
};
const row = {
  hidden: { opacity: 0, x: -6 },
  show: { opacity: 1, x: 0, transition: { duration: 0.26, ease: EASE } },
};

export function Compile() {
  return (
    <section className="site-container section-block">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <SectionHeading
          align="left"
          eyebrow="Compile"
          title="Publish builds a real agent."
          lede="Not orchestration glue over an API. Each publish compiles a standalone, version-pinned agent artifact — the same eve build the platform runs in production."
        />

        <Reveal delay={0.1}>
          <div className="glass-panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
              <span aria-hidden className="term-dot" />
              <span aria-hidden className="term-dot" />
              <span aria-hidden className="term-dot" />
              <span className="ml-2 font-mono text-[11.5px] text-ink-4">
                eve build · issue-triage
              </span>
            </div>

            <motion.div
              variants={list}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: "-60px" }}
              className="terminal-line px-4 py-3.5 text-ink-2"
            >
              <motion.div variants={row} className="text-ink-3">
                <span className="text-ink-4">$</span> eve build issue-triage
              </motion.div>
              {STEPS.map((step) => (
                <motion.div key={step} variants={row} className="flex items-center gap-2">
                  <Check size={13} className="text-ink-3" aria-hidden />
                  <span>{step}</span>
                </motion.div>
              ))}
              <motion.div
                variants={row}
                className="mt-2 flex items-center gap-2 border-t border-hairline pt-2.5 text-ink"
              >
                <span aria-hidden className="size-1.5 rounded-full bg-ok" />
                <span className="font-medium">Published and built.</span>
                <span className="mono-chip ml-auto">ws_v_a1b2c3</span>
              </motion.div>
            </motion.div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
