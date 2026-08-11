/**
 * Stub OAuth 2.1 authorization server (run under BUN) for the oauth-connection
 * spec — the consent + token half of the broker chain the control plane
 * drives for real:
 *
 *  - `GET  /.well-known/oauth-authorization-server` — RFC 8414 metadata
 *    (S256 PKCE, DCR, revocation; the discovery module requires S256).
 *  - `GET  /authorize` — validates the request, then renders an interstitial
 *    page with a single "Approve" button (the Playwright popup clicks it);
 *    `GET /authorize/approve` mints a single-use code bound to the PKCE
 *    challenge + client + redirect_uri + RFC 8707 `resource` and 302s back.
 *  - `POST /token` — `authorization_code` grant validating PKCE (S256),
 *    single-use codes, `redirect_uri`, `client_id`, and `resource`;
 *    `refresh_token` grant with rotation (the presented token is consumed).
 *    Access tokens are issued with a DELIBERATELY SHORT TTL (below the
 *    broker's and the compiled agent's 60 s expiry margins), so every broker
 *    read refreshes — the central-refresh path runs on every tool call
 *    instead of depending on wall-clock luck.
 *  - `POST /register` — RFC 7591 DCR (public client, no secret). The harness
 *    base URL is `http://localhost`, so CIMD is never usable and the broker
 *    always lands here.
 *  - `POST /revoke` — RFC 7009 (accepted + recorded).
 *
 * Test hooks (never part of the OAuth surface):
 *  - `POST /__introspect` (form `token=…`) — `{active}` for the stub MCP
 *    server's bearer validation.
 *  - `POST /__expire` — force-expires every OUTSTANDING access token, so a
 *    replayed pre-expire token can never pass introspection again.
 *  - `POST /__mode` (`{"mode":"ok"|"invalid_grant"}`) — `invalid_grant` makes
 *    every token request fail with the AS's terminal rejection (the broker
 *    lands the grant `expired` + connection `auth_error`).
 *  - `GET  /__stats` — counters (token-endpoint hits per grant type, issued
 *    tokens) for the spec's refresh assertions. Token VALUES never appear in
 *    any response body here or in any log line.
 *
 * Bound to 127.0.0.1. Every credential is a throwaway dev value (config.ts
 * banner). Nothing here ever logs a token, code, or verifier.
 */
import { createHash, randomBytes } from "node:crypto";

import { PORTS } from "../config.ts";

/**
 * Issued-access-token TTL (seconds). MUST stay below the two 60 s expiry
 * margins (broker `ACCESS_TOKEN_EXPIRY_MARGIN_MS`, emitted agent lib
 * `EXPIRY_MARGIN_MS`) so both caches always treat a stored token as stale and
 * the broker refreshes deterministically on every read.
 */
const ACCESS_TOKEN_TTL_SECONDS = 30;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  state: string | null;
}

interface IssuedAccessToken {
  expiresAtMs: number;
  forceExpired: boolean;
}

let tokenMode: "ok" | "invalid_grant" = "ok";
let counter = 0;

const pendingAuthorizations = new Map<string, PendingAuthorization>();
const codes = new Map<string, PendingAuthorization>();
const accessTokens = new Map<string, IssuedAccessToken>();
const liveRefreshTokens = new Set<string>();

const stats = {
  tokenEndpointHits: 0,
  authorizationCodeGrants: 0,
  refreshTokenGrants: 0,
  registrations: 0,
  revocations: 0,
  issuedAccessTokens: 0,
};

const ISSUER = `http://127.0.0.1:${PORTS.stubAs}`;

function metadata(): Response {
  return Response.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    revocation_endpoint: `${ISSUER}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  });
}

/** Interstitial consent page — one Approve button the popup clicks. */
function authorize(url: URL): Response {
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const challenge = params.get("code_challenge");
  if (
    !redirectUri ||
    !clientId ||
    !challenge ||
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256"
  ) {
    return new Response("bad authorize request", { status: 400 });
  }
  const rid = `rid-${++counter}-${randomBytes(8).toString("hex")}`;
  pendingAuthorizations.set(rid, {
    clientId,
    redirectUri,
    codeChallenge: challenge,
    resource: params.get("resource"),
    scope: params.get("scope"),
    state: params.get("state"),
  });
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>E2E stub authorization server</title></head>
<body>
<h1>Authorize Invisible String?</h1>
<p>This is the E2E stub authorization server. Approving grants access to the stub notes resource.</p>
<form method="get" action="/authorize/approve">
  <input type="hidden" name="rid" value="${rid}" />
  <button type="submit">Approve</button>
</form>
</body>
</html>
`;
  return new Response(page, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function approve(url: URL): Response {
  const rid = url.searchParams.get("rid") ?? "";
  const pending = pendingAuthorizations.get(rid);
  if (!pending) return new Response("unknown authorization request", { status: 400 });
  pendingAuthorizations.delete(rid);
  const code = `code-${++counter}-${randomBytes(12).toString("hex")}`;
  codes.set(code, pending);
  const back = new URL(pending.redirectUri);
  back.searchParams.set("code", code);
  if (pending.state !== null) back.searchParams.set("state", pending.state);
  return new Response(null, { status: 302, headers: { location: back.href } });
}

function issueTokens(scope: string | null): Response {
  const accessToken = `e2e-at-${++counter}-${randomBytes(12).toString("hex")}`;
  const refreshToken = `e2e-rt-${++counter}-${randomBytes(12).toString("hex")}`;
  accessTokens.set(accessToken, {
    expiresAtMs: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    forceExpired: false,
  });
  liveRefreshTokens.add(refreshToken);
  stats.issuedAccessTokens += 1;
  return Response.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
  });
}

async function token(req: Request): Promise<Response> {
  stats.tokenEndpointHits += 1;
  const params = new URLSearchParams(await req.text());
  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  if (tokenMode === "invalid_grant") return fail("invalid_grant");

  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const issued = codes.get(code);
    if (!issued) return fail("invalid_grant");
    codes.delete(code); // single-use: a replayed code dies here
    const verifier = params.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== issued.codeChallenge) return fail("invalid_grant");
    if (params.get("redirect_uri") !== issued.redirectUri) return fail("invalid_grant");
    if (params.get("client_id") !== issued.clientId) return fail("invalid_client", 401);
    // RFC 8707: the exchange must name the resource the grant was bound to.
    if (issued.resource !== null && params.get("resource") !== issued.resource) {
      return fail("invalid_target");
    }
    stats.authorizationCodeGrants += 1;
    return issueTokens(issued.scope);
  }

  if (grantType === "refresh_token") {
    const presented = params.get("refresh_token") ?? "";
    // Rotation: the presented token is consumed; reuse is invalid_grant.
    if (!liveRefreshTokens.delete(presented)) return fail("invalid_grant");
    stats.refreshTokenGrants += 1;
    return issueTokens(params.get("scope"));
  }

  return fail("unsupported_grant_type");
}

async function register(req: Request): Promise<Response> {
  await req.text(); // drain; the request shape is asserted by unit suites
  stats.registrations += 1;
  return Response.json(
    { client_id: `e2e-dcr-client-${++counter}` },
    { status: 201 },
  );
}

async function revoke(req: Request): Promise<Response> {
  await req.text();
  stats.revocations += 1;
  return new Response(null, { status: 200 });
}

async function introspect(req: Request): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const presented = params.get("token") ?? "";
  const issued = accessTokens.get(presented);
  const active =
    issued !== undefined && !issued.forceExpired && Date.now() < issued.expiresAtMs;
  return Response.json({ active });
}

function expireAll(): Response {
  let expired = 0;
  for (const issued of accessTokens.values()) {
    if (!issued.forceExpired) {
      issued.forceExpired = true;
      expired += 1;
    }
  }
  return Response.json({ expired });
}

async function setMode(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { mode?: string } | null;
  if (body?.mode !== "ok" && body?.mode !== "invalid_grant") {
    return new Response("mode must be ok|invalid_grant", { status: 400 });
  }
  tokenMode = body.mode;
  return Response.json({ mode: tokenMode });
}

const server = Bun.serve({
  port: PORTS.stubAs,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return metadata();
    }
    if (req.method === "GET" && url.pathname === "/authorize") return authorize(url);
    if (req.method === "GET" && url.pathname === "/authorize/approve") return approve(url);
    if (req.method === "POST" && url.pathname === "/token") return token(req);
    if (req.method === "POST" && url.pathname === "/register") return register(req);
    if (req.method === "POST" && url.pathname === "/revoke") return revoke(req);
    if (req.method === "POST" && url.pathname === "/__introspect") return introspect(req);
    if (req.method === "POST" && url.pathname === "/__expire") return expireAll();
    if (req.method === "POST" && url.pathname === "/__mode") return setMode(req);
    if (req.method === "GET" && url.pathname === "/__stats") {
      return Response.json({ mode: tokenMode, ...stats });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[e2e:stub-as] listening on http://127.0.0.1:${server.port} (oauth AS)`);

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
