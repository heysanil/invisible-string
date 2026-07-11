/**
 * Model resolution for an AgentDefinition's MODEL config (spec §7; runs FIRST
 * in the agent publish path, before any compile work, so typed errors surface
 * to the API).
 *
 * Resolution order (spec §7):
 *   1. `definition.model.modelId` override    — wins outright
 *   2. `definition.model.preset` slug         — workspace model_presets
 *      mapping (slug → provider + modelId)
 *   3. model_allowlist check (enabled)        — ALWAYS, on the final model
 *
 * Reasoning effort lives on the definition itself (`model.reasoning`) and is
 * compiled directly — it is not part of resolution.
 *
 * Pure core (`resolveModel`) over pre-loaded rows so it unit-tests without a
 * database; `loadModelResolutionData` is the drizzle loader.
 */
import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { AgentModel, ModelPresetSlug } from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "./errors";

export type ModelProvider = "anthropic" | "openrouter";

export interface ResolvedModel {
  provider: ModelProvider;
  modelId: string;
  /** The preset slug the model came through (absent for modelId overrides). */
  presetSlug?: ModelPresetSlug;
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
  /** All workspace model presets. */
  modelPresets: ModelPresetRow[];
  /** All workspace allowlist rows. */
  allowlist: AllowlistRow[];
}

/** Pure resolution — throws typed RuntimeApiErrors (422s). */
export function resolveModel(
  model: AgentModel,
  data: ModelResolutionData,
): ResolvedModel {
  const findAllowed = (modelId: string, provider?: ModelProvider) =>
    data.allowlist.find(
      (row) =>
        row.modelId === modelId &&
        row.enabled &&
        (provider === undefined || row.provider === provider),
    );

  // 1. Specific-model override wins outright; provider from the allowlist row.
  if (model.modelId !== undefined) {
    const allowed = findAllowed(model.modelId);
    if (!allowed) throw errors.modelNotAllowlisted(model.modelId);
    return { provider: allowed.provider, modelId: model.modelId };
  }

  // 2. Preset slug → workspace mapping.
  const mapping = data.modelPresets.find((row) => row.slug === model.preset);
  if (!mapping) throw errors.modelPresetNotFound(model.preset);

  // 3. Allowlist check on the resolved model.
  if (!findAllowed(mapping.modelId, mapping.provider)) {
    throw errors.modelNotAllowlisted(mapping.modelId);
  }

  return {
    provider: mapping.provider,
    modelId: mapping.modelId,
    presetSlug: model.preset,
  };
}

/** Load the rows {@link resolveModel} needs for one workspace. */
export async function loadModelResolutionData(
  db: Db,
  organizationId: string,
): Promise<ModelResolutionData> {
  const [presetRows, allowRows] = await Promise.all([
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
    modelPresets: presetRows,
    allowlist: allowRows,
  };
}
