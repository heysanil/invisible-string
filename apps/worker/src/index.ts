/**
 * Worker supervisor v1 (docs/PLAN.md Phase 1 task 4).
 *
 * Boot: parse env → start HTTP surface (internal API + agent proxy) →
 * register with the control plane and heartbeat every 10s.
 * SIGTERM/SIGINT: drain (stop accepting ensures, finish in-flight proxied
 * requests, stop agents, deregister) then exit.
 */
export {
  AgentBootError,
  createAgentManager,
  type AgentInfo,
  type AgentManager,
  type EnsureAgentInput,
  type EnsureAgentResult,
} from "./agents";
export {
  agentEntrypoint,
  ArtifactError,
  createArtifactCache,
  type ArtifactCache,
  type CacheEntry,
} from "./cache";
export { ConfigError, loadConfig, type WorkerConfig } from "./config";
export { createPortPool, PortPoolExhaustedError, type PortPool } from "./ports";
export {
  createRegistration,
  type Registration,
  type RegisterWorkerBody,
  type WorkerCapacity,
} from "./registration";
export {
  createDockerCliClient,
  createSandboxReaper,
  selectIdleSandboxes,
  type DockerClient,
  type SandboxContainer,
  type SandboxReaper,
  type SweepResult,
} from "./sandbox-reaper";
export {
  CALLBACK_PREFIX,
  createWorkerServer,
  FORWARDED_PREFIXES,
  PUBLIC_FORWARDED_PREFIXES,
  type EnsureAgentResponse,
  type WorkerStatusResponse,
} from "./server";
export { createSupervisor, type Supervisor } from "./supervisor";

import { loadConfig } from "./config";
import { createSupervisor } from "./supervisor";

if (import.meta.main) {
  const config = loadConfig();
  const supervisor = createSupervisor(config);
  supervisor.registration.start();
  console.log(
    `[worker ${config.workerId}] listening on :${supervisor.server.port} (public ${config.publicUrl}, cache ${config.artifactCacheDir}, agent ports ${config.agentPortMin}-${config.agentPortMax})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker ${config.workerId}] ${signal} — draining`);
    void supervisor
      .drain()
      .catch((err) => {
        console.error(`[worker ${config.workerId}] drain failed:`, err);
      })
      .finally(() => {
        supervisor.server.stop();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
