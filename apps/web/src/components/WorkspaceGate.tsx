/**
 * Resolves the active workspace and the viewer's role in it, then hands both
 * to `children`. While resolving it shows a titled loading panel; with no
 * workspace it shows a friendly empty panel — screens never flash blank or
 * fire resource fetches before a workspace id exists.
 */
import { Building2 } from "lucide-react";
import type { ReactNode } from "react";

import { useWorkspace, useWorkspaceRole } from "../lib/workspace";
import { EmptyState } from "./ui/EmptyState";
import { Panel } from "./ui/Panel";
import { Spinner } from "./ui/Spinner";

export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  /** Owner/admin — may mutate workspace settings and workspace context. */
  canManage: boolean;
  /** True while the role is still loading (gate mutations until known). */
  rolePending: boolean;
}

export interface WorkspaceGateProps {
  title: string;
  children: (context: WorkspaceContext) => ReactNode;
}

export function WorkspaceGate({ title, children }: WorkspaceGateProps) {
  const { workspace, isPending } = useWorkspace();
  const role = useWorkspaceRole(workspace?.id);

  if (isPending) {
    return (
      <Panel className="panel-enter flex h-full items-center justify-center">
        <div role="status" aria-label={`Loading ${title}`} className="flex items-center gap-2 text-ink-4">
          <Spinner size={16} />
        </div>
      </Panel>
    );
  }

  if (!workspace) {
    return (
      <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
        <header className="px-6 pb-4 pt-5">
          <h1 className="text-[17px]">{title}</h1>
        </header>
        <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />
        <div className="flex-1">
          <EmptyState
            icon={Building2}
            title="No workspace yet"
            description="Create or join a workspace to manage its context and settings."
          />
        </div>
      </Panel>
    );
  }

  return (
    <>
      {children({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        canManage: role.canManage,
        rolePending: role.isPending,
      })}
    </>
  );
}
