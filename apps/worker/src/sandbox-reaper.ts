/**
 * Sandbox reaper (docs/PLAN.md Phase 3 task 2; design correction 4).
 *
 * eve gives docker sandboxes NO idle timeout of its own, so the worker enforces
 * one: enumerate containers eve labels by session and stop those idle longer
 * than the window (default 30 min, env-tunable). The eviction DECISION is a
 * pure function (`selectIdleSandboxes`); docker access is behind a
 * {@link DockerClient} seam so unit tests inject a fake and never require a
 * real daemon (a real-docker path is gated separately).
 */

/** One eve sandbox container the reaper considers. */
export interface SandboxContainer {
  id: string;
  /** The eve session label value (correlation/logging). */
  session: string;
  /**
   * Baseline last-activity epoch ms from docker (`State.StartedAt` — docker
   * exposes no per-exec idle metric). The policy combines it with the
   * supervisor's per-session proxy-activity signal (`activityOf`), so an
   * actively-used sandbox is never stopped; StartedAt alone only bounds a
   * sandbox whose session has had NO platform traffic at all.
   */
  lastActivityAt: number;
}

export interface DockerClient {
  /** List running sandbox containers carrying the eve-session label. */
  listSandboxes(): Promise<SandboxContainer[]>;
  /** Stop (and let docker reap) one container by id. */
  stop(containerId: string): Promise<void>;
}

/** Best-known activity for a container: proxy activity beats StartedAt. */
export function effectiveLastActivity(
  container: SandboxContainer,
  activityOf?: (session: string) => number | undefined,
): number {
  const proxied = activityOf?.(container.session);
  return proxied !== undefined
    ? Math.max(container.lastActivityAt, proxied)
    : container.lastActivityAt;
}

/**
 * Pure policy: which containers are idle past the window? Idle = no proxied
 * eve-session activity (agent-manager signal) since max(container start, last
 * proxy call) — a sandbox in continuous use is NEVER stopped at the 30-minute
 * mark (design correction 4 mandates an IDLE window, not a lifetime cap).
 */
export function selectIdleSandboxes(
  containers: SandboxContainer[],
  now: number,
  idleStopMs: number,
  activityOf?: (session: string) => number | undefined,
): SandboxContainer[] {
  return containers.filter(
    (c) => now - effectiveLastActivity(c, activityOf) >= idleStopMs,
  );
}

export interface SweepResult {
  scanned: number;
  stopped: string[];
}

export interface SandboxReaper {
  sweepOnce(now?: number): Promise<SweepResult>;
  start(): void;
  stop(): void;
  /** Containers seen by the most recent scan (worker /internal metrics). */
  lastScanCount(): number;
}

export function createSandboxReaper(options: {
  docker: DockerClient;
  idleStopMs: number;
  /** Sweep cadence (default idleStopMs/6, clamped 30s–5min). */
  intervalMs?: number;
  /**
   * Last-proxy-activity per eve session id (the container's `eve.session`
   * label value), stamped by the worker's HTTP surface. Without it the policy
   * degrades to the docker StartedAt approximation — a max-lifetime cap.
   */
  activityOf?: (session: string) => number | undefined;
  log?: (message: string) => void;
}): SandboxReaper {
  const { docker, idleStopMs, activityOf } = options;
  const log = options.log ?? (() => {});
  const intervalMs =
    options.intervalMs ??
    Math.min(Math.max(Math.floor(idleStopMs / 6), 30_000), 5 * 60_000);

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let scanned = 0;

  async function sweepOnce(now: number = Date.now()): Promise<SweepResult> {
    const containers = await docker.listSandboxes();
    scanned = containers.length;
    const idle = selectIdleSandboxes(containers, now, idleStopMs, activityOf);
    const stopped: string[] = [];
    for (const container of idle) {
      // Re-read the activity signal right before stopping: the session may
      // have resumed between the docker ps scan and this stop (ps→stop race).
      const lastActivity = effectiveLastActivity(container, activityOf);
      if (now - lastActivity < idleStopMs) continue;
      try {
        await docker.stop(container.id);
        stopped.push(container.id);
        log(
          `sandbox ${container.id} (session ${container.session}) idle ${
            now - lastActivity
          }ms — stopped`,
        );
      } catch (error) {
        log(
          `sandbox ${container.id}: stop failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { scanned: containers.length, stopped };
  }

  return {
    sweepOnce,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void sweepOnce()
          .catch((error) => log(`sandbox sweep failed: ${String(error)}`))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    lastScanCount(): number {
      return scanned;
    },
  };
}

// ── real docker CLI client ───────────────────────────────────────────────────

/** Injectable command runner (real: Bun.spawn; tests can stub the CLI too). */
export type RunCommand = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

const defaultRun: RunCommand = async (bin, args) => {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

/**
 * `DockerClient` backed by the docker CLI. Enumerates containers filtered by
 * the eve-session label, reads each container's `State.StartedAt` as the
 * activity baseline, and stops the idle ones. Only labelled containers are ever
 * touched.
 */
export function createDockerCliClient(options: {
  dockerBin: string;
  labelKey: string;
  run?: RunCommand;
  log?: (message: string) => void;
}): DockerClient {
  const { dockerBin, labelKey } = options;
  const run = options.run ?? defaultRun;
  const log = options.log ?? (() => {});

  return {
    async listSandboxes(): Promise<SandboxContainer[]> {
      // `<id> <labelValue>` per running container carrying the label.
      const ps = await run(dockerBin, [
        "ps",
        "--no-trunc",
        "--filter",
        `label=${labelKey}`,
        "--format",
        `{{.ID}}\t{{.Label "${labelKey}"}}`,
      ]);
      if (ps.exitCode !== 0) {
        log(`docker ps failed (exit ${ps.exitCode})`);
        return [];
      }
      const rows = ps.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const containers: SandboxContainer[] = [];
      for (const row of rows) {
        const [id, session = ""] = row.split("\t");
        if (!id) continue;
        containers.push({
          id,
          session,
          lastActivityAt: await startedAt(id),
        });
      }
      return containers;
    },
    async stop(containerId: string): Promise<void> {
      const result = await run(dockerBin, ["stop", containerId]);
      if (result.exitCode !== 0) {
        throw new Error(`docker stop ${containerId} exited ${result.exitCode}`);
      }
    },
  };

  async function startedAt(id: string): Promise<number> {
    const inspect = await run(dockerBin, [
      "inspect",
      "--format",
      "{{.State.StartedAt}}",
      id,
    ]);
    const parsed = Date.parse(inspect.stdout.trim());
    // Unknown → treat as "just started" (never reap on a parse failure).
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}
