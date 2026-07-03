/**
 * Runtime-API configuration (build service + scheduler + dispatcher + tailer).
 *
 * Separate from the base `Config` so the Phase-0 surface (auth + health)
 * still boots without any runtime env: `tryLoadRuntimeConfig` returns null
 * when NONE of the required runtime vars are present, and fails fast with a
 * complete problem list when the runtime is partially configured.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../config";
import type { ArtifactStoreConfig } from "../artifacts";

export interface RuntimeConfig {
  /**
   * World Postgres SERVER url (WORLD_DATABASE_URL). Its database is only used
   * as the maintenance connection for provisioning; each workflow version
   * gets its own isolated world database `ws_v_<hash12>` (see build/world.ts
   * for why database-per-version, not search_path schema).
   */
  worldDatabaseUrl: string;
  /** HS256 secret compiled agents verify platform JWTs with (PLATFORM_JWT_SECRET). */
  platformJwtSecret: string;
  /** Shared secret for internal worker endpoints (WORKER_SHARED_SECRET). */
  workerSharedSecret: string;
  /** Object store for build artifacts (S3_* — MinIO in dev/CI). */
  s3: ArtifactStoreConfig;
  /**
   * Platform-owned provider keys. Exactly ONE is injected per agent — the one
   * matching the version's resolved provider. Optional here; dispatch fails
   * with a typed error when the needed key is absent.
   */
  openrouterApiKey?: string;
  anthropicApiKey?: string;
  /** Passed through to agents when set (test harnesses point it at a mock). */
  openrouterBaseUrl?: string;
  /**
   * TEST HARNESS ONLY: propagate `EVE_MOCK_AUTHORED_MODELS=1` to agent
   * processes — eve then serves turns with its built-in mock model (honors
   * "Reply with exactly: X"; spike/REPORT.md finding 5). Never set in
   * production: turns would "succeed" without ever calling a real model.
   */
  mockAuthoredModels: boolean;
  /** Per-run wall-clock cap (MAX_RUN_WALL_CLOCK_MS, default 10 minutes). */
  maxRunWallClockMs: number;
  /** Per-workspace concurrent-run cap (MAX_CONCURRENT_RUNS_PER_WORKSPACE, default 5). */
  maxConcurrentRunsPerWorkspace: number;
  /** A worker is live when its heartbeat is fresher than this (default 30s). */
  workerHeartbeatTtlMs: number;
  /**
   * Fallback per-worker agent cap the scheduler enforces for cold placement
   * when a worker did not report its own `maxAgents` in its heartbeat
   * (SCHEDULER_MAX_AGENTS_PER_WORKER, default 20 — matches the worker's own
   * WORKER_MAX_AGENTS default).
   */
  maxAgentsPerWorker: number;
  /**
   * How often the dead-worker sweeper runs (WORKER_SWEEP_INTERVAL_MS, default
   * = the heartbeat TTL). Each pass marks stale/draining workers dead, clears
   * their sessions' affinity, and reschedules interrupted runs elsewhere.
   */
  workerSweepIntervalMs: number;
  /** Shared npm cache dir for agent-project installs (NPM_CACHE_DIR). */
  npmCacheDir: string;
  /**
   * Canonical build root. Build artifacts are NOT path-relocatable
   * (spike/REPORT.md finding 13: absolute appRoot paths are baked into
   * .output) — workers must extract to the SAME path this build used, so
   * AGENT_BUILD_ROOT must be identical on build and worker hosts
   * (default /var/lib/agents; the compose stack mounts it).
   */
  buildRoot: string;
  /** SSE heartbeat comment interval (default 15s; tests shrink it). */
  sseHeartbeatMs: number;
  /**
   * Per-agent world-postgres tuning (WORKFLOW_POSTGRES_MAX_POOL_SIZE /
   * WORKFLOW_POSTGRES_WORKER_CONCURRENCY, defaults 5/5): graphile-worker's
   * defaults (concurrency 50 vs pool 10) multiply toward the Postgres
   * server's max_connections at ~20 agents/worker (spike REPORT finding 15).
   */
  worldMaxPoolSize: number;
  worldWorkerConcurrency: number;
  /**
   * Allow http:// worker addresses (ALLOW_INSECURE_WORKER_TRANSPORT=1).
   * LOCAL DEV/CI ONLY: agent env maps (provider keys, JWT secrets, decrypted
   * MCP tokens) travel to workers over this transport — production must use
   * https/mTLS, so plaintext registrations are rejected by default.
   */
  allowInsecureWorkerTransport: boolean;
  /**
   * Worker-plane auth mode (WORKER_AUTH_MODE, default `shared-secret`). In
   * `worker-token` mode the control plane mints per-worker session tokens at
   * register (rotated on heartbeat) and per-worker DISPATCH tokens on every
   * ensure-agent; the bootstrap `WORKER_SHARED_SECRET` then guards only the
   * initial register. `shared-secret` keeps the Phase-1 single-credential
   * behaviour (both are accepted so the modes interoperate during rollout).
   */
  workerAuthMode: "shared-secret" | "worker-token";
  /**
   * Pre-provisioned worker ids (WORKER_ALLOWED_IDS, comma-separated UUIDs).
   * When set, `POST /internal/workers/register` rejects ids not on the list —
   * a leaked bootstrap secret alone can no longer register a rogue worker that
   * would receive secret-bearing dispatches. Unset (default) = allow all
   * (local dev/CI, where worker ids are random per boot).
   */
  workerAllowedIds?: string[];
}

/** Env vars that, when any is present, mean "the runtime is configured". */
const RUNTIME_SENTINEL_VARS = [
  "WORLD_DATABASE_URL",
  "PLATFORM_JWT_SECRET",
  "WORKER_SHARED_SECRET",
  "S3_ENDPOINT",
] as const;

type Env = Record<string, string | undefined>;

/**
 * Load the runtime config, failing fast with every problem listed.
 * Use {@link tryLoadRuntimeConfig} at boot to keep the runtime optional.
 */
export function loadRuntimeConfig(env: Env = process.env): RuntimeConfig {
  const problems: string[] = [];

  const worldDatabaseUrl = requireVar(env, "WORLD_DATABASE_URL", problems);
  if (worldDatabaseUrl && !/^postgres(ql)?:\/\//.test(worldDatabaseUrl)) {
    problems.push("WORLD_DATABASE_URL must be a postgres:// URL");
  }
  const platformJwtSecret = requireSecretVar(env, "PLATFORM_JWT_SECRET", problems);
  const workerSharedSecret = requireSecretVar(env, "WORKER_SHARED_SECRET", problems);
  const s3Endpoint = requireVar(env, "S3_ENDPOINT", problems);
  const s3AccessKeyId = requireVar(env, "S3_ACCESS_KEY_ID", problems);
  const s3SecretAccessKey = requireVar(env, "S3_SECRET_ACCESS_KEY", problems);

  const maxRunWallClockMs = parsePositiveInt(
    env.MAX_RUN_WALL_CLOCK_MS,
    "MAX_RUN_WALL_CLOCK_MS",
    10 * 60 * 1000,
    problems,
  );
  const maxConcurrentRunsPerWorkspace = parsePositiveInt(
    env.MAX_CONCURRENT_RUNS_PER_WORKSPACE,
    "MAX_CONCURRENT_RUNS_PER_WORKSPACE",
    5,
    problems,
  );
  const workerHeartbeatTtlMs = parsePositiveInt(
    env.WORKER_HEARTBEAT_TTL_MS,
    "WORKER_HEARTBEAT_TTL_MS",
    30_000,
    problems,
  );
  const maxAgentsPerWorker = parsePositiveInt(
    env.SCHEDULER_MAX_AGENTS_PER_WORKER,
    "SCHEDULER_MAX_AGENTS_PER_WORKER",
    20,
    problems,
  );
  const workerSweepIntervalMs = parsePositiveInt(
    env.WORKER_SWEEP_INTERVAL_MS,
    "WORKER_SWEEP_INTERVAL_MS",
    workerHeartbeatTtlMs,
    problems,
  );
  const sseHeartbeatMs = parsePositiveInt(
    env.SSE_HEARTBEAT_MS,
    "SSE_HEARTBEAT_MS",
    15_000,
    problems,
  );
  const worldMaxPoolSize = parsePositiveInt(
    env.WORKFLOW_POSTGRES_MAX_POOL_SIZE,
    "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
    5,
    problems,
  );
  const worldWorkerConcurrency = parsePositiveInt(
    env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY,
    "WORKFLOW_POSTGRES_WORKER_CONCURRENCY",
    5,
    problems,
  );

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    worldDatabaseUrl: worldDatabaseUrl!,
    platformJwtSecret: platformJwtSecret!,
    workerSharedSecret: workerSharedSecret!,
    s3: {
      endpoint: s3Endpoint!,
      accessKeyId: s3AccessKeyId!,
      secretAccessKey: s3SecretAccessKey!,
      bucket: env.S3_BUCKET?.trim() || "artifacts",
      region: env.S3_REGION?.trim() || undefined,
    },
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    openrouterBaseUrl: env.OPENROUTER_BASE_URL?.trim() || undefined,
    mockAuthoredModels: env.EVE_MOCK_AUTHORED_MODELS?.trim() === "1",
    maxRunWallClockMs,
    maxConcurrentRunsPerWorkspace,
    workerHeartbeatTtlMs,
    maxAgentsPerWorker,
    workerSweepIntervalMs,
    npmCacheDir:
      env.NPM_CACHE_DIR?.trim() || join(tmpdir(), "invisible-string-npm-cache"),
    buildRoot: env.AGENT_BUILD_ROOT?.trim() || "/var/lib/agents",
    sseHeartbeatMs,
    worldMaxPoolSize,
    worldWorkerConcurrency,
    allowInsecureWorkerTransport:
      env.ALLOW_INSECURE_WORKER_TRANSPORT?.trim() === "1",
    workerAuthMode:
      env.WORKER_AUTH_MODE?.trim() === "worker-token"
        ? "worker-token"
        : "shared-secret",
    workerAllowedIds: parseWorkerAllowedIds(env.WORKER_ALLOWED_IDS),
  };
}

function parseWorkerAllowedIds(raw: string | undefined): string[] | undefined {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Null when the runtime is entirely unconfigured (Phase-0-style boot);
 * throws {@link ConfigError} when partially configured (misconfiguration
 * must never silently disable the runtime API).
 */
export function tryLoadRuntimeConfig(
  env: Env = process.env,
): RuntimeConfig | null {
  const anyPresent = RUNTIME_SENTINEL_VARS.some(
    (name) => (env[name]?.trim() ?? "") !== "",
  );
  if (!anyPresent) return null;
  return loadRuntimeConfig(env);
}

function requireVar(env: Env, name: string, problems: string[]): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    problems.push(`${name} is required for the runtime API`);
    return undefined;
  }
  return value;
}

/** Minimum length for platform-wide HS256/shared secrets (≈32 bytes entropy). */
const MIN_SECRET_LENGTH = 32;

/**
 * Like {@link requireVar} but enforces a minimum secret length: these HS256/
 * shared secrets authorize the whole worker plane — a short secret is
 * offline-brute-forceable from any captured token.
 */
function requireSecretVar(env: Env, name: string, problems: string[]): string | undefined {
  const value = requireVar(env, name, problems);
  if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
    problems.push(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters — generate with \`openssl rand -base64 32\``,
    );
    return undefined;
  }
  return value;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive integer, got "${value}"`);
    return fallback;
  }
  return parsed;
}
