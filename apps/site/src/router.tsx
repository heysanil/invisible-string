import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * The one router config, shared by the browser entry (`main.tsx`) and the
 * prerender entry (`entry-server.tsx`).
 *
 * Two `createRouter` calls that drift on `basepath` or preloading are the
 * classic cause of hydration mismatches in a hand-rolled SSG, so there is
 * exactly one call site. The server passes a memory history and disables
 * preloading (there is no pointer to hover); everything else is identical.
 */
export function createSiteRouter(options?: {
  history?: RouterHistory;
  defaultPreload?: false;
}) {
  return createRouter({
    routeTree,
    // `basepath` from Vite's `BASE_URL` (driven by SITE_BASE) so a subpath
    // deploy routes correctly with the same one knob.
    basepath: import.meta.env.BASE_URL,
    defaultPreload: options?.defaultPreload === false ? false : "intent",
    history: options?.history,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createSiteRouter>;
  }
}
