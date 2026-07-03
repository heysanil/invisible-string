/**
 * Shared E2E harness configuration — ports, URLs, dev-only secrets, and the
 * managed-process environment. Imported by playwright.config.ts, the global
 * setup/teardown, and the specs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY credential in this file is a throwaway, public, localhost-bound DEV
 * secret — the exact ethos of docker-compose.yml. The E2E stack is LOCAL/CI
 * ONLY and never shares ports or secrets with a real environment. The compose
 * project name (`p2e2e`) and its ports are deliberately offset from the dev
 * (`invisible-string`) and phase-1 (`p1acceptance`) projects so all three can
 * coexist on one host.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = HERE;
export const REPO_ROOT = resolve(HERE, "..");
/** Runtime scratch: PID/log state for teardown + process logs. */
export const RUNTIME_DIR = join(HERE, ".runtime");
export const STATE_FILE = join(RUNTIME_DIR, "state.json");

/** docker compose project — isolated from dev + phase-1 acceptance stacks. */
export const COMPOSE_PROJECT = "p2e2e";

// ── Ports (offset from dev :5432/:9000/:5556 and p1acceptance :5443) ────────
export const PORTS = {
  postgres: 5442,
  minio: 9010,
  minioConsole: 9011,
  dex: 5557,
  controlPlane: 4310,
  worker: 4311,
  preview: 5173,
  /** Local stub MCP server the built agent's tools call. */
  stubMcp: 4315,
} as const;

// ── URLs ────────────────────────────────────────────────────────────────────
export const API_BASE_URL = `http://localhost:${PORTS.controlPlane}`;
export const PREVIEW_URL = `http://localhost:${PORTS.preview}`;
export const WORKER_URL = `http://localhost:${PORTS.worker}`;
// Server-side clients (postgres-js, Bun SQL, S3) use 127.0.0.1 explicitly:
// "localhost" can resolve to ::1 first, which Docker's IPv4 port publishing
// refuses. Browser-facing URLs stay on localhost (cookie-domain stability).
export const S3_ENDPOINT = `http://127.0.0.1:${PORTS.minio}`;
/** The stub MCP endpoint (bound to 127.0.0.1 so the agent process reaches it). */
export const STUB_MCP_URL = `http://127.0.0.1:${PORTS.stubMcp}/mcp`;
/**
 * The stub server also serves the MCP registry REST API (search + detail) so
 * the control-plane's registry proxy can be redirected here — the registry
 * browser never touches the real registry.
 */
export const REGISTRY_STUB_BASE_URL = `http://127.0.0.1:${PORTS.stubMcp}`;

// ── Databases (compose postgres: user dev / pass dev) ───────────────────────
const PG_BASE = `postgres://dev:dev@127.0.0.1:${PORTS.postgres}`;
/** Maintenance DB the container always has (POSTGRES_USER default DB). */
export const ADMIN_DATABASE_URL = `${PG_BASE}/dev`;
/** Product DB — dropped + recreated fresh per harness boot for determinism. */
export const PRODUCT_DB_NAME = "p2e2e_product";
export const PRODUCT_DATABASE_URL = `${PG_BASE}/${PRODUCT_DB_NAME}`;
/** World SERVER maintenance DB (per-version world DBs are provisioned off it). */
export const WORLD_DATABASE_URL = `${PG_BASE}/world`;

// ── Dev-only secrets (throwaway; see banner) ────────────────────────────────
export const SECRETS = {
  betterAuth: "e2e-better-auth-secret-0123456789abcd",
  /** base64 of 32 zero bytes — a valid AES-256 key for the envelope module. */
  encryptionMasterKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  platformJwt: "e2e-platform-jwt-secret-000000000000",
  workerShared: "e2e-worker-shared-secret-00000000000",
} as const;

/** Canonical agent build root — MUST match on the build service + worker. */
export const AGENT_ROOT =
  process.env.E2E_AGENT_ROOT ?? "/tmp/invisible-string-e2e-agents";

/** Warm npm cache for the generated agent installs (kept between runs). */
export const NPM_CACHE_DIR =
  process.env.NPM_CACHE_DIR ?? join(process.env.HOME ?? HERE, ".npm");

/** Environment the control-plane process runs with (mock-model, no real key). */
export function controlPlaneEnv(): Record<string, string> {
  return {
    PORT: String(PORTS.controlPlane),
    DATABASE_URL: PRODUCT_DATABASE_URL,
    BETTER_AUTH_SECRET: SECRETS.betterAuth,
    BETTER_AUTH_URL: API_BASE_URL,
    CORS_ORIGIN: PREVIEW_URL,
    ENCRYPTION_MASTER_KEY: SECRETS.encryptionMasterKey,
    WORLD_DATABASE_URL,
    PLATFORM_JWT_SECRET: SECRETS.platformJwt,
    WORKER_SHARED_SECRET: SECRETS.workerShared,
    S3_ENDPOINT,
    S3_ACCESS_KEY_ID: "dev",
    S3_SECRET_ACCESS_KEY: "devdevdev",
    S3_BUCKET: "artifacts",
    // Redirect the registry proxy at the local stub (never the real registry).
    MCP_REGISTRY_BASE_URL: REGISTRY_STUB_BASE_URL,
    // Mock-model harness: the provider key is a dummy and the base URL points
    // at a dead port, so any REAL model call fails loudly (spike finding 5).
    OPENROUTER_API_KEY: "e2e-dummy-openrouter-key",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9/v1",
    EVE_MOCK_AUTHORED_MODELS: "1",
    // The in-harness worker serves plain http on localhost.
    ALLOW_INSECURE_WORKER_TRANSPORT: "1",
    AGENT_BUILD_ROOT: AGENT_ROOT,
    NPM_CACHE_DIR,
    SSE_HEARTBEAT_MS: "500",
  };
}

/** Environment for the single worker process. */
export function workerEnv(workerId: string): Record<string, string> {
  return {
    CONTROL_PLANE_URL: API_BASE_URL,
    WORKER_SHARED_SECRET: SECRETS.workerShared,
    WORKER_ID: workerId,
    PORT: String(PORTS.worker),
    PUBLIC_URL: WORKER_URL,
    ARTIFACT_CACHE_DIR: AGENT_ROOT,
    HEARTBEAT_INTERVAL_MS: "1000",
    AGENT_READY_TIMEOUT_MS: "120000",
    // Agent port pool MUST NOT overlap the control-plane (4310), worker (4311),
    // or stub (4315) — the default 4310–4409 does.
    AGENT_PORT_MIN: "4320",
    AGENT_PORT_MAX: "4399",
  };
}
