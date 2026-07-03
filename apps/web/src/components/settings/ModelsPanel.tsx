/**
 * Model presets: the three fixed slugs (powerful / balanced / quick), each
 * re-pointed at a provider + model drawn from the workspace allowlist. The
 * model select only ever offers allowlisted, enabled models; the server
 * re-checks and answers 422 `model_not_allowlisted` if the two ever drift.
 */
import type {
  ModelAllowlistEntryDto,
  ModelPresetDto,
  ModelProvider,
} from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { PRESET_HINT, PRESET_LABEL, PRESET_ORDER, PROVIDER_LABEL } from "../../lib/labels";
import {
  useModelAllowlist,
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
  const update = useUpdateModelPreset(workspaceId);
  const { toast } = useToast();

  const enabledEntries = (allowlist.data ?? []).filter((entry) => entry.enabled);

  function modelsFor(provider: ModelProvider): ModelAllowlistEntryDto[] {
    return enabledEntries.filter((entry) => entry.provider === provider);
  }

  function repoint(
    preset: ModelPresetDto,
    provider: ModelProvider,
    modelId: string,
  ) {
    if (provider === preset.provider && modelId === preset.modelId) return;
    update.mutate(
      { slug: preset.slug, patch: { provider, modelId } },
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
      description="Point each preset at a provider and model. Presets are what workflows pick from."
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
            return (
              <div
                key={slug}
                className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-ink">
                        {PRESET_LABEL[slug]}
                      </h3>
                      <Chip tone="ink">
                        {PROVIDER_LABEL[preset.provider]} · {preset.modelId}
                      </Chip>
                    </div>
                    <p className="text-[12.5px] text-ink-3">{PRESET_HINT[slug]}</p>
                  </div>
                </div>

                {canManage ? (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Select
                      label="Provider"
                      value={preset.provider}
                      onChange={(event) => {
                        const provider = event.currentTarget.value as ModelProvider;
                        const first = modelsFor(provider)[0];
                        repoint(preset, provider, first?.modelId ?? preset.modelId);
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
                      onChange={(event) =>
                        repoint(preset, preset.provider, event.currentTarget.value)
                      }
                      options={providerModels.map((entry) => ({
                        value: entry.modelId,
                        label: entry.modelId,
                      }))}
                    />
                  </div>
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
        </div>
      )}
    </SettingsSection>
  );
}
