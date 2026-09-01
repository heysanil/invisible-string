/**
 * OAuth consent broker (connectors redesign spec §6): the control plane owns
 * every state transition of an MCP connection's OAuth grant — the SPA only
 * opens URLs.
 *
 * `startOauth` runs discovery, resolves the client identity
 * (operator-configured first, then CIMD, then DCR — oauth/client-identity.ts),
 * then arms a pending flow: a fresh S256 PKCE verifier (envelope-encrypted at
 * rest, AAD-bound to the row), a single-use `state`, the INITIATOR's user id,
 * the issuer the flow expects to hear back from, and — as ONE staged
 * `pending_flow` object — every endpoint and credential the discovery chain
 * produced. All persisted with a 10-minute TTL so the flow survives restarts.
 * A new start SUPERSEDES any prior pending flow.
 *
 * DISCOVERY IS FLOW STATE, NOT GRANT STATE, and that distinction is a
 * security boundary rather than tidiness. The MCP server names its own
 * authorization server, so everything discovery returns is chosen by the
 * party a mix-up attack controls; `connection_oauth.token_endpoint` and
 * `revocation_endpoint` are meanwhile where oauth/tokens.ts replays a live
 * refresh token — with the client secret — for as long as the grant lasts.
 * Writing discovery onto the row at START time therefore let a re-consent
 * that NEVER COMPLETED (a closed popup, a declined consent, even this
 * module's own `iss` rejection) repoint a still-`connected` grant: the next
 * refresh, seconds before expiry, shipped the previous authorization
 * server's refresh token to the endpoint the MCP server had just nominated.
 * The staging below is what closes that: the live columns move only in the
 * write that stores the tokens minted through them (see PROMOTION in
 * `handleCallback`), so a start that ends in anything but a successful
 * exchange leaves the grant byte-identical.
 *
 * The staging covers the CLIENT IDENTITY too, not only the endpoints: a DCR
 * registration minted at a server this connection has not authorized against
 * would otherwise displace the credentials the live tokens were issued to,
 * and the refresh would then present the wrong client to the right endpoint —
 * a grant broken until someone re-consents, from a popup nobody completed.
 * The visible cost is that two abandoned FIRST attempts register twice
 * (nothing persisted the first one), which is deliberate: the start route
 * writing no credential column at all is a far easier invariant to keep than
 * "writes one only when there is no grant to lose". A re-consent of a live
 * grant at the same issuer still reuses its registration untouched.
 *
 * `handleCallback` completes the flow. It is SESSION-BOUND: the popup shares
 * the app's cookies, so the callback requires an authenticated Better Auth
 * session whose user can manage the connection's scope AND is the person who
 * armed the flow — both checked BEFORE the single-use state is claimed or any
 * token exchange runs, so a forwarded callback URL is useless to an outsider
 * (it neither completes nor burns the flow). The claim itself is an atomic
 * compare-and-clear on `pending_state`, making every state single-use even
 * under racing callbacks. The code exchange sends `code_verifier` + the RFC
 * 8707 `resource` and rides the guarded egress fetch (the token endpoint came
 * from server-controlled discovery metadata — spec §7). Tokens land as
 * AES-256-GCM envelopes AAD-bound to the row
 * (`connection_oauth:<column>:<row-id>`), the row goes `connected`, and the
 * post-connect probe fires asynchronously — now carrying the freshly minted
 * access token, which is what turns a consent into a healthy connection with
 * a populated tool cache rather than a permanent 401 (fix plan F1).
 *
 * THE GRANT STATE MACHINE (2026-08-31 fix plan F5/F12) is the part that used
 * to be documented but not implemented, and its two rules pull in opposite
 * directions on the SAME row:
 *
 *  - arming a flow transitions the row to `pending` — EXCEPT when the row is
 *    already `connected`. A re-consent must not downgrade a working grant:
 *    `getAccessToken` gates on `status === "connected"`, so the moment a
 *    reconnect is started every agent tool call and every probe on a
 *    perfectly valid token would begin failing;
 *  - symmetrically, a FAILED or ABANDONED callback lands `error` only when
 *    there was nothing to lose. A user who opens the consent window on a
 *    live connection and closes it again has changed nothing, and must not
 *    find the connection broken afterwards.
 *
 * The second rule is only SAFE because discovery is staged. Keeping a grant
 * `connected` through a failed re-consent keeps `getAccessToken` willing to
 * refresh it, so "has changed nothing" must be literally true of every column
 * that refresh reads — not merely of the two token columns.
 *
 * Every start and callback failure also records a sanitized machine code on
 * `last_error_code` — the typed vocabulary (`oauth_discovery_failed`,
 * `oauth_registration_failed`, …), never a provider message, because that
 * column is read back by a DTO.
 *
 * RFC 9207 (`iss`) is validated on the callback against the issuer the armed
 * flow recorded — the authorization-server mix-up defence (F13). A missing
 * `iss` fails only when the AS advertised that it sends one.
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
  connectorOauthClientIdentity,
  decryptSecret,
  encryptSecret,
  newId,
  type ConnectorCatalogEntry,
  type EncryptedEnvelope,
  type Logger,
  type MasterKey,
  type StartOauthResponse,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { EgressBlockedError } from "../net/guarded-fetch";
import { loadConnectorCatalog } from "../resources/catalog";
import { scopeWhere, type Scope } from "../resources/common";
import type { OauthClientRegistrations } from "../runtime/config";
import { errors, isRuntimeApiError } from "../runtime/errors";
import { describeProviderFailure } from "./error-codes";
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
/** The staged flow shape (`connection_oauth.pending_flow`), never null here. */
type PendingFlow = NonNullable<OauthRow["pendingFlow"]>;
/** The client half of {@link PendingFlow} — what identity resolution stages. */
type StagedClientIdentity = Pick<
  PendingFlow,
  | "clientIdentityMode"
  | "clientId"
  | "clientSecretEncrypted"
  | "clientRegistrationIssuer"
>;

/** Pending consent flows expire 10 minutes after `startOauth` (spec §3). */
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export interface OauthBrokerDeps {
  db: Db;
  masterKey: MasterKey | undefined;
  /**
   * Public CONTROL-PLANE origin, no trailing slash — the SAME config value
   * Slack OAuth uses (integrations/config.ts `publicAppUrlFromEnv`): the
   * OAuth redirect URI and the CIMD client id, both of which name routes this
   * server serves. NOT the popup's postMessage target — see `publicWebUrl`.
   */
  publicAppUrl: string;
  /**
   * Public SPA origin (runtime/config.ts `publicWebUrlFromEnv`, defaulting to
   * `publicAppUrl`): the callback page's postMessage `targetOrigin`.
   *
   * Separate from `publicAppUrl` because the popup's OPENER is the SPA, not
   * this server (fix plan F8). They coincide behind the production gateway
   * and differ in local dev (API :3000, Vite :5173) — and a `targetOrigin`
   * that does not match the receiving window is dropped by the browser with
   * no error at all, so the SPA sees a consent that "never finished".
   */
  publicWebUrl: string;
  /**
   * Guarded egress fetch (net/guarded-fetch.ts) — discovery, DCR, and the
   * token exchange all hit attacker-influencible URLs (spec §7).
   */
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Better Auth session + membership lookups for the session-bound callback. */
  workspaceDeps: WorkspaceDeps;
  /**
   * Operator-supplied OAuth clients by provider key (runtime/config.ts
   * `loadOauthClientRegistrations`), for authorization servers that gate
   * dynamic registration behind an approved-client allowlist (fix plan F2).
   * Absent = none configured, which is every deployment that needs none.
   */
  preregisteredClients?: OauthClientRegistrations;
  /**
   * Test seam mirroring `ResourceDeps.catalog`: overrides the checked-in
   * connector catalog. The broker reads the entry behind
   * `connections.catalog_slug` for its OAuth client-identity declaration —
   * which strategy the provider supports, and the env prefix its
   * operator-supplied credentials are spelled with.
   */
  catalog?: ReadonlyMap<string, ConnectorCatalogEntry>;
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
  try {
    return await armConsentFlow(deps, deps.masterKey, connection, row, userId);
  } catch (error) {
    // F12: a start that dies in discovery or client registration used to
    // leave NOTHING behind — the row kept whatever status it had and the only
    // trace was a 502 the popup swallowed. Record the machine code so the
    // connection surface can say why. Status is deliberately untouched: the
    // flow never armed, so a prior grant (working or not) is exactly as it
    // was, and inventing `error` here would be the F5 mistake one step early.
    // "Exactly as it was" is now literal — `armConsentFlow` writes ONCE, at
    // the end, and everything it discovered up to the failure was held in
    // memory rather than smeared across the row's endpoint columns.
    await recordFailure(deps, row.id, { lastErrorCode: failureCode(error) });
    throw error;
  }
}

/**
 * Discovery → client identity → armed pending flow → authorization URL.
 * Split out so {@link startOauth} can wrap EVERY failure below it in one
 * bookkeeping catch without swallowing the connection/authType 4xx above it.
 */
async function armConsentFlow(
  deps: OauthBrokerDeps,
  masterKey: MasterKey,
  connection: ConnectionRow,
  row: OauthRow,
  userId: string,
): Promise<StartOauthResponse> {
  let discovery: OauthDiscovery;
  try {
    discovery = await discoverOauth(connection.url, deps.fetchImpl);
  } catch (error) {
    if (error instanceof OauthDiscoveryError) {
      throw errors.oauthDiscoveryFailed(error.reason, error.message);
    }
    throw error;
  }

  // What the CONNECTION contributes to client identity: a catalog preset
  // declares which strategy its authorization server actually supports, and
  // the env prefix its operator-supplied credentials are spelled with. A
  // custom or registry connection has no entry and contributes nothing — it
  // can still match an operator client by issuer (runtime/config.ts).
  const entry =
    connection.catalogSlug === null
      ? undefined
      : (deps.catalog ?? loadConnectorCatalog()).get(connection.catalogSlug);
  /** Set by `persistRegistration` below when identity resolution mints or re-keys one. */
  let stagedClient: StagedClientIdentity | null = null;
  const identity = await resolveClientIdentity(
    {
      publicAppUrl: deps.publicAppUrl,
      fetchImpl: deps.fetchImpl,
      masterKey,
      ...(deps.preregisteredClients !== undefined
        ? { preregisteredClients: deps.preregisteredClients }
        : {}),
      // STAGED, not persisted: `resolveClientIdentity` hands back whatever it
      // registered (or re-keyed), and it goes into the armed flow rather than
      // onto the live client columns. Same reason the endpoints do — a
      // registration minted at an authorization server this connection has
      // not actually authorized against must not displace the one the live
      // access/refresh tokens were issued to. The exchange reads it from
      // there; success promotes it (F13, adversarial review).
      persistRegistration: (_rowId, values) => {
        stagedClient = {
          clientIdentityMode: values.clientIdentityMode,
          clientId: values.clientId,
          clientSecretEncrypted: values.clientSecretEncrypted,
          // F13: a client_id is only replayable at the issuer that minted
          // it, so the issuer travels WITH the credentials.
          clientRegistrationIssuer: values.clientRegistrationIssuer,
        };
        return Promise.resolve();
      },
    },
    discovery,
    {
      id: row.id,
      connectionId: connection.id,
      clientId: row.clientId,
      clientSecretEncrypted: row.clientSecretEncrypted,
      clientRegistrationIssuer: row.clientRegistrationIssuer,
      clientIdentityMode: row.clientIdentityMode,
    },
    {
      providerKey:
        entry === undefined
          ? null
          : entry.auth.type === "oauth"
            ? (entry.auth.clientEnvPrefix ?? entry.slug)
            : entry.slug,
      declaredIdentity:
        entry === undefined ? null : connectorOauthClientIdentity(entry.auth),
    },
  );

  // Everything this start learned about the server, as ONE staged object
  // (schema `PendingOauthFlow`). Nothing here touches the live grant: see the
  // module header's "discovery is flow state" rule. When identity resolution
  // reused the row's existing registration it staged nothing, so the staged
  // flow echoes what is already live — which keeps the exchange reading from
  // exactly one place whatever path produced the identity.
  const pendingFlow: PendingFlow = {
    authorizationServer: discovery.authorizationServer,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    resource: discovery.resource,
    revocationEndpoint: discovery.revocationEndpoint ?? null,
    scopes: discovery.scopesSupported ?? null,
    ...(stagedClient ??
      (identity.mode === "cimd"
        ? {
            // CIMD persists nothing by construction: the client id IS the
            // hosted metadata URL, reconstructed from config at every hop.
            clientIdentityMode: "cimd" as const,
            clientId: null,
            clientSecretEncrypted: null,
            clientRegistrationIssuer: null,
          }
        : {
            clientIdentityMode: identity.mode,
            clientId: identity.clientId,
            clientSecretEncrypted: row.clientSecretEncrypted,
            clientRegistrationIssuer: row.clientRegistrationIssuer,
          })),
  };

  // Fresh PKCE verifier (RFC 7636 §4.1 charset via base64url) + single-use
  // state. Persisting BOTH supersedes any prior pending flow atomically —
  // the old state simply no longer matches.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  await deps.db
    .update(schema.connectionOauth)
    .set({
      // F12: arming IS the documented transition to `pending` — except on a
      // grant that already works. A re-consent must leave a `connected` row
      // connected, because `getAccessToken` gates on exactly that value: the
      // moment the popup opens, every agent tool call and every health probe
      // would otherwise start failing on a token that is still valid, and an
      // abandoned reconnect would never put it back.
      ...(row.status === "connected" ? {} : { status: "pending" as const }),
      // Discovery + client identity ride the FLOW, never the grant, until an
      // exchange succeeds — the endpoint columns are what refresh and
      // revocation replay a live refresh token against.
      pendingFlow,
      pendingState: state,
      pendingCodeVerifierEncrypted: JSON.stringify(
        encryptSecret(
          verifier,
          masterKey,
          connectionOauthAad("pending_code_verifier", row.id),
        ),
      ),
      pendingExpiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
      // F15: the flow belongs to the person who started it, not to whichever
      // admin's browser reaches the callback first.
      pendingStartedBy: userId,
      // F13/RFC 9207: the issuer the AS claims for ITSELF (never the PRM's
      // advertisement of it — the PRM is served by the MCP server, the party
      // a mix-up attack controls), plus whether it promises to echo an `iss`.
      expectedIssuer: discovery.issuer,
      issParameterSupported: discovery.issParameterSupported ?? null,
      // A new attempt clears the last one's verdict.
      lastErrorCode: null,
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
      clientIdentityMode: identity.mode,
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
  /**
   * RFC 9207 issuer identifier of the authorization server that produced this
   * response. Checked against the armed flow's `expected_issuer` BEFORE the
   * code is exchanged — the mix-up defence (F13). Attacker-controlled text:
   * compared, never echoed, never logged.
   */
  iss?: string;
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
  /**
   * A flow-level failure: the popup always renders, carrying this code (F9).
   *
   * The rejections BELOW this line and above the exchange — `forbidden`,
   * `not_initiator`, a dead `state` — deliberately record nothing on the row.
   * They are reachable by someone who is not the grant's owner, or by a stale
   * browser tab, and neither should be able to stamp `last_error_code` onto a
   * connection that is working fine. `last_error_code` answers "why did MY
   * last attempt fail", which is a question about the exchange stage and the
   * start route (F12), not about who else has been clicking old links.
   */
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

  // F15 — the flow is bound to its INITIATOR, not merely to the connection.
  // `state` proves "this callback belongs to that connection"; it proves
  // nothing about who is holding it, and the scope check above admits every
  // workspace admin. Without this, admin B's browser can complete (or simply
  // burn) admin A's consent, and `connected_by` then records the wrong person
  // as the grant's owner. Checked BEFORE the claim, exactly like the scope
  // check, so a wrong-admin hit cannot consume the initiator's single-use
  // state. A NULL is tolerated: flows armed before this column existed are
  // still legitimate, and they age out within one OAUTH_PENDING_TTL_MS.
  if (
    oauth.pendingStartedBy !== null &&
    oauth.pendingStartedBy !== session.user.id
  ) {
    deps.logger.warn("oauth.callback_rejected", {
      fields: { reason: "not_initiator", connectionId: connection.id },
    });
    return fail("not_initiator");
  }

  // Atomic single-use claim: compare-and-clear on pending_state. A racing
  // duplicate (or replay) finds nothing to clear and dies here.
  const claimed = await deps.db
    .update(schema.connectionOauth)
    .set({
      pendingState: null,
      pendingCodeVerifierEncrypted: null,
      pendingExpiresAt: null,
      pendingStartedBy: null,
      // The staged flow is single-use exactly like the verifier: `oauth` is
      // the pre-claim snapshot, so the exchange below still has it.
      pendingFlow: null,
    })
    .where(
      and(
        eq(schema.connectionOauth.id, oauth.id),
        eq(schema.connectionOauth.pendingState, state),
      ),
    )
    .returning({
      id: schema.connectionOauth.id,
      updatedAt: schema.connectionOauth.updatedAt,
    });
  if (claimed.length === 0) return fail(errors.oauthStateInvalid().code);
  // Optimistic-concurrency token for the promotion far below. The exchange in
  // between is a NETWORK round trip, and the connection is mutable throughout
  // it: a URL change resets this grant (resources/connections.ts) and an auth
  // -type change deletes the row outright. Without this predicate the
  // promotion's bare `where(id)` would write the finished flow's tokens AND
  // endpoints back onto a row that had since been reset — resurrecting a grant
  // for a server the connection no longer points at, which is a token issued
  // by one authorization server sitting on a row addressed to another. Every
  // write goes through drizzle, whose `$onUpdate` bumps `updated_at`, so any
  // intervening mutation makes this stale and the promotion match zero rows.
  const claimStamp = claimed[0]!.updatedAt;
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
    // F13 — authorization-server mix-up defence (RFC 9207), BEFORE the code
    // goes anywhere: an authorization response minted by a different issuer
    // than the one consent was started against must never have its code
    // presented at our token endpoint. Checked ahead of `query.error` because
    // the parameter rides error responses too, and a foreign response is not
    // this flow's business whatever it says.
    const issProblem = issuerProblem(oauth, query.iss);
    if (issProblem !== null) throw errors.oauthExchangeFailed(issProblem);
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
    // THE armed flow's own material. `pending_flow` is what this start
    // discovered and staged; the live columns are the fallback for a flow
    // armed before that column existed (they still hold that start's
    // discovery, since the old code wrote it there directly).
    const staged = exchangeMaterial(oauth);
    if (staged.tokenEndpoint === null || oauth.pendingCodeVerifierEncrypted === null) {
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
      staged.clientSecretEncrypted !== null
        ? decryptRowSecret(
            staged.clientSecretEncrypted,
            deps.masterKey,
            "client_secret",
            oauth.id,
            connection.id,
          )
        : null;
    const tokens = await exchangeCode(deps, {
      tokenEndpoint: staged.tokenEndpoint,
      // CIMD identities are never persisted — reconstruct from config.
      clientId: staged.clientId ?? clientMetadataUrl(deps.publicAppUrl),
      clientSecret,
      code,
      verifier,
      resource: staged.resource,
    });
    const promoted = await deps.db
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
        // PROMOTION — the one place the live grant learns where it lives.
        // These endpoints are what the central refresh and RFC 7009
        // revocation replay a still-valid refresh token against months from
        // now, so they land here and nowhere else: paired, in the same write,
        // with the tokens that were actually minted through them. A start
        // that discovers a different authorization server and then never
        // completes has therefore changed nothing at all. (Null when the flow
        // predates `pending_flow`; those rows already hold their own start's
        // discovery on these columns, so leaving them is correct.)
        ...(oauth.pendingFlow !== null
          ? {
              authorizationServer: oauth.pendingFlow.authorizationServer,
              authorizationEndpoint: oauth.pendingFlow.authorizationEndpoint,
              tokenEndpoint: oauth.pendingFlow.tokenEndpoint,
              resource: oauth.pendingFlow.resource,
              revocationEndpoint: oauth.pendingFlow.revocationEndpoint,
              clientIdentityMode: oauth.pendingFlow.clientIdentityMode,
              clientId: oauth.pendingFlow.clientId,
              clientSecretEncrypted: oauth.pendingFlow.clientSecretEncrypted,
              clientRegistrationIssuer:
                oauth.pendingFlow.clientRegistrationIssuer,
            }
          : {}),
        // Granted scopes when the AS reported them, else the ones this flow
        // asked for — never a leftover from the grant being replaced.
        ...(tokens.scope !== undefined
          ? { scopes: tokens.scope.split(/\s+/).filter((s) => s.length > 0) }
          : oauth.pendingFlow !== null
            ? { scopes: oauth.pendingFlow.scopes }
            : {}),
        status: "connected",
        connectedBy: session.user.id,
        // The attempt succeeded — the last one's verdict is history.
        lastErrorCode: null,
      })
      .where(
        and(
          eq(schema.connectionOauth.id, oauth.id),
          eq(schema.connectionOauth.updatedAt, claimStamp),
        ),
      )
      .returning({ id: schema.connectionOauth.id });
    if (promoted.length === 0) {
      // The connection was mutated (or deleted) while we were at the token
      // endpoint. The tokens we just minted belong to a configuration that no
      // longer exists, so they are DISCARDED rather than written: never
      // persist a credential against a row whose url or auth mode has moved.
      // Revocation is best-effort and deliberately not attempted here — the
      // endpoints to revoke at went with the row.
      deps.logger.warn("oauth.callback_superseded", {
        fields: { connectionId: connection.id },
      });
      return fail("oauth_flow_superseded");
    }
  } catch (error) {
    // F5 — `status: error` is right only when the flow had nothing to lose.
    // A first consent, or a re-consent of an expired/errored grant, really is
    // broken and should say so. A re-consent of a LIVE grant is not: closing
    // the consent window, or an authorization server having a bad minute,
    // would otherwise brick a connection whose access and refresh tokens are
    // untouched and still valid — `getAccessToken` gates on `connected`, so
    // every agent tool call and every probe would start failing over a window
    // the user merely dismissed. `oauth` is the PRE-claim snapshot and
    // nothing above this line writes `status`, so it is the honest witness.
    const hadUsableGrant =
      oauth.status === "connected" && oauth.accessTokenEncrypted !== null;
    // Same supersession guard as the promotion: bookkeeping a failure onto a
    // row that has since been reset would stamp a stale verdict (and possibly
    // `status: "error"`) onto a grant this flow no longer describes.
    await recordFailure(
      deps,
      oauth.id,
      {
        ...(hadUsableGrant ? {} : { status: "error" as const }),
        lastErrorCode: failureCode(error),
      },
      claimStamp,
    );
    if (isRuntimeApiError(error)) {
      // The message stays server-side; the popup only learns the code.
      deps.logger.warn("oauth.callback_failed", {
        fields: {
          reason: error.code,
          connectionId: connection.id,
          grantRetained: hadUsableGrant,
        },
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
 * The minimal popup page: posts `{type:"mcp-oauth", ok, connectionId, reason}`
 * to the opener with `targetOrigin` pinned to a real origin (never `*`), then
 * closes. Values are JSON-embedded with `<` escaped so no query-derived text
 * can break out of the script context.
 *
 * `targetOrigin` must be the SPA's origin — `OauthBrokerDeps.publicWebUrl`,
 * NOT `publicAppUrl` (F8). They are the same string behind the production
 * gateway and different in local dev, and a mismatch is silent: the browser
 * drops the message with no error, no exception and nothing in devtools.
 *
 * `reason` is the sanitized machine code (F9). Without it the SPA can only
 * render "something went wrong" for a declined consent, a dead state, a
 * wrong-admin callback and a registration the provider refuses — four
 * different user actions with four different recoveries. It is a CODE from
 * this module's own vocabulary (`unauthenticated`, `forbidden`,
 * `not_initiator`, plus the typed `oauth_*` errors), never a provider string.
 */
export function renderCallbackPage(
  outcome: CallbackOutcome,
  targetOrigin: string,
): string {
  const payload = {
    type: "mcp-oauth" as const,
    ok: outcome.ok,
    connectionId: outcome.ok ? outcome.connectionId : (outcome.connectionId ?? null),
    reason: outcome.ok ? null : sanitizeReasonCode(outcome.reason),
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

/**
 * RFC 6749 §5.2 error body. UNTRUSTED — narrowed by `providerErrorCode`, never
 * interpolated directly (oauth/error-codes.ts).
 */
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

/**
 * Redeem the authorization code. Throws `oauth_exchange_failed` (typed, no
 * OAuth values in the message) on any rejection.
 *
 * A client secret goes in the BODY (`client_secret_post`), which is also what
 * the refresh does (oauth/tokens.ts). `resolveClientIdentity` can negotiate
 * `client_secret_basic`, but nothing persists the negotiated method — the
 * exchange runs in a later request than the start that resolved it, and there
 * is no column — so both hops derive it the same way, from the secret's mere
 * presence. Supporting Basic end to end means adding a
 * `token_endpoint_auth_method` column, not a special case here that the
 * refresh would then contradict.
 */
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
    // Vocabulary codes only: this request carried the authorization code and
    // the client secret, so an unrecognised `error` may be either of them
    // reflected back (oauth/error-codes.ts).
    throw errors.oauthExchangeFailed(
      describeProviderFailure(
        res.status,
        parsedError.success ? parsedError.data.error : null,
      ),
    );
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
 * The machine code that reaches `connection_oauth.last_error_code` and the
 * popup payload. Both are read back by the SPA, so this is a VOCABULARY, not
 * a message: `[a-z][a-z0-9_]*`, ≤64 chars, and anything else collapses to one
 * flat code rather than being echoed. No provider text, no OAuth value, and
 * no attacker-chosen string can pass through it.
 */
function sanitizeReasonCode(code: string): string {
  const trimmed = code.trim().slice(0, 64);
  return /^[a-z][a-z0-9_]*$/.test(trimmed) ? trimmed : "oauth_internal_error";
}

/** Typed errors carry the vocabulary; anything else is infrastructure. */
function failureCode(error: unknown): string {
  return isRuntimeApiError(error)
    ? sanitizeReasonCode(error.code)
    : "oauth_internal_error";
}

/**
 * Best-effort failure bookkeeping (F12). Deliberately swallows its own write
 * failure: the flow has already failed and the caller is about to report a
 * real error or render the popup page — a DB hiccup in the audit trail must
 * not replace that with a 500, nor mask what actually went wrong.
 */
async function recordFailure(
  deps: OauthBrokerDeps,
  rowId: string,
  patch: Partial<typeof schema.connectionOauth.$inferInsert>,
  /**
   * Optional optimistic-concurrency token. When supplied, the write applies
   * only while the row is still the one the caller claimed — a callback that
   * lost its race to a URL or auth-mode change must not stamp its verdict onto
   * the grant that replaced it.
   */
  expectedUpdatedAt?: Date,
): Promise<void> {
  try {
    await deps.db
      .update(schema.connectionOauth)
      .set(patch)
      .where(
        expectedUpdatedAt === undefined
          ? eq(schema.connectionOauth.id, rowId)
          : and(
              eq(schema.connectionOauth.id, rowId),
              eq(schema.connectionOauth.updatedAt, expectedUpdatedAt),
            ),
      );
  } catch (error) {
    deps.logger.warn("oauth.failure_record_failed", {
      fields: { oauthRowId: rowId },
      err: error,
    });
  }
}

/**
 * What the code exchange authenticates and dials with, read from the flow the
 * callback is completing rather than from the live grant.
 *
 * The fallback is for rows armed before `pending_flow` existed: the old start
 * wrote its discovery straight onto the grant columns, so those columns ARE
 * that flow's material and reading them keeps an in-flight consent completable
 * across the deploy. It is a compatibility path with a natural expiry — one
 * `OAUTH_PENDING_TTL_MS` — not a second supported shape.
 *
 * Note the client half is taken WHOLE from whichever side answers: mixing a
 * staged `client_id` with a live `client_secret_encrypted` would pair
 * credentials from two different registrations, and under CIMD a null
 * `clientId` MEANS "the hosted metadata URL", not "look at the other column".
 */
function exchangeMaterial(oauth: OauthRow): {
  tokenEndpoint: string | null;
  resource: string | null;
  clientId: string | null;
  clientSecretEncrypted: string | null;
} {
  const staged = oauth.pendingFlow;
  if (staged !== null) {
    return {
      tokenEndpoint: staged.tokenEndpoint,
      resource: staged.resource,
      clientId: staged.clientId,
      clientSecretEncrypted: staged.clientSecretEncrypted,
    };
  }
  return {
    tokenEndpoint: oauth.tokenEndpoint,
    resource: oauth.resource,
    clientId: oauth.clientId,
    clientSecretEncrypted: oauth.clientSecretEncrypted,
  };
}

/**
 * RFC 9207 check for a callback against its armed flow — null when the
 * response is acceptable, else the (value-free) reason it is not.
 *
 * Three cases, and the middle one is the subtle one: a MISSING `iss` fails
 * only when the authorization server advertised
 * `authorization_response_iss_parameter_supported`. Most servers send none,
 * so requiring it unconditionally would break every conformant flow; ignoring
 * it where it was promised would let an attacker strip the parameter and
 * defeat the check by omission.
 *
 * A null `expected_issuer` means the flow was armed before this column
 * existed — there is nothing to compare against, and the state's own single
 * use plus PKCE still bind the exchange.
 */
function issuerProblem(
  oauth: OauthRow,
  presented: string | undefined,
): string | null {
  const expected = oauth.expectedIssuer;
  if (expected === null) return null;
  const value = presented?.trim() ?? "";
  if (value === "") {
    return oauth.issParameterSupported === true
      ? "the authorization response omitted the issuer identifier this authorization server advertises it sends"
      : null;
  }
  return canonicalIssuer(value) === canonicalIssuer(expected)
    ? null
    : "the authorization response came from a different authorization server than consent was started against";
}

/**
 * RFC 8414 issuer identifiers compare as exact strings, so normalize first:
 * origin + path, no trailing slash, no query/fragment (the path matters — one
 * host can serve several tenant issuers). Mirrors the private helpers in
 * oauth/client-identity.ts and runtime/config.ts; all three must agree, since
 * a value stored by one is compared by another.
 */
function canonicalIssuer(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed; // not a URL: compare verbatim rather than invent one
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
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
