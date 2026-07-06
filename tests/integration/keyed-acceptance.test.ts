/**
 * KEYED ACCEPTANCE — the full product path with the mock model OFF: a REAL
 * OpenRouter key flows control-plane → agent env → @openrouter/ai-sdk-provider
 * and real deepseek/deepseek-v4-flash turns serve the runs. This is the suite
 * that watches the ai@7 ↔ @openrouter/ai-sdk-provider@6.0.0-alpha.1 pairing
 * (packages/compiler/versions.json) under real API traffic.
 *
 * Proves (same spine as tests/integration/phase1-acceptance.test.ts, but with
 * NO EVE_MOCK_AUTHORED_MODELS and NO dead-port OPENROUTER_BASE_URL override):
 *   1. publish → real compile + eve build → tarball in MinIO (quick preset →
 *      deepseek/deepseek-v4-flash).
 *   2. create session "ping" → the run streams REAL model tokens
 *      (message.appended deltas over SSE), completes, and the final
 *      message.completed contains "pong".
 *   3. a follow-up asking for the random codeword planted in the first
 *      message returns it — real continuation memory. (The mock model cannot
 *      answer this: it only honors "Reply with exactly:" fixtures, so a
 *      correct recall also proves the mock is NOT serving the turns.)
 *   4. HITL with the real model: an approval-gated MCP tool
 *      (approval_policy {default:"always"}) parks the run `waiting` with an
 *      input.requested approve/deny; POST /runs/:id/input approves; the tool
 *      executes against the stub MCP server and the run completes.
 *   5. provider API errors are VISIBLE, not silent: a run against a
 *      nonexistent OpenRouter model id (the same surface auth/rate-limit
 *      errors use — an HTTP error from the provider) lands as run.status
 *      "failed" with a populated error, turn.failed in run_events, and a
 *      failed run_status frame on the SSE stream.
 *
 * COST DISCIPLINE: everything runs on deepseek/deepseek-v4-flash (quick
 * preset) with reasoning "low" and one-line prompts; a full green run is a
 * handful of tiny completions.
 *
 * Gated on KEYED=1 + OPENROUTER_API_KEY + TEST_DATABASE_URL (+ mise + docker)
 * so CI can never run it accidentally. Infra (unique compose project):
 *
 *   POSTGRES_PORT=5446 MINIO_PORT=9006 docker compose -p pkeyed up -d --wait postgres minio minio-init
 *   KEYED=1 OPENROUTER_API_KEY=... S3_ENDPOINT=http://localhost:9006 \
 *     TEST_DATABASE_URL=postgres://dev:dev@localhost:5446/product \
 *     bun test tests/integration/keyed-acceptance.test.ts
 *   docker compose -p pkeyed down -v
 *
 * NEVER log or snapshot process.env.OPENROUTER_API_KEY anywhere in this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { SQL } from "bun";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  encryptSecret,
  isRunStreamTerminalStatus,
  parseMasterKey,
  generateMasterKeyBase64,
  type CreateSessionResponse,
  type EveInputRequestedEvent,
  type PostMessageResponse,
  type PublishWorkflowResponse,
  type RunEventFrame,
  type RunStatusFrame,
  type WorkflowDefinitionInput,
} from "@invisible-string/shared";

import { createAppStack, type AppStack } from "../../apps/control-plane/src/index";
import { runMigrations } from "../../apps/control-plane/src/migrate";
import { mcpAuthAadContext } from "../../apps/control-plane/src/runtime/agent-env";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const MASTER_KEY_B64 = generateMasterKeyBase64();
const PLATFORM_JWT_SECRET = "keyed-platform-jwt-secret-0000000";
const WORKER_SHARED_SECRET = "keyed-worker-shared-secret-000000";

/** Canonical agent root — MUST be identical for build service and worker. */
const AGENT_ROOT =
  process.env.KEYED_AGENT_ROOT ?? "/tmp/invisible-string-keyed-agents";
const NPM_CACHE_DIR = process.env.NPM_CACHE_DIR ?? join(homedir(), ".npm");

const GATE_PROBLEMS: string[] = [];
if (process.env.KEYED !== "1") GATE_PROBLEMS.push("KEYED != 1 (explicit opt-in required — real API spend)");
if (!process.env.OPENROUTER_API_KEY) GATE_PROBLEMS.push("OPENROUTER_API_KEY not set");
if (!TEST_DATABASE_URL) GATE_PROBLEMS.push("TEST_DATABASE_URL not set");
if (Bun.which("mise") === null) GATE_PROBLEMS.push("mise not on PATH (eve builds need Node 24)");
if (Bun.which("docker") === null) GATE_PROBLEMS.push("docker not on PATH");
const GATE = GATE_PROBLEMS.length === 0;
if (!GATE) {
  console.warn(`[keyed-acceptance] skipped: ${GATE_PROBLEMS.join("; ")}`);
}

// ── infra (compose on demand, unique project: pkeyed) ───────────────────────

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
  const minioUp = await tcpReachable(`${S3_ENDPOINT}/minio/health/live`);
  if (pgUp && minioUp) return;
  const pgPort = new URL(TEST_DATABASE_URL!).port || "5432";
  const minioPort = new URL(S3_ENDPOINT).port || "9000";
  const services = [...(pgUp ? [] : ["postgres"]), ...(minioUp ? [] : ["minio"])];
  const composeEnv = {
    ...process.env,
    POSTGRES_PORT: pgPort,
    MINIO_PORT: minioPort,
    MINIO_CONSOLE_PORT: String(Number(minioPort) + 1),
  };
  const compose = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["docker", "compose", "-p", "pkeyed", ...args], {
      cwd: REPO_ROOT,
      env: composeEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  };
  const upCode = await compose("up", "-d", "--wait", ...services);
  if (upCode !== 0) throw new Error(`docker compose up failed (${upCode})`);
  if (!minioUp) {
    // Foreground one-shot: `compose wait` races a fast init container (Compose
    // ≥ v5 only sees running containers — an exited one-shot is "no containers").
    const initCode = await compose("run", "--rm", "minio-init");
    if (initCode !== 0) throw new Error(`minio-init failed (${initCode})`);
  }
}

/** The world SERVER maintenance database (compose init creates it; ensure). */
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

/** Own product database, dropped + recreated per run (isolation from the
 *  other gated suites sharing the Postgres server). */
async function ensureFreshProductDatabase(): Promise<string> {
  const name = "keyed_product";
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

/** `<mise install dir for node@24>/bin` pinned on the worker's PATH. */
function resolveNode24Bin(): string | null {
  const result = spawnSync("mise", ["where", "node@24"], { encoding: "utf8" });
  const dir = result.status === 0 ? result.stdout.trim() : "";
  return dir ? `${dir}/bin` : null;
}

// ── local stub MCP server (streamable HTTP, JSON-RPC) ───────────────────────
// Unlike the mock-model suites, the REAL model actually calls the tool after
// approval, so tools/call must answer with a well-formed MCP result.

function startStubMcp(): {
  url: string;
  requests: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  stop(): void;
} {
  const requests: string[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as {
        id?: number | string;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      requests.push(body.method ?? "unknown");
      let result: unknown = {};
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-notes", version: "1.0.0" },
        };
      } else if (body.method === "tools/list") {
        result = {
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
        };
      } else if (body.method === "tools/call") {
        toolCalls.push({
          name: body.params?.name ?? "unknown",
          args: body.params?.arguments ?? {},
        });
        result = {
          content: [{ type: "text", text: "note saved" }],
          isError: false,
        };
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    toolCalls,
    stop: () => server.stop(true),
  };
}

// ── SSE reading (same framing as phase1-acceptance) ─────────────────────────

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
  const frames: SseFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
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
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("id: ")) id = line.slice(4).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: JSON.parse(dataLines.join("\n")) };
}

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

describe.skipIf(!GATE)("keyed acceptance — real model through the full stack", () => {
  const mcp = GATE ? startStubMcp() : null!;
  const node24Bin = GATE ? resolveNode24Bin() : null;

  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  let baseUrl: string;
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  let workerId: string;

  let cookie: string;
  let orgId: string;
  let agentPresetId: string;
  let connectionId: string;

  let pongWorkflowId: string;
  let hitlWorkflowId: string;
  let errorWorkflowId: string;

  let sessionId: string;
  let eveSessionId: string;
  let firstRunId: string;
  /** Random per-run codeword planted in the first message; the follow-up
   *  must recall it — impossible without real session memory (and immune to
   *  the platform context block eve's channel folds into each message). */
  const codeword = `zx-${randomUUID().slice(0, 8)}`;

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

  async function createWorkflow(name: string, definition: WorkflowDefinitionInput): Promise<string> {
    const res = await api("POST", `/workspaces/${orgId}/workflows`, {
      body: { name, draft: definition },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workflow: { id: string } };
    return body.workflow.id;
  }

  /** Publish, wait for the REAL eve build, then delete the build dir so the
   *  worker must boot from the MinIO tarball. */
  async function publishAndBuild(workflowId: string): Promise<PublishWorkflowResponse> {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishWorkflowResponse;
    await stack.runtime!.buildService.waitFor(body.contentHash);
    await until(
      async () => {
        const row = await stack.runtime!.buildStore.get(body.contentHash);
        if (row?.status === "failed") throw new Error(`build failed:\n${row.errorLog ?? "(no log)"}`);
        return row?.status === "succeeded" || undefined;
      },
      `build of ${body.contentHash.slice(0, 12)}`,
      15 * 60_000,
      1_000,
    );
    rmSync(join(AGENT_ROOT, body.contentHash), { recursive: true, force: true });
    return body;
  }

  async function runRow(runId: string): Promise<{ status: string; error: string | null } | undefined> {
    const rows = await db
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    return rows[0];
  }

  /** Poll a run to `want`; `failed` (when not wanted) throws with the error. */
  async function awaitRunStatus(runId: string, want: string, timeoutMs = 4 * 60_000): Promise<void> {
    await until(
      async () => {
        const row = await runRow(runId);
        if (row?.status === "failed" && want !== "failed") {
          throw new Error(`run failed: ${row.error ?? "(no error)"}`);
        }
        return row?.status === want || undefined;
      },
      `run ${runId.slice(0, 8)} → ${want}`,
      timeoutMs,
    );
  }

  async function runEvents(runId: string): Promise<{ type: string; data?: Record<string, unknown> }[]> {
    const rows = await db
      .select({ event: schema.runEvents.event })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.seq);
    return rows.map((r) => r.event as { type: string; data?: Record<string, unknown> });
  }

  function completedMessages(events: { type: string; data?: Record<string, unknown> }[]): string[] {
    return events
      .filter((e) => e.type === "message.completed")
      .map((e) => (e.data?.message as string | null) ?? "");
  }

  beforeAll(async () => {
    await ensureInfra();
    const worldDatabaseUrl = await ensureWorldDatabase();
    const productDatabaseUrl = await ensureFreshProductDatabase();
    await runMigrations(productDatabaseUrl);
    // Fresh product DB ⇒ fresh builds. The content hash covers the COMPILED
    // SOURCE, not the build environment, so a stale extracted artifact from
    // an earlier run of the same source (e.g. built before a build-env
    // change) must not be reused by the worker cache.
    rmSync(AGENT_ROOT, { recursive: true, force: true });
    mkdirSync(AGENT_ROOT, { recursive: true });
    await reapLeftoverAgents();

    // ── control plane: real key, mock OFF, no base-URL override ────────────
    const controlPort = await freePort();
    baseUrl = `http://localhost:${controlPort}`;
    stack = createAppStack({
      DATABASE_URL: productDatabaseUrl,
      BETTER_AUTH_SECRET: "keyed-better-auth-secret-012345678",
      BETTER_AUTH_URL: baseUrl,
      ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
      WORLD_DATABASE_URL: worldDatabaseUrl,
      PLATFORM_JWT_SECRET,
      WORKER_SHARED_SECRET,
      S3_ENDPOINT,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "dev",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "devdevdev",
      S3_BUCKET: process.env.S3_BUCKET ?? "artifacts",
      // THE POINT OF THIS SUITE: the real key, no EVE_MOCK_AUTHORED_MODELS,
      // no OPENROUTER_BASE_URL — agents talk to the real OpenRouter API.
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
      ALLOW_INSECURE_WORKER_TRANSPORT: "1",
      AGENT_BUILD_ROOT: AGENT_ROOT,
      NPM_CACHE_DIR,
      SSE_HEARTBEAT_MS: "500",
    });
    expect(stack.runtime).not.toBeNull();
    // Belt and braces: the runtime must NOT be in mock-model mode.
    expect(stack.runtime!.runtime.mockAuthoredModels).toBeFalse();
    db = stack.dbHandle.db;
    stack.app.listen(controlPort);

    // ── one REAL worker (Node 24 pinned for agent boots) ───────────────────
    workerId = randomUUID();
    const workerPort = await freePort();
    worker = Bun.spawn(["bun", "apps/worker/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: node24Bin ? `${node24Bin}:${process.env.PATH ?? ""}` : process.env.PATH,
        CONTROL_PLANE_URL: baseUrl,
        WORKER_SHARED_SECRET,
        WORKER_ID: workerId,
        PORT: String(workerPort),
        PUBLIC_URL: `http://localhost:${workerPort}`,
        ARTIFACT_CACHE_DIR: AGENT_ROOT,
        HEARTBEAT_INTERVAL_MS: "1000",
        AGENT_READY_TIMEOUT_MS: "120000",
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    await until(
      async () => {
        const rows = await db
          .select({ status: schema.workers.status })
          .from(schema.workers)
          .where(eq(schema.workers.id, workerId));
        return rows[0]?.status === "live" || undefined;
      },
      "worker registration",
      30_000,
    );

    // ── workspace: user + org + seeds ──────────────────────────────────────
    const email = `keyed-${randomUUID()}@example.com`;
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Keyed Acceptance" }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const authHeaders = new Headers({ cookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: "Keyed Acceptance ws", slug: `keyed-${randomUUID().slice(0, 8)}` },
      headers: authHeaders,
    });
    orgId = org!.id;
    await stack.auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: authHeaders,
    });
    await seedWorkspace(db, orgId);

    const agents = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, orgId));
    agentPresetId = agents[0]!.id;

    // Approval-gated MCP connection → the stub server (HITL workflow).
    const conn = await db
      .insert(schema.mcpConnections)
      .values({
        scope: "workspace",
        organizationId: orgId,
        name: "notes",
        source: "custom",
        url: mcp.url,
        approvalPolicy: { default: "always" },
      })
      .returning({ id: schema.mcpConnections.id });
    connectionId = conn[0]!.id;
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

    // quick preset → deepseek/deepseek-v4-flash (packages/db seed); reasoning
    // low keeps the (reasoning) model's token spend minimal.
    const agent = { agentPresetId, modelPreset: "quick" as const, reasoning: "low" as const };

    pongWorkflowId = await createWorkflow("Keyed Pong", {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [], skillIds: [] },
      agent,
      instructions: {
        markdown:
          'When the user says "ping", reply with exactly: pong\n' +
          "For any other message, answer it directly and truthfully in as few words as possible.",
      },
    });
    hitlWorkflowId = await createWorkflow("Keyed HITL", {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [connectionId], skillIds: [] },
      agent,
      instructions: {
        markdown:
          "When asked to save a note, call the save_note tool on @notes with the exact text requested. " +
          "Never ask clarifying questions. After the tool succeeds, reply with exactly: saved",
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (worker) {
      worker.kill("SIGTERM");
      const timer = setTimeout(() => worker?.kill("SIGKILL"), 40_000);
      await worker.exited.catch(() => {});
      clearTimeout(timer);
    }
    await reapLeftoverAgents();
    await stack?.close();
    stack?.app.stop?.();
    mcp?.stop();
  }, 90_000);

  test(
    "publish (quick preset → deepseek/deepseek-v4-flash) → real eve build → tarball in MinIO",
    async () => {
      const body = await publishAndBuild(pongWorkflowId);
      expect(body.contentHash).toHaveLength(64);

      const artifactUrl = stack.runtime!.artifacts.presignGetUrl(
        `artifacts/${body.contentHash}.tar.gz`,
      );
      const head = await fetch(artifactUrl);
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBeGreaterThan(100_000);

      const versions = await db
        .select()
        .from(schema.workflowVersions)
        .where(eq(schema.workflowVersions.id, body.versionId));
      expect(versions[0]).toMatchObject({
        contentHash: body.contentHash,
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash",
        buildStatus: "succeeded",
      });
    },
    15 * 60_000,
  );

  test(
    '"ping" → REAL model tokens stream (message.appended deltas over SSE) and the reply is "pong"',
    async () => {
      const res = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${pongWorkflowId}/sessions`,
        { body: { message: `ping (remember this codeword: ${codeword})` } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;
      sessionId = body.session.id;
      firstRunId = body.run.id;
      eveSessionId = body.session.eveSessionId!;
      expect(eveSessionId).toBeTruthy();

      // Live SSE tail to the TERMINAL run_status frame (the stream opens
      // with a snapshot run_status frame — "running" is not the end).
      const frames = await readSse(await api("GET", `/runs/${firstRunId}/stream`), {
        until: (frame) =>
          frame.event === "run_status" &&
          isRunStreamTerminalStatus((frame.data as RunStatusFrame).status),
        timeoutMs: 4 * 60_000,
      });
      const terminal = frames.at(-1)!.data as RunStatusFrame;
      expect(terminal.status).toBe("succeeded");

      const streamed = frames
        .filter((f) => f.event === "run_event")
        .map((f) => (f.data as RunEventFrame).event);
      const types = streamed.map((e) => e.type);
      expect(types[0]).toBe("session.started");
      expect(types).toContain("turn.started");
      expect(types.at(-1)).toBe("session.waiting");

      // REAL token streaming: incremental message.appended deltas whose
      // concatenation is the final assistant message.
      const deltas = streamed
        .filter((e) => e.type === "message.appended")
        .map((e) => (e as { data: { messageDelta: string } }).data.messageDelta);
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("").toLowerCase()).toContain("pong");

      const completed = completedMessages(
        streamed as { type: string; data?: Record<string, unknown> }[],
      );
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.at(-1)!.toLowerCase()).toContain("pong");
    },
    5 * 60_000,
  );

  test(
    "follow-up recalls the first message's codeword — real continuation memory (mock cannot answer this)",
    async () => {
      const res = await api("POST", `/sessions/${sessionId}/messages`, {
        body: {
          message:
            "What was the codeword I included in my first message? Reply with just the codeword.",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as PostMessageResponse;
      expect(body.run.id).not.toBe(firstRunId);
      await awaitRunStatus(body.run.id, "succeeded");

      // Same durable eve session, no second session.started.
      const sessions = await db
        .select({ eveSessionId: schema.agentSessions.eveSessionId })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, sessionId));
      expect(sessions[0]!.eveSessionId).toBe(eveSessionId);
      const events = await runEvents(body.run.id);
      expect(events.map((e) => e.type)).not.toContain("session.started");

      // Semantic recall across turns: only a real model with the session
      // transcript can reproduce the random codeword (the mock replies with
      // fixture text and has no memory of it).
      const completed = completedMessages(events);
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.at(-1)!.toLowerCase()).toContain(codeword);
    },
    5 * 60_000,
  );

  test(
    "HITL: approval-gated MCP tool parks the run; POST /runs/:id/input approves; tool executes; run completes",
    async () => {
      await publishAndBuild(hitlWorkflowId);

      const res = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${hitlWorkflowId}/sessions`,
        { body: { message: "Save a note with the exact text: keyed-hitl-proof" } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;

      // The REAL model must decide to call notes__save_note; the approval
      // policy parks the run `waiting` with an approve/deny input request.
      await awaitRunStatus(body.run.id, "waiting");
      const parked = await runEvents(body.run.id);
      const inputRequested = parked.find((e) => e.type === "input.requested") as
        | EveInputRequestedEvent
        | undefined;
      expect(inputRequested).toBeDefined();
      const request = inputRequested!.data.requests[0]!;
      expect(request.action.toolName).toContain("save_note");
      const optionIds = (request.options ?? []).map((o) => o.id);
      expect(optionIds).toContain("approve");

      // Approve through the product API.
      const resolve = await api("POST", `/runs/${body.run.id}/input`, {
        body: { requestId: request.requestId, optionId: "approve" },
      });
      expect(resolve.status).toBe(200);
      await awaitRunStatus(body.run.id, "succeeded");

      // The tool REALLY executed against the stub MCP server…
      expect(mcp.requests).toContain("tools/call");
      expect(
        mcp.toolCalls.some(
          (c) => c.name === "save_note" && JSON.stringify(c.args).includes("keyed-hitl-proof"),
        ),
      ).toBeTrue();
      // …and the run saw the completed action.
      const events = await runEvents(body.run.id);
      const actionResults = events.filter((e) => e.type === "action.result");
      expect(actionResults.length).toBeGreaterThan(0);
      expect(actionResults.some((e) => (e.data as { status?: string }).status === "completed")).toBeTrue();
    },
    20 * 60_000,
  );

  test(
    "provider API errors surface as a FAILED run with turn.failed + SSE error (never silent)",
    async () => {
      // A model id that eve's AI-Gateway catalog KNOWS (so `eve build`
      // passes — ids missing from the catalog fail the build with a
      // compaction-metadata error) but that OpenRouter REJECTS (400 "not a
      // valid model ID"; OpenRouter's slug is x-ai/…). The runtime call then
      // fails with a real provider HTTP error — the exact surface OpenRouter
      // auth (401) and rate-limit (429) failures use. Allowlist it so
      // publish-time validation passes.
      const bogusModelId = "xai/grok-4.1-fast-reasoning";
      await db.insert(schema.modelAllowlist).values({
        organizationId: orgId,
        provider: "openrouter",
        modelId: bogusModelId,
        enabled: true,
      });
      errorWorkflowId = await createWorkflow("Keyed Error Surface", {
        trigger: { type: "manual" },
        context: { mcpConnectionIds: [], skillIds: [] },
        agent: { agentPresetId, modelId: bogusModelId },
        instructions: { markdown: "Reply with exactly: unreachable" },
      });
      await publishAndBuild(errorWorkflowId);

      const res = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${errorWorkflowId}/sessions`,
        { body: { message: "ping" } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;

      // VISIBLE failure: run → failed with a populated error…
      await awaitRunStatus(body.run.id, "failed", 5 * 60_000);
      const row = await runRow(body.run.id);
      expect(row!.error).toBeTruthy();
      expect(row!.error!.length).toBeGreaterThan(0);

      // …turn.failed (and the step.failed that caused it) in run_events…
      const events = await runEvents(body.run.id);
      const types = events.map((e) => e.type);
      expect(types).toContain("turn.failed");
      expect(types).toContain("step.failed");

      // …and the SSE stream replays the failure, terminal frame included.
      const frames = await readSse(await api("GET", `/runs/${body.run.id}/stream`), {
        until: (frame) =>
          frame.event === "run_status" &&
          isRunStreamTerminalStatus((frame.data as RunStatusFrame).status),
      });
      const terminal = frames.at(-1)!.data as RunStatusFrame;
      expect(terminal.status).toBe("failed");
      expect(terminal.error).toBeTruthy();
      const streamedTypes = frames
        .filter((f) => f.event === "run_event")
        .map((f) => (f.data as RunEventFrame).event.type);
      expect(streamedTypes).toContain("turn.failed");
    },
    20 * 60_000,
  );
});
