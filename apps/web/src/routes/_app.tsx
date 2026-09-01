import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

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
 * A NAVIGATION's auth decision happens HERE, in `beforeLoad` — never from a
 * snapshot read during render, which is not the same as "never in render":
 * `AppLayout` below keeps a live render-time observer on purpose, because
 * `beforeLoad` runs only on navigation and a session can end without one.
 * The rule is about the VALUE, not the location. What produced the
 * double-login bug was a render-time gate reading a Better Auth atom that
 * reported `isPending: false` over a resolved-null snapshot captured before
 * the user signed in, and bouncing them straight back to /login;
 * authoritative query state with an honest `isPending` is safe to branch on
 * in render, which is what `AppLayout` does below. `throw redirect(...)`
 * here is atomic with navigation resolution, so no render can observe a
 * half-resolved session for a NAVIGATION at all.
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
    //
    // Its RESULT is checked, not discarded. Activation re-reads the viewer,
    // and that read can answer either of the other two ways: `null` means the
    // session died mid-activation, which has to redirect while `location.href`
    // is still the target the user asked for (the render-time <Navigate>
    // below carries no redirect and would silently drop it); a viewer that
    // still has no active workspace means the activation did not stick, which
    // must fail visibly rather than commit a shell WorkspaceGate cannot
    // resolve.
    if (activeWorkspace(viewer) === null && viewer.workspaces.length > 0) {
      const activated = await activateWorkspace(
        context.queryClient,
        viewer.workspaces[0]!.id,
      );
      if (!activated) {
        throw redirect({
          to: "/login",
          search: { redirect: location.href },
          replace: true,
        });
      }
      if (
        activeWorkspace(activated) === null &&
        activated.workspaces.length > 0
      ) {
        throw new ActivateWorkspaceError(
          "The workspace could not be selected.",
        );
      }
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
 * Do NOT call the `reset` prop, same trap as `SessionUnavailableScreen`: it
 * only clears the `CatchBoundary`'s own error state and never re-runs
 * `beforeLoad`, so the still-errored route match throws right back into it
 * on the next render. `router.invalidate()` re-runs `beforeLoad` AND
 * advances `getResetKey`, which clears the boundary too — the strictly
 * stronger recovery.
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

/**
 * The live observer.
 *
 * A render-time decision is acceptable HERE and nowhere else: the value being
 * read is authoritative query state whose `isPending` is honest, not a Better
 * Auth snapshot that reports `isPending: false` over data it never fetched.
 * It exists because `beforeLoad` runs only on navigation, and a session can
 * end without one — revoked in another tab, expired on the wire. All three
 * arms of the viewer contract are branched on here, exactly as they are in
 * the gate: `error` (undetermined) before `null` (signed out) before a
 * `Viewer`.
 */
function AppLayout() {
  const router = useRouter();
  // Kept mounted so a focus refetch that resolves null (session revoked or
  // signed out in another tab) leaves the shell instead of stranding it.
  const { viewer, isPending, error } = useViewer(!FIXTURE_MODE);

  // A live update can leave a signed-in viewer holding workspaces with no
  // RESOLVABLE active one — the active organization was removed elsewhere.
  // `beforeLoad` is the only place that awaits activation and it does not
  // re-run without a navigation, so re-enter it rather than committing a
  // shell whose WorkspaceGate can only show its defensive empty state.
  const needsActivation =
    !FIXTURE_MODE &&
    viewer !== null &&
    viewer.workspaces.length > 0 &&
    activeWorkspace(viewer) === null;

  useEffect(() => {
    // `error` is checked here too, not just below: this effect is declared
    // ahead of the render's `if (error)` arm (hooks can't follow a
    // conditional return), so without this a viewer that is simultaneously
    // errored AND missing a resolvable active workspace would invalidate
    // while the retry card is on screen — harmless today (an extra
    // `beforeLoad` against a warm cache) but it couples two arms the render
    // ordering deliberately keeps independent.
    if (!needsActivation || error) return;
    // `invalidate()` re-runs `beforeLoad` (router-core's `shouldSkipLoader`
    // does not skip a successful match), and the viewer it re-reads is the
    // one this render just saw — so the gate activates and the flag clears.
    // A failure there throws into `errorComponent`; it cannot spin, because
    // the effect only fires on the transition into this state.
    void router.invalidate();
  }, [needsActivation, error, router]);

  if (FIXTURE_MODE) {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }

  // Undetermined, NOT signed out. Without this arm a focus refetch that
  // throws kept rendering the shell over the last viewer we happened to have,
  // so the three-way contract held only on initial navigation.
  if (error) return <SessionUnavailableScreen />;

  if (isPending || needsActivation) {
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
