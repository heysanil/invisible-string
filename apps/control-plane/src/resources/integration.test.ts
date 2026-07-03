/**
 * Phase-2 resource-CRUD integration tests — gated on TEST_DATABASE_URL (skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * Covers the authz matrix (outsider 403 on paths / 404 on foreign rows; member
 * ok; owner/admin-only ops), secrets-never-echoed, the registry proxy (stubbed
 * registry), delete-referenced-connection 409, the skill attachment
 * upload→publish path (bytes threaded into the compiler), model/agent preset
 * guards, member passthrough, and the HITL run-input round trip against a fake
 * eve worker that parks on approval.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, and } from "drizzle-orm";
import { jwtVerify } from "jose";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  generateMasterKeyBase64,
  type CreateSessionResponse,
  type GetMcpConnectionResponse,
  type GetSkillResponse,
  type GetWorkflowResponse,
  type ListMcpConnectionsResponse,
  type ListSessionsResponse,
  type ListWorkflowsResponse,
  type ListWorkspaceMembersResponse,
  type PublishWorkflowResponse,
  type RegistrySearchResponse,
  type RegistryServerSummary,
  type RunDto,
  type RunInputResponse,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import {
  WorkflowCompileError,
  type CompileRequest,
  type CompileWorkflowFn,
} from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { runMigrations } from "../migrate";
import type { RegistryClient } from "./registry";
import {
  derivePlatformJwtSecret,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "../runtime/jwt";
import { createAppStack, type AppStack } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const PLATFORM_JWT_SECRET = "res-platform-jwt-secret-000000000";
const WORKER_SHARED_SECRET = "res-worker-shared-secret-00000000";
const MASTER_KEY_B64 = generateMasterKeyBase64();

// ── stub compiler (captures requests; deterministic hash incl. skill files) ──

const STUB_EVE_VERSION = "0.19.0";
const capturedCompiles: CompileRequest[] = [];

const stubCompile: CompileWorkflowFn = (request) => {
  capturedCompiles.push(request);
  if (request.definition.instructions.markdown.trim() === "") {
    throw new WorkflowCompileError([
      { path: "instructions.markdown", message: "instructions must not be empty" },
    ]);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        definition: request.definition,
        model: request.model.modelId,
        connections: request.connections.map((c) => [c.name, c.url, c.envTokenVar, c.authHeaders]),
        skills: request.skills.map((s) => [s.name, s.content, s.files ?? null]),
        eve: STUB_EVE_VERSION,
      }),
    )
    .digest("hex");
  return {
    files: new Map([["instructions.md", request.definition.instructions.markdown]]),
    hash,
    compilerVersion: "stub-compiler-1",
    eveVersion: STUB_EVE_VERSION,
  };
};

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

// ── stub registry ────────────────────────────────────────────────────────────

const REGISTRY_SERVER: RegistryServerSummary = {
  name: "io.example/linear",
  title: "Linear",
  description: "Issue tracker MCP",
  version: "1.0.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
  envVarDeclarations: [
    { name: "LINEAR_API_KEY", isRequired: true, isSecret: true },
  ],
};

const stubRegistry: RegistryClient = {
  async search(query) {
    return query.toLowerCase().includes("linear") ? [REGISTRY_SERVER] : [];
  },
  async getServer(name) {
    return name === REGISTRY_SERVER.name ? REGISTRY_SERVER : null;
  },
};

// ── fake eve worker (parks on approval) ─────────────────────────────────────

interface FakeSession {
  id: string;
  continuationToken: string;
  events: string[];
  parked: boolean;
}

class FakeWorker {
  readonly sessions = new Map<string, FakeSession>();
  readonly inputResponses: unknown[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private counter = 0;

  get url(): string {
    if (!this.server) throw new Error("not started");
    return `http://localhost:${this.server.port}`;
  }
  start(): void {
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
  }
  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async verify(req: Request, hash: string): Promise<boolean> {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    try {
      await jwtVerify(
        token,
        new TextEncoder().encode(derivePlatformJwtSecret(PLATFORM_JWT_SECRET, hash)),
        { issuer: PLATFORM_JWT_ISSUER, audience: platformJwtAudienceForHash(hash) },
      );
      return true;
    } catch {
      return false;
    }
  }

  private startTurn(s: FakeSession, message: string): void {
    const turnId = "turn_0";
    s.events.push(
      JSON.stringify({ type: "session.started", data: { runtime: { agentId: "f", eveVersion: "0.19.0", modelId: "m" } } }),
      JSON.stringify({ type: "turn.started", data: { sequence: 0, turnId } }),
      JSON.stringify({ type: "message.received", data: { message, sequence: 0, turnId } }),
    );
    if (message.includes("APPROVE")) {
      s.parked = true;
      s.events.push(
        JSON.stringify({
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req-1",
                prompt: "Approve tool call?",
                action: { callId: "c1", kind: "tool-call", toolName: "delete_page", input: {} },
                options: [
                  { id: "approve", label: "Yes" },
                  { id: "deny", label: "No" },
                ],
                display: "confirmation",
                allowFreeform: false,
              },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId,
          },
        }),
        JSON.stringify({ type: "turn.completed", data: { sequence: 0, turnId } }),
        JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } }),
      );
    } else {
      s.events.push(
        JSON.stringify({ type: "message.completed", data: { finishReason: "stop", message: `echo:${message}`, sequence: 0, stepIndex: 0, turnId } }),
        JSON.stringify({ type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId } }),
        JSON.stringify({ type: "turn.completed", data: { sequence: 0, turnId } }),
        JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } }),
      );
    }
  }

  private resume(s: FakeSession): void {
    const turnId = "turn_1";
    s.parked = false;
    s.events.push(
      JSON.stringify({ type: "turn.started", data: { sequence: 1, turnId } }),
      JSON.stringify({ type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "delete_page", output: "ok" }, status: "completed", sequence: 1, stepIndex: 0, turnId } }),
      JSON.stringify({ type: "message.completed", data: { finishReason: "stop", message: "done", sequence: 1, stepIndex: 0, turnId } }),
      JSON.stringify({ type: "turn.completed", data: { sequence: 1, turnId } }),
      JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } }),
    );
  }

  private stream(s: FakeSession, startIndex: number): Response {
    const encoder = new TextEncoder();
    let i = startIndex;
    let timer: ReturnType<typeof setInterval> | null = null;
    const terminal = new Set(["session.waiting", "session.completed", "session.failed"]);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const pump = () => {
          while (i < s.events.length) {
            const line = s.events[i++]!;
            controller.enqueue(encoder.encode(`${line}\n`));
            if (terminal.has((JSON.parse(line) as { type: string }).type)) {
              if (timer) clearInterval(timer);
              controller.close();
              return;
            }
          }
        };
        pump();
        timer = setInterval(() => {
          try {
            pump();
          } catch {
            if (timer) clearInterval(timer);
          }
        }, 10);
      },
      cancel: () => {
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/internal/agents/ensure" && req.method === "POST") {
      if (req.headers.get("x-worker-secret") !== WORKER_SHARED_SECRET) {
        return Response.json({ error: "bad secret" }, { status: 401 });
      }
      await req.json();
      return Response.json({ ok: true });
    }
    const m = path.match(/^\/agents\/([^/]+)\/eve\/v1\/(.*)$/);
    if (!m) return new Response("nf", { status: 404 });
    if (!(await this.verify(req, m[1]!))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const sub = m[2]!;
    if (sub === "session" && req.method === "POST") {
      const body = (await req.json()) as { message: string };
      const id = `es-${++this.counter}`;
      const s: FakeSession = { id, continuationToken: `ct-${id}`, events: [], parked: false };
      this.sessions.set(id, s);
      this.startTurn(s, body.message);
      return Response.json({ sessionId: id, continuationToken: s.continuationToken }, { status: 202 });
    }
    const cont = sub.match(/^session\/([^/]+)$/);
    if (cont && req.method === "POST") {
      const s = this.sessions.get(cont[1]!);
      if (!s) return new Response("no session", { status: 404 });
      const body = (await req.json()) as { inputResponses?: unknown[]; message?: string };
      if (body.inputResponses) {
        this.inputResponses.push(...body.inputResponses);
        this.resume(s);
      } else if (body.message) {
        this.startTurn(s, body.message);
      }
      return Response.json({}, { status: 202 });
    }
    const str = sub.match(/^session\/([^/]+)\/stream$/);
    if (str && req.method === "GET") {
      const s = this.sessions.get(str[1]!);
      if (!s) return new Response("no session", { status: 404 });
      return this.stream(s, Number(url.searchParams.get("startIndex") ?? "0"));
    }
    return new Response("nf", { status: 404 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

if (!TEST_DATABASE_URL) {
  console.warn("[resources] TEST_DATABASE_URL not set — skipping resource integration tests");
}

describe.skipIf(!TEST_DATABASE_URL)("resource CRUD integration", () => {
  const fixture = new FakeWorker();
  const artifacts = createMemoryArtifactStore();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];

  let ownerCookie: string;
  let orgId: string;
  let ownerUserId: string;
  let agentPresetId: string;

  async function api(
    method: string,
    path: string,
    options: { body?: unknown; form?: FormData; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const init: RequestInit = { method, headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers } };
    if (options.form) {
      init.body = options.form;
    } else if (options.body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return stack.app.handle(new Request(`${BASE_URL}${path}`, init));
  }

  async function signUpWithOrg(name: string): Promise<{ cookie: string; orgId: string; userId: string }> {
    const email = `res-${randomUUID()}@example.com`;
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
    const org = await stack.auth.api.createOrganization({ body: { name: `${name} ws`, slug: `ws-${randomUUID().slice(0, 8)}` }, headers });
    await stack.auth.api.setActiveOrganization({ body: { organizationId: org!.id }, headers });
    const session = await stack.auth.api.getSession({ headers });
    return { cookie, orgId: org!.id, userId: session!.user.id };
  }

  async function freshWorker(): Promise<void> {
    await db.update(schema.workers).set({ lastHeartbeatAt: new Date(), status: "live" }).where(eq(schema.workers.address, fixture.url));
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    fixture.start();
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "resource-integration-secret-00000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET,
        WORKER_SHARED_SECRET,
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        OPENROUTER_API_KEY: "or-key",
        MAX_CONCURRENT_RUNS_PER_WORKSPACE: "5",
        ALLOW_INSECURE_WORKER_TRANSPORT: "1",
        SSE_HEARTBEAT_MS: "50",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-res-builds"),
      },
      { compile: stubCompile, buildSteps: fakeBuildSteps(), artifacts, registry: stubRegistry },
    );
    db = stack.dbHandle.db;

    const owner = await signUpWithOrg("Res Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    ownerUserId = owner.userId;
    await seedWorkspace(db, orgId);
    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.organizationId, orgId));
    agentPresetId = agents[0]!.id;

    // Start from a clean worker registry — workers are GLOBAL (selectWorker is
    // not workspace-scoped), so stray live rows from another suite/run sharing
    // this DB would be dispatched to. This suite owns exactly one worker.
    await db.delete(schema.workers);
    await db.insert(schema.workers).values({ address: fixture.url, status: "live", lastHeartbeatAt: new Date() });
  }, 60_000);

  afterAll(async () => {
    // Remove this suite's worker row so it cannot leak into other integration
    // suites sharing the same test DB (e.g. the runtime suite's "no live
    // worker" case, which assumes only its own worker exists).
    await db?.delete(schema.workers).where(eq(schema.workers.address, fixture.url));
    await stack?.close();
    fixture.stop();
  }, 30_000);

  // ── workflows CRUD + roles ───────────────────────────────────────────────

  test("workflows: create/list/get/update(draft diagnostics)/delete with role rules", async () => {
    const create = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: { name: "My Workflow" },
    });
    expect(create.status).toBe(201);
    const wf = ((await create.json()) as GetWorkflowResponse).workflow;
    expect(wf.name).toBe("My Workflow");
    expect(wf.runAsUserId).toBe(ownerUserId);

    const list = await api("GET", `/workspaces/${orgId}/workflows`, { cookie: ownerCookie });
    const workflows = ((await list.json()) as ListWorkflowsResponse).workflows;
    expect(workflows.some((w) => w.id === wf.id)).toBeTrue();

    // Draft update returns dry-run diagnostics inline (ok for a valid draft).
    const draft: WorkflowDefinition = {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [], skillIds: [] },
      agent: { agentPresetId },
      instructions: { markdown: "Be helpful." },
    };
    const patch = await api("PATCH", `/workspaces/${orgId}/workflows/${wf.id}`, { cookie: ownerCookie, body: { draft } });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as GetWorkflowResponse & { diagnostics?: { ok: boolean } };
    expect(patchBody.workflow.triggerType).toBe("manual");
    expect(patchBody.diagnostics?.ok).toBeTrue();

    // A member (non-admin) cannot delete; an owner/admin can.
    await db.update(schema.member).set({ role: "member" }).where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    const denied = await api("DELETE", `/workspaces/${orgId}/workflows/${wf.id}`, { cookie: ownerCookie });
    expect(denied.status).toBe(403);
    await db.update(schema.member).set({ role: "owner" }).where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    const ok = await api("DELETE", `/workspaces/${orgId}/workflows/${wf.id}`, { cookie: ownerCookie });
    expect(ok.status).toBe(200);
  });

  test("workflows: outsider gets 403 on the path and 404 on foreign rows", async () => {
    const create = await api("POST", `/workspaces/${orgId}/workflows`, { cookie: ownerCookie, body: { name: "Owned" } });
    const wfId = ((await create.json()) as GetWorkflowResponse).workflow.id;
    const stranger = await signUpWithOrg("Stranger");

    // Path addresses a workspace that is not the caller's active one → 403.
    const foreignPath = await api("GET", `/workspaces/${orgId}/workflows`, { cookie: stranger.cookie });
    expect(foreignPath.status).toBe(403);

    // Foreign row under the stranger's OWN workspace path → 404 (hidden).
    const foreignRow = await api("GET", `/workspaces/${stranger.orgId}/workflows/${wfId}`, { cookie: stranger.cookie });
    expect(foreignRow.status).toBe(404);

    // Anonymous → 401.
    const anon = await api("GET", `/workspaces/${orgId}/workflows`);
    expect(anon.status).toBe(401);
  });

  test("workflows: run_as user must be a workspace member", async () => {
    const res = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: { name: "Bad RunAs", runAsUserId: "not-a-member" },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("run_as_user_not_member");
  });

  // ── MCP connections + secrets + registry + delete guard ──────────────────

  test("mcp connections: bearer secret encrypted + never echoed; CRUD; user scope", async () => {
    const create = await api("POST", `/workspaces/${orgId}/mcp-connections`, {
      cookie: ownerCookie,
      body: {
        name: "Linear",
        url: "https://mcp.linear.app/mcp",
        auth: { type: "bearer", values: { token: "sk-super-secret" } },
        approvalPolicy: { default: "never", tools: { delete_page: "always" } },
      },
    });
    expect(create.status).toBe(201);
    const conn = ((await create.json()) as GetMcpConnectionResponse).connection;
    expect(conn.hasCredentials).toBeTrue();
    // The secret is NEVER present in any serialized field.
    expect(JSON.stringify(conn)).not.toContain("sk-super-secret");

    const stored = await db.select({ enc: schema.mcpConnections.authConfigEncrypted }).from(schema.mcpConnections).where(eq(schema.mcpConnections.id, conn.id));
    expect(stored[0]!.enc).not.toBeNull();
    expect(stored[0]!.enc!).not.toContain("sk-super-secret"); // encrypted at rest

    const get = await api("GET", `/workspaces/${orgId}/mcp-connections/${conn.id}`, { cookie: ownerCookie });
    expect(JSON.stringify(await get.json())).not.toContain("sk-super-secret");

    // User-scoped create under /me.
    const meCreate = await api("POST", `/me/mcp-connections`, { cookie: ownerCookie, body: { name: "Personal", url: "https://mcp.example/mcp" } });
    expect(meCreate.status).toBe(201);
    const meList = await api("GET", `/me/mcp-connections`, { cookie: ownerCookie });
    const meConns = ((await meList.json()) as ListMcpConnectionsResponse).connections;
    expect(meConns.some((c) => c.scope === "user" && c.name === "Personal")).toBeTrue();
    // Workspace list must NOT include the user-scoped connection.
    const wsList = await api("GET", `/workspaces/${orgId}/mcp-connections`, { cookie: ownerCookie });
    const wsConns = ((await wsList.json()) as ListMcpConnectionsResponse).connections;
    expect(wsConns.some((c) => c.name === "Personal")).toBeFalse();
  });

  test("mcp connections: DELETE blocked (409) while a workflow references it", async () => {
    const create = await api("POST", `/workspaces/${orgId}/mcp-connections`, {
      cookie: ownerCookie,
      body: { name: "Referenced", url: "https://mcp.example/ref" },
    });
    const connId = ((await create.json()) as GetMcpConnectionResponse).connection.id;
    const wf = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: {
        name: "Uses Connection",
        draft: {
          trigger: { type: "manual" },
          context: { mcpConnectionIds: [connId], skillIds: [] },
          agent: { agentPresetId },
          instructions: { markdown: "Use it." },
        },
      },
    });
    const wfName = ((await wf.json()) as GetWorkflowResponse).workflow.name;

    const del = await api("DELETE", `/workspaces/${orgId}/mcp-connections/${connId}`, { cookie: ownerCookie });
    expect(del.status).toBe(409);
    const body = (await del.json()) as { error: { code: string; details?: { workflows?: string[] } } };
    expect(body.error.code).toBe("connection_in_use");
    expect(body.error.details?.workflows).toContain(wfName);
  });

  test("mcp registry: proxy search + install create a registry-sourced connection", async () => {
    const search = await api("GET", `/mcp-registry/search?q=linear`, { cookie: ownerCookie });
    expect(search.status).toBe(200);
    const servers = ((await search.json()) as RegistrySearchResponse).servers;
    expect(servers[0]!.name).toBe("io.example/linear");

    const install = await api("POST", `/workspaces/${orgId}/mcp-connections/install`, {
      cookie: ownerCookie,
      body: {
        registryName: "io.example/linear",
        remoteUrl: "https://mcp.linear.app/mcp",
        auth: { type: "headers", values: { "X-Api-Key": "key-abc" } },
      },
    });
    expect(install.status).toBe(201);
    const conn = ((await install.json()) as GetMcpConnectionResponse).connection;
    expect(conn.source).toBe("registry");
    expect(conn.registryId).toBe("io.example/linear");
    expect(conn.url).toBe("https://mcp.linear.app/mcp");
    expect(conn.hasCredentials).toBeTrue();

    const missing = await api("POST", `/workspaces/${orgId}/mcp-connections/install`, {
      cookie: ownerCookie,
      body: { registryName: "io.example/gone", remoteUrl: "https://x/y" },
    });
    expect(missing.status).toBe(404);
  });

  // ── skills + attachments → publish threads bytes into the compiler ───────

  test("skills: CRUD + attachment upload; publish emits the packaged skill", async () => {
    const create = await api("POST", `/workspaces/${orgId}/skills`, {
      cookie: ownerCookie,
      body: { name: "Triage", description: "How to triage", content: "# Triage\n\nSee references/rota.md" },
    });
    expect(create.status).toBe(201);
    const skill = ((await create.json()) as GetSkillResponse).skill;
    expect(skill.files).toEqual([]);

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("# On-call\n- alice\n")], "references/rota.md", { type: "text/markdown" }));
    const upload = await api("POST", `/workspaces/${orgId}/skills/${skill.id}/files`, { cookie: ownerCookie, form });
    expect(upload.status).toBe(200);
    const withFile = ((await upload.json()) as GetSkillResponse).skill;
    expect(withFile.files).toHaveLength(1);
    expect(withFile.files[0]!.name).toBe("references/rota.md");
    expect(withFile.files[0]!.key).toBe(`skills/${skill.id}/references/rota.md`);
    expect(await artifacts.exists(withFile.files[0]!.key)).toBeTrue();

    const wf = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: {
        name: "Skill Publish",
        draft: {
          trigger: { type: "manual" },
          context: { mcpConnectionIds: [], skillIds: [skill.id] },
          agent: { agentPresetId },
          instructions: { markdown: "Follow the skill." },
        },
      },
    });
    const wfId = ((await wf.json()) as GetWorkflowResponse).workflow.id;

    capturedCompiles.length = 0;
    const publish = await api("POST", `/workspaces/${orgId}/workflows/${wfId}/publish`, { cookie: ownerCookie });
    expect(publish.status).toBe(200);
    const pub = (await publish.json()) as PublishWorkflowResponse;
    await stack.runtime!.buildService.waitFor(pub.contentHash);
    await until(async () => (await stack.runtime!.buildStore.get(pub.contentHash))?.status === "succeeded" || undefined, "build to succeed");

    // The publish compile received the skill WITH its attachment bytes.
    const compiled = capturedCompiles.find((c) => c.skills.length > 0);
    expect(compiled).toBeDefined();
    expect(compiled!.skills[0]!.files).toMatchObject({ "references/rota.md": "# On-call\n- alice\n" });
  });

  test("skills: attachment over the size cap is a typed 413", async () => {
    const create = await api("POST", `/workspaces/${orgId}/skills`, { cookie: ownerCookie, body: { name: "Big", content: "x" } });
    const skillId = ((await create.json()) as GetSkillResponse).skill.id;
    const huge = new Uint8Array(6 * 1024 * 1024); // > 5 MiB cap
    const form = new FormData();
    form.append("file", new File([huge], "big.bin", { type: "application/octet-stream" }));
    const upload = await api("POST", `/workspaces/${orgId}/skills/${skillId}/files`, { cookie: ownerCookie, form });
    expect(upload.status).toBe(413);
    expect(((await upload.json()) as { error: { code: string } }).error.code).toBe("skill_file_too_large");
  });

  // ── model presets + allowlist + agents ───────────────────────────────────

  test("model presets/allowlist: re-point checks the allowlist; remove-referenced is 409", async () => {
    // Add a model to the allowlist, point the "quick" preset at it, then fail
    // to remove it while the preset references it.
    const add = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
      cookie: ownerCookie,
      body: { provider: "openrouter", modelId: "vendor/new-model" },
    });
    expect(add.status).toBe(201);
    const entryId = ((await add.json()) as { entry: { id: string } }).entry.id;

    const repoint = await api("PUT", `/workspaces/${orgId}/model-presets/quick`, {
      cookie: ownerCookie,
      body: { provider: "openrouter", modelId: "vendor/new-model" },
    });
    expect(repoint.status).toBe(200);

    const removeBlocked = await api("DELETE", `/workspaces/${orgId}/model-allowlist/${entryId}`, { cookie: ownerCookie });
    expect(removeBlocked.status).toBe(409);
    expect(((await removeBlocked.json()) as { error: { code: string } }).error.code).toBe("model_referenced_by_preset");

    // Pointing a preset at a NON-allowlisted model is a 422.
    const bad = await api("PUT", `/workspaces/${orgId}/model-presets/quick`, {
      cookie: ownerCookie,
      body: { provider: "openrouter", modelId: "vendor/not-allowed" },
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("model_not_allowlisted");
  });

  test("agent presets: CRUD + model override validated against the allowlist", async () => {
    const bad = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Custom", basePrompt: "You are custom.", modelId: "vendor/not-allowed" },
    });
    expect(bad.status).toBe(422);

    const create = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Custom", basePrompt: "You are custom." },
    });
    expect(create.status).toBe(201);
    const agentId = ((await create.json()) as { agent: { id: string } }).agent.id;

    // Duplicate name → 409.
    const dup = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Custom", basePrompt: "again" },
    });
    expect(dup.status).toBe(409);

    const del = await api("DELETE", `/workspaces/${orgId}/agents/${agentId}`, { cookie: ownerCookie });
    expect(del.status).toBe(200);
  });

  test("members: Better Auth passthrough lists the owner", async () => {
    const res = await api("GET", `/workspaces/${orgId}/members`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const members = ((await res.json()) as ListWorkspaceMembersResponse).members;
    expect(members.some((m) => m.userId === ownerUserId && m.role.includes("owner"))).toBeTrue();
  });

  // ── HITL run input + session list ────────────────────────────────────────

  test("run input: parks on approval then resumes to success; session list reflects it", async () => {
    await freshWorker();
    const draft: WorkflowDefinition = {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [], skillIds: [] },
      agent: { agentPresetId },
      instructions: { markdown: "Gate deletes behind approval." },
    };
    const wf = await api("POST", `/workspaces/${orgId}/workflows`, { cookie: ownerCookie, body: { name: "Approval WF", draft } });
    const wfId = ((await wf.json()) as GetWorkflowResponse).workflow.id;
    const pub = (await (await api("POST", `/workspaces/${orgId}/workflows/${wfId}/publish`, { cookie: ownerCookie })).json()) as PublishWorkflowResponse;
    await stack.runtime!.buildService.waitFor(pub.contentHash);
    await until(async () => (await stack.runtime!.buildStore.get(pub.contentHash))?.status === "succeeded" || undefined, "approval wf build");

    await freshWorker();
    const sessionRes = await api("POST", `/workspaces/${orgId}/workflows/${wfId}/sessions`, { cookie: ownerCookie, body: { message: "APPROVE the delete" } });
    expect(sessionRes.status).toBe(201);
    const { session, run } = (await sessionRes.json()) as CreateSessionResponse;

    // The run parks on the input request (status waiting).
    await until(async () => {
      const rows = await db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run.id));
      return rows[0]?.status === "waiting" || undefined;
    }, "run to park on input");

    // Answering with nothing pending on a DIFFERENT (fresh) run → 409, but here
    // the parked run resolves and resumes to success.
    const input = await api("POST", `/runs/${run.id}/input`, { cookie: ownerCookie, body: { requestId: "req-1", optionId: "approve" } });
    expect(input.status).toBe(200);
    const resumed = ((await input.json()) as RunInputResponse).run;
    expect(resumed.id).toBe(run.id);
    expect(fixture.inputResponses).toContainEqual({ requestId: "req-1", optionId: "approve" });

    await until(async () => {
      const rows = await db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run.id));
      return rows[0]?.status === "succeeded" || undefined;
    }, "resumed run to succeed");

    // Answering again (nothing pending now) → 409 no_pending_input.
    const again = await api("POST", `/runs/${run.id}/input`, { cookie: ownerCookie, body: { requestId: "req-1", optionId: "approve" } });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("no_pending_input");

    // Session list carries the workflow name + latest run status + ordering.
    const list = await api("GET", `/workspaces/${orgId}/sessions?workflowId=${wfId}`, { cookie: ownerCookie });
    expect(list.status).toBe(200);
    const sessions = ((await list.json()) as ListSessionsResponse).sessions;
    const listed = sessions.find((s) => s.id === session.id);
    expect(listed?.workflowName).toBe("Approval WF");
    expect(listed?.lastRunStatus).toBe("succeeded");
  });
});
