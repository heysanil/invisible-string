/**
 * Workspace settings: rename the workspace (owners/admins) + a danger-zone
 * placeholder. Rename goes through Better Auth's organization update.
 */
import { useEffect, useState } from "react";

import { authClient } from "../../lib/auth-client";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useToast } from "../ui/Toast";
import { SettingsSection } from "./SettingsSection";

export interface WorkspacePanelProps {
  workspaceId: string;
  workspaceName: string;
  canManage: boolean;
}

export function WorkspacePanel({
  workspaceId,
  workspaceName,
  canManage,
}: WorkspacePanelProps) {
  const { toast } = useToast();
  const [name, setName] = useState(workspaceName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reflect an updated name arriving from elsewhere while not mid-edit.
  useEffect(() => {
    setName(workspaceName);
  }, [workspaceName]);

  const dirty = name.trim() !== workspaceName && name.trim().length > 0;

  async function save() {
    if (name.trim().length === 0) {
      setError("A workspace needs a name.");
      return;
    }
    setSaving(true);
    try {
      const result = await authClient.organization.update({
        organizationId: workspaceId,
        data: { name: name.trim() },
      });
      const updateError = (result as { error: { message?: string } | null }).error;
      if (updateError) {
        toast({ variant: "error", message: updateError.message ?? "Could not rename." });
        return;
      }
      toast({ variant: "success", message: "Workspace renamed." });
    } catch {
      toast({ variant: "error", message: "Could not rename the workspace." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Workspace" description="Name and workspace-level controls.">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-4">
          <Input
            label="Workspace name"
            value={name}
            readOnly={!canManage}
            error={error}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError(null);
            }}
          />
          {canManage ? (
            <div className="flex justify-end">
              <Button size="sm" loading={saving} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-4">
              Only owners and admins can rename the workspace.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-card-lg border border-err/20 bg-err/[0.04] p-4">
          <p className="text-[13px] font-semibold text-ink">Danger zone</p>
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Deleting a workspace removes its workflows, connections, and run
            history. This isn't available yet.
          </p>
          <div>
            <Button variant="ghost" size="sm" disabled>
              Delete workspace
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
