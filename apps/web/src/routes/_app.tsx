import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";

import { AppShell } from "../components/AppShell";
import { SessionUnavailableScreen } from "../components/auth/SessionUnavailableScreen";
import { CreateWorkspaceScreen } from "../components/onboarding/CreateWorkspaceScreen";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import {
  activateWorkspace,
  ActivateWorkspaceError,
  activeWorkspace,
  useViewer,
  ViewerUnavailableError,
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
  // `_app` is the only route in the tree with an `errorComponent`, so its
  // boundary is the first (and only) one ANY descendant render throw meets
  // — not just a failure in this route's own `beforeLoad`
  // (`@tanstack/react-router` resolves every route without its own
  // `errorComponent` to a no-op boundary, `Match.tsx`). It must therefore
  // discriminate: only a failure to determine the SESSION is "can't reach
  // the server" — an unrelated render crash three routes down must not be
  // misreported as a network outage the user cannot fix by waiting it out.
  errorComponent: ({ error }) =>
    error instanceof ViewerUnavailableError ||
    error instanceof ActivateWorkspaceError ? (
      <SessionUnavailableScreen />
    ) : (
      <AppErrorScreen />
    ),
  component: AppLayout,
});

/**
 * Shown for any `/_app`-subtree error that is NOT about the session itself —
 * a render crash in a descendant route, say. Deliberately says nothing about
 * the network: that framing belongs only to `SessionUnavailableScreen`.
 *
 * Do NOT call the `reset` prop, same trap as `SessionUnavailableScreen`:
 * for an error thrown from `beforeLoad`/`loader` the router passes
 * `reset={undefined as any}` (`Match.tsx:382`).
 */
function AppErrorScreen() {
  const router = useRouter();
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <ErrorState
        message="This page ran into an unexpected problem. Try again, or reload if it keeps happening."
        onRetry={() => void router.invalidate()}
      />
    </div>
  );
}

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
