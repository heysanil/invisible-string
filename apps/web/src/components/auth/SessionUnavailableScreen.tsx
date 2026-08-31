import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { viewerQueryKey } from "../../lib/auth/viewer";
import { Button } from "../ui/Button";
import { AuthCard } from "./AuthCard";

/**
 * Shown when the session could NOT be determined — a network failure or a
 * 5xx, never a 401. A user whose session is fine must not be handed a login
 * form served by a server that cannot answer it.
 *
 * Do NOT call the `reset` prop. `ErrorComponentProps` declares it, but for an
 * error thrown from `beforeLoad`/`loader` the router passes
 * `reset={undefined as any}` (@tanstack/react-router `src/Match.tsx:382`), so
 * calling it throws a TypeError. `router.invalidate()` is the supported
 * recovery: it resets errored matches to pending and reloads them.
 */
export function SessionUnavailableScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();

  function retry() {
    queryClient.removeQueries({ queryKey: viewerQueryKey });
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
