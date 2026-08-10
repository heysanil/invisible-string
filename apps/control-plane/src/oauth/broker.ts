/**
 * OAuth consent broker (connectors redesign spec §6): the control plane owns
 * every state transition of an MCP connection's OAuth grant — the SPA only
 * opens URLs.
 *
 * `startOauth` runs discovery (persisted onto the `connection_oauth` row's
 * endpoint columns), resolves the client identity (CIMD-first, DCR fallback —
 * oauth/client-identity.ts), then arms a pending flow: a fresh S256 PKCE
 * verifier (envelope-encrypted at rest, AAD-bound to the row) and a
 * single-use `state`, both persisted with a 10-minute TTL so the flow
 * survives restarts. A new start SUPERSEDES any prior pending flow.
 *
 * `handleCallback` completes the flow. It is SESSION-BOUND: the popup shares
 * the app's cookies, so the callback requires an authenticated Better Auth
 * session whose user can manage the connection's scope — checked BEFORE the
 * single-use state is claimed or any token exchange runs, so a forwarded
 * callback URL is useless to an outsider (it neither completes nor burns the
 * flow). The claim itself is an atomic compare-and-clear on `pending_state`,
 * making every state single-use even under racing callbacks. The code
 * exchange sends `code_verifier` + the RFC 8707 `resource` and rides the
 * guarded egress fetch (the token endpoint came from server-controlled
 * discovery metadata — spec §7). Tokens land as AES-256-GCM envelopes
 * AAD-bound to the row (`connection_oauth:<column>:<row-id>`), the row goes
 * `connected`, and the post-connect probe fires asynchronously.
 *
 * SECRETS: access/refresh tokens, client secrets, authorization codes, and
 * PKCE verifiers exist in plaintext only inside function scope here — never
 * logged, never in an error message or DTO, never in the rendered callback
 * page. Failure detail carries HTTP status + RFC 6749 error codes at most.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  encryptSecret,
  newId,
  type EncryptedEnvelope,
  type Logger,
  type MasterKey,
  type StartOauthResponse,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { EgressBlockedError } from "../net/guarded-fetch";
import { scopeWhere, type Scope } from "../resources/common";
import { errors, isRuntimeApiError } from "../runtime/errors";
import { hasRole, type WorkspaceDeps } from "../workspace";
import {
  clientMetadataUrl,
  connectionOauthAad,
  mcpOauthRedirectUri,
  resolveClientIdentity,
} from "./client-identity";
import {
  discoverOauth,
  OauthDiscoveryError,
  type OauthDiscovery,
} from "./discovery";

type ConnectionRow = typeof schema.connections.$inferSelect;
type OauthRow = typeof schema.connectionOauth.$inferSelect;

/** Pending consent flows expire 10 minutes after `startOauth` (spec §3). */
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export interface OauthBrokerDeps {
  db: Db;
  masterKey: MasterKey | undefined;
  /**
   * Public app origin, no trailing slash — the SAME config value Slack OAuth
   * uses (integrations/config.ts `publicAppUrlFromEnv`): redirect URI, CIMD
   * client id, and the callback page's postMessage targetOrigin.
   */
  publicAppUrl: string;
  /**
   * Guarded egress fetch (net/guarded-fetch.ts) — discovery, DCR, and the
   * token exchange all hit attacker-influencible URLs (spec §7).
   */
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Better Auth session + membership lookups for the session-bound callback. */
  workspaceDeps: WorkspaceDeps;
  /**
   * Post-connect probe (probe/service.ts `probeAndPersist`), fired
   * fire-and-forget after a successful callback — never blocks the response.
   */
  probeConnection(connection: ConnectionRow): Promise<unknown>;
}

// ── start ────────────────────────────────────────────────────────────────────

/**
 * Begin (or re-begin) consent for a scope-owned OAuth connection: discovery →
 * client identity → fresh PKCE + single-use state persisted with TTL →
 * authorization URL. Any prior pending flow is superseded.
 */
export async function startOauth(
  deps: OauthBrokerDeps,
  scope: Scope,
  connectionId: string,
  userId: string,
): Promise<StartOauthResponse> {
  if (deps.masterKey === undefined) throw errors.encryptionKeyMissing();
  const connection = await loadScopedConnection(deps.db, scope, connectionId);
  if (connection.authType !== "oauth") {
    throw errors.invalidBody([
      {
        path: "authType",
        message: "connection does not use OAuth — switch its auth mode first",
      },
    ]);
  }
  const row = await ensureOauthRow(deps.db, connection.id);

  let discovery: OauthDiscovery;
  try {
    discovery = await discoverOauth(connection.url, deps.fetchImpl);
  } catch (error) {
    if (error instanceof OauthDiscoveryError) {
      throw errors.oauthDiscoveryFailed(error.reason, error.message);
    }
    throw error;
  }

  // Persist discovery results onto the row's endpoint columns — the callback
  // (exchange) and the token lifecycle (refresh, revocation) read them back
  // instead of re-dialing the MCP server.
  await deps.db
    .update(schema.connectionOauth)
    .set({
      authorizationServer: discovery.authorizationServer,
      authorizationEndpoint: discovery.authorizationEndpoint,
      tokenEndpoint: discovery.tokenEndpoint,
      resource: discovery.resource,
      revocationEndpoint: discovery.revocationEndpoint ?? null,
      scopes: discovery.scopesSupported ?? null,
    })
    .where(eq(schema.connectionOauth.id, row.id));

  const identity = await resolveClientIdentity(
    {
      publicAppUrl: deps.publicAppUrl,
      fetchImpl: deps.fetchImpl,
      masterKey: deps.masterKey,
      persistRegistration: async (rowId, values) => {
        await deps.db
          .update(schema.connectionOauth)
          .set({
            clientId: values.clientId,
            clientSecretEncrypted: values.clientSecretEncrypted,
          })
          .where(eq(schema.connectionOauth.id, rowId));
      },
    },
    discovery,
    {
      id: row.id,
      connectionId: connection.id,
      clientId: row.clientId,
      clientSecretEncrypted: row.clientSecretEncrypted,
    },
  );

  // Fresh PKCE verifier (RFC 7636 §4.1 charset via base64url) + single-use
  // state. Persisting BOTH supersedes any prior pending flow atomically —
  // the old state simply no longer matches.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  await deps.db
    .update(schema.connectionOauth)
    .set({
      pendingState: state,
      pendingCodeVerifierEncrypted: JSON.stringify(
        encryptSecret(
          verifier,
          deps.masterKey,
          connectionOauthAad("pending_code_verifier", row.id),
        ),
      ),
      pendingExpiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
    })
    .where(eq(schema.connectionOauth.id, row.id));

  const authorizeUrl = new URL(discovery.authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", identity.clientId);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    mcpOauthRedirectUri(deps.publicAppUrl),
  );
  // RFC 8707: bind the grant to the PRM's canonical resource — repeated on
  // every token request (exchange and refresh).
  authorizeUrl.searchParams.set("resource", discovery.resource);
  if (discovery.scopesSupported && discovery.scopesSupported.length > 0) {
    authorizeUrl.searchParams.set("scope", discovery.scopesSupported.join(" "));
  }
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  deps.logger.info("oauth.start", {
    fields: {
      connectionId: connection.id,
      userId,
      authorizationServer: discovery.authorizationServer,
    },
  });
  return { authorizeUrl: authorizeUrl.href };
}

// ── callback ─────────────────────────────────────────────────────────────────

export interface OauthCallbackQuery {
  code?: string;
  state?: string;
  /** RFC 6749 error code when the AS (or user) declined consent. */
  error?: string;
}

export type CallbackOutcome =
  | { ok: true; connectionId: string }
  | { ok: false; reason: string; connectionId?: string };

/**
 * Complete a consent flow. Never throws for flow-level failures — the route
 * always renders the popup page, so failures come back as outcomes whose
 * `reason` reuses the typed error vocabulary (`oauth_state_invalid`,
 * `oauth_exchange_failed`, …).
 */
export async function handleCallback(
  deps: OauthBrokerDeps,
  query: OauthCallbackQuery,
  headers: Headers,
): Promise<CallbackOutcome> {
  // Session FIRST: an anonymous hit can neither observe nor burn anything.
  const session = await deps.workspaceDeps.getSession(headers);
  if (!session) {
    deps.logger.warn("oauth.callback_rejected", {
      fields: { reason: "unauthenticated" },
    });
    return { ok: false, reason: "unauthenticated" };
  }

  const state = query.state?.trim() ?? "";
  if (state === "") return { ok: false, reason: errors.oauthStateInvalid().code };
  const found = await findPendingFlow(deps.db, state);
  if (!found) {
    deps.logger.warn("oauth.callback_rejected", {
      fields: { reason: "oauth_state_invalid" },
    });
    return { ok: false, reason: errors.oauthStateInvalid().code };
  }
  const { connection, oauth } = found;
  const fail = (reason: string): CallbackOutcome => ({
    ok: false,
    reason,
    connectionId: connection.id,
  });

  // Scope access BEFORE claiming or exchanging: an authenticated outsider
  // must neither trigger an exchange nor burn the legitimate user's state.
  if (!(await mayManageConnection(deps, session.user.id, connection))) {
    deps.logger.warn("oauth.callback_rejected", {
      fields: { reason: "forbidden", connectionId: connection.id },
    });
    return fail("forbidden");
  }

  // Atomic single-use claim: compare-and-clear on pending_state. A racing
  // duplicate (or replay) finds nothing to clear and dies here.
  const claimed = await deps.db
    .update(schema.connectionOauth)
    .set({
      pendingState: null,
      pendingCodeVerifierEncrypted: null,
      pendingExpiresAt: null,
    })
    .where(
      and(
        eq(schema.connectionOauth.id, oauth.id),
        eq(schema.connectionOauth.pendingState, state),
      ),
    )
    .returning({ id: schema.connectionOauth.id });
  if (claimed.length === 0) return fail(errors.oauthStateInvalid().code);
  if (
    oauth.pendingExpiresAt === null ||
    oauth.pendingExpiresAt.getTime() <= Date.now()
  ) {
    deps.logger.warn("oauth.callback_rejected", {
      fields: { reason: "state_expired", connectionId: connection.id },
    });
    return fail(errors.oauthStateInvalid().code);
  }

  try {
    // AS-reported error (e.g. the user declined at consent) — typed failure.
    if (query.error) {
      throw errors.oauthExchangeFailed(
        `authorization was not granted (${sanitizeOauthErrorCode(query.error)})`,
      );
    }
    const code = query.code?.trim() ?? "";
    if (code === "") {
      throw errors.oauthExchangeFailed("callback carried no authorization code");
    }
    if (deps.masterKey === undefined) throw errors.encryptionKeyMissing();
    if (oauth.tokenEndpoint === null || oauth.pendingCodeVerifierEncrypted === null) {
      // A pending state without exchange material means the start flow never
      // finished persisting — unrecoverable for this flow.
      throw errors.oauthExchangeFailed("no token endpoint on record — restart the connect flow");
    }
    const verifier = decryptRowSecret(
      oauth.pendingCodeVerifierEncrypted,
      deps.masterKey,
      "pending_code_verifier",
      oauth.id,
      connection.id,
    );
    const clientSecret =
      oauth.clientSecretEncrypted !== null
        ? decryptRowSecret(
            oauth.clientSecretEncrypted,
            deps.masterKey,
            "client_secret",
            oauth.id,
            connection.id,
          )
        : null;
    const tokens = await exchangeCode(deps, {
      tokenEndpoint: oauth.tokenEndpoint,
      // CIMD identities are never persisted — reconstruct from config.
      clientId: oauth.clientId ?? clientMetadataUrl(deps.publicAppUrl),
      clientSecret,
      code,
      verifier,
      resource: oauth.resource,
    });
    await deps.db
      .update(schema.connectionOauth)
      .set({
        accessTokenEncrypted: JSON.stringify(
          encryptSecret(
            tokens.access_token,
            deps.masterKey,
            connectionOauthAad("access_token", oauth.id),
          ),
        ),
        accessTokenExpiresAt:
          tokens.expires_in !== undefined
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : null,
        refreshTokenEncrypted:
          tokens.refresh_token !== undefined
            ? JSON.stringify(
                encryptSecret(
                  tokens.refresh_token,
                  deps.masterKey,
                  connectionOauthAad("refresh_token", oauth.id),
                ),
              )
            : null,
        ...(tokens.scope !== undefined
          ? { scopes: tokens.scope.split(/\s+/).filter((s) => s.length > 0) }
          : {}),
        status: "connected",
        connectedBy: session.user.id,
      })
      .where(eq(schema.connectionOauth.id, oauth.id));
  } catch (error) {
    if (isRuntimeApiError(error)) {
      // Errors at any step land the grant in `status: error` (spec §6) —
      // the message stays server-side; the popup only learns the code.
      await deps.db
        .update(schema.connectionOauth)
        .set({ status: "error" })
        .where(eq(schema.connectionOauth.id, oauth.id));
      deps.logger.warn("oauth.callback_failed", {
        fields: { reason: error.code, connectionId: connection.id },
      });
      return fail(error.code);
    }
    throw error;
  }

  // Post-connect probe (spec §7 triggers): fire-and-forget — the popup never
  // waits on it, and a probe failure only logs.
  void deps.probeConnection(connection).catch((error) => {
    deps.logger.warn("oauth.post_connect_probe_failed", {
      fields: { connectionId: connection.id },
      err: error,
    });
  });
  deps.logger.info("oauth.connected", {
    fields: { connectionId: connection.id, userId: session.user.id },
  });
  return { ok: true, connectionId: connection.id };
}

// ── callback page ────────────────────────────────────────────────────────────

/**
 * CSP for the callback page ONLY: it carries one inline script (the
 * postMessage + close), which the app-wide `default-src 'self'` would block.
 * Everything else stays locked down.
 */
export const OAUTH_CALLBACK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The minimal popup page: posts `{type:"mcp-oauth", ok, connectionId}` to the
 * opener with `targetOrigin` pinned to the public app URL (never `*`), then
 * closes. Values are JSON-embedded with `<` escaped so no query-derived text
 * can break out of the script context.
 */
export function renderCallbackPage(
  outcome: CallbackOutcome,
  targetOrigin: string,
): string {
  const payload = {
    type: "mcp-oauth" as const,
    ok: outcome.ok,
    connectionId: outcome.ok ? outcome.connectionId : (outcome.connectionId ?? null),
  };
  const message = JSON.stringify(payload).replaceAll("<", "\\u003c");
  const target = JSON.stringify(targetOrigin).replaceAll("<", "\\u003c");
  const heading = outcome.ok ? "Connection authorized" : "Authorization failed";
  const detail = outcome.ok
    ? "You can close this window."
    : "The connection was not authorized. Close this window and try again.";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${heading}</title></head>
<body>
<p>${heading}. ${detail}</p>
<script>
  (function () {
    if (window.opener) {
      try { window.opener.postMessage(${message}, ${target}); } catch (e) {}
    }
    window.close();
  })();
</script>
</body>
</html>
`;
}

// ── internals ────────────────────────────────────────────────────────────────

async function loadScopedConnection(
  db: Db,
  scope: Scope,
  id: string,
): Promise<ConnectionRow> {
  const rows = await db
    .select()
    .from(schema.connections)
    .where(
      and(eq(schema.connections.id, id), scopeWhere(schema.connections, scope)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("connection");
  return row;
}

/** Load-or-create the 1:1 grant row (creates made it; PATCHed-to-oauth rows
 * get it lazily here). Insert races resolve via the connection_id unique. */
async function ensureOauthRow(db: Db, connectionId: string): Promise<OauthRow> {
  const existing = await db
    .select()
    .from(schema.connectionOauth)
    .where(eq(schema.connectionOauth.connectionId, connectionId))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(schema.connectionOauth)
    .values({ id: newId("co"), connectionId })
    .onConflictDoNothing({ target: schema.connectionOauth.connectionId })
    .returning();
  if (inserted[0]) return inserted[0];
  const raced = await db
    .select()
    .from(schema.connectionOauth)
    .where(eq(schema.connectionOauth.connectionId, connectionId))
    .limit(1);
  return raced[0]!;
}

async function findPendingFlow(
  db: Db,
  state: string,
): Promise<{ connection: ConnectionRow; oauth: OauthRow } | null> {
  const rows = await db
    .select({ oauth: schema.connectionOauth, connection: schema.connections })
    .from(schema.connectionOauth)
    .innerJoin(
      schema.connections,
      eq(schema.connectionOauth.connectionId, schema.connections.id),
    )
    .where(eq(schema.connectionOauth.pendingState, state))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * May this user manage (and thus connect) the connection? Workspace scope
 * requires the same owner/admin level that gates every connection mutation;
 * user scope requires being the owner. Audit-only `connected_by` is set from
 * the same session.
 */
async function mayManageConnection(
  deps: OauthBrokerDeps,
  userId: string,
  connection: ConnectionRow,
): Promise<boolean> {
  if (connection.scope === "user") return connection.userId === userId;
  if (connection.organizationId === null) return false;
  const membership = await deps.workspaceDeps.getMembership(
    userId,
    connection.organizationId,
  );
  return membership !== null && hasRole(membership.role, "admin");
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().nonnegative().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** RFC 6749 §5.2 error body — only the machine `error` code is surfaced. */
const tokenErrorSchema = z.object({ error: z.string().min(1) });

/** Token responses are small JSON; anything past this is discarded. */
const MAX_TOKEN_BODY_BYTES = 262_144;

interface ExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  code: string;
  verifier: string;
  resource: string | null;
}

/** Redeem the authorization code. Throws `oauth_exchange_failed` (typed, no
 * OAuth values in the message) on any rejection. */
async function exchangeCode(
  deps: OauthBrokerDeps,
  input: ExchangeInput,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: mcpOauthRedirectUri(deps.publicAppUrl),
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  if (input.resource !== null) body.set("resource", input.resource);
  if (input.clientSecret !== null) body.set("client_secret", input.clientSecret);

  let res: Response;
  try {
    res = await deps.fetchImpl(input.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      throw errors.oauthExchangeFailed(
        `egress guard refused the token endpoint (${error.reason})`,
      );
    }
    throw errors.oauthExchangeFailed("token endpoint unreachable");
  }

  const json = await readJsonCapped(res);
  if (res.status !== 200) {
    const parsedError = tokenErrorSchema.safeParse(json);
    const code = parsedError.success ? `: ${parsedError.data.error}` : "";
    throw errors.oauthExchangeFailed(`HTTP ${res.status}${code}`);
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw errors.oauthExchangeFailed(
      "token response is missing an access_token",
    );
  }
  return parsed.data;
}

function decryptRowSecret(
  serialized: string,
  masterKey: MasterKey,
  column: "client_secret" | "pending_code_verifier",
  rowId: string,
  connectionId: string,
): string {
  try {
    return decryptSecret(
      JSON.parse(serialized) as EncryptedEnvelope,
      masterKey,
      connectionOauthAad(column, rowId),
    );
  } catch {
    throw errors.mcpSecretUnavailable(connectionId);
  }
}

/** AS-supplied error codes are logged — normalize to a safe charset first. */
function sanitizeOauthErrorCode(code: string): string {
  const trimmed = code.trim().slice(0, 64);
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : "unknown_error";
}

/**
 * Best-effort capped JSON body read: `null` on no body, oversize, or
 * non-JSON — callers surface typed errors; the body is never quoted back.
 */
async function readJsonCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_TOKEN_BODY_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
