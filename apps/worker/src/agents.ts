/**
 * Agent process manager — spawns compiled eve agents from extracted
 * artifacts, tracks readiness/activity/in-flight requests, stops idle
 * processes, and cleans up on unexpected exits.
 *
 * Launch semantics follow spike/REPORT.md exactly:
 * - finding 6: `eve start` is just a CLI wrapper that spawns
 *   `node .output/server/index.mjs` — the supervisor launches that entrypoint
 *   directly (Node 24) so it owns the real listener process, and additionally
 *   spawns it detached so the whole process group can be signalled.
 * - finding 5: `NODE_ENV=test` silently switches eve to a mock model — the
 *   supervisor pins `NODE_ENV=production` (callers may override explicitly).
 * - env isolation: the child env is caller-provided env + PORT on a minimal
 *   base (PATH/HOME/LANG/TMPDIR). Nothing else leaks from the supervisor —
 *   secrets discipline lives in what the control plane sends, not here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { agentEntrypoint, type ArtifactCache } from "./cache";
import type { WorkerConfig } from "./config";
import type { PortPool } from "./ports";

export class AgentBootError extends Error {
  override readonly name = "AgentBootError";
  constructor(
    hash: string,
    reason: string,
    public readonly logTail: string,
  ) {
    super(`agent ${hash} failed to boot: ${reason}`);
  }
}

export type AgentState = "ready" | "stopping";

/** Public snapshot of one running agent (never includes its env). */
export interface AgentInfo {
  hash: string;
  port: number;
  state: AgentState;
  startedAt: number;
  lastActivityAt: number;
  inflight: number;
}

export interface EnsureAgentInput {
  versionHash: string;
  artifactUrl: string;
  /** Injected into the agent process (provider key, world DB URL, JWT secret, MCP tokens…). */
  env?: Record<string, string>;
}

export interface EnsureAgentResult extends AgentInfo {
  /** True when the agent was already running (no new process spawned). */
  reused: boolean;
}

interface AgentHandle {
  hash: string;
  port: number;
  child: ChildProcess;
  state: AgentState;
  startedAt: number;
  lastActivityAt: number;
  inflight: number;
  logPath: string;
  exited: Promise<void>;
}

export interface AgentManager {
  ensureAgent(input: EnsureAgentInput): Promise<EnsureAgentResult>;
  stopAgent(hash: string): Promise<void>;
  /** Await pending boots, then stop every running agent. */
  stopAll(): Promise<void>;
  /** Running-agent lookup for the proxy. */
  get(hash: string): AgentInfo | undefined;
  /** Running OR currently booting — cache eviction guard (never evict these). */
  isActive(hash: string): boolean;
  /** Running + boot-in-flight agents (authoritative local capacity gauge). */
  activeCount(): number;
  list(): AgentInfo[];
  totalInflight(): number;
  /** Proxy request lifecycle — keeps idle/drain bookkeeping accurate. */
  beginRequest(hash: string): boolean;
  endRequest(hash: string): void;
  startIdleReaper(): void;
  stopIdleReaper(): void;
}

export function createAgentManager(options: {
  config: Pick<
    WorkerConfig,
    | "artifactCacheDir"
    | "agentIdleStopMs"
    | "agentReadyTimeoutMs"
    | "agentStopTimeoutMs"
    | "nodeBin"
    | "publicUrl"
  >;
  cache: ArtifactCache;
  ports: PortPool;
  /**
   * Per-boot secret authorizing `/.well-known/workflow/*` callbacks through
   * the proxy (server.ts `/cb/<token>/agents/...`). Only the co-located
   * world queue — which gets it via WORKFLOW_LOCAL_BASE_URL — knows it, so
   * external clients cannot forge run callbacks (security review).
   */
  callbackToken: string;
  log?: (message: string) => void;
}): AgentManager {
  const { config, cache, ports, callbackToken } = options;
  const log = options.log ?? (() => {});

  const running = new Map<string, AgentHandle>();
  const pending = new Map<string, Promise<EnsureAgentResult>>();
  let inflightTotal = 0;
  let reaper: ReturnType<typeof setInterval> | null = null;

  const logsDir = join(config.artifactCacheDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  function toInfo(h: AgentHandle): AgentInfo {
    return {
      hash: h.hash,
      port: h.port,
      state: h.state,
      startedAt: h.startedAt,
      lastActivityAt: h.lastActivityAt,
      inflight: h.inflight,
    };
  }

  /** Caller env + PORT on a minimal base — nothing else inherited. */
  function agentEnv(
    hash: string,
    callerEnv: Record<string, string> | undefined,
    port: number,
  ): Record<string, string> {
    const env: Record<string, string> = {
      NODE_ENV: "production",
      // Run callbacks (`/.well-known/workflow/v1/*`) must traverse the same
      // ingress as clients (spike/REPORT.md finding 9) — point the workflow
      // queue at this worker's own proxy base for the agent, on the
      // token-authenticated callback route (the public /agents/:hash surface
      // refuses `.well-known` so external clients cannot forge step/flow
      // callbacks). Caller env may override (test harnesses).
      WORKFLOW_LOCAL_BASE_URL: `${config.publicUrl}/cb/${callbackToken}/agents/${hash}`,
    };
    for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, callerEnv);
    env.PORT = String(port); // supervisor-owned; wins over caller env
    return env;
  }

  function killTree(handle: AgentHandle, signal: NodeJS.Signals): void {
    const pid = handle.child.pid;
    try {
      if (pid !== undefined) {
        // Detached spawn → the agent is its own process-group leader; signal
        // the whole group (spike/REPORT.md finding 6: orphaned listeners).
        process.kill(-pid, signal);
        return;
      }
    } catch {
      // fall through to direct kill
    }
    try {
      handle.child.kill(signal);
    } catch {
      // already gone
    }
  }

  async function waitExit(handle: AgentHandle, timeoutMs: number): Promise<boolean> {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([
      handle.exited.then(() => true),
      timedOut,
    ]);
    clearTimeout(timer);
    return result;
  }

  function logTail(path: string, bytes = 4000): string {
    try {
      return readFileSync(path, "utf8").slice(-bytes);
    } catch {
      return "";
    }
  }

  /** Can we actually bind this port right now? (wildcard, like the agent). */
  function portIsFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", () => resolve(false));
      probe.listen({ port, exclusive: true }, () => {
        probe.close(() => resolve(true));
      });
    });
  }

  /**
   * Allocate a port that is REALLY free. A pool port held by a foreign
   * process (e.g. an agent orphaned by a SIGKILLed supervisor) must never be
   * handed to a new agent: the spawn would fail to bind while the readiness
   * health-check happily answers from the stale listener — a silent
   * mis-route to the wrong agent. Busy ports stay allocated (burned) for
   * this supervisor's lifetime so they are never retried.
   */
  async function allocatePort(): Promise<number> {
    for (;;) {
      const port = ports.allocate(); // throws PortPoolExhaustedError
      if (await portIsFree(port)) return port;
      log(
        `port ${port} is unexpectedly in use (stale listener?) — burning it and trying the next`,
      );
    }
  }

  async function bootAgent(input: EnsureAgentInput): Promise<EnsureAgentResult> {
    const hash = input.versionHash;
    const dir = await cache.ensure(hash, input.artifactUrl);
    const entry = agentEntrypoint(dir);
    const port = await allocatePort();
    const logPath = join(logsDir, `${hash}-${Date.now()}.log`);

    try {
      const child = spawn(config.nodeBin, [entry], {
        cwd: dir,
        detached: true,
        env: agentEnv(hash, input.env, port),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const logStream = createWriteStream(logPath, { flags: "a" });
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      // Object properties (not locals) so TS flow analysis doesn't pin the
      // values assigned from the event callbacks below.
      const boot: { exitedEarly: boolean; spawnError: Error | null } = {
        exitedEarly: false,
        spawnError: null,
      };
      const exited = new Promise<void>((resolve) => {
        child.once("error", (err) => {
          boot.spawnError = err;
          boot.exitedEarly = true;
          resolve();
        });
        child.once("exit", () => {
          boot.exitedEarly = true;
          resolve();
        });
      });

      // Readiness: poll the agent's own health route until it answers.
      const deadline = Date.now() + config.agentReadyTimeoutMs;
      let ready = false;
      while (Date.now() < deadline && !boot.exitedEarly) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // not up yet
        }
        await Bun.sleep(100);
      }

      if (!ready) {
        const reason = boot.spawnError
          ? `spawn failed: ${boot.spawnError.message}`
          : boot.exitedEarly
            ? `process exited before becoming healthy (code ${child.exitCode}, signal ${child.signalCode})`
            : `no healthy /eve/v1/health within ${config.agentReadyTimeoutMs}ms`;
        const handleish: AgentHandle = {
          hash,
          port,
          child,
          state: "stopping",
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          inflight: 0,
          logPath,
          exited,
        };
        killTree(handleish, "SIGKILL");
        await waitExit(handleish, 5_000);
        const tail = logTail(logPath);
        log(`agent ${hash}: boot failed — ${reason}`);
        throw new AgentBootError(hash, reason, tail);
      }

      const handle: AgentHandle = {
        hash,
        port,
        child,
        state: "ready",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        inflight: 0,
        logPath,
        exited,
      };
      running.set(hash, handle);

      // Unexpected-exit cleanup (crash while "running"): free the port and
      // drop the handle so the proxy 404s and the next ensure respawns.
      void exited.then(() => {
        const current = running.get(hash);
        if (current !== undefined && current.child === child) {
          running.delete(hash);
          ports.release(port);
          inflightTotal -= current.inflight;
          if (current.state !== "stopping") {
            log(
              `agent ${hash}: exited unexpectedly (code ${child.exitCode}, signal ${child.signalCode}) — log: ${logPath}`,
            );
          }
        }
      });

      log(`agent ${hash}: ready on :${port}`);
      return { ...toInfo(handle), reused: false };
    } catch (err) {
      ports.release(port);
      throw err;
    }
  }

  async function stopAgent(hash: string): Promise<void> {
    const handle = running.get(hash);
    if (handle === undefined) return;
    handle.state = "stopping";
    running.delete(hash);
    inflightTotal -= handle.inflight;
    cache.touch(hash);
    killTree(handle, "SIGTERM");
    const stopped = await waitExit(handle, config.agentStopTimeoutMs);
    if (!stopped) {
      log(`agent ${hash}: SIGTERM timeout — escalating to SIGKILL`);
      killTree(handle, "SIGKILL");
      await waitExit(handle, 5_000);
    }
    ports.release(handle.port);
    log(`agent ${hash}: stopped`);
  }

  function sweepIdle(): void {
    const now = Date.now();
    for (const handle of running.values()) {
      if (
        handle.state === "ready" &&
        handle.inflight === 0 &&
        now - handle.lastActivityAt >= config.agentIdleStopMs
      ) {
        log(`agent ${handle.hash}: idle for ${now - handle.lastActivityAt}ms — stopping`);
        void stopAgent(handle.hash);
      }
    }
  }

  return {
    async ensureAgent(input: EnsureAgentInput): Promise<EnsureAgentResult> {
      const hash = input.versionHash;
      const existing = running.get(hash);
      if (existing !== undefined && existing.state === "ready") {
        existing.lastActivityAt = Date.now();
        cache.touch(hash);
        return { ...toInfo(existing), reused: true };
      }
      let boot = pending.get(hash);
      if (boot === undefined) {
        boot = bootAgent(input).finally(() => pending.delete(hash));
        pending.set(hash, boot);
      }
      return boot;
    },

    stopAgent,

    async stopAll(): Promise<void> {
      await Promise.allSettled(pending.values());
      await Promise.allSettled([...running.keys()].map((hash) => stopAgent(hash)));
    },

    get(hash: string): AgentInfo | undefined {
      const handle = running.get(hash);
      return handle === undefined ? undefined : toInfo(handle);
    },

    isActive(hash: string): boolean {
      return running.has(hash) || pending.has(hash);
    },

    activeCount(): number {
      let count = running.size;
      for (const hash of pending.keys()) {
        if (!running.has(hash)) count += 1;
      }
      return count;
    },

    list(): AgentInfo[] {
      return [...running.values()].map(toInfo);
    },

    totalInflight(): number {
      return inflightTotal;
    },

    beginRequest(hash: string): boolean {
      const handle = running.get(hash);
      if (handle === undefined || handle.state !== "ready") return false;
      handle.inflight += 1;
      handle.lastActivityAt = Date.now();
      inflightTotal += 1;
      return true;
    },

    endRequest(hash: string): void {
      const handle = running.get(hash);
      if (handle !== undefined) {
        handle.inflight = Math.max(0, handle.inflight - 1);
        handle.lastActivityAt = Date.now();
        inflightTotal = Math.max(0, inflightTotal - 1);
      }
      // else: agent already stopped/crashed — stopAgent/exit-cleanup already
      // reconciled its in-flight count out of the global total.
    },

    startIdleReaper(): void {
      if (reaper !== null) return;
      const interval = Math.min(
        Math.max(Math.floor(config.agentIdleStopMs / 3), 50),
        30_000,
      );
      reaper = setInterval(sweepIdle, interval);
      reaper.unref();
    },

    stopIdleReaper(): void {
      if (reaper !== null) {
        clearInterval(reaper);
        reaper = null;
      }
    },
  };
}
