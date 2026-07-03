/**
 * Playwright global teardown — kill every managed child (control-plane,
 * worker, vite preview, stub MCP) then bring the compose stack down. Reaps
 * any agent the worker may have left behind. Best-effort throughout: teardown
 * must never fail a green run.
 */
import { AGENT_ROOT, COMPOSE_PROJECT, PORTS, REPO_ROOT } from "./config.ts";
import {
  killPid,
  loadState,
  run,
  runQuiet,
  sleep,
} from "./support/process.ts";

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_REUSE === "1") {
    console.log("[e2e:teardown] E2E_REUSE=1 — leaving the stack running");
    return;
  }
  const state = loadState();

  for (const proc of state?.processes ?? []) {
    console.log(`[e2e:teardown] stopping ${proc.name} (pid ${proc.pid})`);
    killPid(proc.pid);
  }

  // Give the worker's drain path a moment to SIGTERM its agents, then hard-reap
  // any survivors squatting the port pool.
  await sleep(3_000);
  runQuiet("pkill", ["-9", "-f", `${AGENT_ROOT}/`], REPO_ROOT);

  try {
    run(
      "docker",
      ["compose", "-p", COMPOSE_PROJECT, "down", "-v"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          POSTGRES_PORT: String(PORTS.postgres),
          MINIO_PORT: String(PORTS.minio),
          MINIO_CONSOLE_PORT: String(PORTS.minioConsole),
          DEX_PORT: String(PORTS.dex),
        },
      },
    );
  } catch (error) {
    console.warn("[e2e:teardown] compose down failed (ignored):", error);
  }
}
