/**
 * Agent presets: card list + create/edit drawer. Deleting a preset that a
 * workflow draft references makes those drafts fail publish
 * (`agent_preset_not_found`) — the delete confirm says so.
 */
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type {
  AgentPresetDto,
  CreateAgentPresetRequest,
} from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { PRESET_LABEL, REASONING_LABEL } from "../../lib/labels";
import {
  useAgentPresets,
  useCreateAgentPreset,
  useDeleteAgentPreset,
  useUpdateAgentPreset,
} from "../../lib/queries/agent-presets";
import { useModelAllowlist } from "../../lib/queries/models";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { SkeletonList } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { AgentPresetDrawer } from "./AgentPresetDrawer";
import { SettingsSection } from "./SettingsSection";

export interface AgentPresetsPanelProps {
  workspaceId: string;
  canManage: boolean;
}

export function AgentPresetsPanel({ workspaceId, canManage }: AgentPresetsPanelProps) {
  const presets = useAgentPresets(workspaceId);
  const allowlist = useModelAllowlist(workspaceId);
  const create = useCreateAgentPreset(workspaceId);
  const update = useUpdateAgentPreset(workspaceId);
  const remove = useDeleteAgentPreset(workspaceId);
  const { toast } = useToast();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentPresetDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentPresetDto | null>(null);

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(preset: AgentPresetDto) {
    setEditing(preset);
    setEditorOpen(true);
  }

  async function submit(input: CreateAgentPresetRequest) {
    if (editing) {
      await update.mutateAsync({ agentId: editing.id, patch: input });
      toast({ variant: "success", message: `${input.name} saved.` });
    } else {
      await create.mutateAsync(input);
      toast({ variant: "success", message: `${input.name} created.` });
    }
    setEditorOpen(false);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      await remove.mutateAsync(target.id);
      toast({ variant: "success", message: `${target.name} deleted.` });
      setPendingDelete(null);
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  return (
    <SettingsSection
      title="Agent presets"
      description="Reusable personas and model settings your workflows can pick from."
      action={
        canManage ? (
          <Button variant="ghost" size="sm" onClick={openCreate}>
            <Plus size={14} aria-hidden="true" />
            New preset
          </Button>
        ) : undefined
      }
    >
      {presets.isPending ? (
        <SkeletonList rows={3} />
      ) : presets.isError ? (
        <ErrorState
          compact
          message={errorMessage(presets.error)}
          onRetry={() => void presets.refetch()}
        />
      ) : presets.data.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agent presets"
          description={
            canManage
              ? "Create a preset to reuse a persona and model configuration across workflows."
              : "No agent presets have been created yet."
          }
          action={
            canManage ? (
              <Button variant="ghost" size="sm" onClick={openCreate}>
                <Plus size={14} aria-hidden="true" />
                New preset
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {presets.data.map((preset) => (
            <li
              key={preset.id}
              className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.05] text-ink-2">
                  <Bot size={17} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <h3 className="truncate text-[14px] font-semibold text-ink">
                    {preset.name}
                  </h3>
                  {preset.description ? (
                    <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">
                      {preset.description}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${preset.name}`}
                      onClick={() => openEdit(preset)}
                      className="lift flex size-8 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${preset.name}`}
                      onClick={() => setPendingDelete(preset)}
                      className="lift flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="neutral">{PRESET_LABEL[preset.modelPreset]}</Chip>
                <Chip tone="neutral">{REASONING_LABEL[preset.reasoningEffort]} reasoning</Chip>
                {preset.modelId ? (
                  <Chip tone="ink">Override · {preset.modelId}</Chip>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <AgentPresetDrawer
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        preset={editing}
        allowlist={allowlist.data ?? []}
        onSubmit={submit}
        saving={create.isPending || update.isPending}
        error={create.error ?? update.error}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={`Delete ${pendingDelete?.name ?? "preset"}?`}
        description="Workflows that reference this preset will fail to publish until updated to another one."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
      />
    </SettingsSection>
  );
}
