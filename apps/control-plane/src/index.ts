/**
 * Control plane (Bun + Elysia) — Phase 0 skeleton.
 *
 * Wires: env config → drizzle/postgres-js → Better Auth (email/pw + orgs +
 * OIDC SSO) mounted at /api/auth → CORS with credentials → health endpoint →
 * workspace-scoping macro for future product routes.
 *
 * Phase 1 adds the compiler invocation, `eve build` + artifact upload,
 * scheduler, dispatcher, and the runtime API.
 */
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { createAuth, type Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import { createDb, type DbHandle } from "./db";
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
  close(): Promise<void>;
}

/** Assemble the Elysia app from already-constructed pieces (testable). */
export function buildApp(opts: {
  config: Config;
  auth: Auth;
  workspaceDeps: WorkspaceDeps;
}) {
  const { config, auth, workspaceDeps } = opts;
  return new Elysia()
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
}

/** Construct the full stack from environment configuration. */
export function createAppStack(
  env: Record<string, string | undefined> = process.env,
): AppStack {
  const config = loadConfig(env);
  const dbHandle = createDb(config.databaseUrl);
  const auth = createAuth(config, dbHandle.db);
  const app = buildApp({
    config,
    auth,
    workspaceDeps: createWorkspaceDeps(auth, dbHandle.db),
  });
  return {
    app,
    auth,
    config,
    dbHandle,
    close: () => dbHandle.close(),
  };
}

if (import.meta.main) {
  const stack = createAppStack();
  stack.app.listen(stack.config.port);
  console.log(`control-plane listening on :${stack.config.port}`);
}
