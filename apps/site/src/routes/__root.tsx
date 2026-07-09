import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";

import { SiteFooter } from "../components/SiteFooter";
import { SiteNav } from "../components/SiteNav";
import { Wash } from "../components/Wash";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    // Global motion contract: honor the user's reduced-motion setting; the
    // shared tokens.css also clamps animation durations as a belt-and-braces.
    // reducedMotion="user" makes every whileInView entrance render its final
    // state statically for users who ask for less motion.
    <MotionConfig reducedMotion="user">
      <Wash />
      <div className="flex min-h-full flex-col">
        <SiteNav />
        <main className="flex-1">
          <Outlet />
        </main>
        <SiteFooter />
      </div>
    </MotionConfig>
  );
}

/** Designed not-found (root-level, catches unknown top-level paths). */
function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="eyebrow">404</p>
      <h1 className="text-display-2">Nothing threaded here.</h1>
      <p className="max-w-sm text-ink-3">
        That page doesn&rsquo;t exist. Follow the thread back to the start.
      </p>
      <Link
        to="/"
        className="lift mt-2 text-sm font-medium text-ink underline underline-offset-4"
      >
        Back to home
      </Link>
    </div>
  );
}
