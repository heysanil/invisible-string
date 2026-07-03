/**
 * Runtime-API integration tests — gated on TEST_DATABASE_URL (skip cleanly
 * when unset; the compose integration stage provides it).
 *
 * Full loop against a FAKE agent/worker (one Bun.serve speaking the eve HTTP
 * contract verified in Phase 0: 202 session create, NDJSON stream with
 * `?startIndex=` resume, continuation-token follow-ups) with a stub compiler
 * and fake build steps injected:
 *
 *   publish → version snapshot + build (cache + idempotency)
 *   dry-run-compile → structured errors
 *   session create → scheduler → ensure-agent env contract → eve 202 →
 *     agent_sessions/runs rows → tailer → run_events
 *   SSE → Last-Event-ID replay + live follow
 *   follow-up message → same eve session, new run, startIndex resume
 *   ownership → 403 (foreign workspace path) / 404 (foreign rows)
 *   caps → 429 at the per-workspace concurrent-run cap
 *
 * The REAL compiler + `eve build` path is exercised in the Integrate stage,
 * not here (per plan).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  encryptSecret,
  generateMasterKeyBase64,
  parseMasterKey,
  type CreateSessionResponse,
  type GetSessionResponse,
  type PostMessageResponse,
  type PublishWorkflowResponse,
  type RunEventFrame,
  type RunStatusFrame,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import {
  WorkflowCompileError,
  type CompileWorkflowFn,
} from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { runMigrations } from "../migrate";
import { mcpAuthAadContext } from "./agent-env";
import {
  derivePlatformJwtSecret,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "./jwt";
import { reconcileInterruptedRuns } from "./reconcile";
import { createAppStack, type AppStack } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const PLATFORM_JWT_SECRET = "itest-platform-jwt-secret-000000";
const WORKER_SHARED_SECRET = "itest-worker-shared-secret-00000";
const OPENROUTER_KEY = "test-openrouter-key";
const OPENROUTER_BASE_URL = "http://localhost:9910/v1";
const MASTER_KEY_B64 = generateMasterKeyBase64();

// ── fake agent/worker fixture ───────────────────────────────────────────────

interface FakeEveSession {
  id: string;
  continuationToken: string;
  /** NDJSON lines, appended per turn. */
  events: string[];
  turns: number;
  receivedMessages: string[];
}

interface EnsureCall {
  hash: string;
  artifactUrl: string;
  env: Record<string, string>;
}

interface StreamCall {
  sessionId: string;
  startIndex: number;
}

const TERMINAL_TYPES = new Set([
  "session.waiting",
  "session.completed",
  "session.failed",
]);

class FakeWorker {
  readonly sessions = new Map<string, FakeEveSession>();
  readonly ensureCalls: EnsureCall[] = [];
  readonly streamCalls: StreamCall[] = [];
  readonly continueTokens: string[] = [];
  jwtFailures = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private counter = 0;

  get url(): string {
    if (!this.server) throw new Error("fixture not started");
    return `http://localhost:${this.server.port}`;
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

  private async verifyJwt(req: Request, hash: string): Promise<boolean> {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    try {
      // Version-bound contract: DERIVED secret + per-hash audience — a token
      // minted with the platform master or another version's params fails.
      await jwtVerify(
        token,
        new TextEncoder().encode(derivePlatformJwtSecret(PLATFORM_JWT_SECRET, hash)),
        {
          issuer: PLATFORM_JWT_ISSUER,
          audience: platformJwtAudienceForHash(hash),
        },
      );
      return true;
    } catch {
      this.jwtFailures += 1;
      return false;
    }
  }

  private pushTurn(session: FakeEveSession, message: string): void {
    const turn = session.turns++;
    const turnId = `turn_${turn}`;
    const hold = message.includes("HOLD");
    const events: unknown[] = [];
    if (turn === 0) {
      events.push({
        type: "session.started",
        data: { runtime: { agentId: "fake-agent", eveVersion: "0.19.0", modelId: "fake" } },
      });
    }
    events.push(
      { type: "turn.started", data: { sequence: turn, turnId } },
      { type: "message.received", data: { message, sequence: turn, turnId } },
      {
        type: "message.appended",
        data: { messageDelta: `echo:${message}`, messageSoFar: `echo:${message}`, sequence: turn, stepIndex: 0, turnId },
      },
      {
        type: "message.completed",
        data: { finishReason: "stop", message: `echo:${message}`, sequence: turn, stepIndex: 0, turnId },
      },
      { type: "step.completed", data: { finishReason: "stop", sequence: turn, stepIndex: 0, turnId } },
      { type: "turn.completed", data: { sequence: turn, turnId } },
    );
    if (!hold) {
      events.push({ type: "session.waiting", data: { wait: "next-user-message" } });
    }
    for (const event of events) session.events.push(JSON.stringify(event));
    session.receivedMessages.push(message);
  }

  private streamResponse(session: FakeEveSession, startIndex: number): Response {
    const encoder = new TextEncoder();
    let index = startIndex;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const pump = () => {
          while (index < session.events.length) {
            const line = session.events[index++]!;
            controller.enqueue(encoder.encode(`${line}\n`));
            const type = (JSON.parse(line) as { type: string }).type;
            if (TERMINAL_TYPES.has(type)) {
              if (timer !== null) clearInterval(timer);
              controller.close();
              return;
            }
          }
        };
        pump();
        // Held sessions: keep the stream open, drip new events as they land.
        timer = setInterval(() => {
          try {
            pump();
          } catch {
            if (timer !== null) clearInterval(timer);
          }
        }, 10);
      },
      cancel: () => {
        if (timer !== null) clearInterval(timer);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Internal plane: ensure-agent (shared secret; the real worker contract —
    // POST /internal/agents/ensure + x-worker-secret + {versionHash,...}).
    if (path === "/internal/agents/ensure" && req.method === "POST") {
      if (req.headers.get("x-worker-secret") !== WORKER_SHARED_SECRET) {
        return Response.json({ error: "bad shared secret" }, { status: 401 });
      }
      const body = (await req.json()) as {
        versionHash: string;
        artifactUrl: string;
        env: Record<string, string>;
      };
      this.ensureCalls.push({
        hash: body.versionHash,
        artifactUrl: body.artifactUrl,
        env: body.env,
      });
      return Response.json({ ok: true });
    }

    // Agent proxy plane: /agents/:hash/eve/v1/...
    const proxyMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/(.*)$/);
    if (!proxyMatch) return new Response("not found", { status: 404 });
    if (!(await this.verifyJwt(req, proxyMatch[1]!))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const sub = proxyMatch[2]!;

    if (sub === "session" && req.method === "POST") {
      const body = (await req.json()) as { message: string };
      const id = `eve-sess-${++this.counter}`;
      const session: FakeEveSession = {
        id,
        continuationToken: `ct-${id}`,
        events: [],
        turns: 0,
        receivedMessages: [],
      };
      this.sessions.set(id, session);
      this.pushTurn(session, body.message);
      // eve acks asynchronously with 202 (Phase-0 fact).
      return Response.json(
        { sessionId: id, continuationToken: session.continuationToken },
        { status: 202 },
      );
    }

    const continueMatch = sub.match(/^session\/([^/]+)$/);
    if (continueMatch && req.method === "POST") {
      const session = this.sessions.get(continueMatch[1]!);
      if (!session) return new Response("no session", { status: 404 });
      const body = (await req.json()) as { continuationToken: string; message?: string };
      this.continueTokens.push(body.continuationToken);
      if (body.continuationToken !== session.continuationToken) {
        return Response.json({ error: "bad continuation token" }, { status: 409 });
      }
      if (body.message) this.pushTurn(session, body.message);
      return Response.json({}, { status: 202 });
    }

    const streamMatch = sub.match(/^session\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      const session = this.sessions.get(streamMatch[1]!);
      if (!session) return new Response("no session", { status: 404 });
      const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
      this.streamCalls.push({ sessionId: session.id, startIndex });
      return this.streamResponse(session, startIndex);
    }

    return new Response("not found", { status: 404 });
  }
}

// ── stub compiler + fake build steps ────────────────────────────────────────

const STUB_EVE_VERSION = "0.19.0";

const stubCompile: CompileWorkflowFn = (request) => {
  if (request.definition.instructions.markdown.trim() === "") {
    throw new WorkflowCompileError([
      { path: "instructions.markdown", message: "instructions must not be empty" },
    ]);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        definition: request.definition,
        model: { provider: request.model.provider, modelId: request.model.modelId },
        connections: request.connections.map((c) => [c.name, c.url, c.envTokenVar]),
        skills: request.skills.map((s) => [s.name, s.content]),
        eve: STUB_EVE_VERSION,
      }),
    )
    .digest("hex");
  return {
    files: new Map([
      ["package.json", JSON.stringify({ name: "stub-agent", private: true })],
      ["instructions.md", request.definition.instructions.markdown],
    ]),
    hash,
    compilerVersion: "stub-compiler-1",
    eveVersion: STUB_EVE_VERSION,
  };
};

function fakeBuildSteps(): { steps: BuildSteps; provisionedHashes: string[] } {
  const provisionedHashes: string[] = [];
  return {
    provisionedHashes,
    steps: {
      async writeFiles() {},
      async install() {},
      async eveBuild() {},
      async provisionWorld(hash) {
        provisionedHashes.push(hash);
      },
      async packageArtifact(_dir, hash) {
        return new TextEncoder().encode(`fake-tarball-${hash}`);
      },
    },
  };
}

// ── SSE reading helpers ─────────────────────────────────────────────────────

interface SseFrame {
  event: string;
  id: string | null;
  data: unknown;
}

async function readSse(
  response: Response,
  options: { until?: (frame: SseFrame) => boolean; timeoutMs?: number } = {},
): Promise<SseFrame[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames: SseFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error("SSE read timed out");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseSseBlock(block);
        if (frame) {
          frames.push(frame);
          if (options.until?.(frame)) return frames;
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function parseSseBlock(block: string): SseFrame | null {
  let event = "message";
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("id: ")) id = line.slice(4).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    else if (line.startsWith("retry:")) return null;
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: JSON.parse(dataLines.join("\n")) };
}

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

if (!TEST_DATABASE_URL) {
  console.warn(
    "[runtime] TEST_DATABASE_URL not set — skipping runtime integration tests (integration stage provides it)",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("runtime API integration", () => {
  const fixture = new FakeWorker();
  const artifacts = createMemoryArtifactStore();
  const { steps, provisionedHashes } = fakeBuildSteps();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];

  // Owner workspace state shared across tests.
  let ownerCookie: string;
  let orgId: string;
  let workflowId: string;
  let agentPresetId: string;
  let mcpConnectionId: string;
  let definition: WorkflowDefinition;
  let contentHash: string;
  let versionId: string;
  let sessionId: string;
  let firstRunId: string;
  let heldSessionId: string;

  async function api(
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return stack.app.handle(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
    );
  }

  async function signUpWithOrg(name: string): Promise<{ cookie: string; orgId: string; userId: string }> {
    const email = `rt-${randomUUID()}@example.com`;
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

  async function freshWorkerHeartbeat(): Promise<void> {
    await db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date(), status: "live" })
      .where(eq(schema.workers.address, fixture.url));
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    fixture.start();

    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "runtime-integration-secret-000000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET,
        WORKER_SHARED_SECRET,
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        OPENROUTER_BASE_URL,
        MAX_CONCURRENT_RUNS_PER_WORKSPACE: "2",
        // The fake worker fixture serves plain http on localhost.
        ALLOW_INSECURE_WORKER_TRANSPORT: "1",
        SSE_HEARTBEAT_MS: "50",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-itest-builds"),
      },
      { compile: stubCompile, buildSteps: steps, artifacts },
    );
    db = stack.dbHandle.db;
    expect(stack.runtime).not.toBeNull();

    const owner = await signUpWithOrg("Runtime Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    await seedWorkspace(db, orgId);

    const agentRows = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, orgId));
    agentPresetId = agentRows[0]!.id;

    // MCP connection with an envelope-encrypted token (workspace scope).
    const mcpRows = await db
      .insert(schema.mcpConnections)
      .values({
        scope: "workspace",
        organizationId: orgId,
        name: "linear",
        source: "custom",
        url: "https://mcp.example.com/mcp",
      })
      .returning({ id: schema.mcpConnections.id });
    mcpConnectionId = mcpRows[0]!.id;
    const envelope = encryptSecret(
      JSON.stringify({ token: "lin-secret-token" }),
      parseMasterKey(MASTER_KEY_B64),
      mcpAuthAadContext(mcpConnectionId),
    );
    await db
      .update(schema.mcpConnections)
      .set({ authConfigEncrypted: JSON.stringify(envelope) })
      .where(eq(schema.mcpConnections.id, mcpConnectionId));

    definition = {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [mcpConnectionId], skillIds: [] },
      agent: { agentPresetId },
      instructions: { markdown: "Be helpful. Use @linear when asked." },
    };
    const wfRows = await db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name: "Runtime Test Workflow",
        runAsUserId: owner.userId,
        draft: definition as unknown as Record<string, unknown>,
      })
      .returning({ id: schema.workflows.id });
    workflowId = wfRows[0]!.id;

    await db.insert(schema.workers).values({
      address: fixture.url,
      status: "live",
      lastHeartbeatAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
    fixture.stop();
  }, 30_000);

  // ── publish + build ───────────────────────────────────────────────────────

  test("publish snapshots an immutable version, resolves the model, and builds", async () => {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishWorkflowResponse;
    expect(body.workflowId).toBe(workflowId);
    expect(body.contentHash).toHaveLength(64);
    expect(body.cached).toBeFalse();
    contentHash = body.contentHash;
    versionId = body.versionId;

    // Deterministic wait: the in-flight build promise (or already done).
    await stack.runtime!.buildService.waitFor(contentHash);
    const build = await until(
      async () => {
        const record = await stack.runtime!.buildStore.get(contentHash);
        return record?.status === "succeeded" ? record : undefined;
      },
      "build to succeed",
    );
    expect(build.artifactKey).toBe(`artifacts/${contentHash}.tar.gz`);
    expect(await artifacts.exists(build.artifactKey!)).toBeTrue();

    // World provisioned once for this version (design correction #10).
    expect(provisionedHashes).toEqual([contentHash]);

    // Version row: immutable snapshot + resolved model (balanced preset).
    const versions = await db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.id, versionId));
    expect(versions[0]).toMatchObject({
      contentHash,
      compilerVersion: "stub-compiler-1",
      eveVersion: STUB_EVE_VERSION,
      modelProvider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      buildStatus: "succeeded",
    });

    // Draft is now published.
    const wf = await db
      .select({ publishedVersionId: schema.workflows.publishedVersionId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId));
    expect(wf[0]?.publishedVersionId).toBe(versionId);
  });

  test("republish of an identical draft is idempotent by hash (cache hit)", async () => {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishWorkflowResponse;
    expect(body.versionId).toBe(versionId);
    expect(body.contentHash).toBe(contentHash);
    expect(body.buildStatus).toBe("succeeded");
    expect(body.cached).toBeTrue();
    // No second world provisioning, no second build.
    expect(provisionedHashes).toEqual([contentHash]);
  });

  test("dry-run-compile: ok+hash for a valid draft; structured errors otherwise", async () => {
    const ok = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/versions/dry-run-compile`,
      { cookie: ownerCookie },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, contentHash });

    // Empty instructions → compiler's typed error, surfaced structurally.
    await db
      .update(schema.workflows)
      .set({
        draft: {
          ...definition,
          instructions: { markdown: "" },
        } as unknown as Record<string, unknown>,
      })
      .where(eq(schema.workflows.id, workflowId));
    const bad = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/versions/dry-run-compile`,
      { cookie: ownerCookie },
    );
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { ok: boolean; error: { code: string } };
    expect(badBody.ok).toBeFalse();
    expect(badBody.error.code).toBe("compile_failed");

    // Non-allowlisted model override → typed model error (pre-compile).
    await db
      .update(schema.workflows)
      .set({
        draft: {
          ...definition,
          agent: { agentPresetId, modelId: "not/allowed" },
        } as unknown as Record<string, unknown>,
      })
      .where(eq(schema.workflows.id, workflowId));
    const banned = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/versions/dry-run-compile`,
      { cookie: ownerCookie },
    );
    const bannedBody = (await banned.json()) as { ok: boolean; error: { code: string } };
    expect(bannedBody.ok).toBeFalse();
    expect(bannedBody.error.code).toBe("model_not_allowlisted");

    // Restore the good draft.
    await db
      .update(schema.workflows)
      .set({ draft: definition as unknown as Record<string, unknown> })
      .where(eq(schema.workflows.id, workflowId));
  });

  // ── sessions + runs + tailer ─────────────────────────────────────────────

  test("session creation dispatches with the exact env contract and tails run events", async () => {
    await freshWorkerHeartbeat();
    const res = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
      { cookie: ownerCookie, body: { message: "hello agent" } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    sessionId = body.session.id;
    firstRunId = body.run.id;
    expect(body.session.eveSessionId).toBe("eve-sess-1");
    expect(body.session.workflowVersionId).toBe(versionId);
    expect(body.run.triggerEvent).toMatchObject({
      workflowId,
      triggerType: "manual",
      message: "hello agent",
    });

    // ensure-agent env contract (SECRETS go here and only here).
    expect(fixture.ensureCalls).toHaveLength(1);
    const ensure = fixture.ensureCalls[0]!;
    expect(ensure.hash).toBe(contentHash);
    expect(ensure.artifactUrl).toContain(`${contentHash}.tar.gz`);
    expect(ensure.env.WORKFLOW_POSTGRES_URL).toContain(
      `ws_v_${contentHash.slice(0, 12)}`,
    );
    expect(ensure.env.WORKFLOW_POSTGRES_JOB_PREFIX).toBe(contentHash);
    // The agent receives the DERIVED per-version secret, never the master.
    expect(ensure.env.PLATFORM_JWT_SECRET).toBe(
      derivePlatformJwtSecret(PLATFORM_JWT_SECRET, contentHash),
    );
    expect(ensure.env.PLATFORM_JWT_SECRET).not.toBe(PLATFORM_JWT_SECRET);
    expect(ensure.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("5");
    expect(ensure.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe("5");
    expect(ensure.env.OPENROUTER_API_KEY).toBe(OPENROUTER_KEY);
    expect(ensure.env.OPENROUTER_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(ensure.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(ensure.env.MCP_LINEAR_TOKEN).toBe("lin-secret-token");

    // The tailer lands the full scripted turn in run_events, then the run
    // is marked succeeded (session.waiting with no pending input).
    await until(async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, firstRunId));
      return rows[0]?.status === "succeeded" || undefined;
    }, "first run to succeed");

    const events = await db
      .select({ seq: schema.runEvents.seq, event: schema.runEvents.event })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, firstRunId))
      .orderBy(schema.runEvents.seq);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((events.at(-1)!.event as { type: string }).type).toBe("session.waiting");
    expect(fixture.streamCalls[0]).toEqual({ sessionId: "eve-sess-1", startIndex: 0 });
    expect(fixture.jwtFailures).toBe(0);

    // Session detail endpoint sees the run.
    const detail = await api("GET", `/sessions/${sessionId}`, { cookie: ownerCookie });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as GetSessionResponse;
    expect(detailBody.session.id).toBe(sessionId);
    expect(detailBody.runs).toHaveLength(1);
    expect(detailBody.runs[0]!.status).toBe("succeeded");
  });

  test("follow-up message continues the SAME eve session as a new run (startIndex resume)", async () => {
    await freshWorkerHeartbeat();
    const res = await api("POST", `/sessions/${sessionId}/messages`, {
      cookie: ownerCookie,
      body: { message: "follow-up question" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PostMessageResponse;
    expect(body.run.agentSessionId).toBe(sessionId);
    expect(body.run.id).not.toBe(firstRunId);

    await until(async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, body.run.id));
      return rows[0]?.status === "succeeded" || undefined;
    }, "follow-up run to succeed");

    // Continuation token round-tripped; second turn tailed from startIndex 8.
    expect(fixture.continueTokens).toEqual(["ct-eve-sess-1"]);
    const session = fixture.sessions.get("eve-sess-1")!;
    expect(session.receivedMessages).toEqual(["hello agent", "follow-up question"]);
    expect(fixture.streamCalls.at(-1)).toEqual({ sessionId: "eve-sess-1", startIndex: 8 });

    // New run's events are seq 0.. again (per-run monotonic; 7 events, no
    // session.started on a follow-up turn).
    const events = await db
      .select({ seq: schema.runEvents.seq })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, body.run.id));
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  // ── SSE ─────────────────────────────────────────────────────────────────

  test("SSE replays run_events and closes with a terminal run_status", async () => {
    const res = await api("GET", `/runs/${firstRunId}/stream`, { cookie: ownerCookie });
    const frames = await readSse(res, {
      until: (frame) => frame.event === "run_status",
    });
    const eventFrames = frames.filter((f) => f.event === "run_event");
    expect(eventFrames).toHaveLength(8);
    expect(eventFrames.map((f) => Number(f.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((eventFrames[0]!.data as RunEventFrame).event.type).toBe("session.started");
    const status = frames.at(-1)!.data as RunStatusFrame;
    expect(status).toMatchObject({ runId: firstRunId, status: "succeeded" });
  });

  test("SSE resumes from Last-Event-ID without replaying consumed events", async () => {
    const res = await api("GET", `/runs/${firstRunId}/stream`, {
      cookie: ownerCookie,
      headers: { "last-event-id": "3" },
    });
    const frames = await readSse(res, {
      until: (frame) => frame.event === "run_status",
    });
    const eventFrames = frames.filter((f) => f.event === "run_event");
    expect(eventFrames.map((f) => Number(f.id))).toEqual([4, 5, 6, 7]);
  });

  test("SSE live-follows an in-flight run to its terminal status", async () => {
    await freshWorkerHeartbeat();
    const created = await api("POST", `/sessions/${sessionId}/messages`, {
      cookie: ownerCookie,
      body: { message: "stream me live" },
    });
    expect(created.status).toBe(201);
    const { run } = (await created.json()) as PostMessageResponse;

    const res = await api("GET", `/runs/${run.id}/stream`, { cookie: ownerCookie });
    const frames = await readSse(res, {
      until: (frame) =>
        frame.event === "run_status" &&
        (frame.data as RunStatusFrame).status === "succeeded",
    });
    const eventFrames = frames.filter((f) => f.event === "run_event");
    expect(eventFrames.length).toBe(7);
    const seqs = eventFrames.map((f) => Number(f.id));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  // ── ownership ───────────────────────────────────────────────────────────

  test("ownership: foreign workspaces get 403 on paths and 404 on rows; anonymous gets 401", async () => {
    const stranger = await signUpWithOrg("Stranger");

    // Path addresses a workspace that is not the caller's active one → 403.
    const publish = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/publish`,
      { cookie: stranger.cookie },
    );
    expect(publish.status).toBe(403);

    // Rows owned by another workspace are invisible → 404.
    const session = await api("GET", `/sessions/${sessionId}`, {
      cookie: stranger.cookie,
    });
    expect(session.status).toBe(404);

    const message = await api("POST", `/sessions/${sessionId}/messages`, {
      cookie: stranger.cookie,
      body: { message: "let me in" },
    });
    expect(message.status).toBe(404);

    const stream = await api("GET", `/runs/${firstRunId}/stream`, {
      cookie: stranger.cookie,
    });
    expect(stream.status).toBe(404);

    // The stranger's snooping never reached the worker plane.
    expect(fixture.sessions.get("eve-sess-1")!.receivedMessages).not.toContain("let me in");

    // No session at all → 401.
    const anon = await api("GET", `/sessions/${sessionId}`);
    expect(anon.status).toBe(401);
  });

  // ── caps ────────────────────────────────────────────────────────────────

  test("per-workspace concurrent-run cap returns 429 (sessions AND messages)", async () => {
    await freshWorkerHeartbeat();
    // Two held runs occupy the whole cap (MAX_CONCURRENT_RUNS_PER_WORKSPACE=2).
    const first = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
      { cookie: ownerCookie, body: { message: "HOLD one" } },
    );
    expect(first.status).toBe(201);
    heldSessionId = ((await first.json()) as CreateSessionResponse).session.id;
    const second = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
      { cookie: ownerCookie, body: { message: "HOLD two" } },
    );
    expect(second.status).toBe(201);

    await until(async () => {
      const active = await db
        .select({ status: schema.runs.status })
        .from(schema.runs);
      return (
        active.filter((r) => r.status === "running" || r.status === "queued").length >= 2 ||
        undefined
      );
    }, "both held runs to be active");

    const third = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
      { cookie: ownerCookie, body: { message: "one too many" } },
    );
    expect(third.status).toBe(429);
    const thirdBody = (await third.json()) as { error: { code: string } };
    expect(thirdBody.error.code).toBe("workspace_run_cap_exceeded");

    const followUp = await api("POST", `/sessions/${sessionId}/messages`, {
      cookie: ownerCookie,
      body: { message: "also too many" },
    });
    expect(followUp.status).toBe(429);
  });

  test("a second message while a run is still active on the SAME session → 409 session_busy", async () => {
    // Two tails on one eve NDJSON stream corrupt run_events and resume
    // points — the message route must serialize runs per session. This
    // fires BEFORE the cap check (the workspace is also at its cap here).
    const res = await api("POST", `/sessions/${heldSessionId}/messages`, {
      cookie: ownerCookie,
      body: { message: "second message mid-run" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_busy");
  });

  test("no live worker → typed 503 (fresh workspace, stale heartbeats)", async () => {
    // Stale EVERY worker: selectWorker is global (not workspace-scoped), so a
    // live row from another suite/run sharing this DB would otherwise be
    // dispatched to and turn this into a 502.
    await db
      .update(schema.workers)
      .set({ lastHeartbeatAt: new Date(Date.now() - 120_000) });

    // Use a FRESH workspace so the run cap (already saturated above) does
    // not shadow the scheduler error.
    const fresh = await signUpWithOrg("Scheduler Test");
    await seedWorkspace(db, fresh.orgId);
    const agentRows = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, fresh.orgId));
    const freshDefinition: WorkflowDefinition = {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [], skillIds: [] },
      agent: { agentPresetId: agentRows[0]!.id },
      instructions: { markdown: "Hi." },
    };
    const wf = await db
      .insert(schema.workflows)
      .values({
        organizationId: fresh.orgId,
        name: "Scheduler wf",
        runAsUserId: fresh.userId,
        draft: freshDefinition as unknown as Record<string, unknown>,
      })
      .returning({ id: schema.workflows.id });
    const publish = await api(
      "POST",
      `/workspaces/${fresh.orgId}/workflows/${wf[0]!.id}/publish`,
      { cookie: fresh.cookie },
    );
    expect(publish.status).toBe(200);
    const publishBody = (await publish.json()) as PublishWorkflowResponse;
    await stack.runtime!.buildService.waitFor(publishBody.contentHash);
    await until(async () => {
      const record = await stack.runtime!.buildStore.get(publishBody.contentHash);
      return record?.status === "succeeded" || undefined;
    }, "fresh workflow build");

    const res = await api(
      "POST",
      `/workspaces/${fresh.orgId}/workflows/${wf[0]!.id}/sessions`,
      { cookie: fresh.cookie, body: { message: "anyone there?" } },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_live_worker");
  });

  test("unpublished workflow → typed 409 on session creation", async () => {
    const fresh = await signUpWithOrg("Unpublished");
    await seedWorkspace(db, fresh.orgId);
    const agentRows = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, fresh.orgId));
    const wf = await db
      .insert(schema.workflows)
      .values({
        organizationId: fresh.orgId,
        name: "Draft only",
        runAsUserId: fresh.userId,
        draft: {
          trigger: { type: "manual" },
          context: { mcpConnectionIds: [], skillIds: [] },
          agent: { agentPresetId: agentRows[0]!.id },
          instructions: { markdown: "Hi." },
        } as unknown as Record<string, unknown>,
      })
      .returning({ id: schema.workflows.id });

    const res = await api(
      "POST",
      `/workspaces/${fresh.orgId}/workflows/${wf[0]!.id}/sessions`,
      { cookie: fresh.cookie, body: { message: "run it" } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_not_published");
  });

  // ── boot reconciliation ───────────────────────────────────────────────────

  test("boot reconciliation resumes orphaned runs on live workers and fails the rest", async () => {
    await freshWorkerHeartbeat();
    const workerRows = await db
      .select({ id: schema.workers.id })
      .from(schema.workers)
      .where(eq(schema.workers.address, fixture.url));
    const liveWorkerId = workerRows[0]!.id;

    async function orphanSession(eveSessionId: string | null, affinity: string | null) {
      const rows = await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          workflowId,
          workflowVersionId: versionId,
          eveSessionId,
          continuationToken: eveSessionId ? `ct-${eveSessionId}` : null,
          origin: "chat",
          principal: { workspaceId: orgId, source: "chat" },
          affinityWorkerId: affinity,
          status: "active",
        })
        .returning();
      return rows[0]!;
    }
    async function orphanRun(agentSessionId: string) {
      const rows = await db
        .insert(schema.runs)
        .values({
          agentSessionId,
          triggerEvent: {
            workflowId,
            triggerType: "manual",
            message: "orphan",
            data: {},
            principal: { workspaceId: orgId, source: "chat" },
          },
          status: "running",
        })
        .returning();
      return rows[0]!;
    }

    // Orphan A: live worker + real eve session → its tail is re-attached and
    // drains eve's durable stream to a terminal (crash-safe resume).
    const liveSession = await orphanSession("eve-sess-1", liveWorkerId);
    const liveRun = await orphanRun(liveSession.id);
    // Orphan B: nothing to resume from → failed with completedAt so the cap
    // slot frees and SSE terminates.
    const deadSession = await orphanSession("eve-gone", null);
    const deadRun = await orphanRun(deadSession.id);

    // The two live HOLD tails from the caps test are skipped (still owned by
    // this process's tailer manager) — only true orphans are touched.
    const outcome = await reconcileInterruptedRuns(stack.runtime!);
    expect(outcome).toEqual({ resumed: 1, failed: 1 });

    const dead = await db
      .select({ status: schema.runs.status, completedAt: schema.runs.completedAt, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, deadRun.id));
    expect(dead[0]!.status).toBe("failed");
    expect(dead[0]!.completedAt).not.toBeNull();
    expect(dead[0]!.error).toContain("control plane restarted");

    await until(async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, liveRun.id));
      return rows[0]?.status === "succeeded" || undefined;
    }, "reconciled run to complete from the resumed tail");
  });
});
