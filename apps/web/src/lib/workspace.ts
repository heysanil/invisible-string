/**
 * Active workspace (= Better Auth active organization) resolution for the
 * product routes. The org plugin stamps `session.activeOrganizationId` on the
 * login session server-side; the SPA reads it here.
 *
 * A member with no active organization cannot address workspace-scoped routes
 * — screens render an explanatory empty state rather than firing requests
 * that would 403.
 */
import { useSession } from "./auth-client";

interface SessionWithOrg {
  session?: { activeOrganizationId?: string | null } | null;
}

/** The active workspace id, or null while loading / when none is active. */
export function useActiveWorkspaceId(): {
  workspaceId: string | null;
  isPending: boolean;
} {
  const { data, isPending } = useSession();
  const activeOrganizationId =
    (data as SessionWithOrg | null | undefined)?.session
      ?.activeOrganizationId ?? null;
  return { workspaceId: activeOrganizationId, isPending };
}
