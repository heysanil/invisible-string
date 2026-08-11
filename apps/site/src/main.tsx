import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { createSiteRouter } from "./router";
import "./index.css";

const router = createSiteRouter();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

/**
 * How long to wait for `router.load()` before hydrating regardless. Generous:
 * the only thing being waited on is a same-origin route chunk that is already
 * in flight, so this is a ceiling on a wedged load, not a normal-path budget.
 */
const LOAD_TIMEOUT_MS = 10_000;

// hydrateRoot, not createRoot: scripts/prerender.ts has already written this
// page's markup into #root, and React adopts that markup instead of rebuilding
// it.
//
// What that does and does NOT buy, precisely, because the difference is easy
// to overstate: on /docs/** and /404 the prerendered content is visible from
// first paint and hydration leaves it alone. On the LANDING page it is present
// but transparent — the entrance animations render their initial state, so
// dist/index.html ships 35 inline `opacity:0` styles including both hero <h1>
// spans at `opacity:0;filter:blur(7px)`, and the middle of the page stays
// blank until the reveal animations run. That is a deliberate tradeoff, not an
// oversight: the text is in the HTML (so crawlers read it) and index.html's
// <noscript> block forces the final state for clients that never animate.
// Emitting the settled state instead would mean giving up the landing
// entrance animations, which is a design decision, not a build one.
//
// Hydration is deferred behind `router.load()` because it has to be. A fresh
// router has no matches, and `MatchesInner` reads them synchronously off the
// store during render — so hydrating immediately renders NOTHING under the
// root boundary while the prerendered HTML holds the whole page, and React
// discards every byte of it ("server rendered HTML didn't match the client")
// and re-renders client-side. `load()` resolves the matches AND their route
// chunks first, so React's first pass produces the same tree the prerender
// did. This is a promise chain rather than top-level `await` so the entry
// needs no TLA support from the build target.
//
// Hydrate no matter how that load turns out — including its not turning out at
// all. An unhandled rejection, or a `loadPromise` that simply never settles,
// would otherwise leave the page permanently un-hydrated and SILENT: inert
// markup, no error boundary, no fallback, nothing in the console. Hydrating
// anyway is the right failure mode because its worst case is the behaviour
// this task replaced — React finds a tree it cannot match, discards the
// prerendered markup and client-renders the page — which is a working site.
// A dead one is not.
Promise.race([
  router.load().catch((error: unknown) => {
    console.error("[site] router.load() failed; hydrating anyway", error);
  }),
  new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
]).then(() => {
  hydrateRoot(
    rootElement,
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
