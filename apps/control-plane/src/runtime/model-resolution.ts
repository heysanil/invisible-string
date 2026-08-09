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
 * Reasoning effort resolves HERE too, because it is INHERITABLE:
 * `definition.model.reasoning` is an optional override, and what it falls back
 * to depends on which branch above won —
 *   - preset branch:   the preset row's own `reasoning`;
 *   - override branch: `provider-default` (emit no reasoning field at all).
 * The override branch deliberately does NOT read the preset: inheriting
 * `balanced`'s `max` onto a deliberately-chosen cheap model is the wrong
 * semantic, and looking the preset up there would invent a new
 * `model_preset_not_found` failure for override drafts that publish fine today.
 *
 * Pure core (`resolveModel`) over pre-loaded rows so it unit-tests without a
 * database; `loadModelResolutionData` is the drizzle loader.
 */
import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  AgentModel,
  ModelPresetSlug,
  ReasoningEffort,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "./errors";

export type ModelProvider = "anthropic" | "openrouter";

export interface ResolvedModel {
  provider: ModelProvider;
  modelId: string;
  /**
   * The effort the artifact is compiled with — always concrete (inheritance
   * is settled here). It rides into the compiler's own ResolvedModel, so it
   * re-keys the content hash: two identical definitions inheriting different
   * preset efforts must never share an artifact.
   */
  reasoning: ReasoningEffort;
  /** The preset slug the model came through (absent for modelId overrides). */
  presetSlug?: ModelPresetSlug;
}

export interface ModelPresetRow {
  slug: ModelPresetSlug;
  provider: ModelProvider;
  modelId: string;
  /** The preset's default effort, inherited when the agent sets none. */
  reasoning: ReasoningEffort;
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
  //    Returns BEFORE the preset lookup, so an unset effort falls to
  //    `provider-default` (the model's own behavior) rather than borrowing an
  //    effort chosen for a different model.
  if (model.modelId !== undefined) {
    const allowed = findAllowed(model.modelId);
    if (!allowed) throw errors.modelNotAllowlisted(model.modelId);
    return {
      provider: allowed.provider,
      modelId: model.modelId,
      reasoning: model.reasoning ?? "provider-default",
    };
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
    // The agent's own effort wins; otherwise the preset's is INHERITED.
    reasoning: model.reasoning ?? mapping.reasoning,
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
        reasoning: schema.modelPresets.reasoning,
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
