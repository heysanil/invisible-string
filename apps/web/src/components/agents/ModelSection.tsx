/**
 * MODEL section: preset segmented control + optional specific-model override
 * (allowlist-limited) + reasoning effort. The agent IS the base configuration
 * now — there is no upstream preset to reset to. Model resolution order
 * mirrors the compiler (override → workspace preset mapping).
 *
 * Reasoning effort is INHERITED by default (`model.reasoning === undefined`):
 * the preset's own effort when resolving through a preset, the model's
 * provider default under a specific-model override — inheriting a preset's
 * `max` onto a deliberately-chosen cheap model is the wrong semantic. The
 * option list is filtered by what the OpenRouter catalog says the effective
 * model supports, and falls back to the whole vocabulary when that is
 * unknown (fail-open, exactly like the catalog check on allowlist adds).
 */
import type {
  AgentDefinition,
  ModelAllowlistEntryDto,
  ModelCapabilityDto,
  ModelPresetDto,
  ModelPresetSlug,
  ReasoningEffort,
} from "@invisible-string/shared";

import type { AgentEditorAction } from "../../lib/agents/model";
import { shortModelId } from "../../lib/builder/summary";
import { offeredReasoningEfforts, REASONING_LABEL } from "../../lib/labels";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";

const MODEL_PRESET_OPTIONS: { value: ModelPresetSlug; label: string }[] = [
  { value: "powerful", label: "Powerful" },
  { value: "balanced", label: "Balanced" },
  { value: "quick", label: "Quick" },
];

const NO_OVERRIDE = "__preset__";
/** Sentinel for "no explicit effort" — mirrors NO_OVERRIDE's shape. */
const INHERIT = "__inherit__";

/**
 * What an unset `model.reasoning` inherits. `null` = a preset this workspace
 * hasn't loaded yet, so the effort can't be named.
 */
function inheritedReasoning(
  model: AgentDefinition["model"],
  preset: ModelPresetDto | undefined,
): ReasoningEffort | null {
  // An override never inherits the PRESET's effort — it falls to the model's
  // own default (the compiler resolves this to `provider-default`).
  if (model.modelId) return "provider-default";
  return preset?.reasoning ?? null;
}

/** What this model block actually resolves to, and whether it was inherited. */
function effectiveReasoning(
  model: AgentDefinition["model"],
  preset: ModelPresetDto | undefined,
): { effort: ReasoningEffort | null; inherited: boolean } {
  return model.reasoning !== undefined
    ? { effort: model.reasoning, inherited: false }
    : { effort: inheritedReasoning(model, preset), inherited: true };
}

/** "What actually runs" line — shared with the rail's Model summary card. */
export function resolvedModelLine(
  model: AgentDefinition["model"],
  modelPresets: readonly ModelPresetDto[],
): string {
  const mapped = modelPresets.find((preset) => preset.slug === model.preset);
  const { effort, inherited } = effectiveReasoning(model, mapped);
  const reasoning =
    effort === null
      ? ""
      : ` Reasoning: ${REASONING_LABEL[effort]}${inherited ? " (inherited)" : ""}.`;

  if (model.modelId) {
    return `Resolves to ${shortModelId(model.modelId)} (override).${reasoning}`;
  }
  return mapped
    ? `${model.preset} maps to ${shortModelId(mapped.modelId)} in this workspace.${reasoning}`
    : `${model.preset} preset.${reasoning}`;
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
  /**
   * Per-model catalog capabilities; null while loading or when the catalog
   * could not be consulted. Either way the effort selector offers the full
   * vocabulary rather than emptying.
   */
  capabilities: readonly ModelCapabilityDto[] | null;
}

export function ModelSection({
  model,
  dispatch,
  modelPresets,
  allowlist,
  capabilities,
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

  // ── reasoning effort ──────────────────────────────────────────────────────

  const mappedPreset = modelPresets.find(
    (preset) => preset.slug === model.preset,
  );
  const effectiveModelId = model.modelId ?? mappedPreset?.modelId;
  const supported =
    capabilities?.find((entry) => entry.modelId === effectiveModelId)
      ?.supportedEfforts ?? null;
  // Unknown support (no catalog row, unreachable catalog, Anthropic) offers
  // everything; a KNOWN set is offered plus `provider-default`, which is the
  // only usable option when the catalog lists a model with no reasoning
  // support at all. Never an empty selector.
  const offered = offeredReasoningEfforts(supported);

  const inheritedEffort = inheritedReasoning(model, mappedPreset);
  const reasoningOptions = [
    {
      value: INHERIT,
      label: model.modelId
        ? "Inherit (model default)"
        : inheritedEffort === null
          ? "Inherit from preset"
          : `Inherit from preset (${REASONING_LABEL[inheritedEffort]})`,
    },
    ...offered.map((effort) => ({
      value: effort,
      label: REASONING_LABEL[effort],
    })),
  ];
  // Same "keep the stored value visible" guard as the override select: an
  // explicit effort this model doesn't advertise stays selectable and is
  // flagged ADVISORY below — never a publish blocker, so republishing an
  // existing agent can't hard-fail on catalog drift. `provider-default` is
  // exempt: no catalog ever lists it, yet it is valid everywhere, so flagging
  // it would warn about the one universally-safe choice.
  const unsupportedEffort =
    model.reasoning !== undefined &&
    model.reasoning !== "provider-default" &&
    supported !== null &&
    !supported.includes(model.reasoning)
      ? model.reasoning
      : null;
  if (unsupportedEffort !== null) {
    reasoningOptions.push({
      value: unsupportedEffort,
      label: REASONING_LABEL[unsupportedEffort],
    });
  }

  // The advisory line, computed off the EFFECTIVE effort so an INHERITED one
  // is covered too. Two cases, most specific first:
  //  - the catalog lists this model with an empty supported set (~a third of
  //    OpenRouter's catalog): any level — inherited or explicit — bakes a
  //    reasoning block onto a model with no use for it, and "Model default"
  //    is the escape hatch;
  //  - the model advertises efforts but not this one.
  // Both are ADVISORY. Publishing never hard-fails on catalog drift.
  const { effort: effectiveEffort } = effectiveReasoning(model, mappedPreset);
  const reasoningAdvisory =
    effectiveModelId === undefined ||
    effectiveEffort === null ||
    effectiveEffort === "provider-default"
      ? null
      : supported !== null && supported.length === 0
        ? `${shortModelId(effectiveModelId)} advertises no reasoning support — “${REASONING_LABEL["provider-default"]}” sends no reasoning field at all. Publishing still works.`
        : unsupportedEffort !== null
          ? `${shortModelId(effectiveModelId)} does not advertise ${REASONING_LABEL[unsupportedEffort].toLowerCase()} reasoning — the provider may ignore it. Publishing still works.`
          : null;

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
          value={model.reasoning ?? INHERIT}
          options={reasoningOptions}
          onChange={(event) => {
            const value = event.currentTarget.value;
            dispatch({
              type: "setReasoning",
              reasoning:
                value === INHERIT ? undefined : (value as ReasoningEffort),
            });
          }}
        />
      </div>
      {reasoningAdvisory !== null ? (
        <p className="-mt-3 px-0.5 text-[12px] text-warn">{reasoningAdvisory}</p>
      ) : null}
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
