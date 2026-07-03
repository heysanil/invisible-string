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
export {
  createLogger,
  jsonLineSink,
  resolveLogLevel,
  stringLogAdapter,
} from "./log";
export { createPortPool, PortPoolExhaustedError, type PortPool } from "./ports";
export {
  createRegistration,
  type Registration,
  type RegisterWorkerBody,
  type WorkerCapacity,
} from "./registration";
export {
  CALLBACK_PREFIX,
  createWorkerServer,
  FORWARDED_PREFIXES,
  PUBLIC_FORWARDED_PREFIXES,
  type EnsureAgentResponse,
  type WorkerHealthResponse,
  type WorkerStatusResponse,
} from "./server";
export { createSupervisor, type Supervisor } from "./supervisor";

import { loadConfig } from "./config";
import { createSupervisor } from "./supervisor";

if (import.meta.main) {
  const config = loadConfig();
  const supervisor = createSupervisor(config);
  const { logger } = supervisor;
  supervisor.registration.start();
  // One structured "ready" line with the resolved config (all non-secret; the
  // worker's shared secret + per-agent env never appear here).
  logger.info("worker.ready", {
    msg: `worker listening on :${supervisor.server.port}`,
    fields: {
      port: supervisor.server.port,
      publicUrl: config.publicUrl,
      controlPlaneUrl: config.controlPlaneUrl,
      cacheDir: config.artifactCacheDir,
      cacheMaxBytes: config.artifactCacheMaxBytes,
      agentPortMin: config.agentPortMin,
      agentPortMax: config.agentPortMax,
      maxAgents: config.maxAgents,
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("worker.shutdown", { msg: `${signal} — draining`, fields: { signal } });
    void supervisor
      .drain()
      .catch((err) => {
        logger.error("worker.drain_failed", { err });
      })
      .finally(() => {
        supervisor.server.stop();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
