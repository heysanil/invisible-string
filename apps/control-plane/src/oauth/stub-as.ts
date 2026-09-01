/**
 * TEST FIXTURE: in-process OAuth 2.1 authorization server for the broker
 * suites (connectors redesign Plan 3, Tasks 5–6). Never imported by
 * production code.
 *
 * Surface:
 * - `GET  /.well-known/oauth-authorization-server` — RFC 8414 metadata
 *   (advertises its own `issuer`, S256, DCR, revocation; scopes/CIMD support
 *   and RFC 9207 `iss` capability via options/fields)
 * - `GET  /authorize` — auto-approves: records the request, mints a
 *   single-use code bound to the PKCE challenge + client + redirect_uri +
 *   `resource`, and 302s back to `redirect_uri` with `code` + `state` (+ the
 *   RFC 9207 `iss`, per {@link StubAuthorizationServer.issMode})
 * - `POST /token` — `authorization_code` grant validating PKCE (S256),
 *   single-use codes, `redirect_uri`, `client_id`, and the RFC 8707
 *   `resource`; `refresh_token` grant with rotation (the presented token
 *   dies, a new one is issued). `tokenMode = "invalid_grant"` makes every
 *   token request fail — the exchange-rejection and Task 6 `invalid_grant`
 *   scenarios.
 * - `POST /register` — RFC 7591 DCR (public client, no secret unless
 *   `issueClientSecret`); the broker registers here whenever the platform
 *   base URL is not public https (CIMD unusable).
 *   `registrationMode = "forbidden"` replays the failure that forced
 *   pre-registered clients into existence: Vercel's registration endpoint
 *   answers `400 invalid_redirect_uri` to any client it has not approved
 *   (2026-08-31 fix plan §3), which no request body can talk it out of.
 * - `POST /revoke` — RFC 7009; records revocations for Task 6 assertions
 *
 * Every request's parameters are recorded so tests can assert exact wire
 * shapes and hit counts.
 */
import { createHash, randomBytes } from "node:crypto";

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
}

export interface StubAsOptions {
  /** Advertise `client_id_metadata_document_supported` in the metadata. */
  clientIdMetadataDocumentSupported?: boolean;
  /** Advertised `scopes_supported` (omitted = none advertised). */
  scopesSupported?: string[];
  /** Seconds until issued access tokens expire (default 3600). */
  accessTokenTtlSeconds?: number;
  /** DCR also issues a client_secret (default: public client, none). */
  issueClientSecret?: boolean;
}

/**
 * A foreign issuer for the authorization-server mix-up scenario: never
 * dialed, only compared, so it needs no server behind it.
 */
export const FOREIGN_ISSUER = "https://mixup.attacker.example";

export class StubAuthorizationServer {
  /** "ok" issues tokens; "invalid_grant" 400s every token request. */
  tokenMode: "ok" | "invalid_grant" = "ok";

  /**
   * Awaited at the TOP of every token request, before any response is formed.
   * A seam for exercising what happens while the broker is mid-exchange — the
   * window in which the connection is still mutable and the callback's
   * optimistic-concurrency guard is the only thing standing between a
   * finished flow and a row that has since been reset. Left undefined the
   * server behaves normally.
   */
  beforeToken?: () => Promise<void>;

  /**
   * What the authorization response carries as its RFC 9207 `iss`:
   * - `correct` — this server's own issuer (the conformant default);
   * - `foreign` — {@link FOREIGN_ISSUER}, i.e. a response minted somewhere
   *   else, which the broker must refuse to exchange;
   * - `omit` — no `iss` at all. Only a failure when the metadata claims
   *   `authorization_response_iss_parameter_supported`, which is exactly why
   *   that flag is separately settable below.
   */
  issMode: "correct" | "foreign" | "omit" = "correct";

  /** Advertise `authorization_response_iss_parameter_supported` (RFC 9207). */
  issParameterSupported = true;

  /**
   * "ok" registers a client; "forbidden" refuses every DCR body with the
   * redirect-URI allowlist rejection real gated servers send — the failure a
   * pre-registered client exists to route around.
   */
  registrationMode: "ok" | "forbidden" = "ok";

  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly registerRequests: unknown[] = [];
  readonly revokeRequests: URLSearchParams[] = [];
  readonly issuedAccessTokens: string[] = [];
  readonly issuedRefreshTokens: string[] = [];

  private readonly options: StubAsOptions;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly liveRefreshTokens = new Set<string>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private counter = 0;

  constructor(options: StubAsOptions = {}) {
    this.options = options;
  }

  get issuer(): string {
    if (!this.server) throw new Error("stub AS not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      return this.metadata();
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      return this.authorize(url);
    }
    if (req.method === "POST" && url.pathname === "/token") {
      return this.token(req);
    }
    if (req.method === "POST" && url.pathname === "/register") {
      return this.register(req);
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      return this.revoke(req);
    }
    return new Response("not found", { status: 404 });
  }

  private metadata(): Response {
    return Response.json({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      ...(this.options.scopesSupported
        ? { scopes_supported: this.options.scopesSupported }
        : {}),
      ...(this.issParameterSupported
        ? { authorization_response_iss_parameter_supported: true }
        : {}),
      ...(this.options.clientIdMetadataDocumentSupported !== undefined
        ? {
            client_id_metadata_document_supported:
              this.options.clientIdMetadataDocumentSupported,
          }
        : {}),
    });
  }

  private authorize(url: URL): Response {
    const params = url.searchParams;
    this.authorizeRequests.push(params);
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
    const code = `code-${++this.counter}-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      resource: params.get("resource"),
      scope: params.get("scope"),
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = params.get("state");
    if (state !== null) back.searchParams.set("state", state);
    // RFC 9207: name the issuer that produced this response, so the client can
    // tell it apart from one minted by a different authorization server.
    if (this.issMode !== "omit") {
      back.searchParams.set(
        "iss",
        this.issMode === "foreign" ? FOREIGN_ISSUER : this.issuer,
      );
    }
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(req: Request): Promise<Response> {
    const params = new URLSearchParams(await req.text());
    this.tokenRequests.push(params);
    if (this.beforeToken !== undefined) await this.beforeToken();
    const fail = (error: string, status = 400) =>
      Response.json({ error }, { status });
    if (this.tokenMode === "invalid_grant") return fail("invalid_grant");

    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const issued = this.codes.get(code);
      if (!issued) return fail("invalid_grant");
      this.codes.delete(code); // single-use: a replayed code dies here
      const verifier = params.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== issued.codeChallenge) return fail("invalid_grant");
      if (params.get("redirect_uri") !== issued.redirectUri) {
        return fail("invalid_grant");
      }
      if (params.get("client_id") !== issued.clientId) {
        return fail("invalid_client", 401);
      }
      // RFC 8707: the token request must name the same resource the
      // authorization request was bound to.
      if (issued.resource !== null && params.get("resource") !== issued.resource) {
        return fail("invalid_target");
      }
      return this.issueTokens(issued.scope);
    }

    if (grantType === "refresh_token") {
      const presented = params.get("refresh_token") ?? "";
      // Rotation: the presented token is consumed; reuse is invalid_grant.
      if (!this.liveRefreshTokens.delete(presented)) return fail("invalid_grant");
      return this.issueTokens(params.get("scope"));
    }

    return fail("unsupported_grant_type");
  }

  private issueTokens(scope: string | null): Response {
    const accessToken = `at-${++this.counter}-${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt-${++this.counter}-${randomBytes(12).toString("hex")}`;
    this.issuedAccessTokens.push(accessToken);
    this.issuedRefreshTokens.push(refreshToken);
    this.liveRefreshTokens.add(refreshToken);
    return Response.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.options.accessTokenTtlSeconds ?? 3600,
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    });
  }

  private async register(req: Request): Promise<Response> {
    const body: unknown = await req.json().catch(() => null);
    this.registerRequests.push(body);
    if (this.registrationMode === "forbidden") {
      // Byte-compatible with the live rejection in fix plan §3 — the machine
      // code is all the broker surfaces, and it is not negotiable by any body.
      return Response.json(
        {
          error: "invalid_redirect_uri",
          error_description:
            "The provided redirect URIs are not approved for use by this authorization server.",
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        client_id: `dcr-client-${++this.counter}`,
        ...(this.options.issueClientSecret
          ? { client_secret: `dcr-secret-${randomBytes(12).toString("hex")}` }
          : {}),
      },
      { status: 201 },
    );
  }

  private async revoke(req: Request): Promise<Response> {
    this.revokeRequests.push(new URLSearchParams(await req.text()));
    return new Response(null, { status: 200 });
  }
}
