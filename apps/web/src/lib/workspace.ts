/**
 * Active-workspace resolution + the viewer's role in it.
 *
 * Workspace = Better Auth organization. Both the workspace list and the
 * active id come from the viewer query (lib/auth/viewer.ts), which is the
 * SPA's single identity source.
 *
 * There is deliberately NO activation effect here any more. Selecting a
 * workspace for a session that has none is the router gate's job
 * (routes/_app.tsx `beforeLoad`), where it is awaited and its failure is
 * visible. The previous fire-and-forget effect latched a ref, ignored the
 * result, and left `isPending` true forever when activation failed.
 *
 * The role comes from the control-plane members list so it reflects exactly
 * what the API will authorize; the server re-checks everything.
 */
import { WORKSPACE_ROLES, type KnownWorkspaceRole } from "@invisible-string/shared";

import { activeWorkspace, useViewer } from "./auth/viewer";
import { useWorkspaceMembers } from "./queries/members";

export interface ActiveWorkspace {
  id: string;
  name: string;
}

export interface UseWorkspaceResult {
  workspace: ActiveWorkspace | null;
  /** True while the viewer is still resolving. */
  isPending: boolean;
  /** Set when the viewer could NOT be determined — distinct from "none". */
  error: Error | null;
}

export function useWorkspace(): UseWorkspaceResult {
  const { viewer, isPending, error } = useViewer();
  const workspace = viewer ? activeWorkspace(viewer) : null;
  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    isPending,
    error,
  };
}

/** The active workspace id + pending flag — the chat/builder accessor. */
export function useActiveWorkspaceId(): {
  workspaceId: string | null;
  isPending: boolean;
} {
  const { workspace, isPending } = useWorkspace();
  return { workspaceId: workspace?.id ?? null, isPending };
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
  const { viewer } = useViewer();
  const members = useWorkspaceMembers(workspaceId ?? "", {
    enabled: workspaceId !== undefined,
  });

  const userId = viewer?.user.id;
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
