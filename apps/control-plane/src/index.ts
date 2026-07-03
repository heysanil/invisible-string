/**
 * Control plane (Bun + Elysia).
 *
 * Wires: env config → drizzle/postgres-js → Better Auth (email/pw + orgs +
 * OIDC SSO) mounted at /api/auth → CORS with credentials → health endpoint →
 * workspace-scoping macro → Phase-1 runtime API (publish/build, sessions,
 * runs, SSE) when the runtime env is configured (see runtime/config.ts).
 *
 * NOTE(integration): the workflow compiler is injected. Until
 * packages/compiler lands its real `compile`, the default is
 * `compilerNotIntegrated` (typed compile error) — wire the adapter here at
 * the Integrate stage (see build/compiler-contract.ts).
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
import {
  compilerNotIntegrated,
  type CompileWorkflowFn,
} from "./build/compiler-contract";
import {
  BuildService,
  createDrizzleBuildStore,
} from "./build/service";
import {
  createBuildSteps,
  createSetupDatabaseRunner,
  type BuildSteps,
} from "./build/steps";
import { createWorldProvisioner } from "./build/world";
import { RunEventBus } from "./runs/bus";
import { createDrizzleRunStore } from "./runs/store";
import { RunTailerManager } from "./runs/tailer";
import { tryLoadRuntimeConfig, type RuntimeConfig } from "./runtime/config";
import { runtimePlugin, type RuntimeDeps } from "./runtime/routes";
import {
  createWorkerClient,
  type WorkerClient,
} from "./runtime/worker-client";
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
  close(): Promise<void>;
}

/** Test seams for the runtime API (fakes for compiler/worker/steps/store). */
export interface RuntimeOverrides {
  runtimeConfig?: RuntimeConfig;
  compile?: CompileWorkflowFn;
  buildSteps?: BuildSteps;
  artifacts?: ArtifactStore;
  workerClient?: WorkerClient;
}

/** Assemble the Elysia app from already-constructed pieces (testable). */
export function buildApp(opts: {
  config: Config;
  auth: Auth;
  workspaceDeps: WorkspaceDeps;
  runtimeDeps?: RuntimeDeps | null;
}) {
  const { config, auth, workspaceDeps } = opts;
  const app = new Elysia()
    .use(
      cors({
        origin: config.corsOrigins,
        credentials: true,
      }),
    )
    // Better Auth owns everything under its basePath (/api/auth).
    .mount(auth.handler)
    .use(workspacePlugin(workspaceDeps))
    .get("/api/health", () => ({ ok: true }));
  if (opts.runtimeDeps) {
    app.use(runtimePlugin(opts.runtimeDeps));
  }
  return app;
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
  });
  const workerClient =
    overrides?.workerClient ??
    createWorkerClient({ workerSharedSecret: runtime.workerSharedSecret });
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
    compile: overrides?.compile ?? compilerNotIntegrated,
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
  const app = buildApp({ config, auth, workspaceDeps, runtimeDeps });
  return {
    app,
    auth,
    config,
    dbHandle,
    runtime: runtimeDeps,
    close: async () => {
      await runtimeDeps?.tailers.stopAll();
      await dbHandle.close();
    },
  };
}

if (import.meta.main) {
  const stack = createAppStack();
  stack.app.listen(stack.config.port);
  console.log(
    `control-plane listening on :${stack.config.port}${stack.runtime ? " (runtime API enabled)" : " (runtime API disabled — set WORLD_DATABASE_URL/PLATFORM_JWT_SECRET/WORKER_SHARED_SECRET/S3_*)"}`,
  );
}
