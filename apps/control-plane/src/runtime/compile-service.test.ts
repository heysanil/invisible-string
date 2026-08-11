/**
 * Publish path through the REAL compiler for broker-delivered OAuth
 * connections (connectors redesign Plan 3 Task 8) — gated on
 * TEST_DATABASE_URL (skips cleanly when unset).
 *
 * Proves, at the compile-service/publish seam:
 *   - publishing an agent whose context has an `auth_type = "oauth"`
 *     connection produces an artifact whose generated connection module calls
 *     `platformConnectionToken(<cn_ id>)` and carries the
 *     `agent/lib/platform-token.ts` broker lib;
 *   - the version's env assembly carries PLATFORM_API_URL (the compiler's
 *     exact env name) and NO oauth material — the broker delivers access
 *     tokens at runtime, never the dispatcher;
 *   - the auth SHAPE is hashed (spec §8): flipping the SAME connection row to
 *     bearer auth republishes to a DIFFERENT content hash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLATFORM_API_URL_ENV } from "@invisible-string/compiler";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  generateMasterKeyBase64,
  newId,
  parseMasterKey,
  type AgentDefinitionInput,
  type GetAgentResponse,
  type PublishAgentResponse,
} from "@invisible-string/shared";
import { eq } from "drizzle-orm";

import { createMemoryArtifactStore } from "../artifacts";
import { compileAgent } from "../build/compiler-adapter";
import type { CompileAgentFn, CompileResult } from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createAppStack, type AppStack } from "../index";
import { runMigrations } from "../migrate";
import { encryptConnectionAuthConfig } from "../resources/mcp-crypto";
import { buildAgentEnv, decryptMcpEnv } from "./agent-env";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const MASTER_KEY = parseMasterKey(MASTER_KEY_B64);
const PLATFORM_API_URL = "http://control-plane:3000";

/** Every result the REAL compiler produced, keyed by content hash. */
const compiledByHash = new Map<string, CompileResult>();
const compileWithCapture: CompileAgentFn = (request) => {
  const result = compileAgent(request);
  compiledByHash.set(result.hash, result);
  return result;
};

/** Real compile, fake build: no npm/eve/world work in this suite. */
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
    "[compile-service] TEST_DATABASE_URL not set — skipping oauth publish integration tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)(
  "publish with an oauth connection (real compiler)",
  () => {
    let stack: AppStack;
    let db: AppStack["dbHandle"]["db"];
    let ownerCookie: string;
    let orgId: string;
    let connectionId: string;
    let agentId: string;
    let oauthHash: string;

    async function api(
      method: string,
      path: string,
      options: { body?: unknown; cookie?: string } = {},
    ): Promise<Response> {
      return stack.app.handle(
        new Request(`${BASE_URL}${path}`, {
          method,
          headers: {
            ...(options.body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
          },
          ...(options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
        }),
      );
    }

    beforeAll(async () => {
      await runMigrations(TEST_DATABASE_URL!);
      stack = createAppStack(
        {
          DATABASE_URL: TEST_DATABASE_URL!,
          BETTER_AUTH_SECRET: "csv-better-auth-secret-0000000000",
          BETTER_AUTH_URL: BASE_URL,
          ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
          WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
          PLATFORM_JWT_SECRET: "csv-platform-jwt-secret-000000000",
          WORKER_SHARED_SECRET: "csv-worker-shared-secret-00000000",
          S3_ENDPOINT: "http://localhost:9000",
          S3_ACCESS_KEY_ID: "dev",
          S3_SECRET_ACCESS_KEY: "devdevdev",
          OPENROUTER_API_KEY: "or-key",
          PLATFORM_API_URL,
          ALLOW_INSECURE_WORKER_TRANSPORT: "1",
          AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-csv-builds"),
        },
        {
          compile: compileWithCapture,
          buildSteps: fakeBuildSteps(),
          artifacts: createMemoryArtifactStore(),
        },
      );
      db = stack.dbHandle.db;
      expect(stack.runtime).not.toBeNull();

      // Owner + workspace (seeded presets so model resolution works).
      const email = `csv-${randomUUID()}@example.com`;
      const signup = await stack.app.handle(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            password: "correct-horse-battery",
            name: "OAuth Publisher",
          }),
        }),
      );
      expect(signup.status).toBe(200);
      ownerCookie = signup.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0]!)
        .join("; ");
      const headers = new Headers({ cookie: ownerCookie });
      const org = await stack.auth.api.createOrganization({
        body: { name: "OAuth ws", slug: `ws-${randomUUID().slice(0, 8)}` },
        headers,
      });
      await stack.auth.api.setActiveOrganization({
        body: { organizationId: org!.id },
        headers,
      });
      orgId = org!.id;
      const session = await stack.auth.api.getSession({ headers });
      await seedWorkspace(db, orgId, session!.user.id);

      // One oauth-mode connection (its grant row is irrelevant to compile).
      connectionId = newId("cn");
      await db.insert(schema.connections).values({
        id: connectionId,
        scope: "workspace",
        organizationId: orgId,
        name: "Linear OAuth",
        source: "custom",
        url: "https://mcp.linear.app/mcp",
        authType: "oauth",
      });
    }, 60_000);

    afterAll(async () => {
      await stack?.close();
    }, 30_000);

    test("the artifact's connection module defers to the platform token broker", async () => {
      const definition: AgentDefinitionInput = {
        persona: "Track issues with @linear-oauth; keep statuses accurate.",
        model: { preset: "balanced" },
        context: { mcpConnectionIds: [connectionId], skillIds: [] },
      };
      const created = await api("POST", `/workspaces/${orgId}/agents`, {
        cookie: ownerCookie,
        body: { name: "OAuth Agent", draft: definition },
      });
      expect(created.status).toBe(201);
      agentId = ((await created.json()) as GetAgentResponse).agent.id;
      const published = await api(
        "POST",
        `/workspaces/${orgId}/agents/${agentId}/publish`,
        { cookie: ownerCookie },
      );
      expect(published.status).toBe(200);
      oauthHash = ((await published.json()) as PublishAgentResponse).contentHash;

      const compiled = compiledByHash.get(oauthHash);
      expect(compiled).toBeDefined();
      const connectionFile = compiled!.files.get(
        "agent/connections/linear-oauth.ts",
      );
      expect(connectionFile).toBeDefined();
      expect(connectionFile!).toContain(
        `platformConnectionToken(${JSON.stringify(connectionId)})`,
      );
      // Broker-delivered: no static-credential env reads in the module…
      expect(connectionFile!).not.toContain("requireEnv");
      // …and the platform-token lib ships in the artifact.
      const lib = compiled!.files.get("agent/lib/platform-token.ts");
      expect(lib).toBeDefined();
      expect(lib!).toContain('requireEnv("PLATFORM_API_URL")');
      expect(lib!).toContain("/internal/connections/token");

      // The version row persisted the emitted slug → cn_ id map (Task 2).
      const versions = await db
        .select({ connectionSlugs: schema.agentVersions.connectionSlugs })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.contentHash, oauthHash));
      expect(versions[0]!.connectionSlugs).toEqual({
        "linear-oauth": connectionId,
      });
    });

    test("env assembly carries PLATFORM_API_URL and zero oauth material", async () => {
      // The oauth connection contributes NOTHING to the decrypted MCP env —
      // access tokens travel through the runtime token route, never env.
      const mcpEnv = await decryptMcpEnv(db, MASTER_KEY, [connectionId]);
      expect(mcpEnv).toEqual({});

      const env = buildAgentEnv({
        runtime: stack.runtime!.runtime,
        worldUrl: "postgres://dev:dev@localhost:5432/ag_v_abcdef012345",
        contentHash: oauthHash,
        provider: "openrouter",
        mcpEnv,
      });
      expect(env[PLATFORM_API_URL_ENV]).toBe(PLATFORM_API_URL);
      // No decrypted token, no oauth value, anywhere in the env map.
      for (const [name, value] of Object.entries(env)) {
        expect(name.startsWith("MCP_")).toBe(false);
        expect(value).not.toContain("oauth");
      }
    });

    test("flipping the SAME row to bearer republishes to a DIFFERENT hash (auth shape is hashed)", async () => {
      await db
        .update(schema.connections)
        .set({
          authType: "bearer",
          authConfigEncrypted: encryptConnectionAuthConfig(
            { type: "bearer", values: { token: "static-bearer-token" } },
            MASTER_KEY,
            connectionId,
          ),
        })
        .where(eq(schema.connections.id, connectionId));

      const republished = await api(
        "POST",
        `/workspaces/${orgId}/agents/${agentId}/publish`,
        { cookie: ownerCookie },
      );
      expect(republished.status).toBe(200);
      const bearerHash = ((await republished.json()) as PublishAgentResponse)
        .contentHash;
      expect(bearerHash).not.toBe(oauthHash);

      const compiled = compiledByHash.get(bearerHash)!;
      const connectionFile = compiled.files.get(
        "agent/connections/linear-oauth.ts",
      )!;
      expect(connectionFile).toContain(
        'requireEnv("MCP_LINEAR_OAUTH_TOKEN")',
      );
      expect(connectionFile).not.toContain("platformConnectionToken");
      expect(compiled.files.has("agent/lib/platform-token.ts")).toBe(false);
    });
  },
);
