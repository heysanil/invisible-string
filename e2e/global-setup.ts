/**
 * Playwright global setup — stands up the FULL real stack, zero manual steps:
 *
 *   docker compose (postgres · garage · dex · meilisearch, project p2e2e)
 *     → fresh product DB + migrations + demo seed (bun)
 *     → production build of the SPA (VITE_API_URL baked)
 *     → managed processes: stub MCP · control-plane · worker · vite preview
 *     → readiness gates on every one, then a gate on the registry→Meilisearch
 *       sync (the community-search specs need the stub server indexed).
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
  REGISTRY_SERVER_NAME,
  REGISTRY_SERVER_TITLE,
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
  sleep,
  spawnManaged,
  waitForHttp,
  type ManagedProcess,
} from "./support/process.ts";

/** `<mise install dir for the node pinned in mise.toml>/bin`, or null if it
 *  can't be resolved. Config-driven (`where node`), never fuzzy
 *  (`where node@24`) — the fuzzy form resolves to the newest 24.x mise knows
 *  about, which may not be the version mise.toml pins. */
function resolveNode24Bin(): string | null {
  const result = spawnSync("mise", ["where", "node"], { encoding: "utf8" });
  const dir = result.status === 0 ? result.stdout.trim() : "";
  return dir ? `${dir}/bin` : null;
}

function composeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    POSTGRES_PORT: String(PORTS.postgres),
    GARAGE_PORT: String(PORTS.garage),
    DEX_PORT: String(PORTS.dex),
    MEILISEARCH_PORT: String(PORTS.meilisearch),
  };
}

/**
 * Gate on the registry→Meilisearch sync: poll the control plane's OWN search
 * route until the stub registry server is indexed. The route requires a
 * session, so mint a throwaway account through Better Auth's REST API first
 * (the Origin header must be a trusted origin — the SPA preview origin is).
 */
async function waitForRegistrySync(): Promise<void> {
  const signup = await fetch(`${API_BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PREVIEW_URL },
    body: JSON.stringify({
      name: "E2E sync probe",
      email: `e2e-sync-probe-${randomUUID().slice(0, 8)}@example.com`,
      password: "correct-horse-battery-staple",
    }),
  });
  if (!signup.ok) {
    throw new Error(`registry-sync probe signup failed: ${signup.status}`);
  }
  const cookie = signup.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0])
    .join("; ");
  if (cookie.length === 0) {
    throw new Error("registry-sync probe signup returned no session cookie");
  }

  // First sync fires at control-plane boot and may race the stub's listen;
  // REGISTRY_SYNC_INTERVAL_MS=5000 retries it quickly, so poll generously.
  const search = `${API_BASE_URL}/mcp-registry/search?q=${encodeURIComponent(REGISTRY_SERVER_TITLE)}`;
  const deadline = Date.now() + 120_000;
  let last = "no attempt made";
  for (;;) {
    try {
      const res = await fetch(search, {
        headers: { cookie },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          results?: Array<{ name?: string }>;
        };
        if (body.results?.some((r) => r.name === REGISTRY_SERVER_NAME)) return;
        last = `indexed ${body.results?.length ?? 0} results, stub server absent`;
      } else {
        last = `status ${res.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the registry→Meilisearch sync to index the stub server (last: ${last})`,
      );
    }
    await sleep(1_000);
  }
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

  console.log("[e2e:setup] docker compose up (postgres, garage, dex, meilisearch)…");
  compose(["up", "-d", "--wait", "postgres", "garage", "dex", "meilisearch"]);

  // Node powers the eve build + agent runtime. Warm the version mise.toml
  // pins (idempotent), then resolve its bin dir so we can pin it on the
  // control-plane + worker PATH. Pinning node 24 FIRST on PATH makes the whole
  // subtree deterministic — a bare `node`/`npx` (e.g. a nested spawn) can never
  // fall through to a system node 22 (eve requires >=24). `install node` reads
  // the version from mise.toml; `install node@24` would resolve to the newest
  // 24.x instead, which the build steps' "newest installed 24.x" resolver would
  // then prefer over the pin. Untrusted config fails loudly here — run
  // `mise trust` once per checkout.
  run("mise", ["install", "node"], { cwd: REPO_ROOT });
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

  console.log("[e2e:setup] waiting for the registry→Meilisearch sync…");
  await waitForRegistrySync();

  console.log(
    `[e2e:setup] stack ready in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(api ${API_BASE_URL}, ui ${PREVIEW_URL})`,
  );
}
