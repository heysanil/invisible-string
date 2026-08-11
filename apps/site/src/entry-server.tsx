import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { prerender } from "react-dom/static";

import { createSiteRouter } from "./router";

/**
 * Re-exported so scripts/prerender.ts derives its page list from the same
 * glob the sidebar uses. A new .mdx file is prerendered on the next build
 * with no registry edit anywhere.
 */
export { docEntries } from "./lib/docs";

/**
 * Render one route to HTML.
 *
 * `prerender()` from react-dom/static, NOT renderToString: doc bodies are
 * `React.lazy(() => import('…mdx'))` (see routes/docs.$.tsx), and
 * renderToString throws on a component that suspends. `prerender()` waits for
 * every Suspense boundary to settle and resolves with complete markup — which
 * is what lets lib/docs.ts stay exactly as it is.
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

  const { prelude } = await prerender(<RouterProvider router={router} />);
  return await new Response(prelude).text();
}
