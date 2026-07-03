/**
 * Workspace inventory the copilot reasons over: MCP connections, skills,
 * agent presets, model presets and the model allowlist visible to the socket
 * user in the socket workspace. Loaded FRESH per turn — the copilot must not
 * propose ids that no longer exist.
 */
import { and, eq, or } from "drizzle-orm";
import { schema } from "@invisible-string/db";

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

export interface InventoryAgentPreset {
  id: string;
  name: string;
  description: string | null;
  reasoningEffort: string;
  modelPreset: string | null;
  modelId: string | null;
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
  agentPresets: InventoryAgentPreset[];
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
        .select()
        .from(schema.agents)
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
      agentPresets: agents.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        reasoningEffort: row.reasoningEffort,
        modelPreset: row.modelPreset,
        modelId: row.modelId,
      })),
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
