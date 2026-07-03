import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/context")({ component: ContextLayout });

/** Context section shell — the index and the skill editor render into here. */
function ContextLayout() {
  return <Outlet />;
}
