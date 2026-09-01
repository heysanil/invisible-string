import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { refetchViewer } from "../../lib/auth/viewer";
import { Button } from "../ui/Button";
import { AuthCard } from "./AuthCard";

/**
 * Shown when the session could NOT be determined — a network failure or a
 * 5xx, never a 401. A user whose session is fine must not be handed a login
 * form served by a server that cannot answer it.
 *
 * Do NOT call the `reset` prop. It is a real, working callback here (this
 * SPA has no SSR, and on the client the router's `CatchBoundary` supplies
 * one — @tanstack/react-router `src/CatchBoundary.tsx`), but it only clears
 * the boundary's OWN error state; it never re-runs `beforeLoad`. The
 * underlying route match is still `status: 'error'`, so the very next
 * render throws the same stale error right back into the boundary.
 * `router.invalidate()` is the recovery that actually works: it resets the
 * errored match to pending and re-runs `beforeLoad`, and it also advances
 * `getResetKey`, which clears the boundary as a side effect.
 *
 * Retry does BOTH, because this screen is reached two ways and each way
 * needs one of them.
 *
 * From `errorComponent`, the route match itself is errored and only
 * `router.invalidate()` resets it. From `AppLayout`'s live observer
 * (`_app.tsx`), the match is `status: 'success'` and the error lives purely
 * in query state — so `invalidate()` alone re-runs `beforeLoad` against a
 * warm cache and changes nothing on screen. That path needs a real fetch
 * that a MOUNTED observer is notified of, which is what `refetchViewer`
 * gives: `queryClient.removeQueries()` deliberately is NOT used, because
 * `Query.destroy()` never dispatches — it would detach the observer from the
 * cache entry and leave the same stale error rendered forever.
 */
export function SessionUnavailableScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();

  function retry() {
    // Rejection is expected when the server is still down; the query state
    // records it and this screen stays up, which is the designed outcome.
    void refetchViewer(queryClient).catch(() => {});
    void router.invalidate();
  }

  return (
    <AuthCard
      title="Can't reach the server"
      subtitle="Check your connection, then try again"
    >
      <Button className="w-full" onClick={retry}>
        Try again
      </Button>
    </AuthCard>
  );
}
