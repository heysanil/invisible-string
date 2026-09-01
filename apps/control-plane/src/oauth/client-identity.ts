/**
 * OAuth client identity for the MCP broker (connectors redesign spec §6, as
 * amended by the 2026-08-31 OAuth fix plan §P2/F13): operator-supplied
 * PRE-REGISTERED client first, then CIMD, then a stored RFC 7591 registration
 * (only at the issuer that minted it), then a fresh registration.
 *
 * PRE-REGISTERED (fix plan P2 option b) wins over both dynamic strategies, and
 * not merely by preference: an operator who configured a `client_id` for a
 * provider is stating that its authorization server accepts nothing else.
 * Some ASes gate registration behind an approved-client allowlist and reject
 * every DCR body — Vercel's `registration_endpoint` answers
 * `400 invalid_redirect_uri` to any redirect URI it has not approved (F2,
 * reproduced live), which surfaced as a 502 behind an already-open consent
 * popup. Credentials come from `MCP_OAUTH_<PREFIX>_CLIENT_ID` /
 * `_CLIENT_SECRET` / `_ISSUER` (runtime/config.ts `loadOauthClientRegistrations`,
 * spelled by the catalog entry's own `clientEnvPrefix`), and a catalog entry
 * that DECLARES `clientIdentity: "preregistered"` with nothing configured
 * fails fast naming its variables rather than POSTing a registration that
 * cannot be accepted.
 *
 * CIMD (client-ID metadata documents, MCP authorization 2026-07-28): when the
 * platform's public base URL is public https AND the authorization server
 * advertises `client_id_metadata_document_supported`, our client_id IS the
 * URL of the hosted metadata document
 * (`GET /integrations/mcp-oauth/client-metadata.json`, served by
 * integrations/routes.ts from the SAME base-URL config Slack OAuth uses).
 * No secret exists and nothing is persisted — every connection shares the one
 * stable identity per deployment.
 *
 * Otherwise DCR: POST the discovered `registration_endpoint` as a public
 * client (`token_endpoint_auth_method: "none"` preferred — some ASes issue a
 * secret anyway and we keep it), persist `client_id` + the envelope-encrypted
 * secret on the `connection_oauth` row, and reuse that registration on every
 * later start.
 *
 * F13 — a stored registration is KEYED BY ISSUER. A `client_id` is issued BY
 * one authorization server and means nothing to another, so reuse is gated on
 * `connection_oauth.client_registration_issuer` still matching the issuer
 * discovery resolved (compared canonically: origin + path, no trailing
 * slash). A server that migrated its AS re-registers and recovers, instead of
 * replaying a stale client — and a compromised MCP server that repoints
 * discovery at an AS of its choosing is never handed the client secret the
 * previous one issued. An UNRECORDED issuer (rows written before the column
 * existed) is reused and backfilled, deliberately: it is not evidence of a
 * CHANGED issuer, and re-registering there would mint a new `client_id` over
 * the one the row's live access/refresh tokens were issued to, killing a
 * working grant to fix a hypothetical one.
 *
 * Every strategy reports the `token_endpoint_auth_method` it authenticates
 * with, so the token exchange stops assuming `none`: the DCR request asks for
 * a method the AS advertises (preferring a public client), and whatever the
 * registration RESPONSE assigns wins over what was asked. Nothing persists the
 * method — there is no column for it — so a later refresh re-derives it from
 * the stored secret's presence (`client_secret_post`).
 *
 * The registration POST rides the caller-supplied fetch — in production Plan
 * 2's guarded egress fetch, because the registration endpoint comes from
 * server-controlled discovery metadata (spec §7 SSRF policy). No OAuth value
 * ever reaches a log line or error message: registration failures carry the
 * HTTP status and the RFC 7591 `error` code at most, never a response body,
 * and the client secret exists in plaintext only inside function scope. An
 * operator-configured secret is held the same way — read from config, encrypted
 * into the row's AAD-bound envelope, never logged and never returned in a DTO;
 * a missing-configuration error names VARIABLES, never values.
 */
import {
  decryptSecret,
  encryptSecret,
  preregisteredClientEnvVars,
  type ConnectorOauthClientIdentity,
  type EncryptedEnvelope,
  type MasterKey,
} from "@invisible-string/shared";
import { z } from "zod";

import { EgressBlockedError, isForbiddenIp } from "../net/guarded-fetch";
import {
  findOauthClientRegistration,
  type OauthClientRegistrations,
} from "../runtime/config";
import { errors } from "../runtime/errors";
import { describeProviderFailure } from "./error-codes";
import type { OauthDiscovery } from "./discovery";

/** `client_name` used for both the CIMD document and DCR requests. */
export const OAUTH_CLIENT_NAME = "Invisible String";

/** The broker's redirect URI (Task 5's callback route) under a base URL. */
export function mcpOauthRedirectUri(publicAppUrl: string): string {
  return `${publicAppUrl}/integrations/mcp-oauth/callback`;
}

/** Where the CIMD document is hosted — with CIMD this URL IS the client_id. */
export function clientMetadataUrl(publicAppUrl: string): string {
  return `${publicAppUrl}/integrations/mcp-oauth/client-metadata.json`;
}

/**
 * The static CIMD document: the same identity DCR registers, with `client_id`
 * set to the document's own URL (the CIMD contract). The DCR body carries two
 * things this cannot — `application_type`, and a negotiated
 * `token_endpoint_auth_method` — because a CIMD client is public by
 * construction (no secret exists to authenticate with).
 */
export function buildClientMetadataDocument(publicAppUrl: string): {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
} {
  return {
    client_id: clientMetadataUrl(publicAppUrl),
    client_name: OAUTH_CLIENT_NAME,
    redirect_uris: [mcpOauthRedirectUri(publicAppUrl)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * AAD context for `connection_oauth` envelopes — the Plan 3 constraint
 * `connection_oauth:<column>:<row-id>`, with the `_encrypted` suffix dropped
 * to match the `connections:auth_config:<id>` precedent
 * (resources/mcp-crypto.ts). The column union covers every encrypted column
 * on the row so Tasks 5–6 (verifier, tokens) share one binding convention.
 */
export function connectionOauthAad(
  column:
    | "client_secret"
    | "access_token"
    | "refresh_token"
    | "pending_code_verifier",
  rowId: string,
): string {
  return `connection_oauth:${column}:${rowId}`;
}

/**
 * Is this base URL usable as a CIMD client id? The AS must be able to fetch
 * it from the open internet, so: https only, and the host must not be
 * localhost or a forbidden (private/loopback/link-local) IP literal. Names
 * that RESOLVE privately are the egress guard's concern, not identity
 * selection's — the AS, not us, dials this URL.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (isIpLiteral && isForbiddenIp(host)) return false;
  return true;
}

/**
 * How the identity in hand was obtained — mirrors the
 * `connection_oauth.client_identity_mode` enum so the broker can record it
 * verbatim. `cimd` is never persisted (there is nothing to store).
 */
export type ClientIdentityMode = "cimd" | "dcr" | "preregistered";

/**
 * The `token_endpoint_auth_method`s this broker can actually execute, in
 * preference order: a public client first (no secret to hold), then the two
 * shared-secret forms. Anything else an AS may advertise (`private_key_jwt`,
 * mTLS…) is out of reach and is never requested.
 */
const EXECUTABLE_AUTH_METHODS = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;
export type ClientAuthMethod = (typeof EXECUTABLE_AUTH_METHODS)[number];

/** What a resolved identity asks the row to record. */
export interface PersistedClientRegistration {
  clientId: string;
  /**
   * Envelope-encrypted secret, or null — which also CLEARS a stale one, so a
   * row that switches strategies never keeps a secret from the old client.
   */
  clientSecretEncrypted: string | null;
  /** `connection_oauth.client_identity_mode` — `cimd` never reaches here. */
  clientIdentityMode: Exclude<ClientIdentityMode, "cimd">;
  /** `connection_oauth.client_registration_issuer`, canonicalized (F13). */
  clientRegistrationIssuer: string;
}

export interface ClientIdentityDeps {
  /**
   * Public app origin, no trailing slash — the SAME config value Slack OAuth
   * builds its redirect URI from (integrations/config.ts `publicAppUrl`).
   */
  publicAppUrl: string;
  /** Outbound HTTP — production passes Plan 2's guarded egress fetch. */
  fetchImpl: typeof fetch;
  /** Envelope master key; required when a registration returns a secret. */
  masterKey: MasterKey | undefined;
  /**
   * Operator-supplied OAuth clients, keyed by provider
   * (runtime/config.ts `loadOauthClientRegistrations`, loaded once at boot).
   * Absent means none are configured — the pre-registered strategy is then
   * simply not on offer, which is every deployment that needs none.
   */
  preregisteredClients?: OauthClientRegistrations;
  /**
   * Persist the resolved identity onto its `connection_oauth` row. Called for
   * every persisted strategy — a fresh DCR registration, a pre-registered
   * client, and the one-time issuer backfill of a pre-F13 row.
   */
  persistRegistration(
    rowId: string,
    values: PersistedClientRegistration,
  ): Promise<void>;
}

/** The `connection_oauth` columns client identity reads (row-compatible). */
export interface ClientRegistrationRow {
  id: string;
  connectionId: string;
  clientId: string | null;
  clientSecretEncrypted: string | null;
  /**
   * `connection_oauth.client_registration_issuer` — the AS that minted the
   * stored credentials, or null on a row written before the column existed
   * (reused and backfilled; see the module doc). Optional so a caller that
   * has not been taught issuer keying still compiles — it then behaves like a
   * legacy row on every start, which is the safe degradation, not the
   * intended one.
   */
  clientRegistrationIssuer?: string | null;
  /** `connection_oauth.client_identity_mode`, when the caller reads it. */
  clientIdentityMode?: ClientIdentityMode | null;
}

export interface ResolvedClientIdentity {
  clientId: string;
  /** Plaintext secret for the immediate token exchange — never persist as-is. */
  clientSecret: string | null;
  /** True when the identity lives on the row; false for ephemeral CIMD. */
  persisted: boolean;
  /** Which strategy produced it (the `client_identity_mode` to record). */
  mode: ClientIdentityMode;
  /**
   * How the token endpoint expects this client to authenticate. `none` and
   * `client_secret_post` are the request body; `client_secret_basic` is the
   * HTTP Basic header — a caller that only ever posts `client_secret` will
   * be rejected by an AS that registered us for Basic.
   */
  tokenEndpointAuthMethod: ClientAuthMethod;
}

/**
 * What the CONNECTION brings to identity selection, as opposed to the
 * deployment (deps) or the grant row. Both fields come from the catalog entry
 * behind `connections.catalog_slug`; a custom or registry connection has
 * neither, and can still match an operator client by issuer.
 */
export interface ClientIdentityContext {
  /**
   * The catalog entry's `clientEnvPrefix` (or its slug) — the lookup key for
   * an operator-supplied client. Case and `-`/`_` are folded by the loader.
   */
  providerKey?: string | null;
  /**
   * The catalog entry's declared strategy (`connectorOauthClientIdentity`).
   * `"preregistered"` makes configuration MANDATORY: DCR is known to be
   * unusable there, so an unconfigured deployment fails with a legible error
   * instead of a 502 from the authorization server.
   */
  declaredIdentity?: ConnectorOauthClientIdentity | null;
}

/** No operator clients configured — the overwhelmingly common case. */
const NO_PREREGISTERED_CLIENTS: OauthClientRegistrations = new Map();

/**
 * Resolve the OAuth client identity for one connection, in strict precedence:
 *
 * 1. an operator-supplied PRE-REGISTERED client for this provider (or pinned
 *    to this issuer) — configuration outranks anything we could mint;
 * 2. CIMD, when the AS advertises it and our base URL is publicly fetchable;
 * 3. the row's stored registration, but ONLY at the issuer that minted it;
 * 4. a fresh RFC 7591 registration — unless the catalog declared
 *    `preregistered`, in which case registration is known to be futile and the
 *    missing configuration is reported instead.
 *
 * Note the order that check sits in: a `preregistered` preset whose AS turns
 * out to advertise CIMD, or whose row already holds a working client, keeps
 * connecting. The declaration means "DCR cannot work here", not "nothing but
 * configuration may be used" — and removing the config must not brick a
 * connection that is already authorized.
 */
export async function resolveClientIdentity(
  deps: ClientIdentityDeps,
  discovery: OauthDiscovery,
  row: ClientRegistrationRow,
  context: ClientIdentityContext = {},
): Promise<ResolvedClientIdentity> {
  // The AS metadata's OWN issuer, never the PRM's advertisement of it: the
  // two are equal by discovery's rule 3 (RFC 8414 §3.3), but only this one is
  // served by the authorization server itself and echoed back as the
  // callback's RFC 9207 `iss` — the PRM is served by the MCP server, which is
  // the party a mix-up attack controls.
  const issuer = canonicalIssuer(discovery.issuer);

  const configured = findOauthClientRegistration(
    deps.preregisteredClients ?? NO_PREREGISTERED_CLIENTS,
    {
      key: context.providerKey ?? null,
      issuer,
      // A preset that declares `dynamic` says registration works at this AS;
      // it must not inherit another provider's configured credentials merely
      // because the issuers coincide. Custom/registry connections declare
      // nothing and keep the fallback.
      allowIssuerFallback: context.declaredIdentity !== "dynamic",
    },
  );
  if (configured !== undefined) {
    // Re-persisted on EVERY start rather than only when it looks changed: the
    // row is what refresh and revocation read months later, and a rotated
    // secret must not survive there behind an unchanged client_id.
    await persistIdentity(deps, row, {
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      mode: "preregistered",
      issuer,
    });
    return {
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      persisted: true,
      mode: "preregistered",
      // Config declares no method; a configured secret goes in the body,
      // which is what the exchange has always sent.
      tokenEndpointAuthMethod:
        configured.clientSecret === null ? "none" : "client_secret_post",
    };
  }

  if (
    discovery.clientIdMetadataDocumentSupported === true &&
    isPublicHttpsUrl(deps.publicAppUrl)
  ) {
    return {
      clientId: clientMetadataUrl(deps.publicAppUrl),
      clientSecret: null,
      persisted: false,
      mode: "cimd",
      tokenEndpointAuthMethod: "none",
    };
  }

  if (row.clientId !== null && row.clientId !== "") {
    const recorded =
      row.clientRegistrationIssuer === null ||
      row.clientRegistrationIssuer === undefined ||
      row.clientRegistrationIssuer === ""
        ? null
        : canonicalIssuer(row.clientRegistrationIssuer);
    // A stored client is replayable ONLY where it was minted (F13).
    //
    // An unrecorded issuer used to be treated as "legacy, not foreign" and
    // replayed against whatever issuer discovery had just returned. That is
    // fail-open: a repointed MCP server nominates its own authorization server
    // and is handed the client secret minted for the previous one. Since
    // `pending_flow` staging landed, a replacement identity can be registered
    // without disturbing the live grant, so there is no longer any reason to
    // accept the risk — an unrecorded issuer now falls through to a fresh
    // registration, which is staged and only promoted if consent succeeds.
    if (recorded !== null && recorded === issuer) {
      const clientSecret = decryptStoredClientSecret(row, deps.masterKey);
      const mode: Exclude<ClientIdentityMode, "cimd"> =
        row.clientIdentityMode === "preregistered" ? "preregistered" : "dcr";
      return {
        clientId: row.clientId,
        clientSecret,
        persisted: true,
        mode,
        // No column records the registered method; the secret's presence is
        // the only evidence left by the time a refresh needs it.
        tokenEndpointAuthMethod:
          clientSecret === null ? "none" : "client_secret_post",
      };
    }
  }

  if (context.declaredIdentity === "preregistered") {
    throw errors.oauthRegistrationFailed(
      missingPreregisteredClientDetail(context.providerKey),
    );
  }

  const registered = await registerClient(deps, discovery);
  await persistIdentity(deps, row, {
    clientId: registered.clientId,
    clientSecret: registered.clientSecret,
    mode: "dcr",
    issuer,
  });
  return {
    clientId: registered.clientId,
    clientSecret: registered.clientSecret,
    persisted: true,
    mode: "dcr",
    tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
  };
}

/** Encrypt (or clear) the secret and hand the identity to the row writer. */
async function persistIdentity(
  deps: ClientIdentityDeps,
  row: ClientRegistrationRow,
  identity: {
    clientId: string;
    clientSecret: string | null;
    mode: Exclude<ClientIdentityMode, "cimd">;
    issuer: string;
  },
): Promise<void> {
  let clientSecretEncrypted: string | null = null;
  if (identity.clientSecret !== null) {
    if (deps.masterKey === undefined) throw errors.encryptionKeyMissing();
    clientSecretEncrypted = JSON.stringify(
      encryptSecret(
        identity.clientSecret,
        deps.masterKey,
        connectionOauthAad("client_secret", row.id),
      ),
    );
  }
  await deps.persistRegistration(row.id, {
    clientId: identity.clientId,
    clientSecretEncrypted,
    clientIdentityMode: identity.mode,
    clientRegistrationIssuer: identity.issuer,
  });
}

/**
 * The typed failure for a `preregistered` preset with no credentials. It names
 * the two ENVIRONMENT VARIABLES (never a value) through the catalog's own
 * renderer, so the message cannot drift from the loader's parsing.
 */
function missingPreregisteredClientDetail(
  providerKey: string | null | undefined,
): string {
  const prefix = providerKey?.trim();
  if (!prefix) {
    return "this connector needs an operator-supplied OAuth client (MCP_OAUTH_<PREFIX>_CLIENT_ID) and none is configured";
  }
  const vars = preregisteredClientEnvVars(
    prefix.toUpperCase().replaceAll("-", "_"),
  );
  return `this authorization server does not accept dynamic client registration — set ${vars.clientId} (and ${vars.clientSecret} if the authorization server issued one)`;
}

/**
 * RFC 8414 issuer identifiers are compared as exact strings, so normalize
 * before storing or comparing: origin + path, no trailing slash, no
 * query/fragment (the path matters — one host can serve several tenant
 * issuers). Mirrors `canonicalIssuer` in runtime/config.ts, which normalizes
 * the operator-configured `MCP_OAUTH_<PREFIX>_ISSUER` the same way.
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

// ── DCR (RFC 7591) ───────────────────────────────────────────────────────────

const registrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  /** What the AS ASSIGNED, which need not be what we asked for (RFC 7591 §3.2.1). */
  token_endpoint_auth_method: z.string().min(1).optional(),
});

/**
 * `token_endpoint_auth_methods_supported` as discovery will surface it when
 * `OauthDiscovery` grows the field, read structurally so this module needs no
 * change when that lands. Until then it is absent, the negotiation below
 * yields `none`, and the request body is what it has always been apart from
 * `application_type`.
 */
type DiscoveryWithAuthMethods = OauthDiscovery & {
  tokenEndpointAuthMethodsSupported?: string[];
};

/** The best method BOTH sides can do, preferring a public client. */
function negotiateAuthMethod(discovery: OauthDiscovery): ClientAuthMethod {
  const supported = (discovery as DiscoveryWithAuthMethods)
    .tokenEndpointAuthMethodsSupported;
  if (supported === undefined || supported.length === 0) return "none";
  return EXECUTABLE_AUTH_METHODS.find((m) => supported.includes(m)) ?? "none";
}

/**
 * How the freshly registered client must authenticate. With no secret the only
 * possible answer is `none`; with one, the AS's assignment wins — except when
 * it assigned `none` and issued a secret anyway (see the module doc), where
 * posting the secret is both what the AS most likely wants and what this
 * broker's exchange has always done.
 */
function resolvedAuthMethod(
  assigned: string | undefined,
  clientSecret: string | null,
): ClientAuthMethod {
  if (clientSecret === null) return "none";
  return (
    EXECUTABLE_AUTH_METHODS.find((m) => m === assigned && m !== "none") ??
    "client_secret_post"
  );
}

/**
 * RFC 7591 §3.2.2 error body. UNTRUSTED — narrowed by `providerErrorCode`,
 * never interpolated directly (oauth/error-codes.ts).
 */
const registrationErrorSchema = z.object({ error: z.string().min(1) });

/** Registration responses are small JSON; anything past this is discarded. */
const MAX_REGISTRATION_BODY_BYTES = 262_144;

async function registerClient(
  deps: ClientIdentityDeps,
  discovery: OauthDiscovery,
): Promise<{
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: ClientAuthMethod;
}> {
  const endpoint = discovery.registrationEndpoint;
  if (endpoint === undefined) {
    throw errors.oauthRegistrationFailed(
      "the authorization server offers no registration endpoint and its client-id-metadata-document support is not usable from this deployment",
    );
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_name: OAUTH_CLIENT_NAME,
        redirect_uris: [mcpOauthRedirectUri(deps.publicAppUrl)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: negotiateAuthMethod(discovery),
        // OIDC/RFC 7591 default, but several conforming servers expect it
        // stated: the broker's client IS a web client (a server-side redirect
        // URI on https), and its absence is a plausible rejection cause.
        application_type: "web",
      }),
    });
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      throw errors.oauthRegistrationFailed(
        `egress guard refused the registration endpoint (${error.reason})`,
      );
    }
    throw errors.oauthRegistrationFailed("registration endpoint unreachable");
  }

  const body = await readBodyCapped(res);
  if (res.status !== 200 && res.status !== 201) {
    const parsedError = registrationErrorSchema.safeParse(body);
    // Vocabulary codes only (oauth/error-codes.ts). Registration is the one hop
    // that does NOT carry a credential inbound, but it answers with one, and
    // this message reaches the SPA — so it is held to the same closed set.
    throw errors.oauthRegistrationFailed(
      `the authorization server rejected the registration (${describeProviderFailure(
        res.status,
        parsedError.success ? parsedError.data.error : null,
      )})`,
    );
  }
  const parsed = registrationResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.oauthRegistrationFailed(
      "the registration response is missing a client_id",
    );
  }
  const clientSecret = parsed.data.client_secret ?? null;
  return {
    clientId: parsed.data.client_id,
    clientSecret,
    tokenEndpointAuthMethod: resolvedAuthMethod(
      parsed.data.token_endpoint_auth_method,
      clientSecret,
    ),
  };
}

/**
 * Best-effort capped JSON body read: `null` on no body, oversize, or non-JSON
 * (callers surface their own typed errors; the body is never quoted back).
 */
async function readBodyCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_REGISTRATION_BODY_BYTES) return null;
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

function decryptStoredClientSecret(
  row: ClientRegistrationRow,
  masterKey: MasterKey | undefined,
): string | null {
  if (row.clientSecretEncrypted === null) return null;
  if (masterKey === undefined) throw errors.encryptionKeyMissing();
  try {
    const envelope = JSON.parse(row.clientSecretEncrypted) as EncryptedEnvelope;
    return decryptSecret(
      envelope,
      masterKey,
      connectionOauthAad("client_secret", row.id),
    );
  } catch {
    throw errors.mcpSecretUnavailable(row.connectionId);
  }
}
