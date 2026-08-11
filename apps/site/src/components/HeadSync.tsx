import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { docFrontmatterMap } from "../lib/docs";
import { applyHead, normalizeSiteUrl, type SeoContext, seoForPath } from "../lib/seo";

/**
 * `indexable: true` is inert here — `applyHead` never writes the robots meta,
 * which the build owns (a preview build's `noindex` must survive every
 * client-side navigation). The field is required rather than optional so that
 * the prerender script, where the value genuinely matters, cannot omit it.
 */
const SEO_CONTEXT: SeoContext = {
  siteUrl: normalizeSiteUrl(import.meta.env.VITE_SITE_URL),
  indexable: true,
};

/**
 * Keeps the document head in step with client-side navigation.
 *
 * Crawlers never need this — they read the prerendered head. It exists so the
 * browser tab, bookmarks, and history entries are correct for humans, and so
 * the dev server (where nothing is prerendered) still shows real titles.
 *
 * Renders nothing. The head is deliberately outside React's tree: it never
 * participates in hydration, so there is no mismatch surface in it at all.
 */
export function HeadSync(): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    applyHead(seoForPath(pathname, docFrontmatterMap, SEO_CONTEXT), document);
  }, [pathname]);

  return null;
}
