/**
 * Active-workspace resolution + the viewer's role in it.
 *
 * Workspace = Better Auth organization (`session.activeOrganizationId`).
 * `useWorkspace` self-heals a fresh login with no active organization by
 * activating the first one the user belongs to. The role comes from the
 * control-plane members list (`GET /workspaces/:id/members`) so it reflects
 * exactly what the API will authorize — settings screens gate mutations on
 * `canManage` (owner/admin) and the server re-checks everything.
 */
import { useEffect, useRef } from "react";
import { WORKSPACE_ROLES, type KnownWorkspaceRole } from "@invisible-string/shared";

import {
  authClient,
  useActiveOrganization,
  useListOrganizations,
  useSession,
} from "./auth-client";
import { useWorkspaceMembers } from "./queries/members";

export interface ActiveWorkspace {
  id: string;
  name: string;
}

export interface UseWorkspaceResult {
  workspace: ActiveWorkspace | null;
  /** True while resolution (or first-org activation) is still in flight. */
  isPending: boolean;
}

export function useWorkspace(): UseWorkspaceResult {
  const active = useActiveOrganization();
  const list = useListOrganizations();
  const activationRequested = useRef(false);

  const activeData = active.data ?? null;
  const organizations = list.data ?? null;

  useEffect(() => {
    if (active.isPending || list.isPending) return;
    if (activeData !== null || activationRequested.current) return;
    const first = organizations?.[0];
    if (!first) return;
    activationRequested.current = true;
    void authClient.organization.setActive({ organizationId: first.id });
  }, [active.isPending, list.isPending, activeData, organizations]);

  const workspace = activeData
    ? { id: activeData.id, name: activeData.name }
    : null;

  // Still pending while: hooks are loading, or activation of the first org
  // was requested and the active-organization hook hasn't caught up yet.
  const isPending =
    active.isPending ||
    (workspace === null &&
      (list.isPending || (organizations?.length ?? 0) > 0));

  return { workspace, isPending };
}

function parseKnownRole(role: string): KnownWorkspaceRole | null {
  // Better Auth stores multi-roles comma-separated; highest privilege wins.
  const parts = role.split(",").map((part) => part.trim());
  for (const candidate of WORKSPACE_ROLES) {
    if (parts.includes(candidate)) return candidate;
  }
  return null;
}

export interface UseWorkspaceRoleResult {
  /** The viewer's role, null while unknown (loading/error/not a member). */
  role: KnownWorkspaceRole | null;
  /** Owner or admin — may mutate settings. False until the role is known. */
  canManage: boolean;
  isPending: boolean;
}

export function useWorkspaceRole(
  workspaceId: string | undefined,
): UseWorkspaceRoleResult {
  const { data: session } = useSession();
  const members = useWorkspaceMembers(workspaceId ?? "", {
    enabled: workspaceId !== undefined,
  });

  const userId = session?.user.id;
  const member =
    userId === undefined
      ? undefined
      : members.data?.find((candidate) => candidate.userId === userId);
  const role = member ? parseKnownRole(member.role) : null;

  return {
    role,
    canManage: role === "owner" || role === "admin",
    isPending: workspaceId !== undefined && members.isPending,
  };
}
