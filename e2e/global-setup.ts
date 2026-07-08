/**
 * Playwright global setup — stands up the FULL real stack, zero manual steps:
 *
 *   docker compose (postgres · garage · dex, project p2e2e)
 *     → fresh product DB + migrations + demo seed (bun)
 *     → production build of the SPA (VITE_API_URL baked)
 *     → managed processes: stub MCP · control-plane · worker · vite preview
 *     → readiness gates on every one.
 *
 * All child PIDs are recorded to .runtime/state.json for global-teardown to
 * kill. Runs under Node; DB work is delegated to a bun subprocess (Bun SQL +
 * workspace imports live there, not here).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { FullConfig } from "@playwright/test";

import {
  AGENT_ROOT,
  API_BASE_URL,
  COMPOSE_PROJECT,
  PORTS,
  PREVIEW_URL,
  REPO_ROOT,
  STUB_MCP_URL,
  WORKER_URL,
  controlPlaneEnv,
  workerEnv,
} from "./config.ts";
import {
  ensureRuntimeDir,
  run,
  runQuiet,
  saveState,
  spawnManaged,
  waitForHttp,
  type ManagedProcess,
} from "./support/process.ts";

/** `<mise install dir for node@24>/bin`, or null if it can't be resolved. */
function resolveNode24Bin(): string | null {
  const result = spawnSync("mise", ["where", "node@24"], { encoding: "utf8" });
  const dir = result.status === 0 ? result.stdout.trim() : "";
  return dir ? `${dir}/bin` : null;
}

function composeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    POSTGRES_PORT: String(PORTS.postgres),
    GARAGE_PORT: String(PORTS.garage),
    DEX_PORT: String(PORTS.dex),
  };
}

function compose(args: string[]): void {
  run("docker", ["compose", "-p", COMPOSE_PROJECT, ...args], {
    cwd: REPO_ROOT,
    env: composeEnv(),
  });
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const started = Date.now();
  ensureRuntimeDir();

  // Reuse mode (local iteration): if the stack is already serving, skip the
  // whole bring-up. Pair with E2E_REUSE on teardown to leave it running.
  if (process.env.E2E_REUSE === "1") {
    const alive = await fetch(`${API_BASE_URL}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) {
      console.log("[e2e:setup] E2E_REUSE=1 and stack is live — skipping bring-up");
      return;
    }
  }

  mkdirSync(AGENT_ROOT, { recursive: true });

  // Reap any agent left squatting the worker's port pool by a crashed run.
  runQuiet("pkill", ["-9", "-f", `${AGENT_ROOT}/`], REPO_ROOT);

  console.log("[e2e:setup] docker compose up (postgres, garage, dex)…");
  compose(["up", "-d", "--wait", "postgres", "garage", "dex"]);

  // node@24 powers the eve build + agent runtime (mise). Warm it (idempotent),
  // then resolve its bin dir so we can pin it on the control-plane + worker
  // PATH. `mise exec node@24` is what the build actually invokes, but pinning
  // node 24 FIRST on PATH makes the whole subtree deterministic — a bare
  // `node`/`npx` (e.g. a nested spawn) can never fall through to a system
  // node 22 (eve requires >=24, and mise-exec activation proved flaky).
  run("mise", ["install", "node@24"], { cwd: REPO_ROOT });
  const node24Bin = resolveNode24Bin();

  console.log("[e2e:setup] resetting product DB + migrating + seeding (bun)…");
  run("bun", ["e2e/scripts/db-setup.ts"], { cwd: REPO_ROOT });

  console.log("[e2e:setup] building the SPA (vite) with API baked in…");
  run("bun", ["run", "build"], {
    cwd: `${REPO_ROOT}/apps/web`,
    env: {
      ...process.env,
      VITE_API_URL: API_BASE_URL,
      VITE_FIXTURE_MODE: "",
    },
  });

  const processes: ManagedProcess[] = [];
  // Node 24 first on PATH for the runtime processes (build + agent boot).
  const pinnedPath = node24Bin
    ? `${node24Bin}:${process.env.PATH ?? ""}`
    : process.env.PATH;
  const fullEnv = (extra: Record<string, string | undefined>) => ({
    ...process.env,
    PATH: pinnedPath,
    ...extra,
  });

  console.log("[e2e:setup] starting stub MCP · control-plane · worker · preview…");
  processes.push(
    spawnManaged("stub-mcp", "bun", ["e2e/scripts/stub-mcp.ts"], {
      cwd: REPO_ROOT,
      env: fullEnv({}),
    }),
  );
  processes.push(
    spawnManaged("control-plane", "bun", ["apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: fullEnv(controlPlaneEnv()),
    }),
  );
  const workerId = randomUUID();
  processes.push(
    spawnManaged("worker", "bun", ["apps/worker/src/index.ts"], {
      cwd: REPO_ROOT,
      env: fullEnv(workerEnv(workerId)),
    }),
  );
  processes.push(
    spawnManaged(
      "preview",
      "bun",
      [
        "x",
        "vite",
        "preview",
        "--port",
        String(PORTS.preview),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: `${REPO_ROOT}/apps/web`, env: fullEnv({}) },
    ),
  );

  saveState({ processes, composeProject: COMPOSE_PROJECT });

  console.log("[e2e:setup] waiting for readiness…");
  await waitForHttp(`${API_BASE_URL}/api/health`, {
    timeoutMs: 60_000,
    expectOk: true,
  });
  await waitForHttp(`http://127.0.0.1:${PORTS.stubMcp}/__calls`, {
    timeoutMs: 20_000,
    expectOk: true,
  });
  await waitForHttp(`${WORKER_URL}/healthz`, {
    timeoutMs: 60_000,
    expectOk: true,
  });
  await waitForHttp(PREVIEW_URL, { timeoutMs: 60_000, expectOk: true });

  console.log(
    `[e2e:setup] stack ready in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(api ${API_BASE_URL}, ui ${PREVIEW_URL})`,
  );
}
