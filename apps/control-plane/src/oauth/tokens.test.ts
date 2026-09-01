/**
 * Token lifecycle integration tests (connectors redesign Plan 3 Task 6) —
 * gated on TEST_DATABASE_URL (skip cleanly when unset; the compose
 * integration stage provides it).
 *
 * Exercises `getAccessToken` directly against rows the REAL consent flow
 * produced (stub AS + stub OAuth-protected resource, exactly the broker
 * suite's rig): expiry-margin logic, refresh with rotation persisted,
 * TRANSIENT refresh failures leaving the grant `connected` and retryable
 * (fix plan F4), `invalid_grant` landing `expired` + connection `auth_error`,
 * transactional single-flight (two concurrent calls → ONE refresh), and the
 * mutation transitions on the HTTP surface (auth-type change off oauth
 * revokes + deletes the grant row; custom URL change revokes + resets to
 * `pending`; connection delete revokes best-effort).
 *
 * RIG NOTE — the consent callback leaves a background writer behind. The
 * broker fires the post-connect probe with `void` and answers the popup
 * immediately (broker.ts, spec §7), so `connectFlow` below waits for that task
 * to LAND before returning: it writes `connections.health`/`last_checked_at`
 * and it is itself a `getAccessToken` caller, so anything left in flight races
 * both the health assertions and the stub AS's request counters here.
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
/**
 * How long `connectFlow` waits for the post-connect probe to commit. The probe
 * dials 127.0.0.1 and is answered instantly, so this is pure headroom; it sits
 * under bun's 5 s per-test default deliberately, so a probe that never fires
 * surfaces as this file's explanatory error rather than a bare test timeout.
 */
const PROBE_SETTLE_TIMEOUT_MS = 4_000;

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
    await awaitPostConnectProbe(body.connection.id);
    return body.connection.id;
  }

  /**
   * Block until the broker's fire-and-forget post-connect probe has finished
   * writing, so nothing this suite asserts can be moved by it afterwards.
   *
   * `last_checked_at` is the honest witness: an oauth row is created WITHOUT a
   * probe (resources/connections.ts skips oauth at create — fix plan F10/F11),
   * so the column is null until `probeAndPersist` writes it, and it writes it
   * on EVERY outcome. Its arrival therefore means "the probe committed", which
   * is the only moment after which `connections.health` is stable and the
   * probe's own `getAccessToken` call can no longer spend a refresh at the
   * stub AS.
   *
   * A timeout here is a real failure — the probe not firing at all is a
   * regression this rig should shout about, not silently tolerate — so it
   * throws rather than falling through.
   */
  async function awaitPostConnectProbe(connectionId: string): Promise<void> {
    const deadline = Date.now() + PROBE_SETTLE_TIMEOUT_MS;
    for (;;) {
      if ((await connectionRow(connectionId))?.lastCheckedAt) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `post-connect probe never landed for ${connectionId} — last_checked_at still null after ${PROBE_SETTLE_TIMEOUT_MS}ms`,
        );
      }
      await Bun.sleep(5);
    }
  }

  /**
   * Force the connection's probe-derived health, the way {@link setExpiry}
   * forces the stored expiry: it arranges a precondition the rig cannot reach
   * honestly. Safe only AFTER the post-connect probe settled (see above) —
   * before that the probe would overwrite it.
   */
  async function setHealth(
    connectionId: string,
    health: (typeof schema.connections.$inferSelect)["health"],
  ) {
    await db
      .update(schema.connections)
      .set({ health, lastError: null })
      .where(eq(schema.connections.id, connectionId));
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

  /**
   * Wrap the guarded egress fetch so the first `failures` POSTs to the stub
   * AS's token endpoint fail the way a real blip does. The request never
   * reaches the AS, so the stored refresh token is NOT consumed and stays
   * perfectly usable — which is exactly what makes these failures transient
   * and `invalid_grant` the only terminal one. `mode` covers both shapes the
   * refresh path types as `oauth_exchange_failed`: an AS 5xx and a dead
   * socket (what the egress timeout looks like to the caller).
   *
   * The stub AS itself is left alone: it has no transient mode, and this rig
   * needs the failure to happen strictly BEFORE the AS sees the grant.
   */
  function flakyTokenEndpoint(
    failures: number,
    mode: "http_503" | "network",
  ): { fetchImpl: typeof fetch; attempts: () => number } {
    const inner = deps.fetchImpl;
    const tokenEndpoint = `${as.issuer}/token`;
    let attempts = 0;
    const impl = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const [input] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === tokenEndpoint && attempts++ < failures) {
        if (mode === "network") throw new Error("socket hang up");
        return Response.json(
          { error: "temporarily_unavailable" },
          { status: 503 },
        );
      }
      return inner(...args);
    };
    return { fetchImpl: impl as typeof fetch, attempts: () => attempts };
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

  test("a transient refresh failure leaves the grant connected — the next demand refreshes for real", async () => {
    const id = await connectFlow("Transient Blip");
    const before = (await oauthRow(id))!;
    const refreshToken = decryptEnvelope(
      before.refreshTokenEncrypted!,
      "refresh_token",
      before.id,
    );
    // Arrange a health a terminal failure would visibly destroy. The settled
    // post-connect probe left `auth_error` (the stub resource 401s every MCP
    // dial), which is the exact value `markExpired` writes — snapshotting THAT
    // would make the assertion below unfalsifiable. `ok` is also the case that
    // actually matters in production: a 30 s blip at the authorization server
    // must not flip a working connector's badge to "reconnect".
    await setHealth(id, "ok");
    const asHitsBefore = as.tokenRequests.length;
    await setExpiry(id, -1_000);

    // A 503 at the AS is NOT the AS disowning the grant.
    const flaky = flakyTokenEndpoint(1, "http_503");
    let message = "";
    try {
      await getAccessToken({ ...deps, fetchImpl: flaky.fetchImpl }, id);
      throw new Error("expected the transient refresh to reject");
    } catch (error) {
      expect(isRuntimeApiError(error)).toBe(true);
      const api = error as { code: string; status: number; message: string };
      expect({ code: api.code, status: api.status }).toEqual({
        code: "oauth_exchange_failed",
        status: 502,
      });
      message = api.message;
    }
    expect(flaky.attempts()).toBe(1);
    expect(as.tokenRequests.length).toBe(asHitsBefore); // never reached the AS
    // Secrets discipline: the typed error carries a status, never a token.
    expect(message).not.toContain(refreshToken);

    // The grant is untouched — status, both envelopes, and the connection's
    // health. Nothing here requires a re-consent.
    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
    const conn = (await connectionRow(id))!;
    expect(conn.health).toBe("ok");
    expect(conn.lastError).toBeNull();

    // The very next demand refreshes with the still-valid material and
    // persists the rotation.
    const result = await getAccessToken(deps, id);
    expect(result.token).toBe(as.issuedAccessTokens.at(-1)!);
    expect(as.tokenRequests.length).toBe(asHitsBefore + 1);
    expect(as.tokenRequests.at(-1)!.get("refresh_token")).toBe(refreshToken);
    const recovered = (await oauthRow(id))!;
    expect(recovered.status).toBe("connected");
    expect(
      decryptEnvelope(recovered.accessTokenEncrypted!, "access_token", recovered.id),
    ).toBe(result.token);
    expect(
      decryptEnvelope(
        recovered.refreshTokenEncrypted!,
        "refresh_token",
        recovered.id,
      ),
    ).toBe(as.issuedRefreshTokens.at(-1)!);
  });

  test("an unreachable token endpoint is transient too — no status write, retry succeeds", async () => {
    const id = await connectFlow("Transient Timeout");
    const before = (await oauthRow(id))!;
    await setExpiry(id, -1_000);

    const flaky = flakyTokenEndpoint(1, "network");
    expect(
      await apiErrorOf(
        getAccessToken({ ...deps, fetchImpl: flaky.fetchImpl }, id),
      ),
    ).toEqual({ code: "oauth_exchange_failed", status: 502 });
    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);

    const result = await getAccessToken(deps, id);
    expect(result.token).toBe(as.issuedAccessTokens.at(-1)!);
  });

  test("a sustained outage fails every concurrent caller without disturbing the grant", async () => {
    const id = await connectFlow("Sustained Outage");
    const before = (await oauthRow(id))!;
    const asHitsBefore = as.tokenRequests.length;
    await setExpiry(id, -1_000);

    // Nothing dedupes a FAILED refresh — the winner of the row lock writes no
    // token for the loser to re-read — so both callers legitimately try, and
    // both must fail without spending the grant.
    const flaky = flakyTokenEndpoint(Number.MAX_SAFE_INTEGER, "http_503");
    const outageDeps = { ...deps, fetchImpl: flaky.fetchImpl };
    const results = await Promise.all([
      apiErrorOf(getAccessToken(outageDeps, id)),
      apiErrorOf(getAccessToken(outageDeps, id)),
    ]);
    expect(results).toEqual([
      { code: "oauth_exchange_failed", status: 502 },
      { code: "oauth_exchange_failed", status: 502 },
    ]);
    expect(as.tokenRequests.length).toBe(asHitsBefore);

    const after = (await oauthRow(id))!;
    expect(after.status).toBe("connected");
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);

    // The AS recovers; the grant needed no re-consent.
    const result = await getAccessToken(deps, id);
    expect(result.token).toBe(as.issuedAccessTokens.at(-1)!);
    expect(as.tokenRequests.length).toBe(asHitsBefore + 1);
  });

  test("invalid_grant on refresh lands expired + auth_required and throws oauth_not_connected", async () => {
    const id = await connectFlow("Invalid Grant");
    // Same sentinel discipline as the transient case: start from `ok` so the
    // `auth_error` below is the REFRESH's write and not the post-connect
    // probe's, which lands the same value against this always-401 stub.
    await setHealth(id, "ok");
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
    // `auth_required`, not `auth_error`: the grant is dead and re-consent is
    // the recovery, which is exactly what the probe classifies an unusable
    // grant as. Writing `auth_error` here contradicted the probe between the
    // failed refresh and the next probe — "your token was rejected" about a
    // grant that needs reconnecting.
    expect(conn.health).toBe("auth_required");
    // The reader is told to re-consent — not that some MCP dial 401'd.
    expect(conn.lastError).toContain("reconnect");

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
