/**
 * OAuth token lifecycle (connectors redesign spec §6): central refresh with
 * single-flight, and best-effort revocation for the mutation transitions.
 *
 * `getAccessToken` is the ONLY reader of a grant's tokens: the runtime token
 * route (Plan 3 Task 7) calls it per agent request, so refresh happens
 * centrally — agents never hold refresh material. The whole decision runs
 * inside one transaction holding `SELECT … FOR UPDATE` on the
 * `connection_oauth` row: concurrent callers (same process, another replica)
 * queue on the row lock, and whoever loses the race re-reads the freshly
 * rotated token instead of double-spending the refresh token — single-flight
 * enforced by Postgres, not an in-process mutex.
 *
 * Refresh rides the guarded egress fetch (the token endpoint came from
 * server-controlled discovery metadata — spec §7), always names the RFC 8707
 * `resource`, and persists rotation: some ASes rotate refresh tokens on every
 * use, so a returned refresh_token replaces the stored one. `invalid_grant`
 * is the AS saying the grant is dead — the row lands `expired`, the
 * connection's health flips to `auth_error`, and callers get the typed 409
 * `oauth_not_connected` (re-consent is the only recovery).
 *
 * That rejection is the ONLY terminal one (2026-08-31 fix plan F4/P3.1).
 * Every other refresh failure — AS 5xx, egress timeout, guard refusal — is a
 * blip that never spent the refresh token, so the row stays `connected` and
 * the typed error is simply rethrown for the caller to retry. Writing a
 * status there would trip this function's own `status !== "connected"` gate
 * on every LATER demand, making a 30-second outage at the authorization
 * server indistinguishable from a dead grant and forcing a needless
 * re-consent.
 *
 * WHERE THESE REQUESTS GO IS AN INVARIANT THIS MODULE DOES NOT CHECK, and
 * must not be weakened elsewhere. `row.token_endpoint`, `row.resource` and
 * `row.revocation_endpoint` all came from discovery against an MCP server
 * that names its own authorization server, and the refresh below POSTs the
 * stored refresh token AND client secret at the first of them, months after
 * consent, with no issuer comparison of any kind. What makes that safe is
 * that oauth/broker.ts promotes those columns ONLY in the same write that
 * stores tokens minted through them (its `pending_flow` staging): a consent
 * flow that discovers a different authorization server and then fails, or is
 * simply abandoned, cannot move them. Restore a start-time write of any of
 * those columns and this function becomes the delivery mechanism — every
 * failed re-consent hands a live refresh token to whatever endpoint the MCP
 * server last advertised. The guard is broker.test.ts's "a re-consent that
 * never completes cannot repoint a live grant" case.
 *
 * SECRETS: access/refresh tokens and client secrets exist in plaintext only
 * inside function scope — never logged, never in an error message or DTO.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  encryptSecret,
  type EncryptedEnvelope,
  type Logger,
  type MasterKey,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { EgressBlockedError } from "../net/guarded-fetch";
import { errors, RuntimeApiError } from "../runtime/errors";
import {
  describeProviderFailure,
  isTerminalTokenError,
  providerErrorCode,
} from "./error-codes";
import { clientMetadataUrl, connectionOauthAad } from "./client-identity";

type OauthRow = typeof schema.connectionOauth.$inferSelect;

/** Tokens expiring within this margin are refreshed instead of returned. */
export const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Advisory expiry returned when the AS never reported `expires_in`: callers
 * (the agent-side cache) need SOME horizon; the token itself may live longer,
 * and the next call past the horizon simply re-reads the same stored token.
 */
export const NO_EXPIRY_ADVISORY_TTL_MS = 60 * 60 * 1000;

/**
 * A subset of `OauthBrokerDeps` (oauth/broker.ts) — the broker deps object
 * satisfies this structurally, so route code passes `deps.oauthBroker`.
 */
export interface TokenLifecycleDeps {
  db: Db;
  masterKey: MasterKey | undefined;
  /** Public app origin — reconstructs the CIMD client id (never persisted). */
  publicAppUrl: string;
  /** Guarded egress fetch — refresh and revocation dial discovered URLs. */
  fetchImpl: typeof fetch;
  logger: Logger;
}

// ── getAccessToken ───────────────────────────────────────────────────────────

type TokenOutcome =
  | { kind: "ok"; token: string; expiresAt: Date }
  | { kind: "fail"; error: RuntimeApiError };

/**
 * Return a usable access token for a `connected` OAuth connection, refreshing
 * centrally when the stored one is (about to be) expired. Throws
 * `oauth_not_connected` (409) whenever the grant cannot produce one without a
 * new consent flow.
 */
export async function getAccessToken(
  deps: TokenLifecycleDeps,
  connectionId: string,
): Promise<{ token: string; expiresAt: Date }> {
  if (deps.masterKey === undefined) throw errors.encryptionKeyMissing();
  const masterKey = deps.masterKey;

  const outcome = await deps.db.transaction(
    async (tx): Promise<TokenOutcome> => {
      // Row lock = the single-flight: a concurrent caller blocks here until
      // this transaction commits, then re-reads the rotated tokens.
      const rows = await tx
        .select()
        .from(schema.connectionOauth)
        .where(eq(schema.connectionOauth.connectionId, connectionId))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || row.status !== "connected") {
        return { kind: "fail", error: errors.oauthNotConnected() };
      }

      // Fresh enough? Return the stored token untouched. A token without a
      // recorded expiry is treated as live (many ASes issue non-expiring
      // tokens) with an advisory horizon.
      if (row.accessTokenEncrypted !== null) {
        const expiresAt = row.accessTokenExpiresAt;
        if (
          expiresAt === null ||
          expiresAt.getTime() > Date.now() + ACCESS_TOKEN_EXPIRY_MARGIN_MS
        ) {
          return {
            kind: "ok",
            token: decryptRowSecret(
              row.accessTokenEncrypted,
              masterKey,
              "access_token",
              row.id,
              connectionId,
            ),
            expiresAt:
              expiresAt ?? new Date(Date.now() + NO_EXPIRY_ADVISORY_TTL_MS),
          };
        }
      }

      // Stale — refresh, or die trying. Without a refresh token (or the token
      // endpoint discovery recorded) the grant cannot be renewed server-side:
      // that is the same terminal state as a rejected refresh.
      if (row.refreshTokenEncrypted === null || row.tokenEndpoint === null) {
        await markExpired(tx, row, connectionId, "no_refresh_material");
        return { kind: "fail", error: errors.oauthNotConnected() };
      }
      const refreshToken = decryptRowSecret(
        row.refreshTokenEncrypted,
        masterKey,
        "refresh_token",
        row.id,
        connectionId,
      );
      const clientSecret =
        row.clientSecretEncrypted !== null
          ? decryptRowSecret(
              row.clientSecretEncrypted,
              masterKey,
              "client_secret",
              row.id,
              connectionId,
            )
          : null;

      let refreshed: TokenResponse;
      try {
        refreshed = await refreshGrant(deps, {
          tokenEndpoint: row.tokenEndpoint,
          // CIMD identities are never persisted — reconstruct from config.
          clientId: row.clientId ?? clientMetadataUrl(deps.publicAppUrl),
          clientSecret,
          refreshToken,
          resource: row.resource,
        });
      } catch (error) {
        if (error instanceof RefreshTerminalError) {
          // The AS disowned the grant or the client — only re-consent recovers
          // it. Retiring the row makes the next probe read `auth_required`
          // ("reconnect"), where leaving it `connected` would retry a dead
          // grant forever and report the AS as merely unreachable.
          await markExpired(tx, row, connectionId, error.code);
          deps.logger.warn("oauth.refresh_rejected", {
            fields: { connectionId, reason: error.code },
          });
          return { kind: "fail", error: errors.oauthNotConnected() };
        }
        if (error instanceof RuntimeApiError) {
          // TRANSIENT by construction: the AS timed out, answered 5xx, or the
          // egress guard refused the hop — none of which is the AS disowning
          // the grant, and none of which spent the refresh token. Persist
          // NOTHING (a status write here bricks the grant on the gate above)
          // and hand the typed error back: the next demand retries with the
          // still-valid refresh material. Only `invalid_grant` is terminal.
          deps.logger.warn("oauth.refresh_failed", {
            fields: { connectionId, reason: error.code, terminal: false },
          });
          return { kind: "fail", error };
        }
        throw error;
      }

      // Persist rotation: always the new access token; the refresh token only
      // when the AS returned one (rotating ASes) — otherwise the old one
      // remains valid and stays.
      const expiresAt =
        refreshed.expires_in !== undefined
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null;
      await tx
        .update(schema.connectionOauth)
        .set({
          accessTokenEncrypted: JSON.stringify(
            encryptSecret(
              refreshed.access_token,
              masterKey,
              connectionOauthAad("access_token", row.id),
            ),
          ),
          accessTokenExpiresAt: expiresAt,
          ...(refreshed.refresh_token !== undefined
            ? {
                refreshTokenEncrypted: JSON.stringify(
                  encryptSecret(
                    refreshed.refresh_token,
                    masterKey,
                    connectionOauthAad("refresh_token", row.id),
                  ),
                ),
              }
            : {}),
        })
        .where(eq(schema.connectionOauth.id, row.id));
      deps.logger.info("oauth.token_refreshed", {
        fields: { connectionId },
      });
      return {
        kind: "ok",
        token: refreshed.access_token,
        expiresAt: expiresAt ?? new Date(Date.now() + NO_EXPIRY_ADVISORY_TTL_MS),
      };
    },
  );

  if (outcome.kind === "fail") throw outcome.error;
  return { token: outcome.token, expiresAt: outcome.expiresAt };
}

/** Transaction client — what `db.transaction` hands the callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Grant is dead: row → `expired`, connection health → `auth_required`.
 *
 * `auth_required`, NOT `auth_error`. The two are not decoration — they are the
 * difference between "reconnect this" and "the server rejected your token", and
 * the probe already classifies an unusable grant as `auth_required`
 * (probe/service.ts). Writing `auth_error` here contradicted that between the
 * failed refresh and the next probe, which is the exact confusion that made the
 * original bug so hard to read.
 *
 * `reason` is a vocabulary code (oauth/error-codes.ts), never provider text.
 */
async function markExpired(
  tx: Tx,
  row: OauthRow,
  connectionId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(schema.connectionOauth)
    .set({ status: "expired", lastErrorCode: reason })
    .where(eq(schema.connectionOauth.id, row.id));
  await tx
    .update(schema.connections)
    .set({
      health: "auth_required",
      lastError: "OAuth grant expired — reconnect the connection",
    })
    .where(eq(schema.connections.id, connectionId));
}

// ── refresh grant ────────────────────────────────────────────────────────────

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().nonnegative().optional(),
  refresh_token: z.string().min(1).optional(),
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * RFC 6749 §5.2 error body. The string is UNTRUSTED and deliberately typed
 * loosely here — `providerErrorCode` is what narrows it to the vocabulary; no
 * caller may interpolate `error` directly.
 */
const tokenErrorSchema = z.object({ error: z.string().min(1) });

/** Token responses are small JSON; anything past this is discarded. */
const MAX_TOKEN_BODY_BYTES = 262_144;

/**
 * Internal marker: the AS disowned the grant or its client identity, so the
 * failure is TERMINAL and retrying spends nothing but the row lock. Carries the
 * vocabulary code (see `oauth/error-codes.ts`) so the row can record WHY it
 * retired — `invalid_grant` is the common case, but `invalid_client`,
 * `unauthorized_client`, `unsupported_grant_type` and `invalid_scope` are just
 * as permanent, and were previously misfiled as transient and retried forever.
 */
class RefreshTerminalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`refresh rejected: ${code}`);
    this.code = code;
  }
}

interface RefreshInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  resource: string | null;
}

/**
 * `grant_type=refresh_token` against the discovered token endpoint. Throws
 * `RefreshInvalidGrantError` on the AS's terminal rejection, or typed
 * `oauth_exchange_failed` (no OAuth values in the message) on anything else.
 */
async function refreshGrant(
  deps: TokenLifecycleDeps,
  input: RefreshInput,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
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
    const raw = parsedError.success ? parsedError.data.error : null;
    if (isTerminalTokenError(raw)) {
      throw new RefreshTerminalError(providerErrorCode(raw) as string);
    }
    // Only a code from the CLOSED vocabulary reaches the message. This request
    // carried the refresh token, so an unrecognised `error` may BE that token
    // echoed back — and this message is persisted to `connections.last_error`
    // and returned in the DTO (oauth/error-codes.ts).
    throw errors.oauthExchangeFailed(describeProviderFailure(res.status, raw));
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw errors.oauthExchangeFailed(
      "token response is missing an access_token",
    );
  }
  return parsed.data;
}

// ── revocation ───────────────────────────────────────────────────────────────

/**
 * RFC 7009 best-effort revocation for the mutation transitions (spec §6):
 * auth-type change off oauth, custom URL change, connection delete. Revokes
 * the refresh token when one exists (the AS SHOULD cascade to its access
 * tokens), else the access token. Every failure — no endpoint, undecryptable
 * envelope, egress refusal, AS error — is swallowed and logged at debug: the
 * caller's mutation must never hinge on a third party's revocation endpoint.
 */
export async function revokeBestEffort(
  deps: TokenLifecycleDeps,
  row: OauthRow,
): Promise<void> {
  if (row.revocationEndpoint === null) return;
  if (deps.masterKey === undefined) return;
  try {
    let token: string;
    let hint: "refresh_token" | "access_token";
    if (row.refreshTokenEncrypted !== null) {
      token = decryptRowSecret(
        row.refreshTokenEncrypted,
        deps.masterKey,
        "refresh_token",
        row.id,
        row.connectionId,
      );
      hint = "refresh_token";
    } else if (row.accessTokenEncrypted !== null) {
      token = decryptRowSecret(
        row.accessTokenEncrypted,
        deps.masterKey,
        "access_token",
        row.id,
        row.connectionId,
      );
      hint = "access_token";
    } else {
      return; // nothing to revoke
    }
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: row.clientId ?? clientMetadataUrl(deps.publicAppUrl),
    });
    if (row.clientSecretEncrypted !== null) {
      body.set(
        "client_secret",
        decryptRowSecret(
          row.clientSecretEncrypted,
          deps.masterKey,
          "client_secret",
          row.id,
          row.connectionId,
        ),
      );
    }
    const res = await deps.fetchImpl(row.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    void res.body?.cancel().catch(() => {});
    deps.logger.debug("oauth.revoked", {
      fields: { connectionId: row.connectionId, status: res.status },
    });
  } catch (error) {
    deps.logger.debug("oauth.revoke_failed", {
      fields: { connectionId: row.connectionId },
      err: error,
    });
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function decryptRowSecret(
  serialized: string,
  masterKey: MasterKey,
  column: "access_token" | "refresh_token" | "client_secret",
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

/**
 * Best-effort capped JSON body read: `null` on no body, oversize, or
 * non-JSON — callers surface typed errors; the body is never quoted back.
 * (Deliberately a module-local copy, like broker.ts and client-identity.ts.)
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
