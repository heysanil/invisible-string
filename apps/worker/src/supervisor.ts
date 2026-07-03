/**
 * Supervisor v1 — composes the artifact cache, agent process manager, HTTP
 * surface (internal API + streaming proxy), and control-plane registration.
 * Single-worker semantics, but every piece (port pool, LRU cache, drain,
 * heartbeat capacity counts) is multi-agent/multi-worker ready for Phase 3.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { Logger } from "@invisible-string/shared";

import { createAgentManager, type AgentManager } from "./agents";
import { createArtifactCache, type ArtifactCache } from "./cache";
import type { WorkerConfig } from "./config";
import { createLogger, stringLogAdapter } from "./log";
import { createPortPool, type PortPool } from "./ports";
import { createRegistration, type Registration } from "./registration";
import { createWorkerServer, type WorkerServer } from "./server";

export interface Supervisor {
  readonly config: WorkerConfig;
  readonly server: WorkerServer;
  /** Structured logger bound to this worker's id (lifecycle events). */
  readonly logger: Logger;
  /** Local base URL of this worker's HTTP surface (tests use this). */
  readonly url: string;
  /**
   * Per-boot secret gating the `/cb/:token/agents/:hash/.well-known/…`
   * run-callback route (only the co-located world queue holds it, via
   * WORKFLOW_LOCAL_BASE_URL). Exposed for tests.
   */
  readonly callbackToken: string;
  readonly agents: AgentManager;
  readonly cache: ArtifactCache;
  readonly ports: PortPool;
  readonly registration: Registration;
  isDraining(): boolean;
  /**
   * Graceful drain (SIGTERM path): stop accepting ensures and new proxied
   * requests, wait for in-flight requests to finish (bounded by
   * drainTimeoutMs), stop all agents, deregister. Idempotent.
   */
  drain(): Promise<void>;
  /** Hard teardown for tests: stops timers, agents, and the HTTP server. */
  stop(): Promise<void>;
}

export function createSupervisor(
  config: WorkerConfig,
  options: { logger?: Logger } = {},
): Supervisor {
  // Bind the worker id to every line; the string adapter upgrades the many
  // detailed internal log calls (agents/cache/registration/proxy) to
  // structured JSON without touching each call site. Redaction runs in the
  // logger core, so a stray secret in a message is scrubbed.
  const logger = options.logger ?? createLogger({ base: { workerId: config.workerId } });
  const log = stringLogAdapter(logger);

  mkdirSync(config.artifactCacheDir, { recursive: true });

  // Per-boot callback secret: agents get it via WORKFLOW_LOCAL_BASE_URL; the
  // proxy's /cb/:token route verifies it before forwarding run callbacks.
  const callbackToken = randomBytes(24).toString("base64url");

  const ports = createPortPool(config.agentPortMin, config.agentPortMax);

  // Two-phase wiring: the cache's eviction guard needs the agent manager.
  // isActive (running OR booting) — an artifact being extracted for a boot
  // in progress must never be evicted out from under its own spawn.
  let agentsRef: AgentManager | null = null;
  const cache = createArtifactCache({
    dir: config.artifactCacheDir,
    maxBytes: config.artifactCacheMaxBytes,
    isRunning: (hash) => agentsRef?.isActive(hash) ?? false,
    log,
  });

  const agents = createAgentManager({ config, cache, ports, callbackToken, log });
  agentsRef = agents;
  agents.startIdleReaper();

  const registration = createRegistration({
    config,
    snapshot: () => ({
      runningAgents: agents.list().length,
      activeRequests: agents.totalInflight(),
    }),
    log,
  });

  let draining = false;
  let drainPromise: Promise<void> | null = null;

  function drain(): Promise<void> {
    drainPromise ??= (async () => {
      draining = true;
      log("draining: refusing new ensures/requests, waiting for in-flight…");
      agents.stopIdleReaper();
      const deadline = Date.now() + config.drainTimeoutMs;
      while (agents.totalInflight() > 0 && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      if (agents.totalInflight() > 0) {
        log(
          `drain timeout after ${config.drainTimeoutMs}ms with ${agents.totalInflight()} request(s) still in flight — stopping anyway`,
        );
      }
      await agents.stopAll();
      registration.stop();
      await registration.deregister();
      log("drain complete");
    })();
    return drainPromise;
  }

  const server = createWorkerServer({
    config,
    agents,
    cache,
    ports,
    callbackToken,
    isDraining: () => draining,
    requestDrain: () => void drain(),
    log,
  });

  return {
    config,
    server,
    logger,
    url: server.url,
    callbackToken,
    agents,
    cache,
    ports,
    registration,
    isDraining: () => draining,
    drain,
    async stop(): Promise<void> {
      draining = true;
      agents.stopIdleReaper();
      registration.stop();
      server.stop();
      await agents.stopAll();
    },
  };
}
