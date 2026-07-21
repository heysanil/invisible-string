/**
 * Shared helpers for the Phase-2 resource CRUD plugin: request-body parsing,
 * scope resolution (workspace vs user), and DTO row→wire mappers.
 *
 * Two scopes exist for MCP connections and skills (spec §9): workspace-level
 * (`/workspaces/:workspaceId/...`, owner = organization) and user-level
 * (`/me/...`, owner = the signed-in user). A single `Scope` value carries the
 * owner so handlers stay scope-agnostic.
 */
import { and, eq, type SQL } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  MasterKey,
  McpConnectionDto,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  SkillDto,
} from "@invisible-string/shared";

import type { ArtifactStore } from "../artifacts";
import type { Auth } from "../auth";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { Db } from "../db";
import { errors } from "../runtime/errors";
import type { WorkspaceDeps } from "../workspace";
import type { OpenRouterModelIds } from "./openrouter-catalog";
import type { RegistryClient } from "./registry";

/** Everything the Phase-2 resource CRUD routes need. */
export interface ResourceDeps {
  db: Db;
  workspaceDeps: WorkspaceDeps;
  auth: Auth;
  masterKey: MasterKey | undefined;
  compile: CompileAgentFn;
  /** Object store for skill attachments (undefined when S3 is unconfigured). */
  artifacts: ArtifactStore | undefined;
  registry: RegistryClient;
  /**
   * OpenRouter model-catalog lookup for allowlist-add validation (advisory,
   * fail-open — see resources/openrouter-catalog.ts). Optional: tests and
   * offline deployments skip the existence check entirely.
   */
  openRouterModelIds?: OpenRouterModelIds;
}

/** Resource owner: an organization (workspace scope) or a user (user scope). */
export type Scope =
  | { kind: "workspace"; organizationId: string }
  | { kind: "user"; userId: string };

/** drizzle WHERE for a scoped table (mcp_connections / skills share columns). */
export function scopeWhere(
  table: typeof schema.mcpConnections | typeof schema.skills,
  scope: Scope,
): SQL {
  return scope.kind === "workspace"
    ? (and(
        eq(table.scope, "workspace"),
        eq(table.organizationId, scope.organizationId),
      ) as SQL)
    : (and(eq(table.scope, "user"), eq(table.userId, scope.userId)) as SQL);
}

/** Column values that stamp a new scoped row with its owner. */
export function scopeInsertValues(scope: Scope): {
  scope: "workspace" | "user";
  organizationId: string | null;
  userId: string | null;
} {
  return scope.kind === "workspace"
    ? { scope: "workspace", organizationId: scope.organizationId, userId: null }
    : { scope: "user", organizationId: null, userId: scope.userId };
}

/** Parse a request body with a zod schema or throw a typed 422. */
export function parseBody<T>(
  schemaLike: {
    safeParse(v: unknown): {
      success: boolean;
      data?: T;
      error?: { issues: unknown };
    };
  },
  body: unknown,
): T {
  const result = schemaLike.safeParse(body);
  if (!result.success || result.data === undefined) {
    throw errors.invalidBody(result.error?.issues);
  }
  return result.data;
}

// ── DTO mappers ──────────────────────────────────────────────────────────────

type McpConnectionRow = typeof schema.mcpConnections.$inferSelect;
type SkillRow = typeof schema.skills.$inferSelect;
type ModelPresetRow = typeof schema.modelPresets.$inferSelect;
type ModelAllowlistRow = typeof schema.modelAllowlist.$inferSelect;

/** Secrets are NEVER echoed — only `hasCredentials`. */
export function mcpConnectionDto(row: McpConnectionRow): McpConnectionDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    description: row.description,
    source: row.source,
    registryId: row.registryId,
    url: row.url,
    toolAllow: row.toolAllow ?? null,
    toolBlock: row.toolBlock ?? null,
    approvalPolicy:
      (row.approvalPolicy as McpConnectionDto["approvalPolicy"]) ?? null,
    enabled: row.enabled,
    hasCredentials: row.authConfigEncrypted != null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function skillDto(row: SkillRow): SkillDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    description: row.description,
    content: row.content,
    files: row.files ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Workflow DTO mappers live in resources/workflows.ts (the summary needs an
// agent-name join, so it is no longer a pure row mapper).

export function modelPresetDto(row: ModelPresetRow): ModelPresetDto {
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function modelAllowlistEntryDto(
  row: ModelAllowlistRow,
): ModelAllowlistEntryDto {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.modelId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Agent DTO mappers live in resources/agents.ts (the summary needs a
// published-version join, so it is no longer a pure row mapper).
