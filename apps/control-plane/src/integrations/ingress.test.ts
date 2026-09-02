/**
 * Trigger ingress + integrations integration tests — gated on
 * TEST_DATABASE_URL (skip cleanly when unset; the compose integration stage
 * provides it).
 *
 * PIPELINES: every trigger event now starts a PIPELINE run of the published
 * v2 config; eve sessions exist only as `agent`-step CHILD runs, and the
 * fake agent/worker exposes ONLY eve's default channel (`POST
 * /eve/v1/session`, `POST /eve/v1/session/:id`, the NDJSON stream). The
 * suite proves the new dispatch contract end to end against a real Postgres,
 * a stub Slack server, and a stub compiler:
 *
 *   webhook ingress → pipeline run → agent step opens a TASK-mode eve child
 *     session with the RENDERED instructions (resolved `@trigger.*` baked
 *     in; TriggerEvent stays storage-only provenance) ·
 *   trigger-row form-schema validation · enabled/published gating · payload
 *     cap · rate-limit 429 · idempotency ·
 *   dispatch-time allowlist re-validation FAILS the agent step + the run ·
 *   parent-run cancel cancels the live child ·
 *   Slack signature/replay/dedup/twin suppression · mention → NEW pipeline
 *     run whose `session: "thread"` agent step claims the thread session (NO
 *     SLACK_BOT_TOKEN in agent env) → a thread reply's run CONTINUES the
 *     same eve session · explicit `onComplete.slackReply` renders against
 *     the final scope and the DeliveryService settles the parent's pending
 *     marker via chat.postMessage (threaded) ·
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
  newStepId,
  parseMasterKey,
  type AgentDefinition,
  type AgentStepSession,
  type CreateWebhookTokenResponse,
  type RunDto,
  type TriggerConfig,
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
import {
  eveAccepted,
  eveSessionNotActive,
  eveStreamHeaders,
  parseCreateBody,
  parseFollowUpBody,
  stampEveEvent,
} from "../testing/fake-eve";

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
  /** Simulates an eve session that went terminal WITHOUT the platform
   *  noticing (30-day timeout, reset, task-mode budget breach). Every later
   *  follow-up answers the permanent 409 `session_not_active`. */
  dead: boolean;
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
  /** eve create options observed on the wire (spike finding 36). */
  mode?: string;
  outputSchema?: unknown;
}

const TERMINAL = new Set(["session.waiting", "session.completed", "session.failed"]);

class FakeWorker {
  readonly sessions = new Map<string, FakeSession>();
  readonly ensureCalls: EnsureCall[] = [];
  /** Every task message that opened or continued an eve session. */
  readonly sessionMessages: SessionMessage[] = [];
  /**
   * When set, ensure-agent records its call and then PARKS until the gate
   * resolves — a deterministic window for a cancel to race the dispatch
   * (the marker fence test). Cleared between tests.
   */
  ensureGate: Promise<void> | null = null;
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
      events.push({ type: "session.started", data: { runtime: { agentId: "fake", eveVersion: "0.31.3", modelId: "fake" } } });
    }
    events.push(
      { type: "turn.started", data: { sequence: turn, turnId: `t${turn}` } },
      { type: "message.received", data: { message, sequence: turn, turnId: `t${turn}` } },
      { type: "message.completed", data: { finishReason: "stop", message: `echo:${message}`, sequence: turn, stepIndex: 0, turnId: `t${turn}` } },
      { type: "turn.completed", data: { sequence: turn, turnId: `t${turn}` } },
    );
    if (!hold) events.push({ type: "session.waiting", data: { wait: "next-user-message" } });
    for (const event of events) {
      session.events.push(JSON.stringify(stampEveEvent(event as Record<string, unknown>)));
    }
  }

  private streamResponse(
    session: FakeSession,
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
    return new Response(stream, { status: 200, headers });
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
      // Recorded FIRST so a test can observe "the dispatch reached ensure",
      // then parked while the gate is held (a cold agent boot in miniature).
      if (this.ensureGate) await this.ensureGate;
      return Response.json({ ok: true });
    }

    // eve default channel: create session (202 async).
    const createMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session$/);
    if (createMatch && req.method === "POST") {
      if (!(await this.verifyJwt(req, createMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const parsed = parseCreateBody(raw);
      if (parsed instanceof Response) return parsed;
      // Finding 36: eve PARSES outputSchema — a non-object is its own 400.
      if (
        raw.outputSchema !== undefined &&
        (typeof raw.outputSchema !== "object" || raw.outputSchema === null)
      ) {
        return Response.json(
          { error: "outputSchema must be an object", ok: false },
          { status: 400 },
        );
      }
      const id = `eve-${++this.counter}`;
      const session: FakeSession = { id, dead: false, events: [], turns: 0 };
      this.sessions.set(id, session);
      this.sessionMessages.push({
        kind: "create",
        hash: createMatch[1]!,
        sessionId: id,
        message: parsed.message,
        ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
        ...(raw.outputSchema !== undefined ? { outputSchema: raw.outputSchema } : {}),
      });
      this.pushTurn(session, parsed.message);
      return eveAccepted(session.id);
    }

    // eve default channel: continue session (202 async).
    const continueMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session\/([^/]+)$/);
    if (continueMatch && req.method === "POST") {
      if (!(await this.verifyJwt(req, continueMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const parsed = parseFollowUpBody(await req.json().catch(() => ({})));
      if (parsed instanceof Response) return parsed;
      const session = this.sessions.get(continueMatch[2]!);
      // Unknown OR terminal ⇒ 0.31's permanent 409 `session_not_active`.
      if (!session || session.dead) return eveSessionNotActive();
      const message =
        parsed.kind === "send"
          ? parsed.message
          : `resume:${parsed.inputResponses[0]?.requestId ?? ""}`;
      this.sessionMessages.push({ kind: "continue", hash: continueMatch[1]!, sessionId: session.id, message });
      this.pushTurn(session, message);
      return eveAccepted(session.id);
    }

    const streamMatch = path.match(/^\/agents\/([^/]+)\/eve\/v1\/session\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      if (!(await this.verifyJwt(req, streamMatch[1]!))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const session = this.sessions.get(streamMatch[2]!);
      if (!session) {
        return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
      }
      return this.streamResponse(
        session,
        Number(url.searchParams.get("startIndex") ?? "0"),
        eveStreamHeaders(url, session.events.length),
      );
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
   * Create a one-agent-step PIPELINE workflow bound to the published agent.
   * Publish = snapshot written by the test (workflow publish routes are
   * proven in resources/workflows.test.ts; ingress only reads the snapshot +
   * trigger row). Slack workflows get `session: "thread"` + an explicit
   * `onComplete.slackReply` unless overridden — the pipeline delivery shape.
   */
  async function createWorkflow(
    name: string,
    trigger: TriggerConfig,
    options: {
      publish?: boolean;
      enabled?: boolean;
      instructions?: string;
      session?: AgentStepSession;
      onCompleteTemplate?: string;
      /** Bind the step to a different published agent (default: the suite's). */
      agentId?: string;
    } = {},
  ): Promise<string> {
    const session: AgentStepSession =
      options.session ?? (trigger.type === "slack" ? "thread" : "fresh");
    const config: WorkflowConfigInput = {
      version: 2,
      trigger,
      steps: [
        {
          id: newStepId(),
          slug: "reply",
          kind: "agent",
          agentId: options.agentId ?? agentId,
          instructions: {
            markdown: options.instructions ?? "Be helpful. @trigger.repo",
          },
          session,
        },
      ],
      ...(options.onCompleteTemplate !== undefined
        ? {
            onComplete: {
              slackReply: { template: { markdown: options.onCompleteTemplate } },
            },
          }
        : {}),
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

  /**
   * Wait until NO pipeline run of the workflow is live. The default
   * `overlap: "skip"` DROPS a trigger event while any run of the workflow is
   * still in flight — so a test that posts a FOLLOW-UP thread event must
   * first let the previous PARENT run settle. Waiting on the CHILD run alone
   * leaves a small window where the parent is still finishing its step
   * bookkeeping (extract → finish → run_finished), and an event posted
   * inside it is overlap-dropped by design — a race, not a product bug.
   */
  async function awaitWorkflowQuiet(workflowId: string): Promise<void> {
    await until(async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.workflowId, workflowId));
      const live = rows.some(
        (r) => r.status === "queued" || r.status === "running" || r.status === "waiting",
      );
      return live ? undefined : true;
    }, `workflow ${workflowId} runs settled`);
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

  test("webhook ingress: token-HASH lookup starts a PIPELINE run; the agent step opens a TASK-mode eve child session with the RENDERED instructions", async () => {
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
    const ack = (await res.json()) as { accepted: boolean; runId: string };
    expect(ack.accepted).toBe(true);

    // The agent step opened an eve CHILD session with the step's rendered
    // instructions (@trigger.repo resolved against the run scope), in TASK
    // mode — fresh agent-step children never park on prompts nobody answers.
    const opened = await until(
      async () => worker.sessionMessages.slice(before).find((m) => m.kind === "create" && m.message.includes("acme/app")),
      "eve child session created",
    );
    expect(opened.message).toBe("Be helpful. acme/app");
    expect(opened.mode).toBe("task");
    expect(opened.outputSchema).toBeUndefined(); // no declared output schema

    // The PARENT pipeline run settles off the child's terminal.
    const run = await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0] && (r[0].status === "succeeded" || r[0].status === "failed") ? r[0] : undefined;
    }, "parent run terminal");
    expect(run.status).toBe("succeeded");
    expect(run.mode).toBe("pipeline");
    expect(run.agentSessionId).toBeNull();
    expect(run.workflowId).toBe(wfId);
    expect(run.organizationId).toBe(orgId);
    expect(run.deliveryStatus).toBeNull(); // webhooks owe no outbound delivery
    const envelope = run.triggerEvent as { workflowId?: string; message?: string };
    expect(envelope.workflowId).toBe(wfId);
    expect(envelope.message).toBe("run it");

    // The CHILD run carries the rendered instructions + real agent identity
    // and links back through the step ledger.
    const steps = await db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, run.id));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe("succeeded");
    expect(steps[0]!.childRunId).not.toBeNull();
    // Schemaless extraction: the child's final stop-message becomes `text`.
    expect((steps[0]!.output as { text?: string }).text).toStartWith("echo:");
    const childRun = (await db.select().from(schema.runs).where(eq(schema.runs.id, steps[0]!.childRunId!)))[0]!;
    expect(childRun.mode).toBe("agent");
    expect(childRun.status).toBe("succeeded");
    expect(childRun.taskMessage).toBe(opened.message);
    expect(childRun.workflowId).toBe(wfId);
    expect(childRun.organizationId).toBe(orgId);
    expect((childRun.triggerEvent as { agentId?: string }).agentId).toBe(agentId);

    // The child session pinned the agent + its published version.
    const sessions = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, childRun.agentSessionId!));
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
    const a = (await (await api("POST", `/t/${minted.token}`, { rawBody: "{}", headers })).json()) as { runId: string };
    const b = (await (await api("POST", `/t/${minted.token}`, { rawBody: "{}", headers })).json()) as { runId: string };
    expect(b.runId).toBe(a.runId);
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
    // Submitted values resolved into the agent step's rendered instructions.
    expect(opened.message).toContain("Be helpful. acme/app");
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

  test("allowlist re-validation: a now-disallowed model FAILS the agent step and the run (not executed)", async () => {
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
    const ack = (await res.json()) as { runId: string };

    const run = await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0] && r[0].status === "failed" ? r[0] : undefined;
    }, "failed parent run");
    expect(run.error).toContain("no longer on this workspace's allowlist");
    // The step ledger carries the class; nothing ever reached the agent.
    const steps = await db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, run.id));
    expect(steps[0]!.errorClass).toBe("model_disallowed_at_dispatch");
    expect(worker.sessionMessages.length).toBe(beforeSessions);

    // Restore for other tests.
    await db.update(schema.modelAllowlist).set({ enabled: true }).where(eq(schema.modelAllowlist.organizationId, orgId));
  });

  // ── run cancel ─────────────────────────────────────────────────────────────

  test("run cancel: canceling the PARENT pipeline run cancels its live agent-step child too", async () => {
    const wfId = await createWorkflow("Cancel WF", {
      type: "webhook",
    }, { instructions: "HOLD the line. @trigger.repo" });
    const minted = await mintToken(wfId);

    // "HOLD" in the rendered instructions keeps the fake stream open → the
    // CHILD run stays running, and the parent watches it.
    const res = await api("POST", `/t/${minted.token}`, { rawBody: JSON.stringify({ repo: "r" }) });
    const ack = (await res.json()) as { runId: string };
    const child = await until(async () => {
      const steps = await db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, ack.runId));
      const childId = steps[0]?.childRunId;
      if (!childId) return undefined;
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, childId));
      return r[0]?.status === "running" ? r[0] : undefined;
    }, "child run running");

    const cancel = await api("POST", `/runs/${ack.runId}/cancel`, { cookie: ownerCookie, body: { reason: "changed my mind" } });
    expect(cancel.status).toBe(200);

    // The driver settles the parent at the next boundary; the child's tail
    // marks it canceled — poll both.
    await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0]?.status === "canceled" ? r[0] : undefined;
    }, "parent canceled");
    await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, child.id));
      return r[0]?.status === "canceled" ? r[0] : undefined;
    }, "child canceled");

    // Idempotent second cancel.
    const again = await api("POST", `/runs/${ack.runId}/cancel`, { cookie: ownerCookie, body: {} });
    expect(((await again.json()) as { run: RunDto }).run.status).toBe("canceled");
  });

  test("run cancel racing the dispatch: a Stop during the agent boot is fenced at the marker — NOTHING reaches eve", async () => {
    // The dispatch parks on a gated ensure-agent (a cold boot in miniature);
    // the Stop lands while it is parked. The cancel route's post-cancel
    // child sweep cancels the just-linked child, and when the boot releases,
    // the dispatch's marker CAS refuses (run already canceled) — no eve
    // session is ever created for a canceled parent, and the eveless child
    // session is closed rather than left holding state.
    const wfId = await createWorkflow(
      "Cancel Race WF",
      { type: "webhook" },
      { instructions: "CANCELRACE @trigger.repo" },
    );
    const minted = await mintToken(wfId);
    let release!: () => void;
    worker.ensureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ack: { runId: string };
    let childId: string;
    try {
      const beforeEnsures = worker.ensureCalls.length;
      const res = await api("POST", `/t/${minted.token}`, {
        rawBody: JSON.stringify({ repo: "race" }),
      });
      expect(res.status).toBe(202);
      ack = (await res.json()) as { runId: string };

      // The child link commits BEFORE any eve interaction; then the dispatch
      // parks on the gated ensure — a deterministic cancel window.
      childId = await until(async () => {
        const steps = await db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, ack.runId));
        return steps[0]?.childRunId ?? undefined;
      }, "child linked pre-dispatch");
      await until(
        async () => (worker.ensureCalls.length > beforeEnsures ? true : undefined),
        "dispatch parked on ensure",
      );

      const cancel = await api("POST", `/runs/${ack.runId}/cancel`, {
        cookie: ownerCookie,
        body: { reason: "stop the race" },
      });
      expect(cancel.status).toBe(200);

      // The route's post-cancel sweep (all linked children) cancels the
      // child immediately — it does not wait for the parked dispatch.
      await until(async () => {
        const r = await db.select().from(schema.runs).where(eq(schema.runs.id, childId));
        return r[0]?.status === "canceled" ? r[0] : undefined;
      }, "child canceled while the dispatch is still parked");
    } finally {
      worker.ensureGate = null;
      release();
    }

    // The released dispatch hits the marker fence and abandons: the child's
    // session never gets an eve session and is CLOSED (releasing any claim).
    const session = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.status === "closed") ?? undefined;
    }, "abandoned dispatch closed the eveless child session");
    expect(session.eveSessionId).toBeNull();
    // NOTHING reached eve for this workflow — the fence held.
    expect(worker.sessionMessages.some((m) => m.message.includes("CANCELRACE"))).toBe(false);
    await until(async () => {
      const r = await db.select().from(schema.runs).where(eq(schema.runs.id, ack.runId));
      return r[0]?.status === "canceled" ? r[0] : undefined;
    }, "parent canceled");
  }, 30_000);

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

  test("Slack: a mention starts a PIPELINE run whose thread agent step claims the session (NO bot token in agent env); a thread reply's run CONTINUES the same eve session; explicit onComplete delivery settles the parent", async () => {
    // Bind a slack-trigger workflow (thread agent step + explicit reply
    // template rendered against the final scope) to the installed team.
    const wfId = await createWorkflow(
      "Slack WF",
      { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
      {
        instructions: "Reply helpfully. @trigger.text",
        onCompleteTemplate: "@steps.reply.text",
      },
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

    // Poll for the eve id, not just the row: session/run rows land BEFORE the
    // eve dispatch (the 202-async window), so a row snapshot taken too early
    // carries eve_session_id NULL and every later assertion against it
    // silently compares to null.
    const session1 = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.origin === "slack" && s.eveSessionId) ?? undefined;
    }, "slack thread session created with an eve session id");
    expect(session1.slackThreadKey).toBe(`${integration.id}:C-slack:${rootTs}`);

    // The agent step became a RENDERED instruction message on eve's default
    // channel — CONVERSATION mode (a human can answer in Slack), and NO
    // Slack secret ever entered agent env.
    const opened = await until(
      async () => worker.sessionMessages.slice(beforeMessages).find((m) => m.kind === "create"),
      "slack eve child session",
    );
    expect(opened.message).toContain("Reply helpfully. hello there");
    expect(opened.mode).toBeUndefined(); // thread sessions are never task-mode
    for (const ensure of worker.ensureCalls) {
      expect(ensure.env.SLACK_BOT_TOKEN).toBeUndefined();
      expect(ensure.env.SLACK_API_BASE_URL).toBeUndefined();
    }

    // The PARENT pipeline run owes the reply (`onComplete.slackReply` +
    // slack origin ⇒ born pending) and settles `delivered` once the child's
    // text renders through the template.
    const parent1 = await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.workflowId, wfId));
      return runs.find((r) => r.mode === "pipeline" && r.status === "succeeded");
    }, "first parent run done");
    const settled = await until(async () => {
      const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, parent1.id));
      return rows[0]!.deliveryStatus === "delivered" ? rows[0] : undefined;
    }, "reply delivered to slack");
    expect(settled.deliveryStatus).toBe("delivered");
    const posted = slack.postMessages.find(
      (m) => m.channel === "C-slack" && m.thread_ts === rootTs,
    )!;
    expect(posted).toBeTruthy();
    // `@steps.reply.text` rendered to the child's final stop-message.
    expect(String(posted.text)).toStartWith("echo:");

    // A second settle attempt (boot recovery racing the runner's terminal
    // path) is CAS'd out — the marker only flips from `pending`, so the
    // reply is never double-posted (at-least-once, single ledger writer).
    const delivery = createDeliveryService({
      reader: createDrizzleDeliveryReader(db),
      runStore: stack.runtime!.runStore,
      slackClient: createSlackClient({ apiBaseUrl: slack.url }),
      masterKey: parseMasterKey(MASTER_KEY_B64),
      logger: createLogger({ sink: () => {}, minLevel: "error" }),
    });
    const outcome = await delivery.deliver({
      runId: parent1.id,
      status: "succeeded",
      lastAssistantMessage: null, // would force a ledger re-render
    });
    expect(outcome).toBe("skipped");
    expect(
      slack.postMessages.filter((m) => m.channel === "C-slack" && m.thread_ts === rootTs),
    ).toHaveLength(1);

    // A reply IN the thread (thread_ts = the root ts), no mention — starts a
    // NEW pipeline run whose agent step must ride the SAME eve session as a
    // continuation (native eve session API).
    const reply = await postSlackEvent({ type: "message", channel: "C-slack", channel_type: "channel", user: "U777", text: "and one more thing", ts: "1720000200.000200", thread_ts: rootTs, team: "T-TEST" });
    expect(reply.status).toBe(200);

    const continued = await until(
      async () =>
        worker.sessionMessages.find(
          (m) => m.kind === "continue" && m.sessionId === session1.eveSessionId,
        ),
      "continue message reached the worker",
    );
    expect(continued.message).toContain("and one more thing");
    // Two PARENT pipeline runs, ONE thread session.
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.workflowId, wfId));
      return runs.filter((r) => r.mode === "pipeline" && r.status === "succeeded").length >= 2 ? true : undefined;
    }, "second parent run done");
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

  test("Slack: a MID-TEXT mention's message twin is suppressed too (no duplicate continuation)", async () => {
    const wfId = await createWorkflow("Slack Midtext Twin WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    // Slack fires app_mention for a mention ANYWHERE in the text — the raw
    // `message.channels` twin must be dropped even when the mention is not
    // leading (a leading-only check would double-dispatch once the first
    // twin's run completes and the busy-guard no longer catches the second).
    const ts = "1720000500.000900";
    const mention = { type: "app_mention", user: "U9", text: "can <@U0BOT> summarize this?", ts, channel: "C-midtwin", team: "T-TEST" };
    const twin = { type: "message", channel: "C-midtwin", channel_type: "channel", user: "U9", text: "can <@U0BOT> summarize this?", ts, team: "T-TEST" };
    await postSlackEvent(mention, { eventId: randomUUID() });

    const session = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.origin === "slack") ?? undefined;
    }, "mid-text twin session");
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "mid-text twin run done");

    // Twin lands AFTER the first run completed — the busy-guard cannot save
    // us here; only twin suppression prevents a duplicate dispatch.
    await postSlackEvent(twin, { eventId: randomUUID() });
    await Bun.sleep(200);

    const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, session.id));
    expect(runs).toHaveLength(1); // exactly ONE dispatch for one user message
  });

  test("Slack: a terminal (errored) session releases its thread key — the next thread message mints a fresh session instead of being dropped forever", async () => {
    const wfId = await createWorkflow("Slack Recovery WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    const rootTs = "1720000600.000600";
    await postSlackEvent({ type: "app_mention", user: "U5", text: "<@U0BOT> start a thread", ts: rootTs, channel: "C-recover", team: "T-TEST" });
    const first = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId));
      return rows.find((s) => s.origin === "slack") ?? undefined;
    }, "recovery session created");
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, first.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "recovery first run done");
    // The PARENT must settle too — overlap "skip" would drop the next event.
    await awaitWorkflowQuiet(wfId);

    // Poison the session the way a failed first dispatch used to: terminal
    // status with the thread key STILL SET (legacy pre-fix shape — the
    // dispatch-side eviction must handle rows markSession never cleaned).
    await db
      .update(schema.agentSessions)
      .set({ status: "error" })
      .where(eq(schema.agentSessions.id, first.id));

    // A new mention in the SAME thread: findSlackThreadSession skips the
    // errored row, and the new-session path must EVICT its key claim rather
    // than throw session_busy (which Slack routing drops) — otherwise this
    // thread is bricked forever.
    await postSlackEvent({ type: "app_mention", user: "U5", text: "<@U0BOT> are you still there?", ts: "1720000700.000700", thread_ts: rootTs, channel: "C-recover", team: "T-TEST" });
    const second = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
      return rows.find((s) => s.id !== first.id) ?? undefined;
    }, "fresh session minted for the poisoned thread");
    expect(second.slackThreadKey).toBe(first.slackThreadKey);
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, second.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "fresh session run dispatched");

    // The evicted holder lost its key claim (the unique index slot is free).
    const evicted = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, first.id)))[0]!;
    expect(evicted.slackThreadKey).toBeNull();

    // And the FORWARD path: markSession to a terminal status releases the key
    // immediately (no eviction needed for sessions terminated after this fix).
    await stack.runtime!.runStore.markSession(second.id, "closed");
    const closed = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, second.id)))[0]!;
    expect(closed.status).toBe("closed");
    expect(closed.slackThreadKey).toBeNull();
  });

  test("Slack: an eve session that died WITHOUT the platform noticing (409 session_not_active) evicts the thread claim and the next message recovers", async () => {
    // The 0.31 failure mode the status-driven eviction above cannot reach.
    // eve's truth can diverge from agent_sessions.status indefinitely — a
    // 30-day sessionTimeoutMs emits session.completed into a stream nobody is
    // tailing, a `reset` retires the id, a task-mode budget breach fails it.
    // In all three the row stays `active`, findSlackThreadSession happily
    // returns it, and the continuation 409s. Without an EVE-driven eviction
    // the thread is bricked forever.
    const wfId = await createWorkflow("Slack Dead-Eve WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    const rootTs = "1720000800.000800";
    await postSlackEvent({ type: "app_mention", user: "U9", text: "<@U0BOT> open a thread", ts: rootTs, channel: "C-dead", team: "T-TEST" });
    const first = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
      return rows.find((s) => s.eveSessionId) ?? undefined;
    }, "dead-eve session created");
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, first.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "dead-eve first run done");
    // The PARENT must settle too — overlap "skip" would drop the next event.
    await awaitWorkflowQuiet(wfId);

    // Kill it INSIDE eve only. The platform row stays `active` and keeps its
    // thread key — exactly the divergence 0.31 introduces.
    worker.sessions.get(first.eveSessionId!)!.dead = true;

    await postSlackEvent({ type: "message", channel: "C-dead", channel_type: "channel", user: "U9", text: "still there?", ts: "1720000810.000810", thread_ts: rootTs, team: "T-TEST" });

    // The agent step's continuation fails with the PERMANENT code, and the
    // dispatch evicts the claim: the row closes and releases its
    // slack_thread_key.
    const evicted = await until(async () => {
      const rows = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, first.id));
      return rows[0]!.status === "closed" ? rows[0] : undefined;
    }, "dead eve session evicted (row closed)");
    expect(evicted.slackThreadKey).toBeNull();
    // The failing CHILD run records the typed, permanent error — never the
    // generic 502 worker_dispatch_failed, which would read as a transient
    // outage. The eviction (markSession) lands a beat before the run is
    // marked, so poll rather than read once.
    const failed = await until(async () => {
      const rows = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, first.id));
      return rows.find((r) => r.status === "failed") ?? undefined;
    }, "the continuation child run failed with the permanent code");
    expect(failed.error ?? "").toContain("can no longer accept messages");

    // RECOVERY happens INSIDE the same pipeline run: the executor classifies
    // session_not_active as retryable (the claim is already freed), and the
    // runner's second attempt mints a fresh session under the freed key —
    // the user's message is NOT lost.
    const revived = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
      return rows.find((s) => s.id !== first.id) ?? undefined;
    }, "fresh session minted by the retry after the eve-driven eviction");
    expect(revived.slackThreadKey).toBe(first.slackThreadKey);
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, revived.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "recovered session run succeeded");
  });

  // ── F2: agent-qualified thread sessions outlive the bare-key holder ────────

  test("Slack: after the bare-key holder terminates, the agent-qualified session still continues AND unmentioned replies still dispatch", async () => {
    // Two agents share one thread: agent A claimed the BARE key; the
    // workflow was then republished binding agent B, whose step claimed the
    // QUALIFIED key. Once A's session terminates (bare key released), the
    // thread must remain KNOWN to the ingress (unmentioned replies dispatch
    // under a mention-only binding) and B's step must find ITS qualified
    // session first — never mint a fresh bare session that strands B's
    // history.
    const agentBId = await createPublishedAgent();
    const wfId = await createWorkflow(
      "Slack Two-Agent WF",
      { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
      { instructions: "Continue kindly. @trigger.text" },
    );
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    // Agent A claims the bare key.
    const rootTs = "1720000900.000900";
    const bareKey = `${integration.id}:C-multi:${rootTs}`;
    await postSlackEvent({ type: "app_mention", user: "U2A", text: "<@U0BOT> hello A", ts: rootTs, channel: "C-multi", team: "T-TEST" });
    const sessionA = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
      return rows.find((s) => s.eveSessionId && s.slackThreadKey === bareKey) ?? undefined;
    }, "agent A's bare-key session");
    expect(sessionA.agentId).toBe(agentId);
    // A's PARENT pipeline run must settle before the next thread event —
    // overlap "skip" drops an event while any run of the workflow is live.
    await awaitWorkflowQuiet(wfId);

    // Republish the workflow with the step bound to agent B.
    const wfRow = (await db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)))[0]!;
    const published = wfRow.published as { steps: Array<Record<string, unknown>> };
    published.steps[0]!.agentId = agentBId;
    await db.update(schema.workflows).set({ published }).where(eq(schema.workflows.id, wfId));

    // A mentioned thread reply now runs agent B: the bare holder (A)
    // mismatches, so B claims the QUALIFIED key.
    await postSlackEvent({ type: "app_mention", user: "U2A", text: "<@U0BOT> hello B", ts: "1720000901.000901", thread_ts: rootTs, channel: "C-multi", team: "T-TEST" });
    const sessionB = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
      return rows.find((s) => s.eveSessionId && s.id !== sessionA.id) ?? undefined;
    }, "agent B's qualified session");
    expect(sessionB.agentId).toBe(agentBId);
    expect(sessionB.slackThreadKey).toBe(`${bareKey}:agent:${agentBId}`);
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, sessionB.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "agent B's first run done");
    await awaitWorkflowQuiet(wfId);

    // Agent A's session terminates — its bare-key claim is released.
    await stack.runtime!.runStore.markSession(sessionA.id, "closed");

    // An UNMENTIONED thread reply under a mention-only binding: the thread
    // is still known (the qualified session lives), so the ingress
    // dispatches, and B's step continues ITS qualified session.
    await postSlackEvent({ type: "message", channel: "C-multi", channel_type: "channel", user: "U2A", text: "one more from the quiet user", ts: "1720000902.000902", thread_ts: rootTs, team: "T-TEST" });
    const continued = await until(
      async () =>
        worker.sessionMessages.find(
          (m) => m.kind === "continue" && m.sessionId === sessionB.eveSessionId && m.message.includes("one more from the quiet user"),
        ),
      "unmentioned reply continued agent B's qualified session",
    );
    expect(continued.hash).toBeTruthy();
    // No THIRD session was minted — B's history was never stranded.
    const sessions = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack");
    expect(sessions).toHaveLength(2);
  }, 30_000);

  test("Slack: a claim poisoned by a crash BEFORE the eve create (active, eveless, no live run) is evicted — the thread recovers", async () => {
    // W1's aftermath, simulated directly: the claim transaction committed
    // (session row + thread key), the process died before the eve create,
    // and boot reconciliation failed the child run — leaving an ACTIVE
    // eveless holder with zero live runs. Without the stale-claim eviction
    // every later message in the thread would 409 session_busy forever.
    const wfId = await createWorkflow("Slack Poisoned Claim WF", { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } });
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    await api("PUT", `/workspaces/${orgId}/workflows/${wfId}/triggers/slack`, {
      cookie: ownerCookie,
      body: { integrationId: integration.id, binding: { mentionOnly: true, includeDirectMessages: false } },
    });

    const agentRow = (await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)))[0]!;
    const rootTs = "1720000903.000903";
    const threadKey = `${integration.id}:C-poison:${rootTs}`;
    const poisoned = (
      await db
        .insert(schema.agentSessions)
        .values({
          organizationId: orgId,
          agentId,
          agentVersionId: agentRow.publishedVersionId!,
          workflowId: wfId,
          eveSessionId: null, // the create never happened
          origin: "slack",
          principal: { workspaceId: orgId, source: "slack:U-poison" },
          slackThreadKey: threadKey,
          status: "active", // nothing ever closed it
        })
        .returning()
    )[0]!;

    await postSlackEvent({ type: "app_mention", user: "U-poison", text: "<@U0BOT> hello again", ts: "1720000904.000904", thread_ts: rootTs, channel: "C-poison", team: "T-TEST" });

    // A fresh session claims the key (the poisoned holder was evicted, not
    // treated as busy) and the message dispatches.
    const fresh = await until(async () => {
      const rows = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.workflowId, wfId))).filter((s) => s.origin === "slack" && s.id !== poisoned.id);
      return rows.find((s) => s.eveSessionId) ?? undefined;
    }, "fresh session for the poisoned thread");
    expect(fresh.slackThreadKey).toBe(threadKey);
    await until(async () => {
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.agentSessionId, fresh.id));
      return runs.some((r) => r.status === "succeeded") ? true : undefined;
    }, "poisoned-thread recovery run succeeded");
    const stale = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, poisoned.id)))[0]!;
    expect(stale.slackThreadKey).toBeNull();
  }, 30_000);

  // ── disconnect ─────────────────────────────────────────────────────────────

  test("integration disconnect removes the row", async () => {
    const integration = (await db.select().from(schema.integrations).where(eq(schema.integrations.organizationId, orgId))).find((r) => r.type === "slack")!;
    const res = await api("DELETE", `/workspaces/${orgId}/integrations/${integration.id}`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.id, integration.id));
    expect(rows).toHaveLength(0);
  });
});
