/**
 * Workspace model-preset resolution — extracted from the session titler
 * (resources/session-title.ts) when pipeline `infer` steps became the second
 * caller. One resolver, one shape, so nothing can drift on what a preset IS:
 * provider, model id AND reasoning effort, because the effort is part of the
 * preset's identity — the seeded `quick` and `balanced` rows are THE SAME
 * MODEL ID and differ only there (packages/db/src/seed.ts says so), which is
 * also why a preset can never be identified by its model id (AGENTS.md).
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  modelPresetSlugSchema,
  type ModelProvider,
  type ReasoningEffort,
} from "@invisible-string/shared";

import type { Db } from "../db";

/** A preset resolved to the triple a model call is actually made with. */
export interface PresetModelRef {
  provider: ModelProvider;
  modelId: string;
  reasoning: ReasoningEffort;
}

/**
 * The workspace's preset `slug` as a model reference, or null when the
 * workspace has no such row — callers decide what "no preset" means (the
 * titler silently skips; an `infer` step fails `model_preset_not_found`).
 *
 * `slug` is accepted as a plain string (an `infer` step's `preset` field is
 * draft-lenient) and validated against the preset-slug vocabulary FIRST: the
 * column is a pgEnum, so comparing an unknown value would raise a Postgres
 * enum error instead of resolving to "not found".
 */
export async function resolvePresetModel(
  db: Db,
  organizationId: string,
  slug: string,
): Promise<PresetModelRef | null> {
  const parsedSlug = modelPresetSlugSchema.safeParse(slug);
  if (!parsedSlug.success) return null;
  const rows = await db
    .select({
      provider: schema.modelPresets.provider,
      modelId: schema.modelPresets.modelId,
      reasoning: schema.modelPresets.reasoning,
    })
    .from(schema.modelPresets)
    .where(
      and(
        eq(schema.modelPresets.organizationId, organizationId),
        eq(schema.modelPresets.slug, parsedSlug.data),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row
    ? {
        provider: row.provider,
        modelId: row.modelId,
        reasoning: row.reasoning,
      }
    : null;
}
