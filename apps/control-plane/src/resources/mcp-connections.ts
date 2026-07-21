/**
 * MCP connection CRUD (agent CONTEXT), both scopes. Secrets are encrypted at
 * rest and NEVER echoed (read DTOs carry `hasCredentials` only). A connection
 * cannot be deleted while any agent draft or published agent version
 * references it (409, with the referencing agent names).
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createMcpConnectionRequestSchema,
  installMcpConnectionRequestSchema,
  updateMcpConnectionRequestSchema,
  type DeleteResourceResponse,
  type GetMcpConnectionResponse,
  type ListMcpConnectionsResponse,
  type McpApprovalPolicy,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "../runtime/errors";
import {
  mcpConnectionDto,
  parseBody,
  scopeInsertValues,
  scopeWhere,
  type ResourceDeps,
  type Scope,
} from "./common";
import { encryptMcpAuthConfig } from "./mcp-crypto";

type Row = typeof schema.mcpConnections.$inferSelect;

async function loadOwned(db: Db, scope: Scope, id: string): Promise<Row> {
  const rows = await db
    .select()
    .from(schema.mcpConnections)
    .where(and(eq(schema.mcpConnections.id, id), scopeWhere(schema.mcpConnections, scope)))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("mcp_connection");
  return row;
}

/**
 * Agent names (draft OR any published version definition) that reference
 * this connection id — the delete guard. The query is constrained to the
 * SAME scope as the connection, mirroring how compile-service resolves refs
 * (workspace connections resolve only against same-org agents; user
 * connections only against agents whose run-as user owns them). This keeps
 * the guard from ever reading or reporting agent names outside the owner's
 * scope. jsonb `@>` containment matches the id inside the
 * `context.mcpConnectionIds` array.
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
): Promise<ListMcpConnectionsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.mcpConnections)
    .where(scopeWhere(schema.mcpConnections, scope))
    .orderBy(schema.mcpConnections.name);
  return { connections: rows.map(mcpConnectionDto) };
}

export async function getConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<GetMcpConnectionResponse> {
  const row = await loadOwned(deps.db, scope, id);
  return { connection: mcpConnectionDto(row) };
}

export async function createConnection(
  deps: ResourceDeps,
  scope: Scope,
  body: unknown,
): Promise<GetMcpConnectionResponse> {
  const input = parseBody(createMcpConnectionRequestSchema, body);
  const id = randomUUID();
  const authConfigEncrypted = input.auth
    ? encryptMcpAuthConfig(input.auth, deps.masterKey, id)
    : null;
  const rows = await deps.db
    .insert(schema.mcpConnections)
    .values({
      id,
      ...scopeInsertValues(scope),
      name: input.name,
      description: input.description ?? null,
      source: "custom",
      url: input.url,
      authConfigEncrypted,
      toolAllow: input.toolAllow ?? null,
      toolBlock: input.toolBlock ?? null,
      approvalPolicy: input.approvalPolicy ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return { connection: mcpConnectionDto(rows[0]!) };
}

export async function installConnection(
  deps: ResourceDeps,
  scope: Scope,
  body: unknown,
): Promise<GetMcpConnectionResponse> {
  const input = parseBody(installMcpConnectionRequestSchema, body);
  const server = await deps.registry.getServer(input.registryName, input.version);
  if (!server) throw errors.registryServerNotFound(input.registryName);
  if (server.remotes.length === 0) {
    throw errors.registryServerNotInstallable(input.registryName);
  }
  // The stored URL must be one the registry actually advertises — otherwise a
  // caller could claim registry provenance while pointing the connection (and
  // its runtime-injected credentials) at an arbitrary host.
  if (!server.remotes.some((remote) => remote.url === input.remoteUrl)) {
    throw errors.registryRemoteMismatch(input.registryName);
  }
  const id = randomUUID();
  const authConfigEncrypted = input.auth
    ? encryptMcpAuthConfig(input.auth, deps.masterKey, id)
    : null;
  const rows = await deps.db
    .insert(schema.mcpConnections)
    .values({
      id,
      ...scopeInsertValues(scope),
      name: input.name ?? server.title ?? server.name,
      description: input.description ?? (server.description || null),
      source: "registry",
      registryId: input.registryName,
      // The client picked one of the server's remotes (from our trimmed DTO);
      // we store it as the connection target (never fetched here).
      url: input.remoteUrl,
      authConfigEncrypted,
      toolAllow: input.toolAllow ?? null,
      toolBlock: input.toolBlock ?? null,
      approvalPolicy: input.approvalPolicy ?? null,
      enabled: true,
    })
    .returning();
  return { connection: mcpConnectionDto(rows[0]!) };
}

export async function updateConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
  body: unknown,
): Promise<GetMcpConnectionResponse> {
  const input = parseBody(updateMcpConnectionRequestSchema, body);
  const existing = await loadOwned(deps.db, scope, id);

  // Resulting tool filter must not set both allow AND block.
  const nextAllow =
    input.toolAllow !== undefined ? input.toolAllow : existing.toolAllow;
  const nextBlock =
    input.toolBlock !== undefined ? input.toolBlock : existing.toolBlock;
  if (nextAllow && nextAllow.length > 0 && nextBlock && nextBlock.length > 0) {
    throw errors.toolFilterConflict();
  }

  const patch: Partial<typeof schema.mcpConnections.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.url !== undefined) patch.url = input.url;
  if (input.toolAllow !== undefined) patch.toolAllow = input.toolAllow;
  if (input.toolBlock !== undefined) patch.toolBlock = input.toolBlock;
  if (input.approvalPolicy !== undefined) {
    patch.approvalPolicy = input.approvalPolicy as McpApprovalPolicy | null;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.auth !== undefined) {
    // omitted = keep; {type:"none"} = clear; bearer/headers = replace.
    patch.authConfigEncrypted = encryptMcpAuthConfig(input.auth, deps.masterKey, id);
  }

  const rows = await deps.db
    .update(schema.mcpConnections)
    .set(patch)
    .where(and(eq(schema.mcpConnections.id, id), scopeWhere(schema.mcpConnections, scope)))
    .returning();
  return { connection: mcpConnectionDto(rows[0]!) };
}

export async function deleteConnection(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<DeleteResourceResponse> {
  await loadOwned(deps.db, scope, id);
  const referencing = await connectionReferences(deps.db, scope, id);
  if (referencing.length > 0) throw errors.connectionInUse(referencing);
  await deps.db
    .delete(schema.mcpConnections)
    .where(and(eq(schema.mcpConnections.id, id), scopeWhere(schema.mcpConnections, scope)));
  return { id, deleted: true };
}
