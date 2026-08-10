/**
 * Agent-facing runtime token route (connectors redesign Plan 3 Task 7) —
 * gated on TEST_DATABASE_URL (skip cleanly when unset; the compose
 * integration stage provides it).
 *
 * `POST /internal/connections/token` shares the `/internal/*` prefix with the
 * worker plane but NOT its auth model: the caller is a COMPILED AGENT holding
 * only its version-derived `PLATFORM_JWT_SECRET`, and the version hash the
 * route serves comes ONLY from the verified JWT audience (spec §6) — never
 * from the request body. Covered here:
 *
 *   happy path — version-bound JWT + a `connected` oauth connection in the
 *     version's definition → `{token, expiresAt}` and nothing else
 *   401 — missing bearer, bare `agent-version` channel audience, JWT signed
 *     under a DIFFERENT version's derived secret, expired JWT, audience hash
 *     with no version row
 *   403 — connection not in the audience version's definition
 *   body cannot steer — a `versionHash` field in the body is ignored (the
 *     response serves the audience's version)
 *   409 — oauth row not `connected` (`oauth_not_connected`)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  encryptSecret,
  generateMasterKeyBase64,
  newId,
  parseMasterKey,
  type AgentDefinitionInput,
  type ApiErrorBody,
  type GetAgentResponse,
  type PublishAgentResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createAppStack, type AppStack } from "../index";
import { runMigrations } from "../migrate";
import { connectionOauthAad } from "../oauth/client-identity";
import { flipConnectionAuthRequired } from "./routes";
import {
  derivePlatformJwtSecret,
  mintPlatformJwt,
  PLATFORM_JWT_AUDIENCE,
  platformJwtAudienceForHash,
} from "./jwt";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const PLATFORM_JWT_SECRET = "ctr-platform-jwt-secret-000000000";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const MASTER_KEY = parseMasterKey(MASTER_KEY_B64);

const ACCESS_TOKEN = "live-access-token-value";

// ── cheap publish stubs (no real eve build in this suite) ───────────────────

const stubCompile: CompileAgentFn = (request) => ({
  files: new Map([["agent/instructions.md", request.definition.persona]]),
  hash: createHash("sha256")
    .update(
      JSON.stringify({
        definition: request.definition,
        workspace: request.workspaceSlug,
        agent: request.agentSlug,
      }),
    )
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

if (!TEST_DATABASE_URL) {
  console.warn(
    "[connection-token-route] TEST_DATABASE_URL not set — skipping token route integration tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("POST /internal/connections/token", () => {
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];

  let ownerCookie: string;
  let orgId: string;

  /** oauth + `connected`, referenced by version A's definition. */
  let connectedId: string;
  /** oauth + still `pending`, ALSO referenced by version A's definition. */
  let pendingId: string;
  /** oauth + `connected`, NOT referenced by any version. */
  let outsideId: string;
  let accessTokenExpiresAt: Date;

  /** Version A: definition contains [connectedId, pendingId]. */
  let hashA: string;
  /** Version B: definition contains NO connections (the steering decoy). */
  let hashB: string;

  async function api(
    method: string,
    path: string,
    options: {
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    return stack.app.handle(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      }),
    );
  }

  async function signUpWithOrg(
    name: string,
  ): Promise<{ cookie: string; orgId: string; userId: string }> {
    const email = `ctr-${randomUUID()}@example.com`;
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

  /** Insert an oauth-mode connection + its grant row directly (focused fixture). */
  async function insertOauthConnection(
    name: string,
    status: "connected" | "pending",
    expiresAt: Date,
  ): Promise<string> {
    const connectionId = newId("cn");
    await db.insert(schema.connections).values({
      id: connectionId,
      scope: "workspace",
      organizationId: orgId,
      name,
      source: "custom",
      url: "https://mcp.example.com/mcp",
      authType: "oauth",
    });
    const rowId = newId("co");
    await db.insert(schema.connectionOauth).values({
      id: rowId,
      connectionId,
      status,
      ...(status === "connected"
        ? {
            accessTokenEncrypted: JSON.stringify(
              encryptSecret(
                ACCESS_TOKEN,
                MASTER_KEY,
                connectionOauthAad("access_token", rowId),
              ),
            ),
            accessTokenExpiresAt: expiresAt,
          }
        : {}),
    });
    return connectionId;
  }

  async function createAndPublish(
    name: string,
    definition: AgentDefinitionInput,
  ): Promise<string> {
    const created = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name, draft: definition },
    });
    expect(created.status).toBe(201);
    const agent = ((await created.json()) as GetAgentResponse).agent;
    const published = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agent.id}/publish`,
      { cookie: ownerCookie },
    );
    expect(published.status).toBe(200);
    const body = (await published.json()) as PublishAgentResponse;
    expect(body.contentHash).toHaveLength(64);
    return body.contentHash;
  }

  /** Mint an agent-style platform JWT; overrides model the attack cases. */
  function mint(
    hash: string,
    overrides: {
      secretHash?: string;
      audience?: string;
      ttlSeconds?: number;
    } = {},
  ): Promise<string> {
    return mintPlatformJwt(
      derivePlatformJwtSecret(PLATFORM_JWT_SECRET, overrides.secretHash ?? hash),
      {
        subject: "agent",
        audience: overrides.audience ?? platformJwtAudienceForHash(hash),
        ...(overrides.ttlSeconds !== undefined
          ? { ttlSeconds: overrides.ttlSeconds }
          : {}),
      },
    );
  }

  function postToken(
    jwt: string | null,
    body: unknown,
  ): Promise<Response> {
    return api("POST", "/internal/connections/token", {
      body,
      ...(jwt ? { headers: { authorization: `Bearer ${jwt}` } } : {}),
    });
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "ctr-better-auth-secret-0000000000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET,
        WORKER_SHARED_SECRET: "ctr-worker-shared-secret-00000000",
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        OPENROUTER_API_KEY: "or-key",
        ALLOW_INSECURE_WORKER_TRANSPORT: "1",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-ctr-builds"),
      },
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts: createMemoryArtifactStore(),
      },
    );
    db = stack.dbHandle.db;
    expect(stack.runtime).not.toBeNull();

    const owner = await signUpWithOrg("Token Route Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    await seedWorkspace(db, orgId, owner.userId);

    accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    connectedId = await insertOauthConnection(
      "linear oauth",
      "connected",
      accessTokenExpiresAt,
    );
    pendingId = await insertOauthConnection(
      "notion oauth",
      "pending",
      accessTokenExpiresAt,
    );
    outsideId = await insertOauthConnection(
      "outside oauth",
      "connected",
      accessTokenExpiresAt,
    );

    hashA = await createAndPublish("Token Agent A", {
      persona: "Use @linear-oauth and @notion-oauth.",
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [connectedId, pendingId], skillIds: [] },
    });
    hashB = await createAndPublish("Token Agent B", {
      persona: "No connections at all.",
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });
    expect(hashB).not.toBe(hashA);
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  }, 30_000);

  test("happy path: version-bound JWT + in-definition connection → {token, expiresAt} only", async () => {
    const res = await postToken(await mint(hashA), { connectionId: connectedId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toBe(ACCESS_TOKEN);
    // Never refresh material, never extra fields.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);
    expect(
      Math.abs(new Date(body.expiresAt).getTime() - accessTokenExpiresAt.getTime()),
    ).toBeLessThan(1_000);
  });

  test("missing bearer → 401", async () => {
    const res = await postToken(null, { connectionId: connectedId });
    expect(res.status).toBe(401);
  });

  test("bare agent-version channel audience → 401", async () => {
    const jwt = await mint(hashA, { audience: PLATFORM_JWT_AUDIENCE });
    const res = await postToken(jwt, { connectionId: connectedId });
    expect(res.status).toBe(401);
  });

  test("JWT signed under a DIFFERENT version's derived secret → 401", async () => {
    // Version B's agent env cannot mint for version A: the route derives the
    // verification secret from the AUDIENCE hash, so the signature fails.
    const jwt = await mint(hashA, { secretHash: hashB });
    const res = await postToken(jwt, { connectionId: connectedId });
    expect(res.status).toBe(401);
  });

  test("expired JWT → 401", async () => {
    const jwt = await mint(hashA, { ttlSeconds: -30 });
    const res = await postToken(jwt, { connectionId: connectedId });
    expect(res.status).toBe(401);
  });

  test("well-formed audience with no version row → 401", async () => {
    const ghost = "f".repeat(64);
    const jwt = await mint(ghost);
    const res = await postToken(jwt, { connectionId: connectedId });
    expect(res.status).toBe(401);
  });

  test("connection not in the audience version's definition → 403", async () => {
    const res = await postToken(await mint(hashA), { connectionId: outsideId });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("connection_not_in_version");
  });

  test("a versionHash field in the body is ignored — the audience decides", async () => {
    // Version B's definition has NO connections: if the body could steer the
    // version resolution, this request would 403. It serves version A's.
    const res = await postToken(await mint(hashA), {
      connectionId: connectedId,
      versionHash: hashB,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBe(ACCESS_TOKEN);
  });

  test("oauth row not connected → 409 oauth_not_connected", async () => {
    const res = await postToken(await mint(hashA), { connectionId: pendingId });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("oauth_not_connected");
  });

  // ── mid-run authorization health flip (plan-3 task 9) ────────────────────
  //
  // The tailer's authorization latch resolves eve's connection name (the
  // per-version slug) back to a `cn_` row through the SAME published
  // `connection_slugs` map this suite's fixtures carry, then flips health to
  // `auth_required`. Dormant on eve 0.31.3 (spike finding 30) but wired
  // defensively — proven here against a real publish.

  test("authorization health flip: version slug resolves to the row and flips health", async () => {
    const versions = await db
      .select({ connectionSlugs: schema.agentVersions.connectionSlugs })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.contentHash, hashA))
      .limit(1);
    const slugs = versions[0]!.connectionSlugs ?? {};
    const entry = Object.entries(slugs).find(([, id]) => id === connectedId);
    expect(entry).toBeDefined();

    await flipConnectionAuthRequired(
      { db, logger: stack.logger },
      hashA,
      entry![0],
    );
    const rows = await db
      .select({ health: schema.connections.health })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectedId));
    expect(rows[0]!.health).toBe("auth_required");
  });

  test("authorization health flip: an unknown slug is a logged no-op, never a throw", async () => {
    // eve's event names are server-influenced content — an unresolvable name
    // must not error a tail or touch any row.
    await flipConnectionAuthRequired(
      { db, logger: stack.logger },
      hashA,
      "no-such-connection",
    );
    const rows = await db
      .select({ health: schema.connections.health })
      .from(schema.connections)
      .where(eq(schema.connections.id, outsideId));
    expect(rows[0]!.health).toBe("unknown");
  });
});
