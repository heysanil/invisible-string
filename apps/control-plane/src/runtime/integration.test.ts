/**
 * Runtime-API integration tests — gated on TEST_DATABASE_URL (skip cleanly
 * when unset; the compose integration stage provides it).
 *
 * Full loop against a FAKE agent/worker (one Bun.serve speaking the eve 0.31
 * session API v2: 202 ID-addressed session create, NDJSON stream with
 * `?startIndex=` resume + the `includeTailIndex` bounded read, and send-XOR-
 * respond follow-ups that REFUSE the shapes real eve refuses — see
 * `src/testing/fake-eve.ts`) with a stub compiler
 * and fake build steps injected — agents-first: the AGENT is the compile
 * unit, chat targets agents, workflows dispatch rendered task messages:
 *
 *   agent publish → version snapshot + build (cache + idempotency)
 *   dry-run-compile → structured errors
 *   chat session create → scheduler → ensure-agent env contract → eve 202 →
 *     agent_sessions/runs rows (workflowId null) → tailer → run_events
 *   workflow manual /run → published snapshot → rendered taskMessage →
 *     session with workflow provenance
 *   SSE → Last-Event-ID replay + live follow
 *   follow-up message → same eve session, new run, startIndex resume
 *   ownership → 403 (foreign workspace path) / 404 (foreign rows)
 *   caps → 429 at the per-workspace concurrent-run cap
 *
 * The REAL compiler + `eve build` path is exercised in the acceptance
 * suites, not here (per plan).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  generateMasterKeyBase64,
  newId,
  parseMasterKey,
  type AgentDefinitionInput,
  type ApiErrorBody,
  type CreateSessionResponse,
  type GetAgentResponse,
  type GetSessionResponse,
  type PostMessageResponse,
  type PublishAgentResponse,
  type ResetSessionResponse,
  type RunEventFrame,
  type RunStatusFrame,
  type SessionContextControlResponse,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import {
  AgentCompileError,
  type CompileAgentFn,
} from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { runMigrations } from "../migrate";
import { encryptConnectionAuthConfig } from "../resources/mcp-crypto";
import {
  derivePlatformJwtSecret,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "./jwt";
import { reconcileInterruptedRuns } from "./reconcile";
import { createAppStack, type AppStack } from "../index";
import {
  eveAccepted,
  eveSessionNotActive,
  eveStreamHeaders,
  parseCreateBody,
  parseFollowUpBody,
  rejectContinuationToken,
  stampEveEvent,
} from "../testing/fake-eve";

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
  /** Set by `reset`: the id survives but refuses every later message. */
  retired: boolean;
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
  /** Every follow-up body the control plane sent, in order. */
  readonly continueBodies: unknown[] = [];
  /** Control-route calls: "cancel" | "clear" | "compact" | "reset". */
  readonly controlCalls: Array<{ sessionId: string; action: string }> = [];
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
        data: { runtime: { agentId: "fake-agent", eveVersion: STUB_EVE_VERSION, modelId: "fake" } },
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
    // 0.31 stamps a stable `evt_` id on every event before its durable write —
    // the tailer's dedupe key.
    for (const event of events) {
      session.events.push(JSON.stringify(stampEveEvent(event as Record<string, unknown>)));
    }
    session.receivedMessages.push(message);
  }

  private streamResponse(
    session: FakeEveSession,
    startIndex: number,
    headers: Record<string, string>,
  ): Response {
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
    return new Response(stream, { status: 200, headers });
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
      const parsed = parseCreateBody(await req.json().catch(() => ({})));
      if (parsed instanceof Response) return parsed;
      const id = `eve-sess-${++this.counter}`;
      const session: FakeEveSession = {
        id,
        retired: false,
        events: [],
        turns: 0,
        receivedMessages: [],
      };
      this.sessions.set(id, session);
      this.pushTurn(session, parsed.message);
      // eve acks asynchronously with 202 + the x-eve-session-id header.
      return eveAccepted(id);
    }

    const continueMatch = sub.match(/^session\/([^/]+)$/);
    if (continueMatch && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      this.continueBodies.push(body);
      const parsed = parseFollowUpBody(body);
      if (parsed instanceof Response) return parsed;
      const session = this.sessions.get(continueMatch[1]!);
      // Unknown OR retired ⇒ the same permanent 409 — 0.31 renders both as
      // `session_not_active`.
      if (!session || session.retired) return eveSessionNotActive();
      if (parsed.kind === "send") this.pushTurn(session, parsed.message);
      else this.pushTurn(session, `resume:${parsed.inputResponses[0]?.requestId ?? ""}`);
      return eveAccepted(session.id);
    }

    const controlMatch = sub.match(/^session\/([^/]+)\/(cancel|clear|compact|reset)$/);
    if (controlMatch && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const rejected = rejectContinuationToken(body);
      if (rejected) return rejected;
      const id = controlMatch[1]!;
      const action = controlMatch[2]!;
      this.controlCalls.push({ sessionId: id, action });
      const session = this.sessions.get(id);
      if (!session || session.retired) {
        // eve renders ONE dead-session condition under three names.
        return Response.json(
          {
            ok: true,
            status: action === "cancel" ? "no_active_turn" : "no_active_session",
          },
          { status: 200 },
        );
      }
      if (action === "reset") {
        session.retired = true;
        // Reset is the ONE control route that never answers 202, and its id
        // field is `previousSessionId`.
        return Response.json(
          { ok: true, previousSessionId: id, status: "reset" },
          { status: 200 },
        );
      }
      if (action === "clear") {
        session.events.push(
          JSON.stringify(
            stampEveEvent({
              type: "context.cleared",
              data: { sequence: session.turns, sessionId: id, turnId: `turn_${session.turns}` },
            }),
          ),
        );
      }
      return Response.json({ ok: true, sessionId: id, status: "accepted" }, { status: 202 });
    }

    const streamMatch = sub.match(/^session\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      const session = this.sessions.get(streamMatch[1]!);
      if (!session) return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
      const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
      this.streamCalls.push({ sessionId: session.id, startIndex });
      return this.streamResponse(
        session,
        startIndex,
        eveStreamHeaders(url, session.events.length),
      );
    }

    return new Response("not found", { status: 404 });
  }
}

// ── stub compiler + fake build steps ────────────────────────────────────────

const STUB_EVE_VERSION = "0.31.3";

const stubCompile: CompileAgentFn = (request) => {
  if (request.definition.persona.trim() === "") {
    throw new AgentCompileError([
      { path: "persona", message: "persona must not be empty" },
    ]);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        definition: request.definition,
        // Mirrors the real compiler, which hashes the whole resolved model —
        // the EFFORT included, so inheriting a re-pointed preset's effort
        // re-keys the artifact.
        model: {
          provider: request.model.provider,
          modelId: request.model.modelId,
          reasoning: request.model.reasoning,
        },
        connections: request.connections.map((c) => [c.name, c.url, c.envTokenVar]),
        skills: request.skills.map((s) => [s.name, s.content]),
        workspace: request.workspaceSlug,
        agent: request.agentSlug,
        eve: STUB_EVE_VERSION,
      }),
    )
    .digest("hex");
  return {
    files: new Map([
      ["package.json", JSON.stringify({ name: "stub-agent", private: true })],
      ["agent/instructions.md", request.definition.persona],
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
  let agentId: string;
  let mcpConnectionId: string;
  let draft: AgentDefinitionInput;
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

  /** Create an agent via the API and return its id. */
  async function createAgent(
    cookie: string,
    workspaceId: string,
    name: string,
    definition: AgentDefinitionInput,
  ): Promise<string> {
    const res = await api("POST", `/workspaces/${workspaceId}/agents`, {
      cookie,
      body: { name, draft: definition },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as GetAgentResponse;
    return body.agent.id;
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
    await seedWorkspace(db, orgId, owner.userId);

    // Connection with an envelope-encrypted token (workspace scope). The AAD
    // binds the row id, so the id exists before the insert (newId, spec §3).
    mcpConnectionId = newId("cn");
    await db.insert(schema.connections).values({
      id: mcpConnectionId,
      scope: "workspace",
      organizationId: orgId,
      name: "linear",
      source: "custom",
      url: "https://mcp.example.com/mcp",
      authType: "bearer",
      authConfigEncrypted: encryptConnectionAuthConfig(
        { type: "bearer", values: { token: "lin-secret-token" } },
        parseMasterKey(MASTER_KEY_B64),
        mcpConnectionId,
      ),
    });

    draft = {
      persona: "Be helpful. Use @linear when asked.",
      // No explicit effort: the agent INHERITS the preset's, which is the
      // default state of every new agent.
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [mcpConnectionId], skillIds: [] },
    };
    agentId = await createAgent(ownerCookie, orgId, "Runtime Test Agent", draft);

    // Start from a clean worker registry — workers are GLOBAL (selectWorker is
    // not workspace-scoped), so a stray live row from another suite sharing
    // this DB (pointing at a stopped fixture server) would win scheduling for
    // fresh sessions and fail dispatch with a connection-refused 502.
    await db.delete(schema.workers);
    await db.insert(schema.workers).values({
      address: fixture.url,
      status: "live",
      lastHeartbeatAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    // Remove this suite's worker row so it cannot leak into later suites
    // sharing the same test DB.
    await db?.delete(schema.workers).where(eq(schema.workers.address, fixture.url));
    await stack?.close();
    fixture.stop();
  }, 30_000);

  // ── publish + build ───────────────────────────────────────────────────────

  test("publish snapshots an immutable agent version, resolves the model, and builds", async () => {
    const res = await api("POST", `/workspaces/${orgId}/agents/${agentId}/publish`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishAgentResponse;
    expect(body.agentId).toBe(agentId);
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

    // World provisioned once for this version (design correction #10). The
    // signup's fire-and-forget seed-agent publish provisions its OWN hash in
    // the background — count only this version's.
    expect(provisionedHashes.filter((hash) => hash === contentHash)).toEqual([
      contentHash,
    ]);

    // Version row: immutable snapshot + resolved model (balanced preset).
    const versions = await db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, versionId));
    expect(versions[0]).toMatchObject({
      agentId,
      contentHash,
      compilerVersion: "stub-compiler-1",
      eveVersion: STUB_EVE_VERSION,
      modelProvider: "openrouter",
      // The seeded `balanced` preset (packages/db seed) — a `~`-prefixed
      // OpenRouter `-latest` alias; the tilde is part of the id.
      modelId: "~deepseek/deepseek-v4-flash-latest",
      buildStatus: "succeeded",
    });
    // The snapshot is the parsed (defaults-applied) AgentDefinition — and an
    // inherited effort stays ABSENT in it: materializing one would freeze the
    // preset's current effort into an immutable snapshot.
    expect(versions[0]!.definition).toMatchObject({
      persona: draft.persona,
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [mcpConnectionId], skillIds: [] },
    });
    expect(
      (versions[0]!.definition as { model: Record<string, unknown> }).model,
    ).not.toHaveProperty("reasoning");

    // Draft is now published.
    const agents = await db
      .select({ publishedVersionId: schema.agents.publishedVersionId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    expect(agents[0]?.publishedVersionId).toBe(versionId);
  });

  test("republish of an identical draft is idempotent by hash (cache hit)", async () => {
    const res = await api("POST", `/workspaces/${orgId}/agents/${agentId}/publish`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishAgentResponse;
    expect(body.versionId).toBe(versionId);
    expect(body.contentHash).toBe(contentHash);
    expect(body.buildStatus).toBe("succeeded");
    expect(body.cached).toBeTrue();
    // No second world provisioning, no second build for THIS hash (the
    // signup's background seed-agent publish owns its own separate hash).
    expect(provisionedHashes.filter((hash) => hash === contentHash)).toEqual([
      contentHash,
    ]);
  });

  test("dry-run-compile: ok+hash for a valid draft; structured errors otherwise", async () => {
    const ok = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/dry-run-compile`,
      { cookie: ownerCookie },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, contentHash });

    // Empty persona → compiler's typed error, surfaced structurally.
    await db
      .update(schema.agents)
      .set({
        draft: { ...draft, persona: "" } as unknown as Record<string, unknown>,
      })
      .where(eq(schema.agents.id, agentId));
    const bad = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/dry-run-compile`,
      { cookie: ownerCookie },
    );
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { ok: boolean; error: { code: string } };
    expect(badBody.ok).toBeFalse();
    expect(badBody.error.code).toBe("compile_failed");

    // Non-allowlisted model override → typed model error (pre-compile).
    await db
      .update(schema.agents)
      .set({
        draft: {
          ...draft,
          model: { preset: "balanced", modelId: "not/allowed", reasoning: "medium" },
        } as unknown as Record<string, unknown>,
      })
      .where(eq(schema.agents.id, agentId));
    const banned = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/dry-run-compile`,
      { cookie: ownerCookie },
    );
    const bannedBody = (await banned.json()) as { ok: boolean; error: { code: string } };
    expect(bannedBody.ok).toBeFalse();
    expect(bannedBody.error.code).toBe("model_not_allowlisted");

    // Shape-invalid draft → draft_invalid, still as dry-run payload.
    await db
      .update(schema.agents)
      .set({ draft: { persona: 42 } as unknown as Record<string, unknown> })
      .where(eq(schema.agents.id, agentId));
    const invalid = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/dry-run-compile`,
      { cookie: ownerCookie },
    );
    expect(invalid.status).toBe(200);
    const invalidBody = (await invalid.json()) as { ok: boolean; error: { code: string } };
    expect(invalidBody.ok).toBeFalse();
    expect(invalidBody.error.code).toBe("draft_invalid");

    // Restore the good draft.
    await db
      .update(schema.agents)
      .set({ draft: draft as unknown as Record<string, unknown> })
      .where(eq(schema.agents.id, agentId));
  });

  // ── chat sessions + runs + tailer ────────────────────────────────────────

  test("chat session creation dispatches with the exact env contract and tails run events", async () => {
    await freshWorkerHeartbeat();
    const res = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/sessions`,
      { cookie: ownerCookie, body: { message: "hello agent" } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    sessionId = body.session.id;
    firstRunId = body.run.id;
    expect(body.session.eveSessionId).toBe("eve-sess-1");
    expect(body.session.agentId).toBe(agentId);
    expect(body.session.agentVersionId).toBe(versionId);
    // Direct chat carries no workflow provenance.
    expect(body.session.workflowId).toBeNull();
    expect(body.run.triggerEvent).toMatchObject({
      agentId,
      workflowId: null,
      triggerType: "manual",
      message: "hello agent",
    });
    // The chat message goes through verbatim — no rendered task message.
    expect(body.run.taskMessage).toBeNull();
    expect(body.run.deliveryStatus).toBeNull();

    // ensure-agent env contract (SECRETS go here and only here).
    expect(fixture.ensureCalls).toHaveLength(1);
    const ensure = fixture.ensureCalls[0]!;
    expect(ensure.hash).toBe(contentHash);
    expect(ensure.artifactUrl).toContain(`${contentHash}.tar.gz`);
    expect(ensure.env.WORKFLOW_POSTGRES_URL).toContain(
      `ag_v_${contentHash.slice(0, 12)}`,
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
    // No per-trigger env exists anymore (delivery is control-plane-side).
    expect(ensure.env).not.toHaveProperty("SLACK_BOT_TOKEN");

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

    // ID-addressed follow-up: the body is EXACTLY the "send" form. A stray
    // `continuationToken` key (or `inputResponses` alongside `message`) would
    // have been a 400 at the fake, mirroring real eve.
    expect(fixture.continueBodies).toEqual([{ message: "follow-up question" }]);
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

  // ── workflow manual "Run now" ────────────────────────────────────────────

  test("workflow /run dispatches the published snapshot with a rendered taskMessage", async () => {
    await freshWorkerHeartbeat();
    // A webhook-shaped workflow delegating to the published agent.
    const created = await api("POST", `/workspaces/${orgId}/workflows`, {
      cookie: ownerCookie,
      body: {
        name: "Runtime Run-now Workflow",
        draft: {
          trigger: { type: "webhook" },
          agentId,
          instructions: { markdown: "Reply politely to @trigger.customer.email about their request." },
        },
      },
    });
    expect(created.status).toBe(201);
    const wfId = ((await created.json()) as { workflow: { id: string } }).workflow.id;

    // Run-now before publish → typed 409.
    const early = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${wfId}/run`,
      { cookie: ownerCookie, body: { message: "too early" } },
    );
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
      "workflow_not_published",
    );

    const published = await api(
      "POST",
      `/workspaces/${orgId}/workflows/${wfId}/publish`,
      { cookie: ownerCookie },
    );
    expect(published.status).toBe(200);

    const res = await api("POST", `/workspaces/${orgId}/workflows/${wfId}/run`, {
      cookie: ownerCookie,
      body: {
        message: "manual test run",
        data: { customer: { email: "kim@example.com" } },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;

    // Workflow provenance on the session; the exact agent version pinned.
    expect(body.session.workflowId).toBe(wfId);
    expect(body.session.agentId).toBe(agentId);
    expect(body.session.agentVersionId).toBe(versionId);

    // The agent received the RENDERED task message, not the raw envelope —
    // and the run row carries it as provenance.
    expect(body.run.taskMessage).not.toBeNull();
    expect(body.run.taskMessage!).toContain("<workflow-task>");
    expect(body.run.taskMessage!).toContain("kim@example.com");
    expect(body.run.triggerEvent).toMatchObject({
      agentId,
      workflowId: wfId,
      triggerType: "manual",
    });
    const eveSession = fixture.sessions.get(body.session.eveSessionId!)!;
    expect(eveSession.receivedMessages[0]).toBe(body.run.taskMessage!);

    await until(async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, body.run.id));
      return rows[0]?.status === "succeeded" || undefined;
    }, "run-now run to succeed");
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
      `/workspaces/${orgId}/agents/${agentId}/publish`,
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

    // A foreign AGENT row is invisible too (chat create in own workspace,
    // foreign agent id) — existence-hiding, not 403.
    const foreignAgent = await api(
      "POST",
      `/workspaces/${stranger.orgId}/agents/${agentId}/sessions`,
      { cookie: stranger.cookie, body: { message: "not yours" } },
    );
    expect(foreignAgent.status).toBe(404);

    // The stranger's snooping never reached the worker plane.
    expect(fixture.sessions.get("eve-sess-1")!.receivedMessages).not.toContain("let me in");

    // No session at all → 401.
    const anon = await api("GET", `/sessions/${sessionId}`);
    expect(anon.status).toBe(401);
  });

  // ── eve 0.31 context controls (clear / compact / reset) ─────────────────

  describe("session context controls", () => {
    let controlSessionId: string;
    let controlEveSessionId: string;

    async function newQuietSession(): Promise<{ id: string; eveSessionId: string }> {
      await freshWorkerHeartbeat();
      const res = await api(
        "POST",
        `/workspaces/${orgId}/agents/${agentId}/sessions`,
        { cookie: ownerCookie, body: { message: "context control seed" } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;
      // Controls refuse a BUSY session, so wait for the seed run to settle.
      await until(async () => {
        const rows = await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, body.run.id));
        return rows[0]?.status === "succeeded" || undefined;
      }, "seed run to succeed");
      return { id: body.session.id, eveSessionId: body.session.eveSessionId! };
    }

    test("clear and compact forward to eve and leave the session usable", async () => {
      const session = await newQuietSession();
      controlSessionId = session.id;
      controlEveSessionId = session.eveSessionId;

      for (const action of ["clear", "compact"] as const) {
        const res = await api("POST", `/sessions/${controlSessionId}/${action}`, {
          cookie: ownerCookie,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SessionContextControlResponse;
        // Success is keyed on eve's `status`, not the HTTP code.
        expect(body.status).toBe("accepted");
        expect(body.session.status).toBe("active");
      }
      expect(
        fixture.controlCalls.filter((c) => c.sessionId === controlEveSessionId),
      ).toEqual([
        { sessionId: controlEveSessionId, action: "clear" },
        { sessionId: controlEveSessionId, action: "compact" },
      ]);

      // The session id is unchanged and still accepts messages.
      await freshWorkerHeartbeat();
      const follow = await api("POST", `/sessions/${controlSessionId}/messages`, {
        cookie: ownerCookie,
        body: { message: "after clear" },
      });
      expect(follow.status).toBe(201);
    });

    test("reset retires the eve session, closes the row, and mints a replacement that still works", async () => {
      const session = await newQuietSession();

      const res = await api("POST", `/sessions/${session.id}/reset`, {
        cookie: ownerCookie,
        body: { reason: "starting over" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ResetSessionResponse;
      expect(body.status).toBe("reset");
      if (body.status !== "reset") throw new Error("unreachable");
      expect(body.previousSession.id).toBe(session.id);
      expect(body.previousSession.status).toBe("closed");
      // The replacement pins the SAME agent version — a reset must not
      // silently migrate the thread onto a newer publish.
      expect(body.session.id).not.toBe(session.id);
      expect(body.session.agentVersionId).toBe(body.previousSession.agentVersionId);
      // It starts with NO eve session: the retired id can never be reused.
      expect(body.session.eveSessionId).toBeNull();

      // The retired eve id now answers eve's permanent 409 — a message to the
      // OLD row must surface `session_not_continuable`, never a 502.
      const oldRow = await api("POST", `/sessions/${session.id}/messages`, {
        cookie: ownerCookie,
        body: { message: "zombie" },
      });
      expect(oldRow.status).toBe(409);
      expect(((await oldRow.json()) as ApiErrorBody).error.code).toBe(
        "session_not_continuable",
      );

      // The REPLACEMENT row opens a fresh eve session on its first message.
      await freshWorkerHeartbeat();
      const revived = await api("POST", `/sessions/${body.session.id}/messages`, {
        cookie: ownerCookie,
        body: { message: "fresh start" },
      });
      expect(revived.status).toBe(201);
      const rows = await db
        .select({ eveSessionId: schema.agentSessions.eveSessionId })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, body.session.id));
      expect(rows[0]!.eveSessionId).not.toBeNull();
      expect(rows[0]!.eveSessionId).not.toBe(session.eveSessionId);
    });

    test("authz: an outsider cannot clear, compact, or reset another workspace's session", async () => {
      // A cancel/clear/reset route that leaks across workspaces is a security
      // bug, not a UX one — assert every verb, not just one.
      const stranger = await signUpWithOrg("Control Stranger");
      const before = fixture.controlCalls.length;
      for (const action of ["clear", "compact", "reset"] as const) {
        const res = await api("POST", `/sessions/${controlSessionId}/${action}`, {
          cookie: stranger.cookie,
        });
        // Existence-hiding: a foreign row is 404, never 403-with-detail.
        expect(res.status).toBe(404);
        await res.text();
        // Anonymous callers never get past auth either.
        const anon = await api("POST", `/sessions/${controlSessionId}/${action}`);
        expect(anon.status).toBe(401);
        await anon.text();
      }
      // Nothing reached the agent plane.
      expect(fixture.controlCalls.length).toBe(before);
    });

    test("authz: a plain MEMBER of the owning workspace may drive every control", async () => {
      // Deliberately member-level: these mutate only the conversation the
      // member is already allowed to drive. Raising them to admin would block
      // a member from resetting their own chat.
      const session = await newQuietSession();
      const member = await signUpWithOrg("Control Member");
      await db.insert(schema.member).values({
        id: `mem-${randomUUID()}`,
        organizationId: orgId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      });
      await stack.auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: member.cookie }),
      });

      const clear = await api("POST", `/sessions/${session.id}/clear`, {
        cookie: member.cookie,
      });
      expect(clear.status).toBe(200);
      const reset = await api("POST", `/sessions/${session.id}/reset`, {
        cookie: member.cookie,
      });
      expect(reset.status).toBe(200);
    });

    test("a BUSY session refuses context controls with the transient session_busy code", async () => {
      // Clearing mid-turn would race the running turn and land
      // context.cleared inside another run's log; resetting mid-turn would
      // retire the very id the live tail is reading.
      await freshWorkerHeartbeat();
      const held = await api(
        "POST",
        `/workspaces/${orgId}/agents/${agentId}/sessions`,
        { cookie: ownerCookie, body: { message: "HOLD for controls" } },
      );
      expect(held.status).toBe(201);
      const heldBody = (await held.json()) as CreateSessionResponse;
      try {
        const res = await api("POST", `/sessions/${heldBody.session.id}/clear`, {
          cookie: ownerCookie,
        });
        expect(res.status).toBe(409);
        // Transient — NOT eve's permanent session_not_active.
        expect(((await res.json()) as ApiErrorBody).error.code).toBe("session_busy");
      } finally {
        await api("POST", `/runs/${heldBody.run.id}/cancel`, { cookie: ownerCookie });
      }
    });
  });

  // ── caps ────────────────────────────────────────────────────────────────

  test("per-workspace concurrent-run cap returns 429 (sessions AND messages)", async () => {
    await freshWorkerHeartbeat();
    // Two held runs occupy the whole cap (MAX_CONCURRENT_RUNS_PER_WORKSPACE=2).
    const first = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/sessions`,
      { cookie: ownerCookie, body: { message: "HOLD one" } },
    );
    // Surface the error envelope on failure — a bare status mismatch hides
    // the dispatch error detail (this is how the leaked-worker-row 502 from a
    // sibling suite was found).
    if (first.status !== 201) {
      console.log("[cap] first create failed:", first.status, await first.clone().text());
    }
    expect(first.status).toBe(201);
    heldSessionId = ((await first.json()) as CreateSessionResponse).session.id;
    const second = await api(
      "POST",
      `/workspaces/${orgId}/agents/${agentId}/sessions`,
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
      `/workspaces/${orgId}/agents/${agentId}/sessions`,
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
    await seedWorkspace(db, fresh.orgId, fresh.userId);
    const freshAgentId = await createAgent(fresh.cookie, fresh.orgId, "Scheduler agent", {
      persona: "Hi.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });
    const publish = await api(
      "POST",
      `/workspaces/${fresh.orgId}/agents/${freshAgentId}/publish`,
      { cookie: fresh.cookie },
    );
    expect(publish.status).toBe(200);
    const publishBody = (await publish.json()) as PublishAgentResponse;
    await stack.runtime!.buildService.waitFor(publishBody.contentHash);
    await until(async () => {
      const record = await stack.runtime!.buildStore.get(publishBody.contentHash);
      return record?.status === "succeeded" || undefined;
    }, "fresh agent build");

    const res = await api(
      "POST",
      `/workspaces/${fresh.orgId}/agents/${freshAgentId}/sessions`,
      { cookie: fresh.cookie, body: { message: "anyone there?" } },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_live_worker");
  });

  test("unpublished agent → typed 409 on session creation", async () => {
    const fresh = await signUpWithOrg("Unpublished");
    await seedWorkspace(db, fresh.orgId, fresh.userId);
    const draftAgentId = await createAgent(fresh.cookie, fresh.orgId, "Draft only", {
      persona: "Hi.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });

    const res = await api(
      "POST",
      `/workspaces/${fresh.orgId}/agents/${draftAgentId}/sessions`,
      { cookie: fresh.cookie, body: { message: "run it" } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("agent_not_published");
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
          agentId,
          agentVersionId: versionId,
          workflowId: null,
          eveSessionId,
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
            agentId,
            workflowId: null,
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
    expect(outcome).toMatchObject({ resumed: 1, failed: 1 });

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
