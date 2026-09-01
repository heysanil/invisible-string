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
  ConnectionDto,
  ConnectionOauthStatus,
  ConnectorCatalogEntry,
  Logger,
  MasterKey,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  SkillDto,
} from "@invisible-string/shared";

import type { ArtifactStore } from "../artifacts";
import type { Auth } from "../auth";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { Db } from "../db";
import type { OauthBrokerDeps } from "../oauth/broker";
import { errors } from "../runtime/errors";
import type { MeiliClient } from "../search/meili";
import type { WorkspaceDeps } from "../workspace";
import type { OpenRouterCatalog } from "./openrouter-catalog";
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
   * Meilisearch client backing `GET /mcp-registry/search` (the registry
   * mirror). Null = community search degraded to a typed 503 — the catalog
   * and custom-URL lanes never depend on it (connectors spec §5).
   */
  meili: MeiliClient | null;
  /**
   * OpenRouter model-catalog lookup: allowlist-add validation AND the model
   * capabilities (supported reasoning efforts, context window) the effort
   * selectors read (advisory, fail-open — see resources/openrouter-catalog.ts).
   * Optional: tests and offline deployments skip the existence check entirely
   * and report every model's capabilities as unknown.
   */
  openRouterCatalog?: OpenRouterCatalog;
  /**
   * Guarded egress fetch for MCP probes (net/guarded-fetch.ts): the ONLY path
   * a caller-influenced URL may leave the control plane on — DNS-validated,
   * IP-pinned, redirect-re-validated. Constructed ONCE in index.ts from the
   * runtime config's `mcpProbeAllowPrivate` (MCP_PROBE_ALLOW_PRIVATE).
   */
  probeFetch: typeof fetch;
  /**
   * OAuth consent broker dependencies (oauth/broker.ts) — the
   * `/connections/:id/oauth/start` routes run on them. Shares the guarded
   * egress fetch with the probe (one egress policy for all
   * caller-influenced URLs).
   */
  oauthBroker: OauthBrokerDeps;
  /**
   * Test seam: overrides the checked-in connector catalog
   * (resources/catalog.ts) so gated suites can install synthetic recipes —
   * production always uses the module-load-validated JSON.
   */
  catalog?: ReadonlyMap<string, ConnectorCatalogEntry>;
  /**
   * Structured logger for fire-and-forget resource work (the after-create
   * connection probe) — request-path failures surface as typed errors instead.
   */
  logger: Logger;
}

/** Resource owner: an organization (workspace scope) or a user (user scope). */
export type Scope =
  | { kind: "workspace"; organizationId: string }
  | { kind: "user"; userId: string };

/** drizzle WHERE for a scoped table (connections / skills share columns). */
export function scopeWhere(
  table: typeof schema.connections | typeof schema.skills,
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

type ConnectionRow = typeof schema.connections.$inferSelect;
type SkillRow = typeof schema.skills.$inferSelect;
type ModelPresetRow = typeof schema.modelPresets.$inferSelect;
type ModelAllowlistRow = typeof schema.modelAllowlist.$inferSelect;

/**
 * Rebuilt `connections` row → wire DTO. Secrets are NEVER echoed — only
 * `hasCredentials`, which answers "can this connection actually present a
 * credential right now?": a stored auth envelope for static auth, and for an
 * oauth row a grant that has reached `connected`. It used to be hardcoded
 * true for every oauth row, which is what dressed "I hold no token" up as
 * "your token was rejected" and pointed every debugger at the server
 * (2026-08-31 fix plan F10) — a `pending` grant is NOT credentialed.
 *
 * `oauthStatus` is caller-supplied: create passes the newborn grant's
 * `pending`; every reader of an oauth row loads its `connection_oauth`
 * status (resources/connections.ts `oauthStatusOf`) — a null here means
 * "not an oauth connection", never "status unknown".
 */
export function connectionDto(
  row: ConnectionRow,
  oauthStatus: ConnectionOauthStatus | null = null,
): ConnectionDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    description: row.description,
    source: row.source,
    catalogSlug: row.catalogSlug,
    registryName: row.registryName,
    url: row.url,
    transport: row.transport,
    authType: row.authType,
    hasCredentials:
      row.authType === "oauth"
        ? oauthStatus === "connected"
        : row.authConfigEncrypted != null,
    oauthStatus,
    toolAllow: row.toolAllow ?? null,
    toolBlock: row.toolBlock ?? null,
    approvalPolicy: (row.approvalPolicy as ConnectionDto["approvalPolicy"]) ?? null,
    enabled: row.enabled,
    health: row.health,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    tools: row.toolsCache ?? null,
    toolsCachedAt: row.toolsCachedAt?.toISOString() ?? null,
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
    reasoning: row.reasoning,
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
