import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { AppShell } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import { useSession } from "../lib/auth-client";

export const Route = createFileRoute("/_app")({ component: AppLayout });

/**
 * Authenticated shell layout. Session comes from the better-auth client;
 * unauthenticated (or unreachable-API) visitors are sent to /login, which
 * remains fully usable offline.
 */
function AppLayout() {
  const { data: session, isPending } = useSession();

  // Fixture mode is a backendless design/E2E harness — skip the auth gate so
  // canned screens render without a control plane.
  if (FIXTURE_MODE) {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }

  if (isPending) {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex min-h-dvh items-center justify-center"
      >
        <Spinner size={20} className="text-ink-4" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
