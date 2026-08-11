import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { prerender } from "react-dom/static";

import { docEntries } from "./lib/docs";
import { inlineResolvedSuspense } from "./lib/suspense-inline";
import { createSiteRouter } from "./router";

/**
 * Re-exported so scripts/prerender.ts derives its page list from the same
 * glob the sidebar uses. A new .mdx file is prerendered on the next build
 * with no registry edit anywhere.
 */
export { docEntries };

/** Guards against a redirect loop between routes rather than hanging forever. */
const MAX_REDIRECTS = 10;

/**
 * Render one route to HTML.
 *
 * `prerender()` from react-dom/static, NOT renderToString/renderToStaticMarkup:
 * doc bodies are `React.lazy(() => import('…mdx'))` (see routes/docs.$.tsx),
 * and neither of those APIs actually waits for a suspended component — both
 * silently resolve with its fallback instead (verified directly: neither
 * throws or rejects). `prerender()` is the one API that genuinely waits for
 * every Suspense boundary to settle before resolving, which is the only safe
 * contract for a page whose content must always be complete.
 *
 * That completeness guarantee is about *content*, not *placement*:
 * `@tanstack/react-router`'s `<Outlet>` unconditionally wraps routed content
 * in `<Suspense>` under the root route (not configurable via any route
 * option), and `prerender()` preserves that boundary's streaming markup even
 * when nothing inside it ever actually suspends. `inlineResolvedSuspense`
 * (lib/suspense-inline.ts) collapses that markup back into flat,
 * hydration-compatible HTML — see its own doc comment for the full
 * mechanics, including why it splices in `<!--$-->…<!--/$-->` rather than
 * bare content: `main.tsx` mounts via `createRoot` today, but the moment a
 * future task switches it to `hydrateRoot`, those markers are exactly what
 * `hydrateRoot` matches a `<Suspense>` boundary against — bare content would
 * make every routed page fail to hydrate and get silently discarded and
 * re-rendered client-side.
 *
 * `prerender()`'s "waits for everything" guarantee does not, on its own, mean
 * the result is safe to ship: two failure modes still resolve normally rather
 * than reject, so both are checked explicitly below.
 *
 *  1. A component that throws inside a Suspense boundary is *recoverable* as
 *     far as React is concerned — the boundary resolves as `<!--$!-->` plus
 *     the fallback, and `prerender()`'s promise still fulfills. The `onError`
 *     option is the only way to observe this; without it, the failure is
 *     invisible except as a stack trace on stderr that looks like console
 *     noise, not a build failure.
 *  2. A route's `beforeLoad` throwing a `redirect()` (e.g. `/docs` →
 *     `/docs/getting-started/overview`, docs.index.tsx) leaves
 *     `router.load()` resolving with `router.state.matches` empty and
 *     `router.state.redirect` set, rather than throwing — nothing renders,
 *     and the naive result is `""`. Since this is a same-origin route
 *     redirect the router already knows how to resolve, the useful behavior
 *     is to follow it and render the destination, not merely fail; a generic
 *     empty-output check below still catches any other cause the two checks
 *     above don't anticipate.
 *
 * Returns the children of `#root` only; scripts/prerender.ts wraps them in the
 * built index.html template.
 */
export async function renderPage(path: string): Promise<string> {
  return renderResolvedPage(path, []);
}

async function renderResolvedPage(path: string, redirectChain: readonly string[]): Promise<string> {
  const router = createSiteRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPreload: false,
    // Emits the root Suspense boundary the browser renders but this build
    // cannot — see `PrerenderRootSuspense` in router.tsx. Without it every
    // page fails to hydrate and is thrown away client-side.
    prerendering: true,
  });

  await router.load();

  const redirectResponse = router.state.redirect;
  if (redirectResponse) {
    const location = redirectResponse.headers.get("location");
    if (!location) {
      throw new Error(`renderPage: ${path} redirected with no Location header`);
    }
    if (redirectChain.length >= MAX_REDIRECTS || redirectChain.includes(path)) {
      throw new Error(
        `renderPage: redirect loop rendering ${path} (chain: ${[...redirectChain, path, location].join(" -> ")})`,
      );
    }
    return renderResolvedPage(location, [...redirectChain, path]);
  }

  const renderErrors: unknown[] = [];
  const { prelude } = await prerender(<RouterProvider router={router} />, {
    onError(error) {
      renderErrors.push(error);
    },
  });
  if (renderErrors.length > 0) {
    throw new AggregateError(renderErrors, `renderPage: ${path} threw while rendering`);
  }

  const html = await new Response(prelude).text();
  const inlined = inlineResolvedSuspense(html);

  if (inlined.trim().length === 0) {
    throw new Error(`renderPage: ${path} rendered empty output`);
  }

  return inlined;
}
