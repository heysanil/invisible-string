/**
 * PHASE-1 ACCEPTANCE (docs/PLAN.md Phase 1 §Acceptance) — the full spine,
 * nothing faked between the REST API and a REAL compiled eve agent:
 *
 *   REST-create workflow (manual trigger, 1 MCP connection → local stub MCP
 *   server, 1 authored skill, balanced preset)
 *   → publish → REAL @invisible-string/compiler compile → mise-node24
 *     npm install → `eve build` → tar.gz → MinIO
 *   → create session with a message (eve's mock-model harness — the spike's
 *     EVE_MOCK_AUTHORED_MODELS pattern; "Reply with exactly: X" fixtures)
 *   → real eve NDJSON events (session/turn/step/message.*) land in
 *     run_events and stream over SSE (incl. a Last-Event-ID resume)
 *   → follow-up message continues the SAME eve session (event continuity:
 *     same eve session id, no second session.started)
 *   → republish with changed instructions → NEW session uses the new
 *     version hash, the OLD session stays pinned to the old one.
 *
 * Gated on TEST_DATABASE_URL (+ mise + docker). Infra: the docker-compose
 * postgres/minio/dex services — brought up on demand when unreachable:
 *
 *   POSTGRES_PORT=5443 docker compose -p p1acceptance up -d --wait postgres minio minio-init dex
 *   TEST_DATABASE_URL=postgres://dev:dev@localhost:5443/product bun test tests/integration/phase1-acceptance.test.ts
 *
 * The first run cold-installs the generated agent's npm deps (minutes);
 * NPM_CACHE_DIR (default ~/.npm) keeps reruns warm. Artifact relocation is
 * proven honestly: the build directory is DELETED after each build, so the
 * worker must pull the tarball from MinIO and boot `.output` alone (eve
 * bundles its compiled artifacts into the server bundle; REPORT finding 13's
 * baked appRoot is a fallback path that production never consults).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { SQL } from "bun";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  encryptSecret,
  parseMasterKey,
  generateMasterKeyBase64,
  type CreateSessionResponse,
  type GetSessionResponse,
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
const PLATFORM_JWT_SECRET = "p1a-platform-jwt-secret-000000000";
const WORKER_SHARED_SECRET = "p1a-worker-shared-secret-00000000";

/** Canonical agent root — MUST be identical for build service and worker. */
const AGENT_ROOT =
  process.env.PHASE1_AGENT_ROOT ?? "/tmp/invisible-string-p1-agents";
/** Warm npm cache (spike + CI actions/cache both land here by default). */
const NPM_CACHE_DIR = process.env.NPM_CACHE_DIR ?? join(homedir(), ".npm");

const GATE_PROBLEMS: string[] = [];
if (!TEST_DATABASE_URL) GATE_PROBLEMS.push("TEST_DATABASE_URL not set");
if (Bun.which("mise") === null) GATE_PROBLEMS.push("mise not on PATH (eve builds need Node 24)");
if (Bun.which("docker") === null) GATE_PROBLEMS.push("docker not on PATH");
const GATE = GATE_PROBLEMS.length === 0;
if (!GATE) {
  console.warn(`[phase1-acceptance] skipped: ${GATE_PROBLEMS.join("; ")}`);
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
  const minioUp = await tcpReachable(`${S3_ENDPOINT}/minio/health/live`);
  if (pgUp && minioUp) return;

  const pgPort = new URL(TEST_DATABASE_URL!).port || "5432";
  const minioPort = new URL(S3_ENDPOINT).port || "9000";
  // Only start what is missing — a postgres/minio already serving the
  // configured port (dev compose, spike project, CI service) must not be
  // double-bound by a second compose project.
  const services = [
    ...(pgUp ? [] : ["postgres"]),
    ...(minioUp ? [] : ["minio"]),
    "dex",
  ];
  console.log(
    `[phase1-acceptance] infra not reachable (pg=${pgUp} minio=${minioUp}) — docker compose up ${services.join(" ")} (pg:${pgPort} minio:${minioPort})`,
  );
  const composeEnv = {
    ...process.env,
    POSTGRES_PORT: pgPort,
    MINIO_PORT: minioPort,
    MINIO_CONSOLE_PORT: String(Number(minioPort) + 1),
    DEX_PORT: process.env.DEX_PORT ?? "5556",
  };
  const compose = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["docker", "compose", "-p", "p1acceptance", ...args], {
      cwd: REPO_ROOT,
      env: composeEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  };
  // `--wait` only for long-running services; minio-init is a one-shot job
  // (creates the artifacts bucket, exits 0) which `--wait` misreads as a
  // failure — run it separately and wait on its exit code.
  const upCode = await compose("up", "-d", "--wait", ...services);
  if (upCode !== 0) throw new Error(`docker compose up failed (${upCode})`);
  if (!minioUp) {
    const initUp = await compose("up", "-d", "minio-init");
    if (initUp !== 0) throw new Error(`docker compose up minio-init failed (${initUp})`);
    const initCode = await compose("wait", "minio-init");
    if (initCode !== 0) throw new Error(`minio-init failed (${initCode})`);
  }
}

/** The world SERVER maintenance database (compose init creates it; ensure). */
async function ensureWorldDatabase(): Promise<string> {
  const worldUrl = new URL(TEST_DATABASE_URL!);
  worldUrl.pathname = "/world";
  const admin = new SQL(TEST_DATABASE_URL!, { max: 1 });
  try {
    const rows = (await admin`
      select 1 as one from pg_database where datname = 'world'
    `) as unknown[];
    if (rows.length === 0) await admin.unsafe(`create database "world"`);
  } finally {
    await admin.close();
  }
  return worldUrl.toString();
}

/**
 * The acceptance stack gets its OWN product database (dropped + recreated
 * per run). Sharing TEST_DATABASE_URL's database with the other gated
 * suites is not safe in one `bun test` run: this suite registers a REAL
 * live worker row and full Better Auth state, which the runtime-integration
 * suite's scheduler/auth assertions would then observe (e.g. its
 * "no live worker" 503 becomes a 502 against our leftover worker).
 */
async function ensureFreshProductDatabase(): Promise<string> {
  const name = "p1a_product";
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

/**
 * Kill any agent process left over from a previous (crashed/killed) run —
 * matched strictly by the canonical agent root in its command line. An
 * orphaned agent squatting on the port pool would otherwise answer the new
 * worker's health checks for the wrong agent (the worker now bind-probes
 * ports, but a clean slate keeps the pool usable).
 */
async function reapLeftoverAgents(): Promise<void> {
  const proc = Bun.spawn(["pkill", "-9", "-f", `${AGENT_ROOT}/`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited; // exit 1 = nothing matched; both outcomes are fine
}

// ── local stub MCP server (streamable HTTP, JSON-RPC) ───────────────────────

function startStubMcp(): { url: string; requests: string[]; stop(): void } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as {
        id?: number | string;
        method?: string;
      };
      requests.push(body.method ?? "unknown");
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
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    stop: () => server.stop(true),
  };
}

// ── SSE reading ─────────────────────────────────────────────────────────────

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
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
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
  timeoutMs = 30_000,
  intervalMs = 200,
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

describe.skipIf(!GATE)("phase 1 acceptance — compiler→build→run spine", () => {
  const mcp = GATE ? startStubMcp() : null!;
  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  let baseUrl: string;
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  let workerId: string;

  let cookie: string;
  let orgId: string;
  let workflowId: string;
  let agentPresetId: string;
  let definition: WorkflowDefinitionInput;

  let hashV1: string;
  let versionIdV1: string;
  let sessionId: string;
  let eveSessionIdV1: string;
  let firstRunId: string;
  let firstRunSeqs: number[] = [];

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

  async function publish(): Promise<PublishWorkflowResponse> {
    const res = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`);
    expect(res.status).toBe(200);
    return (await res.json()) as PublishWorkflowResponse;
  }

  /** Wait for the (real) build, then delete the build dir so the worker MUST
   *  pull the tarball from MinIO (proves the artifact path end to end). */
  async function awaitBuildAndStripDir(contentHash: string): Promise<void> {
    await stack.runtime!.buildService.waitFor(contentHash);
    const record = await until(
      async () => {
        const row = await stack.runtime!.buildStore.get(contentHash);
        if (row?.status === "failed") {
          throw new Error(`build failed:\n${row.errorLog ?? "(no log)"}`);
        }
        return row?.status === "succeeded" ? row : undefined;
      },
      `build of ${contentHash.slice(0, 12)} to succeed`,
      15 * 60_000,
      1_000,
    );
    expect(record.artifactKey).toBe(`artifacts/${contentHash}.tar.gz`);
    rmSync(join(AGENT_ROOT, contentHash), { recursive: true, force: true });
  }

  beforeAll(async () => {
    await ensureInfra();
    const worldDatabaseUrl = await ensureWorldDatabase();
    const productDatabaseUrl = await ensureFreshProductDatabase();
    await runMigrations(productDatabaseUrl);

    mkdirSync(AGENT_ROOT, { recursive: true });
    await reapLeftoverAgents();

    // ── control plane (in-process, real everything) ────────────────────────
    const controlPort = await freePort();
    baseUrl = `http://localhost:${controlPort}`;
    stack = createAppStack({
      DATABASE_URL: productDatabaseUrl,
      BETTER_AUTH_SECRET: "p1a-better-auth-secret-0123456789",
      BETTER_AUTH_URL: baseUrl,
      ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
      WORLD_DATABASE_URL: worldDatabaseUrl,
      PLATFORM_JWT_SECRET,
      WORKER_SHARED_SECRET,
      S3_ENDPOINT,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "dev",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "devdevdev",
      S3_BUCKET: process.env.S3_BUCKET ?? "artifacts",
      // Mock-model harness (spike REPORT finding 5): agents serve turns with
      // eve's built-in mock; the provider key is a dummy and the base URL
      // points at a dead port so any REAL model call fails loudly.
      OPENROUTER_API_KEY: "p1a-dummy-openrouter-key",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/v1",
      EVE_MOCK_AUTHORED_MODELS: "1",
      // The in-test worker serves plain http on localhost.
      ALLOW_INSECURE_WORKER_TRANSPORT: "1",
      AGENT_BUILD_ROOT: AGENT_ROOT,
      NPM_CACHE_DIR,
      SSE_HEARTBEAT_MS: "500",
    });
    expect(stack.runtime).not.toBeNull();
    db = stack.dbHandle.db;
    stack.app.listen(controlPort);

    // ── one REAL worker process ────────────────────────────────────────────
    workerId = randomUUID();
    const workerPort = await freePort();
    worker = Bun.spawn(["bun", "apps/worker/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
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

    // ── workspace: user + org + seeds + context rows ───────────────────────
    const email = `p1a-${randomUUID()}@example.com`;
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "P1 Acceptance" }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const authHeaders = new Headers({ cookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: "P1 Acceptance ws", slug: `p1a-${randomUUID().slice(0, 8)}` },
      headers: authHeaders,
    });
    orgId = org!.id;
    await stack.auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: authHeaders,
    });
    await seedWorkspace(db, orgId);

    const agents = await db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, orgId));
    agentPresetId = agents[0]!.id;

    // 1 MCP connection → the local stub server, bearer-token auth.
    const conn = await db
      .insert(schema.mcpConnections)
      .values({
        scope: "workspace",
        organizationId: orgId,
        name: "notes",
        source: "custom",
        url: mcp.url,
      })
      .returning({ id: schema.mcpConnections.id });
    const connectionId = conn[0]!.id;
    const envelope = encryptSecret(
      JSON.stringify({ token: "stub-notes-token" }),
      parseMasterKey(MASTER_KEY_B64),
      mcpAuthAadContext(connectionId),
    );
    await db
      .update(schema.mcpConnections)
      .set({ authConfigEncrypted: JSON.stringify(envelope) })
      .where(eq(schema.mcpConnections.id, connectionId));

    // 1 authored skill.
    const skill = await db
      .insert(schema.skills)
      .values({
        scope: "workspace",
        organizationId: orgId,
        name: "Summary Style",
        description: "Use when asked to summarize anything.",
        content: "# Summary style\n\nAlways answer in at most two sentences.",
      })
      .returning({ id: schema.skills.id });

    definition = {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [connectionId], skillIds: [skill[0]!.id] },
      agent: { agentPresetId, modelPreset: "balanced" },
      instructions: {
        markdown:
          "Answer questions directly. Use @notes to store anything the user asks you to remember, and follow @skill.summary-style when summarizing.",
      },
    };
  }, 120_000);

  afterAll(async () => {
    if (worker) {
      // Give the drain path time to SIGTERM→SIGKILL its agents (graphile's
      // graceful shutdown can hold agents through SIGTERM for ~10s each);
      // SIGKILLing the worker early would orphan them on the port pool.
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

  test("REST-create workflow (manual trigger, 1 MCP, 1 skill, balanced preset)", async () => {
    const res = await api("POST", `/workspaces/${orgId}/workflows`, {
      body: { name: "P1 Acceptance Workflow", draft: definition },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workflow: { id: string; name: string } };
    workflowId = body.workflow.id;
    expect(body.workflow.name).toBe("P1 Acceptance Workflow");
  });

  test(
    "publish → REAL compile + npm install + eve build → tarball in MinIO",
    async () => {
      const body = await publish();
      expect(body.contentHash).toHaveLength(64);
      hashV1 = body.contentHash;
      versionIdV1 = body.versionId;

      await awaitBuildAndStripDir(hashV1);

      // The artifact really is in the object store (presign + HEAD-by-GET).
      const artifactUrl = stack.runtime!.artifacts.presignGetUrl(
        `artifacts/${hashV1}.tar.gz`,
      );
      const head = await fetch(artifactUrl);
      expect(head.status).toBe(200);
      const bytes = await head.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(100_000);

      const versions = await db
        .select()
        .from(schema.workflowVersions)
        .where(eq(schema.workflowVersions.id, versionIdV1));
      expect(versions[0]).toMatchObject({
        contentHash: hashV1,
        modelProvider: "openrouter",
        buildStatus: "succeeded",
      });
    },
    15 * 60_000,
  );

  test(
    "create session → real agent boots from the MinIO tarball → real eve NDJSON events land in run_events",
    async () => {
      const res = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
        { body: { message: "Reply with exactly: acceptance-alpha" } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateSessionResponse;
      sessionId = body.session.id;
      firstRunId = body.run.id;
      eveSessionIdV1 = body.session.eveSessionId!;
      expect(eveSessionIdV1).toBeTruthy();
      expect(body.session.workflowVersionId).toBe(versionIdV1);

      await until(
        async () => {
          const rows = await db
            .select({ status: schema.runs.status, error: schema.runs.error })
            .from(schema.runs)
            .where(eq(schema.runs.id, firstRunId));
          if (rows[0]?.status === "failed") {
            throw new Error(`run failed: ${rows[0].error ?? "(no error)"}`);
          }
          return rows[0]?.status === "succeeded" || undefined;
        },
        "first run to succeed",
        120_000,
      );

      const events = await db
        .select({ seq: schema.runEvents.seq, event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, firstRunId))
        .orderBy(schema.runEvents.seq);
      const types = events.map((e) => (e.event as { type: string }).type);
      firstRunSeqs = events.map((e) => e.seq);

      // Real eve event stream: session/turn/step/message.* (PLAN acceptance).
      expect(types[0]).toBe("session.started");
      expect(types).toContain("turn.started");
      expect(types).toContain("step.started");
      expect(types).toContain("message.completed");
      expect(types).toContain("turn.completed");
      expect(types.at(-1)).toBe("session.waiting");

      // The mock-model fixture reply proves a full model turn ran.
      const completed = events
        .map((e) => e.event as { type: string; data?: { message?: string | null } })
        .filter((e) => e.type === "message.completed")
        .map((e) => e.data?.message ?? "");
      expect(completed.some((m) => m.includes("acceptance-alpha"))).toBeTrue();
    },
    5 * 60_000,
  );

  test("SSE streams the run and resumes from Last-Event-ID mid-stream", async () => {
    const full = await readSse(await api("GET", `/runs/${firstRunId}/stream`), {
      until: (frame) => frame.event === "run_status",
    });
    const eventFrames = full.filter((f) => f.event === "run_event");
    expect(eventFrames.length).toBe(firstRunSeqs.length);
    expect((eventFrames[0]!.data as RunEventFrame).event.type).toBe("session.started");
    expect((full.at(-1)!.data as RunStatusFrame).status).toBe("succeeded");

    // Resume mid-stream: consumed through seq N → replay starts at N+1.
    const mid = firstRunSeqs[Math.floor(firstRunSeqs.length / 2)]!;
    const resumed = await readSse(
      await api("GET", `/runs/${firstRunId}/stream`, {
        headers: { "last-event-id": String(mid) },
      }),
      { until: (frame) => frame.event === "run_status" },
    );
    const resumedIds = resumed
      .filter((f) => f.event === "run_event")
      .map((f) => Number(f.id));
    expect(resumedIds[0]).toBe(mid + 1);
    expect(resumedIds).toEqual(firstRunSeqs.filter((seq) => seq > mid));
  });

  test(
    "follow-up message continues the SAME eve session (event continuity)",
    async () => {
      const res = await api("POST", `/sessions/${sessionId}/messages`, {
        body: { message: "Reply with exactly: acceptance-beta" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as PostMessageResponse;
      expect(body.run.id).not.toBe(firstRunId);

      await until(
        async () => {
          const rows = await db
            .select({ status: schema.runs.status, error: schema.runs.error })
            .from(schema.runs)
            .where(eq(schema.runs.id, body.run.id));
          if (rows[0]?.status === "failed") {
            throw new Error(`follow-up run failed: ${rows[0].error ?? "(no error)"}`);
          }
          return rows[0]?.status === "succeeded" || undefined;
        },
        "follow-up run to succeed",
        120_000,
      );

      // Same eve session id on the row…
      const sessions = await db
        .select({ eveSessionId: schema.agentSessions.eveSessionId })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, sessionId));
      expect(sessions[0]!.eveSessionId).toBe(eveSessionIdV1);

      // …and event continuity: the follow-up turn ran INSIDE the durable
      // session — no second session.started, but a full turn with the reply.
      const events = await db
        .select({ event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, body.run.id));
      const types = events.map((e) => (e.event as { type: string }).type);
      expect(types).not.toContain("session.started");
      expect(types).toContain("turn.started");
      const completed = events
        .map((e) => e.event as { type: string; data?: { message?: string | null } })
        .filter((e) => e.type === "message.completed")
        .map((e) => e.data?.message ?? "");
      expect(completed.some((m) => m.includes("acceptance-beta"))).toBeTrue();
    },
    5 * 60_000,
  );

  test(
    "republish with changed instructions → new session uses the new version, old session keeps the old",
    async () => {
      const changed = {
        ...definition,
        instructions: {
          markdown:
            "You are the v2 agent. Answer tersely. Use @notes for storage and @skill.summary-style for summaries.",
        },
      };
      await db
        .update(schema.workflows)
        .set({ draft: changed as unknown as Record<string, unknown> })
        .where(eq(schema.workflows.id, workflowId));

      const body = await publish();
      expect(body.contentHash).not.toBe(hashV1);
      expect(body.versionId).not.toBe(versionIdV1);
      const hashV2 = body.contentHash;

      await awaitBuildAndStripDir(hashV2);

      // New session → new version hash.
      const created = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${workflowId}/sessions`,
        { body: { message: "Reply with exactly: acceptance-v2" } },
      );
      expect(created.status).toBe(201);
      const v2 = (await created.json()) as CreateSessionResponse;
      expect(v2.session.workflowVersionId).toBe(body.versionId);
      expect(v2.session.eveSessionId).not.toBe(eveSessionIdV1);

      await until(
        async () => {
          const rows = await db
            .select({ status: schema.runs.status, error: schema.runs.error })
            .from(schema.runs)
            .where(eq(schema.runs.id, v2.run.id));
          if (rows[0]?.status === "failed") {
            throw new Error(`v2 run failed: ${rows[0].error ?? "(no error)"}`);
          }
          return rows[0]?.status === "succeeded" || undefined;
        },
        "v2 run to succeed",
        120_000,
      );

      // Old session stays pinned to the old version AND still works.
      const followUp = await api("POST", `/sessions/${sessionId}/messages`, {
        body: { message: "Reply with exactly: acceptance-old-still-works" },
      });
      expect(followUp.status).toBe(201);
      const oldRun = (await followUp.json()) as PostMessageResponse;
      await until(
        async () => {
          const rows = await db
            .select({ status: schema.runs.status, error: schema.runs.error })
            .from(schema.runs)
            .where(eq(schema.runs.id, oldRun.run.id));
          if (rows[0]?.status === "failed") {
            throw new Error(`old-session run failed: ${rows[0].error ?? "(no error)"}`);
          }
          return rows[0]?.status === "succeeded" || undefined;
        },
        "old-session follow-up to succeed",
        120_000,
      );
      const detail = await api("GET", `/sessions/${sessionId}`);
      const detailBody = (await detail.json()) as GetSessionResponse;
      expect(detailBody.session.workflowVersionId).toBe(versionIdV1);
      expect(detailBody.session.eveSessionId).toBe(eveSessionIdV1);
    },
    20 * 60_000,
  );
});
