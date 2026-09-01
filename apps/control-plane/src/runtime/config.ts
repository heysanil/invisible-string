/**
 * Runtime-API configuration (build service + scheduler + dispatcher + tailer).
 *
 * Separate from the base `Config` so the Phase-0 surface (auth + health)
 * still boots without any runtime env: `tryLoadRuntimeConfig` returns null
 * when NONE of the required runtime vars are present, and fails fast with a
 * complete problem list when the runtime is partially configured.
 *
 * The MCP OAuth broker's two deployment settings live at the BOTTOM of this
 * file as standalone `env → value` loaders rather than as `RuntimeConfig`
 * fields, because the broker is assembled OUTSIDE the nullable runtime graph
 * (index.ts builds its `oauthBroker` deps unconditionally, reading
 * `publicAppUrlFromEnv(env)` straight from the environment) — a value gated on
 * `tryLoadRuntimeConfig` returning non-null would be silently ignored on a
 * Phase-0 boot, which is the exact failure mode (a silently dropped setting)
 * that F8 is about.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../config";
import { publicAppUrlFromEnv } from "../integrations/config";
import {
  loadSessionTitleConfig,
  type SessionTitleConfig,
} from "../resources/session-title";
import type { ArtifactStoreConfig } from "../artifacts";

export interface RuntimeConfig {
  /**
   * World Postgres SERVER url (WORLD_DATABASE_URL). Its database is only used
   * as the maintenance connection for provisioning; each agent version
   * gets its own isolated world database `ag_v_<hash12>` (see build/world.ts
   * for why database-per-version, not search_path schema).
   */
  worldDatabaseUrl: string;
  /** HS256 secret compiled agents verify platform JWTs with (PLATFORM_JWT_SECRET). */
  platformJwtSecret: string;
  /** Shared secret for internal worker endpoints (WORKER_SHARED_SECRET). */
  workerSharedSecret: string;
  /** Object store for build artifacts (S3_* — Garage in dev/CI). */
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
   * Session-titler switch + timeout (SESSION_TITLE_*, spec D9), resolved from
   * the SAME env record as the platform keys just above and carried beside
   * them for that reason: the titler reads both off this object
   * (`TitleRuntimeConfig`, resources/session-title.ts), so an in-process
   * harness that injects a provider key and `SESSION_TITLE_ENABLED=0` in one
   * record has both halves of that pair obeyed. Reading `process.env` there
   * instead would honor the key and ignore the kill switch — a real, billable
   * provider call the caller explicitly asked not to make.
   */
  sessionTitle: SessionTitleConfig;
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
  /**
   * Schedule-ticker cadence (SCHEDULE_TICK_MS, default 30s — keep in sync
   * with runtime/schedule-ticker.ts DEFAULT_SCHEDULE_TICK_MS): how often the
   * control plane scans for due cron triggers. Tests shrink it.
   */
  scheduleTickMs: number;
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
   * Timeout for non-streaming worker calls (WORKER_REQUEST_TIMEOUT_MS,
   * default 120s). ensure-agent is synchronous in v1 — it pulls the artifact
   * and boots the agent, and a COLD first boot (download + extract + node
   * boot + world/graphile migration) can exceed 60s, which 502s the very
   * first session on a fresh version (observed in the keyed acceptance run).
   */
  workerRequestTimeoutMs: number;
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
  /**
   * Meilisearch registry-search mirror (MEILISEARCH_URL +
   * MEILISEARCH_MASTER_KEY). BOTH optional and never validated as required:
   * absent means registry search is degraded, not a boot failure (connectors
   * redesign spec §5 — the index is a disposable mirror).
   */
  meilisearchUrl?: string;
  meilisearchMasterKey?: string;
  /**
   * Registry→Meilisearch sync cadence (REGISTRY_SYNC_INTERVAL_MS, default
   * 6 h): how often the ETL mirrors the official MCP registry into the
   * search index. Only consulted when the Meilisearch client exists.
   */
  registrySyncIntervalMs: number;
  /**
   * MCP_PROBE_ALLOW_PRIVATE=1 — DEV/E2E/SELF-HOSTED ONLY: the guarded egress
   * helper (net/guarded-fetch.ts) stops rejecting private/loopback targets
   * AND allows plain http://, so probes can reach stubs on 127.0.0.1. Never
   * set in production: it disables the SSRF containment.
   */
  mcpProbeAllowPrivate: boolean;
  /**
   * PLATFORM_API_URL — the control-plane base URL as reachable from the
   * WORKER network (prod compose: `http://control-plane:3000`; dev:
   * `http://localhost:3000`). Injected into every agent env under the same
   * name (compiler PLATFORM_API_URL_ENV): compiled agents with broker-
   * delivered OAuth connections call `POST /internal/connections/token` on
   * it. Optional: absent, agents boot fine but any oauth connection's tool
   * calls fail with a missing-env error — a degraded state, not a boot
   * failure.
   */
  platformApiUrl?: string;
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
  const scheduleTickMs = parsePositiveInt(
    env.SCHEDULE_TICK_MS,
    "SCHEDULE_TICK_MS",
    30_000,
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
  const workerRequestTimeoutMs = parsePositiveInt(
    env.WORKER_REQUEST_TIMEOUT_MS,
    "WORKER_REQUEST_TIMEOUT_MS",
    120_000,
    problems,
  );
  const registrySyncIntervalMs = parsePositiveInt(
    env.REGISTRY_SYNC_INTERVAL_MS,
    "REGISTRY_SYNC_INTERVAL_MS",
    // Keep in sync with search/registry-sync.ts DEFAULT_REGISTRY_SYNC_INTERVAL_MS.
    21_600_000,
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
    sessionTitle: loadSessionTitleConfig(env),
    mockAuthoredModels: env.EVE_MOCK_AUTHORED_MODELS?.trim() === "1",
    maxRunWallClockMs,
    maxConcurrentRunsPerWorkspace,
    workerHeartbeatTtlMs,
    maxAgentsPerWorker,
    workerSweepIntervalMs,
    scheduleTickMs,
    npmCacheDir:
      env.NPM_CACHE_DIR?.trim() || join(tmpdir(), "invisible-string-npm-cache"),
    buildRoot: env.AGENT_BUILD_ROOT?.trim() || "/var/lib/agents",
    sseHeartbeatMs,
    worldMaxPoolSize,
    worldWorkerConcurrency,
    workerRequestTimeoutMs,
    allowInsecureWorkerTransport:
      env.ALLOW_INSECURE_WORKER_TRANSPORT?.trim() === "1",
    workerAuthMode:
      env.WORKER_AUTH_MODE?.trim() === "worker-token"
        ? "worker-token"
        : "shared-secret",
    workerAllowedIds: parseWorkerAllowedIds(env.WORKER_ALLOWED_IDS),
    meilisearchUrl: env.MEILISEARCH_URL?.trim() || undefined,
    meilisearchMasterKey: env.MEILISEARCH_MASTER_KEY?.trim() || undefined,
    registrySyncIntervalMs,
    mcpProbeAllowPrivate: env.MCP_PROBE_ALLOW_PRIVATE?.trim() === "1",
    platformApiUrl: normalizeBaseUrl(env.PLATFORM_API_URL),
  };
}

/** Trim + drop a trailing slash so path joins never double up. */
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/\/+$/, "");
  return value || undefined;
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

// ── MCP OAuth broker deployment settings ─────────────────────────────────────
// Both take an `env` record and are meant to be called where index.ts already
// calls `publicAppUrlFromEnv(env)` to build the broker deps. Neither is a
// `RuntimeConfig` field — see the file header for why.

/**
 * THE SPA origin the OAuth consent popup `postMessage`s its result to
 * (PUBLIC_WEB_URL), normalized to a bare origin because that is what the
 * browser compares `targetOrigin` against.
 *
 * It defaults to {@link publicAppUrlFromEnv}, so a single-origin deployment —
 * production behind the nginx gateway, where the SPA and the control plane
 * share one origin — is completely unaffected by this var existing.
 *
 * It exists because the two origins are NOT the same thing and coincide only
 * by deployment accident (F8): PUBLIC_APP_URL is the CONTROL-PLANE origin,
 * correct for the OAuth `redirect_uri` and the CIMD client id since the
 * control plane is what serves `/integrations/mcp-oauth/callback` — but the
 * popup's OPENER is the SPA, which in local dev is Vite on :5173 while the API
 * is on :3000. A `postMessage` whose `targetOrigin` does not match the
 * receiving window's origin is dropped by the browser with no error, no
 * exception and no devtools warning, so the consent result silently never
 * arrives and the SPA falls back to popup-close polling — reporting a
 * dismissal for a consent that actually succeeded.
 *
 * Throws {@link ConfigError} when PUBLIC_WEB_URL is set but is not an absolute
 * http(s) URL: a malformed target origin would fail in exactly the same
 * silent way. An empty/whitespace value counts as unset.
 */
export function publicWebUrlFromEnv(env: Env = process.env): string {
  const raw = env.PUBLIC_WEB_URL?.trim();
  if (!raw) return publicAppUrlFromEnv(env);
  const origin = parseHttpOrigin(raw);
  if (origin === null) {
    throw new ConfigError([
      'PUBLIC_WEB_URL must be an absolute http(s) origin (e.g. "http://localhost:5173")',
    ]);
  }
  return origin;
}

/**
 * One operator-supplied OAuth client registration. Held in memory only and
 * never persisted: unlike a DCR registration (which is minted per connection
 * and envelope-encrypted onto the `connection_oauth` row) this identity is
 * deployment-wide and comes from the environment on every boot.
 *
 * `clientSecret` is plaintext — treat this object as secret-bearing: never put
 * one in a log field, an error string, a DTO or agent env. (The structured
 * logger's redaction would catch a `clientSecret`/`*_SECRET` KEY, but not a
 * whole registration object interpolated into a message.)
 */
export interface OauthClientRegistration {
  /**
   * Normalized provider key: the catalog entry's `clientEnvPrefix` (or its
   * slug) lower-cased with `_` folded to `-`, so `VERCEL`, `vercel` and a
   * `hugging-face`/`HUGGING_FACE` pair all land on one key.
   */
  key: string;
  clientId: string;
  /** Null for a public pre-registered client (no secret issued). */
  clientSecret: string | null;
  /**
   * Canonical issuer this registration is pinned to, or null for unpinned.
   * A pinned registration is refused against any other authorization server
   * (see {@link findOauthClientRegistration}): a `client_id` is issued BY one
   * AS and means nothing to another, and a server-controlled discovery
   * document decides which AS we end up talking to.
   */
  issuer: string | null;
}

/** Pre-registered OAuth clients by provider key (see the loader). */
export type OauthClientRegistrations = ReadonlyMap<string, OauthClientRegistration>;

const OAUTH_CLIENT_PREFIX = "MCP_OAUTH_";
/**
 * `MCP_OAUTH_<PREFIX>_<FIELD>` — greedy prefix, anchored field suffix, so
 * `MCP_OAUTH_VERCEL_CLIENT_ID` backtracks to prefix `VERCEL` + `CLIENT_ID`
 * rather than prefix `VERCEL_CLIENT` + `ID`.
 */
const OAUTH_CLIENT_VAR = /^MCP_OAUTH_(.+)_(CLIENT_ID|CLIENT_SECRET|ISSUER)$/;

/** Fold a catalog `clientEnvPrefix`, a slug, or an env segment onto one key. */
function normalizeProviderKey(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("_", "-");
}

/**
 * Operator-supplied OAuth client credentials, for authorization servers that
 * gate dynamic client registration behind an approved-client allowlist rather
 * than serving open DCR (F2: Vercel's `registration_endpoint` answers every
 * DCR POST with `400 invalid_redirect_uri`, because it only accepts redirect
 * URIs belonging to clients Vercel has already approved — no tuning of the
 * request body can pass it). For those the broker must skip DCR entirely and
 * present an identity the AS issued out of band.
 *
 * The scheme is keyed so a deployment can configure several providers:
 *
 *     MCP_OAUTH_<PREFIX>_CLIENT_ID       required — the AS-issued client_id
 *     MCP_OAUTH_<PREFIX>_CLIENT_SECRET   optional — omit for a public client
 *     MCP_OAUTH_<PREFIX>_ISSUER          required — the AS issuer it is for
 *
 * `<PREFIX>` is the catalog entry's own `clientEnvPrefix`
 * (`packages/shared/src/connector-catalog.ts`, whose `preregisteredClientEnvVars`
 * renders the same two names for the UI and the preflight test); it is
 * env-shaped, so `-` is written `_` and the key normalizes back
 * (`MCP_OAUTH_HUGGING_FACE_CLIENT_ID` → key `hugging-face`).
 *
 * Fails fast on a half-configured provider (a secret or issuer with no client
 * id) and on an unrecognised `MCP_OAUTH_*` suffix — a typo'd credential var
 * that is silently ignored is a consent flow that mysteriously still 502s.
 * Problem strings name VARIABLES only, never values.
 */
export function loadOauthClientRegistrations(
  env: Env = process.env,
): OauthClientRegistrations {
  const problems: string[] = [];
  const fields = new Map<string, { id?: string; secret?: string; issuer?: string }>();

  for (const [name, rawValue] of Object.entries(env)) {
    if (!name.startsWith(OAUTH_CLIENT_PREFIX)) continue;
    const value = rawValue?.trim();
    if (!value) continue; // an empty var is "unset", as everywhere else here
    const matched = OAUTH_CLIENT_VAR.exec(name);
    if (matched === null) {
      problems.push(
        `${name} is not a recognised pre-registered OAuth client variable — expected ${OAUTH_CLIENT_PREFIX}<PREFIX>_CLIENT_ID, _CLIENT_SECRET or _ISSUER`,
      );
      continue;
    }
    const field = matched[2]!;
    const key = normalizeProviderKey(matched[1]!);
    const entry = fields.get(key) ?? {};
    if (field === "CLIENT_ID") entry.id = value;
    else if (field === "CLIENT_SECRET") entry.secret = value;
    else entry.issuer = value;
    fields.set(key, entry);
  }

  const registrations = new Map<string, OauthClientRegistration>();
  for (const [key, entry] of [...fields].sort(([a], [b]) => a.localeCompare(b))) {
    const envVar = (field: string) =>
      `${OAUTH_CLIENT_PREFIX}${key.toUpperCase().replaceAll("-", "_")}_${field}`;
    if (entry.id === undefined) {
      problems.push(
        `${envVar("CLIENT_ID")} is required when ${envVar(entry.secret !== undefined ? "CLIENT_SECRET" : "ISSUER")} is set`,
      );
      continue;
    }
    // REQUIRED, not optional. Without it the registration matches whatever
    // issuer discovery reports, so a repointed MCP server could nominate its
    // own authorization server and be handed a deployment-wide approved client
    // secret. Failing boot is the right trade: the value is a one-line addition
    // an operator already knows, and the alternative fails silently and open.
    if (entry.issuer === undefined) {
      problems.push(
        `${envVar("ISSUER")} is required when ${envVar("CLIENT_ID")} is set — a pre-registered client must be pinned to the authorization server that issued it`,
      );
      continue;
    }
    const issuer = canonicalIssuer(entry.issuer);
    if (issuer === null) {
      problems.push(`${envVar("ISSUER")} must be an absolute http(s) URL`);
      continue;
    }
    registrations.set(key, {
      key,
      clientId: entry.id,
      clientSecret: entry.secret ?? null,
      issuer,
    });
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return registrations;
}

/**
 * Resolve the pre-registered client for a flow, by provider key (a catalog
 * entry's `clientEnvPrefix` or slug) and/or the issuer discovery reported. The
 * key is tried first (a catalog preset names its own provider); the issuer is
 * the fallback, so a custom or registry
 * connection pointed at the same authorization server picks up the same
 * approved identity. A key whose registration is pinned to a DIFFERENT issuer
 * resolves to nothing rather than falling through — sending an approved
 * `client_id` to an authorization server it was not issued by is precisely the
 * AS mix-up the pin exists to prevent.
 */
export function findOauthClientRegistration(
  registrations: OauthClientRegistrations,
  match: {
    key?: string | null;
    issuer?: string | null;
    /**
     * Whether an issuer-only match may resolve a registration configured under
     * a DIFFERENT provider key. True for custom and registry connections, which
     * name no provider and legitimately pick up an approved identity for the
     * authorization server they point at. FALSE for a catalog preset that
     * declares `dynamic`: that entry states DCR or CIMD works here, and
     * silently substituting some other provider's operator credentials because
     * the two happen to share an issuer contradicts the declaration. The keyed
     * lookup is unaffected either way.
     */
    allowIssuerFallback?: boolean;
  },
): OauthClientRegistration | undefined {
  const issuer = match.issuer ? canonicalIssuer(match.issuer) : null;
  const key = match.key ? normalizeProviderKey(match.key) : "";
  if (key) {
    const byKey = registrations.get(key);
    if (byKey !== undefined) {
      // EXACT match, no fail-open. "Issuer unknown on either side" is not
      // evidence that the two agree, and this credential is AS-issued and
      // often deployment-wide. `_ISSUER` is required at load, so
      // `byKey.issuer` is never null here.
      return byKey.issuer !== null && byKey.issuer === issuer
        ? byKey
        : undefined;
    }
  }
  if (issuer === null || match.allowIssuerFallback === false) return undefined;
  for (const registration of registrations.values()) {
    if (registration.issuer === issuer) return registration;
  }
  return undefined;
}

/** Bare `scheme://host[:port]` for an absolute http(s) URL; null otherwise. */
function parseHttpOrigin(raw: string): string | null {
  const parsed = parseHttpUrl(raw);
  return parsed === null ? null : parsed.origin;
}

/**
 * RFC 8414 issuer identifiers are compared as strings, so canonicalize before
 * storing or comparing: origin + path, no trailing slash, no query/fragment
 * (the path matters — one host can serve several tenant issuers).
 */
function canonicalIssuer(raw: string): string | null {
  const parsed = parseHttpUrl(raw);
  if (parsed === null) return null;
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function parseHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.origin === "null" || parsed.hostname === "") return null;
  return parsed;
}
