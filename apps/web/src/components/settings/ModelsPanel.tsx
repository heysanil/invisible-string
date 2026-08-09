/**
 * Model presets: the three fixed slugs (powerful / balanced / quick), each
 * re-pointed at a provider + model + REASONING EFFORT drawn from the
 * workspace allowlist. The model select only ever offers allowlisted, enabled
 * models; the server re-checks and answers 422 `model_not_allowlisted` if the
 * two ever drift.
 *
 * The effort is part of the preset (two tiers may share a model and differ
 * only in effort — the seeded `balanced`/`quick` pair does exactly that), and
 * the offered efforts are filtered by what the catalog says that model
 * supports, falling back to the whole vocabulary when unknown.
 */
import type {
  ModelAllowlistEntryDto,
  ModelPresetDto,
  ModelProvider,
  ReasoningEffort,
} from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import {
  offeredReasoningEfforts,
  PRESET_HINT,
  PRESET_LABEL,
  PRESET_ORDER,
  PROVIDER_LABEL,
  REASONING_LABEL,
  sortReasoningEfforts,
} from "../../lib/labels";
import {
  useModelAllowlist,
  useModelCapabilities,
  useModelPresets,
  useUpdateModelPreset,
} from "../../lib/queries/models";
import { Chip } from "../ui/Chip";
import { ErrorState } from "../ui/ErrorState";
import { Select } from "../ui/Select";
import { SkeletonList } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { SettingsSection } from "./SettingsSection";

export interface ModelsPanelProps {
  workspaceId: string;
  canManage: boolean;
}

const PROVIDERS: ModelProvider[] = ["anthropic", "openrouter"];

export function ModelsPanel({ workspaceId, canManage }: ModelsPanelProps) {
  const presets = useModelPresets(workspaceId);
  const allowlist = useModelAllowlist(workspaceId);
  // Capabilities are advisory: an error or an unreachable catalog just means
  // "unknown", which offers the full effort vocabulary (never blocks a save).
  const capabilities = useModelCapabilities(workspaceId);
  const update = useUpdateModelPreset(workspaceId);
  const { toast } = useToast();

  const enabledEntries = (allowlist.data ?? []).filter((entry) => entry.enabled);

  function modelsFor(provider: ModelProvider): ModelAllowlistEntryDto[] {
    return enabledEntries.filter((entry) => entry.provider === provider);
  }

  /**
   * The catalog's supported set for a model — `null` = UNKNOWN (no row, no
   * catalog, or a non-OpenRouter provider). An EMPTY array is a different
   * answer: the catalog lists this model and it advertises no reasoning
   * support at all, so it must not be collapsed into "unknown".
   */
  function supportedEffortsFor(modelId: string): ReasoningEffort[] | null {
    const entry = capabilities.data?.find(
      (candidate) => candidate.modelId === modelId,
    );
    if (entry === undefined || entry.supportedEfforts === null) return null;
    return sortReasoningEfforts(entry.supportedEfforts);
  }

  /**
   * Keep the effort valid for the model it will run on. When the new model
   * does not advertise the current effort we snap to the catalog's own
   * default, and to `provider-default` (= send no reasoning field) when it
   * names none — the one value that is safe on every model.
   */
  function effortFor(modelId: string, current: ReasoningEffort): ReasoningEffort {
    // `provider-default` is never "unsupported": no catalog advertises it and
    // it is legal everywhere, so a deliberate choice of it must survive a
    // model change instead of being snapped onto a level.
    if (current === "provider-default") return current;
    const supported = supportedEffortsFor(modelId);
    if (supported === null || supported.includes(current)) return current;
    const entry = capabilities.data?.find(
      (candidate) => candidate.modelId === modelId,
    );
    return entry?.defaultEffort ?? "provider-default";
  }

  function repoint(
    preset: ModelPresetDto,
    provider: ModelProvider,
    modelId: string,
    reasoning: ReasoningEffort,
  ) {
    if (
      provider === preset.provider &&
      modelId === preset.modelId &&
      reasoning === preset.reasoning
    ) {
      return;
    }
    update.mutate(
      { slug: preset.slug, patch: { provider, modelId, reasoning } },
      {
        onSuccess: () =>
          toast({ variant: "success", message: `${PRESET_LABEL[preset.slug]} updated.` }),
        onError: (error) => toast({ variant: "error", message: errorMessage(error) }),
      },
    );
  }

  const loading = presets.isPending || allowlist.isPending;
  const errored = presets.isError || allowlist.isError;

  return (
    <SettingsSection
      title="Models"
      description="Point each preset at a provider, model and reasoning effort. Presets are what agents and workflows pick from."
    >
      {loading ? (
        <SkeletonList rows={3} />
      ) : errored ? (
        <ErrorState
          compact
          message={errorMessage(presets.error ?? allowlist.error)}
          onRetry={() => {
            void presets.refetch();
            void allowlist.refetch();
          }}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {PRESET_ORDER.map((slug) => {
            const preset = presets.data.find((candidate) => candidate.slug === slug);
            if (!preset) return null;
            const providerModels = modelsFor(preset.provider);
            const modelOnList = providerModels.some(
              (entry) => entry.modelId === preset.modelId,
            );
            const supported = supportedEffortsFor(preset.modelId);
            // Always includes `provider-default` — the only usable option on a
            // model the catalog lists with an EMPTY supported set, which would
            // otherwise leave an admin with a one-option selector.
            const effortOptions = offeredReasoningEfforts(supported);
            // Keep the STORED effort selectable even when the catalog does not
            // advertise it — a Select with no matching option would silently
            // display the wrong value (same guard the agent editor uses).
            const effortShown = effortOptions.includes(preset.reasoning)
              ? effortOptions
              : [...effortOptions, preset.reasoning];
            // The catalog can say a model supports NO efforts at all. Every
            // agent inheriting this preset would then send a reasoning block
            // to a model with no use for it — advisory, never a save blocker.
            const noReasoningSupport =
              supported !== null &&
              supported.length === 0 &&
              preset.reasoning !== "provider-default";
            return (
              <div
                key={slug}
                className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-ink">
                        {PRESET_LABEL[slug]}
                      </h3>
                      <Chip tone="ink">
                        {PROVIDER_LABEL[preset.provider]} · {preset.modelId}
                      </Chip>
                      <Chip tone="neutral">
                        {REASONING_LABEL[preset.reasoning]} reasoning
                      </Chip>
                    </div>
                    <p className="text-[12.5px] text-ink-3">{PRESET_HINT[slug]}</p>
                  </div>
                </div>

                {canManage ? (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    <Select
                      label="Provider"
                      value={preset.provider}
                      onChange={(event) => {
                        const provider = event.currentTarget.value as ModelProvider;
                        const first = modelsFor(provider)[0];
                        const modelId = first?.modelId ?? preset.modelId;
                        repoint(
                          preset,
                          provider,
                          modelId,
                          effortFor(modelId, preset.reasoning),
                        );
                      }}
                      options={PROVIDERS.map((provider) => ({
                        value: provider,
                        label: PROVIDER_LABEL[provider],
                      }))}
                    />
                    <Select
                      label="Model"
                      value={modelOnList ? preset.modelId : ""}
                      placeholder={modelOnList ? undefined : "Select a model"}
                      onChange={(event) => {
                        const modelId = event.currentTarget.value;
                        repoint(
                          preset,
                          preset.provider,
                          modelId,
                          effortFor(modelId, preset.reasoning),
                        );
                      }}
                      options={providerModels.map((entry) => ({
                        value: entry.modelId,
                        label: entry.modelId,
                      }))}
                    />
                    <Select
                      label="Reasoning effort"
                      value={preset.reasoning}
                      onChange={(event) =>
                        repoint(
                          preset,
                          preset.provider,
                          preset.modelId,
                          event.currentTarget.value as ReasoningEffort,
                        )
                      }
                      options={effortShown.map((effort) => ({
                        value: effort,
                        label: REASONING_LABEL[effort],
                      }))}
                    />
                  </div>
                ) : null}

                {noReasoningSupport ? (
                  <p className="text-[12.5px] text-warn">
                    {preset.modelId} advertises no reasoning support — “
                    {REASONING_LABEL["provider-default"]}” sends no reasoning
                    field at all. Presets still save and publish.
                  </p>
                ) : null}

                {canManage && providerModels.length === 0 ? (
                  <p className="text-[12.5px] text-warn">
                    No enabled {PROVIDER_LABEL[preset.provider]} models on the
                    allowlist. Add one under Allowlist.
                  </p>
                ) : null}
              </div>
            );
          })}

          {/*
            Dispatch reads the model baked into the published agent VERSION,
            never the live preset row — so a re-point is inert until each
            agent is published again.
          */}
          <p className="px-1 pt-1 text-[12.5px] text-ink-3">
            Preset changes apply on the next publish. Agents already published
            keep running the model and effort baked into their current version
            until you publish them again.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}
