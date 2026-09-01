/**
 * Probe persistence service (connectors redesign spec §7): run ONE health
 * probe for a `connections` row through the guarded egress fetch and persist
 * its outcome onto the row's probe columns.
 *
 * CREDENTIALS LIVE IN TWO DIFFERENT HOMES, and conflating them was the whole
 * of the OAuth "connected but 401" bug (2026-08-31 fix plan F1/P1.1). Static
 * auth (`bearer`/`headers`) is an envelope on `connections.auth_config_encrypted`;
 * an OAuth grant's access token is an envelope on
 * `connection_oauth.access_token_encrypted`, readable ONLY through
 * `getAccessToken` (oauth/tokens.ts), which is also where refresh happens
 * centrally. `decryptConnectionAuthHeaders` deliberately returns `{}` for an
 * oauth row (resources/mcp-crypto.ts), so a probe built solely on it dialled
 * with NO Authorization header, collected the server's entirely correct 401,
 * and — because `hasCredentials` was hardcoded true for oauth — persisted
 * `auth_error`: "your token was rejected", about a token never sent. Every
 * OAuth connection therefore reported a 401 forever and never populated
 * `tools_cache`, so none could fill the tool picker or the tool directory.
 *
 * The auth-type branches (see {@link classifyConnection}):
 *  - not oauth                → static headers, exactly as before;
 *  - oauth, grant unusable    → `auth_required`, with NO dial. Consent is the
 *    missing piece; a round trip cannot tell us anything we do not know, and
 *    the badge should say "connect", not "rejected";
 *  - oauth, grant `connected` → `Authorization: Bearer <token>` from
 *    `getAccessToken` (refreshing first when the stored token is stale). A 401
 *    here is a REAL `auth_error`.
 *
 * Persistence rules:
 *  - `health`, `last_checked_at`, `last_error` are written on EVERY probe
 *    (`last_error` clears to null on a healthy probe);
 *  - `tools_cache` + `tools_cached_at` are written ONLY on `ok` — a blip
 *    (unreachable, expired credentials) must not wipe the tool picker, so the
 *    prior cache is KEPT on failure.
 *
 * Decrypted auth headers and access tokens live inside function scope only —
 * never logged, never persisted, never returned. `probeMcpServer` scrubs every
 * header VALUE (and the trailing segment of a `Bearer x` value) out of its
 * classification message, which is why the bearer is handed to it as a header
 * rather than pasted into a message here.
 */
import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { getAccessToken } from "../oauth/tokens";
import type { ResourceDeps } from "../resources/common";
import { decryptConnectionAuthHeaders } from "../resources/mcp-crypto";
import { errors, isRuntimeApiError } from "../runtime/errors";
import { probeMcpServer, type ProbeOutcome } from "./mcp-probe";

/** The `connections` row shape the probe reads and returns. */
export type ConnectionRow = typeof schema.connections.$inferSelect;

/**
 * What a probe runs on: the resource graph plus the guarded egress fetch.
 *
 * The OAuth token lifecycle rides `ResourceDeps.oauthBroker` — `OauthBrokerDeps`
 * already satisfies `TokenLifecycleDeps` structurally (db + masterKey +
 * publicAppUrl + fetchImpl + logger), which is precisely why that type was
 * written as a subset — so teaching the probe about tokens needs no new wiring
 * at the composition root.
 */
export type ProbeDeps = ResourceDeps & { probeFetch: typeof fetch };

/**
 * Probe `row`'s MCP server and persist the classified outcome, returning the
 * fresh row. Ownership is the CALLER's concern — pass a row already loaded
 * under the request's scope (the update below keys on the id alone).
 *
 * Never throws for an unhealthy server or an unusable grant (both are
 * persisted classifications); it DOES throw for infrastructure failures —
 * decrypt errors, a missing master key, a row deleted mid-probe, DB write
 * failures — which the route wraps as `probe_failed` and the fire-and-forget
 * create hook logs.
 */
export async function probeAndPersist(
  deps: ProbeDeps,
  row: ConnectionRow,
): Promise<ConnectionRow> {
  const outcome = await classifyConnection(deps, row);

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

/**
 * Resolve credentials for `row` and classify its server, without persisting
 * anything. Splits on auth type because the two credential homes have
 * different failure modes — a static secret is either configured or not, while
 * an OAuth grant can also be un-consented, mid-refresh, or retired.
 */
async function classifyConnection(
  deps: ProbeDeps,
  row: ConnectionRow,
): Promise<ProbeOutcome> {
  if (row.authType !== "oauth") {
    // Plaintext credentials: function scope only.
    const headers = decryptConnectionAuthHeaders(row, deps.masterKey);
    return probeMcpServer({
      url: row.url,
      transport: row.transport,
      headers,
      hasCredentials: row.authConfigEncrypted != null,
      fetchImpl: deps.probeFetch,
    });
  }

  // The grant's own status FIRST, because `getAccessToken` cannot tell the two
  // unusable states apart — it answers `oauth_not_connected` both for a grant
  // nobody ever consented to and for one the authorization server has since
  // disowned. Those are opposite user-facing facts ("connect this" vs "your
  // authorization was rejected"), and collapsing them is exactly the confusion
  // the original bug was made of.
  const grant = await deps.db
    .select({ status: schema.connectionOauth.status })
    .from(schema.connectionOauth)
    .where(eq(schema.connectionOauth.connectionId, row.id))
    .limit(1);
  const grantStatus = grant[0]?.status ?? null;
  if (grantStatus === null || grantStatus === "pending") {
    // Never consented. Nothing to present, so nothing to learn from a dial.
    return { health: "auth_required", tools: null, error: null };
  }

  let token: string;
  try {
    // The ONE reader of a grant's tokens: it refreshes centrally when the
    // stored token is (about to be) stale, and fails before any MCP dial when
    // the grant cannot produce one at all.
    ({ token } = await getAccessToken(deps.oauthBroker, row.id));
  } catch (error) {
    return classifyTokenFailure(error);
  }

  // Plaintext token: function scope only, handed straight to the transport.
  return probeMcpServer({
    url: row.url,
    transport: row.transport,
    headers: { Authorization: `Bearer ${token}` },
    // We really did present a credential, so a 401 here means the server
    // rejected it — the only case that legitimately reads `auth_error`.
    hasCredentials: true,
    fetchImpl: deps.probeFetch,
  });
}

/**
 * A grant that cannot produce a token is not an unhealthy MCP server:
 *
 *  - `oauth_not_connected` — reached ONLY from a grant that was past `pending`
 *    (the caller returns `auth_required` before this for one that never
 *    consented), so it means the authorization server disowned a grant the user
 *    really did complete: revoked, or a refresh answered `invalid_grant`. A
 *    credential existed and was rejected, which is `auth_error` — the state the
 *    detail view explains as "Authorization expired" with a Reconnect button.
 *    Nothing dialled, so there is no error string to report.
 *  - `oauth_exchange_failed` — the authorization server's token endpoint timed
 *    out, 5xx'd, or was refused by the egress guard. That is a third party we
 *    could not reach, which is what `unreachable` means; the grant itself
 *    stays `connected` (fix plan P3.1) so the next probe simply retries. Its
 *    detail is HTTP status + RFC error code only (oauth/tokens.ts) — never an
 *    OAuth value — so it is safe in `last_error`.
 *
 * Anything else (missing master key, an undecryptable envelope) is genuine
 * infrastructure failure: rethrow, and let the route answer 502 `probe_failed`.
 */
function classifyTokenFailure(error: unknown): ProbeOutcome {
  if (isRuntimeApiError(error)) {
    if (error.code === "oauth_not_connected") {
      return { health: "auth_error", tools: null, error: null };
    }
    if (error.code === "oauth_exchange_failed") {
      return { health: "unreachable", tools: null, error: error.message };
    }
  }
  throw error;
}
