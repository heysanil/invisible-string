import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/docs")({ component: DocsLayout });

/**
 * Docs layout route. The three-column shell (glass sidebar · frosted content ·
 * TOC rail) lives in the splat route `docs.$.tsx`, since the TOC is derived from
 * the rendered article and prev/next from the current slug — both per-page. This
 * layout only owns the outer width + top spacing that clears the fixed nav dock.
 */
function DocsLayout() {
  return (
    <div className="docs-shell pt-28 pb-24">
      <Outlet />
    </div>
  );
}
