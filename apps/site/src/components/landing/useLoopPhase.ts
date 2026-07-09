import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Drives a slow, calm, autonomous vignette loop. Given a stable array of
 * per-phase durations (ms), returns the current phase index and advances
 * through them on a wrapping timer.
 *
 * Under `prefers-reduced-motion` the loop never starts: it parks on the LAST
 * phase so every vignette renders its final, fully-resolved state statically
 * (the E1 reduced-motion contract). Pass a MODULE-LEVEL constant array so its
 * identity is stable across renders.
 */
export function useLoopPhase(durations: readonly number[]): number {
  const reduced = useReducedMotion() ?? false;
  const lastPhase = durations.length - 1;
  const [phase, setPhase] = useState(reduced ? lastPhase : 0);

  useEffect(() => {
    if (reduced) {
      setPhase(lastPhase);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let i = 0;
    setPhase(0);

    const tick = () => {
      timer = setTimeout(
        () => {
          if (cancelled) return;
          i = (i + 1) % durations.length;
          setPhase(i);
          tick();
        },
        durations[i] ?? 1000,
      );
    };
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduced, durations, lastPhase]);

  return phase;
}
