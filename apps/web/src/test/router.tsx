/**
 * Test helper: mount a component subtree inside a real TanStack Router
 * context so router primitives (`<Link>`, `useNavigate`, …) work in isolated
 * component tests. Registers the in-app link targets (e.g. the builder route)
 * as no-op stubs so runtime path building succeeds without pulling the whole
 * generated route tree.
 */
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

export function renderWithRouter(ui: ReactNode) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  // Link targets referenced by chat components. Path building needs the route
  // registered; the component itself is irrelevant in these tests.
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => null,
  });
  const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
    component: () => null,
  });
  const agentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId",
    component: () => null,
  });
  const contextRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/context",
    component: () => null,
  });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    workflowRoute,
    agentsRoute,
    agentRoute,
    contextRoute,
    chatRoute,
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The local route tree differs from the app's registered tree; that only
  // affects compile-time `to` typing (validated against the app router), not
  // runtime, so the cast keeps RouterProvider happy.
  return render(<RouterProvider router={router as never} />);
}
