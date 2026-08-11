/**
 * OAuth consent broker integration tests (connectors redesign Plan 3 Task 5)
 * — gated on TEST_DATABASE_URL (skip cleanly when unset; the compose
 * integration stage provides it).
 *
 * Drives the full HTTP surface against an in-process stub authorization
 * server (stub-as.ts) and a stub OAuth-protected MCP resource:
 * start → consent → callback happy path (encrypted tokens, `connected`,
 * post-connect probe), single-use/expired/superseded `state`, exchange
 * rejection landing `status: error`, oauth-enabled creates (custom + catalog
 * recipe), and the authz matrix on the start routes + the session-bound
 * callback.
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
import { StubAuthorizationServer } from "./stub-as";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const MASTER_KEY = parseMasterKey(MASTER_KEY_B64);

// ── stub OAuth-protected MCP resource ────────────────────────────────────────
//
// `GET /mcp` answers 401 with the RFC 9728 `WWW-Authenticate`
// `resource_metadata` pointer (exercising discovery's pointer-first path);
// the PRM lives at the path-aware well-known and names the stub AS. Every
// /mcp hit is counted so tests can observe the post-connect probe firing.

class StubResource {
  mcpHits = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(asIssuer: string): void {
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          this.mcpHits += 1;
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: this.mcpUrl,
            authorization_servers: [asIssuer],
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
  const resource = new StubResource();
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
  ): Promise<{ id: string; startPath: string }> {
    const res = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: {
        source: "custom",
        name,
        url: resource.mcpUrl,
        auth: { type: "oauth" },
      },
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
    resource.start(as.issuer);
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
      },
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts: createMemoryArtifactStore(),
        catalog: new Map([[catalogEntry.slug, catalogEntry]]),
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
    resource.stop();
  }, 30_000);

  // ── oauth-enabled creates ─────────────────────────────────────────────────

  test("custom create with oauth auth yields a pending grant row and a start path", async () => {
    const { id, startPath } = await createOauthConnection("Custom OAuth");
    expect(startPath).toBe(`/workspaces/${orgId}/connections/${id}/oauth/start`);

    const get = await api("GET", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
    });
    const dto = ((await get.json()) as CreateConnectionResponse).connection;
    expect(dto.authType).toBe("oauth");
    expect(dto.hasCredentials).toBeTrue();

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
    expect(params.get("scope")).toBe("mcp.read mcp.write");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    const state = params.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(22);

    // Base URL is http://localhost — CIMD unusable, so the broker registered
    // a DCR client and uses its id.
    expect(as.registerRequests.length).toBe(registrationsBefore + 1);
    expect(params.get("client_id")).toMatch(/^dcr-client-/);

    // Discovery results + the pending flow persisted on the row; the stored
    // verifier hashes to the code_challenge in the URL (S256).
    const pending = (await oauthRow(id))!;
    expect(pending.authorizationServer).toBe(as.issuer);
    expect(pending.authorizationEndpoint).toBe(`${as.issuer}/authorize`);
    expect(pending.tokenEndpoint).toBe(`${as.issuer}/token`);
    expect(pending.resource).toBe(resource.mcpUrl);
    expect(pending.revocationEndpoint).toBe(`${as.issuer}/revoke`);
    expect(pending.pendingState).toBe(state);
    expect(pending.pendingExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const verifier = decryptEnvelope(
      pending.pendingCodeVerifierEncrypted!,
      "pending_code_verifier",
      pending.id,
    );
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      params.get("code_challenge")!,
    );

    const probeHitsBefore = resource.mcpHits;
    const callbackPath = await approveConsent(authorizeUrl);
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
    expect(page).toContain(JSON.stringify(BASE_URL));

    const connected = (await oauthRow(id))!;
    expect(connected.status).toBe("connected");
    expect(connected.connectedBy).toBe(ownerUserId);
    expect(connected.pendingState).toBeNull();
    expect(connected.pendingCodeVerifierEncrypted).toBeNull();
    expect(connected.pendingExpiresAt).toBeNull();
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

    // The post-connect probe fired (fire-and-forget — poll for the hit).
    await until(
      async () => resource.mcpHits > probeHitsBefore,
      "post-connect probe to hit the stub resource",
    );
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
    // The DCR registration is reused, not repeated, on a re-start.
    expect(as.registerRequests.length).toBe(registrationsAfterFirst);

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
      expect(await res.text()).toContain('"ok":false');
    } finally {
      as.tokenMode = "ok";
    }

    const row = (await oauthRow(id))!;
    expect(row.status).toBe("error");
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.pendingState).toBeNull();
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
