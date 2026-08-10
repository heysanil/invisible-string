/**
 * Probe persistence service (connectors redesign spec §7): run ONE health
 * probe for a `connections` row through the guarded egress fetch and persist
 * its outcome onto the row's probe columns.
 *
 * Persistence rules:
 *  - `health`, `last_checked_at`, `last_error` are written on EVERY probe
 *    (`last_error` clears to null on a healthy probe);
 *  - `tools_cache` + `tools_cached_at` are written ONLY on `ok` — a blip
 *    (unreachable, expired credentials) must not wipe the tool picker, so the
 *    prior cache is KEPT on failure.
 *
 * Decrypted auth headers live inside {@link probeAndPersist}'s scope only —
 * never logged, never persisted, never returned (`probeMcpServer` scrubs
 * header values out of classification messages before they reach
 * `last_error`).
 */
import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { ResourceDeps } from "../resources/common";
import { decryptConnectionAuthHeaders } from "../resources/mcp-crypto";
import { errors } from "../runtime/errors";
import { probeMcpServer } from "./mcp-probe";

/** The `connections` row shape the probe reads and returns. */
export type ConnectionRow = typeof schema.connections.$inferSelect;

/**
 * Probe `row`'s MCP server and persist the classified outcome, returning the
 * fresh row. Ownership is the CALLER's concern — pass a row already loaded
 * under the request's scope (the update below keys on the id alone).
 *
 * Never throws for an unhealthy server (that is a persisted classification);
 * it DOES throw for infrastructure failures — decrypt errors, a row deleted
 * mid-probe, DB write failures — which the route wraps as `probe_failed` and
 * the fire-and-forget create hook logs.
 */
export async function probeAndPersist(
  deps: ResourceDeps & { probeFetch: typeof fetch },
  row: ConnectionRow,
): Promise<ConnectionRow> {
  // Plaintext credentials: function scope only.
  const headers = decryptConnectionAuthHeaders(row, deps.masterKey);
  const outcome = await probeMcpServer({
    url: row.url,
    transport: row.transport,
    headers,
    // Mirrors connectionDto: an `oauth` row counts as credentialed even
    // before Plan 3 stores its grant, so its 401s read `auth_error`.
    hasCredentials: row.authConfigEncrypted != null || row.authType === "oauth",
    fetchImpl: deps.probeFetch,
  });

  const now = new Date();
  const patch: Partial<typeof schema.connections.$inferInsert> = {
    health: outcome.health,
    lastCheckedAt: now,
    lastError: outcome.error,
  };
  if (outcome.health === "ok") {
    patch.toolsCache = outcome.tools;
    patch.toolsCachedAt = now;
  }

  const rows = await deps.db
    .update(schema.connections)
    .set(patch)
    .where(eq(schema.connections.id, row.id))
    .returning();
  const fresh = rows[0];
  // Row deleted while the probe was in flight — nothing was persisted.
  if (!fresh) throw errors.notFound("connection");
  return fresh;
}
