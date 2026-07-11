import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agents")({
  component: AgentsLayout,
});

/**
 * Pass-through layout for the Agents section. `/agents` renders the card grid
 * (index route); `/agents/:id` renders the flagship agent editor — the two
 * are siblings, so this layout is just the outlet.
 */
function AgentsLayout() {
  return <Outlet />;
}
