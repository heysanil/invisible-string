/**
 * Workspace members (read-only). Better Auth's organization plugin owns
 * membership; this route is a thin passthrough to `listMembers` mapped to the
 * DTO. Invitation/role mutations go through Better Auth's own endpoints.
 */
import type { ListWorkspaceMembersResponse } from "@invisible-string/shared";

import type { ResourceDeps } from "./common";

interface AuthMemberRow {
  id: string;
  userId: string;
  role: string;
  createdAt: Date | string;
  user?: { name?: string | null; email?: string | null };
}

export async function listWorkspaceMembers(
  deps: ResourceDeps,
  organizationId: string,
  headers: Headers,
): Promise<ListWorkspaceMembersResponse> {
  const result = (await deps.auth.api.listMembers({
    query: { organizationId },
    headers,
  })) as { members?: AuthMemberRow[] } | null;

  const members = (result?.members ?? []).map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user?.name ?? null,
    email: m.user?.email ?? "",
    role: m.role,
    createdAt:
      m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
  }));

  return { members };
}
