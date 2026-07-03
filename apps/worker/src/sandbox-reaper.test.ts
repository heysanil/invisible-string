/**
 * Sandbox reaper tests — a FAKE docker shim proves the eviction contract with
 * no real daemon (design correction 4). A real-docker smoke check is gated on
 * WORKER_REAL_DOCKER=1 so CI without docker still runs green.
 */
import { describe, expect, test } from "bun:test";

import {
  createDockerCliClient,
  createSandboxReaper,
  selectIdleSandboxes,
  type DockerClient,
  type RunCommand,
  type SandboxContainer,
} from "./sandbox-reaper";

const NOW = Date.parse("2026-07-03T12:00:00Z");
const MIN = 60_000;

function container(id: string, ageMs: number): SandboxContainer {
  return { id, session: `sess-${id}`, lastActivityAt: NOW - ageMs };
}

/** In-memory docker: lists a fixed set, records what was stopped. */
class FakeDocker implements DockerClient {
  stopped: string[] = [];
  constructor(private containers: SandboxContainer[]) {}
  async listSandboxes(): Promise<SandboxContainer[]> {
    return this.containers.filter((c) => !this.stopped.includes(c.id));
  }
  async stop(id: string): Promise<void> {
    this.stopped.push(id);
  }
}

describe("selectIdleSandboxes (pure policy)", () => {
  test("selects only containers idle at/past the window", () => {
    const idle = selectIdleSandboxes(
      [container("fresh", 5 * MIN), container("old", 45 * MIN), container("edge", 30 * MIN)],
      NOW,
      30 * MIN,
    );
    expect(idle.map((c) => c.id).sort()).toEqual(["edge", "old"]);
  });
});

describe("sandbox reaper sweep", () => {
  test("stops idle sandboxes (>30min) and leaves fresh ones running", async () => {
    const docker = new FakeDocker([
      container("busy", 2 * MIN),
      container("idle-a", 31 * MIN),
      container("idle-b", 90 * MIN),
    ]);
    const reaper = createSandboxReaper({ docker, idleStopMs: 30 * MIN });

    const result = await reaper.sweepOnce(NOW);
    expect(result.scanned).toBe(3);
    expect(result.stopped.sort()).toEqual(["idle-a", "idle-b"]);
    expect(docker.stopped.sort()).toEqual(["idle-a", "idle-b"]);

    // A second sweep sees only the busy one still up (nothing more to stop).
    const again = await reaper.sweepOnce(NOW);
    expect(again.scanned).toBe(1);
    expect(again.stopped).toEqual([]);
  });

  test("a stop failure does not abort the sweep of other containers", async () => {
    const docker: DockerClient = {
      async listSandboxes() {
        return [container("bad", 60 * MIN), container("good", 60 * MIN)];
      },
      async stop(id) {
        if (id === "bad") throw new Error("docker daemon hiccup");
      },
    };
    const reaper = createSandboxReaper({ docker, idleStopMs: 30 * MIN });
    const result = await reaper.sweepOnce(NOW);
    expect(result.stopped).toEqual(["good"]);
  });
});

describe("createDockerCliClient (parsing, stubbed CLI)", () => {
  test("enumerates labelled containers and reaps the ones started long ago", async () => {
    const started: Record<string, string> = {
      c1: new Date(NOW - 90 * MIN).toISOString(),
      c2: new Date(NOW - 2 * MIN).toISOString(),
    };
    const calls: string[][] = [];
    const run: RunCommand = async (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "ps") {
        // <id>\t<labelValue> per container.
        return { stdout: "c1\tsession-1\nc2\tsession-2\n", exitCode: 0 };
      }
      if (args[0] === "inspect") {
        const id = args[args.length - 1]!;
        return { stdout: `${started[id] ?? ""}\n`, exitCode: 0 };
      }
      if (args[0] === "stop") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    };

    const docker = createDockerCliClient({
      dockerBin: "docker",
      labelKey: "eve.session",
      run,
    });
    const containers = await docker.listSandboxes();
    expect(containers.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    // ps filtered by the eve-session label only.
    expect(calls[0]).toContain("label=eve.session");

    const idle = selectIdleSandboxes(containers, NOW, 30 * MIN);
    expect(idle.map((c) => c.id)).toEqual(["c1"]);

    await docker.stop("c1");
    expect(calls.at(-1)).toEqual(["docker", "stop", "c1"]);
  });

  test("empty ps output → no containers (never throws)", async () => {
    const run: RunCommand = async () => ({ stdout: "\n", exitCode: 0 });
    const docker = createDockerCliClient({ dockerBin: "docker", labelKey: "eve.session", run });
    expect(await docker.listSandboxes()).toEqual([]);
  });
});

// Real docker, opt-in only.
const realDocker = process.env.WORKER_REAL_DOCKER === "1";
describe.skipIf(!realDocker)("real docker smoke", () => {
  test("lists sandboxes without throwing against a live daemon", async () => {
    const docker = createDockerCliClient({ dockerBin: "docker", labelKey: "eve.session" });
    const containers = await docker.listSandboxes();
    expect(Array.isArray(containers)).toBe(true);
  });
});
