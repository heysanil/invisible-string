/**
 * OAuth discovery for MCP connections — MCP authorization (2026-07-28
 * revision) client-side: RFC 9728 protected-resource metadata (path-aware
 * well-knowns, `WWW-Authenticate` pointer preferred), then RFC 8414 / OIDC
 * authorization-server metadata, in spec order (spec §6).
 *
 * Every fetch rides the caller-supplied `fetchImpl` — in production that is
 * Plan 2's guarded egress fetch (`createGuardedFetch`), because a malicious
 * MCP server chooses its own advertised authorization servers (spec §7 SSRF
 * policy). A guard refusal aborts discovery immediately as
 * `OauthDiscoveryError("egress_blocked")` with the `EgressBlockedError` as
 * `cause` — probing further paths on a forbidden origin would only hide the
 * refusal.
 *
 * Metadata documents are size-capped independently of the guard's response
 * cap (they are small JSON documents; anything oversized is discarded).
 * Results are not cached — discovery runs are rare (connect/reconnect), and
 * callers persist what they need on `connection_oauth`.
 *
 * No OAuth secret material exists at discovery time; error messages carry
 * URLs only.
 *
 * Failure vocabulary (`OauthDiscoveryError.reason`):
 * - `invalid_url`              — the MCP URL (or an advertised issuer) is not a URL
 * - `egress_blocked`           — the egress guard refused a discovery fetch
 * - `no_oauth_metadata`        — no protected-resource metadata anywhere:
 *                                this server is not an OAuth resource
 * - `prm_invalid`              — PRM found but unusable (no resource /
 *                                authorization servers)
 * - `as_metadata_unavailable`  — no AS metadata at any well-known variant
 * - `as_metadata_invalid`      — AS metadata unreadable or missing endpoints
 * - `pkce_unsupported`         — AS does not advertise S256 (PKCE is
 *                                mandatory for MCP clients)
 */
import { z } from "zod";

import { EgressBlockedError } from "../net/guarded-fetch";

export interface OauthDiscovery {
  /** Canonical resource identifier from the PRM (the RFC 8707 value). */
  resource: string;
  /** Authorization server issuer, as advertised by the PRM. */
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  clientIdMetadataDocumentSupported?: boolean;
}

/** Typed discovery failure; `reason` values are enumerated in the module doc. */
export class OauthDiscoveryError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string, options?: ErrorOptions) {
    super(message ?? reason, options);
    this.name = "OauthDiscoveryError";
    this.reason = reason;
  }
}

/** Metadata documents are small; anything past this is discarded unread. */
const MAX_METADATA_BYTES = 262_144;

const prmSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

const asMetadataSchema = z.object({
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1).optional(),
  revocation_endpoint: z.string().min(1).optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
});

/**
 * Resolve the full OAuth surface for an MCP server URL:
 *
 * 1. `GET mcpUrl` unauthenticated — a 401's `WWW-Authenticate`
 *    `resource_metadata` pointer wins over well-known probing.
 * 2. PRM well-knowns, path-aware FIRST: for `https://host/some/path` try
 *    `https://host/.well-known/oauth-protected-resource/some/path`, then the
 *    root variant (real servers mount MCP under a path).
 * 3. From the PRM: canonical `resource` + the first `authorization_servers[]`
 *    entry.
 * 4. AS metadata for issuer `https://as/tenant`: RFC 8414 path-inserted →
 *    OIDC path-appended → root variants; first 200 wins.
 * 5. Require `code_challenge_methods_supported` to include `S256`.
 */
export async function discoverOauth(
  mcpUrl: string,
  fetchImpl: typeof fetch,
): Promise<OauthDiscovery> {
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(mcpUrl);
  } catch (cause) {
    throw new OauthDiscoveryError(
      "invalid_url",
      `not a valid MCP URL: ${mcpUrl}`,
      { cause },
    );
  }

  const prm = await discoverProtectedResource(resourceUrl, fetchImpl);
  const authorizationServer = prm.authorization_servers![0]!;
  const { meta, url: metaUrl } = await discoverAsMetadata(
    authorizationServer,
    fetchImpl,
  );

  if (!meta.code_challenge_methods_supported?.includes("S256")) {
    throw new OauthDiscoveryError(
      "pkce_unsupported",
      `authorization server metadata at ${metaUrl} does not advertise S256 code challenges (PKCE is mandatory)`,
    );
  }

  const discovery: OauthDiscovery = {
    resource: prm.resource,
    authorizationServer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
  if (meta.registration_endpoint !== undefined) {
    discovery.registrationEndpoint = meta.registration_endpoint;
  }
  if (meta.revocation_endpoint !== undefined) {
    discovery.revocationEndpoint = meta.revocation_endpoint;
  }
  // The PRM's scopes are what the client should request for THIS resource;
  // the AS-wide list is only a fallback.
  const scopes = prm.scopes_supported ?? meta.scopes_supported;
  if (scopes !== undefined) discovery.scopesSupported = scopes;
  if (meta.client_id_metadata_document_supported !== undefined) {
    discovery.clientIdMetadataDocumentSupported =
      meta.client_id_metadata_document_supported;
  }
  return discovery;
}

type PrmDocument = z.infer<typeof prmSchema>;

async function discoverProtectedResource(
  resourceUrl: URL,
  fetchImpl: typeof fetch,
): Promise<PrmDocument> {
  const candidates: string[] = [];
  const pointer = await challengePointer(resourceUrl, fetchImpl);
  if (pointer !== null) candidates.push(pointer);

  const resourcePath = trimSlashes(resourceUrl.pathname);
  if (resourcePath !== "") {
    candidates.push(
      `${resourceUrl.origin}/.well-known/oauth-protected-resource/${resourcePath}`,
    );
  }
  candidates.push(`${resourceUrl.origin}/.well-known/oauth-protected-resource`);

  let sawDocument = false;
  for (const candidate of dedupe(candidates)) {
    const result = await fetchMetadata(candidate, fetchImpl);
    if (result.status !== "hit") continue; // miss or unreadable: keep probing
    const parsed = prmSchema.safeParse(result.doc);
    if (!parsed.success || !parsed.data.authorization_servers?.length) {
      sawDocument = true;
      continue;
    }
    return parsed.data;
  }

  throw sawDocument
    ? new OauthDiscoveryError(
        "prm_invalid",
        `protected-resource metadata for ${resourceUrl.href} is missing a resource or authorization servers`,
      )
    : new OauthDiscoveryError(
        "no_oauth_metadata",
        `no protected-resource metadata for ${resourceUrl.href} — not an OAuth resource`,
      );
}

type AsMetadata = z.infer<typeof asMetadataSchema>;

async function discoverAsMetadata(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<{ meta: AsMetadata; url: string }> {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch (cause) {
    throw new OauthDiscoveryError(
      "invalid_url",
      `advertised authorization server is not a valid URL`,
      { cause },
    );
  }

  const issuerPath = trimSlashes(issuerUrl.pathname);
  const variants =
    issuerPath !== ""
      ? [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server/${issuerPath}`,
          `${issuerUrl.origin}/${issuerPath}/.well-known/openid-configuration`,
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ]
      : [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ];

  for (const variant of dedupe(variants)) {
    const result = await fetchMetadata(variant, fetchImpl);
    if (result.status === "miss") continue;
    if (result.status === "unreadable") {
      // First 200 wins — a 200 that is not readable JSON is a broken AS,
      // not a reason to keep probing.
      throw new OauthDiscoveryError(
        "as_metadata_invalid",
        `authorization server metadata at ${variant} is not readable JSON`,
        { cause: result.cause },
      );
    }
    const parsed = asMetadataSchema.safeParse(result.doc);
    if (!parsed.success) {
      throw new OauthDiscoveryError(
        "as_metadata_invalid",
        `authorization server metadata at ${variant} is missing required endpoints`,
        { cause: parsed.error },
      );
    }
    return { meta: parsed.data, url: variant };
  }

  throw new OauthDiscoveryError(
    "as_metadata_unavailable",
    `no authorization server metadata for issuer ${issuer}`,
  );
}

/**
 * Unauthenticated GET of the MCP URL itself: on 401, extract the RFC 9728
 * `resource_metadata` pointer from `WWW-Authenticate`. Any other outcome —
 * including plain network failure — falls back to well-known probing; only a
 * guard refusal aborts (the connection URL itself is off-limits).
 */
async function challengePointer(
  resourceUrl: URL,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(resourceUrl.href, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    rethrowIfEgressBlocked(error, resourceUrl.href);
    return null;
  }
  // Only status + headers matter; never read the body (a GET on a streamable
  // MCP endpoint may be an unbounded SSE stream).
  void res.body?.cancel().catch(() => {});
  if (res.status !== 401) return null;
  const header = res.headers.get("www-authenticate");
  if (header === null) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,;]+))/i.exec(
    header,
  );
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || raw === "") return null;
  try {
    return new URL(raw, resourceUrl).href;
  } catch {
    return null;
  }
}

type MetadataFetchResult =
  | { status: "miss" }
  | { status: "hit"; doc: unknown }
  | { status: "unreadable"; cause: unknown };

/**
 * GET one metadata URL. Non-200 (and plain network failure) is a "miss";
 * a 200 whose body is oversized or not JSON is "unreadable"; a guard refusal
 * aborts discovery.
 */
async function fetchMetadata(
  url: string,
  fetchImpl: typeof fetch,
): Promise<MetadataFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    rethrowIfEgressBlocked(error, url);
    return { status: "miss" };
  }
  if (res.status !== 200) {
    void res.body?.cancel().catch(() => {});
    return { status: "miss" };
  }
  try {
    return { status: "hit", doc: await readJsonCapped(res) };
  } catch (cause) {
    return { status: "unreadable", cause };
  }
}

function rethrowIfEgressBlocked(error: unknown, url: string): never | void {
  if (error instanceof EgressBlockedError) {
    throw new OauthDiscoveryError(
      "egress_blocked",
      `egress guard refused discovery fetch of ${url} (${error.reason})`,
      { cause: error },
    );
  }
}

/** Read a JSON body with a hard byte cap (throws past it, or on bad JSON). */
async function readJsonCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("metadata response had no body");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_METADATA_BYTES) {
        throw new Error(
          `metadata document exceeds ${MAX_METADATA_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function trimSlashes(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
