import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";

import { ToastProvider } from "../components/ui/Toast";
import { Wash } from "../components/Wash";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Wash />
        <Outlet />
      </ToastProvider>
    </QueryClientProvider>
  );
}
