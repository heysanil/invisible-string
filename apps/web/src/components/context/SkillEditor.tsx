/**
 * Full-height skill editor: markdown body (CodeMirror) + name + description
 * + attachments sidebar. Save is explicit with dirty tracking; a member
 * (read-only) sees the same layout without mutating affordances.
 */
import { ArrowLeft, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SkillDto } from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { useSkill, useUpdateSkill } from "../../lib/queries/skills";
import type { ScopeRef } from "../../lib/queries/keys";
import { CodeMirrorMarkdown } from "../CodeMirrorMarkdown";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import { Input } from "../ui/Input";
import { Panel } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";
import { Textarea } from "../ui/Textarea";
import { useToast } from "../ui/Toast";
import { AttachmentsSidebar } from "./AttachmentsSidebar";

export interface SkillEditorProps {
  scope: ScopeRef;
  skillId: string;
  readOnly: boolean;
  onBack: () => void;
}

interface Draft {
  name: string;
  description: string;
  content: string;
}

function toDraft(skill: SkillDto): Draft {
  return {
    name: skill.name,
    description: skill.description ?? "",
    content: skill.content,
  };
}

export function SkillEditor({ scope, skillId, readOnly, onBack }: SkillEditorProps) {
  const skill = useSkill(scope, skillId);
  const update = useUpdateSkill(scope);
  const { toast } = useToast();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // Seed the draft once the skill loads; keep it stable while editing.
  useEffect(() => {
    if (skill.data && draft === null) setDraft(toDraft(skill.data));
  }, [skill.data, draft]);

  const dirty = useMemo(() => {
    if (!skill.data || !draft) return false;
    const base = toDraft(skill.data);
    return (
      base.name !== draft.name ||
      base.description !== draft.description ||
      base.content !== draft.content
    );
  }, [skill.data, draft]);

  async function save() {
    if (!draft) return;
    if (draft.name.trim().length === 0) {
      setNameError("A skill needs a name.");
      return;
    }
    try {
      await update.mutateAsync({
        skillId,
        patch: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          content: draft.content,
        },
      });
      toast({ variant: "success", message: "Skill saved." });
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  const header = (
    <header className="flex items-center gap-3 px-5 pb-3 pt-4">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to context"
        className="lift flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
        {skill.data?.name ?? "Skill"}
      </h1>
      {!readOnly && draft ? (
        <div className="flex items-center gap-3">
          <span
            aria-live="polite"
            className="text-[12px] text-ink-4"
          >
            {dirty ? "Unsaved changes" : (
              <span className="inline-flex items-center gap-1 text-ok">
                <Check size={13} aria-hidden="true" /> Saved
              </span>
            )}
          </span>
          <Button size="sm" loading={update.isPending} disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
    </header>
  );

  return (
    <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
      {header}
      <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />

      {skill.isPending || draft === null ? (
        <div className="flex flex-1 gap-5 p-5">
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-10 w-1/2" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-full min-h-40 w-full" />
          </div>
          <Skeleton className="hidden h-40 w-64 sm:block" />
        </div>
      ) : skill.isError ? (
        <ErrorState
          message={errorMessage(skill.error)}
          onRetry={() => void skill.refetch()}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 sm:flex-row">
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <Input
              label="Name"
              value={draft.name}
              readOnly={readOnly}
              error={nameError}
              onChange={(event) => {
                setDraft({ ...draft, name: event.currentTarget.value });
                if (nameError) setNameError(null);
              }}
            />
            <Textarea
              label="Description"
              value={draft.description}
              rows={2}
              readOnly={readOnly}
              hint="A one-liner the agent uses to decide when to reach for this skill."
              onChange={(event) =>
                setDraft({ ...draft, description: event.currentTarget.value })
              }
            />
            <div className="flex min-h-64 flex-1 flex-col gap-1.5">
              <span className="px-1 text-[13px] font-medium text-ink-2">
                Instructions
              </span>
              <div className="min-h-0 flex-1">
                <CodeMirrorMarkdown
                  ariaLabel="Skill instructions (markdown)"
                  value={draft.content}
                  readOnly={readOnly}
                  placeholder={"# How to…\n\nWrite the skill in Markdown."}
                  onChange={(content) => setDraft({ ...draft, content })}
                />
              </div>
            </div>
          </div>

          <AttachmentsSidebar
            scope={scope}
            skillId={skillId}
            files={skill.data.files}
            readOnly={readOnly}
          />
        </div>
      )}
    </Panel>
  );
}
