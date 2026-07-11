/**
 * Resource-CRUD integration tests — gated on TEST_DATABASE_URL (skip cleanly
 * when unset; the compose integration stage provides it).
 *
 * Covers the authz matrix (outsider 403 on paths / 404 on foreign rows; member
 * ok; owner/admin-only ops), secrets-never-echoed, the registry proxy (stubbed
 * registry), delete-referenced-connection 409 (agents reference connections
 * now), the skill attachment upload→agent-publish path (bytes threaded into
 * the compiler), model preset guards, agents CRUD (+ inline dry-run
 * diagnostics, run-as membership, delete guard), member passthrough, and the
 * HITL run-input round trip against a fake eve worker that parks on approval.
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
  type AgentDefinitionInput,
  type CreateSessionResponse,
  type GetAgentResponse,
  type GetMcpConnectionResponse,
  type GetSkillResponse,
  type GetWorkflowResponse,
  type ListMcpConnectionsResponse,
  type ListSessionsResponse,
  type ListWorkflowsResponse,
  type ListWorkspaceMembersResponse,
  type PublishAgentResponse,
  type RegistrySearchResponse,
  type RegistryServerSummary,
  type RunInputResponse,
  type UpdateAgentResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import {
  AgentCompileError,
  type CompileRequest,
  type CompileAgentFn,
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

const stubCompile: CompileAgentFn = (request) => {
  capturedCompiles.push(request);
  if (request.definition.persona.trim() === "") {
    throw new AgentCompileError([
      { path: "persona", message: "persona must not be empty" },
    ]);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        definition: request.definition,
        model: request.model.modelId,
        connections: request.connections.map((c) => [c.name, c.url, c.envTokenVar, c.authHeaders]),
        skills: request.skills.map((s) => [s.name, s.content, s.files ?? null]),
        agent: request.agentSlug,
        eve: STUB_EVE_VERSION,
      }),
    )
    .digest("hex");
  return {
    files: new Map([["agent/instructions.md", request.definition.persona]]),
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

/** Minimal valid AgentDefinition draft for these tests. */
function agentDraft(overrides: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    persona: "Be helpful.",
    model: { preset: "balanced", reasoning: "medium" },
    context: { mcpConnectionIds: [], skillIds: [] },
    ...overrides,
  };
}

if (!TEST_DATABASE_URL) {
  console.warn("[resources] TEST_DATABASE_URL not set — skipping resource integration tests");
}

describe.skipIf(!TEST_DATABASE_URL)("resource CRUD integration", () => {
  const fixture = new FakeWorker();
  const artifacts = createMemoryArtifactStore();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  /** Stubbed OpenRouter catalog state: null = unreachable (fail-open). */
  let openRouterCatalogIds: ReadonlySet<string> | null = null;

  let ownerCookie: string;
  let orgId: string;
  let ownerUserId: string;
  /** The seeded "General Purpose" agent (chat + HITL target). */
  let seededAgentId: string;

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
      {
        compile: stubCompile,
        buildSteps: fakeBuildSteps(),
        artifacts,
        registry: stubRegistry,
        // Stubbed OpenRouter catalog: null = "unavailable" (fail-open), so
        // the fake `vendor/...` ids used across this suite stay allowlistable
        // regardless of network; individual tests set `openRouterCatalogIds`
        // to exercise the catalog check.
        openRouterModelIds: async () => openRouterCatalogIds,
      },
    );
    db = stack.dbHandle.db;

    const owner = await signUpWithOrg("Res Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    ownerUserId = owner.userId;
    await seedWorkspace(db, orgId, ownerUserId);
    const seeded = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.organizationId, orgId), eq(schema.agents.name, "General Purpose")));
    seededAgentId = seeded[0]!.id;

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
    expect(wf.published).toBeNull();
    expect(wf.enabled).toBeTrue();

    // Draft update returns validator diagnostics inline.
    const draft = {
      trigger: { type: "manual" },
      agentId: seededAgentId,
      instructions: { markdown: "Be helpful." },
    };
    const patch = await api("PATCH", `/workspaces/${orgId}/workflows/${wf.id}`, { cookie: ownerCookie, body: { draft } });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as GetWorkflowResponse;
    expect(Array.isArray(patchBody.diagnostics)).toBeTrue();

    // List summaries surface the draft trigger type + agent name.
    const list = await api("GET", `/workspaces/${orgId}/workflows`, { cookie: ownerCookie });
    const workflows = ((await list.json()) as ListWorkflowsResponse).workflows;
    const summary = workflows.find((w) => w.id === wf.id);
    expect(summary?.triggerType).toBe("manual");
    expect(summary?.agentName).toBe("General Purpose");

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

  test("mcp connections: DELETE blocked (409) while an agent references it", async () => {
    const create = await api("POST", `/workspaces/${orgId}/mcp-connections`, {
      cookie: ownerCookie,
      body: { name: "Referenced", url: "https://mcp.example/ref" },
    });
    const connId = ((await create.json()) as GetMcpConnectionResponse).connection.id;
    const agent = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: {
        name: "Uses Connection",
        draft: agentDraft({
          persona: "Use it.",
          context: { mcpConnectionIds: [connId], skillIds: [] },
        }),
      },
    });
    expect(agent.status).toBe(201);
    const agentName = ((await agent.json()) as GetAgentResponse).agent.name;

    const del = await api("DELETE", `/workspaces/${orgId}/mcp-connections/${connId}`, { cookie: ownerCookie });
    expect(del.status).toBe(409);
    // details = bare array of referencing AGENT names (the SPA blocker parser
    // reads bare arrays and keyed shapes alike).
    const body = (await del.json()) as { error: { code: string; details?: string[] } };
    expect(body.error.code).toBe("connection_in_use");
    expect(body.error.details).toContain(agentName);
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

  // ── skills + attachments → agent publish threads bytes into the compiler ──

  test("skills: CRUD + attachment upload; agent publish emits the packaged skill", async () => {
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

    const agentRes = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: {
        name: "Skill Agent",
        draft: agentDraft({
          persona: "Follow the skill.",
          context: { mcpConnectionIds: [], skillIds: [skill.id] },
        }),
      },
    });
    expect(agentRes.status).toBe(201);
    const skillAgentId = ((await agentRes.json()) as GetAgentResponse).agent.id;

    capturedCompiles.length = 0;
    const publish = await api("POST", `/workspaces/${orgId}/agents/${skillAgentId}/publish`, { cookie: ownerCookie });
    expect(publish.status).toBe(200);
    const pub = (await publish.json()) as PublishAgentResponse;
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

  // ── model presets + allowlist ────────────────────────────────────────────

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

  test("allowlist add validates OpenRouter ids: shape 422s, catalog-unknown 422s, catalog-known passes, catalog-down fails open (keyed-run papercut: invalid ids used to fail only at run time)", async () => {
    // Wrong grammar for the provider — schema-level 422 (no catalog needed).
    const badShape = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
      cookie: ownerCookie,
      body: { provider: "openrouter", modelId: "no-vendor-prefix" },
    });
    expect(badShape.status).toBe(422);
    expect(((await badShape.json()) as { error: { code: string } }).error.code).toBe("invalid_body");
    const gatewayIdOnAnthropic = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
      cookie: ownerCookie,
      body: { provider: "anthropic", modelId: "anthropic/claude-opus-4-8" },
    });
    expect(gatewayIdOnAnthropic.status).toBe(422);

    // Catalog reachable: unknown id → typed 422; known id → 201. (The
    // gateway-slug/OpenRouter-slug confusion is exactly the keyed-run case:
    // "moonshot/kimi-k3" vs OpenRouter's real "moonshotai/kimi-k3".)
    openRouterCatalogIds = new Set(["moonshotai/kimi-k3"]);
    try {
      const unknown = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
        cookie: ownerCookie,
        body: { provider: "openrouter", modelId: "moonshot/kimi-k3" },
      });
      expect(unknown.status).toBe(422);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("model_unknown_to_openrouter");

      const known = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
        cookie: ownerCookie,
        body: { provider: "openrouter", modelId: "moonshotai/kimi-k3" },
      });
      expect(known.status).toBe(201);
    } finally {
      openRouterCatalogIds = null;
    }

    // Catalog unreachable (null): fail OPEN — the add succeeds unchecked.
    const failOpen = await api("POST", `/workspaces/${orgId}/model-allowlist`, {
      cookie: ownerCookie,
      body: { provider: "openrouter", modelId: "vendor/offline-model" },
    });
    expect(failOpen.status).toBe(201);
  });

  // ── agents CRUD ──────────────────────────────────────────────────────────

  test("agents: CRUD + inline dry-run diagnostics + run-as membership + delete guard", async () => {
    // run_as user must be a workspace member.
    const badRunAs = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Bad RunAs", runAsUserId: "not-a-member" },
    });
    expect(badRunAs.status).toBe(422);
    expect(((await badRunAs.json()) as { error: { code: string } }).error.code).toBe("run_as_user_not_member");

    const create = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Custom", draft: agentDraft() },
    });
    expect(create.status).toBe(201);
    const agent = ((await create.json()) as GetAgentResponse).agent;
    // run-as defaults to the creator.
    expect(agent.runAsUserId).toBe(ownerUserId);

    // Duplicate name → 409 (names feed the content hash via the slug).
    const dup = await api("POST", `/workspaces/${orgId}/agents`, {
      cookie: ownerCookie,
      body: { name: "Custom" },
    });
    expect(dup.status).toBe(409);

    // Draft PATCH returns dry-run diagnostics inline: a non-allowlisted
    // model override is the diagnostics PAYLOAD, not a failed save.
    const badModel = await api("PATCH", `/workspaces/${orgId}/agents/${agent.id}`, {
      cookie: ownerCookie,
      body: {
        draft: agentDraft({
          model: { preset: "balanced", modelId: "vendor/not-allowed", reasoning: "medium" },
        }),
      },
    });
    expect(badModel.status).toBe(200);
    const badModelBody = (await badModel.json()) as UpdateAgentResponse;
    expect(badModelBody.diagnostics).toMatchObject({
      ok: false,
      error: { code: "model_not_allowlisted" },
    });

    const goodPatch = await api("PATCH", `/workspaces/${orgId}/agents/${agent.id}`, {
      cookie: ownerCookie,
      body: { draft: agentDraft({ persona: "You are custom." }) },
    });
    expect(goodPatch.status).toBe(200);
    const goodBody = (await goodPatch.json()) as UpdateAgentResponse;
    expect(goodBody.diagnostics).toMatchObject({ ok: true });

    // DELETE is guarded while a workflow references the agent.
    const wf = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: {
        name: "Uses Agent",
        draft: {
          trigger: { type: "manual" },
          agentId: agent.id,
          instructions: { markdown: "Delegate." },
        },
      },
    });
    expect(wf.status).toBe(201);
    const wfId = ((await wf.json()) as GetWorkflowResponse).workflow.id;

    const blocked = await api("DELETE", `/workspaces/${orgId}/agents/${agent.id}`, { cookie: ownerCookie });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("agent_in_use");

    await api("DELETE", `/workspaces/${orgId}/workflows/${wfId}`, { cookie: ownerCookie });

    // A member (non-admin) cannot delete; an owner/admin can.
    await db.update(schema.member).set({ role: "member" }).where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    const denied = await api("DELETE", `/workspaces/${orgId}/agents/${agent.id}`, { cookie: ownerCookie });
    expect(denied.status).toBe(403);
    await db.update(schema.member).set({ role: "owner" }).where(and(eq(schema.member.userId, ownerUserId), eq(schema.member.organizationId, orgId)));
    const del = await api("DELETE", `/workspaces/${orgId}/agents/${agent.id}`, { cookie: ownerCookie });
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
    // Publish the seeded "General Purpose" agent and chat with it.
    const pub = (await (await api("POST", `/workspaces/${orgId}/agents/${seededAgentId}/publish`, { cookie: ownerCookie })).json()) as PublishAgentResponse;
    await stack.runtime!.buildService.waitFor(pub.contentHash);
    await until(async () => (await stack.runtime!.buildStore.get(pub.contentHash))?.status === "succeeded" || undefined, "seeded agent build");

    await freshWorker();
    const sessionRes = await api("POST", `/workspaces/${orgId}/agents/${seededAgentId}/sessions`, { cookie: ownerCookie, body: { message: "APPROVE the delete" } });
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

    // Session list carries the agent name + latest run status; direct chat
    // has no workflow provenance.
    const list = await api("GET", `/workspaces/${orgId}/sessions?agentId=${seededAgentId}`, { cookie: ownerCookie });
    expect(list.status).toBe(200);
    const sessions = ((await list.json()) as ListSessionsResponse).sessions;
    const listed = sessions.find((s) => s.id === session.id);
    expect(listed?.agentName).toBe("General Purpose");
    expect(listed?.workflowName).toBeNull();
    expect(listed?.lastRunStatus).toBe("succeeded");
  });
});
