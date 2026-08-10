/**
 * OAuth client identity for the MCP broker (connectors redesign spec §6):
 * CIMD-first, RFC 7591 dynamic-client-registration fallback.
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
 * The registration POST rides the caller-supplied fetch — in production Plan
 * 2's guarded egress fetch, because the registration endpoint comes from
 * server-controlled discovery metadata (spec §7 SSRF policy). No OAuth value
 * ever reaches a log line or error message: registration failures carry the
 * HTTP status and the RFC 7591 `error` code at most, never a response body,
 * and the client secret exists in plaintext only inside function scope.
 */
import {
  decryptSecret,
  encryptSecret,
  type EncryptedEnvelope,
  type MasterKey,
} from "@invisible-string/shared";
import { z } from "zod";

import { EgressBlockedError, isForbiddenIp } from "../net/guarded-fetch";
import { errors } from "../runtime/errors";
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
 * The static CIMD document: field-for-field the same identity DCR registers,
 * with `client_id` set to the document's own URL (the CIMD contract).
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
  /** Persist a fresh DCR registration onto its `connection_oauth` row. */
  persistRegistration(
    rowId: string,
    values: { clientId: string; clientSecretEncrypted: string | null },
  ): Promise<void>;
}

/** The `connection_oauth` columns client identity reads (row-compatible). */
export interface ClientRegistrationRow {
  id: string;
  connectionId: string;
  clientId: string | null;
  clientSecretEncrypted: string | null;
}

export interface ResolvedClientIdentity {
  clientId: string;
  /** Plaintext secret for the immediate token exchange — never persist as-is. */
  clientSecret: string | null;
  /** True when the identity lives on the row (DCR); false for ephemeral CIMD. */
  persisted: boolean;
}

/**
 * Resolve the OAuth client identity for one connection: CIMD when usable,
 * else the row's stored DCR registration, else a fresh registration
 * (persisted for reuse).
 */
export async function resolveClientIdentity(
  deps: ClientIdentityDeps,
  discovery: OauthDiscovery,
  row: ClientRegistrationRow,
): Promise<ResolvedClientIdentity> {
  if (
    discovery.clientIdMetadataDocumentSupported === true &&
    isPublicHttpsUrl(deps.publicAppUrl)
  ) {
    return {
      clientId: clientMetadataUrl(deps.publicAppUrl),
      clientSecret: null,
      persisted: false,
    };
  }

  if (row.clientId !== null && row.clientId !== "") {
    return {
      clientId: row.clientId,
      clientSecret: decryptStoredClientSecret(row, deps.masterKey),
      persisted: true,
    };
  }

  const registered = await registerClient(deps, discovery);
  let clientSecretEncrypted: string | null = null;
  if (registered.clientSecret !== null) {
    if (deps.masterKey === undefined) throw errors.encryptionKeyMissing();
    clientSecretEncrypted = JSON.stringify(
      encryptSecret(
        registered.clientSecret,
        deps.masterKey,
        connectionOauthAad("client_secret", row.id),
      ),
    );
  }
  await deps.persistRegistration(row.id, {
    clientId: registered.clientId,
    clientSecretEncrypted,
  });
  return {
    clientId: registered.clientId,
    clientSecret: registered.clientSecret,
    persisted: true,
  };
}

// ── DCR (RFC 7591) ───────────────────────────────────────────────────────────

const registrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
});

/** RFC 7591 §3.2.2 error body — only the machine `error` code is surfaced. */
const registrationErrorSchema = z.object({ error: z.string().min(1) });

/** Registration responses are small JSON; anything past this is discarded. */
const MAX_REGISTRATION_BODY_BYTES = 262_144;

async function registerClient(
  deps: ClientIdentityDeps,
  discovery: OauthDiscovery,
): Promise<{ clientId: string; clientSecret: string | null }> {
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
        token_endpoint_auth_method: "none",
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
    const code = parsedError.success ? `: ${parsedError.data.error}` : "";
    throw errors.oauthRegistrationFailed(
      `the authorization server rejected the registration (HTTP ${res.status}${code})`,
    );
  }
  const parsed = registrationResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.oauthRegistrationFailed(
      "the registration response is missing a client_id",
    );
  }
  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret ?? null,
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
