/**
 * OAuth consent broker integration tests (connectors redesign Plan 3 Task 5,
 * as reworked by the 2026-08-31 OAuth fix plan) — gated on TEST_DATABASE_URL
 * (skip cleanly when unset; the compose integration stage provides it).
 *
 * Drives the full HTTP surface against an in-process stub authorization
 * server (stub-as.ts) and a stub OAuth-protected MCP resource that BEHAVES
 * LIKE ONE: start → consent → callback happy path ending in a probe that
 * authenticates and caches tools, the grant state machine (arm-to-`pending`,
 * a live grant surviving a failed re-consent, sanitized error codes),
 * single-use/expired/superseded `state`, RFC 9207 issuer validation,
 * initiator binding, pre-registered client identity, oauth-enabled creates
 * (custom + catalog recipe), and the authz matrix on the start routes + the
 * session-bound callback.
 *
 * Two of the cases below run against a SECOND stub authorization server the
 * MCP resource can be made to nominate mid-life (`otherAs`), because "a live
 * grant survives a failed re-consent" is only true if the row survives it
 * WHOLE: the endpoint and client columns are what the central refresh replays
 * a still-valid refresh token against, so a start that discovers a different
 * authorization server and then never completes must move none of them.
 *
 * WHAT THIS SUITE USED TO GET WRONG, because it is the reason the shipped
 * product was broken (fix plan §2 "why the tests did not catch it"): the MCP
 * fixture answered 401 to EVERYTHING, and the happy-path test asserted only
 * that a probe had FIRED — never its outcome. The health it actually
 * persisted after that passing test was `auth_error`, which is precisely the
 * "connected but 401" users saw. The fixture below now requires the bearer
 * token like every real OAuth MCP server, and the assertions are on the
 * persisted health, the tool cache, and the Authorization header the server
 * received.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  generateMasterKeyBase64,
  parseMasterKey,
  type ConnectorCatalogEntry,
  type CreateConnectionResponse,
  type EncryptedEnvelope,
  type StartOauthResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createAppStack, type AppStack } from "../index";
import { runMigrations } from "../migrate";
import { connectionOauthAad } from "./client-identity";
import { FOREIGN_ISSUER, StubAuthorizationServer } from "./stub-as";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** The CONTROL-PLANE origin: redirect URI + CIMD client id come from it. */
const BASE_URL = "http://localhost:3000";
/**
 * The SPA origin, deliberately DIFFERENT from the API's — the split-origin
 * deployment (local dev) whose silent postMessage drop is fix plan F8. Every
 * callback page rendered by this suite must target this one.
 */
const WEB_URL = "http://localhost:5173";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const MASTER_KEY = parseMasterKey(MASTER_KEY_B64);
/** Operator-supplied client for the `preregistered` preset (fix plan P2b). */
const PREREGISTERED_CLIENT_ID = "preapproved-client-id";
const PREREGISTERED_ENV_PREFIX = "STUB_PREREG";

// ── stub OAuth-protected MCP resource ────────────────────────────────────────
//
// A real OAuth-protected MCP server, because a permissive one cannot prove
// the thing that matters (fix plan F1/P1.3): EVERY /mcp request needs a
// bearer the stub AS issued, exactly like Linear, Notion or Sentry.
//
//  - unauthenticated (discovery's GET; any token-less probe) → 401 carrying
//    the RFC 9728 `resource_metadata` pointer AND the `scope` the request
//    lacked. That challenge scope is authoritative per the MCP spec and is
//    deliberately WIDER than the PRM's, so which one reaches the
//    authorization request is observable (fix plan F6);
//  - authenticated GET → 405, the spec's "no standalone SSE stream here",
//    which the SDK client accepts and moves on from;
//  - authenticated POST → streamable-HTTP JSON-RPC: `initialize`, the
//    `notifications/initialized` 202, and `tools/list`.

/** The one tool advertised — `tools_cache` stores exactly this, trimmed. */
const STUB_TOOL = {
  name: "echo",
  description: "Echo a message back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

interface JsonRpcMessage {
  method?: unknown;
  id?: unknown;
  params?: { protocolVersion?: unknown } | undefined;
}

class StubResource {
  /** Every /mcp request, authenticated or not — probe-fired assertions. */
  mcpHits = 0;
  /** `Authorization` of every /mcp request, in order (null when absent). */
  readonly authorizationHeaders: (string | null)[] = [];
  /** Bearer values the server ACCEPTED, in order. */
  readonly acceptedTokens: string[] = [];
  /** `WWW-Authenticate` scope — authoritative over the PRM's (fix plan F6). */
  challengeScope = "mcp.read mcp.write";
  /** PRM `scopes_supported`, deliberately NARROWER than the challenge's. */
  prmScopes: string[] = ["mcp.read"];
  /**
   * The authorization server this resource NOMINATES. Mutable because it is
   * the MCP server's choice — a hostile or compromised one repoints it, which
   * is the AS mix-up the broker's staging has to survive.
   */
  asIssuer = "";

  private isLiveToken: (token: string) => boolean = () => false;
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(asIssuer: string, isLiveToken: (token: string) => boolean): void {
    this.asIssuer = asIssuer;
    this.isLiveToken = isLiveToken;
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") return await this.mcp(req);
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: this.mcpUrl,
            authorization_servers: [this.asIssuer],
            scopes_supported: this.prmScopes,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  get origin(): string {
    if (!this.server) throw new Error("stub resource not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  get mcpUrl(): string {
    return `${this.origin}/mcp`;
  }

  /** A URL on this host that is NOT an MCP server — discovery finds nothing. */
  get notMcpUrl(): string {
    return `${this.origin}/not-mcp`;
  }

  private async mcp(req: Request): Promise<Response> {
    this.mcpHits += 1;
    const header = req.headers.get("authorization");
    this.authorizationHeaders.push(header);
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
    if (token === null || !this.isLiveToken(token)) return this.challenge();
    this.acceptedTokens.push(token);
    // No standalone SSE stream: the SDK opens one after `initialized` and
    // treats 405 as "not offered" without erroring the session.
    if (req.method !== "POST") return new Response(null, { status: 405 });

    const message = (await req.json().catch(() => null)) as JsonRpcMessage | null;
    if (message === null || typeof message.method !== "string") {
      return new Response("bad json-rpc", { status: 400 });
    }
    // Notifications carry no id and get an empty 202.
    if (message.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      return reply({
        // Echo what the client asked for: the SDK rejects a version outside
        // its supported set, and the client's own request is always inside it.
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-oauth-mcp", version: "1.0.0" },
      });
    }
    if (message.method === "tools/list") return reply({ tools: [STUB_TOOL] });
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "method not found" },
    });
  }

  private challenge(): Response {
    return new Response("unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp", scope="${this.challengeScope}"`,
      },
    });
  }
}

// ── cheap publish stubs (only the seeded-workspace publish runs here) ────────

const stubCompile: CompileAgentFn = (request) => ({
  files: new Map([["agent/instructions.md", request.definition.persona]]),
  hash: createHash("sha256")
    .update(JSON.stringify(request.definition))
    .digest("hex"),
  compilerVersion: "stub-compiler-1",
  eveVersion: "0.31.3",
});

function fakeBuildSteps(): BuildSteps {
  return {
    async writeFiles() {},
    async install() {},
    async eveBuild() {},
    async provisionWorld() {},
    async packageArtifact(_dir, hash) {
      return new TextEncoder().encode(`fake-${hash}`);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function decryptEnvelope(
  serialized: string,
  column: "access_token" | "refresh_token" | "pending_code_verifier",
  rowId: string,
): string {
  return decryptSecret(
    JSON.parse(serialized) as EncryptedEnvelope,
    MASTER_KEY,
    connectionOauthAad(column, rowId),
  );
}

if (!TEST_DATABASE_URL) {
  console.warn(
    "[oauth-broker] TEST_DATABASE_URL not set — skipping broker integration tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("oauth consent broker", () => {
  const as = new StubAuthorizationServer({
    scopesSupported: ["mcp.read", "mcp.write"],
  });
  /**
   * A SECOND, fully functional authorization server the resource can be made
   * to nominate instead — the endpoint an AS mix-up would repoint a live
   * grant at. It registers clients and issues tokens like any other, which is
   * the point: nothing about it is malformed, so only WHEN its endpoints are
   * allowed to reach the grant row keeps a refresh token away from it.
   */
  const otherAs = new StubAuthorizationServer();
  const resource = new StubResource();
  /**
   * The pre-registered preset gets its OWN resource, nominating `otherAs`.
   *
   * It cannot share `resource`: an operator registration is pinned to exactly
   * one issuer (`_ISSUER` is required and exact-matched), and
   * `findOauthClientRegistration` will hand that identity to ANY connection
   * reaching the same authorization server — deliberately, so a custom
   * connection pointed at an approved AS inherits the approved client. With
   * one shared AS the pin would therefore capture every `source: "custom"`
   * connection in this file and silently skip the DCR path the other tests
   * exist to cover.
   */
  const preregResource = new StubResource();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];

  let ownerCookie: string;
  let orgId: string;
  let ownerUserId: string;

  async function api(
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string } = {},
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    return stack.app.handle(new Request(`${BASE_URL}${path}`, init));
  }

  async function signUpWithOrg(
    name: string,
  ): Promise<{ cookie: string; orgId: string; userId: string }> {
    const email = `oauth-${randomUUID()}@example.com`;
    const res = await stack.app.handle(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery", name }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const headers = new Headers({ cookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: `${name} ws`, slug: `ws-${randomUUID().slice(0, 8)}` },
      headers,
    });
    await stack.auth.api.setActiveOrganization({
      body: { organizationId: org!.id },
      headers,
    });
    const session = await stack.auth.api.getSession({ headers });
    return { cookie, orgId: org!.id, userId: session!.user.id };
  }

  /** Create a workspace-scoped custom OAuth connection; returns id + start path. */
  async function createOauthConnection(
    name: string,
    url = resource.mcpUrl,
  ): Promise<{ id: string; startPath: string }> {
    const res = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: { source: "custom", name, url, auth: { type: "oauth" } },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateConnectionResponse;
    expect(body.oauthStartPath).toBeDefined();
    return { id: body.connection.id, startPath: body.oauthStartPath! };
  }

  async function oauthRow(connectionId: string) {
    const rows = await db
      .select()
      .from(schema.connectionOauth)
      .where(eq(schema.connectionOauth.connectionId, connectionId))
      .limit(1);
    return rows[0];
  }

  async function connectionRow(connectionId: string) {
    const rows = await db
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId))
      .limit(1);
    return rows[0];
  }

  /**
   * Block until the fire-and-forget post-connect probe has committed.
   * `last_checked_at` is the honest witness: an oauth row is created WITHOUT
   * a probe (fix plan P1.2), so the column is null until `probeAndPersist`
   * writes it, and it writes it on every outcome.
   */
  async function awaitPostConnectProbe(connectionId: string): Promise<void> {
    await until(
      async () => ((await connectionRow(connectionId))?.lastCheckedAt ?? null) !== null,
      "the post-connect probe to persist a health classification",
    );
  }

  /** The stored access token, decrypted — what the probe must present. */
  async function storedAccessToken(connectionId: string): Promise<string> {
    const row = (await oauthRow(connectionId))!;
    return decryptEnvelope(row.accessTokenEncrypted!, "access_token", row.id);
  }

  /** Create → start → consent → callback, asserting only that it connected. */
  async function connectFlow(
    name: string,
  ): Promise<{ id: string; startPath: string }> {
    const created = await createOauthConnection(name);
    const url = await startFlow(created.startPath);
    const callback = await approveConsent(url);
    const res = await api("GET", callback, { cookie: ownerCookie });
    expect(await res.text()).toContain('"ok":true');
    return created;
  }

  /** POST the start route and return the parsed authorize URL. */
  async function startFlow(startPath: string): Promise<URL> {
    const res = await api("POST", startPath, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as StartOauthResponse;
    return new URL(authorizeUrl);
  }

  /** Drive the stub AS consent redirect; returns the callback path+query. */
  async function approveConsent(authorizeUrl: URL): Promise<string> {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/integrations/mcp-oauth/callback");
    return `${location.pathname}${location.search}`;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    as.start();
    otherAs.start();
    // The resource trusts exactly the tokens this AS minted — so "the probe
    // presented the broker's token" is checkable, not assumed. `otherAs`
    // deliberately does NOT appear here: a token it issued is worthless at
    // the resource, which is what a mix-up costs the user.
    resource.start(as.issuer, (token) => as.issuedAccessTokens.includes(token));
    preregResource.start(otherAs.issuer, (token) =>
      otherAs.issuedAccessTokens.includes(token),
    );
    const catalogEntry: ConnectorCatalogEntry = {
      slug: "stub-oauth",
      title: "Stub OAuth",
      category: "dev-tools",
      description: "OAuth-protected stub connector.",
      modelDescription: "Stub OAuth MCP server for broker tests.",
      // http + private on purpose: the entry map is injected post-parse, and
      // MCP_PROBE_ALLOW_PRIVATE=1 admits the loopback stub.
      url: resource.mcpUrl,
      transport: "streamable-http",
      auth: { type: "oauth" },
    };
    // The Phase-2 option (b) preset: an authorization server this broker
    // cannot register with, whose client identity therefore comes from
    // operator config under the prefix the entry itself names.
    const preregisteredEntry: ConnectorCatalogEntry = {
      ...catalogEntry,
      slug: "stub-oauth-preregistered",
      title: "Stub OAuth (pre-registered)",
      url: preregResource.mcpUrl,
      auth: {
        type: "oauth",
        clientIdentity: "preregistered",
        clientEnvPrefix: PREREGISTERED_ENV_PREFIX,
      },
    };
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "oauth-broker-secret-0000000000000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET: "oauth-platform-jwt-secret-0000000",
        WORKER_SHARED_SECRET: "oauth-worker-shared-secret-000000",
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        OPENROUTER_API_KEY: "or-key",
        ALLOW_INSECURE_WORKER_TRANSPORT: "1",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-oauth-builds"),
        // The stub AS + resource live on 127.0.0.1 over http — the guarded
        // egress fetch must admit them (same var the probe lane documents).
        MCP_PROBE_ALLOW_PRIVATE: "1",
        // Split-origin deployment: the SPA is NOT this API's origin, which is
        // the configuration F8 was invisible under.
        PUBLIC_WEB_URL: WEB_URL,
        // Operator-supplied client for the pre-registered preset.
        [`MCP_OAUTH_${PREREGISTERED_ENV_PREFIX}_CLIENT_ID`]:
          PREREGISTERED_CLIENT_ID,
        [`MCP_OAUTH_${PREREGISTERED_ENV_PREFIX}_CLIENT_SECRET`]:
          "preapproved-client-secret",
        // REQUIRED and exact-matched. Without the pin the registration would
        // match whatever issuer discovery reported, so a repointed MCP server
        // could nominate its own AS and be handed this approved secret.
        [`MCP_OAUTH_${PREREGISTERED_ENV_PREFIX}_ISSUER`]: otherAs.issuer,
      },
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts: createMemoryArtifactStore(),
        catalog: new Map([
          [catalogEntry.slug, catalogEntry],
          [preregisteredEntry.slug, preregisteredEntry],
        ]),
      },
    );
    db = stack.dbHandle.db;

    const owner = await signUpWithOrg("OAuth Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    ownerUserId = owner.userId;
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
    as.stop();
    otherAs.stop();
    resource.stop();
    preregResource.stop();
  }, 30_000);

  // ── oauth-enabled creates ─────────────────────────────────────────────────

  test("custom create with oauth auth yields a pending grant row and a start path", async () => {
    const hitsBefore = resource.mcpHits;
    const { id, startPath } = await createOauthConnection("Custom OAuth");
    expect(startPath).toBe(`/workspaces/${orgId}/connections/${id}/oauth/start`);
    // No create-time probe for an OAuth row (fix plan P1.2): consent has not
    // happened, so a dial could only collect a 401 — and, once the
    // post-callback probe carries a token, that late-landing failure could
    // overwrite a healthy result. Not dialling removes the race outright.
    expect(resource.mcpHits).toBe(hitsBefore);

    const get = await api("GET", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
    });
    const dto = ((await get.json()) as CreateConnectionResponse).connection;
    expect(dto.authType).toBe("oauth");
    // A pending grant holds NO token, so it is not credentialed (fix plan
    // F10). This assertion used to read `toBeTrue()`, and that hardcoding is
    // what dressed "I have nothing to send" up as "your token was rejected".
    expect(dto.hasCredentials).toBeFalse();
    // …and nothing dialled the server on the way in (fix plan P1.2), so the
    // honest opening health is `auth_required`, not a 401 collected from a
    // request that carried no credential.
    expect(dto.health).toBe("auth_required");
    expect(dto.lastError).toBeNull();

    const row = await oauthRow(id);
    expect(row).toBeDefined();
    expect(row!.id).toMatch(/^co_[0-9a-z]{16}$/);
    expect(row!.status).toBe("pending");
    expect(row!.accessTokenEncrypted).toBeNull();
  });

  test("catalog create with an oauth recipe yields pending + start path; static creds are rejected", async () => {
    const res = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: { source: "catalog", slug: "stub-oauth" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateConnectionResponse;
    expect(body.connection.authType).toBe("oauth");
    expect(body.connection.oauthStatus).toBe("pending");
    expect(body.oauthStartPath).toBe(
      `/workspaces/${orgId}/connections/${body.connection.id}/oauth/start`,
    );
    const row = await oauthRow(body.connection.id);
    expect(row!.status).toBe("pending");

    // The recipe is OAuth: supplying static credentials is a 422.
    const withCreds = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: {
        source: "catalog",
        slug: "stub-oauth",
        auth: { type: "bearer", values: { token: "sk-nope" } },
      },
    });
    expect(withCreds.status).toBe(422);
  });

  // ── the full consent flow ─────────────────────────────────────────────────

  test("start → consent → callback persists encrypted tokens, connects, and fires the probe", async () => {
    const { id, startPath } = await createOauthConnection("Happy Path");
    const registrationsBefore = as.registerRequests.length;

    const authorizeUrl = await startFlow(startPath);
    expect(authorizeUrl.origin).toBe(as.issuer);
    expect(authorizeUrl.pathname).toBe("/authorize");
    const params = authorizeUrl.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(
      `${BASE_URL}/integrations/mcp-oauth/callback`,
    );
    expect(params.get("resource")).toBe(resource.mcpUrl);
    // The CHALLENGE's scope, not the PRM's (`mcp.read`) and not the AS-wide
    // advertisement — the MCP spec's authoritative source (fix plan F6).
    expect(params.get("scope")).toBe("mcp.read mcp.write");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    const state = params.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(22);

    // Base URL is http://localhost — CIMD unusable, so the broker registered
    // a DCR client and uses its id.
    expect(as.registerRequests.length).toBe(registrationsBefore + 1);
    expect(params.get("client_id")).toMatch(/^dcr-client-/);

    // Discovery landed on the STAGED flow, not on the grant: everything the
    // MCP server nominated is held there until an exchange succeeds, because
    // `token_endpoint`/`revocation_endpoint` are where a live refresh token
    // gets replayed (adversarial review of F5/F12).
    const pending = (await oauthRow(id))!;
    expect(pending.pendingFlow).not.toBeNull();
    expect(pending.pendingFlow!.authorizationServer).toBe(as.issuer);
    expect(pending.pendingFlow!.authorizationEndpoint).toBe(
      `${as.issuer}/authorize`,
    );
    expect(pending.pendingFlow!.tokenEndpoint).toBe(`${as.issuer}/token`);
    expect(pending.pendingFlow!.resource).toBe(resource.mcpUrl);
    expect(pending.pendingFlow!.revocationEndpoint).toBe(`${as.issuer}/revoke`);
    expect(pending.pendingFlow!.clientIdentityMode).toBe("dcr");
    expect(pending.pendingFlow!.clientRegistrationIssuer).toBe(as.issuer);
    // …and the grant columns are still blank — this connection has authorized
    // nothing yet, so it has no endpoints and no client of its own.
    expect(pending.authorizationServer).toBeNull();
    expect(pending.tokenEndpoint).toBeNull();
    expect(pending.revocationEndpoint).toBeNull();
    expect(pending.resource).toBeNull();
    expect(pending.clientId).toBeNull();
    expect(pending.clientIdentityMode).toBeNull();
    expect(pending.clientRegistrationIssuer).toBeNull();
    expect(pending.pendingState).toBe(state);
    expect(pending.pendingExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    // The armed flow records who started it and what it expects to hear back
    // from (fix plan F13/F15), and clears any prior verdict (F12).
    expect(pending.status).toBe("pending");
    expect(pending.pendingStartedBy).toBe(ownerUserId);
    expect(pending.expectedIssuer).toBe(as.issuer);
    expect(pending.issParameterSupported).toBeTrue();
    expect(pending.lastErrorCode).toBeNull();
    const verifier = decryptEnvelope(
      pending.pendingCodeVerifierEncrypted!,
      "pending_code_verifier",
      pending.id,
    );
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      params.get("code_challenge")!,
    );

    const callbackPath = await approveConsent(authorizeUrl);
    // The authorization response names its issuer (RFC 9207) and the broker
    // checked it before exchanging anything (fix plan F13).
    expect(new URLSearchParams(callbackPath.split("?")[1]).get("iss")).toBe(
      as.issuer,
    );
    const callback = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toContain("text/html");
    expect(callback.headers.get("content-security-policy")).toContain(
      "script-src 'unsafe-inline'",
    );
    const page = await callback.text();
    expect(page).toContain('"type":"mcp-oauth"');
    expect(page).toContain('"ok":true');
    expect(page).toContain(id);
    expect(page).toContain('"reason":null');
    // The postMessage targets the SPA, not this API (fix plan F8) — a page
    // pinned to the API origin is dropped by the browser in silence.
    expect(page).toContain(JSON.stringify(WEB_URL));
    expect(page).not.toContain(JSON.stringify(BASE_URL));

    const connected = (await oauthRow(id))!;
    expect(connected.status).toBe("connected");
    expect(connected.connectedBy).toBe(ownerUserId);
    expect(connected.pendingState).toBeNull();
    expect(connected.pendingCodeVerifierEncrypted).toBeNull();
    expect(connected.pendingExpiresAt).toBeNull();
    expect(connected.pendingStartedBy).toBeNull();
    expect(connected.pendingFlow).toBeNull();
    expect(connected.lastErrorCode).toBeNull();
    // The exchange PROMOTED the staged flow: the grant now records the
    // endpoints and the client its own tokens were minted through, and those
    // are the ones refresh and revocation will replay against.
    expect(connected.authorizationServer).toBe(as.issuer);
    expect(connected.authorizationEndpoint).toBe(`${as.issuer}/authorize`);
    expect(connected.tokenEndpoint).toBe(`${as.issuer}/token`);
    expect(connected.revocationEndpoint).toBe(`${as.issuer}/revoke`);
    expect(connected.resource).toBe(resource.mcpUrl);
    expect(connected.clientIdentityMode).toBe("dcr");
    expect(connected.clientId).toBe(params.get("client_id"));
    expect(connected.clientRegistrationIssuer).toBe(as.issuer);
    expect(connected.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const accessToken = decryptEnvelope(
      connected.accessTokenEncrypted!,
      "access_token",
      connected.id,
    );
    expect(as.issuedAccessTokens).toContain(accessToken);
    const refreshToken = decryptEnvelope(
      connected.refreshTokenEncrypted!,
      "refresh_token",
      connected.id,
    );
    expect(as.issuedRefreshTokens).toContain(refreshToken);
    // No token value ever appears in the page.
    expect(page).not.toContain(accessToken);
    expect(page).not.toContain(refreshToken);

    // The token exchange carried PKCE + the RFC 8707 resource.
    const exchange = as.tokenRequests.at(-1)!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code_verifier")).toBe(verifier);
    expect(exchange.get("resource")).toBe(resource.mcpUrl);

    // ── THE assertion the old suite was missing (fix plan F1/P1.3) ─────────
    //
    // The post-connect probe is fire-and-forget, so poll — but poll for the
    // OUTCOME, not for a hit count. Asserting only that a probe fired is what
    // let "connected but 401" ship: the probe dialled with no Authorization
    // header, the server correctly refused it, and the row was persisted
    // `auth_error` while this test passed.
    const health = await until(async () => {
      const row = (await connectionRow(id))!;
      // `last_checked_at` is what proves a probe RAN — the row was born
      // `auth_required` without one (fix plan P1.2), so health alone cannot
      // tell "not probed yet" from "probed and unauthorized".
      return row.lastCheckedAt === null ? false : row;
    }, "post-connect probe to persist a health classification");
    expect(health.health).toBe("ok");
    expect(health.lastError).toBeNull();
    // The tool cache populates, which is what feeds the tool picker,
    // per-tool approvals, the agent-version tool directory and the copilot
    // inventory — none of which any OAuth connection could reach before.
    expect(health.toolsCache).toEqual([
      { name: "echo", description: "Echo a message back.", params: ["message"] },
    ]);
    expect(health.toolsCachedAt).not.toBeNull();
    // And it authenticated with the broker's own token — not merely with
    // "some" credential.
    expect(resource.authorizationHeaders).toContain(`Bearer ${accessToken}`);
    expect(resource.acceptedTokens).toContain(accessToken);
    // …and the fixture really is gated: discovery's own unauthenticated GET
    // was refused (that 401 is what carries the challenge), so an `ok` here
    // can only have come from a request that presented the token.
    expect(resource.authorizationHeaders).toContain(null);

    // The DTO agrees: a connected grant IS credentialed.
    const dto = await api("GET", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
    });
    const body = ((await dto.json()) as CreateConnectionResponse).connection;
    expect(body.hasCredentials).toBeTrue();
    expect(body.oauthStatus).toBe("connected");
    expect(body.health).toBe("ok");
  });

  // ── state discipline ──────────────────────────────────────────────────────

  test("unknown state fails without touching any pending flow", async () => {
    const { id, startPath } = await createOauthConnection("Wrong State");
    const authorizeUrl = await startFlow(startPath);
    const state = authorizeUrl.searchParams.get("state")!;

    const exchangesBefore = as.tokenRequests.length;
    const res = await api(
      "GET",
      `/integrations/mcp-oauth/callback?code=whatever&state=not-${state}`,
      { cookie: ownerCookie },
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('"ok":false');
    // The failure carries its machine code, so the SPA can say WHICH failure
    // this was rather than "something went wrong" (fix plan F9).
    expect(page).toContain('"reason":"oauth_state_invalid"');
    expect(page).toContain(JSON.stringify(WEB_URL));
    expect(as.tokenRequests.length).toBe(exchangesBefore);

    // The real pending flow survives untouched; no tokens were written.
    const row = (await oauthRow(id))!;
    expect(row.pendingState).toBe(state);
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.status).toBe("pending");
  });

  test("expired state is rejected and consumed, with no token write", async () => {
    const { id, startPath } = await createOauthConnection("Expired State");
    const authorizeUrl = await startFlow(startPath);
    const callbackPath = await approveConsent(authorizeUrl);
    const row = (await oauthRow(id))!;
    await db
      .update(schema.connectionOauth)
      .set({ pendingExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.connectionOauth.id, row.id));

    const exchangesBefore = as.tokenRequests.length;
    const res = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await res.text()).toContain('"ok":false');
    expect(as.tokenRequests.length).toBe(exchangesBefore);

    const after = (await oauthRow(id))!;
    expect(after.pendingState).toBeNull(); // single-use: expired state dies
    expect(after.accessTokenEncrypted).toBeNull();
    expect(after.status).toBe("pending");
  });

  test("a completed callback URL cannot be replayed", async () => {
    const { id, startPath } = await createOauthConnection("Replay");
    const authorizeUrl = await startFlow(startPath);
    const callbackPath = await approveConsent(authorizeUrl);

    const first = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await first.text()).toContain('"ok":true');
    const connected = (await oauthRow(id))!;
    expect(connected.status).toBe("connected");

    const exchangesBefore = as.tokenRequests.length;
    const replay = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await replay.text()).toContain('"ok":false');
    expect(as.tokenRequests.length).toBe(exchangesBefore); // no second exchange
    expect((await oauthRow(id))!.status).toBe("connected"); // grant untouched
  });

  test("a second start supersedes the first pending flow", async () => {
    const { id, startPath } = await createOauthConnection("Supersede");
    const firstUrl = await startFlow(startPath);
    const firstCallback = await approveConsent(firstUrl);
    const registrationsAfterFirst = as.registerRequests.length;

    const secondUrl = await startFlow(startPath);
    expect(secondUrl.searchParams.get("state")).not.toBe(
      firstUrl.searchParams.get("state"),
    );
    // A registration made for a consent that never completed is NOT a
    // credential this connection holds — it was staged with the superseded
    // flow and died with it — so this start mints its own. The reuse that
    // matters is a re-consent of a LIVE grant (see "re-consent keeps a live
    // grant connected"), where the registration promoted alongside the
    // tokens is right there on the row and is reused untouched. Paying one
    // dynamic registration per abandoned first attempt is the price of the
    // start route never writing a credential column at all.
    expect(as.registerRequests.length).toBe(registrationsAfterFirst + 1);

    // The superseded state is dead — and the live one still works.
    const stale = await api("GET", firstCallback, { cookie: ownerCookie });
    expect(await stale.text()).toContain('"ok":false');
    expect((await oauthRow(id))!.pendingState).toBe(
      secondUrl.searchParams.get("state"),
    );

    const liveCallback = await approveConsent(secondUrl);
    const live = await api("GET", liveCallback, { cookie: ownerCookie });
    expect(await live.text()).toContain('"ok":true');
    expect((await oauthRow(id))!.status).toBe("connected");
  });

  test("exchange rejection lands status error with no token write", async () => {
    const { id, startPath } = await createOauthConnection("Exchange Fails");
    const authorizeUrl = await startFlow(startPath);
    const callbackPath = await approveConsent(authorizeUrl);

    as.tokenMode = "invalid_grant";
    try {
      const res = await api("GET", callbackPath, { cookie: ownerCookie });
      const page = await res.text();
      expect(page).toContain('"ok":false');
      expect(page).toContain('"reason":"oauth_exchange_failed"');
    } finally {
      as.tokenMode = "ok";
    }

    // Nothing to lose (a first consent), so `error` is the honest landing —
    // and the reason is recorded for the connection surface (fix plan F12).
    const row = (await oauthRow(id))!;
    expect(row.status).toBe("error");
    expect(row.lastErrorCode).toBe("oauth_exchange_failed");
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.pendingState).toBeNull();

    // …and a fresh start re-arms it: `error` is a verdict on one attempt, not
    // a dead end (fix plan F12).
    await startFlow(startPath);
    const rearmed = (await oauthRow(id))!;
    expect(rearmed.status).toBe("pending");
    expect(rearmed.lastErrorCode).toBeNull();
    expect(rearmed.pendingState).not.toBeNull();
  });

  // ── the grant state machine (fix plan F5/F12) ─────────────────────────────

  test("a start failure records a sanitized code and leaves the grant alone", async () => {
    // An endpoint that is not an MCP server at all: no challenge, no PRM, no
    // authorization-server metadata anywhere discovery looks.
    const { id, startPath } = await createOauthConnection(
      "Discovery Fails",
      resource.notMcpUrl,
    );
    const before = (await oauthRow(id))!;

    const res = await api("POST", startPath, { cookie: ownerCookie });
    expect(res.status).toBe(502);
    expect(
      ((await res.json()) as { error: { code: string } }).error.code,
    ).toBe("oauth_discovery_failed");

    const row = (await oauthRow(id))!;
    // The typed code is persisted — the old behaviour left NOTHING behind, so
    // a user watching a popup fail had no way to learn why.
    expect(row.lastErrorCode).toBe("oauth_discovery_failed");
    // Nothing armed, so nothing about the grant changed: no state, and the
    // status is exactly what it was (inventing `error` here would be the F5
    // mistake one step early).
    expect(row.status).toBe(before.status);
    expect(row.pendingState).toBeNull();
    expect(row.pendingStartedBy).toBeNull();
  });

  test("re-consent keeps a live grant connected, and a failed one does not break it", async () => {
    const { id, startPath } = await connectFlow("Re-Consent");
    const live = (await oauthRow(id))!;
    expect(live.status).toBe("connected");

    // Arming a re-consent must NOT downgrade the row to `pending`:
    // getAccessToken gates on `connected`, so every agent tool call and every
    // probe would start failing the moment the popup opened.
    const registrationsBefore = as.registerRequests.length;
    const authorizeUrl = await startFlow(startPath);
    const armed = (await oauthRow(id))!;
    expect(armed.status).toBe("connected");
    expect(armed.pendingState).toBe(authorizeUrl.searchParams.get("state"));
    expect(armed.accessTokenEncrypted).toBe(live.accessTokenEncrypted);
    // Re-consent at the SAME issuer reuses the registration promoted with the
    // live tokens — no new client, and nothing to stage over it.
    expect(as.registerRequests.length).toBe(registrationsBefore);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(live.clientId);

    // Now fail the re-consent the way a user does — by declining. The grant
    // that was already working must survive it (fix plan F5).
    const callbackPath = await approveConsent(authorizeUrl);
    as.tokenMode = "invalid_grant";
    try {
      const res = await api("GET", callbackPath, { cookie: ownerCookie });
      expect(await res.text()).toContain('"ok":false');
    } finally {
      as.tokenMode = "ok";
    }

    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.accessTokenEncrypted).toBe(live.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(live.refreshTokenEncrypted);
    // The failure is still reported — retained, not hidden.
    expect(after.lastErrorCode).toBe("oauth_exchange_failed");

    // Proof it is not merely a status string: the connection still probes
    // healthy, which needs a decryptable token the server accepts.
    const probe = await api(
      "POST",
      `/workspaces/${orgId}/connections/${id}/probe`,
      { cookie: ownerCookie },
    );
    expect(probe.status).toBe(200);
    const dto = ((await probe.json()) as CreateConnectionResponse).connection;
    expect(dto.health).toBe("ok");
    expect(resource.acceptedTokens).toContain(await storedAccessToken(id));
  });

  test("a re-consent that never completes cannot repoint a live grant", async () => {
    const { id, startPath } = await connectFlow("AS Repoint");
    // The post-connect probe is fire-and-forget AND a `getAccessToken`
    // caller, so let it land before this test starts counting token requests
    // and forcing expiries under it.
    await awaitPostConnectProbe(id);
    const live = (await oauthRow(id))!;
    expect(live.status).toBe("connected");
    expect(live.tokenEndpoint).toBe(`${as.issuer}/token`);

    // The MCP server now nominates a DIFFERENT authorization server. That is
    // the whole attack: the server picks its own AS, so a compromised (or
    // merely hijacked) one can name anything, and the only thing standing
    // between it and a live refresh token is WHEN discovery is allowed to
    // reach the grant row.
    resource.asIssuer = otherAs.issuer;
    try {
      const authorizeUrl = await startFlow(startPath);
      expect(authorizeUrl.origin).toBe(otherAs.issuer);
      // …and the user closes the popup. No callback ever arrives.

      const armed = (await oauthRow(id))!;
      // The grant is still live (F5) — and now that is safe, because nothing
      // the start discovered reached it. Every column the refresh and the
      // revocation read is byte-identical.
      expect(armed.status).toBe("connected");
      expect(armed.authorizationServer).toBe(live.authorizationServer);
      expect(armed.authorizationEndpoint).toBe(live.authorizationEndpoint);
      expect(armed.tokenEndpoint).toBe(live.tokenEndpoint);
      expect(armed.revocationEndpoint).toBe(live.revocationEndpoint);
      expect(armed.resource).toBe(live.resource);
      expect(armed.scopes).toEqual(live.scopes);
      expect(armed.clientId).toBe(live.clientId);
      expect(armed.clientIdentityMode).toBe(live.clientIdentityMode);
      expect(armed.clientSecretEncrypted).toBe(live.clientSecretEncrypted);
      expect(armed.clientRegistrationIssuer).toBe(live.clientRegistrationIssuer);
      expect(armed.accessTokenEncrypted).toBe(live.accessTokenEncrypted);
      expect(armed.refreshTokenEncrypted).toBe(live.refreshTokenEncrypted);
      // The other server's endpoints exist ONLY as staged flow state.
      expect(armed.pendingFlow!.tokenEndpoint).toBe(`${otherAs.issuer}/token`);
      expect(armed.pendingFlow!.authorizationServer).toBe(otherAs.issuer);

      // Now force the refresh that any agent tool call or health probe
      // triggers once the stored token reaches its expiry margin — the moment
      // the repointed endpoint would have been dialled.
      await db
        .update(schema.connectionOauth)
        .set({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.connectionOauth.id, live.id));
      const strayTokenHits = otherAs.tokenRequests.length;
      const homeTokenHits = as.tokenRequests.length;

      const probe = await api(
        "POST",
        `/workspaces/${orgId}/connections/${id}/probe`,
        { cookie: ownerCookie },
      );
      expect(probe.status).toBe(200);

      // THE assertion: the refresh went home. A refresh token minted by one
      // authorization server was never presented to another — which is what a
      // start-time endpoint write turns every abandoned re-consent into.
      expect(otherAs.tokenRequests.length).toBe(strayTokenHits);
      expect(as.tokenRequests.length).toBe(homeTokenHits + 1);
      expect(as.tokenRequests.at(-1)!.get("grant_type")).toBe("refresh_token");
      // And the connection kept working across all of it.
      const dto = ((await probe.json()) as CreateConnectionResponse).connection;
      expect(dto.health).toBe("ok");
      expect(resource.acceptedTokens).toContain(await storedAccessToken(id));
    } finally {
      resource.asIssuer = as.issuer;
    }
  });

  test("a re-consent that succeeds does move the grant to the new server", async () => {
    // The positive control for the test above: staging is "not yet", never
    // "never". A user who actually completes consent at the newly advertised
    // authorization server gets a grant that points there.
    const { id, startPath } = await connectFlow("AS Migration");
    const before = (await oauthRow(id))!;

    resource.asIssuer = otherAs.issuer;
    try {
      const authorizeUrl = await startFlow(startPath);
      const callbackPath = await approveConsent(authorizeUrl);
      const res = await api("GET", callbackPath, { cookie: ownerCookie });
      expect(await res.text()).toContain('"ok":true');
    } finally {
      resource.asIssuer = as.issuer;
    }

    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.pendingFlow).toBeNull();
    expect(after.authorizationServer).toBe(otherAs.issuer);
    expect(after.tokenEndpoint).toBe(`${otherAs.issuer}/token`);
    expect(after.revocationEndpoint).toBe(`${otherAs.issuer}/revoke`);
    // Promoted TOGETHER with the tokens: the client that authorized there and
    // the issuer it was registered at, never a mix of two registrations.
    expect(after.clientRegistrationIssuer).toBe(otherAs.issuer);
    expect(after.clientId).not.toBe(before.clientId);
    expect(after.accessTokenEncrypted).not.toBe(before.accessTokenEncrypted);
    const accessToken = decryptEnvelope(
      after.accessTokenEncrypted!,
      "access_token",
      after.id,
    );
    expect(otherAs.issuedAccessTokens).toContain(accessToken);
  });

  test("a declined consent leaves a first-time grant in error, not connected", async () => {
    const { id, startPath } = await createOauthConnection("Declined");
    const authorizeUrl = await startFlow(startPath);
    const state = authorizeUrl.searchParams.get("state")!;

    // The AS redirects back with an RFC 6749 error instead of a code.
    const res = await api(
      "GET",
      `/integrations/mcp-oauth/callback?error=access_denied&iss=${encodeURIComponent(as.issuer)}&state=${encodeURIComponent(state)}`,
      { cookie: ownerCookie },
    );
    const page = await res.text();
    expect(page).toContain('"ok":false');
    expect(page).toContain('"reason":"oauth_exchange_failed"');

    const row = (await oauthRow(id))!;
    expect(row.status).toBe("error");
    expect(row.lastErrorCode).toBe("oauth_exchange_failed");
    expect(row.accessTokenEncrypted).toBeNull();
  });

  // ── RFC 9207 issuer validation (fix plan F13) ─────────────────────────────

  test("an authorization response from a different issuer is never exchanged", async () => {
    const { id, startPath } = await createOauthConnection("Issuer Mixup");
    const authorizeUrl = await startFlow(startPath);

    as.issMode = "foreign";
    let callbackPath: string;
    try {
      callbackPath = await approveConsent(authorizeUrl);
    } finally {
      as.issMode = "correct";
    }
    expect(new URLSearchParams(callbackPath.split("?")[1]).get("iss")).toBe(
      FOREIGN_ISSUER,
    );

    const exchangesBefore = as.tokenRequests.length;
    const res = await api("GET", callbackPath, { cookie: ownerCookie });
    const page = await res.text();
    expect(page).toContain('"ok":false');
    expect(page).toContain('"reason":"oauth_exchange_failed"');
    // The decisive part: the code never reached the token endpoint.
    expect(as.tokenRequests.length).toBe(exchangesBefore);
    // Nor does the failure page echo the attacker-supplied issuer.
    expect(page).not.toContain(FOREIGN_ISSUER);

    const row = (await oauthRow(id))!;
    expect(row.status).toBe("error");
    expect(row.accessTokenEncrypted).toBeNull();
  });

  test("a missing iss fails only when the server advertises it sends one", async () => {
    // Advertised and omitted → refused: an attacker must not defeat the check
    // by simply stripping the parameter.
    const promised = await createOauthConnection("Iss Omitted");
    const promisedUrl = await startFlow(promised.startPath);
    as.issMode = "omit";
    try {
      const callbackPath = await approveConsent(promisedUrl);
      expect(callbackPath).not.toContain("iss=");
      const exchangesBefore = as.tokenRequests.length;
      const res = await api("GET", callbackPath, { cookie: ownerCookie });
      expect(await res.text()).toContain('"ok":false');
      expect(as.tokenRequests.length).toBe(exchangesBefore);
      expect((await oauthRow(promised.id))!.status).toBe("error");

      // Not advertised and omitted → fine. Most conformant servers send no
      // `iss` at all, and requiring one unconditionally would break them.
      as.issParameterSupported = false;
      const quiet = await createOauthConnection("Iss Not Advertised");
      const quietUrl = await startFlow(quiet.startPath);
      // Not advertised reads as NULL — "unknown", which is the same
      // permissive branch as an explicit false and is why the column is
      // nullable rather than defaulting.
      expect((await oauthRow(quiet.id))!.issParameterSupported).toBeNull();
      const quietCallback = await approveConsent(quietUrl);
      const ok = await api("GET", quietCallback, { cookie: ownerCookie });
      expect(await ok.text()).toContain('"ok":true');
      expect((await oauthRow(quiet.id))!.status).toBe("connected");
    } finally {
      as.issMode = "correct";
      as.issParameterSupported = true;
    }
  });

  // ── initiator binding (fix plan F15) ──────────────────────────────────────

  test("only the admin who started a flow can complete it", async () => {
    const { id, startPath } = await createOauthConnection("Initiator Bound");
    const authorizeUrl = await startFlow(startPath);
    const state = authorizeUrl.searchParams.get("state")!;
    const callbackPath = await approveConsent(authorizeUrl);

    // A SECOND admin of the same workspace: authorized to manage the
    // connection, and still not the person this consent belongs to.
    const other = await signUpWithOrg("Second Admin");
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: other.userId,
      role: "admin",
      createdAt: new Date(),
    });

    const exchangesBefore = as.tokenRequests.length;
    const foreign = await api("GET", callbackPath, { cookie: other.cookie });
    const page = await foreign.text();
    expect(page).toContain('"ok":false');
    expect(page).toContain('"reason":"not_initiator"');
    expect(as.tokenRequests.length).toBe(exchangesBefore);
    // Rejected BEFORE the claim, so the initiator's single-use state is intact.
    expect((await oauthRow(id))!.pendingState).toBe(state);

    const legit = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await legit.text()).toContain('"ok":true');
    const row = (await oauthRow(id))!;
    expect(row.status).toBe("connected");
    expect(row.connectedBy).toBe(ownerUserId);
  });

  // ── pre-registered client identity (fix plan P2 option b) ─────────────────

  test("a preregistered preset authorizes with the operator's client and never registers", async () => {
    const create = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: { source: "catalog", slug: "stub-oauth-preregistered" },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as CreateConnectionResponse;
    const id = created.connection.id;

    // The authorization server refuses DCR outright, exactly as the provider
    // that forced this feature does — so any attempt to register is fatal,
    // and a start that succeeds proves none was made.
    // This preset has its OWN resource nominating `otherAs`, so the pin is
    // exact-matched there and no custom connection in this file inherits it.
    const registrationsBefore = otherAs.registerRequests.length;
    otherAs.registrationMode = "forbidden";
    let authorizeUrl: URL;
    try {
      authorizeUrl = await startFlow(created.oauthStartPath!);
    } finally {
      otherAs.registrationMode = "ok";
    }
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      PREREGISTERED_CLIENT_ID,
    );
    expect(otherAs.registerRequests.length).toBe(registrationsBefore);

    // Staged with the flow, like every other identity — the grant's own
    // client columns stay blank until an exchange succeeds.
    const armed = (await oauthRow(id))!;
    expect(armed.pendingFlow!.clientIdentityMode).toBe("preregistered");
    expect(armed.pendingFlow!.clientId).toBe(PREREGISTERED_CLIENT_ID);
    expect(armed.pendingFlow!.clientRegistrationIssuer).toBe(otherAs.issuer);
    expect(armed.clientId).toBeNull();
    // The operator's secret is at rest as an envelope, never in the clear.
    expect(armed.pendingFlow!.clientSecretEncrypted).not.toBeNull();
    expect(armed.pendingFlow!.clientSecretEncrypted).not.toContain(
      "preapproved-client-secret",
    );

    // And the flow completes end to end on that identity, promoting it.
    const callbackPath = await approveConsent(authorizeUrl);
    const res = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await res.text()).toContain('"ok":true');
    const connected = (await oauthRow(id))!;
    expect(connected.status).toBe("connected");
    expect(connected.clientIdentityMode).toBe("preregistered");
    expect(connected.clientId).toBe(PREREGISTERED_CLIENT_ID);
    expect(connected.clientRegistrationIssuer).toBe(otherAs.issuer);
    expect(connected.clientSecretEncrypted).not.toContain(
      "preapproved-client-secret",
    );
    expect(otherAs.tokenRequests.at(-1)!.get("client_id")).toBe(
      PREREGISTERED_CLIENT_ID,
    );
  });

  /**
   * The callback's optimistic-concurrency guard (2026-08-31 review).
   *
   * The claim on `pending_state` is a proper compare-and-swap, so a REPLAY dies
   * there. It does not protect the window AFTER it: the code exchange is a
   * network round trip, and the connection stays mutable throughout. A URL
   * change resets this grant, and the promotion's original bare `where(id)`
   * would then have written the finished flow's tokens AND endpoints back onto
   * the reset row as `connected` — a token issued by one authorization server,
   * sitting on a row now addressed at a different one, which the next probe or
   * agent tool call would present there.
   */
  test("a callback that loses its race to a URL change discards its tokens", async () => {
    const { id, startPath } = await createOauthConnection("Superseded");
    const authorizeUrl = await startFlow(startPath);
    const callbackPath = await approveConsent(authorizeUrl);

    // Mutate the connection WHILE the broker is at the token endpoint — the
    // one window the state CAS cannot cover.
    let patched = false;
    as.beforeToken = async () => {
      if (patched) return;
      patched = true;
      const res = await api("PATCH", `/workspaces/${orgId}/connections/${id}`, {
        cookie: ownerCookie,
        body: { url: resource.mcpUrl.replace("/mcp", "/mcp-moved") },
      });
      expect(res.status).toBe(200);
    };
    let callback: Response;
    try {
      callback = await api("GET", callbackPath, { cookie: ownerCookie });
    } finally {
      as.beforeToken = undefined;
    }
    expect(patched).toBeTrue();

    // The popup still renders (callback failures are never JSON errors), and
    // it carries the typed reason.
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("oauth_flow_superseded");

    // Decisively: nothing from the dead flow reached the row. It was reset by
    // the PATCH and must stay reset — no tokens, no endpoints, not connected.
    const after = (await oauthRow(id))!;
    expect(after.status).not.toBe("connected");
    expect(after.accessTokenEncrypted).toBeNull();
    expect(after.refreshTokenEncrypted).toBeNull();
    expect(after.tokenEndpoint).toBeNull();
  });

  // ── authz ─────────────────────────────────────────────────────────────────

  test("start routes enforce the authz matrix", async () => {
    const { startPath } = await createOauthConnection("Authz Matrix");

    // Anonymous → 401.
    expect((await api("POST", startPath)).status).toBe(401);

    // Outsider (their own active workspace ≠ path workspace) → 403.
    const stranger = await signUpWithOrg("OAuth Stranger");
    expect((await api("POST", startPath, { cookie: stranger.cookie })).status).toBe(
      403,
    );

    // Plain member → 403 (mutations are owner/admin-gated).
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.member.userId, ownerUserId),
          eq(schema.member.organizationId, orgId),
        ),
      );
    try {
      expect((await api("POST", startPath, { cookie: ownerCookie })).status).toBe(
        403,
      );
    } finally {
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(
          and(
            eq(schema.member.userId, ownerUserId),
            eq(schema.member.organizationId, orgId),
          ),
        );
    }

    // User scope: the owner's /me connection starts fine; a stranger 404s.
    const meCreate = await api("POST", "/me/connections", {
      cookie: ownerCookie,
      body: {
        source: "custom",
        name: "Me OAuth",
        url: resource.mcpUrl,
        auth: { type: "oauth" },
      },
    });
    expect(meCreate.status).toBe(201);
    const meBody = (await meCreate.json()) as CreateConnectionResponse;
    expect(meBody.oauthStartPath).toBe(
      `/me/connections/${meBody.connection.id}/oauth/start`,
    );
    const meStart = await api("POST", meBody.oauthStartPath!, {
      cookie: ownerCookie,
    });
    expect(meStart.status).toBe(200);
    const foreign = await api("POST", meBody.oauthStartPath!, {
      cookie: stranger.cookie,
    });
    expect(foreign.status).toBe(404);
  });

  test("callback is session-bound: outsiders can neither complete nor burn a flow", async () => {
    const { id, startPath } = await createOauthConnection("Callback Authz");
    const authorizeUrl = await startFlow(startPath);
    const callbackPath = await approveConsent(authorizeUrl);
    const state = authorizeUrl.searchParams.get("state")!;

    // Anonymous → failure page, flow untouched.
    const anon = await api("GET", callbackPath);
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain('"ok":false');

    // Authenticated outsider → failure page, no exchange, state NOT burned.
    const stranger = await signUpWithOrg("Callback Stranger");
    const exchangesBefore = as.tokenRequests.length;
    const foreign = await api("GET", callbackPath, { cookie: stranger.cookie });
    expect(await foreign.text()).toContain('"ok":false');
    expect(as.tokenRequests.length).toBe(exchangesBefore);
    const row = (await oauthRow(id))!;
    expect(row.pendingState).toBe(state);
    expect(row.accessTokenEncrypted).toBeNull();

    // The legitimate admin still completes the same flow.
    const legit = await api("GET", callbackPath, { cookie: ownerCookie });
    expect(await legit.text()).toContain('"ok":true');
    expect((await oauthRow(id))!.status).toBe("connected");
  });
});
