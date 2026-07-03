/**
 * Create/edit an agent preset in a right-docked drawer: name, description,
 * base prompt (with character guidance), reasoning effort, model preset, and
 * an optional specific-model override drawn from the allowlist.
 */
import { useEffect, useState } from "react";
import type {
  AgentPresetDto,
  CreateAgentPresetRequest,
  ModelAllowlistEntryDto,
  ModelPresetSlug,
  ReasoningEffort,
} from "@invisible-string/shared";
import {
  createAgentPresetRequestSchema,
  reasoningEffortSchema,
} from "@invisible-string/shared";

import { errorMessage, fieldErrorsFromZod } from "../../lib/forms";
import {
  PRESET_LABEL,
  PRESET_ORDER,
  PROVIDER_LABEL,
  REASONING_LABEL,
} from "../../lib/labels";
import { Button } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";

const BASE_PROMPT_MAX = 50_000;
const BASE_PROMPT_ADVICE = 1_500;

export interface AgentPresetDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Present = edit, absent = create. */
  preset: AgentPresetDto | null;
  allowlist: ModelAllowlistEntryDto[];
  onSubmit: (input: CreateAgentPresetRequest) => Promise<unknown>;
  saving: boolean;
  error?: unknown;
}

interface Draft {
  name: string;
  description: string;
  basePrompt: string;
  reasoningEffort: ReasoningEffort;
  modelPreset: ModelPresetSlug;
  modelId: string;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  basePrompt: "",
  reasoningEffort: "medium",
  modelPreset: "balanced",
  modelId: "",
};

function fromPreset(preset: AgentPresetDto): Draft {
  return {
    name: preset.name,
    description: preset.description ?? "",
    basePrompt: preset.basePrompt,
    reasoningEffort: preset.reasoningEffort,
    modelPreset: preset.modelPreset,
    modelId: preset.modelId ?? "",
  };
}

export function AgentPresetDrawer({
  open,
  onClose,
  preset,
  allowlist,
  onSubmit,
  saving,
  error,
}: AgentPresetDrawerProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Reset the form each time the drawer opens (fresh create or a given edit).
  useEffect(() => {
    if (!open) return;
    setDraft(preset ? fromPreset(preset) : EMPTY);
    setFieldErrors({});
  }, [open, preset]);

  const enabledModels = allowlist.filter((entry) => entry.enabled);

  async function submit() {
    const candidate = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      basePrompt: draft.basePrompt,
      reasoningEffort: draft.reasoningEffort,
      modelPreset: draft.modelPreset,
      modelId: draft.modelId ? draft.modelId : undefined,
    };
    const parsed = createAgentPresetRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    await onSubmit(parsed.data);
  }

  const promptLen = draft.basePrompt.length;
  const topError = error ? errorMessage(error) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={preset ? "Edit agent preset" : "New agent preset"}
      description="A reusable persona and model configuration workflows can pick."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" loading={saving} onClick={() => void submit()}>
            {preset ? "Save changes" : "Create preset"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <Input
          label="Name"
          value={draft.name}
          autoFocus
          placeholder="e.g. Support triager"
          error={fieldErrors["name"]}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
        />
        <Input
          label="Description (optional)"
          value={draft.description}
          placeholder="One line about what this agent is for."
          onChange={(event) =>
            setDraft({ ...draft, description: event.currentTarget.value })
          }
        />
        <Textarea
          label="Base prompt"
          value={draft.basePrompt}
          rows={7}
          maxLength={BASE_PROMPT_MAX}
          placeholder="You are…"
          error={fieldErrors["basePrompt"]}
          hint={
            promptLen === 0
              ? `The persona prepended to every run. Aim for under ${BASE_PROMPT_ADVICE.toLocaleString()} characters.`
              : `${promptLen.toLocaleString()} / ${BASE_PROMPT_MAX.toLocaleString()} characters`
          }
          onChange={(event) =>
            setDraft({ ...draft, basePrompt: event.currentTarget.value })
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Reasoning"
            value={draft.reasoningEffort}
            onChange={(event) =>
              setDraft({
                ...draft,
                reasoningEffort: event.currentTarget.value as ReasoningEffort,
              })
            }
            options={reasoningEffortSchema.options.map((value) => ({
              value,
              label: REASONING_LABEL[value],
            }))}
          />
          <Select
            label="Model preset"
            value={draft.modelPreset}
            onChange={(event) =>
              setDraft({
                ...draft,
                modelPreset: event.currentTarget.value as ModelPresetSlug,
              })
            }
            options={PRESET_ORDER.map((slug) => ({
              value: slug,
              label: PRESET_LABEL[slug],
            }))}
          />
        </div>
        <Select
          label="Model override (optional)"
          value={draft.modelId}
          onChange={(event) => setDraft({ ...draft, modelId: event.currentTarget.value })}
          options={[
            { value: "", label: "Use the model preset" },
            ...enabledModels.map((entry) => ({
              value: entry.modelId,
              label: `${PROVIDER_LABEL[entry.provider]} · ${entry.modelId}`,
            })),
          ]}
        />

        {topError ? (
          <p role="alert" className="text-[13px] text-err">
            {topError}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
