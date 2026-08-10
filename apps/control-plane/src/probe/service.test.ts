/**
 * Probe service + test-connection routes — DB-gated (skips cleanly when
 * TEST_DATABASE_URL is unset). Exercises the full HTTP surface against an
 * in-process, protocol-correct MCP fixture (the Task-2 pattern: SDK
 * `McpServer` + `StreamableHTTPServerTransport` on a loopback `node:http`
 * server) whose auth behaviour can be flipped mid-suite:
 *
 *  - POST /connections/:id/probe persists `ok` + the trimmed tool cache;
 *  - a later 401 (credentials present) → `auth_error`, prior tools RETAINED;
 *  - authz matrix on the workspace and /me probe routes;
 *  - create fires a fire-and-forget probe: the create response never waits
 *    (health `unknown` in the response, `ok` shortly after in the row).
 *
 * The stack boots with MCP_PROBE_ALLOW_PRIVATE=1 so the guarded egress fetch
 * admits the loopback http fixture — exactly how dev/e2e run probes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  generateMasterKeyBase64,
  type GetConnectionResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import type { CompileAgentFn } from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createAppStack, type AppStack } from "../index";
import { runMigrations } from "../migrate";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const MASTER_KEY_B64 = generateMasterKeyBase64();

// ── stubs (the seed-agent background publish needs a cheap compile path) ─────

const stubCompile: CompileAgentFn = (request) => ({
  files: new Map([["agent/instructions.md", request.definition.persona]]),
  hash: createHash("sha256")
    .update(JSON.stringify(request.definition))
    .digest("hex"),
  compilerVersion: "stub-compiler-probe",
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

// ── switchable MCP fixture (mirrors probe/mcp-probe.test.ts) ─────────────────

type FixtureMode = "ok" | "unauthorized";

function buildFixtureMcpServer(): McpServer {
  const server = new McpServer({ name: "probe-service-notes", version: "1.0.0" });
  server.registerTool(
    "save_note",
    {
      description: "Save a short note to the user's notebook.",
      inputSchema: { note: z.string().describe("The note text to save.") },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `note saved: ${note}` }],
    }),
  );
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/** Loopback MCP server whose auth behaviour flips via `mode`. */
class ProbeFixture {
  mode: FixtureMode = "ok";
  private server: ReturnType<typeof createServer> | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  get url(): string {
    if (!this.server) throw new Error("fixture not started");
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.mode === "unauthorized") {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Bearer realm="mcp"');
      res.end("unauthorized");
      return;
    }
    const server = buildFixtureMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    let body: unknown;
    try {
      body = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch {
      body = undefined;
    }
    await transport.handleRequest(req, res, body);
  }
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

if (!TEST_DATABASE_URL) {
  console.warn("[probe] TEST_DATABASE_URL not set — skipping probe service tests");
}

describe.skipIf(!TEST_DATABASE_URL)("probe service + routes", () => {
  const fixture = new ProbeFixture();
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
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}) },
    };
    if (options.body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return stack.app.handle(new Request(`${BASE_URL}${path}`, init));
  }

  async function signUpWithOrg(
    name: string,
  ): Promise<{ cookie: string; orgId: string; userId: string }> {
    const email = `probe-${randomUUID()}@example.com`;
    const res = await stack.app.handle(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery", name }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
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

  async function createCustom(
    scopePath: string,
    name: string,
    body: Record<string, unknown> = {},
  ): Promise<GetConnectionResponse["connection"]> {
    const res = await api("POST", scopePath, {
      cookie: ownerCookie,
      body: { source: "custom", name, url: fixture.url, ...body },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as GetConnectionResponse).connection;
  }

  async function rowOf(id: string) {
    const rows = await db
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, id));
    return rows[0];
  }

  /** Wait for the fire-and-forget after-create probe to settle. */
  async function untilProbed(id: string) {
    return until(async () => {
      const row = await rowOf(id);
      return row && row.health !== "unknown" ? row : undefined;
    }, `connection ${id} first probe`);
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    await fixture.start();
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "probe-service-secret-000000000000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET: "probe-platform-jwt-secret-0000000",
        WORKER_SHARED_SECRET: "probe-worker-shared-secret-000000",
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-probe-builds"),
        // The fixture is loopback http — exactly the dev/e2e probe posture.
        MCP_PROBE_ALLOW_PRIVATE: "1",
      },
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts: createMemoryArtifactStore(),
      },
    );
    db = stack.dbHandle.db;

    const owner = await signUpWithOrg("Probe Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    ownerUserId = owner.userId;
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
    await fixture.stop();
  }, 30_000);

  test("probe route persists ok + trimmed tools and returns the fresh DTO", async () => {
    fixture.mode = "ok";
    const conn = await createCustom(`/workspaces/${orgId}/connections`, "Notes");
    expect(conn.health).toBe("unknown");
    await untilProbed(conn.id);

    const res = await api(
      "POST",
      `/workspaces/${orgId}/connections/${conn.id}/probe`,
      { cookie: ownerCookie },
    );
    expect(res.status).toBe(200);
    const probed = ((await res.json()) as GetConnectionResponse).connection;
    expect(probed.health).toBe("ok");
    expect(probed.lastError).toBeNull();
    expect(probed.lastCheckedAt).not.toBeNull();
    expect(probed.toolsCachedAt).not.toBeNull();
    expect(probed.tools?.map((t) => t.name)).toContain("save_note");
    expect(probed.tools?.[0]?.params).toEqual(["note"]);

    // Persisted, not just echoed.
    const row = await rowOf(conn.id);
    expect(row?.health).toBe("ok");
    expect(row?.toolsCache?.map((t) => t.name)).toContain("save_note");
    expect(row?.lastCheckedAt).not.toBeNull();
  }, 30_000);

  test("re-probe after the server starts 401ing → auth_error, prior tools cache retained", async () => {
    fixture.mode = "ok";
    const conn = await createCustom(`/workspaces/${orgId}/connections`, "Cred Notes", {
      auth: { type: "bearer", values: { token: "probe-secret-token" } },
    });
    await untilProbed(conn.id); // background probe settled — no stale writer

    const first = await api(
      "POST",
      `/workspaces/${orgId}/connections/${conn.id}/probe`,
      { cookie: ownerCookie },
    );
    expect(first.status).toBe(200);
    const healthy = ((await first.json()) as GetConnectionResponse).connection;
    expect(healthy.health).toBe("ok");
    expect(healthy.tools?.map((t) => t.name)).toContain("save_note");

    fixture.mode = "unauthorized";
    const second = await api(
      "POST",
      `/workspaces/${orgId}/connections/${conn.id}/probe`,
      { cookie: ownerCookie },
    );
    // An unhealthy server is a 200 with its classified health — never a 5xx.
    expect(second.status).toBe(200);
    const unhealthy = ((await second.json()) as GetConnectionResponse).connection;
    expect(unhealthy.health).toBe("auth_error"); // credentials present
    expect(unhealthy.lastError).toBeTruthy();
    expect(unhealthy.lastError).not.toContain("probe-secret-token");
    // A blip must not wipe the picker: the prior cache is KEPT.
    expect(unhealthy.tools?.map((t) => t.name)).toContain("save_note");
    expect(unhealthy.toolsCachedAt).toBe(healthy.toolsCachedAt);

    const row = await rowOf(conn.id);
    expect(row?.health).toBe("auth_error");
    expect(row?.toolsCache?.map((t) => t.name)).toContain("save_note");
    fixture.mode = "ok";
  }, 30_000);

  test("probe authz matrix — anonymous 401, outsider 403/404, member 403, /me isolated", async () => {
    const conn = await createCustom(`/workspaces/${orgId}/connections`, "Authz Notes");

    const anon = await api("POST", `/workspaces/${orgId}/connections/${conn.id}/probe`);
    expect(anon.status).toBe(401);

    const stranger = await signUpWithOrg("Probe Stranger");
    // Foreign workspace path → 403.
    const foreignPath = await api(
      "POST",
      `/workspaces/${orgId}/connections/${conn.id}/probe`,
      { cookie: stranger.cookie },
    );
    expect(foreignPath.status).toBe(403);
    // Foreign row under the stranger's OWN path → 404 (hidden).
    const foreignRow = await api(
      "POST",
      `/workspaces/${stranger.orgId}/connections/${conn.id}/probe`,
      { cookie: stranger.cookie },
    );
    expect(foreignRow.status).toBe(404);

    // Probe mutates health columns → owner/admin-gated like other mutations.
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    try {
      const memberProbe = await api(
        "POST",
        `/workspaces/${orgId}/connections/${conn.id}/probe`,
        { cookie: ownerCookie },
      );
      expect(memberProbe.status).toBe(403);
    } finally {
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    }
    const ownerProbe = await api(
      "POST",
      `/workspaces/${orgId}/connections/${conn.id}/probe`,
      { cookie: ownerCookie },
    );
    expect(ownerProbe.status).toBe(200);

    // /me probe: the signed-in user owns the row; anyone else sees 404.
    const mine = await createCustom(`/me/connections`, "My Notes");
    const strangerMe = await api("POST", `/me/connections/${mine.id}/probe`, {
      cookie: stranger.cookie,
    });
    expect(strangerMe.status).toBe(404);
    const myProbe = await api("POST", `/me/connections/${mine.id}/probe`, {
      cookie: ownerCookie,
    });
    expect(myProbe.status).toBe(200);
    const myProbed = ((await myProbe.json()) as GetConnectionResponse).connection;
    expect(myProbed.health).toBe("ok");
  }, 30_000);

  test("create fires a fire-and-forget probe: response never waits, row transitions from unknown", async () => {
    fixture.mode = "ok";
    const conn = await createCustom(`/workspaces/${orgId}/connections`, "Async Probe");
    // The create response is pre-probe — proving create did not block on it.
    expect(conn.health).toBe("unknown");
    expect(conn.tools).toBeNull();
    expect(conn.lastCheckedAt).toBeNull();

    const row = await untilProbed(conn.id);
    expect(row.health).toBe("ok");
    expect(row.toolsCache?.map((t) => t.name)).toContain("save_note");
    expect(row.lastCheckedAt).not.toBeNull();
  }, 30_000);
});
