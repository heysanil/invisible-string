import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { prerender } from "react-dom/static";

import { docEntries, preloadDoc } from "./lib/docs";
import { createSiteRouter } from "./router";

/**
 * Re-exported so scripts/prerender.ts derives its page list from the same
 * glob the sidebar uses. A new .mdx file is prerendered on the next build
 * with no registry edit anywhere.
 */
export { docEntries };

/**
 * Render one route to HTML.
 *
 * `prerender()` from react-dom/static, NOT renderToString: doc bodies are
 * `React.lazy(() => import('…mdx'))` (see routes/docs.$.tsx), and
 * renderToString/renderToStaticMarkup don't wait for a suspended component —
 * they silently emit ITS FALLBACK instead (verified directly: neither throws,
 * both just render whatever was synchronously available). `prerender()` is
 * the one API that actually waits for every Suspense boundary to settle
 * before resolving, so it's the only safe choice for a page whose content
 * must always be complete — including if a future doc or component suspends
 * in some new way nothing here anticipated.
 *
 * That completeness guarantee is about *content*, not *placement*, and two
 * separate things need preloading before render so the render pass has as
 * few boundaries to resolve as possible:
 *
 *  1. `autoCodeSplitting` (vite.config.ts) wraps every route's OWN component
 *     in an internal lazy-loader, and `router.load()` deliberately does not
 *     resolve it on the server (TanStack Router only preloads a route's chunk
 *     for a match whose `ssr` option is `true`, and `match.ssr` is forced to
 *     `undefined` on the server regardless of that option). `loadRouteChunk`
 *     is the router's own API for resolving a route's component chunk ahead
 *     of render.
 *  2. Doc bodies are `React.lazy(() => import('…mdx'))` (routes/docs.$.tsx),
 *     which always suspends on its first touch even against an
 *     already-resolved dynamic import. `preloadDoc` warms lib/docs.ts's cache
 *     so `docs.$.tsx` mounts the already-resolved component directly instead.
 *
 * Even with both preloaded, one boundary remains and cannot be preloaded
 * away: `@tanstack/react-router`'s `<Outlet>` unconditionally wraps the
 * routed content in `<Suspense>` whenever it sits directly under the root
 * route (react-router's Match.js — not configurable via any route option).
 * `prerender()` preserves that boundary's streaming markup — a placeholder
 * comment pair, a `<template>`, the fallback, then the real content parked in
 * a hidden sibling `<div>` with a client-side swap `<script>` — even though
 * nothing inside it ever actually suspends: with both preloads above in
 * place, `renderToString()` on the identical tree emits no Suspense markers
 * at all, proving the content is fully synchronous by the time `prerender()`
 * sees it. `inlineResolvedSuspense` below collapses that always-already-
 * resolved streaming structure back into flat markup. This is a pure
 * reformatting pass, never a wait — `prerender()` has already done the
 * waiting — and it doesn't touch hydration, since `main.tsx` mounts via
 * `createRoot`, not `hydrateRoot`.
 *
 * Returns the children of `#root` only; scripts/prerender.ts wraps them in the
 * built index.html template.
 */
export async function renderPage(path: string): Promise<string> {
  const router = createSiteRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPreload: false,
  });

  await router.load();

  await Promise.all(
    router.state.matches
      .map((match) => router.looseRoutesById[match.routeId])
      .filter((route) => route !== undefined)
      .map((route) => router.loadRouteChunk(route)),
  );

  const docMatch = router.state.matches.find((match) => match.routeId === "/docs/$");
  if (docMatch) {
    const { _splat } = docMatch.params as { _splat?: string };
    await preloadDoc(_splat ?? "");
  }

  const { prelude } = await prerender(<RouterProvider router={router} />);
  const html = await new Response(prelude).text();
  return inlineResolvedSuspense(html);
}

/**
 * Index just past the `</div>` that closes the `<div ...>` whose content
 * starts at `contentStart`, matching nested `<div>`s by depth. A regex alone
 * can't do this safely — doc bodies are full of nested `<div>`s, so a
 * non-greedy match would stop at the first inner `</div>` rather than the
 * true closing tag.
 */
function findDivClose(html: string, contentStart: number): number {
  let depth = 1;
  let i = contentStart;
  while (depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose === -1) {
      throw new Error("inlineResolvedSuspense: unterminated <div>");
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + "<div".length;
    } else {
      depth--;
      i = nextClose + "</div>".length;
    }
  }
  return i;
}

/**
 * Collapses a `prerender()` Suspense boundary's streaming markup into flat
 * HTML, given the boundary is (per the contract `renderPage` relies on)
 * always fully resolved by the time this runs: the `<!--$?-->…<!--/$-->`
 * placeholder (containing an empty `<template id="B:N">` and the fallback UI)
 * is replaced by the real content already parked in `<div hidden
 * id="S:N">…</div>`, and the now-orphaned hidden div plus the client-side
 * swap `<script>`s (React's Fizz runtime globals — `$RB`/`$RC`/`$RT`/`$RV`)
 * are removed.
 *
 * Boundaries can nest — the doc body's own boundary sits inside the route
 * boundary's segment — so this resolves one boundary at a time against the
 * live string rather than in a single pass: a segment's captured content can
 * itself contain a still-unresolved nested placeholder, and splicing it in
 * exposes that placeholder at its new position for the next iteration to
 * find, while its own segment (not yet touched) is still sitting elsewhere in
 * the string waiting to be spliced in turn. A one-shot global replace can't
 * do this — it captures every segment against the *original* string, so an
 * outer segment's copy of an inner placeholder is never revisited, and the
 * inner segment ends up spliced in at its stale, now-orphaned position
 * instead of the outer segment's new one.
 */
function inlineResolvedSuspense(html: string): string {
  let out = html;
  const placeholderPattern = /<!--\$\?--><template id="B:(\d+)"><\/template>[\s\S]*?<!--\/\$-->/;

  for (;;) {
    const placeholder = placeholderPattern.exec(out);
    if (!placeholder) break;
    const num = placeholder[1];
    if (num === undefined) {
      throw new Error("inlineResolvedSuspense: boundary placeholder matched without a number");
    }

    const openTag = `<div hidden id="S:${num}">`;
    const segmentStart = out.indexOf(openTag, placeholder.index + placeholder[0].length);
    if (segmentStart === -1) {
      throw new Error(`inlineResolvedSuspense: no resolved segment for boundary B:${num}`);
    }
    const contentStart = segmentStart + openTag.length;
    const afterClose = findDivClose(out, contentStart);
    const content = out.slice(contentStart, afterClose - "</div>".length);

    out =
      out.slice(0, placeholder.index) +
      content +
      out.slice(placeholder.index + placeholder[0].length, segmentStart) +
      out.slice(afterClose);
  }

  // Strip the streaming swap-script boilerplate.
  return out.replace(/<script>[\s\S]*?<\/script>/g, (block) => (/\$R[BCTV]\b/.test(block) ? "" : block));
}
