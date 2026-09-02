/**
 * Control plane (Bun + Elysia).
 *
 * Wires: env config → drizzle/postgres-js → Better Auth (email/pw + orgs +
 * OIDC SSO) mounted at /api/auth → CORS with credentials → health endpoint →
 * workspace-scoping macro → Phase-1 runtime API (publish/build, sessions,
 * runs, SSE) when the runtime env is configured (see runtime/config.ts).
 *
 * The agent compiler is injected (tests use stubs); the production default
 * is `compileAgent` — the adapter over @invisible-string/compiler
 * (build/compiler-adapter.ts).
 */
import { cors } from "@elysiajs/cors";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import type { ConnectorCatalogEntry, Logger } from "@invisible-string/shared";

import { createAuth, type Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import {
  createDb,
  lockPoolSizeFromEnv,
  pipelineLockPoolSizeFromEnv,
  poolSizeFromEnv,
  type DbHandle,
} from "./db";
import { healthPlugin, type DeepHealthDeps } from "./health";
import { createLogger } from "./log";
import { requestLoggerPlugin } from "./request-log";
import { isWorkerLive, setAgentReservationTtlMs } from "./runtime/scheduler";
import { MetricsRegistry } from "./runtime/metrics";
import {
  createArtifactStore,
  type ArtifactStore,
} from "./artifacts";
import { compileAgent } from "./build/compiler-adapter";
import { type CompileAgentFn } from "./build/compiler-contract";
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
import {
  createDeliveryService,
  createDrizzleDeliveryReader,
} from "./runs/delivery";
import { createDrizzleRunStore } from "./runs/store";
import { RunTailerManager } from "./runs/tailer";
import { createGuardedFetch } from "./net/guarded-fetch";
import type { OauthBrokerDeps } from "./oauth/broker";
import {
  createPipelineRunner,
  loadPipelineRunnerConfig,
  type PipelineRunner,
  type StepExecutorRegistry,
} from "./pipeline/runner";
import { pipelinePlugin, type PipelineRouteDeps } from "./pipeline/routes";
import {
  createDrizzleRunStepStore,
  createDrizzleWorkflowStateStore,
} from "./pipeline/step-store";
import type { PipelineExecutorDeps } from "./pipeline/types";
import { executeAgentStep } from "./pipeline/steps/agent";
import { executeInferStep } from "./pipeline/steps/infer";
import { executeToolStep } from "./pipeline/steps/tool";
import { probeAndPersist } from "./probe/service";
import { resourcesPlugin } from "./resources/plugin";
import {
  createOpenRouterCatalog,
  type OpenRouterCatalog,
} from "./resources/openrouter-catalog";
import {
  createRegistryClient,
  REGISTRY_HOST,
  type RegistryClient,
} from "./resources/registry";
import type { ResourceDeps } from "./resources/common";
import {
  createMeiliClient,
  ensureRegistryIndex,
  type MeiliClient,
} from "./search/meili";
import { createRegistrySync, type RegistrySync } from "./search/registry-sync";
import {
  createPipelineRecoverySweeper,
  type PipelineRecoverySweeper,
} from "./pipeline/recovery";
import {
  loadOauthClientRegistrations,
  publicWebUrlFromEnv,
  tryLoadRuntimeConfig,
  type RuntimeConfig,
} from "./runtime/config";
import {
  createRemoteCancelSweeper,
  reconcileInterruptedRuns,
  type RemoteCancelSweeper,
} from "./runtime/reconcile";
import { publishAgentByName, runtimePlugin, type RuntimeDeps } from "./runtime/routes";
import { createScheduleTicker, type ScheduleTicker } from "./runtime/schedule-ticker";
import { createWorkerSweeper } from "./runtime/worker-sweeper";
import {
  createWorkerClient,
  ENSURE_AGENT_MAX_ATTEMPTS,
  type WorkerClient,
} from "./runtime/worker-client";
import { mintDispatchToken } from "@invisible-string/shared";
import { loadIntegrationsConfig, publicAppUrlFromEnv } from "./integrations/config";
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
  createFakeTransport,
  createModelTransport,
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
  /**
   * Pipeline interpreter (workflow-pipelines redesign) — present with the
   * runtime. Also carried on `runtime` as `pipelines` (the RuntimeDeps
   * intersection below) so dispatch/routes reach it through the deps graph.
   */
  pipelines: PipelineRunner | null;
  /** Present when the runtime API is configured (triggers/integrations). */
  integrations: IntegrationDeps | null;
  /**
   * Meilisearch client for the registry-search mirror — present only when
   * MEILISEARCH_URL + MEILISEARCH_MASTER_KEY are configured alongside the
   * runtime. Null = registry search degraded, never fatal (spec §5).
   */
  meili: MeiliClient | null;
  close(): Promise<void>;
}

/** Test seams for the runtime API (fakes for compiler/worker/steps/store). */
export interface RuntimeOverrides {
  runtimeConfig?: RuntimeConfig;
  compile?: CompileAgentFn;
  buildSteps?: BuildSteps;
  artifacts?: ArtifactStore;
  workerClient?: WorkerClient;
  /** MCP registry proxy client (stubbed in tests). */
  registry?: RegistryClient;
  /**
   * Connector catalog override (gated suites install synthetic recipes);
   * production always uses the checked-in, boot-validated JSON.
   */
  catalog?: ReadonlyMap<string, ConnectorCatalogEntry>;
  /** Slack Web API client (stubbed against a fake Slack server in tests). */
  slackClient?: SlackClient;
  /**
   * OpenRouter catalog lookup for allowlist validation + model capabilities
   * (stubbed in tests).
   */
  openRouterCatalog?: OpenRouterCatalog;
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
  /** Pipeline run/step/state/test routes — mounted beside the runtime API. */
  pipelineDeps?: PipelineRouteDeps | null;
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
  if (opts.pipelineDeps) {
    app.use(pipelinePlugin(opts.pipelineDeps));
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
  /** MCP OAuth consent broker — the mcp-oauth callback route runs on it. */
  oauthBroker: OauthBrokerDeps;
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
    oauthBroker: opts.oauthBroker,
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
  // Outbound reply delivery (Slack replies are posted by the CONTROL PLANE —
  // agent artifacts are trigger-agnostic and never see a bot token). Shares
  // the slackClient test override with the integrations plugin so a stubbed
  // Slack server observes both ingress reactions and delivered replies.
  const delivery = createDeliveryService({
    reader: createDrizzleDeliveryReader(db),
    runStore,
    slackClient:
      overrides?.slackClient ??
      createSlackClient({
        apiBaseUrl: env.SLACK_API_BASE_URL?.trim() || undefined,
      }),
    masterKey: config.encryptionMasterKey,
    logger,
    onOutcome: (outcome) => metrics.recordDelivery(outcome),
  });
  const tailers = new RunTailerManager({
    store: runStore,
    bus,
    maxWallClockMs: runtime.maxRunWallClockMs,
    remoteCancelObserveMs: runtime.remoteCancelObserveMs,
    logger,
    // Feed the run-duration histogram from every completed run (parked
    // `waiting` runs are not finished, so they are excluded), then settle any
    // pending outbound reply — deliver() no-ops for runs owing none and
    // never throws into the tailer.
    onFinish: (info) => {
      if (
        info.status === "succeeded" ||
        info.status === "failed" ||
        info.status === "canceled"
      ) {
        metrics.recordRunDuration(info.durationMs);
      }
      void delivery.deliver(info);
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
    compile: overrides?.compile ?? compileAgent,
    workerClient,
    runStore,
    bus,
    tailers,
    delivery,
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
  // Three pools (db.ts): the root pool for every query, plus one dedicated
  // lock pool per long-held advisory-lock family — the per-session dispatch
  // critical section and the per-run pipeline driver lock. A holder pins
  // one lock connection for its whole lifetime (an eve round-trip; a whole
  // pipeline run), and on a shared pool `max` such holders deadlock the
  // control plane waiting for a `max+1`th. The two lock families are kept
  // apart from each other too, so a pipeline burst never starves a Stop.
  const dbHandle = createDb(config.databaseUrl, {
    max: poolSizeFromEnv(env),
    lockMax: lockPoolSizeFromEnv(env),
    pipelineLockMax: pipelineLockPoolSizeFromEnv(env),
  });
  // The seeded-workspace publish kick needs the runtime graph, which is built
  // AFTER auth (workspace deps wrap the auth instance) — late-bind via a slot.
  const runtimeSlot: { current: RuntimeDeps | null } = { current: null };
  const auth = createAuth(config, dbHandle.db, {
    // Fire-and-forget: a brand-new workspace publishes its seeded
    // "General Purpose" agent so first chat needs no manual publish step
    // (design §5.8). Runtime unconfigured ⇒ no-op; failures log-and-continue
    // and never surface into the signup request.
    onWorkspaceSeeded: (organizationId) => {
      const runtime = runtimeSlot.current;
      if (!runtime) return;
      void publishAgentByName(runtime, organizationId, "General Purpose")
        .then((result) => {
          if (!result) {
            logger.warn("workspace.seed_agent_publish_skipped", {
              workspaceId: organizationId,
              fields: { reason: "seed agent not found" },
            });
            return;
          }
          logger.info("workspace.seed_agent_published", {
            workspaceId: organizationId,
            fields: {
              agentId: result.agentId,
              versionId: result.versionId,
              buildStatus: result.buildStatus,
            },
          });
        })
        .catch((error) => {
          logger.warn("workspace.seed_agent_publish_failed", {
            workspaceId: organizationId,
            err: error,
          });
        });
    },
  });
  const workspaceDeps = createWorkspaceDeps(auth, dbHandle.db);
  // Intersection type so the pipeline runner can be late-bound below the
  // same way `oauthTokens` is (RuntimeDeps is assignable to it; consumers of
  // the field read it off the runtime graph).
  const runtimeDeps: (RuntimeDeps & { pipelines?: PipelineRunner }) | null =
    createRuntimeDeps({
      env,
      config,
      db: dbHandle.db,
      workspaceDeps,
      logger,
      overrides: runtimeOverrides,
    });
  runtimeSlot.current = runtimeDeps;
  // Meilisearch registry-search mirror: constructed only when BOTH vars are
  // configured, and NEVER fatal — an unreachable Meilisearch degrades registry
  // search, nothing else (connectors redesign spec §5). The index bootstrap is
  // fire-and-forget; consumers find the index ready or degrade.
  let meili: MeiliClient | null = null;
  if (
    runtimeDeps?.runtime.meilisearchUrl &&
    runtimeDeps.runtime.meilisearchMasterKey
  ) {
    meili = createMeiliClient({
      url: runtimeDeps.runtime.meilisearchUrl,
      apiKey: runtimeDeps.runtime.meilisearchMasterKey,
    });
    void ensureRegistryIndex(meili).catch((error) => {
      logger.warn("search.meili_index_bootstrap_failed", {
        msg: "meilisearch registry index bootstrap failed — registry search degraded",
        err: error,
      });
    });
  }
  // ONE guarded egress fetch for every caller-influenced URL leaving the
  // control plane: MCP probes AND the whole OAuth broker (discovery, DCR,
  // token exchange) — a single egress policy, a single allow-private switch.
  const mcpEgressFetch = createGuardedFetch({
    allowPrivate: runtimeDeps?.runtime.mcpProbeAllowPrivate ?? false,
  });
  // MCP OAuth consent broker (oauth/broker.ts): the start routes ride the
  // resources plugin, the callback rides the integrations plugin — both run
  // on this one deps object. `probeConnection` closes over `resourceDeps`
  // (declared below) — it only runs after assembly, on post-connect probes,
  // and that probe now reads the grant's access token through the same deps
  // (probe/service.ts uses `ResourceDeps.oauthBroker` as its token lifecycle,
  // which is why teaching the probe about OAuth needed no new wiring here).
  const oauthBroker: OauthBrokerDeps = {
    db: dbHandle.db,
    masterKey: config.encryptionMasterKey,
    publicAppUrl: publicAppUrlFromEnv(env),
    // The SPA origin the consent popup posts its result to — the same value
    // as publicAppUrl in a single-origin deployment, and the whole point of
    // the setting when it is not (fix plan F8).
    publicWebUrl: publicWebUrlFromEnv(env),
    fetchImpl: mcpEgressFetch,
    logger,
    workspaceDeps,
    // Operator-supplied OAuth clients (MCP_OAUTH_<PREFIX>_*), for providers
    // whose authorization server refuses dynamic registration. Parsed at boot
    // so a typo'd credential var fails fast instead of surfacing as a 502 in
    // the middle of a consent flow.
    preregisteredClients: loadOauthClientRegistrations(env),
    probeConnection: (connection) => probeAndPersist(resourceDeps, connection),
    // Same catalog the resource routes install from — the broker reads a
    // preset's declared client-identity strategy from it.
    ...(runtimeOverrides?.catalog ? { catalog: runtimeOverrides.catalog } : {}),
  };
  // The runtime plugin's agent-facing token route (POST /internal/connections/
  // token) refreshes through the SAME lifecycle deps the broker runs on — one
  // egress policy, one master key. Late-bound onto the runtime deps because
  // the broker assembles after createRuntimeDeps has returned.
  if (runtimeDeps) runtimeDeps.oauthTokens = oauthBroker;
  // Pipeline interpreter (workflow-pipelines redesign): constructed beside
  // the broker because tool steps ride the SAME guarded egress fetch and
  // token lifecycle. Late-bound onto the runtime deps like `oauthTokens` so
  // dispatch, the schedule ticker and the pipeline routes all reach it
  // through the one deps graph.
  let pipelineRunner: PipelineRunner | null = null;
  let pipelineRouteDeps: PipelineRouteDeps | null = null;
  if (runtimeDeps) {
    // Executor registry for tool/infer/agent steps (pipeline/steps/*). The
    // object is shared BY REFERENCE with the runner, so kinds registered
    // after construction are picked up; a kind with no registered executor
    // fails its step `executor_unavailable` rather than crashing the run.
    // The `agent` executor reaches the dispatch machinery through the
    // `runtimeDeps` handed to executorDeps below.
    const stepExecutors: StepExecutorRegistry = {
      tool: executeToolStep,
      infer: executeInferStep,
      agent: executeAgentStep,
    };
    // One executor dependency graph, shared between the runner and the
    // pipeline routes' per-step test (both execute the same executors, so
    // they must see the same egress fetch / oauth broker / provider keys).
    const pipelineExecutorDeps: PipelineExecutorDeps = {
      db: dbHandle.db,
      logger,
      masterKey: config.encryptionMasterKey,
      fetchImpl: mcpEgressFetch,
      oauthTokens: oauthBroker,
      providerKeys: {
        ...(runtimeDeps.runtime.openrouterApiKey
          ? { openrouterApiKey: runtimeDeps.runtime.openrouterApiKey }
          : {}),
        ...(runtimeDeps.runtime.anthropicApiKey
          ? { anthropicApiKey: runtimeDeps.runtime.anthropicApiKey }
          : {}),
        ...(runtimeDeps.runtime.openrouterBaseUrl
          ? { openrouterBaseUrl: runtimeDeps.runtime.openrouterBaseUrl }
          : {}),
      },
      runtimeDeps,
    };
    pipelineRunner = createPipelineRunner({
      db: dbHandle.db,
      runStore: runtimeDeps.runStore,
      stepStore: createDrizzleRunStepStore(dbHandle.db),
      stateStore: createDrizzleWorkflowStateStore(dbHandle.db),
      bus: runtimeDeps.bus,
      logger,
      executors: stepExecutors,
      executorDeps: pipelineExecutorDeps,
      config: loadPipelineRunnerConfig(env),
      workspaceRunCap: runtimeDeps.runtime.maxConcurrentRunsPerWorkspace,
      metrics: runtimeDeps.metrics,
      ...(runtimeDeps.delivery ? { delivery: runtimeDeps.delivery } : {}),
    });
    runtimeDeps.pipelines = pipelineRunner;
    pipelineRouteDeps = {
      db: dbHandle.db,
      workspaceDeps,
      logger,
      executorDeps: pipelineExecutorDeps,
    };
  }
  const integrationDeps = createIntegrationDeps({
    env,
    runtimeDeps,
    slackClient: runtimeOverrides?.slackClient,
    oauthBroker,
  });
  const resourceDeps: ResourceDeps = {
    db: dbHandle.db,
    workspaceDeps,
    auth,
    masterKey: config.encryptionMasterKey,
    compile: runtimeOverrides?.compile ?? compileAgent,
    // Skill attachments live in the same object store as build artifacts.
    artifacts: runtimeDeps?.artifacts,
    registry:
      runtimeOverrides?.registry ??
      createRegistryClient({ baseUrl: env.MCP_REGISTRY_BASE_URL }),
    // Community search rides the Meilisearch mirror; null keeps the route on
    // its typed 503 degradation (connectors spec §5).
    meili,
    // Advisory allowlist-add validation + reasoning/context capabilities from
    // OpenRouter's public model catalog (fail-open when unreachable — see
    // resources/openrouter-catalog.ts).
    openRouterCatalog:
      runtimeOverrides?.openRouterCatalog ?? createOpenRouterCatalog(),
    // Guarded egress for MCP probes — the ONLY fetch caller-influenced URLs
    // ride (SSRF containment: DNS-validated, IP-pinned, redirect-re-validated).
    // MCP_PROBE_ALLOW_PRIVATE (dev/e2e/self-hosted) admits private targets and
    // plain http; a runtime-less boot keeps the hardened default. The same
    // instance backs the OAuth broker above.
    probeFetch: mcpEgressFetch,
    oauthBroker,
    ...(runtimeOverrides?.catalog ? { catalog: runtimeOverrides.catalog } : {}),
    logger,
  };
  // Copilot socket: mounted whenever a transport is available — a scripted
  // fake (COPILOT_FAKE_SCRIPT / test override; dev/test ONLY — loadCopilotConfig
  // drops the fake script under NODE_ENV=production so it can never displace
  // the real model path in prod) or the real model path when a provider key
  // exists. Keyless boots simply do not expose /copilot.
  const copilotConfig = loadCopilotConfig(env);
  const copilotTransport: CopilotTransport | null =
    runtimeOverrides?.copilotTransport ??
    (copilotConfig.fakeScript
      ? createFakeTransport(copilotConfig.fakeScript)
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
        // Same catalog instance as the resource routes — one cache, so a
        // copilot turn does not re-fetch what a settings load just warmed.
        openRouterCatalog: resourceDeps.openRouterCatalog,
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
    pipelineDeps: pipelineRouteDeps,
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
    pipelines: pipelineRunner,
    integrations: integrationDeps,
    meili,
    close: async () => {
      // Interrupt pipeline drivers WITHOUT terminal writes (their runs are
      // re-adopted by the next boot's recovery), then drain the tailers.
      await pipelineRunner?.stopAll();
      await runtimeDeps?.tailers.stopAll();
      await dbHandle.close();
    },
  };
}

/**
 * Bun.serve transport options (Elysia forwards these verbatim).
 *
 * - maxRequestBodySize: refuse oversized uploads before buffering — the
 *   largest legitimate body is a skill attachment (see resources/plugin.ts
 *   SKILL_UPLOAD_MAX_BODY_BYTES); mirrors nginx client_max_body_size.
 * - idleTimeout 0: Bun's default (~10s of socket inactivity) kills quiet
 *   run-stream SSE tails mid-response (heartbeats default to 15s) and cuts
 *   chat dispatches that await a cold agent boot before writing headers,
 *   surfacing as gateway 502s. The worker disables it for the same reason
 *   (apps/worker/src/server.ts); nginx/the edge proxy own the real timeouts.
 */
export const BUN_SERVE_OPTIONS = {
  maxRequestBodySize: 8 * 1024 * 1024,
  idleTimeout: 0,
} as const;

if (import.meta.main) {
  const stack = createAppStack();
  const { logger } = stack;
  stack.app.listen({
    port: stack.config.port,
    ...BUN_SERVE_OPTIONS,
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

  let scheduleTicker: ScheduleTicker | null = null;
  let remoteCancelSweeper: RemoteCancelSweeper | null = null;
  let pipelineRecoverySweeper: PipelineRecoverySweeper | null = null;
  let registrySync: RegistrySync | null = null;
  if (stack.runtime) {
    // Adopt or fail runs orphaned in queued/running by a previous crash —
    // they hold cap slots and hang SSE streams forever otherwise. Pipeline
    // runs are re-driven from their step ledgers (pipeline/recovery.ts). The
    // delivery sweep settles TERMINAL runs stranded with a pending Slack
    // reply: succeeded ones deliver late (at-least-once), failed/canceled
    // ones settle the ledger (see runs/delivery.ts).
    void reconcileInterruptedRuns(stack.runtime, {
      delivery: stack.runtime.delivery,
      ...(stack.pipelines ? { pipelines: stack.pipelines } : {}),
    })
      .then(({ resumed, failed, sessionsClosed, remoteCancels, pipelines, deliveries }) => {
        if (
          resumed > 0 ||
          failed > 0 ||
          sessionsClosed > 0 ||
          remoteCancels.settled > 0 ||
          remoteCancels.deferred > 0 ||
          remoteCancels.retained > 0 ||
          remoteCancels.observing > 0 ||
          remoteCancels.unresolved > 0 ||
          pipelines.resumed > 0 ||
          pipelines.failed > 0 ||
          deliveries.delivered > 0 ||
          deliveries.failed > 0
        ) {
          logger.info("run.reconciled", {
            msg: `run reconciliation: resumed ${resumed} tail(s), failed ${failed} orphaned run(s), closed ${sessionsClosed} abandoned eveless session(s), finished ${remoteCancels.settled} pending remote cancel(s) (${remoteCancels.observing} observing, ${remoteCancels.deferred} deferred, ${remoteCancels.retained} retained, ${remoteCancels.unresolved} unresolved), re-drove ${pipelines.resumed} pipeline run(s), recovered ${deliveries.delivered} stranded deliver(y/ies)`,
            fields: { resumed, failed, sessionsClosed, remoteCancels, pipelines, deliveries },
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
    // Schedule ticker: fires due cron workflows from the control plane
    // (compiled schedules are dead in production — spike finding 6). Safe
    // multi-instance via per-trigger advisory locks; SCHEDULE_TICK_MS tunes
    // the scan cadence.
    scheduleTicker = createScheduleTicker(stack.runtime, {
      tickMs: stack.runtime.runtime.scheduleTickMs,
    });
    scheduleTicker.start();
    // Remote-cancel sweeper: re-runs boot reconciliation's pending-remote-
    // cancel sweep every REMOTE_CANCEL_SWEEP_MS so a Stop whose confirmation
    // is still owed (a crashed observation tail, an unreachable worker, a
    // held lock) is re-observed by a HEALTHY process, not the next restart —
    // and so an obligation past REMOTE_CANCEL_OBSERVE_MS is declared
    // unresolved. Replica-safe: advisory-try-locked scan, per-session
    // dispatch lock per candidate, one observation tail per session.
    remoteCancelSweeper = createRemoteCancelSweeper(stack.runtime, {
      intervalMs: stack.runtime.runtime.remoteCancelSweepMs,
    });
    remoteCancelSweeper.start();
    // Pipeline-recovery sweeper: re-runs boot reconciliation's interrupted-
    // pipeline adoption every PIPELINE_RECOVERY_SWEEP_MS so an orphan left
    // `locked` at boot (pipeline lock pool exhausted, or a driver that died
    // in another replica) is re-driven by a HEALTHY process instead of
    // holding its cap slot until the next restart. Replica-safe: advisory-
    // try-locked scan, and adoption itself is gated on the per-run driver
    // lock (an acquirable lock proves no live driver owns the run).
    if (stack.pipelines) {
      pipelineRecoverySweeper = createPipelineRecoverySweeper(
        {
          db: stack.dbHandle.db,
          runner: stack.pipelines,
          logger: logger.child({ fields: { component: "pipeline-recovery" } }),
        },
        { intervalMs: stack.runtime.runtime.pipelineRecoverySweepMs },
      );
      pipelineRecoverySweeper.start();
    }
    // Registry→Meilisearch sync ETL: mirrors the official MCP registry into
    // the disposable search index (immediate full/incremental run, then
    // REGISTRY_SYNC_INTERVAL_MS cadence). Only when the meili client exists —
    // without it registry search is degraded and there is nothing to feed.
    // Multi-instance safe via a single advisory try-lock.
    if (stack.meili) {
      registrySync = createRegistrySync({
        db: stack.dbHandle.db,
        meili: stack.meili,
        // Same dev/CI-only override seam as the registry proxy client.
        registryBaseUrl:
          process.env.MCP_REGISTRY_BASE_URL?.trim() || REGISTRY_HOST,
        logger: logger.child({ fields: { component: "registry-sync" } }),
        intervalMs: stack.runtime.runtime.registrySyncIntervalMs,
      });
      registrySync.start();
    }
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
    void Promise.all([
      scheduleTicker?.stop(),
      remoteCancelSweeper?.stop(),
      pipelineRecoverySweeper?.stop(),
      registrySync?.stop(),
    ])
      .then(() => stack.close())
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
