/**
 * AGENT focused editor: preset picker cards + model-preset segmented control
 * + optional specific-model override (allowlist-limited) + reasoning select +
 * run-as display. Model resolution order mirrors the compiler
 * (override → preset override → agent preset default).
 */
import { Bot, UserRound } from "lucide-react";
import type {
  AgentPresetDto,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  ModelPresetSlug,
  ReasoningEffort,
  WorkflowDefinition,
  WorkspaceMemberDto,
} from "@invisible-string/shared";

import type { BuilderAction } from "../../lib/builder/model";
import { shortModelId } from "../../lib/builder/summary";
import { cn } from "../../lib/cn";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { StatusChip } from "../ui/StatusChip";

const MODEL_PRESET_OPTIONS: { value: ModelPresetSlug; label: string }[] = [
  { value: "powerful", label: "Powerful" },
  { value: "balanced", label: "Balanced" },
  { value: "quick", label: "Quick" },
];

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const NO_OVERRIDE = "__preset__";

export interface AgentEditorProps {
  definition: WorkflowDefinition;
  dispatch: (action: BuilderAction) => void;
  presets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  allowlist: readonly ModelAllowlistEntryDto[];
  members: readonly WorkspaceMemberDto[];
  runAsUserId: string;
  onChangeRunAs: (userId: string) => void;
}

export function AgentEditor({
  definition,
  dispatch,
  presets,
  modelPresets,
  allowlist,
  members,
  runAsUserId,
  onChangeRunAs,
}: AgentEditorProps) {
  const agent = definition.agent;
  const selectedPreset = presets.find((p) => p.id === agent.agentPresetId);
  const effectiveSlug: ModelPresetSlug =
    agent.modelPreset ?? selectedPreset?.modelPreset ?? "balanced";
  const enabledModels = allowlist.filter((entry) => entry.enabled);

  const runAsMember = members.find((m) => m.userId === runAsUserId);

  return (
    <div className="flex flex-col gap-6">
      {/* Preset picker */}
      <fieldset>
        <legend className="mb-3 px-0.5 text-[13px] font-medium text-ink-2">
          Agent preset
        </legend>
        {presets.length === 0 ? (
          <p className="rounded-card border border-dashed border-black/15 px-4 py-6 text-center text-[13px] text-ink-4">
            No agent presets in this workspace yet.
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Agent preset"
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
          >
            {presets.map((preset) => {
              const selected = preset.id === agent.agentPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() =>
                    dispatch({ type: "setAgentPreset", id: preset.id })
                  }
                  className={cn(
                    "lift flex items-start gap-3 rounded-card-lg border p-3.5 text-left",
                    selected
                      ? "border-ink/80 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
                      : "border-black/10 bg-white/40 hover:border-black/20 hover:bg-white/60",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full",
                      selected ? "bg-ink text-white" : "bg-black/[0.05] text-ink-3",
                    )}
                  >
                    <Bot size={17} aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13.5px] font-semibold text-ink">
                      {preset.name}
                    </span>
                    {preset.description ? (
                      <span className="line-clamp-2 text-[12px] leading-snug text-ink-3">
                        {preset.description}
                      </span>
                    ) : null}
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      <StatusChip tone="neutral">{preset.modelPreset}</StatusChip>
                      <StatusChip tone="neutral">
                        {preset.reasoningEffort} reasoning
                      </StatusChip>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </fieldset>

      {/* Model preset */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="px-0.5 text-[13px] font-medium text-ink-2">
            Model preset
          </span>
          {agent.modelPreset ? (
            <button
              type="button"
              onClick={() => dispatch({ type: "setModelPreset", preset: undefined })}
              className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            >
              Reset to preset default
            </button>
          ) : null}
        </div>
        <SegmentedControl
          label="Model preset"
          options={MODEL_PRESET_OPTIONS}
          value={effectiveSlug}
          onChange={(value) => dispatch({ type: "setModelPreset", preset: value })}
        />
        <p className="px-0.5 text-[12px] text-ink-3">
          {resolvedModelLine(agent, selectedPreset, modelPresets, effectiveSlug)}
        </p>
      </div>

      {/* Specific-model override */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Model override (optional)"
          value={agent.modelId ?? NO_OVERRIDE}
          options={[
            { value: NO_OVERRIDE, label: "Use the preset's model" },
            ...enabledModels.map((entry) => ({
              value: entry.modelId,
              label: `${shortModelId(entry.modelId)} · ${entry.provider}`,
            })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            dispatch({
              type: "setModelId",
              modelId: value === NO_OVERRIDE ? undefined : value,
            });
          }}
        />
        <Select
          label="Reasoning effort"
          value={agent.reasoning ?? selectedPreset?.reasoningEffort ?? "medium"}
          options={REASONING_OPTIONS}
          onChange={(event) =>
            dispatch({
              type: "setReasoning",
              reasoning: event.currentTarget.value as ReasoningEffort,
            })
          }
        />
      </div>
      {agent.modelId && !enabledModels.some((e) => e.modelId === agent.modelId) ? (
        <p className="-mt-3 px-0.5 text-[12px] text-err">
          {shortModelId(agent.modelId)} is not on the workspace allowlist — it
          will be rejected at publish.
        </p>
      ) : null}

      {/* Run-as */}
      <div className="flex flex-col gap-2.5 rounded-card border border-black/[0.07] bg-white/40 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <UserRound size={15} className="text-ink-3" aria-hidden="true" />
          <h3 className="text-[13.5px] font-semibold text-ink">Run as</h3>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Runs use this member's connected credentials. They must stay a
          workspace member for the workflow to publish.
        </p>
        {members.length > 0 ? (
          <Select
            label="Run-as member"
            srOnlyLabel
            value={runAsUserId}
            options={members.map((member) => ({
              value: member.userId,
              label: member.name
                ? `${member.name} · ${member.email}`
                : member.email,
            }))}
            onChange={(event) => onChangeRunAs(event.currentTarget.value)}
          />
        ) : (
          <StatusChip tone="neutral">{runAsMember?.email ?? runAsUserId}</StatusChip>
        )}
      </div>
    </div>
  );
}

function resolvedModelLine(
  agent: WorkflowDefinition["agent"],
  preset: AgentPresetDto | undefined,
  modelPresets: readonly ModelPresetDto[],
  slug: ModelPresetSlug,
): string {
  if (agent.modelId) {
    return `Resolves to ${shortModelId(agent.modelId)} (override).`;
  }
  if (preset?.modelId) {
    return `Resolves to ${shortModelId(preset.modelId)} (preset's model).`;
  }
  const mapped = modelPresets.find((mp) => mp.slug === slug);
  return mapped
    ? `${slug} maps to ${shortModelId(mapped.modelId)} in this workspace.`
    : `${slug} preset.`;
}
