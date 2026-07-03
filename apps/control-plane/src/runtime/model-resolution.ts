/**
 * Preset→model resolution + allowlist validation (spec §7; runs FIRST in the
 * publish path, before any compile work, so typed errors surface to the API).
 *
 * Resolution order (spec §7):
 *   1. workflow `modelId` override            — wins outright
 *   2. workflow `modelPreset` override        — else the agent preset's slug
 *   3. workspace model_presets mapping        — slug → provider + modelId
 *   4. model_allowlist check (enabled)        — ALWAYS, on the final model
 *
 * Pure core (`resolveModel`) over pre-loaded rows so it unit-tests without a
 * database; `loadModelResolutionData` is the drizzle loader.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  AgentConfig,
  ModelPresetSlug,
  ReasoningEffort,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "./errors";

export type ModelProvider = "anthropic" | "openrouter";

export interface ResolvedModel {
  provider: ModelProvider;
  modelId: string;
  /** The preset slug the model came through (absent for modelId overrides). */
  presetSlug?: ModelPresetSlug;
  reasoning: ReasoningEffort;
  /** Agent-preset persona, prepended to instructions.md by the compiler. */
  agentName: string;
  basePrompt: string;
}

export interface AgentPresetRow {
  id: string;
  name: string;
  basePrompt: string;
  reasoningEffort: ReasoningEffort;
  modelPreset: ModelPresetSlug;
  modelId: string | null;
}

export interface ModelPresetRow {
  slug: ModelPresetSlug;
  provider: ModelProvider;
  modelId: string;
}

export interface AllowlistRow {
  provider: ModelProvider;
  modelId: string;
  enabled: boolean;
}

export interface ModelResolutionData {
  /** The agents row named by agentPresetId; null when it doesn't exist. */
  agentPreset: AgentPresetRow | null;
  /** All workspace model presets. */
  modelPresets: ModelPresetRow[];
  /** All workspace allowlist rows. */
  allowlist: AllowlistRow[];
}

/** Pure resolution — throws typed RuntimeApiErrors (422s). */
export function resolveModel(
  agent: AgentConfig,
  data: ModelResolutionData,
): ResolvedModel {
  const preset = data.agentPreset;
  if (!preset) throw errors.agentPresetNotFound(agent.agentPresetId);

  const reasoning = agent.reasoning ?? preset.reasoningEffort;
  const base = { reasoning, agentName: preset.name, basePrompt: preset.basePrompt };

  const findAllowed = (modelId: string, provider?: ModelProvider) =>
    data.allowlist.find(
      (row) =>
        row.modelId === modelId &&
        row.enabled &&
        (provider === undefined || row.provider === provider),
    );

  // 1. Specific-model override (workflow-level wins over the agent preset's).
  const modelIdOverride = agent.modelId ?? preset.modelId ?? undefined;
  if (modelIdOverride !== undefined) {
    const allowed = findAllowed(modelIdOverride);
    if (!allowed) throw errors.modelNotAllowlisted(modelIdOverride);
    return { ...base, provider: allowed.provider, modelId: modelIdOverride };
  }

  // 2./3. Preset slug → workspace mapping.
  const slug = agent.modelPreset ?? preset.modelPreset;
  const mapping = data.modelPresets.find((row) => row.slug === slug);
  if (!mapping) throw errors.modelPresetNotFound(slug);

  // 4. Allowlist check on the resolved model.
  if (!findAllowed(mapping.modelId, mapping.provider)) {
    throw errors.modelNotAllowlisted(mapping.modelId);
  }

  return {
    ...base,
    provider: mapping.provider,
    modelId: mapping.modelId,
    presetSlug: slug,
  };
}

/** Load the rows {@link resolveModel} needs for one workspace + agent preset. */
export async function loadModelResolutionData(
  db: Db,
  organizationId: string,
  agentPresetId: string,
): Promise<ModelResolutionData> {
  const [agentRows, presetRows, allowRows] = await Promise.all([
    db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        basePrompt: schema.agents.basePrompt,
        reasoningEffort: schema.agents.reasoningEffort,
        modelPreset: schema.agents.modelPreset,
        modelId: schema.agents.modelId,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.id, agentPresetId),
          eq(schema.agents.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select({
        slug: schema.modelPresets.slug,
        provider: schema.modelPresets.provider,
        modelId: schema.modelPresets.modelId,
      })
      .from(schema.modelPresets)
      .where(eq(schema.modelPresets.organizationId, organizationId)),
    db
      .select({
        provider: schema.modelAllowlist.provider,
        modelId: schema.modelAllowlist.modelId,
        enabled: schema.modelAllowlist.enabled,
      })
      .from(schema.modelAllowlist)
      .where(eq(schema.modelAllowlist.organizationId, organizationId)),
  ]);

  return {
    agentPreset: agentRows[0] ?? null,
    modelPresets: presetRows,
    allowlist: allowRows,
  };
}
