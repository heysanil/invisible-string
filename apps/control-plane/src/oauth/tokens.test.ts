/**
 * Token lifecycle integration tests (connectors redesign Plan 3 Task 6) —
 * gated on TEST_DATABASE_URL (skip cleanly when unset; the compose
 * integration stage provides it).
 *
 * Exercises `getAccessToken` directly against rows the REAL consent flow
 * produced (stub AS + stub OAuth-protected resource, exactly the broker
 * suite's rig): expiry-margin logic, refresh with rotation persisted,
 * `invalid_grant` landing `expired` + connection `auth_error`, transactional
 * single-flight (two concurrent calls → ONE refresh), and the mutation
 * transitions on the HTTP surface (auth-type change off oauth revokes +
 * deletes the grant row; custom URL change revokes + resets to `pending`;
 * connection delete revokes best-effort).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  generateMasterKeyBase64,
  parseMasterKey,
  type CreateConnectionResponse,
  type EncryptedEnvelope,
  type GetConnectionResponse,
  type StartOauthResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createAppStack, type AppStack } from "../index";
import { runMigrations } from "../migrate";
import { createGuardedFetch } from "../net/guarded-fetch";
import { isRuntimeApiError } from "../runtime/errors";
import { connectionOauthAad } from "./client-identity";
import { StubAuthorizationServer } from "./stub-as";
import { getAccessToken, type TokenLifecycleDeps } from "./tokens";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const MASTER_KEY = parseMasterKey(MASTER_KEY_B64);

// ── stub OAuth-protected MCP resource (broker.test.ts idiom) ─────────────────

class StubResource {
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(asIssuer: string): void {
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
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

// Cheap publish stubs — only the seeded-workspace publish runs here.
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

/** Await a rejection and return its typed `{code, status}` (or null). */
async function apiErrorOf(
  promise: Promise<unknown>,
): Promise<{ code: string; status: number } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (isRuntimeApiError(error)) {
      return { code: error.code, status: error.status };
    }
    throw error;
  }
}

function decryptEnvelope(
  serialized: string,
  column: "access_token" | "refresh_token",
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
    "[oauth-tokens] TEST_DATABASE_URL not set — skipping token lifecycle tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("oauth token lifecycle", () => {
  const as = new StubAuthorizationServer();
  const resource = new StubResource();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  let deps: TokenLifecycleDeps;

  let ownerCookie: string;
  let orgId: string;

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

  /** Create a custom oauth connection and run the FULL consent flow. */
  async function connectFlow(name: string): Promise<string> {
    const create = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: {
        source: "custom",
        name,
        url: resource.mcpUrl,
        auth: { type: "oauth" },
      },
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as CreateConnectionResponse;
    const start = await api("POST", body.oauthStartPath!, { cookie: ownerCookie });
    expect(start.status).toBe(200);
    const { authorizeUrl } = (await start.json()) as StartOauthResponse;
    const consent = await fetch(authorizeUrl, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get("location")!);
    const callback = await api(
      "GET",
      `${location.pathname}${location.search}`,
      { cookie: ownerCookie },
    );
    expect(await callback.text()).toContain('"ok":true');
    const row = (await oauthRow(body.connection.id))!;
    expect(row.status).toBe("connected");
    return body.connection.id;
  }

  /** Force the stored access token's expiry to `msFromNow`. */
  async function setExpiry(connectionId: string, msFromNow: number | null) {
    await db
      .update(schema.connectionOauth)
      .set({
        accessTokenExpiresAt:
          msFromNow === null ? null : new Date(Date.now() + msFromNow),
      })
      .where(eq(schema.connectionOauth.connectionId, connectionId));
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    as.start();
    resource.start(as.issuer);
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "oauth-tokens-secret-0000000000000",
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
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-oauth-token-builds"),
        // Stub AS + resource live on 127.0.0.1 over http — the guarded egress
        // fetch must admit them (same var the probe lane documents).
        MCP_PROBE_ALLOW_PRIVATE: "1",
      },
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts: createMemoryArtifactStore(),
      },
    );
    db = stack.dbHandle.db;
    deps = {
      db,
      masterKey: MASTER_KEY,
      publicAppUrl: BASE_URL,
      fetchImpl: createGuardedFetch({ allowPrivate: true }),
      logger: stack.logger,
    };

    const email = `tokens-${randomUUID()}@example.com`;
    const signup = await stack.app.handle(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "correct-horse-battery",
          name: "Token Owner",
        }),
      }),
    );
    expect(signup.status).toBe(200);
    ownerCookie = signup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const headers = new Headers({ cookie: ownerCookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: "Tokens ws", slug: `ws-${randomUUID().slice(0, 8)}` },
      headers,
    });
    await stack.auth.api.setActiveOrganization({
      body: { organizationId: org!.id },
      headers,
    });
    orgId = org!.id;
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
    as.stop();
    resource.stop();
  }, 30_000);

  // ── expiry-margin logic ───────────────────────────────────────────────────

  test("a fresh token is returned untouched — no refresh request", async () => {
    const id = await connectFlow("Fresh Token");
    const before = (await oauthRow(id))!;
    const stored = decryptEnvelope(
      before.accessTokenEncrypted!,
      "access_token",
      before.id,
    );
    const hitsBefore = as.tokenRequests.length;

    const result = await getAccessToken(deps, id);
    expect(result.token).toBe(stored);
    expect(result.expiresAt.getTime()).toBe(
      before.accessTokenExpiresAt!.getTime(),
    );
    expect(as.tokenRequests.length).toBe(hitsBefore);

    // Row untouched — same envelope, same refresh token.
    const after = (await oauthRow(id))!;
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
  });

  test("a token with no recorded expiry is returned with an advisory expiry", async () => {
    const id = await connectFlow("No Expiry");
    await setExpiry(id, null);
    const hitsBefore = as.tokenRequests.length;

    const result = await getAccessToken(deps, id);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(as.tokenRequests.length).toBe(hitsBefore);
  });

  test("a token expiring inside the 60 s margin refreshes; outside it does not", async () => {
    const id = await connectFlow("Margin");

    // 120 s out: beyond the margin — untouched.
    await setExpiry(id, 120_000);
    const hitsBefore = as.tokenRequests.length;
    await getAccessToken(deps, id);
    expect(as.tokenRequests.length).toBe(hitsBefore);

    // 30 s out: inside the margin — refreshed.
    await setExpiry(id, 30_000);
    const result = await getAccessToken(deps, id);
    expect(as.tokenRequests.length).toBe(hitsBefore + 1);
    expect(result.token).toBe(as.issuedAccessTokens.at(-1)!);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  // ── refresh + rotation ────────────────────────────────────────────────────

  test("a stale token refreshes over the wire and persists the rotated pair", async () => {
    const id = await connectFlow("Stale Refresh");
    const before = (await oauthRow(id))!;
    const oldAccess = decryptEnvelope(
      before.accessTokenEncrypted!,
      "access_token",
      before.id,
    );
    const oldRefresh = decryptEnvelope(
      before.refreshTokenEncrypted!,
      "refresh_token",
      before.id,
    );
    await setExpiry(id, -1_000); // already expired

    const result = await getAccessToken(deps, id);
    expect(result.token).not.toBe(oldAccess);
    expect(result.token).toBe(as.issuedAccessTokens.at(-1)!);

    // The wire request was a refresh grant carrying the old refresh token,
    // the RFC 8707 resource, and the registered client id.
    const refresh = as.tokenRequests.at(-1)!;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe(oldRefresh);
    expect(refresh.get("resource")).toBe(resource.mcpUrl);
    expect(refresh.get("client_id")).toBe(before.clientId!);

    // Rotation persisted: new access token AND the new refresh token.
    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(
      decryptEnvelope(after.accessTokenEncrypted!, "access_token", after.id),
    ).toBe(result.token);
    const newRefresh = decryptEnvelope(
      after.refreshTokenEncrypted!,
      "refresh_token",
      after.id,
    );
    expect(newRefresh).not.toBe(oldRefresh);
    expect(newRefresh).toBe(as.issuedRefreshTokens.at(-1)!);
    expect(after.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBe(
      after.accessTokenExpiresAt!.getTime(),
    );

    // The rotated pair keeps working: expire again, refresh again.
    await setExpiry(id, -1_000);
    const again = await getAccessToken(deps, id);
    expect(again.token).toBe(as.issuedAccessTokens.at(-1)!);
  });

  test("invalid_grant on refresh lands expired + auth_error and throws oauth_not_connected", async () => {
    const id = await connectFlow("Invalid Grant");
    await setExpiry(id, -1_000);

    as.tokenMode = "invalid_grant";
    try {
      expect(await apiErrorOf(getAccessToken(deps, id))).toEqual({
        code: "oauth_not_connected",
        status: 409,
      });
    } finally {
      as.tokenMode = "ok";
    }

    const row = (await oauthRow(id))!;
    expect(row.status).toBe("expired");
    const conn = (await connectionRow(id))!;
    expect(conn.health).toBe("auth_error");

    // The grant is dead even now that the AS recovered: still 409.
    expect(await apiErrorOf(getAccessToken(deps, id))).toEqual({
      code: "oauth_not_connected",
      status: 409,
    });
  });

  test("a never-connected (pending) grant throws oauth_not_connected", async () => {
    const create = await api("POST", `/workspaces/${orgId}/connections`, {
      cookie: ownerCookie,
      body: {
        source: "custom",
        name: "Pending Grant",
        url: resource.mcpUrl,
        auth: { type: "oauth" },
      },
    });
    const body = (await create.json()) as CreateConnectionResponse;
    expect(await apiErrorOf(getAccessToken(deps, body.connection.id))).toEqual({
      code: "oauth_not_connected",
      status: 409,
    });
  });

  // ── single-flight ─────────────────────────────────────────────────────────

  test("two concurrent calls on a stale token produce exactly ONE refresh", async () => {
    const id = await connectFlow("Single Flight");
    await setExpiry(id, -1_000);
    const hitsBefore = as.tokenRequests.length;

    const [a, b] = await Promise.all([
      getAccessToken(deps, id),
      getAccessToken(deps, id),
    ]);
    expect(a.token).toBe(b.token);
    expect(a.token).toBe(as.issuedAccessTokens.at(-1)!);
    expect(as.tokenRequests.length).toBe(hitsBefore + 1);
  });

  // ── mutation transitions ──────────────────────────────────────────────────

  test("PATCH switching auth off oauth revokes the grant and deletes the row", async () => {
    const id = await connectFlow("Auth Switch");
    const before = (await oauthRow(id))!;
    const refreshToken = decryptEnvelope(
      before.refreshTokenEncrypted!,
      "refresh_token",
      before.id,
    );
    const revokesBefore = as.revokeRequests.length;

    const patch = await api("PATCH", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
      body: { auth: { type: "bearer", values: { token: "sk-static" } } },
    });
    expect(patch.status).toBe(200);
    const dto = ((await patch.json()) as GetConnectionResponse).connection;
    expect(dto.authType).toBe("bearer");

    // Revocation hit the AS with the refresh token (RFC 7009), and the grant
    // row is gone.
    expect(as.revokeRequests.length).toBe(revokesBefore + 1);
    const revoke = as.revokeRequests.at(-1)!;
    expect(revoke.get("token")).toBe(refreshToken);
    expect(revoke.get("token_type_hint")).toBe("refresh_token");
    expect(await oauthRow(id)).toBeUndefined();
  });

  test("custom URL change on an oauth connection revokes and resets the grant to pending", async () => {
    const id = await connectFlow("Url Change");
    const before = (await oauthRow(id))!;
    const revokesBefore = as.revokeRequests.length;

    const patch = await api("PATCH", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
      body: { url: `${resource.origin}/mcp-elsewhere` },
    });
    expect(patch.status).toBe(200);

    expect(as.revokeRequests.length).toBe(revokesBefore + 1);
    const row = (await oauthRow(id))!;
    expect(row.id).toBe(before.id); // same grant row, reset in place
    expect(row.status).toBe("pending");
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(row.accessTokenExpiresAt).toBeNull();
    // Discovery + client registration belong to the OLD resource/AS — cleared.
    expect(row.authorizationServer).toBeNull();
    expect(row.tokenEndpoint).toBeNull();
    expect(row.resource).toBeNull();
    expect(row.revocationEndpoint).toBeNull();
    expect(row.clientId).toBeNull();
    expect(row.clientSecretEncrypted).toBeNull();
    expect(row.pendingState).toBeNull();
    expect(row.connectedBy).toBeNull();
  });

  test("a rename PATCH leaves the grant untouched", async () => {
    const id = await connectFlow("Harmless Rename");
    const before = (await oauthRow(id))!;
    const revokesBefore = as.revokeRequests.length;

    const patch = await api("PATCH", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
      body: { name: "Harmless Renamed" },
    });
    expect(patch.status).toBe(200);
    expect(as.revokeRequests.length).toBe(revokesBefore);
    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
  });

  test("connection delete revokes the grant best-effort", async () => {
    const id = await connectFlow("Delete Me");
    const before = (await oauthRow(id))!;
    const refreshToken = decryptEnvelope(
      before.refreshTokenEncrypted!,
      "refresh_token",
      before.id,
    );
    const revokesBefore = as.revokeRequests.length;

    const del = await api("DELETE", `/workspaces/${orgId}/connections/${id}`, {
      cookie: ownerCookie,
    });
    expect(del.status).toBe(200);
    expect(as.revokeRequests.length).toBe(revokesBefore + 1);
    expect(as.revokeRequests.at(-1)!.get("token")).toBe(refreshToken);
    expect(await oauthRow(id)).toBeUndefined();
    expect(await connectionRow(id)).toBeUndefined();
  });
});
