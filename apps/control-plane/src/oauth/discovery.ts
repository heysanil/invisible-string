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
 * URLs WE constructed only — a value the server supplied is described
 * (scheme, shape) but never quoted back, since discovery failures surface in
 * an API error DTO that the SPA renders.
 *
 * ── Conformance rules this module owns (2026-08-31 OAuth fix plan) ──────────
 *
 * 1. SCHEME (F3/P0.1). Every URL an MCP SERVER hands us — the challenge's
 *    `resource_metadata` pointer, the PRM's `resource` and
 *    `authorization_servers[0]`, and the AS's authorization / token /
 *    registration / revocation endpoints — is parsed and required to be
 *    `https:`, with no embedded credentials and no fragment. This is not
 *    redundant with the guarded egress fetch: the SPA NAVIGATES a popup to
 *    `authorizationEndpoint` (`popup.location.replace`), and that popup is an
 *    `about:blank` window the SPA opened, so it inherits the SPA's origin — a
 *    custom MCP server (one of the three connection sources) advertising a
 *    `javascript:` authorization endpoint would be script execution against
 *    the app origin, on a path no fetch guard ever sees. `http:` is admitted
 *    only under `allowInsecureHttp`, which DEFAULTS to the MCP URL's own
 *    scheme: an `http:` MCP URL is dialable at all only when the guarded
 *    fetch runs with `MCP_PROBE_ALLOW_PRIVATE`, so the dev switch is
 *    inherited rather than re-read, and an https connection can never be
 *    downgraded by its own metadata.
 *
 * 2. SCOPE (F6+F7/P4.1). Precedence is challenge → PRM → nothing. The Bearer
 *    challenge's `scope` is authoritative per the MCP spec (it is the server
 *    saying what THIS request lacked); the PRM's is the resource's own list;
 *    the AS-wide `scopes_supported` is NOT a fallback — asking for every
 *    scope an authorization server happens to advertise globally over-requests
 *    against an unrelated resource. No scope at all is a legitimate outcome:
 *    the parameter is then omitted and the AS applies its default. The one
 *    read of the AS-wide list is `offline_access`: an AS that gates refresh
 *    tokens on that scope issues none without it and the grant dies at first
 *    expiry — but it is appended only to an already-resolved scope set, never
 *    sent alone, because `scope=offline_access` by itself converts an implicit
 *    default grant into an explicit request for no resource access.
 *
 * 3. ISSUER (F13/P4.2). `issuer` is REQUIRED (RFC 8414 §2) and must be the
 *    issuer whose well-known we asked for (§3.3 says identical; the one
 *    tolerance is a lone trailing slash, which changes nothing about which
 *    server is meant). A document describing a different issuer is a MISS,
 *    not a broken AS — probing continues — which is what stops the root
 *    well-known of a multi-tenant host from answering for a tenant issuer.
 *    The metadata's own verbatim `issuer` is returned beside it: that is the
 *    string the AS echoes as the callback's RFC 9207 `iss`, so it is the
 *    string the broker persists as expected.
 *
 * 4. RESOURCE (F14/P4.3). The PRM's `resource` must identify the MCP URL we
 *    asked about: same origin, and the requested path at or below the
 *    resource's path. Ancestry is accepted because a server mounted at
 *    `/mcp` may legitimately publish one root PRM; a different origin is the
 *    audience-injection case (get us to ask an AS for a token bound to
 *    someone else's identifier) and is refused. Trailing slashes are
 *    normalised on BOTH sides — Vercel's root PRM answers
 *    `https://mcp.vercel.com/` for a catalog URL written
 *    `https://mcp.vercel.com`, and a naive string compare would break a
 *    server doing nothing wrong. The value is returned VERBATIM once
 *    validated: the AS matches the exact string its own resource published.
 *
 * Failure vocabulary (`OauthDiscoveryError.reason`):
 * - `invalid_url`              — the MCP URL (or an advertised issuer) is not a URL
 * - `insecure_endpoint`        — a server-supplied URL is one we refuse to
 *                                fetch or navigate to (rule 1)
 * - `egress_blocked`           — the egress guard refused a discovery fetch
 * - `no_oauth_metadata`        — no protected-resource metadata anywhere:
 *                                this server is not an OAuth resource
 * - `prm_invalid`              — PRM found but unusable (no resource /
 *                                authorization servers)
 * - `resource_mismatch`        — PRM found, but its `resource` does not
 *                                identify the MCP URL requested (rule 4)
 * - `as_metadata_unavailable`  — no AS metadata at any well-known variant
 * - `as_metadata_invalid`      — AS metadata unreadable or missing required
 *                                fields (endpoints, `issuer`)
 * - `issuer_mismatch`          — AS metadata found, but every variant
 *                                described a different issuer (rule 3)
 * - `pkce_unsupported`         — AS does not advertise S256 (PKCE is
 *                                mandatory for MCP clients)
 */
import { z } from "zod";

import { EgressBlockedError } from "../net/guarded-fetch";

export interface OauthDiscovery {
  /**
   * Canonical resource identifier from the PRM (the RFC 8707 value),
   * VERIFIED to identify the MCP URL discovery was run for and returned
   * verbatim (rule 4).
   */
  resource: string;
  /** Authorization server issuer, as advertised by the PRM. */
  authorizationServer: string;
  /**
   * The issuer the AS metadata claims for ITSELF, verbatim — equal to
   * `authorizationServer` up to a trailing slash (that equality IS the
   * check), and the value an RFC 9207 callback carries as `iss`.
   */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /**
   * The scopes to REQUEST — resolved by rule 2, NOT the AS-wide
   * advertisement. Absent means: send no `scope` parameter at all.
   */
  scopesSupported?: string[];
  clientIdMetadataDocumentSupported?: boolean;
  /**
   * RFC 9207: the AS promises an `iss` on every authorization response, so
   * the broker can require one on the callback rather than merely check the
   * one it happens to receive.
   */
  issParameterSupported?: boolean;
}

export interface DiscoveryOptions {
  /**
   * Admit plain-`http:` in server-supplied URLs. DEFAULTS to the MCP URL's
   * own scheme (rule 1) — pass it explicitly only to pin the policy, which
   * is what a test wanting the production stance against a loopback fixture
   * needs.
   */
  allowInsecureHttp?: boolean;
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

/** The scope an AS that gates refresh tokens wants asked for by name. */
const OFFLINE_ACCESS = "offline_access";

const prmSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

const asMetadataSchema = z.object({
  // Required by RFC 8414 §2 and the check rule 3 is built on: an optional
  // issuer that is simply absent would silently disable AS mix-up defence.
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1).optional(),
  revocation_endpoint: z.string().min(1).optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

/**
 * Resolve the full OAuth surface for an MCP server URL:
 *
 * 1. `GET mcpUrl` unauthenticated — the 401's `WWW-Authenticate` challenge
 *    supplies both the `resource_metadata` pointer (which wins over
 *    well-known probing) and the authoritative `scope`.
 * 2. PRM well-knowns, path-aware FIRST: for `https://host/some/path` try
 *    `https://host/.well-known/oauth-protected-resource/some/path`, then the
 *    root variant (real servers mount MCP under a path).
 * 3. From the PRM: canonical `resource` (verified against the requested URL)
 *    + the first `authorization_servers[]` entry.
 * 4. AS metadata for issuer `https://as/tenant`: RFC 8414 path-inserted →
 *    OIDC path-appended → root variants; the first 200 whose `issuer` is the
 *    one asked about wins.
 * 5. Require `code_challenge_methods_supported` to include `S256`.
 */
export async function discoverOauth(
  mcpUrl: string,
  fetchImpl: typeof fetch,
  options: DiscoveryOptions = {},
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
  // The MCP URL itself is operator/user-supplied, not server-supplied: the
  // guarded fetch decides whether it may be dialed. What it DOES decide here
  // is the scheme policy applied to everything the server then hands back.
  const allowInsecureHttp =
    options.allowInsecureHttp ?? resourceUrl.protocol === "http:";

  const challenge = await readChallenge(
    resourceUrl,
    fetchImpl,
    allowInsecureHttp,
  );
  const prm = await discoverProtectedResource(
    resourceUrl,
    challenge.resourceMetadata,
    fetchImpl,
    allowInsecureHttp,
  );
  const authorizationServer = prm.authorization_servers![0]!;
  const { meta, url: metaUrl } = await discoverAsMetadata(
    authorizationServer,
    fetchImpl,
    allowInsecureHttp,
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
    issuer: meta.issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
  if (meta.registration_endpoint !== undefined) {
    discovery.registrationEndpoint = meta.registration_endpoint;
  }
  if (meta.revocation_endpoint !== undefined) {
    discovery.revocationEndpoint = meta.revocation_endpoint;
  }
  const scopes = resolveScopes(
    challenge.scope,
    prm.scopes_supported,
    meta.scopes_supported,
  );
  if (scopes !== undefined) discovery.scopesSupported = scopes;
  if (meta.client_id_metadata_document_supported !== undefined) {
    discovery.clientIdMetadataDocumentSupported =
      meta.client_id_metadata_document_supported;
  }
  if (meta.authorization_response_iss_parameter_supported !== undefined) {
    discovery.issParameterSupported =
      meta.authorization_response_iss_parameter_supported;
  }
  return discovery;
}

/**
 * Rule 2 in one place: challenge scope → PRM scope → omit. `asAdvertised` is
 * read for exactly one thing — whether `offline_access` is a scope this AS
 * knows, in which case an already-resolved set asks for it too.
 */
function resolveScopes(
  challengeScope: string[] | null,
  prmScopes: string[] | undefined,
  asAdvertised: string[] | undefined,
): string[] | undefined {
  const chosen =
    challengeScope !== null && challengeScope.length > 0
      ? challengeScope
      : prmScopes !== undefined && prmScopes.length > 0
        ? prmScopes
        : undefined;
  if (chosen === undefined) return undefined;
  if (
    asAdvertised?.includes(OFFLINE_ACCESS) &&
    !chosen.includes(OFFLINE_ACCESS)
  ) {
    return [...chosen, OFFLINE_ACCESS];
  }
  return chosen;
}

type PrmDocument = z.infer<typeof prmSchema>;

/** Why one PRM candidate was unusable — carried so the final error is specific. */
interface Rejection {
  reason: string;
  detail: string;
}

async function discoverProtectedResource(
  resourceUrl: URL,
  pointer: string | null,
  fetchImpl: typeof fetch,
  allowInsecureHttp: boolean,
): Promise<PrmDocument> {
  const candidates: string[] = [];
  if (pointer !== null) candidates.push(pointer);

  const resourcePath = trimSlashes(resourceUrl.pathname);
  if (resourcePath !== "") {
    candidates.push(
      `${resourceUrl.origin}/.well-known/oauth-protected-resource/${resourcePath}`,
    );
  }
  candidates.push(`${resourceUrl.origin}/.well-known/oauth-protected-resource`);

  // A document that fails validation is a MISS, not a verdict: the pointer
  // may be hostile while the well-known beside it is honest, so probing runs
  // to the end and the LAST rejection is what the failure reports.
  let rejection: Rejection | null = null;
  for (const candidate of dedupe(candidates)) {
    const result = await fetchMetadata(candidate, fetchImpl);
    if (result.status !== "hit") continue; // miss or unreadable: keep probing
    const parsed = prmSchema.safeParse(result.doc);
    if (!parsed.success || !parsed.data.authorization_servers?.length) {
      rejection = {
        reason: "prm_invalid",
        detail: `${candidate} is missing a resource or authorization servers`,
      };
      continue;
    }
    const resourceProblem = resourceProblemFor(
      parsed.data.resource,
      resourceUrl,
      allowInsecureHttp,
    );
    if (resourceProblem !== null) {
      rejection = resourceProblem;
      continue;
    }
    const asCheck = checkServerUrl(
      parsed.data.authorization_servers[0]!,
      allowInsecureHttp,
    );
    if (!asCheck.ok) {
      rejection = {
        reason: "insecure_endpoint",
        detail: `${candidate} advertises an unusable authorization server (${asCheck.detail})`,
      };
      continue;
    }
    return parsed.data;
  }

  if (rejection !== null) {
    throw new OauthDiscoveryError(rejection.reason, rejection.detail);
  }
  throw new OauthDiscoveryError(
    "no_oauth_metadata",
    `no protected-resource metadata for ${resourceUrl.href} — not an OAuth resource`,
  );
}

/**
 * Rule 4: does this `resource` identify the URL we asked about? Returns the
 * rejection, or null when it does.
 */
function resourceProblemFor(
  resource: string,
  requested: URL,
  allowInsecureHttp: boolean,
): Rejection | null {
  const check = checkServerUrl(resource, allowInsecureHttp);
  if (!check.ok) {
    return {
      reason: "insecure_endpoint",
      detail: `protected-resource metadata for ${requested.href} declares an unusable resource identifier (${check.detail})`,
    };
  }
  const mismatch: Rejection = {
    reason: "resource_mismatch",
    detail: `protected-resource metadata for ${requested.href} declares a resource identifier that does not identify it`,
  };
  if (check.url.origin !== requested.origin) return mismatch;
  const resourcePath = withoutTrailingSlash(check.url.pathname);
  const requestedPath = withoutTrailingSlash(requested.pathname);
  const covers =
    requestedPath === resourcePath ||
    requestedPath.startsWith(`${resourcePath}/`);
  if (!covers) return mismatch;
  if (check.url.search !== "" && check.url.search !== requested.search) {
    return mismatch;
  }
  return null;
}

type AsMetadata = z.infer<typeof asMetadataSchema>;

async function discoverAsMetadata(
  issuer: string,
  fetchImpl: typeof fetch,
  allowInsecureHttp: boolean,
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

  let mismatchedAt: string | null = null;
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
        `authorization server metadata at ${variant} is missing an issuer or required endpoints`,
        { cause: parsed.error },
      );
    }
    // Rule 3: a document describing SOMEONE ELSE is a miss. The root
    // well-known of a multi-tenant host answering for a tenant issuer is
    // exactly this, and taking it would be the AS mix-up (F13).
    if (!sameIssuer(parsed.data.issuer, issuer, allowInsecureHttp)) {
      mismatchedAt = variant;
      continue;
    }
    requireEndpoints(parsed.data, variant, allowInsecureHttp);
    return { meta: parsed.data, url: variant };
  }

  if (mismatchedAt !== null) {
    throw new OauthDiscoveryError(
      "issuer_mismatch",
      `authorization server metadata at ${mismatchedAt} declares a different issuer than the ${issuer} it was requested for`,
    );
  }
  throw new OauthDiscoveryError(
    "as_metadata_unavailable",
    `no authorization server metadata for issuer ${issuer}`,
  );
}

/**
 * RFC 8414 §3.3 wants the two issuer identifiers identical. The single
 * tolerance is a lone trailing slash: real deployments differ by exactly that
 * character and it changes nothing about which server is meant. Anything
 * else — scheme, host, port, path, a query string (which §2 forbids on an
 * issuer at all) — is a different issuer.
 */
function sameIssuer(
  claimed: string,
  requested: string,
  allowInsecureHttp: boolean,
): boolean {
  const a = checkServerUrl(claimed, allowInsecureHttp);
  const b = checkServerUrl(requested, allowInsecureHttp);
  if (!a.ok || !b.ok) return false;
  if (a.url.search !== "" || b.url.search !== "") return false;
  return (
    a.url.origin === b.url.origin &&
    withoutTrailingSlash(a.url.pathname) ===
      withoutTrailingSlash(b.url.pathname)
  );
}

/**
 * Rule 1 for the four endpoints the broker fetches or the SPA navigates to.
 * A bad endpoint on a document that IS our issuer is fatal (unlike an issuer
 * mismatch, there is nothing better further down the variant list).
 */
function requireEndpoints(
  meta: AsMetadata,
  at: string,
  allowInsecureHttp: boolean,
): void {
  const endpoints: [string, string | undefined][] = [
    ["authorization_endpoint", meta.authorization_endpoint],
    ["token_endpoint", meta.token_endpoint],
    ["registration_endpoint", meta.registration_endpoint],
    ["revocation_endpoint", meta.revocation_endpoint],
  ];
  for (const [label, value] of endpoints) {
    if (value === undefined) continue;
    const check = checkServerUrl(value, allowInsecureHttp);
    if (check.ok) continue;
    throw new OauthDiscoveryError(
      "insecure_endpoint",
      `authorization server metadata at ${at} advertises an unusable ${label} (${check.detail})`,
    );
  }
}

type UrlCheck =
  | { ok: true; url: URL }
  /** Describes the problem WITHOUT quoting the server's value back. */
  | { ok: false; detail: string };

/**
 * Rule 1's single gate for every server-supplied URL. Rejects anything we
 * would not fetch or hand to a browser: a non-http(s) scheme, plain http
 * outside the dev switch, embedded credentials (which read as one host in a
 * popup's URL bar while dialing another), and a fragment (meaningless on an
 * endpoint, forbidden on an identifier).
 */
function checkServerUrl(raw: string, allowInsecureHttp: boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: "not an absolute URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, detail: `scheme "${url.protocol}" is not https` };
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    return { ok: false, detail: "plain http is not https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, detail: "embedded credentials" };
  }
  if (url.hash !== "") return { ok: false, detail: "URL fragment" };
  return { ok: true, url };
}

interface BearerChallenge {
  /** RFC 9728 `resource_metadata` pointer, absolutised, or null. */
  resourceMetadata: string | null;
  /** RFC 6750 `scope`, split on spaces — authoritative per rule 2. */
  scope: string[] | null;
}

/**
 * Unauthenticated GET of the MCP URL itself: on 401, read the Bearer
 * challenge for the RFC 9728 `resource_metadata` pointer AND the `scope` the
 * server says this request lacked. Any other outcome — including plain
 * network failure — falls back to well-known probing with no scope hint;
 * only a guard refusal aborts (the connection URL itself is off-limits).
 */
async function readChallenge(
  resourceUrl: URL,
  fetchImpl: typeof fetch,
  allowInsecureHttp: boolean,
): Promise<BearerChallenge> {
  const none: BearerChallenge = { resourceMetadata: null, scope: null };
  let res: Response;
  try {
    res = await fetchImpl(resourceUrl.href, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    rethrowIfEgressBlocked(error, resourceUrl.href);
    return none;
  }
  // Only status + headers matter; never read the body (a GET on a streamable
  // MCP endpoint may be an unbounded SSE stream).
  void res.body?.cancel().catch(() => {});
  if (res.status !== 401) return none;
  const header = res.headers.get("www-authenticate");
  if (header === null) return none;
  const params = bearerParams(header);

  const rawScope = params.get("scope")?.trim() ?? "";
  const scope = rawScope === "" ? null : rawScope.split(/\s+/);

  const rawPointer = params.get("resource_metadata")?.trim() ?? "";
  if (rawPointer === "") return { resourceMetadata: null, scope };
  let pointer: URL;
  try {
    pointer = new URL(rawPointer, resourceUrl);
  } catch {
    return { resourceMetadata: null, scope };
  }
  // The pointer is a server-supplied URL like any other (rule 1); an
  // unusable one is skipped, never fatal — the well-knowns remain.
  const check = checkServerUrl(pointer.href, allowInsecureHttp);
  return { resourceMetadata: check.ok ? check.url.href : null, scope };
}

/**
 * Parameters of the `Bearer` challenge in a `WWW-Authenticate` header.
 *
 * RFC 9110 §11.6.1 lets one header carry several challenges, each `scheme`
 * optionally followed by comma-separated `key=value` pairs — so the schemes
 * and their parameters share one comma-separated list and position, not
 * punctuation, says which is which. Splitting is quote-aware because a
 * quoted value may itself contain commas (`realm="legacy, old"`) and escaped
 * quotes. Anything before the `Bearer` scheme, and anything after the next
 * scheme token, belongs to a different challenge.
 */
function bearerParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  let inBearer = false;
  const TOKEN = String.raw`[A-Za-z0-9!#$%&'*+.^_\`|~-]+`;
  const paramRe = new RegExp(`^(${TOKEN})\\s*=\\s*([\\s\\S]*)$`);
  const schemeRe = new RegExp(`^(${TOKEN})(?:\\s+([\\s\\S]*))?$`);

  for (const item of splitOutsideQuotes(header)) {
    const asParam = paramRe.exec(item);
    if (asParam !== null) {
      if (inBearer) params.set(asParam[1]!.toLowerCase(), unquote(asParam[2]!));
      continue;
    }
    const asScheme = schemeRe.exec(item);
    if (asScheme === null) continue;
    inBearer = asScheme[1]!.toLowerCase() === "bearer";
    const rest = asScheme[2];
    if (rest === undefined || !inBearer) continue;
    const firstParam = paramRe.exec(rest.trim());
    if (firstParam !== null) {
      params.set(firstParam[1]!.toLowerCase(), unquote(firstParam[2]!));
    }
  }
  return params;
}

/** Split on commas that are not inside a quoted-string (RFC 9110 §5.6.4). */
function splitOutsideQuotes(header: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i]!;
    if (quoted) {
      if (ch === "\\" && i + 1 < header.length) {
        current += ch + header[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === '"') quoted = false;
      current += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Strip surrounding quotes and quoted-pair escapes; token values pass through. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
  }
  return value;
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

/** `/mcp/` and `/` both lose their trailing slash; `/mcp` is unchanged. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
