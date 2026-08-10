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

import { COPILOT_FAKE_SCRIPT_JSON } from "./support/copilot-script.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = HERE;
export const REPO_ROOT = resolve(HERE, "..");
/** Runtime scratch: PID/log state for teardown + process logs. */
export const RUNTIME_DIR = join(HERE, ".runtime");
export const STATE_FILE = join(RUNTIME_DIR, "state.json");

/** docker compose project — isolated from dev + phase-1 acceptance stacks. */
export const COMPOSE_PROJECT = "p2e2e";

// ── Ports (offset from dev :5432/:9000/:5556 and p1acceptance :5443) ────────
/**
 * Every port is env-overridable, defaulting to the historical value.
 *
 * These are fixed low ports (deliberately below the ephemeral range so the
 * kernel never hands one out mid-run), which makes them collidable with ANY
 * other docker project on the machine — not just this repo's other harnesses.
 * A collision fails the whole suite in global setup with a bare "port is
 * already allocated", so the escape hatch has to exist:
 *   E2E_POSTGRES_PORT=5452 bunx playwright test
 * Keep overrides below 32768 for the same reason the defaults are.
 */
function port(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${envName} must be an integer port 1-65535, got ${raw}`);
  }
  return parsed;
}

export const PORTS = {
  postgres: port("E2E_POSTGRES_PORT", 5442),
  garage: port("E2E_GARAGE_PORT", 3910),
  dex: port("E2E_DEX_PORT", 5557),
  /** Registry-search mirror (offset from the dev stack's :7700). */
  meilisearch: port("E2E_MEILISEARCH_PORT", 7710),
  controlPlane: port("E2E_CONTROL_PLANE_PORT", 4310),
  worker: port("E2E_WORKER_PORT", 4311),
  preview: port("E2E_PREVIEW_PORT", 5173),
  /** Local stub MCP server the built agent's tools call. */
  stubMcp: port("E2E_STUB_MCP_PORT", 4315),
  /** Pool the worker draws AGENT ports from — see the invariant below. */
  agentMin: port("E2E_AGENT_PORT_MIN", 4320),
  agentMax: port("E2E_AGENT_PORT_MAX", 4399),
} as const;

/**
 * The agent pool must not contain any service port.
 *
 * This is enforced rather than merely commented because the failure is silent
 * and expensive: the worker hands a booting agent a port a service already
 * holds, the agent never answers /eve/v1/health, and every spec that needs a
 * published agent dies 120 s later with "boot failed" — while the services
 * themselves look perfectly healthy. Overriding the service ports upward
 * (E2E_CONTROL_PLANE_PORT=4320) walks straight into it, so the check runs at
 * import time and names the offender instead.
 */
{
  const services: ReadonlyArray<[string, number]> = [
    ["controlPlane", PORTS.controlPlane],
    ["worker", PORTS.worker],
    ["stubMcp", PORTS.stubMcp],
    ["preview", PORTS.preview],
  ];
  const clashes = services
    .filter(([, value]) => value >= PORTS.agentMin && value <= PORTS.agentMax)
    .map(([name, value]) => `${name}=${value}`);
  if (clashes.length > 0) {
    throw new Error(
      `e2e port config: ${clashes.join(", ")} fall inside the agent pool ` +
        `${PORTS.agentMin}-${PORTS.agentMax}. Agents booted onto a service's ` +
        `port never become healthy. Move the service ports below the pool, ` +
        `or shift the pool with E2E_AGENT_PORT_MIN/E2E_AGENT_PORT_MAX.`,
    );
  }
}

// ── URLs ────────────────────────────────────────────────────────────────────
export const API_BASE_URL = `http://localhost:${PORTS.controlPlane}`;
export const PREVIEW_URL = `http://localhost:${PORTS.preview}`;
export const WORKER_URL = `http://localhost:${PORTS.worker}`;
// Server-side clients (postgres-js, Bun SQL, S3) use 127.0.0.1 explicitly:
// "localhost" can resolve to ::1 first, which Docker's IPv4 port publishing
// refuses. Browser-facing URLs stay on localhost (cookie-domain stability).
export const S3_ENDPOINT = `http://127.0.0.1:${PORTS.garage}`;
/** The stub MCP endpoint (bound to 127.0.0.1 so the agent process reaches it). */
export const STUB_MCP_URL = `http://127.0.0.1:${PORTS.stubMcp}/mcp`;
/**
 * The stub server also serves the MCP registry REST API (list + detail) so
 * both the control-plane's registry→Meilisearch sync ETL and the server-side
 * install re-fetch can be redirected here (MCP_REGISTRY_BASE_URL) — the real
 * registry is never contacted.
 */
export const REGISTRY_STUB_BASE_URL = `http://127.0.0.1:${PORTS.stubMcp}`;
/** Meilisearch endpoint of the harness compose service (server-side client). */
export const MEILISEARCH_URL = `http://127.0.0.1:${PORTS.meilisearch}`;
/** The compose service's hardcoded dev master key (see docker-compose.yml). */
export const MEILISEARCH_MASTER_KEY = "dev-meili-master-key";

// ── The stub registry server's identity (fixtures + specs share it) ─────────
/** Reverse-DNS name the stub registry lists (NOT io.github.* ⇒ verified). */
export const REGISTRY_SERVER_NAME = "io.modelcontextprotocol/e2e-notes";
/**
 * The stub server's title — ALSO the installed connection's name: the add
 * dialog derives registry-install names from the server title (no name field).
 */
export const REGISTRY_SERVER_TITLE = "E2E Notes";
/** Secret header the stub's remote declares; the add dialog must collect it. */
export const REGISTRY_SECRET_HEADER = "X-Api-Key";
/** The throwaway credential the specs enter for that header (see banner). */
export const REGISTRY_SECRET_VALUE = "e2e-notes-api-key";

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
    S3_ACCESS_KEY_ID: "GKdeadbeefdeadbeefdeadbeefdeadbeef",
    S3_SECRET_ACCESS_KEY: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    S3_BUCKET: "artifacts",
    // Garage enforces exact SigV4 region matching (infra/garage.toml
    // s3_region) — a real S3 provider would tolerate a region mismatch;
    // Garage does not.
    S3_REGION: "us-east-1",
    // Redirect the registry proxy at the local stub (never the real registry).
    MCP_REGISTRY_BASE_URL: REGISTRY_STUB_BASE_URL,
    // Community search rides the harness Meilisearch; the registry→Meilisearch
    // sync ticks fast so global-setup can await the first successful sync
    // (a boot-time run can race the stub's listen — 5 s retries it quickly).
    MEILISEARCH_URL,
    MEILISEARCH_MASTER_KEY,
    REGISTRY_SYNC_INTERVAL_MS: "5000",
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
    // Copilot: deterministic scripted fake LLM (never a real model call in
    // the browser harness) — keyed scripts shared with e2e/specs/copilot.e2e.ts.
    COPILOT_FAKE_SCRIPT: COPILOT_FAKE_SCRIPT_JSON,
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
    // Agent port pool MUST NOT overlap the control-plane, worker, or stub
    // ports — the worker's own default (4310–4409) does. The non-overlap is
    // asserted at import time in this file, so these two stay in lockstep
    // with the service ports even when both are overridden.
    AGENT_PORT_MIN: String(PORTS.agentMin),
    AGENT_PORT_MAX: String(PORTS.agentMax),
  };
}
