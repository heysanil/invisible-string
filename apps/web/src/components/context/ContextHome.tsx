/**
 * Context section home: Workspace | Personal tabs over MCP connections +
 * skills. Workspace-scope mutations are gated on `canManage` (members see a
 * read-only view); personal scope is always the signed-in user's own and
 * fully editable.
 */
import { useState } from "react";

import type { ScopeRef } from "../../lib/queries/keys";
import { Panel } from "../ui/Panel";
import { SegmentedControl } from "../ui/SegmentedControl";
import { McpConnectionsGrid } from "./McpConnectionsGrid";
import { RegistryBrowserModal } from "./RegistryBrowserModal";
import { SkillList } from "./SkillList";

export type ContextScopeTab = "workspace" | "personal";

export interface ContextHomeProps {
  workspaceId: string;
  /** Owner/admin — may mutate workspace-scoped context. */
  canManage: boolean;
  /** Open the skill editor for (scope, id). */
  onOpenSkill: (scope: ContextScopeTab, skillId: string) => void;
}

export function ContextHome({ workspaceId, canManage, onOpenSkill }: ContextHomeProps) {
  const [tab, setTab] = useState<ContextScopeTab>("workspace");
  const [adding, setAdding] = useState(false);

  const scope: ScopeRef =
    tab === "workspace"
      ? { scope: "workspace", workspaceId }
      : { scope: "user" };
  const readOnly = tab === "workspace" ? !canManage : false;
  const scopeLabel = tab === "workspace" ? "workspace" : "personal";

  return (
    <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex flex-col gap-3 px-6 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[17px]">Context</h1>
          <SegmentedControl<ContextScopeTab>
            ariaLabel="Context scope"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "personal", label: "Personal" },
            ]}
          />
        </div>
        <p className="text-[13px] leading-relaxed text-ink-3">
          {tab === "workspace"
            ? "Connections and skills available to everyone in this workspace."
            : "Your personal connections and skills, private to you across workspaces."}
        </p>
      </header>
      <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />

      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-5">
        <McpConnectionsGrid
          scope={scope}
          readOnly={readOnly}
          onAdd={() => setAdding(true)}
        />
        <SkillList
          scope={scope}
          readOnly={readOnly}
          onOpenSkill={(skillId) => onOpenSkill(tab, skillId)}
        />
      </div>

      <RegistryBrowserModal
        open={adding}
        onClose={() => setAdding(false)}
        scope={scope}
        scopeLabel={scopeLabel}
      />
    </Panel>
  );
}
