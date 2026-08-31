import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell } from "../components/AppShell";
import { SessionUnavailableScreen } from "../components/auth/SessionUnavailableScreen";
import { CreateWorkspaceScreen } from "../components/onboarding/CreateWorkspaceScreen";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import {
  activateWorkspace,
  activeWorkspace,
  useViewer,
  viewerQueryOptions,
} from "../lib/auth/viewer";

/**
 * The authenticated shell.
 *
 * The auth decision happens HERE, in `beforeLoad`, and never in render. A
 * render-time gate is what produced the double-login bug: it read a Better
 * Auth atom that reported `isPending: false` over a resolved-null snapshot
 * captured before the user signed in, and bounced them straight back to
 * /login. `throw redirect(...)` is atomic with navigation resolution, so no
 * render can observe a half-resolved session at all.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location, cause }) => {
    // Preloading must never decide authentication. `beforeLoad` runs again
    // for the real navigation (router-core `load-matches.ts`), so returning
    // here cannot let an actual navigation bypass the guard. Note this returns
    // BEFORE fetching, so a preload warms nothing — and any future loader on a
    // descendant route would therefore run during preload with no viewer in
    // context. Add one only if it tolerates that.
    if (cause === "preload") return;
    // Fixture mode is a backendless design/E2E harness — there is no session.
    if (FIXTURE_MODE) return;

    // fetchQuery, not ensureQueryData: ensureQueryData returns stale cached
    // data without revalidating, which would let the gate authorize from a
    // stale cache — the same defect in a different library.
    const viewer = await context.queryClient.fetchQuery(viewerQueryOptions());

    if (!viewer) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
        replace: true,
      });
    }

    // A fresh login (or an invite acceptance) can leave the session with no
    // active organization. Activation is AWAITED here so its failure is an
    // error the user can see and retry, rather than the fire-and-forget
    // effect that used to leave useWorkspace() pending forever.
    if (activeWorkspace(viewer) === null && viewer.workspaces.length > 0) {
      await activateWorkspace(context.queryClient, viewer.workspaces[0]!.id);
    }
  },
  errorComponent: SessionUnavailableScreen,
  component: AppLayout,
});

function AppLayout() {
  // Kept mounted so a focus refetch that resolves null (session revoked or
  // signed out in another tab) leaves the shell instead of stranding it.
  const { viewer, isPending } = useViewer(!FIXTURE_MODE);

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

  if (!viewer) return <Navigate to="/login" replace />;
  if (viewer.workspaces.length === 0) return <CreateWorkspaceScreen />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
