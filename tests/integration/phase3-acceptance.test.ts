/**
 * PHASE-3 ACCEPTANCE (docs/PLAN.md Phase 3 §Acceptance, re-keyed for the
 * agents-first redesign) — the worker pool, every trigger surface, HITL,
 * Slack thread continuity + control-plane reply delivery, the schedule
 * ticker, dead-worker failover, and graceful drain, all against the REAL
 * stack: a real control plane, TWO real `apps/worker` processes, real
 * `@invisible-string/compiler` v3 agents (`eve build`) booted from Garage
 * tarballs, and eve's mock-model harness serving the turns
 * (EVE_MOCK_AUTHORED_MODELS — no provider key). External services are
 * stubbed: a local MCP server and a local Slack Web API server. NOTHING
 * between the platform API and a live compiled agent is faked.
 *
 * AGENTS-FIRST SHAPE: the AGENT is the compile unit — TWO agents (two hashes,
 * two builds); the workflows all delegate to one of them and compile NOTHING
 * (publish is instant). Dispatch renders each workflow's instructions into
 * the task message; agent env is identical across every path (no per-trigger
 * env — no SLACK_BOT_TOKEN ever reaches an agent).
 *
 * The proofs (each an assertion polled off real DB/stub state — no sleeps):
 *   1. SPREAD    — sessions land on ≥2 distinct workers
 *      (`agent_sessions.affinity_worker_id` spans both). Two AGENT HASHES are
 *      used (single-writer-per-hash fencing pins one hash to one worker);
 *      determinism comes from the real "scheduler only routes to LIVE
 *      workers" rule (park one worker `draining` for the second dispatch —
 *      the same mechanism graceful drain uses).
 *   2. TRIGGERS  — manual "Run now" (`POST /workspaces/:id/workflows/:wfId/run`),
 *      form (`POST /t/:token`) and webhook (`POST /t/:token`) each start a
 *      run whose persisted task message carries the `<workflow-task>` wrapper.
 *   3. SLACK     — an app_mention creates a session AND the CONTROL PLANE
 *      delivers a THREADED chat.postMessage to the stub Slack API off the
 *      run's terminal event (runs.delivery_status settles `delivered` — the
 *      compiled artifact has no Slack code path at all in compiler v3); a
 *      follow-up in the SAME thread_ts continues the SAME agent_session (one
 *      session row, two runs, same eve session id, both replies delivered).
 *   4. SCHEDULE  — a published cron workflow with a DUE `next_fire_at` is
 *      claimed and dispatched by the control-plane schedule ticker (short
 *      SCHEDULE_TICK_MS): the session's origin is `schedule`, the cursor
 *      advances (no backfill), and disabling the workflow disarms it.
 *   5. HITL      — an ask_question tool call parks the run (`waiting`);
 *      answering via `POST /runs/:id/input` resumes it to `succeeded`.
 *   6. FAILOVER  — a parked run on worker A survives `SIGKILL A`: the sweeper
 *      marks A dead and CLEARS the session affinity, then the parked approval
 *      reschedules and the durable eve turn RESUMES on worker B and finishes.
 *   7. DRAIN     — `SIGTERM` worker A mid-idle with an agent loaded: it
 *      deregisters, new sessions route to worker B, and A exits 0.
 *
 * Gated on TEST_DATABASE_URL (+ mise + docker). Infra: the docker-compose
 * postgres/garage services, brought up on demand when unreachable. The first
 * run cold-installs the generated agents' npm deps (minutes) — NPM_CACHE_DIR
 * keeps reruns warm.
 *
 *   POSTGRES_PORT=5444 docker compose -p p3acceptance up -d --wait postgres garage
 *   TEST_DATABASE_URL=postgres://dev:dev@localhost:5444/product PHASE3_AGENT_ROOT=/tmp/invisible-string-p3-agents bun test tests/integration/phase3-acceptance.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { and, eq } from "drizzle-orm";
import { SQL } from "bun";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  encryptSecret,
  parseMasterKey,
  generateMasterKeyBase64,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  type AgentDefinitionInput,
  type CreateSessionResponse,
  type CreateWebhookTokenResponse,
  type PublishAgentResponse,
  type PublishWorkflowResponse,
  type SlackInnerEvent,
  type SlackIntegrationMetadata,
  type TriggerIngressResponse,
  type WorkflowConfigInput,
} from "@invisible-string/shared";

import { createAppStack, type AppStack } from "../../apps/control-plane/src/index";
import { runMigrations } from "../../apps/control-plane/src/migrate";
import { mcpAuthAadContext } from "../../apps/control-plane/src/runtime/agent-env";
import {
  createScheduleTicker,
  type ScheduleTicker,
} from "../../apps/control-plane/src/runtime/schedule-ticker";
import { createWorkerSweeper } from "../../apps/control-plane/src/runtime/worker-sweeper";
import { computeSlackSignature } from "../../apps/control-plane/src/integrations/slack-verify";
import { encryptIntegrationCredentials } from "../../apps/control-plane/src/integrations/crypto";
import {
  setSlackBinding,
  upsertSlackIntegration,
  upsertTriggerType,
} from "../../apps/control-plane/src/integrations/service";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:3900";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const PLATFORM_JWT_SECRET = "p3a-platform-jwt-secret-000000000";
const WORKER_SHARED_SECRET = "p3a-worker-shared-secret-00000000";

// Dev-only throwaway Slack app credentials (never a real Slack).
const SLACK_CLIENT_ID = "111.222";
const SLACK_CLIENT_SECRET = "p3a-slack-client-secret-000000";
const SLACK_SIGNING_SECRET = "p3a-slack-signing-secret-00000000000";
const SLACK_TEAM_ID = "T_P3ACCEPT";
const SLACK_BOT_TOKEN = "xoxb-p3-stub-bot-token";
const SLACK_BOT_USER_ID = "UBOTP3";
const SLACK_CHANNEL = "C_P3ACCEPT";

/** Canonical agent root — MUST be identical for build service and every worker. */
const AGENT_ROOT =
  process.env.PHASE3_AGENT_ROOT ?? "/tmp/invisible-string-p3-agents";
const NPM_CACHE_DIR = process.env.NPM_CACHE_DIR ?? join(homedir(), ".npm");

// Worker liveness tuned tight so a SIGKILLed worker is swept dead within
// seconds (failover) without being flaky under load: TTL 4s, sweep every 1s,
// heartbeat every 1s. The schedule ticker scans every 500ms so a forced-due
// trigger fires within one poll interval.
const WORKER_HEARTBEAT_TTL_MS = "4000";
const WORKER_SWEEP_INTERVAL_MS = "1000";
const HEARTBEAT_INTERVAL_MS = "1000";
const SCHEDULE_TICK_MS = "500";

const GATE_PROBLEMS: string[] = [];
if (!TEST_DATABASE_URL) GATE_PROBLEMS.push("TEST_DATABASE_URL not set");
if (Bun.which("mise") === null) GATE_PROBLEMS.push("mise not on PATH (eve builds need Node 24)");
if (Bun.which("docker") === null) GATE_PROBLEMS.push("docker not on PATH");
const GATE = GATE_PROBLEMS.length === 0;
if (!GATE) {
  console.warn(`[phase3-acceptance] skipped: ${GATE_PROBLEMS.join("; ")}`);
}

// ── infra (compose on demand) ───────────────────────────────────────────────

async function tcpReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function pgReachable(url: string): Promise<boolean> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}

async function ensureInfra(): Promise<void> {
  const pgUp = await pgReachable(TEST_DATABASE_URL!);
  const s3Up = await tcpReachable(S3_ENDPOINT);
  if (pgUp && s3Up) return;
  const pgPort = new URL(TEST_DATABASE_URL!).port || "5432";
  const s3Port = new URL(S3_ENDPOINT).port || "3900";
  const services = [...(pgUp ? [] : ["postgres"]), ...(s3Up ? [] : ["garage"])];
  const composeEnv = {
    ...process.env,
    POSTGRES_PORT: pgPort,
    GARAGE_PORT: s3Port,
  };
  const compose = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["docker", "compose", "-p", "p3acceptance", ...args], {
      cwd: REPO_ROOT,
      env: composeEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  };
  const upCode = await compose("up", "-d", "--wait", ...services);
  if (upCode !== 0) throw new Error(`docker compose up failed (${upCode})`);
}

async function ensureWorldDatabase(): Promise<string> {
  const worldUrl = new URL(TEST_DATABASE_URL!);
  worldUrl.pathname = "/world";
  const admin = new SQL(TEST_DATABASE_URL!, { max: 1 });
  try {
    const rows = (await admin`select 1 as one from pg_database where datname = 'world'`) as unknown[];
    if (rows.length === 0) await admin.unsafe(`create database "world"`);
  } finally {
    await admin.close();
  }
  return worldUrl.toString();
}

async function ensureFreshProductDatabase(): Promise<string> {
  const name = "p3a_product";
  const admin = new SQL(TEST_DATABASE_URL!, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Kill any agent left over from a previous crashed run (matched by AGENT_ROOT). */
async function reapLeftoverAgents(): Promise<void> {
  const proc = Bun.spawn(["pkill", "-9", "-f", `${AGENT_ROOT}/`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** `<mise install dir for node@24>/bin`, or null. Pinned on every worker's PATH
 *  so the agent boot (`node .output/server/index.mjs`) always runs Node 24. */
function resolveNode24Bin(): string | null {
  const result = spawnSync("mise", ["where", "node@24"], { encoding: "utf8" });
  const dir = result.status === 0 ? result.stdout.trim() : "";
  return dir ? `${dir}/bin` : null;
}

// ── local stub MCP server (streamable HTTP, JSON-RPC) ───────────────────────

function startStubMcp(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as { id?: number | string; method?: string };
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "stub-notes", version: "1.0.0" },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "save_note",
                    description: "Save a note",
                    inputSchema: {
                      type: "object",
                      properties: { note: { type: "string" } },
                      required: ["note"],
                    },
                  },
                ],
              }
            : {};
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

// ── local stub Slack Web API server (receives the CONTROL PLANE's replies) ──

interface SlackPostedMessage {
  channel: string;
  text: string;
  threadTs: string | null;
  authorization: string | null;
}

function startStubSlack(): {
  baseUrl: string;
  posted: SlackPostedMessage[];
  stop(): void;
} {
  const posted: SlackPostedMessage[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat.postMessage") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          channel?: string;
          text?: string;
          thread_ts?: string;
        };
        posted.push({
          channel: body.channel ?? "",
          text: body.text ?? "",
          threadTs: body.thread_ts ?? null,
          authorization: req.headers.get("authorization"),
        });
        return Response.json({ ok: true, ts: `${Date.now() / 1000}` });
      }
      if (url.pathname.endsWith("/oauth.v2.access")) {
        // Unused (we seed the integration directly) — answer plausibly anyway.
        return Response.json({ ok: false, error: "not_used_in_test" });
      }
      return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    posted,
    stop: () => server.stop(true),
  };
}

// ── polling ─────────────────────────────────────────────────────────────────

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 120_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

interface ManagedWorker {
  id: string;
  port: number;
  address: string;
  proc: ReturnType<typeof Bun.spawn>;
}

describe.skipIf(!GATE)("phase 3 acceptance — worker pool + triggers + delivery + HITL", () => {
  const mcp = GATE ? startStubMcp() : null!;
  const slack = GATE ? startStubSlack() : null!;
  const node24Bin = GATE ? resolveNode24Bin() : null;

  let stack: AppStack;
  let sweeper: ReturnType<typeof createWorkerSweeper>;
  let ticker: ScheduleTicker;
  let db: AppStack["dbHandle"]["db"];
  let baseUrl: string;
  const workers: ManagedWorker[] = [];
  let agentPortCursor = 4420;

  let cookie: string;
  let orgId: string;

  // Two published agents = two hashes = two builds. Every workflow delegates
  // to Alpha; Beta exists so SPREAD can span two workers without fighting the
  // single-writer-per-hash fence.
  let agentAlphaId: string;
  let agentBetaId: string;

  // Delegation workflows (published instantly — no builds).
  let manualWorkflowId: string;
  let formWorkflowId: string;
  let webhookWorkflowId: string;
  let slackWorkflowId: string;

  async function api(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        cookie,
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }

  /** Spawn one real worker process; returns once it is registered `live`. */
  async function spawnWorker(): Promise<ManagedWorker> {
    const id = randomUUID();
    const port = await freePort();
    const address = `http://localhost:${port}`;
    const agentPortMin = agentPortCursor;
    const agentPortMax = agentPortCursor + 39;
    agentPortCursor += 40;
    const pinnedPath = node24Bin
      ? `${node24Bin}:${process.env.PATH ?? ""}`
      : process.env.PATH;
    const proc = Bun.spawn(["bun", "apps/worker/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: pinnedPath,
        CONTROL_PLANE_URL: baseUrl,
        WORKER_SHARED_SECRET,
        WORKER_ID: id,
        PORT: String(port),
        PUBLIC_URL: address,
        ARTIFACT_CACHE_DIR: AGENT_ROOT,
        HEARTBEAT_INTERVAL_MS,
        AGENT_READY_TIMEOUT_MS: "120000",
        AGENT_PORT_MIN: String(agentPortMin),
        AGENT_PORT_MAX: String(agentPortMax),
        // The control-plane tailer holds a live NDJSON stream open per active
        // session to follow future turns, so a graceful drain always trips its
        // in-flight wait. Keep that wait short here — the drain still stops the
        // agents and deregisters cleanly (exit 0), just without a 30s stall.
        DRAIN_TIMEOUT_MS: "3000",
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const worker: ManagedWorker = { id, port, address, proc };
    workers.push(worker);
    await until(
      async () => {
        const rows = await db
          .select({ status: schema.workers.status })
          .from(schema.workers)
          .where(eq(schema.workers.id, id));
        return rows[0]?.status === "live" || undefined;
      },
      `worker ${id.slice(0, 8)} registration`,
      30_000,
    );
    return worker;
  }

  async function stopWorker(worker: ManagedWorker, signal: "SIGTERM" | "SIGKILL"): Promise<number | null> {
    worker.proc.kill(signal);
    // Generous fallback: a graceful drain waits DRAIN_TIMEOUT_MS for in-flight,
    // then stops its eve agents (graphile graceful shutdown is ~10s each).
    const timer =
      signal === "SIGTERM" ? setTimeout(() => worker.proc.kill("SIGKILL"), 90_000) : null;
    await worker.proc.exited.catch(() => {});
    if (timer) clearTimeout(timer);
    const idx = workers.indexOf(worker);
    if (idx >= 0) workers.splice(idx, 1);
    return worker.proc.exitCode;
  }

  async function createAgent(name: string, draft: AgentDefinitionInput): Promise<string> {
    const res = await api("POST", `/workspaces/${orgId}/agents`, {
      body: { name, draft },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string } };
    return body.agent.id;
  }

  async function awaitBuild(contentHash: string): Promise<void> {
    await stack.runtime!.buildService.waitFor(contentHash);
    await until(
      async () => {
        const row = await stack.runtime!.buildStore.get(contentHash);
        if (row?.status === "failed") throw new Error(`build failed:\n${row.errorLog ?? "(no log)"}`);
        return row?.status === "succeeded" || undefined;
      },
      `build of ${contentHash.slice(0, 12)}`,
      15 * 60_000,
      1_000,
    );
  }

  /** Publish an agent and wait for its REAL eve build. */
  async function publishAgentAndBuild(agentId: string): Promise<PublishAgentResponse> {
    const res = await api("POST", `/workspaces/${orgId}/agents/${agentId}/publish`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishAgentResponse;
    await awaitBuild(body.contentHash);
    return body;
  }

  async function createWorkflow(name: string, draft: WorkflowConfigInput): Promise<string> {
    const res = await api("POST", `/workspaces/${orgId}/workflows`, {
      body: { name, draft },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workflow: { id: string } };
    return body.workflow.id;
  }

  /** Workflow publish is INSTANT (validate + snapshot + trigger sync, no build). */
  async function publishWorkflow(workflowId: string): Promise<PublishWorkflowResponse> {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`);
    expect(res.status).toBe(200);
    return (await res.json()) as PublishWorkflowResponse;
  }

  /** Start a chat session against a published agent. */
  async function chat(agentId: string, message: string): Promise<CreateSessionResponse> {
    const res = await api("POST", `/workspaces/${orgId}/agents/${agentId}/sessions`, {
      body: { message },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateSessionResponse;
  }

  async function runStatus(runId: string): Promise<string | undefined> {
    const rows = await db
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    if (rows[0]?.status === "failed") throw new Error(`run failed: ${rows[0].error ?? "(no error)"}`);
    return rows[0]?.status;
  }

  async function awaitRunStatus(runId: string, want: string, timeoutMs = 120_000): Promise<void> {
    await until(async () => ((await runStatus(runId)) === want ? true : undefined), `run ${runId.slice(0, 8)} → ${want}`, timeoutMs);
  }

  async function runMessages(runId: string): Promise<string[]> {
    const events = await db
      .select({ event: schema.runEvents.event })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return events
      .map((e) => e.event as { type: string; data?: { message?: string | null } })
      .filter((e) => e.type === "message.completed")
      .map((e) => e.data?.message ?? "");
  }

  /** The requestId eve emitted with the parked input.requested for a run. */
  async function pendingRequestId(runId: string): Promise<string | undefined> {
    const events = await db
      .select({ event: schema.runEvents.event })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    for (const row of events) {
      const ev = row.event as { type: string; data?: { requests?: { requestId: string }[] } };
      if (ev.type === "input.requested") return ev.data?.requests?.[0]?.requestId;
    }
    return undefined;
  }

  async function sessionAffinity(sessionId: string): Promise<string | null | undefined> {
    const rows = await db
      .select({ affinity: schema.agentSessions.affinityWorkerId })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId));
    return rows[0]?.affinity;
  }

  async function sessionRow(sessionId: string) {
    const rows = await db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId));
    return rows[0];
  }

  async function runRow(runId: string) {
    const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    return rows[0];
  }

  async function triggerRowOf(workflowId: string) {
    const rows = await db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.workflowId, workflowId));
    return rows[0];
  }

  function slackHeaders(rawBody: string): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      [SLACK_TIMESTAMP_HEADER]: ts,
      [SLACK_SIGNATURE_HEADER]: computeSlackSignature(SLACK_SIGNING_SECRET, ts, rawBody),
    };
  }

  async function postSlackEvent(event: SlackInnerEvent, eventId: string): Promise<void> {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: SLACK_TEAM_ID,
      event_id: eventId,
      event,
    });
    const res = await fetch(`${baseUrl}/integrations/slack/events`, {
      method: "POST",
      headers: slackHeaders(raw),
      body: raw,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
  }

  beforeAll(async () => {
    await ensureInfra();
    const worldDatabaseUrl = await ensureWorldDatabase();
    const productDatabaseUrl = await ensureFreshProductDatabase();
    await runMigrations(productDatabaseUrl);
    mkdirSync(AGENT_ROOT, { recursive: true });
    await reapLeftoverAgents();

    const controlPort = await freePort();
    baseUrl = `http://localhost:${controlPort}`;
    stack = createAppStack({
      DATABASE_URL: productDatabaseUrl,
      BETTER_AUTH_SECRET: "p3a-better-auth-secret-0123456789",
      BETTER_AUTH_URL: baseUrl,
      PUBLIC_APP_URL: baseUrl,
      ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
      WORLD_DATABASE_URL: worldDatabaseUrl,
      PLATFORM_JWT_SECRET,
      WORKER_SHARED_SECRET,
      S3_ENDPOINT,
      S3_ACCESS_KEY_ID:
        process.env.S3_ACCESS_KEY_ID ?? "GKdeadbeefdeadbeefdeadbeefdeadbeef",
      S3_SECRET_ACCESS_KEY:
        process.env.S3_SECRET_ACCESS_KEY ??
        "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
      S3_BUCKET: process.env.S3_BUCKET ?? "artifacts",
      // Garage enforces exact SigV4 region matching (infra/garage.toml
      // s3_region) — a real S3 provider would tolerate a region mismatch;
      // Garage does not.
      S3_REGION: process.env.S3_REGION ?? "us-east-1",
      // Mock-model harness (no provider key; a dead base URL fails real calls loudly).
      OPENROUTER_API_KEY: "p3a-dummy-openrouter-key",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/v1",
      EVE_MOCK_AUTHORED_MODELS: "1",
      ALLOW_INSECURE_WORKER_TRANSPORT: "1",
      AGENT_BUILD_ROOT: AGENT_ROOT,
      NPM_CACHE_DIR,
      SSE_HEARTBEAT_MS: "500",
      WORKER_HEARTBEAT_TTL_MS,
      WORKER_SWEEP_INTERVAL_MS,
      SCHEDULE_TICK_MS,
      // Slack app configured; ingress verification + the control-plane
      // DeliveryService's chat.postMessage both hit the local stub.
      SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET,
      SLACK_API_BASE_URL: slack.baseUrl,
    });
    expect(stack.runtime).not.toBeNull();
    db = stack.dbHandle.db;
    stack.app.listen(controlPort);
    // The sweeper + schedule ticker only auto-start in the CLI entrypoint
    // (import.meta.main); an in-process stack starts them itself — failover
    // depends on the sweeper, the SCHEDULE proof on the ticker.
    sweeper = createWorkerSweeper(stack.runtime!, { log: () => {} });
    sweeper.start();
    ticker = createScheduleTicker(stack.runtime!, {
      tickMs: stack.runtime!.runtime.scheduleTickMs,
    });
    ticker.start();

    // Two real workers.
    await spawnWorker();
    await spawnWorker();

    // Workspace: user + org + seeds.
    const email = `p3a-${randomUUID()}@example.com`;
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "P3 Acceptance" }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const authHeaders = new Headers({ cookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: "P3 Acceptance ws", slug: `p3a-${randomUUID().slice(0, 8)}` },
      headers: authHeaders,
    });
    orgId = org!.id;
    await stack.auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: authHeaders });
    await seedWorkspace(db, orgId); // idempotent (afterCreateOrganization already ran)

    // One MCP connection → the stub server (equipped on agent Alpha; proves
    // agent CONTEXT boots against a real MCP server across trigger surfaces).
    const conn = await db
      .insert(schema.mcpConnections)
      .values({ scope: "workspace", organizationId: orgId, name: "notes", source: "custom", url: mcp.url })
      .returning({ id: schema.mcpConnections.id });
    const connectionId = conn[0]!.id;
    await db
      .update(schema.mcpConnections)
      .set({
        authConfigEncrypted: JSON.stringify(
          encryptSecret(
            JSON.stringify({ token: "stub-notes-token" }),
            parseMasterKey(MASTER_KEY_B64),
            mcpAuthAadContext(connectionId),
          ),
        ),
      })
      .where(eq(schema.mcpConnections.id, connectionId));

    const persona =
      "You are a helpful assistant. Do exactly what the incoming message asks. " +
      "The message may be wrapped in <workflow-task> or <trigger-context> blocks; " +
      "obey the instruction inside them.";

    // TWO agents → two hashes → two eve builds (name feeds the hash via its
    // slug, so even an identical definition compiles to a distinct artifact).
    agentAlphaId = await createAgent("P3 Alpha", {
      persona,
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [connectionId], skillIds: [] },
    });
    agentBetaId = await createAgent("P3 Beta", {
      persona,
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });
    await publishAgentAndBuild(agentAlphaId);
    await publishAgentAndBuild(agentBetaId);

    // Delegation workflows — all handled by Alpha; publish is instant.
    const instructions = {
      markdown:
        "Do exactly what the incoming request in the trigger context asks.",
    };
    manualWorkflowId = await createWorkflow("P3 Manual", {
      trigger: { type: "manual" },
      agentId: agentAlphaId,
      instructions,
    });
    formWorkflowId = await createWorkflow("P3 Form", {
      trigger: {
        type: "form",
        fields: [
          { key: "message", label: "Message", type: "text", required: true },
          { key: "topic", label: "Topic", type: "text", required: false },
        ],
      },
      agentId: agentAlphaId,
      instructions,
    });
    webhookWorkflowId = await createWorkflow("P3 Webhook", {
      trigger: { type: "webhook" },
      agentId: agentAlphaId,
      instructions,
    });
    slackWorkflowId = await createWorkflow("P3 Slack", {
      trigger: { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
      agentId: agentAlphaId,
      instructions,
    });
    await publishWorkflow(manualWorkflowId);
    await publishWorkflow(formWorkflowId);
    await publishWorkflow(webhookWorkflowId);
    await publishWorkflow(slackWorkflowId);

    // Seed the Slack integration + point the Slack workflow's trigger at it
    // (the OAuth install flow is tested elsewhere; here we drive inbound
    // events directly). Publish created the trigger row; binding the team is
    // the user-managed step (PUT …/triggers/slack does the same).
    const metadata: SlackIntegrationMetadata = {
      teamName: "P3 Team",
      botUserId: SLACK_BOT_USER_ID,
      scopes: ["app_mentions:read", "chat:write"],
    };
    const integration = await upsertSlackIntegration(db, {
      organizationId: orgId,
      teamId: SLACK_TEAM_ID,
      credentialsEncrypted: encryptIntegrationCredentials(
        JSON.stringify({ botToken: SLACK_BOT_TOKEN }),
        parseMasterKey(MASTER_KEY_B64),
        "slack",
        SLACK_TEAM_ID,
      ),
      metadata,
    });
    const slackTrigger = await upsertTriggerType(db, slackWorkflowId, "slack");
    await setSlackBinding(db, slackTrigger.id, integration.id, {
      mentionOnly: true,
      includeDirectMessages: false,
    });

    // The onboarding kick fired a background publish (+ eve build) of the
    // seeded "General Purpose" agent at org creation. Await it so the suite
    // never exits with a build subprocess in flight (it runs concurrently
    // with the two agent builds above, so this is cheap by now).
    const seedVersionId = await until(
      async () => {
        const rows = await db
          .select({ publishedVersionId: schema.agents.publishedVersionId })
          .from(schema.agents)
          .where(and(eq(schema.agents.organizationId, orgId), eq(schema.agents.name, "General Purpose")));
        return rows[0]?.publishedVersionId ?? undefined;
      },
      "seed-agent publish kick",
      60_000,
    );
    const seedVersions = await db
      .select({ contentHash: schema.agentVersions.contentHash })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, seedVersionId));
    await awaitBuild(seedVersions[0]!.contentHash);
  }, 30 * 60_000);

  afterAll(async () => {
    await ticker?.stop();
    sweeper?.stop();
    for (const worker of [...workers]) {
      await stopWorker(worker, "SIGTERM").catch(() => {});
    }
    await reapLeftoverAgents();
    await stack?.close();
    stack?.app.stop?.();
    mcp?.stop();
    slack?.stop();
  }, 120_000);

  // ── 1. SPREAD ──────────────────────────────────────────────────────────────

  test(
    "runs spread across ≥2 workers (two agent hashes; affinity_worker_id spans both)",
    async () => {
      // Session 1 (agent Alpha) lands on whichever worker the cold scheduler picks.
      const s1 = await chat(agentAlphaId, "Reply with exactly: spread-1");
      const workerA = await until(
        async () => (await sessionAffinity(s1.session.id)) ?? undefined,
        "session 1 affinity",
      );
      await awaitRunStatus(s1.run.id, "succeeded");

      // Force session 2 (agent Beta — a DIFFERENT hash, so the single-writer
      // fence never contends) onto the OTHER worker: park worker A `draining`
      // so the scheduler (which only routes to LIVE workers) must pick the
      // other one. This is the exact rule graceful drain relies on. The
      // worker's own heartbeats never revive the status (the handler only
      // touches lastHeartbeatAt), so the toggle holds until we restore it.
      await db.update(schema.workers).set({ status: "draining" }).where(eq(schema.workers.id, workerA));
      let s2: CreateSessionResponse;
      try {
        s2 = await chat(agentBetaId, "Reply with exactly: spread-2");
      } finally {
        await db.update(schema.workers).set({ status: "live" }).where(eq(schema.workers.id, workerA));
      }
      const workerB = await until(
        async () => (await sessionAffinity(s2.session.id)) ?? undefined,
        "session 2 affinity",
      );
      await awaitRunStatus(s2.run.id, "succeeded");

      expect(workerB).not.toBe(workerA);
      const spanned = new Set([workerA, workerB]);
      expect(spanned.size).toBe(2);
      // Both are genuine, registered workers.
      const workerIds = new Set(workers.map((w) => w.id));
      expect(workerIds.has(workerA)).toBeTrue();
      expect(workerIds.has(workerB)).toBeTrue();
    },
    10 * 60_000,
  );

  // ── 2. TRIGGERS: manual "Run now" + form + webhook each start a run ─────────

  test(
    'manual "Run now" (POST /workflows/:wfId/run) dispatches the published snapshot',
    async () => {
      const res = await api("POST", `/workspaces/${orgId}/workflows/${manualWorkflowId}/run`, {
        body: { message: "Reply with exactly: manual-hello" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;
      // Workflow provenance + the rendered task message ride the rows.
      expect(body.session.workflowId).toBe(manualWorkflowId);
      expect(body.run.taskMessage).not.toBeNull();
      expect(body.run.taskMessage!).toContain("<workflow-task>");
      expect(body.run.taskMessage!).toContain("Reply with exactly: manual-hello");
      await awaitRunStatus(body.run.id, "succeeded");
      expect((await runMessages(body.run.id)).some((m) => m.includes("manual-hello"))).toBeTrue();
    },
    5 * 60_000,
  );

  test(
    "form trigger (POST /t/:token, form-bound workflow) starts a run",
    async () => {
      const mint = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${formWorkflowId}/triggers/webhook-token`,
      );
      expect(mint.status).toBe(201);
      const { token } = (await mint.json()) as CreateWebhookTokenResponse;

      const res = await fetch(`${baseUrl}/t/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { message: "Reply with exactly: form-hello", topic: "billing" } }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as TriggerIngressResponse;
      expect(body.accepted).toBeTrue();
      await awaitRunStatus(body.runId, "succeeded");
      expect((await runMessages(body.runId)).some((m) => m.includes("form-hello"))).toBeTrue();
      const session = await sessionRow(body.sessionId);
      expect(session).toMatchObject({ origin: "form", workflowId: formWorkflowId });
    },
    5 * 60_000,
  );

  test(
    "webhook trigger (POST /t/:token, raw JSON) starts a run",
    async () => {
      const mint = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${webhookWorkflowId}/triggers/webhook-token`,
      );
      expect(mint.status).toBe(201);
      const { token } = (await mint.json()) as CreateWebhookTokenResponse;

      const res = await fetch(`${baseUrl}/t/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Reply with exactly: webhook-hello" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as TriggerIngressResponse;
      expect(body.accepted).toBeTrue();
      await awaitRunStatus(body.runId, "succeeded");
      expect((await runMessages(body.runId)).some((m) => m.includes("webhook-hello"))).toBeTrue();
      const session = await sessionRow(body.sessionId);
      expect(session).toMatchObject({ origin: "webhook", workflowId: webhookWorkflowId });
    },
    5 * 60_000,
  );

  // ── 3. SLACK: mention → CONTROL-PLANE threaded reply; thread continues session ──

  test(
    "slack mention creates a session AND the control plane delivers a threaded reply (delivery_status ledger)",
    async () => {
      const mentionTs = `${Math.floor(Date.now() / 1000)}.000100`;
      const before = slack.posted.length;
      await postSlackEvent(
        {
          type: "app_mention",
          user: "UHUMAN",
          text: `<@${SLACK_BOT_USER_ID}> Reply with exactly: slack-hello`,
          ts: mentionTs,
          channel: SLACK_CHANNEL,
          team: SLACK_TEAM_ID,
        },
        "Ev-mention-1",
      );

      // The dispatch is async (Slack is acked fast). A session appears…
      const slackSession = await until(
        async () => {
          const rows = await db
            .select({ id: schema.agentSessions.id, continuationToken: schema.agentSessions.continuationToken })
            .from(schema.agentSessions)
            .where(
              and(
                eq(schema.agentSessions.workflowId, slackWorkflowId),
                eq(schema.agentSessions.origin, "slack"),
              ),
            );
          const ready = rows.find((r) => r.continuationToken);
          return ready ?? undefined;
        },
        "slack session with continuation token",
        4 * 60_000,
      );

      // …and the CONTROL PLANE posts a THREADED reply to the stub Slack API
      // off the run's terminal event. (Compiler v3 artifacts have no Slack
      // code path and never see a bot token — runs/delivery.ts owns this.)
      const reply = await until(
        async () => slack.posted.slice(before).find((m) => m.text.includes("slack-hello")) ?? undefined,
        "threaded chat.postMessage at the stub Slack API",
        4 * 60_000,
      );
      expect(reply.channel).toBe(SLACK_CHANNEL);
      expect(reply.threadTs).toBe(mentionTs); // threaded under the mention
      expect(reply.authorization).toBe(`Bearer ${SLACK_BOT_TOKEN}`);

      // The delivery LEDGER settles: slack-origin runs are born owing a reply
      // (pending at dispatch) and flip to `delivered` after the post.
      const mentionRun = await until(
        async () => {
          const rows = await db
            .select({ id: schema.runs.id, deliveryStatus: schema.runs.deliveryStatus })
            .from(schema.runs)
            .where(eq(schema.runs.agentSessionId, slackSession.id));
          return rows.find((r) => r.deliveryStatus === "delivered") ?? undefined;
        },
        "runs.delivery_status → delivered",
        60_000,
      );
      expect(mentionRun.deliveryStatus).toBe("delivered");
      // The task message (rendered instructions) is provenance on the run.
      const mentionRunRow = await runRow(mentionRun.id);
      expect(mentionRunRow!.taskMessage).not.toBeNull();
      expect(mentionRunRow!.taskMessage!).toContain("<workflow-task>");

      // ── follow-up in the SAME thread continues the SAME session ──
      // Wait for the mention's run to fully finish first: a thread reply that
      // lands while the first turn is still in flight is rejected 409
      // session_busy (one run per session) and dropped by the Slack router.
      await until(
        async () => {
          const rows = await db
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(eq(schema.runs.agentSessionId, slackSession.id));
          return rows.length > 0 && rows.every((r) => r.status === "succeeded" || r.status === "failed")
            ? true
            : undefined;
        },
        "mention run to finish before the thread reply",
        4 * 60_000,
      );
      const before2 = slack.posted.length;
      await postSlackEvent(
        {
          type: "message",
          user: "UHUMAN",
          text: "Reply with exactly: slack-followup",
          ts: `${Math.floor(Date.now() / 1000)}.000200`,
          thread_ts: mentionTs,
          channel: SLACK_CHANNEL,
          team: SLACK_TEAM_ID,
        },
        "Ev-thread-2",
      );

      const followReply = await until(
        async () => slack.posted.slice(before2).find((m) => m.text.includes("slack-followup")) ?? undefined,
        "threaded follow-up reply",
        4 * 60_000,
      );
      expect(followReply.threadTs).toBe(mentionTs);

      // Continuity: still exactly ONE slack session for this workflow, now
      // with TWO runs (same eve session id) — the thread reply rode eve's
      // native session continuation, no custom channel involved.
      const sessions = await db
        .select({ id: schema.agentSessions.id, eveSessionId: schema.agentSessions.eveSessionId })
        .from(schema.agentSessions)
        .where(
          and(
            eq(schema.agentSessions.workflowId, slackWorkflowId),
            eq(schema.agentSessions.origin, "slack"),
          ),
        );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe(slackSession.id);
      const runs = await db
        .select({ id: schema.runs.id, deliveryStatus: schema.runs.deliveryStatus })
        .from(schema.runs)
        .where(eq(schema.runs.agentSessionId, slackSession.id));
      expect(runs.length).toBe(2);
      // Both replies were control-plane-delivered.
      await until(
        async () => {
          const rows = await db
            .select({ deliveryStatus: schema.runs.deliveryStatus })
            .from(schema.runs)
            .where(eq(schema.runs.agentSessionId, slackSession.id));
          return rows.every((r) => r.deliveryStatus === "delivered") || undefined;
        },
        "both slack runs delivered",
        60_000,
      );
    },
    10 * 60_000,
  );

  // ── 4. SCHEDULE: a due next_fire_at fires through the control-plane ticker ──

  test(
    "schedule trigger: due next_fire_at → ticker claims + dispatches (origin schedule); cursor advances; disable disarms",
    async () => {
      // Created here (not beforeAll) so the live ticker cannot fire it on a
      // natural minute boundary during earlier proofs.
      const scheduleWorkflowId = await createWorkflow("P3 Schedule", {
        trigger: { type: "schedule", cron: "* * * * *" },
        agentId: agentAlphaId,
        // Schedules dispatch with an EMPTY ingress message — the instructions
        // themselves carry the task (mock fixture directive included).
        instructions: { markdown: "Reply with exactly: schedule-hello" },
      });
      try {
        const beforePublish = Date.now();
        await publishWorkflow(scheduleWorkflowId);

        // Publish synced the trigger row: cron + an armed next_fire_at cursor
        // (strictly after the publish instant — never a backfill).
        const armed = await triggerRowOf(scheduleWorkflowId);
        expect(armed).toMatchObject({ type: "schedule", cron: "* * * * *", enabled: true });
        expect(armed!.nextFireAt).not.toBeNull();
        expect(armed!.nextFireAt!.getTime()).toBeGreaterThan(beforePublish);

        // Make it DUE — the running ticker (SCHEDULE_TICK_MS=500) must claim
        // it under the advisory lock and dispatch through the ordinary path.
        const forcedDue = new Date(Date.now() - 1_000);
        await db
          .update(schema.triggers)
          .set({ nextFireAt: forcedDue })
          .where(eq(schema.triggers.id, armed!.id));

        const session = await until(
          async () => {
            const rows = await db
              .select()
              .from(schema.agentSessions)
              .where(eq(schema.agentSessions.workflowId, scheduleWorkflowId));
            return rows[0] ?? undefined;
          },
          "schedule-fired session",
          60_000,
        );
        expect(session.origin).toBe("schedule");
        expect(session.agentId).toBe(agentAlphaId);

        const run = await until(
          async () => {
            const rows = await db
              .select()
              .from(schema.runs)
              .where(eq(schema.runs.agentSessionId, session.id));
            return rows[0] ?? undefined;
          },
          "schedule-fired run",
          30_000,
        );
        await awaitRunStatus(run.id, "succeeded", 4 * 60_000);
        expect((await runMessages(run.id)).some((m) => m.includes("schedule-hello"))).toBeTrue();

        // The rendered task message carried the instructions; the provenance
        // envelope carries the fired window.
        const fired = await runRow(run.id);
        expect(fired!.taskMessage).not.toBeNull();
        expect(fired!.taskMessage!).toContain("<workflow-task>");
        expect(fired!.taskMessage!).toContain("Reply with exactly: schedule-hello");
        const event = fired!.triggerEvent as { triggerType?: string; data?: { scheduledFor?: unknown } };
        expect(event.triggerType).toBe("schedule");
        expect(typeof event.data?.scheduledFor).toBe("string");

        // Cursor advanced BEFORE dispatch (no backfill): strictly after the
        // forced-due time, into the future relative to the claim.
        const advanced = await triggerRowOf(scheduleWorkflowId);
        expect(advanced!.nextFireAt).not.toBeNull();
        expect(advanced!.nextFireAt!.getTime()).toBeGreaterThan(forcedDue.getTime());
      } finally {
        // Disarm: the master switch clears next_fire_at so the live ticker
        // cannot re-fire this workflow during the remaining proofs.
        const disabled = await api(
          "PATCH",
          `/workspaces/${orgId}/workflows/${scheduleWorkflowId}`,
          { body: { enabled: false } },
        );
        expect(disabled.status).toBe(200);
      }
      const disarmed = await triggerRowOf(scheduleWorkflowId);
      expect(disarmed!.enabled).toBeFalse();
      expect(disarmed!.nextFireAt).toBeNull();
    },
    8 * 60_000,
  );

  // ── 5. HITL: ask_question parks → POST /runs/:id/input resumes ──────────────

  test(
    "an approval-gated tool pauses the run (waiting) → resolve via /runs/:id/input → completes",
    async () => {
      const { runId } = await parkApprovalRun("hitl");
      const requestId = await until(
        async () => (await pendingRequestId(runId)) ?? undefined,
        "input.requested requestId",
      );
      const resolve = await api("POST", `/runs/${runId}/input`, {
        body: { requestId, optionId: "approve" },
      });
      expect(resolve.status).toBe(200);
      await awaitRunStatus(runId, "succeeded");
    },
    8 * 60_000,
  );

  /**
   * Start a chat run (agent Alpha) that calls eve's built-in `ask_question`
   * tool — the mock model invokes it directly (top-level framework tool),
   * which surfaces `input.requested` and parks the run `waiting`. Returns
   * once the run is parked. Used by HITL and FAILOVER.
   */
  async function parkApprovalRun(marker: string): Promise<{ sessionId: string; runId: string }> {
    const body = await chat(
      agentAlphaId,
      `Use the ask_question tool to ask me to approve step ${marker}. ` +
        `Offer one option with id: "approve", label: "Approve".`,
    );
    await awaitRunStatus(body.run.id, "waiting", 4 * 60_000);
    return { sessionId: body.session.id, runId: body.run.id };
  }

  // ── 6. FAILOVER: park on A → SIGKILL A → resume on B → finish ───────────────

  test(
    "parked run survives SIGKILL of its worker and resumes on another worker",
    async () => {
      const { sessionId, runId } = await parkApprovalRun("failover");
      const homeWorkerId = await until(
        async () => (await sessionAffinity(sessionId)) ?? undefined,
        "parked session affinity",
      );
      const homeWorker = workers.find((w) => w.id === homeWorkerId);
      expect(homeWorker).toBeDefined();
      const requestId = await until(
        async () => (await pendingRequestId(runId)) ?? undefined,
        "input.requested requestId (pre-kill)",
      );

      // Hard-kill the home worker. Its heartbeats stop; the sweeper marks it
      // dead and CLEARS the parked session's affinity so it can reschedule.
      await stopWorker(homeWorker!, "SIGKILL");
      await until(
        async () => {
          const rows = await db
            .select({ status: schema.workers.status })
            .from(schema.workers)
            .where(eq(schema.workers.id, homeWorkerId));
          return rows[0]?.status === "dead" || undefined;
        },
        "sweeper marks the killed worker dead",
        30_000,
      );
      await until(
        async () => ((await sessionAffinity(sessionId)) === null ? true : undefined),
        "sweeper clears the parked session's affinity",
        30_000,
      );

      // Answer the parked approval — it reschedules onto a surviving LIVE worker
      // and the durable eve turn resumes there (world state lives in Postgres).
      const resolve = await api("POST", `/runs/${runId}/input`, {
        body: { requestId, optionId: "approve" },
      });
      expect(resolve.status).toBe(200);
      await awaitRunStatus(runId, "succeeded", 4 * 60_000);

      // It resumed on a DIFFERENT worker than the one we killed.
      const resumedWorker = await sessionAffinity(sessionId);
      expect(resumedWorker).not.toBe(homeWorkerId);
      expect(workers.some((w) => w.id === resumedWorker)).toBeTrue();

      // Restore the fleet to two live workers for the drain proof.
      await spawnWorker();
    },
    12 * 60_000,
  );

  // ── 7. DRAIN: SIGTERM a worker mid-idle → reroute + clean exit 0 ────────────

  test(
    "SIGTERM drains a worker cleanly (exit 0); new sessions route to the survivor",
    async () => {
      expect(workers.length).toBeGreaterThanOrEqual(2);
      // Load an agent on the worker we will drain (idle, but warm).
      const warmBody = await chat(agentAlphaId, "Reply with exactly: drain-warmup");
      const drainWorkerId = await until(
        async () => (await sessionAffinity(warmBody.session.id)) ?? undefined,
        "warmup session affinity",
      );
      await awaitRunStatus(warmBody.run.id, "succeeded");
      const drainWorker = workers.find((w) => w.id === drainWorkerId)!;

      // SIGTERM mid-idle → drain (finish in-flight, stop agents, deregister) → exit 0.
      const exitCode = await stopWorker(drainWorker, "SIGTERM");
      expect(exitCode).toBe(0);
      await until(
        async () => {
          const rows = await db
            .select({ status: schema.workers.status })
            .from(schema.workers)
            .where(eq(schema.workers.id, drainWorkerId));
          return rows[0]?.status === "dead" || rows.length === 0 || undefined;
        },
        "drained worker deregistered",
        30_000,
      );

      // New sessions route to the surviving worker.
      const afterBody = await chat(agentAlphaId, "Reply with exactly: drain-reroute");
      const rerouted = await until(
        async () => (await sessionAffinity(afterBody.session.id)) ?? undefined,
        "rerouted session affinity",
      );
      expect(rerouted).not.toBe(drainWorkerId);
      expect(workers.some((w) => w.id === rerouted)).toBeTrue();
      await awaitRunStatus(afterBody.run.id, "succeeded");
    },
    8 * 60_000,
  );
});
