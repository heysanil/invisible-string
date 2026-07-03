/**
 * Control plane (Bun + Elysia).
 *
 * Wires: env config → drizzle/postgres-js → Better Auth (email/pw + orgs +
 * OIDC SSO) mounted at /api/auth → CORS with credentials → health endpoint →
 * workspace-scoping macro → Phase-1 runtime API (publish/build, sessions,
 * runs, SSE) when the runtime env is configured (see runtime/config.ts).
 *
 * The workflow compiler is injected (tests use stubs); the production
 * default is `compileWorkflow` — the adapter over @invisible-string/compiler
 * (build/compiler-adapter.ts).
 */
import { cors } from "@elysiajs/cors";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import type { Logger } from "@invisible-string/shared";

import { createAuth, type Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import { createDb, type DbHandle } from "./db";
import { healthPlugin, type DeepHealthDeps } from "./health";
import { createLogger } from "./log";
import { requestLoggerPlugin } from "./request-log";
import { isWorkerLive, setAgentReservationTtlMs } from "./runtime/scheduler";
import { MetricsRegistry } from "./runtime/metrics";
import {
  createArtifactStore,
  type ArtifactStore,
} from "./artifacts";
import { compileWorkflow } from "./build/compiler-adapter";
import { type CompileWorkflowFn } from "./build/compiler-contract";
import {
  BuildService,
  createDrizzleBuildStore,
} from "./build/service";
import {
  createBuildSteps,
  createSetupDatabaseRunner,
  type BuildSteps,
} from "./build/steps";
import { createWorldProvisioner, worldDatabaseExists } from "./build/world";
import { RunEventBus } from "./runs/bus";
import { createDrizzleRunStore } from "./runs/store";
import { RunTailerManager } from "./runs/tailer";
import { resourcesPlugin } from "./resources/plugin";
import {
  createOpenRouterCatalog,
  type OpenRouterModelIds,
} from "./resources/openrouter-catalog";
import { createRegistryClient, type RegistryClient } from "./resources/registry";
import type { ResourceDeps } from "./resources/common";
import { tryLoadRuntimeConfig, type RuntimeConfig } from "./runtime/config";
import { reconcileInterruptedRuns } from "./runtime/reconcile";
import { runtimePlugin, type RuntimeDeps } from "./runtime/routes";
import { createWorkerSweeper } from "./runtime/worker-sweeper";
import {
  createWorkerClient,
  ENSURE_AGENT_MAX_ATTEMPTS,
  type WorkerClient,
} from "./runtime/worker-client";
import { mintDispatchToken } from "@invisible-string/shared";
import { loadIntegrationsConfig } from "./integrations/config";
import { FixedWindowRateLimiter } from "./integrations/rate-limit";
import { integrationsPlugin, type IntegrationDeps } from "./integrations/routes";
import { createSlackClient, type SlackClient } from "./integrations/slack-client";
import { SlackEventDedup } from "./integrations/slack-verify";
import { loadCopilotConfig } from "./copilot/config";
import {
  copilotPlugin,
  createCopilotDeps,
  type CopilotDeps,
} from "./copilot/plugin";
import {
  createModelTransport,
  createScriptedTransport,
  parseFakeScript,
  type CopilotTransport,
} from "./copilot/transport";
import {
  createWorkspaceDeps,
  workspacePlugin,
  type WorkspaceDeps,
} from "./workspace";

export interface AppStack {
  app: ReturnType<typeof buildApp>;
  auth: Auth;
  config: Config;
  dbHandle: DbHandle;
  /** Process-wide structured logger (redaction-safe). */
  logger: Logger;
  /** Present when the runtime API is configured (see runtime/config.ts). */
  runtime: RuntimeDeps | null;
  /** Present when the runtime API is configured (triggers/integrations). */
  integrations: IntegrationDeps | null;
  close(): Promise<void>;
}

/** Test seams for the runtime API (fakes for compiler/worker/steps/store). */
export interface RuntimeOverrides {
  runtimeConfig?: RuntimeConfig;
  compile?: CompileWorkflowFn;
  buildSteps?: BuildSteps;
  artifacts?: ArtifactStore;
  workerClient?: WorkerClient;
  /** MCP registry proxy client (stubbed in tests). */
  registry?: RegistryClient;
  /** Slack Web API client (stubbed against a fake Slack server in tests). */
  slackClient?: SlackClient;
  /** OpenRouter catalog lookup for allowlist validation (stubbed in tests). */
  openRouterModelIds?: OpenRouterModelIds;
  /** Copilot LLM transport (scripted fake in tests). */
  copilotTransport?: CopilotTransport;
}

/** Assemble the Elysia app from already-constructed pieces (testable). */
export function buildApp(opts: {
  config: Config;
  auth: Auth;
  workspaceDeps: WorkspaceDeps;
  resourceDeps: ResourceDeps;
  runtimeDeps?: RuntimeDeps | null;
  integrationDeps?: IntegrationDeps | null;
  /** Copilot WS deps — the `/copilot` socket mounts when present. */
  copilotDeps?: CopilotDeps | null;
  /** Deep-health probes for `GET /api/health?deep=1` (absent ⇒ shallow only). */
  health?: DeepHealthDeps;
  /** When set, a request-scoped logger threads a per-request correlation id. */
  logger?: Logger;
}) {
  const { config, auth, workspaceDeps, resourceDeps } = opts;
  const app = new Elysia()
    // Security-response headers on EVERY response (defense-in-depth backstop):
    // the API is a JSON/SSE surface that should never be framed, sniffed, or
    // leak a referrer. CSP `default-src 'self'` + `frame-ancestors 'none'`
    // closes clickjacking of any authenticated surface; HSTS is opt-in (TLS).
    .onRequest(({ set }) => {
      set.headers["content-security-policy"] =
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
      set.headers["x-frame-options"] = "DENY";
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["referrer-policy"] = "no-referrer";
      if (config.hstsEnabled) {
        set.headers["strict-transport-security"] =
          "max-age=63072000; includeSubDomains";
      }
    })
    .use(
      cors({
        origin: config.corsOrigins,
        credentials: true,
      }),
    );
  // Request-scoped correlation: mint/propagate a requestId, thread a bound
  // child logger, and close each request with one `http.request` line.
  if (opts.logger) app.use(requestLoggerPlugin(opts.logger));
  app
    // Better Auth owns everything under its basePath (/api/auth).
    .mount(auth.handler)
    .use(workspacePlugin(workspaceDeps))
    // Liveness by default (`{ ok: true }`, no IO). `?deep=1` runs the readiness
    // probe (DB + object store + a live worker) and answers 503 when any
    // dependency is degraded, so a load balancer drains this instance.
    .use(healthPlugin(opts.health))
    // Phase-2 product CRUD (works without the runtime env; skill uploads that
    // need the object store fail cleanly when it is unconfigured).
    .use(resourcesPlugin(resourceDeps));
  if (opts.runtimeDeps) {
    app.use(runtimePlugin(opts.runtimeDeps));
  }
  if (opts.integrationDeps) {
    app.use(integrationsPlugin(opts.integrationDeps));
  }
  if (opts.copilotDeps) {
    app.use(copilotPlugin(opts.copilotDeps));
  }
  return app;
}

/**
 * Construct the trigger-ingress + integrations dependency graph. Null when the
 * runtime is unconfigured (ingress dispatch needs workers + artifacts). The
 * Slack app itself stays optional (see loadIntegrationsConfig) — webhook/form
 * ingress works without it.
 */
export function createIntegrationDeps(opts: {
  env: Record<string, string | undefined>;
  runtimeDeps: RuntimeDeps | null;
  slackClient?: SlackClient;
}): IntegrationDeps | null {
  const { env, runtimeDeps } = opts;
  if (!runtimeDeps) return null;
  const config = loadIntegrationsConfig(env, runtimeDeps.runtime.platformJwtSecret);
  const perMinute = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    runtime: runtimeDeps,
    config,
    slackClient:
      opts.slackClient ??
      createSlackClient({ apiBaseUrl: config.slack?.apiBaseUrl }),
    tokenRateLimiter: new FixedWindowRateLimiter({
      limit: perMinute("TRIGGER_RATE_LIMIT_PER_TOKEN_PER_MIN", 60),
      windowMs: 60_000,
    }),
    ipRateLimiter: new FixedWindowRateLimiter({
      limit: perMinute("TRIGGER_RATE_LIMIT_PER_IP_PER_MIN", 120),
      windowMs: 60_000,
    }),
    slackDedup: new SlackEventDedup(),
  };
}

/** Construct the runtime dependency graph (null when unconfigured). */
export function createRuntimeDeps(opts: {
  env: Record<string, string | undefined>;
  config: Config;
  db: DbHandle["db"];
  workspaceDeps: WorkspaceDeps;
  logger: Logger;
  overrides?: RuntimeOverrides;
}): RuntimeDeps | null {
  const { env, config, db, workspaceDeps, logger, overrides } = opts;
  const runtime = overrides?.runtimeConfig ?? tryLoadRuntimeConfig(env);
  if (!runtime) return null;

  const artifacts = overrides?.artifacts ?? createArtifactStore(runtime.s3);
  const buildStore = createDrizzleBuildStore(db);
  const worldProvisioner = createWorldProvisioner({
    worldDatabaseUrl: runtime.worldDatabaseUrl,
    runSetupDatabase: createSetupDatabaseRunner(),
  });
  const steps =
    overrides?.buildSteps ??
    createBuildSteps({
      runtime,
      provisionWorld: async (hash, projectDir) => {
        await worldProvisioner.ensure(hash, projectDir);
      },
    });
  const buildService = new BuildService({
    steps,
    store: buildStore,
    artifacts,
    buildRoot: runtime.buildRoot,
    worldExists: overrides?.buildSteps
      ? undefined // faked steps ⇒ no real world server to probe
      : (hash) => worldDatabaseExists(runtime.worldDatabaseUrl, hash),
  });
  const workerClient =
    overrides?.workerClient ??
    createWorkerClient({
      workerSharedSecret: runtime.workerSharedSecret,
      allowInsecureWorkerTransport: runtime.allowInsecureWorkerTransport,
      // ensure-agent pulls + boots the agent synchronously; a COLD first
      // boot can exceed a fixed 60s (WORKER_REQUEST_TIMEOUT_MS, default 120s
      // — observed >60s on the keyed acceptance's first real-model boot).
      requestTimeoutMs: runtime.workerRequestTimeoutMs,
      // Per-worker dispatch tokens when the worker plane runs in worker-token
      // mode (Phase-3 identity); the bootstrap secret is still sent alongside
      // so the modes interoperate during rollout.
      mintDispatchToken:
        runtime.workerAuthMode === "worker-token"
          ? (workerId) =>
              mintDispatchToken(runtime.workerSharedSecret, workerId).token
          : undefined,
    });
  // Placement reservations must outlive the worker-client's whole ensure
  // budget (timeout × attempts) or concurrent cold placements over-place
  // onto a still-booting worker once the reservation lapses.
  setAgentReservationTtlMs(
    runtime.workerRequestTimeoutMs * ENSURE_AGENT_MAX_ATTEMPTS,
  );
  const runStore = createDrizzleRunStore(db);
  const bus = new RunEventBus();
  const metrics = new MetricsRegistry();
  const tailers = new RunTailerManager({
    store: runStore,
    bus,
    maxWallClockMs: runtime.maxRunWallClockMs,
    logger,
    // Feed the run-duration histogram from every completed run (parked
    // `waiting` runs are not finished, so they are excluded).
    onFinish: ({ status, durationMs }) => {
      if (status === "succeeded" || status === "failed" || status === "canceled") {
        metrics.recordRunDuration(durationMs);
      }
    },
  });

  return {
    db,
    runtime,
    masterKey: config.encryptionMasterKey,
    workspaceDeps,
    artifacts,
    buildService,
    buildStore,
    compile: overrides?.compile ?? compileWorkflow,
    workerClient,
    runStore,
    bus,
    tailers,
    metrics,
    logger,
  };
}

/** Count workers eligible to take work right now (deep-health probe). */
async function countLiveWorkers(
  db: DbHandle["db"],
  heartbeatTtlMs: number,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .select({
      id: schema.workers.id,
      address: schema.workers.address,
      status: schema.workers.status,
      lastHeartbeatAt: schema.workers.lastHeartbeatAt,
    })
    .from(schema.workers)
    .where(eq(schema.workers.status, "live"));
  return rows.filter((row) => isWorkerLive(row, now, heartbeatTtlMs)).length;
}

/** Construct the full stack from environment configuration. */
export function createAppStack(
  env: Record<string, string | undefined> = process.env,
  runtimeOverrides?: RuntimeOverrides,
): AppStack {
  const config = loadConfig(env);
  const logger = createLogger({ env });
  const dbHandle = createDb(config.databaseUrl);
  const auth = createAuth(config, dbHandle.db);
  const workspaceDeps = createWorkspaceDeps(auth, dbHandle.db);
  const runtimeDeps = createRuntimeDeps({
    env,
    config,
    db: dbHandle.db,
    workspaceDeps,
    logger,
    overrides: runtimeOverrides,
  });
  const integrationDeps = createIntegrationDeps({
    env,
    runtimeDeps,
    slackClient: runtimeOverrides?.slackClient,
  });
  const resourceDeps: ResourceDeps = {
    db: dbHandle.db,
    workspaceDeps,
    auth,
    masterKey: config.encryptionMasterKey,
    compile: runtimeOverrides?.compile ?? compileWorkflow,
    // Skill attachments live in the same object store as build artifacts.
    artifacts: runtimeDeps?.artifacts,
    registry:
      runtimeOverrides?.registry ??
      createRegistryClient({ baseUrl: env.MCP_REGISTRY_BASE_URL }),
    // Advisory allowlist-add validation against OpenRouter's public model
    // catalog (fail-open when unreachable — resources/openrouter-catalog.ts).
    openRouterModelIds:
      runtimeOverrides?.openRouterModelIds ?? createOpenRouterCatalog(),
  };
  // Copilot socket: mounted whenever a transport is available — a scripted
  // fake (COPILOT_FAKE_SCRIPT / test override) or the real model path when a
  // provider key exists. Keyless boots simply do not expose /copilot.
  const copilotConfig = loadCopilotConfig(env);
  const copilotTransport: CopilotTransport | null =
    runtimeOverrides?.copilotTransport ??
    (copilotConfig.fakeScript
      ? createScriptedTransport(parseFakeScript(copilotConfig.fakeScript))
      : (
            copilotConfig.provider === "anthropic"
              ? env.ANTHROPIC_API_KEY
              : env.OPENROUTER_API_KEY
          )
        ? createModelTransport(copilotConfig, env)
        : null);
  const copilotDeps: CopilotDeps | null = copilotTransport
    ? createCopilotDeps({
        db: dbHandle.db,
        workspaceDeps,
        config: copilotConfig,
        transport: copilotTransport,
      })
    : null;
  // Deep-health probes: DB always; object store + live-worker count only when
  // the runtime is configured (a Phase-0-style boot degrades to the DB check).
  const health: DeepHealthDeps = {
    pingDb: async () => {
      await dbHandle.sql`select 1`;
    },
    ...(runtimeDeps
      ? {
          pingObjectStore: async () => {
            // `exists` on a probe key round-trips to the store; a missing key
            // returns false (reachable = healthy), an unreachable store throws.
            await runtimeDeps.artifacts.exists("artifacts/__health_probe__");
          },
          countLiveWorkers: () =>
            countLiveWorkers(
              dbHandle.db,
              runtimeDeps.runtime.workerHeartbeatTtlMs,
            ),
        }
      : {}),
  };
  const app = buildApp({
    config,
    auth,
    workspaceDeps,
    resourceDeps,
    runtimeDeps,
    integrationDeps,
    copilotDeps,
    health,
    logger,
  });
  return {
    app,
    auth,
    config,
    dbHandle,
    logger,
    runtime: runtimeDeps,
    integrations: integrationDeps,
    close: async () => {
      await runtimeDeps?.tailers.stopAll();
      await dbHandle.close();
    },
  };
}

if (import.meta.main) {
  const stack = createAppStack();
  const { logger } = stack;
  // Cap the request body at the transport (Bun.serve) so oversized uploads are
  // refused before buffering — the largest legitimate body is a skill
  // attachment (see resources/plugin.ts SKILL_UPLOAD_MAX_BODY_BYTES).
  stack.app.listen({
    port: stack.config.port,
    maxRequestBodySize: 8 * 1024 * 1024,
  });
  // One structured "ready" line with the resolved config. `fields` is
  // redaction-safe — every value here is non-secret, and the logger scrubs
  // anything secret-shaped as a backstop (never the auth/encryption secrets).
  logger.info("control-plane.ready", {
    msg: `control-plane listening on :${stack.config.port}`,
    fields: {
      port: stack.config.port,
      runtimeApi: stack.runtime !== null,
      corsOrigins: stack.config.corsOrigins,
      requireEmailVerification: stack.config.requireEmailVerification,
      hstsEnabled: stack.config.hstsEnabled,
      encryptionConfigured: stack.config.encryptionMasterKey !== undefined,
    },
  });

  if (stack.runtime) {
    // Adopt or fail runs orphaned in queued/running by a previous crash —
    // they hold cap slots and hang SSE streams forever otherwise.
    void reconcileInterruptedRuns(stack.runtime)
      .then(({ resumed, failed }) => {
        if (resumed > 0 || failed > 0) {
          logger.info("run.reconciled", {
            msg: `run reconciliation: resumed ${resumed} tail(s), failed ${failed} orphaned run(s)`,
            fields: { resumed, failed },
          });
        }
      })
      .catch((error) => {
        logger.error("run.reconcile_failed", { err: error });
      });
    // Dead-worker sweeper: heartbeat TTL → dead, clear parked-session affinity,
    // reschedule + re-tail interrupted runs on a live worker. Failover events
    // are structured one-JSON-per-line with correlation ids (never bare
    // console strings) — they are the highest-value operational logs.
    const sweeper = createWorkerSweeper(stack.runtime, {
      logger: logger.child({ fields: { component: "sweeper" } }),
      log: (message) => logger.info("sweeper.pass", { msg: message }),
    });
    sweeper.start();
  }

  // Graceful shutdown (SIGTERM/SIGINT): stop accepting new connections, drain
  // live NDJSON tailers, and close the Postgres pool (stack.close). Idempotent.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("control-plane.shutdown", {
      msg: `${signal} — draining`,
      fields: { signal },
    });
    stack.app.server?.stop();
    void stack
      .close()
      .catch((error) => {
        logger.error("control-plane.shutdown_failed", { err: error });
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
