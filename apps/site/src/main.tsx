import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { createSiteRouter } from "./router";
import "./index.css";

const router = createSiteRouter();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

// hydrateRoot, not createRoot: scripts/prerender.ts has already written this
// page's markup into #root. React adopts it rather than rebuilding it, which
// is what keeps the prerendered content on screen through first paint.
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
router.load().then(() => {
  hydrateRoot(
    rootElement,
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
