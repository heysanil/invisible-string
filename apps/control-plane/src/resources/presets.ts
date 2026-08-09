/**
 * Model layer CRUD (workspace-scoped):
 * - model presets: three fixed slugs, re-pointed via PUT (allowlist-checked).
 *   A preset carries its own reasoning EFFORT — agents inherit it.
 * - model allowlist: add / toggle / remove; a model referenced by a preset (or
 *   an agent draft's specific-model override) cannot be removed.
 * - model capabilities: the allowlist joined with the OpenRouter catalog.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  addModelAllowlistEntryRequestSchema,
  updateModelAllowlistEntryRequestSchema,
  updateModelPresetRequestSchema,
  type DeleteResourceResponse,
  type GetModelAllowlistEntryResponse,
  type GetModelPresetResponse,
  type ListModelAllowlistResponse,
  type ListModelCapabilitiesResponse,
  type ListModelPresetsResponse,
  type ModelCapabilityDto,
  type ModelProvider,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "../runtime/errors";
import { catalogHasModel, catalogModelInfo } from "./openrouter-catalog";
import {
  modelAllowlistEntryDto,
  modelPresetDto,
  parseBody,
  type ResourceDeps,
} from "./common";

// ── allowlist helpers ─────────────────────────────────────────────────────────

async function isAllowlisted(
  db: Db,
  organizationId: string,
  provider: ModelProvider | undefined,
  modelId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.modelAllowlist.id })
    .from(schema.modelAllowlist)
    .where(
      and(
        eq(schema.modelAllowlist.organizationId, organizationId),
        eq(schema.modelAllowlist.modelId, modelId),
        eq(schema.modelAllowlist.enabled, true),
        ...(provider ? [eq(schema.modelAllowlist.provider, provider)] : []),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── model presets ─────────────────────────────────────────────────────────────

export async function listModelPresets(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListModelPresetsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.modelPresets)
    .where(eq(schema.modelPresets.organizationId, organizationId))
    .orderBy(schema.modelPresets.slug);
  return { presets: rows.map(modelPresetDto) };
}

export async function updateModelPreset(
  deps: ResourceDeps,
  organizationId: string,
  slug: string,
  body: unknown,
): Promise<GetModelPresetResponse> {
  const parsedSlug = schema.modelPresetSlug.enumValues.find((s) => s === slug);
  if (!parsedSlug) throw errors.notFound("model_preset");
  const input = parseBody(updateModelPresetRequestSchema, body);
  if (!(await isAllowlisted(deps.db, organizationId, input.provider, input.modelId))) {
    throw errors.modelNotAllowlisted(input.modelId);
  }
  // `reasoning` is OPTIONAL on the wire (a pre-effort web bundle mid-deploy
  // must not 400): absent means KEEP the stored effort, so it is omitted from
  // both the insert values and the conflict SET rather than written as a
  // default — the column default only applies to a genuinely new row.
  const rows = await deps.db
    .insert(schema.modelPresets)
    .values({
      organizationId,
      slug: parsedSlug,
      provider: input.provider,
      modelId: input.modelId,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    })
    .onConflictDoUpdate({
      target: [schema.modelPresets.organizationId, schema.modelPresets.slug],
      set: {
        provider: input.provider,
        modelId: input.modelId,
        ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      },
    })
    .returning();
  return { preset: modelPresetDto(rows[0]!) };
}

// ── model capabilities ────────────────────────────────────────────────────────

/**
 * Every ENABLED allowlist entry, joined with what the OpenRouter catalog says
 * about it — the source for the reasoning-effort selectors.
 *
 * The entry list is ALWAYS complete: a model the workspace allowlisted stays
 * selectable whether or not the catalog can be reached, so an openrouter.ai
 * outage can never empty the model picker. Only the CAPABILITIES degrade —
 * `supportedEfforts: null` means UNKNOWN (no catalog entry, an unreachable
 * catalog, or a non-OpenRouter provider, since Anthropic publishes no such
 * list), and clients must then offer the full effort vocabulary. Whether the
 * catalog answered at all is reported separately so the UI can say so.
 */
export async function getModelCapabilities(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListModelCapabilitiesResponse> {
  const rows = await deps.db
    .select({
      provider: schema.modelAllowlist.provider,
      modelId: schema.modelAllowlist.modelId,
    })
    .from(schema.modelAllowlist)
    .where(
      and(
        eq(schema.modelAllowlist.organizationId, organizationId),
        eq(schema.modelAllowlist.enabled, true),
      ),
    )
    .orderBy(schema.modelAllowlist.provider, schema.modelAllowlist.modelId);

  const catalog = deps.openRouterCatalog ? await deps.openRouterCatalog() : null;

  const models: ModelCapabilityDto[] = rows.map((row) => {
    const info =
      catalog !== null && row.provider === "openrouter"
        ? catalogModelInfo(catalog, row.modelId)
        : undefined;
    return {
      provider: row.provider,
      modelId: row.modelId,
      supportedEfforts: info ? [...info.supportedEfforts] : null,
      ...(info?.defaultEffort !== undefined
        ? { defaultEffort: info.defaultEffort }
        : {}),
      ...(info?.contextWindowTokens !== undefined
        ? { contextWindowTokens: info.contextWindowTokens }
        : {}),
    };
  });

  return { models, catalogAvailable: catalog !== null };
}

// ── model allowlist ───────────────────────────────────────────────────────────

export async function listModelAllowlist(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListModelAllowlistResponse> {
  const rows = await deps.db
    .select()
    .from(schema.modelAllowlist)
    .where(eq(schema.modelAllowlist.organizationId, organizationId))
    .orderBy(schema.modelAllowlist.provider, schema.modelAllowlist.modelId);
  return { entries: rows.map(modelAllowlistEntryDto) };
}

export async function addModelAllowlistEntry(
  deps: ResourceDeps,
  organizationId: string,
  body: unknown,
): Promise<GetModelAllowlistEntryResponse> {
  const input = parseBody(addModelAllowlistEntryRequestSchema, body);
  // Advisory OpenRouter-catalog check (keyed-acceptance papercut: an
  // OpenRouter-invalid id used to surface only at RUN time as a provider
  // error). Fail-OPEN: `null` means the catalog was unreachable — allowlist
  // the id unchecked rather than couple workspace config to openrouter.ai
  // availability. The id's SHAPE was already schema-validated.
  if (input.provider === "openrouter" && deps.openRouterCatalog) {
    const catalog = await deps.openRouterCatalog();
    if (catalog !== null && !catalogHasModel(catalog, input.modelId)) {
      throw errors.modelUnknownToOpenRouter(input.modelId);
    }
  }
  const rows = await deps.db
    .insert(schema.modelAllowlist)
    .values({
      organizationId,
      provider: input.provider,
      modelId: input.modelId,
      enabled: input.enabled,
    })
    .onConflictDoNothing({
      target: [
        schema.modelAllowlist.organizationId,
        schema.modelAllowlist.provider,
        schema.modelAllowlist.modelId,
      ],
    })
    .returning();
  if (rows.length === 0) throw errors.modelAllowlistDuplicate();
  return { entry: modelAllowlistEntryDto(rows[0]!) };
}

export async function updateModelAllowlistEntry(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
  body: unknown,
): Promise<GetModelAllowlistEntryResponse> {
  const input = parseBody(updateModelAllowlistEntryRequestSchema, body);
  const rows = await deps.db
    .update(schema.modelAllowlist)
    .set({ enabled: input.enabled })
    .where(
      and(
        eq(schema.modelAllowlist.id, id),
        eq(schema.modelAllowlist.organizationId, organizationId),
      ),
    )
    .returning();
  if (rows.length === 0) throw errors.notFound("model_allowlist_entry");
  return { entry: modelAllowlistEntryDto(rows[0]!) };
}

/**
 * Preset slugs / agent names that would break if this model were removed.
 * Agents override models inside their draft AgentDefinition
 * (`draft.model.modelId`) — the jsonb path query mirrors that shape.
 */
export async function modelReferences(
  db: Db,
  organizationId: string,
  provider: ModelProvider,
  modelId: string,
): Promise<string[]> {
  const [presets, agents] = await Promise.all([
    db
      .select({ slug: schema.modelPresets.slug })
      .from(schema.modelPresets)
      .where(
        and(
          eq(schema.modelPresets.organizationId, organizationId),
          eq(schema.modelPresets.provider, provider),
          eq(schema.modelPresets.modelId, modelId),
        ),
      ),
    db
      .select({ name: schema.agents.name })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.organizationId, organizationId),
          sql`${schema.agents.draft} -> 'model' ->> 'modelId' = ${modelId}`,
        ),
      ),
  ]);
  return [...presets.map((p) => p.slug), ...agents.map((a) => a.name)];
}

export async function deleteModelAllowlistEntry(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<DeleteResourceResponse> {
  const rows = await deps.db
    .select()
    .from(schema.modelAllowlist)
    .where(
      and(
        eq(schema.modelAllowlist.id, id),
        eq(schema.modelAllowlist.organizationId, organizationId),
      ),
    )
    .limit(1);
  const entry = rows[0];
  if (!entry) throw errors.notFound("model_allowlist_entry");
  const refs = await modelReferences(
    deps.db,
    organizationId,
    entry.provider,
    entry.modelId,
  );
  if (refs.length > 0) throw errors.modelReferencedByPreset(refs);
  await deps.db
    .delete(schema.modelAllowlist)
    .where(eq(schema.modelAllowlist.id, id));
  return { id, deleted: true };
}
