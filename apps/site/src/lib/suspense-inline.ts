/**
 * Collapses a `prerender()` Suspense boundary's streaming markup into flat,
 * hydration-compatible HTML.
 *
 * `prerender()` (react-dom/static) waits for every Suspense boundary in the
 * tree to settle before it resolves, but that completeness guarantee is about
 * *content*, not *placement*: a boundary that suspends even once during the
 * render pass gets React's streaming treatment in the markup — a placeholder
 * comment pair (`<!--$?-->`) around an empty `<template id="B:N">` and the
 * fallback UI, with the real content parked separately in a hidden `<div
 * hidden id="S:N">` and a client-side `<script>` that swaps it into place —
 * regardless of whether the thing that suspended has already resolved by the
 * time `prerender()` returns.
 *
 * `@tanstack/react-router`'s `<Outlet>` unconditionally wraps routed content
 * in `<Suspense>` whenever it sits directly under the root route
 * (react-router's `Match.js` — not configurable via any route option), so
 * every page gets at least this one streamed boundary even when nothing in
 * the tree ever actually suspends.
 *
 * This function replaces each such boundary's placeholder with its resolved
 * segment, spliced in as `<!--$-->…<!--/$-->` (React's own marker pair for a
 * Suspense boundary that completed without streaming) rather than bare
 * content — those comments are exactly what `hydrateRoot` matches a
 * `<Suspense>` boundary against, so this keeps the output hydration-safe: it
 * is byte-for-byte what `renderToString()` would have produced directly, had
 * `renderToString()` actually waited for everything the way `prerender()`
 * does (verified: it doesn't — see `entry-server.tsx`). It also strips the
 * swap `<script>`s (React's Fizz runtime globals — `$RB`/`$RC`/`$RT`/`$RV`).
 *
 * This is a pure reformatting pass over content `prerender()` has already
 * fully resolved — it performs no async work and cannot itself introduce a
 * wait or a fallback. It is not a substitute for verifying the render
 * actually succeeded: an errored boundary resolves as `<!--$!-->` (a
 * different marker — React treats a component throw inside Suspense as
 * *recoverable* and emits the fallback rather than rejecting), which this
 * function does not attempt to repair. `entry-server.tsx`'s `renderPage`
 * catches that case earlier, via `prerender()`'s `onError`; the check here
 * against any surviving `<!--$?-->` or `<!--$!-->` is a second, independent
 * backstop, not the primary defense.
 */
export function inlineResolvedSuspense(html: string): string {
  let out = html;

  for (;;) {
    PLACEHOLDER_OPEN.lastIndex = 0;
    const open = PLACEHOLDER_OPEN.exec(out);
    if (!open) break;
    const num = open[1];
    if (num === undefined) {
      throw new Error("inlineResolvedSuspense: boundary placeholder matched without a number");
    }

    const placeholderStart = open.index;
    const fallbackStart = open.index + open[0].length;
    // The fallback UI can itself contain a nested boundary's own comment
    // markers, so the *true* end of this placeholder isn't simply "the next
    // <!--/$-->" — it's the one at matching depth. See findCommentClose.
    const placeholderEnd = findCommentClose(out, fallbackStart);

    const openTag = `<div hidden id="S:${num}">`;
    const segmentStart = out.indexOf(openTag, placeholderEnd);
    if (segmentStart === -1) {
      throw new Error(`inlineResolvedSuspense: no resolved segment for boundary B:${num}`);
    }
    const contentStart = segmentStart + openTag.length;
    const afterDivClose = findDivClose(out, contentStart);
    const content = out.slice(contentStart, afterDivClose - CLOSE_DIV.length);

    out =
      out.slice(0, placeholderStart) +
      `<!--$-->${content}<!--/$-->` +
      out.slice(placeholderEnd, segmentStart) +
      out.slice(afterDivClose);
  }

  if (out.includes("<!--$?-->") || out.includes("<!--$!-->")) {
    throw new Error(
      "inlineResolvedSuspense: an unresolved or errored Suspense boundary survived post-processing",
    );
  }

  // Strip the now-unused streaming swap-script boilerplate.
  return out.replace(SCRIPT_TAG, (block) => (FIZZ_RUNTIME_GLOBAL.test(block) ? "" : block));
}

const PLACEHOLDER_OPEN = /<!--\$\?--><template id="B:(\d+)"><\/template>/g;
const SCRIPT_TAG = /<script>[\s\S]*?<\/script>/g;
const FIZZ_RUNTIME_GLOBAL = /\$R[BCTV]\b/;
const CLOSE_DIV = "</div>";

const SUSPENSE_OPEN_MARKERS = ["<!--$?-->", "<!--$-->", "<!--$!-->"];
const SUSPENSE_CLOSE_MARKER = "<!--/$-->";

/**
 * Index just past the Suspense comment marker (`<!--/$-->`) that closes the
 * boundary whose fallback content starts at `from`, matching nested
 * boundaries by depth (a fallback can itself render a `<Suspense>`, in
 * principle, even though nothing in this app's fallbacks does today).
 */
function findCommentClose(html: string, from: number): number {
  let depth = 1;
  let i = from;
  while (depth > 0) {
    let matchIndex = -1;
    let matchLength = 0;
    let isOpen = false;
    for (const marker of SUSPENSE_OPEN_MARKERS) {
      const idx = html.indexOf(marker, i);
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matchLength = marker.length;
        isOpen = true;
      }
    }
    const closeIdx = html.indexOf(SUSPENSE_CLOSE_MARKER, i);
    if (closeIdx !== -1 && (matchIndex === -1 || closeIdx < matchIndex)) {
      matchIndex = closeIdx;
      matchLength = SUSPENSE_CLOSE_MARKER.length;
      isOpen = false;
    }
    if (matchIndex === -1) {
      throw new Error("inlineResolvedSuspense: unterminated Suspense boundary comment");
    }
    depth += isOpen ? 1 : -1;
    i = matchIndex + matchLength;
  }
  return i;
}

/**
 * Index just past the `</div>` that closes the `<div ...>` whose content
 * starts at `contentStart`, matching nested `<div>`s by depth — doc bodies
 * are full of nested `<div>`s, so a non-greedy regex would stop at the first
 * inner `</div>` rather than the true closing tag. Safe to scan for a bare
 * `<div`/`</div>` this way only because React escapes `<` in text and
 * attribute values it renders; nothing under `apps/site/src` uses
 * `dangerouslySetInnerHTML`, so a literal `<div` can never appear except as a
 * real element boundary.
 */
export function findDivClose(html: string, contentStart: number): number {
  let depth = 1;
  let i = contentStart;
  while (depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf(CLOSE_DIV, i);
    if (nextClose === -1) {
      throw new Error("findDivClose: unterminated <div>");
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + "<div".length;
    } else {
      depth--;
      i = nextClose + CLOSE_DIV.length;
    }
  }
  return i;
}
