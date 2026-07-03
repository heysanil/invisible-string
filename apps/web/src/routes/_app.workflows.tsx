import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/workflows")({
  component: WorkflowsLayout,
});

/**
 * Pass-through layout for the Workflows section. `/workflows` renders the list
 * (index route); `/workflows/:id` renders the full-bleed hybrid builder — the
 * two are siblings, so this layout is just the outlet.
 */
function WorkflowsLayout() {
  return <Outlet />;
}
