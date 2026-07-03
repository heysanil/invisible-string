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
import {
  createDockerCliClient,
  createSandboxReaper,
  type SandboxReaper,
} from "./sandbox-reaper";
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
  /** Present when SANDBOX_REAPER_ENABLED=1 (needs docker); null otherwise. */
  readonly sandboxReaper: SandboxReaper | null;
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
      runningHashes: agents.list().map((a) => a.hash),
    }),
    log,
    // Fenced by the control plane (heartbeat 404 — marked dead / unknown): our
    // runs may already be failed over to another worker. Stop every local
    // agent BEFORE re-registering so one version hash never executes on two
    // workers against its shared world DB (single-writer-per-hash contract).
    onFenced: async () => {
      log("fenced by control plane — stopping all local agents before re-register");
      await agents.stopAll();
    },
  });

  // Per-eve-session proxy activity: stamped by the HTTP surface on every
  // proxied session call, joined by the sandbox reaper to the container's
  // `eve.session` label so an actively-used sandbox is NEVER stopped at the
  // 30-min mark (design correction 4 is an IDLE window, not a lifetime cap).
  const sessionActivity = new Map<string, number>();
  const SESSION_ACTIVITY_MAX = 10_000;
  const noteSessionActivity = (eveSessionId: string): void => {
    if (sessionActivity.size >= SESSION_ACTIVITY_MAX && !sessionActivity.has(eveSessionId)) {
      const oldest = sessionActivity.keys().next().value;
      if (oldest !== undefined) sessionActivity.delete(oldest);
    }
    sessionActivity.delete(eveSessionId); // re-insert to refresh iteration order
    sessionActivity.set(eveSessionId, Date.now());
  };

  // Sandbox reaper (design correction 4): eve sandboxes have no idle timeout,
  // so the worker stops docker containers labelled by eve session that have
  // been IDLE past the window (idle = no proxied session activity since the
  // later of container start / last proxy call). Off by default (needs docker).
  const sandboxReaper: SandboxReaper | null = config.sandboxReaperEnabled
    ? createSandboxReaper({
        docker: createDockerCliClient({
          dockerBin: config.dockerBin,
          labelKey: config.sandboxLabelKey,
          log,
        }),
        idleStopMs: config.sandboxIdleStopMs,
        activityOf: (session) => sessionActivity.get(session),
        log,
      })
    : null;
  sandboxReaper?.start();

  let draining = false;
  let drainPromise: Promise<void> | null = null;

  function drain(): Promise<void> {
    drainPromise ??= (async () => {
      draining = true;
      log("draining: refusing new ensures/requests, waiting for in-flight…");
      // FIRST: tell the control plane (status → draining) so the scheduler
      // stops routing new sessions here at t≈0 — otherwise every dispatch
      // during the in-flight wait would hit our 503 and fail a user run.
      await registration.beginDrain();
      agents.stopIdleReaper();
      sandboxReaper?.stop();
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
    sandboxCount: () => sandboxReaper?.lastScanCount() ?? 0,
    onSessionActivity: noteSessionActivity,
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
    sandboxReaper,
    isDraining: () => draining,
    drain,
    async stop(): Promise<void> {
      draining = true;
      agents.stopIdleReaper();
      sandboxReaper?.stop();
      registration.stop();
      server.stop();
      await agents.stopAll();
    },
  };
}
