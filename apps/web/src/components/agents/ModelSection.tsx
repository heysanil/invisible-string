/**
 * MODEL section: preset segmented control + optional specific-model override
 * (allowlist-limited) + reasoning effort. The agent IS the base configuration
 * now — there is no upstream preset to reset to. Model resolution order
 * mirrors the compiler (override → workspace preset mapping).
 */
import type {
  AgentDefinition,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  ModelPresetSlug,
  ReasoningEffort,
} from "@invisible-string/shared";

import type { AgentEditorAction } from "../../lib/agents/model";
import { shortModelId } from "../../lib/builder/summary";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";

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

/** "What actually runs" line — shared with the rail's Model summary card. */
export function resolvedModelLine(
  model: AgentDefinition["model"],
  modelPresets: readonly ModelPresetDto[],
): string {
  if (model.modelId) {
    return `Resolves to ${shortModelId(model.modelId)} (override).`;
  }
  const mapped = modelPresets.find((preset) => preset.slug === model.preset);
  return mapped
    ? `${model.preset} maps to ${shortModelId(mapped.modelId)} in this workspace.`
    : `${model.preset} preset.`;
}

export interface ModelSectionProps {
  model: AgentDefinition["model"];
  dispatch: (action: AgentEditorAction) => void;
  modelPresets: readonly ModelPresetDto[];
  /**
   * Null while the allowlist query is in flight — the off-allowlist error
   * must NOT flash for a stored override we simply haven't verified yet
   * (loading is not the same as "empty allowlist").
   */
  allowlist: readonly ModelAllowlistEntryDto[] | null;
}

export function ModelSection({
  model,
  dispatch,
  modelPresets,
  allowlist,
}: ModelSectionProps) {
  const enabledModels = (allowlist ?? []).filter((entry) => entry.enabled);
  const overrideOptions = [
    { value: NO_OVERRIDE, label: "Use the preset's model" },
    ...enabledModels.map((entry) => ({
      value: entry.modelId,
      label: `${shortModelId(entry.modelId)} · ${entry.provider}`,
    })),
  ];
  // Keep the STORED override visible while the allowlist loads (or when it
  // has since been removed from the allowlist) — a Select with no matching
  // option would silently display the wrong value.
  if (
    model.modelId !== undefined &&
    !overrideOptions.some((option) => option.value === model.modelId)
  ) {
    overrideOptions.push({
      value: model.modelId,
      label: shortModelId(model.modelId),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Model preset */}
      <div className="flex flex-col gap-2.5">
        <span className="px-0.5 text-[13px] font-medium text-ink-2">
          Model preset
        </span>
        <SegmentedControl
          variant="radio"
          label="Model preset"
          options={MODEL_PRESET_OPTIONS}
          value={model.preset}
          onChange={(value) => dispatch({ type: "setModelPreset", preset: value })}
        />
        <p className="px-0.5 text-[12px] text-ink-3">
          {resolvedModelLine(model, modelPresets)}
        </p>
      </div>

      {/* Specific-model override + reasoning */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Model override (optional)"
          value={model.modelId ?? NO_OVERRIDE}
          options={overrideOptions}
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
          value={model.reasoning}
          options={REASONING_OPTIONS}
          onChange={(event) =>
            dispatch({
              type: "setReasoning",
              reasoning: event.currentTarget.value as ReasoningEffort,
            })
          }
        />
      </div>
      {model.modelId &&
      allowlist !== null &&
      !enabledModels.some((e) => e.modelId === model.modelId) ? (
        <p className="-mt-3 px-0.5 text-[12px] text-err">
          {shortModelId(model.modelId)} is not on the workspace allowlist — it
          will be rejected at publish.
        </p>
      ) : null}
    </div>
  );
}
