/**
 * Workspace member list (settings → members; run-as pickers).
 *
 * Read-only here — invitations and role changes go through Better Auth's
 * organization endpoints (lib/auth-client.ts), not this API.
 */
import { useQuery } from "@tanstack/react-query";
import { listWorkspaceMembersResponseSchema } from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

export function fetchWorkspaceMembers(workspaceId: string, signal?: AbortSignal) {
  return api.get(
    `/workspaces/${workspaceId}/members`,
    listWorkspaceMembersResponseSchema,
    { signal },
  );
}

export function useWorkspaceMembers(
  workspaceId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.members.list(workspaceId),
    queryFn: ({ signal }) => fetchWorkspaceMembers(workspaceId, signal),
    select: (data) => data.members,
    staleTime: 60_000,
    enabled: (options.enabled ?? true) && workspaceId.length > 0,
  });
}
