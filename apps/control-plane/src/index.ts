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
import { Elysia } from "elysia";

import { createAuth, type Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import { createDb, type DbHandle } from "./db";
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
import { createRegistryClient, type RegistryClient } from "./resources/registry";
import type { ResourceDeps } from "./resources/common";
import { tryLoadRuntimeConfig, type RuntimeConfig } from "./runtime/config";
import { reconcileInterruptedRuns } from "./runtime/reconcile";
import { runtimePlugin, type RuntimeDeps } from "./runtime/routes";
import {
  createWorkerClient,
  type WorkerClient,
} from "./runtime/worker-client";
import { loadIntegrationsConfig } from "./integrations/config";
import { FixedWindowRateLimiter } from "./integrations/rate-limit";
import { integrationsPlugin, type IntegrationDeps } from "./integrations/routes";
import { createSlackClient, type SlackClient } from "./integrations/slack-client";
import { SlackEventDedup } from "./integrations/slack-verify";
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
}

/** Assemble the Elysia app from already-constructed pieces (testable). */
export function buildApp(opts: {
  config: Config;
  auth: Auth;
  workspaceDeps: WorkspaceDeps;
  resourceDeps: ResourceDeps;
  runtimeDeps?: RuntimeDeps | null;
  integrationDeps?: IntegrationDeps | null;
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
    )
    // Better Auth owns everything under its basePath (/api/auth).
    .mount(auth.handler)
    .use(workspacePlugin(workspaceDeps))
    .get("/api/health", () => ({ ok: true }))
    // Phase-2 product CRUD (works without the runtime env; skill uploads that
    // need the object store fail cleanly when it is unconfigured).
    .use(resourcesPlugin(resourceDeps));
  if (opts.runtimeDeps) {
    app.use(runtimePlugin(opts.runtimeDeps));
  }
  if (opts.integrationDeps) {
    app.use(integrationsPlugin(opts.integrationDeps));
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
  overrides?: RuntimeOverrides;
}): RuntimeDeps | null {
  const { env, config, db, workspaceDeps, overrides } = opts;
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
    });
  const runStore = createDrizzleRunStore(db);
  const bus = new RunEventBus();
  const tailers = new RunTailerManager({
    store: runStore,
    bus,
    maxWallClockMs: runtime.maxRunWallClockMs,
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
  };
}

/** Construct the full stack from environment configuration. */
export function createAppStack(
  env: Record<string, string | undefined> = process.env,
  runtimeOverrides?: RuntimeOverrides,
): AppStack {
  const config = loadConfig(env);
  const dbHandle = createDb(config.databaseUrl);
  const auth = createAuth(config, dbHandle.db);
  const workspaceDeps = createWorkspaceDeps(auth, dbHandle.db);
  const runtimeDeps = createRuntimeDeps({
    env,
    config,
    db: dbHandle.db,
    workspaceDeps,
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
  };
  const app = buildApp({
    config,
    auth,
    workspaceDeps,
    resourceDeps,
    runtimeDeps,
    integrationDeps,
  });
  return {
    app,
    auth,
    config,
    dbHandle,
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
  // Cap the request body at the transport (Bun.serve) so oversized uploads are
  // refused before buffering — the largest legitimate body is a skill
  // attachment (see resources/plugin.ts SKILL_UPLOAD_MAX_BODY_BYTES).
  stack.app.listen({
    port: stack.config.port,
    maxRequestBodySize: 8 * 1024 * 1024,
  });
  console.log(
    `control-plane listening on :${stack.config.port}${stack.runtime ? " (runtime API enabled)" : " (runtime API disabled — set WORLD_DATABASE_URL/PLATFORM_JWT_SECRET/WORKER_SHARED_SECRET/S3_*)"}`,
  );
  if (stack.runtime) {
    // Adopt or fail runs orphaned in queued/running by a previous crash —
    // they hold cap slots and hang SSE streams forever otherwise.
    void reconcileInterruptedRuns(stack.runtime)
      .then(({ resumed, failed }) => {
        if (resumed > 0 || failed > 0) {
          console.log(
            `run reconciliation: resumed ${resumed} tail(s), failed ${failed} orphaned run(s)`,
          );
        }
      })
      .catch((error) => {
        console.error("run reconciliation failed:", error);
      });
  }
}
