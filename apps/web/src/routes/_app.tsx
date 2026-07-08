import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { AppShell } from "../components/AppShell";
import { CreateWorkspaceScreen } from "../components/onboarding/CreateWorkspaceScreen";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import {
  useActiveOrganization,
  useListOrganizations,
  useSession,
} from "../lib/auth-client";

export const Route = createFileRoute("/_app")({ component: AppLayout });

/**
 * Authenticated shell layout. Session comes from the better-auth client;
 * unauthenticated (or unreachable-API) visitors are sent to /login, which
 * remains fully usable offline.
 *
 * This layout is also the single owner of the zero-workspace state: a
 * signed-in user with no organizations gets the first-run
 * CreateWorkspaceScreen instead of the shell. The active-organization check
 * matters after invite acceptance — /organization/accept-invitation does not
 * fire the client's $listOrg refetch (only create/delete/update do), but
 * setActive refreshes the active-org store, which must win here.
 */
function AppLayout() {
  const { data: session, isPending } = useSession();
  const organizations = useListOrganizations();
  const activeOrganization = useActiveOrganization();

  // Fixture mode is a backendless design/E2E harness — skip the auth gate so
  // canned screens render without a control plane.
  if (FIXTURE_MODE) {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }

  const orgsResolving =
    session !== null &&
    session !== undefined &&
    (organizations.isPending || activeOrganization.isPending);

  if (isPending || orgsResolving) {
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

  // If org resolution errored, fall through to the shell — WorkspaceGate's
  // designed empty state handles it; never mis-onboard a user who may
  // already own workspaces.
  const orgResolutionFailed =
    organizations.error != null || activeOrganization.error != null;
  const hasWorkspace =
    (organizations.data?.length ?? 0) > 0 || activeOrganization.data !== null;

  if (!orgResolutionFailed && !hasWorkspace) return <CreateWorkspaceScreen />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
