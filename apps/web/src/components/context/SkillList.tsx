import { FileText, Paperclip, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { SkillDto } from "@invisible-string/shared";

import { formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { useCreateSkill, useDeleteSkill, useSkills } from "../../lib/queries/skills";
import type { ScopeRef } from "../../lib/queries/keys";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { SkeletonList } from "../ui/Skeleton";
import { Textarea } from "../ui/Textarea";
import { useToast } from "../ui/Toast";

export interface SkillListProps {
  scope: ScopeRef;
  readOnly: boolean;
  /** Open the full-height editor for a skill id. */
  onOpenSkill: (skillId: string) => void;
}

/** First non-empty line of a description, for the list subtitle. */
function firstLine(text: string | null): string {
  if (!text) return "";
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? "";
}

export function SkillList({ scope, readOnly, onOpenSkill }: SkillListProps) {
  const skills = useSkills(scope);
  const create = useCreateSkill(scope);
  const remove = useDeleteSkill(scope);
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillDto | null>(null);

  async function submitCreate() {
    if (newName.trim().length === 0) {
      setNameError("Give this skill a name.");
      return;
    }
    try {
      const result = await create.mutateAsync({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        content: "",
      });
      setCreating(false);
      setNewName("");
      setNewDescription("");
      onOpenSkill(result.skill.id);
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
    }
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
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-ink">Skills</h2>
          {skills.data ? (
            <span className="text-[12px] text-ink-4">{skills.data.length}</span>
          ) : null}
        </div>
        {readOnly ? null : (
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden="true" />
            New skill
          </Button>
        )}
      </div>

      {skills.isPending ? (
        <SkeletonList rows={2} />
      ) : skills.isError ? (
        <ErrorState
          compact
          message={errorMessage(skills.error)}
          onRetry={() => void skills.refetch()}
        />
      ) : skills.data.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No skills yet"
          description={
            readOnly
              ? "No skills have been authored here yet."
              : "Author a skill — reusable instructions and files your agents can draw on."
          }
          action={
            readOnly ? undefined : (
              <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
                <Plus size={14} aria-hidden="true" />
                New skill
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.data.map((skill) => (
            <li key={skill.id}>
              <div className="lift group flex items-center gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-3 hover:border-black/15 hover:bg-white/70">
                <button
                  type="button"
                  onClick={() => onOpenSkill(skill.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.05] text-ink-2">
                    <FileText size={16} strokeWidth={1.9} aria-hidden="true" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-semibold text-ink">
                      {skill.name}
                    </span>
                    <span className="truncate text-[12.5px] text-ink-3">
                      {firstLine(skill.description) || "No description yet"}
                    </span>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-3">
                  {skill.files.length > 0 ? (
                    <span
                      className="inline-flex items-center gap-1 text-[12px] text-ink-4"
                      title={`${skill.files.length} attachment${skill.files.length === 1 ? "" : "s"}`}
                    >
                      <Paperclip size={12} aria-hidden="true" />
                      {skill.files.length}
                    </span>
                  ) : null}
                  <span className="hidden text-[12px] text-ink-4 sm:inline">
                    {formatRelativeTime(skill.updatedAt)}
                  </span>
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={`Delete ${skill.name}`}
                      onClick={() => setPendingDelete(skill)}
                      className="lift flex size-8 items-center justify-center rounded-full text-ink-4 opacity-0 hover:bg-err/10 hover:text-err focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New skill"
        description="Name it now — you'll write the instructions next."
        maxWidthClassName="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={create.isPending} onClick={() => void submitCreate()}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pb-1">
          <Input
            label="Name"
            value={newName}
            autoFocus
            placeholder="e.g. Brand voice"
            error={nameError}
            onChange={(event) => {
              setNewName(event.currentTarget.value);
              if (nameError) setNameError(null);
            }}
          />
          <Textarea
            label="Description (optional)"
            value={newDescription}
            rows={2}
            placeholder="One line so the agent knows when to reach for it."
            onChange={(event) => setNewDescription(event.currentTarget.value)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={`Delete ${pendingDelete?.name ?? "skill"}?`}
        description="This removes the skill and its attachments. Workflows that reference it will fail to publish until updated."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
      />
    </section>
  );
}
