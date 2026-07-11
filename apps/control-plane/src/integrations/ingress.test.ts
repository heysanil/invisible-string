/**
 * Trigger ingress + integrations integration tests — gated on
 * TEST_DATABASE_URL (skip cleanly when unset; the compose integration stage
 * provides it).
 *
 * AGENTS-FIRST: the fake agent/worker exposes ONLY eve's default channel
 * (`POST /eve/v1/session`, `POST /eve/v1/session/:id`, the NDJSON stream) —
 * there are no compiled trigger channels. The suite proves the new dispatch
 * contract end to end against a real Postgres, a stub Slack server, and a
 * stub compiler:
 *
 *   webhook ingress → RENDERED task message opens the eve session (resolved
 *     `@trigger.*` baked in; TriggerEvent stays storage-only provenance) ·
 *   trigger-row form-schema validation · enabled/published gating · payload
 *     cap · rate-limit 429 · idempotency ·
 *   dispatch-time allowlist re-validation FAILS the run · run cancel ·
 *   Slack signature/replay/dedup/twin suppression · mention → dispatch (NO
 *     SLACK_BOT_TOKEN in agent env) → thread reply CONTINUES the same eve
 *     session · slack-origin runs owe `delivery_status = pending` and the
 *     DeliveryService settles them via chat.postMessage (threaded) ·
 *   Slack OAuth install + callback + tenant binding · list / disconnect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  computeSlackSignature,
} from "./slack-verify";
import { signOAuthState } from "./slack-oauth";
import {
  generateMasterKeyBase64,
  parseMasterKey,
  type AgentDefinition,
  type CreateWebhookTokenResponse,
  type RunDto,
  type TriggerConfig,
  type TriggerIngressResponse,
  type WorkflowConfigInput,
} from "@invisible-string/shared";

import { createMemoryArtifactStore } from "../artifacts";
import {
  AgentCompileError,
  type CompileAgentFn,
} from "../build/compiler-contract";
import type { BuildSteps } from "../build/steps";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import {
  derivePlatformJwtSecret,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "../runtime/jwt";
import {
  createDeliveryService,
  createDrizzleDeliveryReader,
} from "../runs/delivery";
import { createSlackClient } from "./slack-client";
import { createAppStack, type AppStack } from "../index";
import { hashIngressToken } from "./tokens";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const PLATFORM_JWT_SECRET = "ingress-platform-jwt-secret-00000000";
const WORKER_SHARED_SECRET = "ingress-worker-shared-secret-000000";
const OPENROUTER_KEY = "test-openrouter-key";
const SLACK_SIGNING_SECRET = "ingress-slack-signing-secret-000000";
const MASTER_KEY_B64 = generateMasterKeyBase64();

// ── fake agent/worker (eve DEFAULT channel only) ─────────────────────────────

interface FakeSession {
  id: string;
  continuationToken: string;
  events: string[];
  turns: number;
}
interface EnsureCall {
  hash: string;
  env: Record<string, string>;
}
interface SessionMessage {
  kind: "create" | "continue";
  hash: string;
  sessionId: string;
  message: string;
}

const TERMINAL = new Set(["session.waiting", "session.completed", "session.failed"]);

class FakeWorker {
  readonly sessions = new Map<string, FakeSession>();
  readonly ensureCalls: EnsureCall[] = [];
  /** Every task message that opened or continued an eve session. */
  readonly sessionMessages: SessionMessage[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private counter = 0;

  get url(): string {
    if (!this.server) throw new Error("fixture not started");
    return `http://localhost:${this.server.port}`;
  }
  start(): void {
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
  }
  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async verifyJwt(req: Request, hash: string): Promise<boolean> {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    try {
      await jwtVerify(token, new TextEncoder().encode(derivePlatformJwtSecret(PLATFORM_JWT_SECRET, hash)), {
        issuer: PLATFORM_JWT_ISSUER,
        audience: platformJwtAudienceForHash(hash),
      });
      return true;
    } catch {
      return false;
    }
  }

  private pushTurn(session: FakeSession, message: string): void {
    const turn = session.turns++;
    const hold = message.includes("HOLD");
    const events: unknown[] = [];
    if (turn === 0) {
      events.push({ type: "session.started", data: { runtime: { agentId: "fake", eveVersion: "0.19.0", modelId: "fake" } } });
    }
    events.push(
      { type: "turn.started", data: { sequence: turn, turnId: `t${turn}` } },
      { type: "message.received", data: { message, sequence: turn, turnId: `t${turn}` } },
      { type: "message.completed", data: { finishReason: "stop", message: `echo:${message}`, sequence: turn, stepIndex: 0, turnId: `t${turn}` } },
      { type: "turn.completed", data: { sequence: turn, turnId: `t${turn}` } },
    );
    if (!hold) events.push({ type: "session.waiting", data: { wait: "next-user-message" } });
    for (const event of events) session.events.push(JSON.stringify(event));
  }

  private streamResponse(session: FakeSession, startIndex: number): Response {
    const encoder = new TextEncoder();
    let index = startIndex;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const pump = () => {
          while (index < session.events.length) {
            const line = session.events[index++]!;
            controller.enqueue(encoder.encode(`${line}\n`));
            if (TERMINAL.has((JSON.parse(line) as { type: string }).type)) {
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
      const body = (await req.json()) as { versionHash: string; env: Record<string, string> };
      this.ensureCalls.push({ hash: body.versionHash, env: body.env });
      return Response.json({ ok: true });
    }

    // eve default channel: create session (202 async).
    const createMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session$/);
    if (createMatch && req.method === "POST") {
      if (!(await this.verifyJwt(req, createMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = (await req.json()) as { message?: string };
      const id = `eve-${++this.counter}`;
      const session: FakeSession = { id, continuationToken: `ct-${id}`, events: [], turns: 0 };
      this.sessions.set(id, session);
      const message = String(body.message ?? "");
      this.sessionMessages.push({ kind: "create", hash: createMatch[1]!, sessionId: id, message });
      this.pushTurn(session, message);
      return Response.json(
        { sessionId: session.id, continuationToken: session.continuationToken },
        { status: 202 },
      );
    }

    // eve default channel: continue session (202 async).
    const continueMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session\/([^/]+)$/);
    if (continueMatch && req.method === "POST") {
      if (!(await this.verifyJwt(req, continueMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const session = this.sessions.get(continueMatch[2]!);
      if (!session) return new Response("no session", { status: 404 });
      const body = (await req.json()) as { continuationToken?: string; message?: string };
      if (body.continuationToken !== session.continuationToken) {
        return Response.json({ error: "bad continuation token" }, { status: 409 });
      }
      const message = String(body.message ?? "");
      this.sessionMessages.push({ kind: "continue", hash: continueMatch[1]!, sessionId: session.id, message });
      this.pushTurn(session, message);
      return Response.json({}, { status: 202 });
    }

    const streamMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      if (!(await this.verifyJwt(req, streamMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const session = this.sessions.get(streamMatch[2]!);
      if (!session) return new Response("no session", { status: 404 });
      return this.streamResponse(session, Number(url.searchParams.get("startIndex") ?? "0"));
    }
    return new Response("not found", { status: 404 });
  }
}

// ── stub Slack server (oauth.v2.access + chat.postMessage) ──────────────────

class SlackStub {
  readonly postMessages: Array<Record<string, unknown>> = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  team = { id: "T-TEST", name: "Ingress Team" };

  get url(): string {
    if (!this.server) throw new Error("slack stub not started");
    return `http://localhost:${this.server.port}`;
  }
  start(): void {
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth.v2.access") {
          return Response.json({
            ok: true,
            app_id: "A1",
            team: this.team,
            bot_user_id: "U0BOT",
            access_token: "xoxb-ingress-bot-token",
            scope: "app_mentions:read,chat:write",
          });
        }
        if (url.pathname === "/chat.postMessage") {
          this.postMessages.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true, ts: "1.0" });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }
  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

// ── stub compiler + fake build steps ────────────────────────────────────────

const STUB_EVE_VERSION = "0.19.0";
const stubCompile: CompileAgentFn = (request) => {
  if (request.definition.persona.trim() === "") {
    throw new AgentCompileError([{ path: "persona", message: "empty" }]);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ def: request.definition, slug: request.agentSlug, model: request.model.modelId, eve: STUB_EVE_VERSION }))
    .digest("hex");
  return {
    files: new Map([["package.json", "{}"]]),
    hash,
    compilerVersion: "stub-1",
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
      return new TextEncoder().encode(`tarball-${hash}`);
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

if (!TEST_DATABASE_URL) {
  console.warn("[ingress] TEST_DATABASE_URL not set — skipping trigger ingress integration tests");
}

describe.skipIf(!TEST_DATABASE_URL)("trigger ingress + integrations", () => {
  const worker = new FakeWorker();
  const slack = new SlackStub();
  const artifacts = createMemoryArtifactStore();
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  let ownerCookie: string;
  let orgId: string;
  let userId: string;
  let agentId: string;

  async function api(method: string, path: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string>; rawBody?: string } = {}): Promise<Response> {
    return stack.app.handle(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined || options.rawBody !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers,
        },
        ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
    );
  }

  async function signUpWithOrg(name: string) {
    const email = `ingress-${randomUUID()}@example.com`;
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

  /** Create + publish an agent (real publish route, stub compile/build). */
  async function createPublishedAgent(): Promise<string> {
    const definition: AgentDefinition = {
      persona: "Be a helpful ingress test agent.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    };
    const rows = await db
      .insert(schema.agents)
      .values({
        organizationId: orgId,
        name: `Ingress Agent ${randomUUID().slice(0, 8)}`,
        runAsUserId: userId,
        draft: definition as unknown as Record<string, unknown>,
      })
      .returning({ id: schema.agents.id });
    const id = rows[0]!.id;
    const res = await api("POST", `/workspaces/${orgId}/agents/${id}/publish`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentHash: string };
    await stack.runtime!.buildService.waitFor(body.contentHash);
    await until(async () => {
      const record = await stack.runtime!.buildStore.get(body.contentHash);
      return record?.status === "succeeded" ? record : undefined;
    }, "agent build");
    return id;
  }

  /**
   * Create a workflow delegating to the published agent. Publish = snapshot
   * written by the test (workflow publish routes are proven in
   * resources/workflows.test.ts; ingress only reads the snapshot + trigger
   * row).
   */
  async function createWorkflow(
    name: string,
    trigger: TriggerConfig,
    options: { publish?: boolean; enabled?: boolean; instructions?: string } = {},
  ): Promise<string> {
    const config: WorkflowConfigInput = {
      trigger,
      agentId,
      instructions: { markdown: options.instructions ?? "Be helpful. @trigger.repo" },
    };
    const rows = await db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name,
        draft: config as unknown as Record<string, unknown>,
        ...(options.publish === false
          ? {}
          : {
              published: config as unknown as Record<string, unknown>,
              publishedAt: new Date(),
              publishedAgentId: agentId,
            }),
        enabled: options.enabled ?? true,
      })
      .returning({ id: schema.workflows.id });
    return rows[0]!.id;
  }

  async function mintToken(workflowId: string): Promise<CreateWebhookTokenResponse> {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/triggers/webhook-token`, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWebhookTokenResponse;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    worker.start();
    slack.start();
    stack = createAppStack(
      {
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "ingress-integration-secret-0000000",
        BETTER_AUTH_URL: BASE_URL,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET,
        WORKER_SHARED_SECRET,
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "dev",
        S3_SECRET_ACCESS_KEY: "devdevdev",
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        MAX_CONCURRENT_RUNS_PER_WORKSPACE: "50",
        ALLOW_INSECURE_WORKER_TRANSPORT: "1",
        SSE_HEARTBEAT_MS: "50",
        AGENT_BUILD_ROOT: join(tmpdir(), "invisible-string-ingress-builds"),
        PUBLIC_APP_URL: "https://app.test",
        SLACK_CLIENT_ID: "123.456",
        SLACK_CLIENT_SECRET: "slack-client-secret",
        SLACK_SIGNING_SECRET,
        SLACK_API_BASE_URL: slack.url,
        SLACK_AUTHORIZE_URL: `${slack.url}/authorize`,
      },
      { compile: stubCompile, buildSteps: fakeBuildSteps(), artifacts },
    );
    db = stack.dbHandle.db;
    expect(stack.integrations).not.toBeNull();

    const owner = await signUpWithOrg("Ingress Owner");
    ownerCookie = owner.cookie;
    orgId = owner.orgId;
    userId = owner.userId;
    await seedWorkspace(db, orgId, userId);

    // Start from a clean worker registry — workers are GLOBAL (selectWorker is
    // not workspace-scoped), so stray live rows from another suite/run sharing
    // this DB would be dispatched to. This suite owns exactly one worker.
    await db.delete(schema.workers);
    await db.insert(schema.workers).values({ address: worker.url, status: "live", lastHeartbeatAt: new Date() });

    agentId = await createPublishedAgent();
  }, 60_000);

  afterAll(async () => {
    // Remove this suite's worker row so it cannot leak into other integration
    // suites sharing the same test DB — the fixture server stops with this
    // file, and a live row pointing at a dead address gets picked by a later
    // suite's scheduler (dispatch then 502s with a connection error).
    await db?.delete(schema.workers).where(eq(schema.workers.address, worker.url));
    await stack?.close();
    worker.stop();
    slack.stop();
  }, 30_000);

  // ── webhook ──────────────────────────────────────────────────────────────

  test("webhook ingress: token-HASH lookup, RENDERED task message opens the eve session, run streams", async () => {
    const wfId = await createWorkflow("Webhook WF", { type: "webhook" });
    const minted = await mintToken(wfId);
    expect(minted.token).toStartWith("whk_");
    expect(minted.ingressUrl).toBe(`https://app.test/t/${minted.token}`);

    // Only the HASH is stored — the plaintext token never touches the DB.
    const rows = await db.select().from(schema.triggers).where(eq(schema.triggers.workflowId, wfId));
    expect(rows[0]!.tokenHash).toBe(hashIngressToken(minted.token));
    expect(rows[0]!.tokenHash).not.toBe(minted.token);

    const before = worker.sessionMessages.length;
    const res = await api("POST", `/t/${minted.token}`, { rawBody: JSON.stringify({ repo: "acme/app", message: "run it" }) });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as TriggerIngressResponse;
    expect(ack.accepted).toBe(true);

    // The dispatcher opened an eve session with the RENDERED task message:
    // instructions with @trigger.repo resolved, trigger context appended.
    const opened = await until(
      async () => worker.sessionMessages.slice(before).find((m) => m.kind === "create" && m.message.includes("acme/app")),
      "eve session created",
    );
    expect(opened.message).toContain("<workflow-task>");
    expect(opened.message).toContain("Be helpful. acme/app");
    expect(opened.message).toContain("trigger.repo: acme/app");
    expect(opened.message).toContain("run it");

    const run = await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0] && (r[0].status === "succeeded" || r[0].status === "failed") ? r[0] : undefined;
    }, "run terminal");
    expect(run.status).toBe("succeeded");
    // Provenance: the rendered message is persisted; the envelope carries the
    // agent + workflow; webhooks owe no outbound delivery.
    expect(run.taskMessage).toBe(opened.message);
    const envelope = run.triggerEvent as { agentId?: string; workflowId?: string; message?: string };
    expect(envelope.agentId).toBe(agentId);
    expect(envelope.workflowId).toBe(wfId);
    expect(envelope.message).toBe("run it");
    expect(run.deliveryStatus).toBeNull();

    // The session pinned the agent + its published version.
    const sessions = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, run.agentSessionId));
    expect(sessions[0]!.agentId).toBe(agentId);
    expect(sessions[0]!.workflowId).toBe(wfId);
  });

  test("webhook: unknown token → 404 (existence-hiding)", async () => {
    const res = await api("POST", "/t/whk_nonexistent-token-value", { rawBody: "{}" });
    expect(res.status).toBe(404);
  });

  test("webhook: oversized body → 413", async () => {
    const wfId = await createWorkflow("Webhook Big", { type: "webhook" });
    const minted = await mintToken(wfId);
    const huge = JSON.stringify({ blob: "x".repeat(300 * 1024) });
    const res = await api("POST", `/t/${minted.token}`, { rawBody: huge });
    expect(res.status).toBe(413);
  });

  test("webhook: idempotency key returns the SAME run", async () => {
    const wfId = await createWorkflow("Webhook Idem", { type: "webhook" });
    const minted = await mintToken(wfId);
    const headers = { "idempotency-key": "idem-abc" };
    const a = (await (await api("POST", `/t/${minted.token}`, { rawBody: "{}", headers })).json()) as TriggerIngressResponse;
    const b = (await (await api("POST", `/t/${minted.token}`, { rawBody: "{}", headers })).json()) as TriggerIngressResponse;
    expect(b.runId).toBe(a.runId);
    expect(b.sessionId).toBe(a.sessionId);
  });

  test("kill switch: a disabled workflow accepts no trigger events (403)", async () => {
    const wfId = await createWorkflow("Disabled WF", { type: "webhook" }, { enabled: false });
    const minted = await mintToken(wfId);
    const res = await api("POST", `/t/${minted.token}`, { rawBody: "{}" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("trigger_disabled");
  });

  test("an unpublished workflow cannot be dispatched (409)", async () => {
    const wfId = await createWorkflow("Draft WF", { type: "webhook" }, { publish: false });
    const minted = await mintToken(wfId);
    const res = await api("POST", `/t/${minted.token}`, { rawBody: "{}" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_not_published");
  });

  // ── form ─────────────────────────────────────────────────────────────────

  test("form ingress: validates against the trigger row's synced form schema", async () => {
    const wfId = await createWorkflow("Form WF", {
      type: "form",
      fields: [
        { key: "repo", label: "Repo", type: "text", required: true },
        { key: "message", label: "Message", type: "textarea", required: false },
      ],
    });
    const minted = await mintToken(wfId);

    const bad = await api("POST", `/t/${minted.token}`, { rawBody: JSON.stringify({ values: { message: "hi" } }) });
    expect(bad.status).toBe(422); // missing required "repo"

    const before = worker.sessionMessages.length;
    const good = await api("POST", `/t/${minted.token}`, { rawBody: JSON.stringify({ values: { repo: "acme/app", message: "hello" } }) });
    expect(good.status).toBe(202);
    const opened = await until(
      async () => worker.sessionMessages.slice(before).find((m) => m.kind === "create"),
      "form dispatch",
    );
    // Submitted values resolved into the task message + trigger context.
    expect(opened.message).toContain("Be helpful. acme/app");
    expect(opened.message).toContain("hello");
  });

  // ── rate limit ─────────────────────────────────────────────────────────────

  test("rate limit: token budget exhaustion → 429", async () => {
    // Exhaust the shared limiter for a specific token key, then one more hit
    // trips 429 (limit-agnostic).
    const rl = stack.integrations!.tokenRateLimiter;
    while (rl.hit("tok:rl-probe").allowed) {
      /* drain */
    }
    const res = await api("POST", "/t/rl-probe", { rawBody: "{}", headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  // ── dispatch-time allowlist re-validation ──────────────────────────────────

  test("allowlist re-validation: a now-disallowed model FAILS the run (not executed)", async () => {
    const wfId = await createWorkflow("Allowlist WF", { type: "webhook" });
    const minted = await mintToken(wfId);

    // The agent version compiled the balanced preset model; disable it on the
    // CURRENT allowlist after publish.
    await db
      .update(schema.modelAllowlist)
      .set({ enabled: false })
      .where(eq(schema.modelAllowlist.organizationId, orgId));

    const beforeSessions = worker.sessionMessages.length;
    const res = await api("POST", `/t/${minted.token}`, { rawBody: "{}" });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as TriggerIngressResponse;

    const run = await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0] && r[0].status === "failed" ? r[0] : undefined;
    }, "failed run");
    expect(run.error).toContain("no longer on this workspace's allowlist");
    // Never dispatched to the agent.
    expect(worker.sessionMessages.length).toBe(beforeSessions);

    // Restore for other tests.
    await db.update(schema.modelAllowlist).set({ enabled: true }).where(eq(schema.modelAllowlist.organizationId, orgId));
  });

  // ── run cancel ─────────────────────────────────────────────────────────────

  test("run cancel: aborts a running run and marks it canceled", async () => {
    const wfId = await createWorkflow("Cancel WF", { type: "webhook" });
    const minted = await mintToken(wfId);

    // "HOLD" keeps the fake stream open → run stays running.
    const res = await api("POST", `/t/${minted.token}`, { rawBody: JSON.stringify({ message: "HOLD open" }) });
    const ack = (await res.json()) as TriggerIngressResponse;
    await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0]?.status === "running" ? r[0] : undefined;
    }, "run running");

    const cancel = await api("POST", `/runs/${ack.runId}/cancel`, { cookie: ownerCookie, body: { reason: "changed my mind" } });
    expect(cancel.status).toBe(200);
    const canceled = (await cancel.json()) as { run: RunDto };
    expect(canceled.run.status).toBe("canceled");

    // Idempotent second cancel.
    const again = await api("POST", `/runs/${ack.runId}/cancel`, { cookie: ownerCookie, body: {} });
    expect(((await again.json()) as { run: RunDto }).run.status).toBe("canceled");
  });

  // ── Slack OAuth install + callback ─────────────────────────────────────────

  test("Slack install redirects to consent with a signed state", async () => {
    const res = await api("GET", `/workspaces/${orgId}/integrations/slack/install`, { cookie: ownerCookie });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location")!;
    expect(location).toStartWith(`${slack.url}/authorize`);
    expect(new URL(location).searchParams.get("state")).toBeTruthy();
  });

  test("Slack OAuth callback requires the initiating admin session (tenant-binding CSRF)", async () => {
    // A valid signed state alone must NOT bind the install: without the
    // initiating admin's session cookie the callback refuses and stores nothing.
    const state = signOAuthState(PLATFORM_JWT_SECRET, orgId);
    const res = await api("GET", `/integrations/slack/callback?code=the-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("location")).toContain("slack=forbidden");
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId));
    expect(rows.filter((r) => r.type === "slack")).toHaveLength(0);
  });

  test("Slack OAuth callback exchanges the code and stores encrypted creds", async () => {
    const state = signOAuthState(PLATFORM_JWT_SECRET, orgId);
    const res = await api("GET", `/integrations/slack/callback?code=the-code&state=${encodeURIComponent(state)}`, { cookie: ownerCookie });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("location")).toContain("slack=connected");

    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId));
    const slackRow = rows.find((r) => r.type === "slack" && r.externalId === "T-TEST")!;
    expect(slackRow).toBeTruthy();
    // The bot token is envelope-encrypted (not the plaintext).
    expect(slackRow.credentialsEncrypted).not.toContain("xoxb-ingress-bot-token");

    // Listed with non-secret metadata only.
    const listRes = await api("GET", `/workspaces/${orgId}/integrations`, { cookie: ownerCookie });
    const list = (await listRes.json()) as { integrations: { externalId: string; hasCredentials: boolean; teamName: string | null }[] };
    const dto = list.integrations.find((i) => i.externalId === "T-TEST")!;
    expect(dto.hasCredentials).toBe(true);
    expect(dto.teamName).toBe("Ingress Team");
  });

  test("Slack OAuth state is single-use (replay within the TTL is refused)", async () => {
    const state = signOAuthState(PLATFORM_JWT_SECRET, orgId);
    const first = await api("GET", `/integrations/slack/callback?code=code-a&state=${encodeURIComponent(state)}`, { cookie: ownerCookie });
    expect(first.headers.get("location")).toContain("slack=connected");
    const replay = await api("GET", `/integrations/slack/callback?code=code-b&state=${encodeURIComponent(state)}`, { cookie: ownerCookie });
    expect(replay.status).toBe(400); // slack_state_invalid
  });

  test("a Slack team connected to one org can NOT be silently re-bound by another org", async () => {
    const other = await signUpWithOrg("Slack Thief");
    // The thief org mints its own valid state and completes consent for the
    // SAME Slack team — ownership must not move.
    const state = signOAuthState(PLATFORM_JWT_SECRET, other.orgId);
    const res = await stack.app.handle(
      new Request(`${BASE_URL}/integrations/slack/callback?code=the-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: other.cookie },
      }),
    );
    expect(res.headers.get("location")).toContain("slack=team_already_connected");
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.externalId, "T-TEST"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(orgId); // still the first org's
  });

  // ── Slack events: signature, mention → dispatch, thread reply = same session ─

  async function postSlackEvent(event: Record<string, unknown>, opts: { eventId: string; badSignature?: boolean; timestamp?: number } = { eventId: randomUUID() }): Promise<Response> {
    const body = JSON.stringify({ type: "event_callback", team_id: "T-TEST", api_app_id: "A1", event_id: opts.eventId, event_time: 1720000000, event });
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = opts.badSignature ? "v0=deadbeef" : computeSlackSignature(SLACK_SIGNING_SECRET, ts, body);
    return api("POST", "/integrations/slack/events", {
      rawBody: body,
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": ts },
    });
  }

  test("Slack: bad signature → 401; url_verification → challenge echo", async () => {
    const bad = await postSlackEvent({ type: "app_mention", user: "U1", text: "hi", ts: "1.0", channel: "C1" }, { eventId: randomUUID(), badSignature: true });
    expect(bad.status).toBe(401);

    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
    const res = await api("POST", "/integrations/slack/events", {
      rawBody: body,
      headers: { "x-slack-signature": computeSlackSignature(SLACK_SIGNING_SECRET, ts, body), "x-slack-request-timestamp": ts },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { challenge: string }).challenge).toBe("chal-123");
  });

  test("Slack: stale timestamp → 401 (replay window)", async () => {
    const res = await postSlackEvent(
      { type: "app_mention", user: "U1", text: "hi", ts: "1.0", channel: "C1" },
      { eventId: randomUUID(), timestamp: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(res.status).toBe(401);
  });

  test("Slack: mention dispatches (task message, NO bot token in agent env); a thread reply CONTINUES the same eve session; delivery settles the pending reply", async () => {
    // Bind a slack-trigger workflow to the installed team integration.
    const wfId = await createWorkflow(
      "Slack WF",
      { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
      { instructions: "Reply helpfully. @trigger.text" },
    );
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    const bind = await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });
    expect(bind.status).toBe(200);

    // A root mention (thread_ts absent → threadKey = its own ts).
    const rootTs = "1720000100.000100";
    const beforeMessages = worker.sessionMessages.length;
    const mention = await postSlackEvent({ type: "app_mention", user: "U777", text: "<@U0BOT> hello there", ts: rootTs, channel: "C-slack", team: "T-TEST" });
    expect(mention.status).toBe(200);

    const session1 = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.origin === "slack") ?? undefined;
    }, "slack session created");

    // AGENTS-FIRST: the mention became a RENDERED task message on eve's
    // default channel, and NO Slack secret ever entered agent env.
    const opened = await until(
      async () => worker.sessionMessages.slice(beforeMessages).find((m) => m.kind === "create"),
      "slack eve session",
    );
    expect(opened.message).toContain("Reply helpfully. hello there");
    for (const ensure of worker.ensureCalls) {
      expect(ensure.env.SLACK_BOT_TOKEN).toBeUndefined();
      expect(ensure.env.SLACK_API_BASE_URL).toBeUndefined();
    }

    const firstRun = await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session1.id));
      return runs.find((r) => r.status === "succeeded");
    }, "first slack run done");
    // Slack-origin runs owe an outbound reply: dispatch marks `pending`, and
    // the app stack's tailer-hooked DeliveryService settles it to `delivered`
    // moments later (either state may be observed here — never null).
    expect(firstRun.deliveryStatus).not.toBeNull();
    expect(["pending", "delivered"]).toContain(firstRun.deliveryStatus!);

    // The stack's own DeliveryService (tailer onFinish hook) posts the
    // terminal reply back to the thread and settles the marker — through the
    // real drizzle reader over the persisted rows.
    const settled = await until(async () => {
      const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, firstRun.id));
      return rows[0]!.deliveryStatus === "delivered" ? rows[0] : undefined;
    }, "reply delivered to slack");
    expect(settled.deliveryStatus).toBe("delivered");
    const posted = slack.postMessages.find(
      (m) => m.channel === "C-slack" && m.thread_ts === rootTs,
    )!;
    expect(posted).toBeTruthy();
    expect(String(posted.text)).toStartWith("echo:");

    // A second settle attempt (boot recovery racing the tailer hook) is
    // CAS'd out — the marker only flips from `pending`, so the reply is
    // never double-posted (at-least-once, single ledger writer).
    const delivery = createDeliveryService({
      reader: createDrizzleDeliveryReader(db),
      runStore: stack.runtime!.runStore,
      slackClient: createSlackClient({ apiBaseUrl: slack.url }),
      masterKey: parseMasterKey(MASTER_KEY_B64),
      logger: createLogger({ sink: () => {}, minLevel: "error" }),
    });
    const outcome = await delivery.deliver({
      runId: firstRun.id,
      status: "succeeded",
      lastAssistantMessage: null, // would force recovery from run_events
    });
    expect(outcome).toBe("skipped");
    expect(
      slack.postMessages.filter((m) => m.channel === "C-slack" && m.thread_ts === rootTs),
    ).toHaveLength(1);

    // A reply IN the thread (thread_ts = the root ts), no mention — must ride
    // the SAME eve session as a continuation (native eve session API).
    const reply = await postSlackEvent({ type: "message", channel: "C-slack", channel_type: "channel", user: "U777", text: "and one more thing", ts: "1720000200.000200", thread_ts: rootTs, team: "T-TEST" });
    expect(reply.status).toBe(200);

    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session1.id));
      return runs.length >= 2 ? true : undefined;
    }, "thread reply continued the session");
    const continued = worker.sessionMessages.find(
      (m) => m.kind === "continue" && m.sessionId === session1.eveSessionId,
    )!;
    expect(continued).toBeTruthy();
    expect(continued.message).toContain("and one more thing");
    const slackSessions = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
    expect(slackSessions).toHaveLength(1);
  });

  test("Slack: retried event_id is de-duplicated (no second dispatch)", async () => {
    const wfId = await createWorkflow("Slack Dedup WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    const eventId = randomUUID();
    const event = { type: "app_mention", user: "U1", text: "<@U0BOT> dedupe me", ts: "1720000300.000300", channel: "C-dedup", team: "T-TEST" };
    await postSlackEvent(event, { eventId });
    await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.some((s) => s.origin === "slack") ? true : undefined;
    }, "first dedup session");
    // Same event_id (a Slack retry) — ignored.
    const retry = await postSlackEvent(event, { eventId });
    expect(retry.status).toBe(200);
    await Bun.sleep(200);
    const sessions = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
    expect(sessions).toHaveLength(1);
  });

  test("Slack: the message twin of an app_mention (same channel:ts) does NOT double-dispatch", async () => {
    const wfId = await createWorkflow("Slack Twin WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    // One user message @mentioning the bot arrives as TWO Slack events with
    // DIFFERENT event_ids: the app_mention and its raw `message.channels` twin.
    const ts = "1720000400.000700";
    const mention = { type: "app_mention", user: "U9", text: "<@U0BOT> twin me", ts, channel: "C-twin", team: "T-TEST" };
    const twin = { type: "message", channel: "C-twin", channel_type: "channel", user: "U9", text: "<@U0BOT> twin me", ts, team: "T-TEST" };
    await postSlackEvent(mention, { eventId: randomUUID() });
    await postSlackEvent(twin, { eventId: randomUUID() });

    const session = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.origin === "slack") ?? undefined;
    }, "twin session");
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "twin run done");
    await Bun.sleep(200); // give a wrong second dispatch time to appear

    const sessions = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
    expect(sessions).toHaveLength(1);
    const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session.id));
    expect(runs).toHaveLength(1); // exactly ONE dispatch for one user message
  });

  // ── disconnect ─────────────────────────────────────────────────────────────

  test("integration disconnect removes the row", async () => {
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    const res = await api("DELETE", `/workspaces/${orgId}/integrations/${integration.id}`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.id, integration.id));
    expect(rows).toHaveLength(0);
  });
});
