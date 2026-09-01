import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { ToastProvider } from "../components/ui/Toast";
import { Wash } from "../components/Wash";

/**
 * Router context. The QueryClient lives here (rather than as a module
 * singleton) so route `beforeLoad` guards can read and write the cache — the
 * auth gate in routes/_app.tsx resolves the viewer before the route commits.
 */
export interface AppRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Wash />
        <Outlet />
      </ToastProvider>
    </QueryClientProvider>
  );
}
