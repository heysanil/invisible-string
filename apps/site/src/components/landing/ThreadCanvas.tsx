import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";
import type { RefObject } from "react";

/**
 * THE INVISIBLE STRING.
 *
 * A single 1px hairline ink thread that unwinds from the hero spool and draws
 * itself down the entire page as you scroll, weaving behind every section, and
 * winds back into the footer spool. Engineered as one full-height, absolutely
 * positioned SVG layer sitting *behind* the section content (pointer-events
 * none), so the weave passes under each glass island and reads as one
 * continuous string tying the page together.
 *
 * Mechanism: `useScroll` on the landing container yields a 0→1 progress value;
 * a `motion.path`'s `pathLength` is bound to it, so the stroke literally draws
 * from the spool downward in lockstep with the scroll. A faint static "ghost"
 * of the full thread underlies the drawn portion ("low opacity rising to
 * full"). `preserveAspectRatio="none"` stretches the path to the container's
 * true height (which is fluid); `vector-effect: non-scaling-stroke` keeps the
 * thread a crisp hairline regardless of that scaling.
 *
 * Desktop weaves wide; a separate near-straight path is shown ≤ md so the
 * mobile thread simplifies to a centered hairline. Under reduced motion the
 * thread renders fully drawn (pathLength = 1), statically.
 */
export function ThreadCanvas({
  targetRef,
}: {
  targetRef: RefObject<HTMLDivElement | null>;
}) {
  const reduced = useReducedMotion() ?? false;
  const { scrollYProgress } = useScroll({
    target: targetRef,
    offset: ["start start", "end end"],
  });
  // Smooth the scroll so the draw glides rather than snaps.
  const smooth = useSpring(scrollYProgress, {
    stiffness: 90,
    damping: 30,
    restDelta: 0.001,
  });
  const pathLength = reduced ? 1 : smooth;

  // Desktop serpentine: gentle bends, roughly one per section, spool→spool.
  const desktopPath =
    "M 500 0 " +
    "C 500 220, 250 300, 240 520 " +
    "S 780 780, 760 950 " +
    "S 300 1230, 300 1400 " +
    "S 740 1680, 720 1850 " +
    "S 280 2130, 280 2300 " +
    "S 760 2560, 740 2750 " +
    "S 340 2980, 360 3150 " +
    "S 500 3420, 500 3600";

  // Mobile: a near-straight centered hairline with the faintest drift.
  const mobilePath =
    "M 500 0 C 500 800, 540 1400, 500 1900 S 470 3000, 500 3600";

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1000 3600"
      preserveAspectRatio="none"
      fill="none"
    >
      {/* Ghost: the full thread at whisper opacity, always present. */}
      <path
        className="hidden md:block"
        d={desktopPath}
        stroke="var(--ink)"
        strokeOpacity={0.05}
        strokeWidth={1.25}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="md:hidden"
        d={mobilePath}
        stroke="var(--ink)"
        strokeOpacity={0.05}
        strokeWidth={1.25}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* Drawn thread: pathLength follows scroll. */}
      <motion.path
        className="hidden md:block"
        d={desktopPath}
        stroke="var(--thread)"
        strokeWidth={1.5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ pathLength }}
      />
      <motion.path
        className="md:hidden"
        d={mobilePath}
        stroke="var(--thread)"
        strokeWidth={1.5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ pathLength }}
      />
    </svg>
  );
}
