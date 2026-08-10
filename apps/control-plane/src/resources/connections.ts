/**
 * Connections CRUD on the rebuilt domain (connectors redesign spec §3/§4) —
 * the `connections` table, both scopes, one create route discriminated on
 * `source` (catalog | registry | custom; the old separate /install route is
 * gone). Secrets are encrypted at rest (AAD-bound to the new table+row) and
 * NEVER echoed — read DTOs carry `hasCredentials` only. A connection cannot
 * be deleted while any agent draft or published agent version references it
 * (409, with the referencing agent names).
 *
 * Name discipline: sibling names in a scope must differ AND must slugify
 * distinctly (`slugifyName` — the exact function the compile path uses for
 * connection filenames/env vars), so a publish can never fail on a slug
 * collision the create quietly allowed.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createConnectionRequestSchema,
  newId,
  updateConnectionRequestSchema,
  type ConnectorCatalogEntry,
  type CreateConnectionResponse,
  type DeleteResourceResponse,
  type GetConnectionResponse,
  type ListConnectionsResponse,
  type McpApprovalPolicy,
  type McpAuthWrite,
} from "@invisible-string/shared";

import { slugifyName } from "../build/compiler-adapter";
import type { Db } from "../db";
import { revokeBestEffort } from "../oauth/tokens";
import { probeAndPersist } from "../probe/service";
import { errors, isRuntimeApiError } from "../runtime/errors";
import { loadConnectorCatalog } from "./catalog";
import {
  connectionDto,
  parseBody,
  scopeInsertValues,
  scopeWhere,
  type ResourceDeps,
  type Scope,
} from "./common";
import { encryptConnectionAuthConfig } from "./mcp-crypto";

type Row = typeof schema.connections.$inferSelect;
type OauthGrantRow = typeof schema.connectionOauth.$inferSelect;

async function loadOauthGrant(
  db: Db,
  connectionId: string,
): Promise<OauthGrantRow | undefined> {
  const rows = await db
    .select()
    .from(schema.connectionOauth)
    .where(eq(schema.connectionOauth.connectionId, connectionId))
    .limit(1);
  return rows[0];
}

async function loadOwned(db: Db, scope: Scope, id: string): Promise<Row> {
  const rows = await db
    .select()
    .from(schema.connections)
    .where(and(eq(schema.connections.id, id), scopeWhere(schema.connections, scope)))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("connection");
  return row;
}

/** Persisted auth_type for a validated auth WRITE. */
function authTypeOf(
  auth: McpAuthWrite | undefined,
): "none" | "bearer" | "headers" | "oauth" {
  if (!auth) return "none";
  return auth.type;
}

/**
 * Validate a caller's auth WRITE against a catalog entry's recipe (spec §4):
 * - recipe `none`    → any supplied credentials are a 422 (the entry takes none);
 * - recipe `oauth`   → no static credentials allowed — the grant arrives via
 *                      the consent broker after install (spec §6);
 * - recipe `bearer`  → a non-empty bearer token is required;
 * - recipe `headers` → every SECRET header the recipe declares is required.
 */
function requireRecipeAuth(
  entry: ConnectorCatalogEntry,
  auth: McpAuthWrite | undefined,
): McpAuthWrite {
  const recipe = entry.auth;
  if (recipe.type === "none") {
    if (auth !== undefined && auth.type !== "none") {
      throw errors.invalidBody([
        { path: "auth", message: `catalog entry "${entry.slug}" takes no credentials` },
      ]);
    }
    return { type: "none" };
  }
  if (recipe.type === "oauth") {
    if (auth !== undefined && auth.type !== "oauth") {
      throw errors.invalidBody([
        {
          path: "auth",
          message: `catalog entry "${entry.slug}" uses OAuth — connect it after install instead of supplying credentials`,
        },
      ]);
    }
    return { type: "oauth" };
  }
  if (recipe.type === "bearer") {
    if (auth?.type !== "bearer" || auth.values.token.trim().length === 0) {
      throw errors.invalidBody([
        {
          path: "auth",
          message: `catalog entry "${entry.slug}" requires a bearer token (${recipe.tokenLabel})`,
        },
      ]);
    }
    return auth;
  }
  if (auth?.type !== "headers") {
    throw errors.invalidBody([
      {
        path: "auth",
        message: `catalog entry "${entry.slug}" requires headers auth (${recipe.headers
          .map((header) => header.name)
          .join(", ")})`,
      },
    ]);
  }
  const missing = recipe.headers
    .filter((header) => header.isSecret && !(header.name in auth.values))
    .map((header) => header.name);
  if (missing.length > 0) {
    throw errors.invalidBody([
      {
        path: "auth",
        message: `catalog entry "${entry.slug}" requires header(s): ${missing.join(", ")}`,
      },
    ]);
  }
  return auth;
}

/**
 * 409 when a sibling connection in the same scope already uses this exact
 * name OR a name that slugifies identically (`excludeId` skips the row being
 * renamed). The compiler namespaces connections by slug, so a collision here
 * would otherwise surface much later as a failed publish.
 */
async function assertNameAndSlugFree(
  db: Db,
  scope: Scope,
  name: string,
  excludeId?: string,
): Promise<void> {
  const siblings = await db
    .select({ id: schema.connections.id, name: schema.connections.name })
    .from(schema.connections)
    .where(scopeWhere(schema.connections, scope));
  const slug = slugifyName(name);
  for (const sibling of siblings) {
    if (sibling.id === excludeId) continue;
    if (sibling.name === name) throw errors.duplicateConnectionName(name);
    if (slugifyName(sibling.name) === slug) {
      throw errors.duplicateConnectionSlug(name, sibling.name);
    }
  }
}

/**
 * Agent names (draft OR any published version definition) that reference
 * this connection id — the delete guard. The query is constrained to the
 * SAME scope as the connection, mirroring how compile-service resolves refs
 * (workspace connections resolve only against same-org agents; user
 * connections only against agents whose run-as user owns them). This keeps
 * the guard from ever reading or reporting agent names outside the owner's
 * scope. jsonb `@>` containment matches the id inside the
 * `context.mcpConnectionIds` array (id-shape-agnostic: uuid or `cn_`).
 */
export async function connectionReferences(
  db: Db,
  scope: Scope,
  connectionId: string,
): Promise<string[]> {
  const idJson = JSON.stringify(connectionId);
  const scopeCond =
    scope.kind === "workspace"
      ? sql`a.organization_id = ${scope.organizationId}`
      : sql`a.run_as_user_id = ${scope.userId}`;
  const result = await db.execute(sql`
    SELECT DISTINCT a.name AS name
    FROM ${schema.agents} a
    WHERE ${scopeCond}
      AND (a.draft -> 'context' -> 'mcpConnectionIds') @> ${idJson}::jsonb
    UNION
    SELECT DISTINCT a.name AS name
    FROM ${schema.agents} a
    JOIN ${schema.agentVersions} v ON v.agent_id = a.id
    WHERE ${scopeCond}
      AND (v.definition -> 'context' -> 'mcpConnectionIds') @> ${idJson}::jsonb
    ORDER BY name
  `);
  const rows = result as unknown as Array<{ name: unknown }>;
  return rows
    .map((r) => (typeof r.name === "string" ? r.name : null))
    .filter((n): n is string => n !== null);
}

export async function listConnections(
  deps: ResourceDeps,
  scope: Scope,
): Promise<ListConnectionsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.connections)
    .where(scopeWhere(schema.connections, scope))
    .orderBy(schema.connections.name);
  return { connections: rows.map((row) => connectionDto(row)) };
}

export async function getConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<GetConnectionResponse> {
  const row = await loadOwned(deps.db, scope, id);
  return { connection: connectionDto(row) };
}

export async function createConnection(
  deps: ResourceDeps,
  scope: Scope,
  body: unknown,
): Promise<CreateConnectionResponse> {
  const input = parseBody(createConnectionRequestSchema, body);
  // The auth envelope's AAD binds the row id, so the id exists BEFORE insert.
  const id = newId("cn");

  let values: typeof schema.connections.$inferInsert;
  if (input.source === "catalog") {
    const entry = (deps.catalog ?? loadConnectorCatalog()).get(input.slug);
    if (!entry) throw errors.catalogEntryNotFound(input.slug);
    const auth = requireRecipeAuth(entry, input.auth);
    values = {
      id,
      ...scopeInsertValues(scope),
      name: entry.title,
      description: entry.modelDescription,
      source: "catalog",
      catalogSlug: entry.slug,
      url: entry.url,
      transport: entry.transport,
      authType: authTypeOf(auth),
      authConfigEncrypted: encryptConnectionAuthConfig(auth, deps.masterKey, id),
      enabled: true,
    };
  } else if (input.source === "registry") {
    const server = await deps.registry.getServer(input.registryName, input.version);
    if (!server) throw errors.registryServerNotFound(input.registryName);
    if (server.remotes.length === 0) {
      throw errors.registryServerNotInstallable(input.registryName);
    }
    // The stored URL must be one the registry actually advertises — otherwise
    // a caller could claim registry provenance while pointing the connection
    // (and its runtime-injected credentials) at an arbitrary host.
    const remote = server.remotes.find((r) => r.url === input.remoteUrl);
    if (!remote) throw errors.registryRemoteMismatch(input.registryName);
    values = {
      id,
      ...scopeInsertValues(scope),
      name: input.name ?? server.title ?? server.name,
      description: input.description ?? (server.description || null),
      source: "registry",
      registryName: input.registryName,
      url: input.remoteUrl,
      transport: remote.type === "sse" ? "sse" : "streamable-http",
      authType: authTypeOf(input.auth),
      authConfigEncrypted: input.auth
        ? encryptConnectionAuthConfig(input.auth, deps.masterKey, id)
        : null,
      enabled: true,
    };
  } else {
    values = {
      id,
      ...scopeInsertValues(scope),
      name: input.name,
      description: input.description ?? null,
      source: "custom",
      url: input.url,
      transport: input.transport ?? "streamable-http",
      authType: authTypeOf(input.auth),
      authConfigEncrypted: input.auth
        ? encryptConnectionAuthConfig(input.auth, deps.masterKey, id)
        : null,
      enabled: true,
    };
  }

  await assertNameAndSlugFree(deps.db, scope, values.name);
  const rows = await deps.db.insert(schema.connections).values(values).returning();
  const row = rows[0]!;
  // OAuth connections pair 1:1 with a `connection_oauth` grant row, born
  // `pending` (spec §3/§6); the response carries the scope-correct start path
  // so the UI chains straight into the consent popup.
  let oauthStartPath: string | undefined;
  if (row.authType === "oauth") {
    await deps.db
      .insert(schema.connectionOauth)
      .values({ id: newId("co"), connectionId: row.id })
      .onConflictDoNothing({ target: schema.connectionOauth.connectionId });
    oauthStartPath =
      scope.kind === "workspace"
        ? `/workspaces/${scope.organizationId}/connections/${row.id}/oauth/start`
        : `/me/connections/${row.id}/oauth/start`;
  }
  // First health probe (spec §7): fire-and-forget — the create response NEVER
  // waits on or fails from it. The outcome lands on the row's probe columns;
  // an infrastructure failure only logs (no credential material in the error:
  // probeAndPersist scrubs classification text, and typed errors carry ids).
  void probeAndPersist(deps, row).catch((error) => {
    deps.logger.warn("connections.initial_probe_failed", {
      fields: { connectionId: row.id },
      err: error,
    });
  });
  return {
    connection: connectionDto(row, row.authType === "oauth" ? "pending" : null),
    ...(oauthStartPath !== undefined ? { oauthStartPath } : {}),
  };
}

export async function updateConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
  body: unknown,
): Promise<GetConnectionResponse> {
  const input = parseBody(updateConnectionRequestSchema, body);
  const existing = await loadOwned(deps.db, scope, id);

  // catalog/registry rows keep their recipe/registry-advertised endpoint —
  // only custom connections may re-point url/transport.
  if (existing.source !== "custom" && (input.url !== undefined || input.transport !== undefined)) {
    throw errors.invalidBody([
      {
        path: input.url !== undefined ? "url" : "transport",
        message: `a ${existing.source} connection's endpoint is fixed by its ${existing.source === "catalog" ? "catalog recipe" : "registry listing"}`,
      },
    ]);
  }

  // Resulting tool filter must not set both allow AND block.
  const nextAllow =
    input.toolAllow !== undefined ? input.toolAllow : existing.toolAllow;
  const nextBlock =
    input.toolBlock !== undefined ? input.toolBlock : existing.toolBlock;
  if (nextAllow && nextAllow.length > 0 && nextBlock && nextBlock.length > 0) {
    throw errors.toolFilterConflict();
  }

  if (input.name !== undefined && input.name !== existing.name) {
    await assertNameAndSlugFree(deps.db, scope, input.name, id);
  }

  const patch: Partial<typeof schema.connections.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.url !== undefined) patch.url = input.url;
  if (input.transport !== undefined) patch.transport = input.transport;
  if (input.toolAllow !== undefined) patch.toolAllow = input.toolAllow;
  if (input.toolBlock !== undefined) patch.toolBlock = input.toolBlock;
  if (input.approvalPolicy !== undefined) {
    patch.approvalPolicy = input.approvalPolicy as McpApprovalPolicy | null;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.auth !== undefined) {
    // omitted = keep; {type:"none"} = clear; bearer/headers = replace.
    patch.authConfigEncrypted = encryptConnectionAuthConfig(input.auth, deps.masterKey, id);
    patch.authType = authTypeOf(input.auth);
  }

  // OAuth mutation transitions (spec §6). Switching auth OFF oauth ends the
  // grant's life: revoke best-effort, then delete the 1:1 row. A URL change
  // while STAYING oauth (custom rows only — others 422'd above) invalidates
  // the grant a different way: the tokens, discovery metadata, and client
  // registration were all bound to the OLD resource/AS, so revoke and reset
  // the row to a blank `pending` for a fresh consent flow against the new URL.
  if (existing.authType === "oauth") {
    const leavingOauth = input.auth !== undefined && input.auth.type !== "oauth";
    const urlChanging = input.url !== undefined && input.url !== existing.url;
    if (leavingOauth || urlChanging) {
      const grant = await loadOauthGrant(deps.db, id);
      if (grant !== undefined) {
        await revokeBestEffort(deps.oauthBroker, grant);
        if (leavingOauth) {
          await deps.db
            .delete(schema.connectionOauth)
            .where(eq(schema.connectionOauth.id, grant.id));
        } else {
          await deps.db
            .update(schema.connectionOauth)
            .set({
              status: "pending",
              authorizationServer: null,
              authorizationEndpoint: null,
              tokenEndpoint: null,
              resource: null,
              revocationEndpoint: null,
              scopes: null,
              clientId: null,
              clientSecretEncrypted: null,
              accessTokenEncrypted: null,
              accessTokenExpiresAt: null,
              refreshTokenEncrypted: null,
              pendingState: null,
              pendingCodeVerifierEncrypted: null,
              pendingExpiresAt: null,
              connectedBy: null,
            })
            .where(eq(schema.connectionOauth.id, grant.id));
        }
      }
    }
  }

  const rows = await deps.db
    .update(schema.connections)
    .set(patch)
    .where(and(eq(schema.connections.id, id), scopeWhere(schema.connections, scope)))
    .returning();
  return { connection: connectionDto(rows[0]!) };
}

export async function deleteConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<DeleteResourceResponse> {
  const row = await loadOwned(deps.db, scope, id);
  const referencing = await connectionReferences(deps.db, scope, id);
  if (referencing.length > 0) throw errors.connectionInUse(referencing);
  // Ending an OAuth connection revokes its grant at the AS best-effort
  // (spec §6) before the row — and its cascading `connection_oauth` grant —
  // is deleted. Revocation failures never block the delete.
  if (row.authType === "oauth") {
    const grant = await loadOauthGrant(deps.db, id);
    if (grant !== undefined) await revokeBestEffort(deps.oauthBroker, grant);
  }
  await deps.db
    .delete(schema.connections)
    .where(and(eq(schema.connections.id, id), scopeWhere(schema.connections, scope)));
  return { id, deleted: true };
}

/**
 * Test-connection (spec §7/§9): probe NOW, persist, return the updated DTO.
 * An unhealthy server is a 200 whose DTO carries the classified health —
 * `probe_failed` (502) is reserved for failure of the probe machinery itself.
 */
export async function probeConnectionRoute(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<GetConnectionResponse> {
  const row = await loadOwned(deps.db, scope, id);
  try {
    const fresh = await probeAndPersist(deps, row);
    return { connection: connectionDto(fresh) };
  } catch (error) {
    if (isRuntimeApiError(error)) throw error;
    throw errors.probeFailed(
      error instanceof Error ? error.message : String(error),
    );
  }
}
