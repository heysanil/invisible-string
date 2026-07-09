import { motion } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/** The single E1 easing curve — used for every landing transition. */
export const EASE = [0.22, 0.61, 0.36, 1] as const;

/* Button class strings for router `Link`s (which can't be the site's <button>
   `Button`). Mirror the E1 Button idiom at landing scale. */
const BTN_BASE =
  "lift inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-capsule font-medium";
export const btnPrimaryLg = cn(
  BTN_BASE,
  "h-12 px-6 text-[15px] bg-ink text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)] hover:shadow-[0_6px_18px_rgba(0,0,0,0.22)]",
);
export const btnGhostLg = cn(
  BTN_BASE,
  "h-12 px-6 text-[15px] border border-black/10 bg-white/40 text-ink hover:border-black/15 hover:bg-white/70",
);

/**
 * Scroll-entrance wrapper: rises + fades in once when it enters the viewport.
 * `whileInView` + `viewport={{ once: true }}`; under reduced motion MotionConfig
 * collapses the transition so the final state renders statically.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 16,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** GitHub mark (lucide 1.x dropped brand icons). Monochrome `currentColor`,
 *  so it stays on-system in the ink palette. */
export function GithubGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.62 8.2 11.18.6.12.82-.26.82-.57v-2.03c-3.34.72-4.04-1.58-4.04-1.58-.55-1.37-1.34-1.74-1.34-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.22 1.84 1.22 1.07 1.78 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.16-.13-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 0 1 3-.4c1.02 0 2.05.14 3 .4 2.29-1.53 3.3-1.21 3.3-1.21.66 1.65.24 2.87.12 3.17.77.82 1.24 1.87 1.24 3.16 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.82.57C20.57 21.91 24 17.49 24 12.29 24 5.78 18.63.5 12 .5Z" />
    </svg>
  );
}

/** Section kicker + heading + optional lede, centered by default. */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "center",
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <Reveal
      className={cn(
        "flex flex-col gap-3",
        align === "center" ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="max-w-2xl text-balance text-[clamp(1.75rem,3.6vw,2.75rem)] font-[660] leading-[1.08] tracking-[-0.025em]">
        {title}
      </h2>
      {lede ? (
        <p
          className={cn(
            "max-w-xl text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed text-ink-3",
            align === "center" && "mx-auto",
          )}
        >
          {lede}
        </p>
      ) : null}
    </Reveal>
  );
}

/** A framed, labelled product vignette. The frame carries the aria-label that
 *  describes what the (aria-hidden) animation depicts, so the loop stays
 *  accessible without narrating every frame. */
export function Vignette({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="img" aria-label={label} className="glass-panel vignette">
      {/* Layout classes apply here so callers' padding/flex actually wrap the
          children (the frame itself carries no padding). */}
      <div aria-hidden="true" className={className}>
        {children}
      </div>
    </div>
  );
}
