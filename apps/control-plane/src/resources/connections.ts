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
 *
 * Also here: the per-agent-version TOOL DIRECTORY (2026-08-11 spec D5) — the
 * read-only projection of this domain's probe-cached `tools/list` that lets
 * the chat thread render a tool call in English. It lives with the data it
 * projects; see {@link getAgentVersionTools}.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  connectorOauthClientIdentity,
  createConnectionRequestSchema,
  newId,
  updateConnectionRequestSchema,
  type ConnectionOauthStatus,
  type ConnectionToolDirectoryEntry,
  type ConnectorCatalogEntry,
  type CreateConnectionResponse,
  type DeleteResourceResponse,
  type GetAgentVersionToolsResponse,
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

/**
 * Grant status for one row's DTO: oauth rows read their 1:1 grant (a missing
 * row — e.g. a PATCHed-to-oauth connection before its first start — reads
 * `pending`); every other auth type is null. Readers MUST carry this or the
 * SPA's auth panel can never leave "pending" after a refetch (spec §6/§10).
 */
async function oauthStatusOf(
  db: Db,
  row: Row,
): Promise<ConnectionOauthStatus | null> {
  if (row.authType !== "oauth") return null;
  const grant = await loadOauthGrant(db, row.id);
  return grant?.status ?? "pending";
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
  // Grant statuses for the oauth rows in ONE query (not per-row).
  const oauthIds = rows
    .filter((row) => row.authType === "oauth")
    .map((row) => row.id);
  const grants =
    oauthIds.length === 0
      ? []
      : await deps.db
          .select({
            connectionId: schema.connectionOauth.connectionId,
            status: schema.connectionOauth.status,
          })
          .from(schema.connectionOauth)
          .where(inArray(schema.connectionOauth.connectionId, oauthIds));
  const statusById = new Map(grants.map((g) => [g.connectionId, g.status]));
  return {
    connections: rows.map((row) =>
      connectionDto(
        row,
        row.authType === "oauth" ? (statusById.get(row.id) ?? "pending") : null,
      ),
    ),
  };
}

export async function getConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<GetConnectionResponse> {
  const row = await loadOwned(deps.db, scope, id);
  return { connection: connectionDto(row, await oauthStatusOf(deps.db, row)) };
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
  /**
   * Catalog-declared client identity, carried onto the newborn grant (fix plan
   * §5 Phase 2 option (b)). A `preregistered` recipe means the provider gates
   * client registration — Vercel answers every DCR body `invalid_redirect_uri`
   * — so the broker must take its client_id from operator config instead of
   * discovering a strategy at start. `dynamic` (and every non-catalog source)
   * leaves the column NULL: which of CIMD or DCR applies is a runtime fact
   * about the AS metadata, unknowable here, and the broker records the outcome
   * it actually used when it arms the flow.
   */
  let oauthClientIdentityMode: "preregistered" | null = null;
  if (input.source === "catalog") {
    const entry = (deps.catalog ?? loadConnectorCatalog()).get(input.slug);
    if (!entry) throw errors.catalogEntryNotFound(input.slug);
    const auth = requireRecipeAuth(entry, input.auth);
    if (connectorOauthClientIdentity(entry.auth) === "preregistered") {
      oauthClientIdentityMode = "preregistered";
    }
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

  // An OAuth connection is born WITHOUT a credential — consent has not happened
  // yet — so `auth_required` is the honest initial health, not the `unknown`
  // default that means "never looked". It is also exactly what a probe would
  // persist for a `pending` grant (probe/service.ts classifies that arm with no
  // dial at all), which is why stating it here costs nothing and the create-time
  // probe below can be skipped outright.
  if (values.authType === "oauth") values.health = "auth_required";

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
      .values({
        id: newId("co"),
        connectionId: row.id,
        clientIdentityMode: oauthClientIdentityMode,
      })
      .onConflictDoNothing({ target: schema.connectionOauth.connectionId });
    oauthStartPath =
      scope.kind === "workspace"
        ? `/workspaces/${scope.organizationId}/connections/${row.id}/oauth/start`
        : `/me/connections/${row.id}/oauth/start`;
  }
  // First health probe (spec §7) — STATIC auth only: fire-and-forget, so the
  // create response NEVER waits on or fails from it. The outcome lands on the
  // row's probe columns; an infrastructure failure only logs (no credential
  // material in the error: probeAndPersist scrubs classification text, and
  // typed errors carry ids).
  //
  // OAuth rows are deliberately EXCLUDED (fix plan F10/F11, P1.2). Consent has
  // not happened at create time, so the probe could only report the absence of
  // a grant — `auth_required`, which the insert above already states without a
  // round trip. Firing it anyway is what made a brand-new Linear/Vercel install
  // read "http 401" the moment it appeared: the probe dialled with no
  // Authorization header and collected the server's entirely correct rejection.
  // Worse, now that the POST-CALLBACK probe carries the broker's token, this
  // one racing it can land LAST and overwrite a healthy result with that
  // failure — a connection that really works showing a 401 forever. Not
  // dialling removes the race by construction, which is strictly better than a
  // probe-generation counter: a counter only narrows the window.
  if (row.authType !== "oauth") {
    void probeAndPersist(deps, row).catch((error) => {
      deps.logger.warn("connections.initial_probe_failed", {
        fields: { connectionId: row.id },
        err: error,
      });
    });
  }
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
  // ENTERING oauth from a static auth type is the mirror image of the reset
  // below, and stale in exactly the same way: the row's health describes a
  // credential the caller just discarded, and a grant it has not consented to
  // yet cannot present one. (The 1:1 grant row is minted lazily by the start
  // route — `ensureOauthRow` — so nothing else is owed here.)
  if (input.auth?.type === "oauth" && existing.authType !== "oauth") {
    patch.health = "auth_required";
    patch.lastError = null;
    patch.lastCheckedAt = null;
  }

  if (existing.authType === "oauth") {
    const leavingOauth = input.auth !== undefined && input.auth.type !== "oauth";
    const urlChanging = input.url !== undefined && input.url !== existing.url;
    if (leavingOauth || urlChanging) {
      // The row's PROBE columns describe a world that no longer exists (fix
      // plan F16, P3.4): a health and a `last_error` collected against the old
      // grant — in practice the "http 401" of an unauthenticated dial — and, on
      // a URL change, a tool cache belonging to a different server entirely.
      // Left in place the SPA keeps rendering that stale failure for an
      // endpoint nothing has dialled since, with no way for a user to tell it
      // apart from a live one. `auth_required` is the honest reading for a
      // blank `pending` grant (identical to what the create path stamps, and to
      // what a probe would persist without a dial); leaving oauth instead lands
      // `unknown`, because the caller's brand-new static credential has not
      // been tried and "connect me" would be a different lie. `tools_cache`
      // survives an auth switch on the SAME url — those really are still the
      // server's tools, and blanking the tool picker on a re-auth helps nobody.
      patch.health = leavingOauth ? "unknown" : "auth_required";
      patch.lastError = null;
      patch.lastCheckedAt = null;
      if (urlChanging) {
        patch.toolsCache = null;
        patch.toolsCachedAt = null;
      }
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
              // Client identity goes too: a registered client is only valid at
              // the issuer that minted it, and the new URL may resolve to an
              // entirely different authorization server.
              clientIdentityMode: null,
              clientId: null,
              clientSecretEncrypted: null,
              clientRegistrationIssuer: null,
              accessTokenEncrypted: null,
              accessTokenExpiresAt: null,
              refreshTokenEncrypted: null,
              pendingState: null,
              pendingCodeVerifierEncrypted: null,
              pendingExpiresAt: null,
              pendingStartedBy: null,
              pendingFlow: null,
              expectedIssuer: null,
              issParameterSupported: null,
              lastErrorCode: null,
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
  // The response seeds the SPA's detail cache — carry the grant status.
  return {
    connection: connectionDto(rows[0]!, await oauthStatusOf(deps.db, rows[0]!)),
  };
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
    // Also seeds the SPA's detail cache — carry the grant status.
    return {
      connection: connectionDto(fresh, await oauthStatusOf(deps.db, fresh)),
    };
  } catch (error) {
    if (isRuntimeApiError(error)) throw error;
    throw errors.probeFailed(
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ── agent-version tool directory (2026-08-11 spec D5) ───────────────────────

/**
 * `agents.id` / `agent_versions.id` are uuid columns, so a junk path segment
 * reaches postgres as `invalid input syntax for type uuid` — a 500 for what is
 * really "no such row". Shape-check first and 404 like any other unknown id.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tool directory for ONE agent version — what the chat thread reads so a step
 * can render as "Linear · Create issue", with the tool's own description as its
 * subtitle, instead of `linear__create_issue` plus a JSON blob (spec D5).
 *
 * Everything served here is data the control plane already holds: the version
 * row's `connection_slugs` map (slug → `cn_` id, written at publish from the
 * same unique-slug pass the compiler bakes into the generated files) joined to
 * each connection's display name and its probe-cached `tools/list`
 * (`connections.tools_cache`). NOTHING is fetched from an MCP server on this
 * path — rendering a thread must never dial a third-party server, and a stale
 * or absent cache is a display degradation, never a probe.
 *
 * WHY A VERSION-KEYED ROUTE rather than a field on session detail: a session is
 * bound to exactly one `agent_version_id` and versions are immutable, so the
 * thread fetches this ONCE per version and resolves every tool call in the run
 * stream against it client-side — no round trip per tool call, no N+1, and the
 * same response serves every session on that version. The echoed
 * `agentVersionId` is what makes a client-side cache safe to key.
 *
 * Degradations, all silent, all still 200 with a well-formed directory:
 *  - `connection_slugs` null (a row published before that column existed) →
 *    no entries; republishing backfills it;
 *  - a slug whose connection row no longer resolves in the agent's scope → the
 *    entry is DROPPED and the thread falls back to the slug it already has in
 *    the tool name. Defensive rather than routine: the delete guard
 *    (`connectionReferences`) refuses to remove a connection any version's
 *    definition still names, so this is reachable only by a scope change;
 *  - a connection never probed OK → `tools: []` (empty, never absent), so the
 *    step shows its humanized name with no description.
 *
 * A DISABLED connection is deliberately still resolved: the version was
 * compiled while it was enabled and its calls are in the run history this
 * decorates — hiding the name would only make old threads less legible.
 *
 * SCOPE: the agent's own — workspace rows of this organization, or user rows of
 * the agent's run-as user. That is exactly the set `resolveCompileInputs`
 * accepted at publish, so re-deriving it here means a connection that has since
 * changed hands cannot be read back through an old version. A workspace member
 * reading a run-as-someone-else agent does see that user's connection NAMES —
 * but they already do, because the emitted slug IS `slugifyName(name)` and
 * rides every tool call in the run stream this directory exists to decorate.
 * No credential material, URL, or auth config appears in this projection.
 */
export async function getAgentVersionTools(
  deps: ResourceDeps,
  organizationId: string,
  agentId: string,
  versionId: string,
): Promise<GetAgentVersionToolsResponse> {
  if (!UUID_RE.test(agentId)) throw errors.notFound("agent");
  if (!UUID_RE.test(versionId)) throw errors.notFound("agent_version");

  const agents = await deps.db
    .select({
      id: schema.agents.id,
      runAsUserId: schema.agents.runAsUserId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.organizationId, organizationId),
      ),
    )
    .limit(1);
  const agent = agents[0];
  if (!agent) throw errors.notFound("agent");

  // The version must belong to THIS agent — a version id from another agent
  // (or another workspace) is 404, not somebody else's tool inventory.
  const versions = await deps.db
    .select({
      id: schema.agentVersions.id,
      connectionSlugs: schema.agentVersions.connectionSlugs,
    })
    .from(schema.agentVersions)
    .where(
      and(
        eq(schema.agentVersions.id, versionId),
        eq(schema.agentVersions.agentId, agent.id),
      ),
    )
    .limit(1);
  const version = versions[0];
  if (!version) throw errors.notFound("agent_version");

  const slugs = version.connectionSlugs ?? {};
  const entries: ConnectionToolDirectoryEntry[] = [];
  const connectionIds = [...new Set(Object.values(slugs))];
  if (connectionIds.length > 0) {
    // ONE query for every referenced connection (the map is small — a context's
    // connection list — but a per-slug SELECT here would be an N+1 on a path
    // the thread hits on every open).
    const rows = await deps.db
      .select({
        id: schema.connections.id,
        name: schema.connections.name,
        scope: schema.connections.scope,
        organizationId: schema.connections.organizationId,
        userId: schema.connections.userId,
        toolsCache: schema.connections.toolsCache,
      })
      .from(schema.connections)
      .where(inArray(schema.connections.id, connectionIds));
    const byId = new Map(
      rows
        .filter(
          (row) =>
            (row.scope === "workspace" && row.organizationId === organizationId) ||
            (row.scope === "user" && row.userId === agent.runAsUserId),
        )
        .map((row) => [row.id, row]),
    );
    for (const [slug, connectionId] of Object.entries(slugs)) {
      const row = byId.get(connectionId);
      if (!row) continue;
      entries.push({
        slug,
        connectionId: row.id,
        connectionName: row.name,
        tools: row.toolsCache ?? [],
      });
    }
    // Stable order (the map's key order is insertion order from publish, which
    // is definition order — fine, but sorting makes the response comparable).
    entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  return {
    directory: { agentVersionId: version.id, connections: entries },
  };
}
