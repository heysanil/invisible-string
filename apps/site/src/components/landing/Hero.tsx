import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";

import { LogoMark } from "../LogoMark";
import { BuilderVignette } from "./BuilderVignette";
import { btnGhostLg, btnPrimaryLg, EASE, GithubGlyph, Vignette } from "./parts";

const GITHUB_URL = "https://github.com/heysanil/invisible-string";

/* Staggered line-rise with a one-shot blur-to-sharp "ink settles" entrance.
   Filter-blur here is a single sub-400ms transition on TEXT (never on glass /
   backdrop-filter), and MotionConfig neutralizes it under reduced motion. */
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};
const line = {
  hidden: { opacity: 0, y: 18, filter: "blur(7px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.38, ease: EASE },
  },
};

export function Hero() {
  return (
    <section className="site-container flex flex-col items-center pt-28 text-center sm:pt-32">
      {/* The spool the string unwinds from. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="mb-7 flex size-14 items-center justify-center rounded-panel-sm text-ink"
      >
        <LogoMark size={40} />
      </motion.div>

      <motion.h1
        variants={container}
        initial="hidden"
        animate="show"
        className="text-display-1 text-balance"
      >
        <motion.span variants={line} className="block">
          Describe the work,
        </motion.span>
        <motion.span variants={line} className="block">
          consider it done.
        </motion.span>
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.28 }}
        className="mt-6 max-w-2xl text-lede text-ink-2"
      >
        Describe what you want done, in plain language. It becomes a workflow
        that runs from chat, Slack, forms, or a schedule — live, reliable, and
        yours to approve.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.36 }}
        className="mt-9 flex flex-wrap items-center justify-center gap-3"
      >
        <Link to="/docs" className={btnPrimaryLg}>
          Read the docs
          <ArrowRight size={17} aria-hidden />
        </Link>
        <a href={GITHUB_URL} className={btnGhostLg}>
          <GithubGlyph size={17} />
          View on GitHub
        </a>
      </motion.div>

      {/* Centerpiece vignette. */}
      <motion.div
        initial={{ opacity: 0, y: 26 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.46 }}
        className="mt-16 w-full max-w-4xl sm:mt-20"
      >
        <Vignette
          label="A workflow comes together — trigger, context, agent, instructions — is published, then handles a request in chat in six seconds."
          className="p-0"
        >
          <BuilderVignette />
        </Vignette>
      </motion.div>
    </section>
  );
}
