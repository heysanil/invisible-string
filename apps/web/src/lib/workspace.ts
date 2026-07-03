/**
 * Active workspace resolution. Workspaces are Better Auth organizations;
 * the server stamps `session.activeOrganizationId` on the login session
 * (org plugin). The generated client type doesn't carry the org plugin's
 * session fields, so this is the ONE place that reads them (defensively).
 */
import { useSession } from "./auth-client";

interface SessionWithOrg {
  session?: { activeOrganizationId?: string | null } | null;
}

/** The active workspace (organization) id, or null before one is active. */
export function useActiveWorkspaceId(): string | null {
  const { data } = useSession();
  const record = data as unknown as SessionWithOrg | null;
  return record?.session?.activeOrganizationId ?? null;
}
