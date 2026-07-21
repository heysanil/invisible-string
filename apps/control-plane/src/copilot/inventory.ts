/**
 * Workspace inventory the copilot reasons over: MCP connections, skills,
 * agents (with their PUBLISHED context slugs), model presets and the model
 * allowlist visible to the socket user in the socket workspace. Loaded FRESH
 * per turn — the copilot must not propose ids that no longer exist.
 *
 * Agents carry the context slugs of their published version's definition
 * (not their mutable draft): workflow instructions render at dispatch against
 * the agent's PUBLISHED context, so that is what workflow-surface @reference
 * validation must check (validate.ts).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import { agentDefinitionSchema } from "@invisible-string/shared";

import type { Db } from "../db";
import { slugifyName } from "../build/compiler-adapter";

export interface InventoryConnection {
  id: string;
  name: string;
  /** `@<slug>` reference name (slugified connection name). */
  slug: string;
  description: string | null;
  enabled: boolean;
}

export interface InventorySkill {
  id: string;
  name: string;
  /** `@skill.<slug>` reference slug (slugified skill name). */
  slug: string;
  description: string | null;
}

export interface InventoryAgent {
  id: string;
  name: string;
  description: string | null;
  /** True when the agent has a published version (setAgent requires it). */
  published: boolean;
  /**
   * `@<slug>` connection refs available to workflow instructions when this
   * agent is selected — from the PUBLISHED version's context (empty when
   * unpublished).
   */
  contextConnectionSlugs: string[];
  /** `@skill.<slug>` refs from the published version's context. */
  contextSkillSlugs: string[];
}

export interface InventoryModelPreset {
  slug: string;
  provider: string;
  modelId: string;
}

export interface InventoryAllowlistEntry {
  provider: string;
  modelId: string;
  enabled: boolean;
}

export interface WorkspaceInventory {
  connections: InventoryConnection[];
  skills: InventorySkill[];
  agents: InventoryAgent[];
  modelPresets: InventoryModelPreset[];
  allowlist: InventoryAllowlistEntry[];
}

export type LoadInventoryFn = (
  organizationId: string,
  userId: string,
) => Promise<WorkspaceInventory>;

/** Workspace-scoped rows plus the caller's user-scoped rows (spec §11). */
export function createInventoryLoader(db: Db): LoadInventoryFn {
  return async (organizationId, userId) => {
    const scopeFilter = <
      T extends {
        scope: unknown;
        organizationId: unknown;
        userId: unknown;
      },
    >(
      table: T,
    ) =>
      or(
        and(
          eq(table.scope as never, "workspace"),
          eq(table.organizationId as never, organizationId),
        ),
        and(eq(table.scope as never, "user"), eq(table.userId as never, userId)),
      );

    const [connections, skills, agents, presets, allowlist] = await Promise.all([
      db
        .select()
        .from(schema.mcpConnections)
        .where(scopeFilter(schema.mcpConnections)),
      db.select().from(schema.skills).where(scopeFilter(schema.skills)),
      db
        .select({
          id: schema.agents.id,
          name: schema.agents.name,
          description: schema.agents.description,
          publishedVersionId: schema.agents.publishedVersionId,
          publishedDefinition: schema.agentVersions.definition,
        })
        .from(schema.agents)
        .leftJoin(
          schema.agentVersions,
          eq(schema.agents.publishedVersionId, schema.agentVersions.id),
        )
        .where(eq(schema.agents.organizationId, organizationId)),
      db
        .select()
        .from(schema.modelPresets)
        .where(eq(schema.modelPresets.organizationId, organizationId)),
      db
        .select()
        .from(schema.modelAllowlist)
        .where(eq(schema.modelAllowlist.organizationId, organizationId)),
    ]);

    // Published-context ids → slugs. Published definitions may reference rows
    // the SOCKET user cannot see (user-scoped resources of the agent's run-as
    // user), so resolve any id missing from the scoped lists by direct lookup
    // — exposing only the slug of context the agent already binds.
    const connectionSlugById = new Map(
      connections.map((row) => [row.id, slugifyName(row.name)]),
    );
    const skillSlugById = new Map(
      skills.map((row) => [row.id, slugifyName(row.name)]),
    );
    const publishedContexts = new Map<
      string,
      { connectionIds: string[]; skillIds: string[] }
    >();
    const missingConnectionIds = new Set<string>();
    const missingSkillIds = new Set<string>();
    for (const agent of agents) {
      if (agent.publishedDefinition === null) continue;
      const parsed = agentDefinitionSchema.safeParse(agent.publishedDefinition);
      if (!parsed.success) continue; // corrupt snapshot — treat as no context
      const { mcpConnectionIds, skillIds } = parsed.data.context;
      publishedContexts.set(agent.id, {
        connectionIds: mcpConnectionIds,
        skillIds,
      });
      for (const id of mcpConnectionIds) {
        if (!connectionSlugById.has(id)) missingConnectionIds.add(id);
      }
      for (const id of skillIds) {
        if (!skillSlugById.has(id)) missingSkillIds.add(id);
      }
    }
    const [extraConnections, extraSkills] = await Promise.all([
      missingConnectionIds.size > 0
        ? db
            .select({ id: schema.mcpConnections.id, name: schema.mcpConnections.name })
            .from(schema.mcpConnections)
            .where(inArray(schema.mcpConnections.id, [...missingConnectionIds]))
        : Promise.resolve([]),
      missingSkillIds.size > 0
        ? db
            .select({ id: schema.skills.id, name: schema.skills.name })
            .from(schema.skills)
            .where(inArray(schema.skills.id, [...missingSkillIds]))
        : Promise.resolve([]),
    ]);
    for (const row of extraConnections) {
      connectionSlugById.set(row.id, slugifyName(row.name));
    }
    for (const row of extraSkills) skillSlugById.set(row.id, slugifyName(row.name));

    const slugsFor = (
      ids: string[] | undefined,
      slugById: Map<string, string>,
    ): string[] =>
      (ids ?? []).flatMap((id) => {
        const slug = slugById.get(id);
        return slug === undefined ? [] : [slug];
      });

    return {
      connections: connections.map((row) => ({
        id: row.id,
        name: row.name,
        slug: slugifyName(row.name),
        description: row.description,
        enabled: row.enabled,
      })),
      skills: skills.map((row) => ({
        id: row.id,
        name: row.name,
        slug: slugifyName(row.name),
        description: row.description,
      })),
      agents: agents.map((row) => {
        const context = publishedContexts.get(row.id);
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          published: row.publishedVersionId !== null,
          contextConnectionSlugs: slugsFor(
            context?.connectionIds,
            connectionSlugById,
          ),
          contextSkillSlugs: slugsFor(context?.skillIds, skillSlugById),
        };
      }),
      modelPresets: presets.map((row) => ({
        slug: row.slug,
        provider: row.provider,
        modelId: row.modelId,
      })),
      allowlist: allowlist.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        enabled: row.enabled,
      })),
    };
  };
}
