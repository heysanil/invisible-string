/**
 * Shared lifecycle harness for the Phase-0 spike suite.
 *
 * Orchestrates: docker-compose Postgres (world DB) -> world-postgres
 * bootstrap -> `eve build` -> `eve start` (Node 24 via mise) -> Bun reverse
 * proxy (forwards only /eve/ and /.well-known/workflow/).
 *
 * Gating: the whole suite is DB-dependent and skips cleanly when
 * TEST_DATABASE_URL is unset. Keyed tests additionally require
 * OPENROUTER_API_KEY.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { SQL, type Subprocess } from "bun";

import { startProxy, type ProxyHandle } from "../proxy.ts";

export const SPIKE_DIR = resolve(import.meta.dir, "..");
export const REPO_ROOT = resolve(SPIKE_DIR, "..");
export const AGENT_PROJECT_DIR = join(SPIKE_DIR, "agent-project");
export const ARTIFACTS_DIR = join(SPIKE_DIR, ".artifacts");

export const AGENT_PORT = 4101;
export const PROXY_PORT = 4100;
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
export const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;

export const WORLD_DB_URL =
  process.env.SPIKE_WORLD_DATABASE_URL ?? "postgres://dev:dev@localhost:5443/world";
export const PLATFORM_JWT_SECRET = "spike-platform-secret-0000000000000000";

export const DB_GATE_AVAILABLE = process.env.TEST_DATABASE_URL !== undefined;
export const DB_GATE_SKIP_REASON =
  "requires TEST_DATABASE_URL (integration stage provides it)";
export const KEY_GATE_AVAILABLE = (process.env.OPENROUTER_API_KEY ?? "") !== "";
export const KEY_GATE_SKIP_REASON = "requires OPENROUTER_API_KEY";

function node24Bin(): string {
  const override = process.env.SPIKE_NODE24_BIN;
  if (override !== undefined && override.length > 0) return override;
  const installs = `${process.env.HOME}/.local/share/mise/installs/node`;
  if (existsSync(installs)) {
    const v24 = readdirSync(installs)
      .filter((d) => d.startsWith("24."))
      .sort()
      .at(-1);
    if (v24 !== undefined) return join(installs, v24, "bin", "node");
  }
  throw new Error(
    "Node 24 not found. Run `mise install node@24` or set SPIKE_NODE24_BIN.",
  );
}

async function run(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = options.timeoutMs ?? 240_000;
  const timer = setTimeout(() => proc.kill(9), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Postgres (docker compose -p p0spike, port 5443)
// ---------------------------------------------------------------------------

async function worldDbReachable(): Promise<boolean> {
  try {
    const sql = new SQL(WORLD_DB_URL, { max: 1 });
    await sql`select 1`;
    await sql.close();
    return true;
  } catch {
    return false;
  }
}

export async function ensurePostgres(): Promise<void> {
  if (await worldDbReachable()) return;
  const up = await run(
    ["docker", "compose", "-p", "p0spike", "up", "-d", "postgres"],
    { env: { POSTGRES_PORT: "5443" }, timeoutMs: 180_000 },
  );
  if (up.exitCode !== 0) {
    throw new Error(`docker compose up failed: ${up.stderr.slice(-2000)}`);
  }
  for (let i = 0; i < 60; i++) {
    if (await worldDbReachable()) return;
    await sleep(1000);
  }
  throw new Error(`world DB not reachable at ${WORLD_DB_URL} after compose up`);
}

export async function queryWorldDb<T>(query: string): Promise<T[]> {
  const sql = new SQL(WORLD_DB_URL, { max: 1 });
  try {
    return (await sql.unsafe(query)) as T[];
  } finally {
    await sql.close();
  }
}

// ---------------------------------------------------------------------------
// world-postgres bootstrap + eve build
// ---------------------------------------------------------------------------

let worldBootstrapped = false;
let agentBuilt = false;

export async function bootstrapWorld(): Promise<void> {
  if (worldBootstrapped) return;
  const result = await run(
    [node24Bin(), join(AGENT_PROJECT_DIR, "node_modules", "@workflow", "world-postgres", "bin", "setup.js")],
    {
      cwd: AGENT_PROJECT_DIR,
      env: { WORKFLOW_POSTGRES_URL: WORLD_DB_URL },
      timeoutMs: 120_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `world-postgres bootstrap failed (${result.exitCode}):\n${result.stdout.slice(-1000)}\n${result.stderr.slice(-2000)}`,
    );
  }
  worldBootstrapped = true;
  await resetWorldState();
}

/**
 * Wipe workflow runs/jobs left by previous suite runs. Without this, every
 * `eve start` boot re-enqueues ALL active runs found in the world DB
 * (@workflow/world reenqueueActiveRuns has no job-prefix filter — see
 * spike/REPORT.md), and stale sessions from old runs flood the queue.
 */
async function resetWorldState(): Promise<void> {
  const sql = new SQL(WORLD_DB_URL, { max: 1 });
  try {
    const tables = (await sql.unsafe(
      "select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and (table_schema = 'workflow' or table_schema = 'graphile_worker') and table_name not like '%migrations%'",
    )) as { table_schema: string; table_name: string }[];
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.table_schema}"."${t.table_name}"`).join(", ");
    await sql.unsafe(`truncate table ${list} cascade`);
  } finally {
    await sql.close();
  }
}

export async function eveBuild(): Promise<void> {
  if (agentBuilt) return;
  const result = await run(
    [node24Bin(), join(AGENT_PROJECT_DIR, "node_modules", "eve", "bin", "eve.js"), "build"],
    { cwd: AGENT_PROJECT_DIR, timeoutMs: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `eve build failed (${result.exitCode}):\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`,
    );
  }
  if (!existsSync(join(AGENT_PROJECT_DIR, ".output", "server", "index.mjs"))) {
    throw new Error("eve build reported success but .output/server/index.mjs is missing");
  }
  agentBuilt = true;
}

// ---------------------------------------------------------------------------
// eve start (agent process) + proxy
// ---------------------------------------------------------------------------

export interface EveProcess {
  proc: Subprocess;
  /** PID of the actual HTTP listener (child of the eve CLI). */
  serverPid(): Promise<number | null>;
  stop(): Promise<void>;
  /** SIGKILL without cleanup — used by the kill-and-resume durability test. */
  killHard(): Promise<void>;
}

export interface StartEveOptions {
  /** Extra env for the agent process. */
  env?: Record<string, string>;
  /** Allow localDev() auth (loopback) instead of failing closed. */
  allowLocalDev?: boolean;
  /**
   * Serve turns with eve's documented mock-model mode
   * (EVE_MOCK_AUTHORED_MODELS=1): the harness, durability machinery, tools,
   * approvals, and sandbox all run for real; only the LLM call is emulated.
   * When false (default), NODE_ENV is forced to "production" so bun test's
   * NODE_ENV=test cannot silently activate the mock (observed empirically).
   */
  mockModels?: boolean;
}

export function markerDir(): string {
  const dir = join(ARTIFACTS_DIR, "markers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resetMarkerDir(): void {
  rmSync(join(ARTIFACTS_DIR, "markers"), { force: true, recursive: true });
  mkdirSync(join(ARTIFACTS_DIR, "markers"), { recursive: true });
}

async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

/**
 * `eve start` (the CLI) spawns the actual HTTP server as a CHILD process
 * (`node .output/server/index.mjs`). Signaling only the CLI orphans the
 * listener (observed empirically; see spike/REPORT.md — the worker
 * supervisor must manage the whole process tree). Track listeners by port.
 */
async function pidsListeningOn(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      stderr: "ignore",
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
  } catch {
    return [];
  }
}

async function killPortListeners(port: number, signal: NodeJS.Signals | number): Promise<void> {
  for (const pid of await pidsListeningOn(port)) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await sleep(250);
  }
  return portFree(port);
}

export async function startEve(options: StartEveOptions = {}): Promise<EveProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // bun test exports NODE_ENV=test; if it leaked into `eve start`, eve
    // would mock authored models. Make the model mode explicit either way.
    NODE_ENV: "production",
    EVE_MOCK_AUTHORED_MODELS: options.mockModels === true ? "1" : undefined,
    PORT: String(AGENT_PORT),
    WORKFLOW_POSTGRES_URL: WORLD_DB_URL,
    WORKFLOW_POSTGRES_JOB_PREFIX: "spike",
    // Run callbacks (/.well-known/workflow/v1/*) go THROUGH the proxy so a
    // completed turn proves the proxy forwards the workflow prefix.
    WORKFLOW_LOCAL_BASE_URL: PROXY_URL,
    PLATFORM_JWT_SECRET,
    SPIKE_MARKER_DIR: markerDir(),
    SPIKE_DISABLE_LOCAL_DEV: options.allowLocalDev === true ? "0" : "1",
    ...options.env,
  };
  if (options.mockModels !== true) delete env.EVE_MOCK_AUTHORED_MODELS;

  // Pre-flight: reclaim the port from any stray listener (e.g. a server
  // child orphaned by a previous crashed run).
  if (!(await portFree(AGENT_PORT))) {
    await killPortListeners(AGENT_PORT, 9);
    if (!(await waitPortFree(AGENT_PORT, 5_000))) {
      throw new Error(`port ${AGENT_PORT} is occupied and could not be reclaimed`);
    }
  }

  const proc = Bun.spawn(
    [node24Bin(), join(AGENT_PROJECT_DIR, "node_modules", "eve", "bin", "eve.js"), "start", "--host", "0.0.0.0"],
    {
      cwd: AGENT_PROJECT_DIR,
      env,
      stdout: Bun.file(join(ARTIFACTS_DIR, `eve-start-${Date.now()}.log`)),
      stderr: Bun.file(join(ARTIFACTS_DIR, `eve-start-${Date.now()}.err.log`)),
    },
  );

  // Wait for health on the agent port directly.
  let healthy = false;
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/eve/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  if (!healthy) {
    proc.kill(9);
    throw new Error("eve start did not become healthy on /eve/v1/health within 90s");
  }

  const shutdown = async (signal: number) => {
    // Kill the CLI *and* its server child — signaling only the CLI orphans
    // the listener (observed; production supervisors need process groups).
    proc.kill(signal);
    await killPortListeners(AGENT_PORT, signal);
    await proc.exited;
    if (!(await waitPortFree(AGENT_PORT, 5_000))) {
      await killPortListeners(AGENT_PORT, 9);
      if (!(await waitPortFree(AGENT_PORT, 5_000))) {
        throw new Error(`eve server still listening on ${AGENT_PORT} after kill`);
      }
    }
  };

  return {
    proc,
    async serverPid() {
      const pids = await pidsListeningOn(AGENT_PORT);
      return pids[0] ?? null;
    },
    async stop() {
      await shutdown(15);
    },
    async killHard() {
      await shutdown(9);
    },
  };
}

let proxyHandle: ProxyHandle | null = null;

export function ensureProxy(): ProxyHandle {
  proxyHandle ??= startProxy({ port: PROXY_PORT, upstream: AGENT_URL });
  return proxyHandle;
}

export function stopProxy(): void {
  proxyHandle?.stop();
  proxyHandle = null;
}

// ---------------------------------------------------------------------------
// Platform JWT (HS256, hand-rolled — mirrors the control-plane dispatcher)
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function mintPlatformJwt(
  overrides: Record<string, unknown> = {},
  secret: string = PLATFORM_JWT_SECRET,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: "invisible-string",
        aud: "workflow-agent",
        sub: "dispatcher",
        iat: now,
        exp: now + 300,
        ...overrides,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// NDJSON stream helpers (raw HTTP, exercised through the proxy)
// ---------------------------------------------------------------------------

export interface NdjsonEvent {
  type: string;
  data?: unknown;
  meta?: unknown;
  [key: string]: unknown;
}

/**
 * Read NDJSON events from a session stream until `until` matches, `maxEvents`
 * is hit, or `timeoutMs` elapses. Returns all parsed events.
 */
export async function readNdjson(
  url: string,
  options: {
    headers?: Record<string, string>;
    until?: (event: NdjsonEvent, all: NdjsonEvent[]) => boolean;
    maxEvents?: number;
    timeoutMs?: number;
  } = {},
): Promise<NdjsonEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const events: NdjsonEvent[] = [];
  try {
    const res = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!res.ok || res.body === null) {
      throw new Error(`stream fetch failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const event = JSON.parse(line) as NdjsonEvent;
          events.push(event);
          if (options.until?.(event, events) === true) return events;
          if (options.maxEvents !== undefined && events.length >= options.maxEvents) {
            return events;
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

mkdirSync(ARTIFACTS_DIR, { recursive: true });
