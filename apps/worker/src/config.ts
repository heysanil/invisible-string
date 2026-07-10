/**
 * Worker environment configuration — parsed once at boot, fail-fast with
 * readable errors listing every problem at once (mirrors apps/control-plane).
 *
 * The supervisor is deliberately env-light: everything agent-specific
 * (provider keys, MCP secrets, world-DB URLs scoped to the version's world
 * schema) arrives per-agent in the `POST /internal/agents/ensure` body and is
 * injected into the spawned process only — never persisted, never logged.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkerConfig {
  /** Control-plane base URL for register/heartbeat/deregister (CONTROL_PLANE_URL). */
  controlPlaneUrl: string;
  /** Shared secret guarding /internal/* on both sides (WORKER_SHARED_SECRET). */
  workerSharedSecret: string;
  /** Stable worker identity (WORKER_ID; random UUID per boot when unset). */
  workerId: string;
  /** HTTP port of the supervisor itself (PORT, default 4000; 0 = ephemeral). */
  port: number;
  /**
   * Base URL this worker advertises to the control plane (PUBLIC_URL).
   * The control plane dispatches to `${publicUrl}/agents/<hash>/eve/...`.
   */
  publicUrl: string;
  /**
   * Artifact cache root (ARTIFACT_CACHE_DIR, default /var/lib/agents).
   * ⚠️ eve build outputs are NOT path-relocatable (spike/REPORT.md finding
   * 13): absolute appRoot paths are baked into `.output/server/index.mjs`.
   * This dir must match the canonical build path used by the build service.
   */
  artifactCacheDir: string;
  /** LRU cap for extracted artifacts (ARTIFACT_CACHE_MAX_BYTES, default 20 GiB). */
  artifactCacheMaxBytes: number;
  /** Stop agent processes idle this long (AGENT_IDLE_STOP_MS, default 15 min). */
  agentIdleStopMs: number;
  /** Agent port pool, inclusive (AGENT_PORT_MIN/AGENT_PORT_MAX, default 4310–4409). */
  agentPortMin: number;
  agentPortMax: number;
  /** Max wait for /eve/v1/health after spawn (AGENT_READY_TIMEOUT_MS, default 60 s). */
  agentReadyTimeoutMs: number;
  /** SIGTERM → SIGKILL escalation window (AGENT_STOP_TIMEOUT_MS, default 10 s). */
  agentStopTimeoutMs: number;
  /** Max wait for in-flight proxied requests during drain (DRAIN_TIMEOUT_MS, default 30 s). */
  drainTimeoutMs: number;
  /** Heartbeat cadence (HEARTBEAT_INTERVAL_MS, default 10 s). */
  heartbeatIntervalMs: number;
  /** Advertised capacity: max concurrent agent processes (WORKER_MAX_AGENTS, default 20). */
  maxAgents: number;
  /**
   * Worker-plane auth mode (WORKER_AUTH_MODE, default `shared-secret`). In
   * `worker-token` mode the worker declares its identity at register, keeps the
   * per-worker session token from the response, and presents it (with
   * `x-worker-id`) on heartbeat/deregister instead of resending the bootstrap
   * secret. Inbound dispatches are still accepted with either the bootstrap
   * secret or a per-worker dispatch token.
   */
  authMode: "shared-secret" | "worker-token";
  /**
   * Stop docker sandboxes idle longer than this (SANDBOX_IDLE_STOP_MS, default
   * 30 min — design correction 4: eve gives sandboxes NO idle timeout, so the
   * worker enforces one). The reaper enumerates containers labelled by eve
   * session and stops the idle ones.
   */
  sandboxIdleStopMs: number;
  /** docker CLI the sandbox reaper shells out to (DOCKER_BIN, default `docker`). */
  dockerBin: string;
  /**
   * Container label key eve stamps on sandbox containers, used to enumerate
   * them (SANDBOX_LABEL, default `eve.session`). Only containers carrying this
   * label are candidates for reaping — the worker never touches unlabeled
   * containers.
   */
  sandboxLabelKey: string;
  /**
   * Enable the sandbox reaper (SANDBOX_REAPER_ENABLED, default off). Requires a
   * reachable docker daemon; the compose worker image mounts the socket.
   */
  sandboxReaperEnabled: boolean;
  /**
   * Node runtime used to launch compiled agents (WORKER_NODE_BIN). eve agents
   * require Node 24.x. Defaults to the newest mise-installed node 24, then
   * `node` on PATH (the production worker image ships Node 24 as `node`).
   */
  nodeBin: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(public readonly problems: string[]) {
    super(
      `invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

type Env = Record<string, string | undefined>;

const GIB = 1024 ** 3;

/**
 * Parse configuration from an environment map. Throws {@link ConfigError}
 * listing all problems when anything required is missing or malformed.
 */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];

  const controlPlaneUrl = requireVar(
    env,
    "CONTROL_PLANE_URL",
    "e.g. http://control-plane:3000",
    problems,
  );
  if (controlPlaneUrl !== undefined && !isHttpUrl(controlPlaneUrl)) {
    problems.push(
      `CONTROL_PLANE_URL must be an http(s) URL, got "${controlPlaneUrl}"`,
    );
  }

  const workerSharedSecret = requireVar(
    env,
    "WORKER_SHARED_SECRET",
    "shared secret for /internal/* — generate with `openssl rand -base64 32`",
    problems,
  );
  if (workerSharedSecret !== undefined && workerSharedSecret.length < 32) {
    // Guards the ensure-agent surface that receives full secret env maps —
    // a short secret is offline-brute-forceable.
    problems.push(
      "WORKER_SHARED_SECRET must be at least 32 characters — generate with `openssl rand -base64 32`",
    );
  }

  // Lowercased: the control plane round-trips this id through a Postgres
  // uuid column (which lowercases it) and binds dispatch-token audiences to
  // the DB value — a mixed-case WORKER_ID (macOS uuidgen emits uppercase)
  // would register fine but fail every dispatch's case-sensitive guard.
  const workerId = env.WORKER_ID?.trim().toLowerCase() || crypto.randomUUID();

  const port = parseIntVar(env.PORT, "PORT", 4000, 0, 65535, problems);
  const publicUrl =
    env.PUBLIC_URL?.trim().replace(/\/+$/, "") || `http://localhost:${port}`;
  if (!isHttpUrl(publicUrl)) {
    problems.push(`PUBLIC_URL must be an http(s) URL, got "${publicUrl}"`);
  }

  const artifactCacheDir = env.ARTIFACT_CACHE_DIR?.trim() || "/var/lib/agents";

  const artifactCacheMaxBytes = parseIntVar(
    env.ARTIFACT_CACHE_MAX_BYTES,
    "ARTIFACT_CACHE_MAX_BYTES",
    20 * GIB,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const agentIdleStopMs = parseIntVar(
    env.AGENT_IDLE_STOP_MS,
    "AGENT_IDLE_STOP_MS",
    15 * 60_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const agentPortMin = parseIntVar(
    env.AGENT_PORT_MIN,
    "AGENT_PORT_MIN",
    4310,
    1,
    65535,
    problems,
  );
  const agentPortMax = parseIntVar(
    env.AGENT_PORT_MAX,
    "AGENT_PORT_MAX",
    4409,
    1,
    65535,
    problems,
  );
  if (agentPortMin > agentPortMax) {
    problems.push(
      `AGENT_PORT_MIN (${agentPortMin}) must be <= AGENT_PORT_MAX (${agentPortMax})`,
    );
  }
  const agentReadyTimeoutMs = parseIntVar(
    env.AGENT_READY_TIMEOUT_MS,
    "AGENT_READY_TIMEOUT_MS",
    60_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const agentStopTimeoutMs = parseIntVar(
    env.AGENT_STOP_TIMEOUT_MS,
    "AGENT_STOP_TIMEOUT_MS",
    10_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const drainTimeoutMs = parseIntVar(
    env.DRAIN_TIMEOUT_MS,
    "DRAIN_TIMEOUT_MS",
    30_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const heartbeatIntervalMs = parseIntVar(
    env.HEARTBEAT_INTERVAL_MS,
    "HEARTBEAT_INTERVAL_MS",
    10_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const maxAgents = parseIntVar(
    env.WORKER_MAX_AGENTS,
    "WORKER_MAX_AGENTS",
    20,
    1,
    10_000,
    problems,
  );
  const sandboxIdleStopMs = parseIntVar(
    env.SANDBOX_IDLE_STOP_MS,
    "SANDBOX_IDLE_STOP_MS",
    30 * 60_000,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const authMode =
    env.WORKER_AUTH_MODE?.trim() === "worker-token"
      ? ("worker-token" as const)
      : ("shared-secret" as const);
  const dockerBin = env.DOCKER_BIN?.trim() || "docker";
  const sandboxLabelKey = env.SANDBOX_LABEL?.trim() || "eve.session";
  const sandboxReaperEnabled = env.SANDBOX_REAPER_ENABLED?.trim() === "1";

  const nodeBin = resolveNodeBin(env, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    controlPlaneUrl: controlPlaneUrl!.replace(/\/+$/, ""),
    workerSharedSecret: workerSharedSecret!,
    workerId,
    port,
    publicUrl,
    artifactCacheDir,
    artifactCacheMaxBytes,
    agentIdleStopMs,
    agentPortMin,
    agentPortMax,
    agentReadyTimeoutMs,
    agentStopTimeoutMs,
    drainTimeoutMs,
    heartbeatIntervalMs,
    maxAgents,
    authMode,
    sandboxIdleStopMs,
    dockerBin,
    sandboxLabelKey,
    sandboxReaperEnabled,
    nodeBin,
  };
}

/**
 * Resolve the Node runtime for agent processes: WORKER_NODE_BIN override →
 * newest mise-installed node 24.x (dev machines / CI, per spike harness) →
 * `node` on PATH (production image, where PATH node IS Node 24).
 */
export function resolveNodeBin(env: Env, problems: string[]): string {
  const override = env.WORKER_NODE_BIN?.trim();
  if (override) return override;

  const installs = join(
    env.HOME ?? process.env.HOME ?? "",
    ".local/share/mise/installs/node",
  );
  if (existsSync(installs)) {
    const newest24 = readdirSync(installs)
      .filter((d) => /^24\.\d+\.\d+$/.test(d))
      .sort((a, b) => compareVersions(a, b))
      .at(-1);
    if (newest24 !== undefined) {
      const bin = join(installs, newest24, "bin", "node");
      if (existsSync(bin)) return bin;
    }
  }

  const onPath = Bun.which("node");
  if (onPath !== null) return onPath;

  problems.push(
    "no Node runtime found for agent processes (set WORKER_NODE_BIN, `mise install node@24`, or put node 24 on PATH)",
  );
  return "node";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requireVar(
  env: Env,
  name: string,
  hint: string,
  problems: string[],
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    problems.push(`${name} is required (${hint})`);
    return undefined;
  }
  return value;
}

function parseIntVar(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(
      `${name} must be an integer between ${min} and ${max}, got "${raw}"`,
    );
    return fallback;
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
