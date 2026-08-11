import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { type ReactNode, Suspense } from "react";

import { routeTree } from "./routeTree.gen";

/**
 * Supplies, during prerender only, the root `<Suspense>` boundary the BROWSER
 * will render — so the emitted HTML is something `hydrateRoot` can adopt.
 *
 * `Matches` (@tanstack/react-router) picks its root wrapper like this:
 *
 *   (isServer ?? router.isServer) || (typeof document !== "undefined" && router.ssr)
 *     ? SafeFragment : React.Suspense
 *
 * and `isServer` is NOT a runtime check — it is a module constant chosen by
 * package export condition (`@tanstack/router-core/isServer`): `true` under
 * the `node`/`bun` condition that `vite build --ssr` leaves the router to be
 * resolved with, `false` under `browser`. So the prerendered HTML carries no
 * root boundary while the browser insists on one, and React refuses the
 * hydration outright ("server rendered HTML didn't match the client",
 * `<Suspense fallback={null}>` vs `<div class="wash">`), throwing away every
 * page scripts/prerender.ts produced and re-rendering it client-side.
 *
 * `InnerWrap` is the documented seam for this: it wraps `Matches`' output
 * without rendering DOM of its own, so a `<Suspense>` here emits exactly the
 * `<!--$-->…<!--/$-->` marker pair the client's own boundary hydrates against.
 * `fallback={null}` matches the client's, which is `defaultPendingComponent`
 * — unset for this app.
 *
 * Two rejected alternatives, both verified broken, so they don't get retried:
 *  - Setting `router.ssr` (what TanStack Start's `hydrate()` does) makes the
 *    BROWSER skip the boundary instead. It silences the mismatch and leaves
 *    the app dead: the route chunk is never fetched and the routed component
 *    never renders, so the page is inert static HTML.
 *  - Resolving the SSR build with `browser` conditions (`ssr.noExternal` +
 *    `ssr.resolve.conditions`) gets `isServer === false` honestly, then dies
 *    in `RouterCore`'s constructor on `window is not defined` — the browser
 *    build wants a DOM, which is exactly what this prerender refuses to fake.
 */
function PrerenderRootSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

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
  /** Set ONLY by `entry-server.tsx` — see `PrerenderRootSuspense`. */
  prerendering?: true;
}) {
  return createRouter({
    routeTree,
    // `basepath` from Vite's `BASE_URL` (driven by SITE_BASE) so a subpath
    // deploy routes correctly with the same one knob.
    basepath: import.meta.env.BASE_URL,
    defaultPreload: options?.defaultPreload === false ? false : "intent",
    history: options?.history,
    InnerWrap: options?.prerendering ? PrerenderRootSuspense : undefined,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createSiteRouter>;
  }
}
