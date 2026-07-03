import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryArtifactStore } from "../artifacts";
import { BuildService, type BuildRecord, type BuildStore } from "./service";
import { BuildStepError, type BuildSteps } from "./steps";

function memoryBuildStore(): BuildStore & { records: Map<string, BuildRecord> } {
  const records = new Map<string, BuildRecord>();
  return {
    records,
    async get(hash) {
      return records.get(hash) ?? null;
    },
    async markBuilding(hash) {
      records.set(hash, { hash, status: "building", artifactKey: null, errorLog: null });
    },
    async markSucceeded(hash, artifactKey) {
      records.set(hash, { hash, status: "succeeded", artifactKey, errorLog: null });
    },
    async markFailed(hash, errorLog) {
      records.set(hash, { hash, status: "failed", artifactKey: null, errorLog });
    },
  };
}

interface FakeStepsOptions {
  failAt?: "install" | "eveBuild" | "provisionWorld";
  delayMs?: number;
}

function fakeSteps(options: FakeStepsOptions = {}): {
  steps: BuildSteps;
  calls: string[];
} {
  const calls: string[] = [];
  const maybe = async (step: string) => {
    calls.push(step);
    if (options.delayMs) await Bun.sleep(options.delayMs);
    if (options.failAt === step) {
      throw new BuildStepError(step, `synthetic ${step} failure log`);
    }
  };
  return {
    calls,
    steps: {
      async writeFiles() {
        calls.push("writeFiles");
      },
      install: () => maybe("install"),
      eveBuild: () => maybe("eveBuild"),
      provisionWorld: (hash) => maybe(`provisionWorld:${hash}`).then(() => maybe("provisionWorld")),
      async packageArtifact() {
        calls.push("packageArtifact");
        return new TextEncoder().encode("tarball-bytes");
      },
    },
  };
}

const HASH = "aabbccddeeff00112233445566778899";
const FILES = new Map([["package.json", "{}"]]);
const BUILD_ROOT = join(tmpdir(), "invisible-string-test-builds");

describe("BuildService", () => {
  test("fresh build runs every step in order, uploads the artifact, marks succeeded", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const { steps, calls } = fakeSteps();
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const outcome = await service.ensureBuild(HASH, FILES);

    expect(outcome).toEqual({
      status: "succeeded",
      artifactKey: `artifacts/${HASH}.tar.gz`,
      errorLog: null,
      cached: false,
    });
    expect(calls).toEqual([
      "writeFiles",
      "install",
      "eveBuild",
      `provisionWorld:${HASH}`,
      "provisionWorld",
      "packageArtifact",
    ]);
    expect(store.records.get(HASH)?.status).toBe("succeeded");
    expect(artifacts.objects.has(`artifacts/${HASH}.tar.gz`)).toBeTrue();
  });

  test("cache hit: an existing succeeded build with a present artifact skips all steps", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const key = `artifacts/${HASH}.tar.gz`;
    await artifacts.put(key, "existing");
    await store.markSucceeded(HASH, key);
    const { steps, calls } = fakeSteps();
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const outcome = await service.ensureBuild(HASH, FILES);

    expect(outcome.cached).toBeTrue();
    expect(outcome.status).toBe("succeeded");
    expect(calls).toEqual([]);
  });

  test("a succeeded record whose artifact vanished triggers a full rebuild", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    await store.markSucceeded(HASH, `artifacts/${HASH}.tar.gz`); // no object!
    const { steps, calls } = fakeSteps();
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const outcome = await service.ensureBuild(HASH, FILES);

    expect(outcome.cached).toBeFalse();
    expect(outcome.status).toBe("succeeded");
    expect(calls).toContain("eveBuild");
  });

  test("step failure marks the build failed with the step's log; artifact not uploaded", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const { steps } = fakeSteps({ failAt: "eveBuild" });
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const outcome = await service.ensureBuild(HASH, FILES);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorLog).toContain("synthetic eveBuild failure log");
    expect(store.records.get(HASH)?.status).toBe("failed");
    expect(store.records.get(HASH)?.errorLog).toContain("eveBuild");
    expect(artifacts.objects.size).toBe(0);
  });

  test("single-flight: concurrent ensureBuild calls for one hash coalesce", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const { steps, calls } = fakeSteps({ delayMs: 20 });
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const [a, b, c] = await Promise.all([
      service.ensureBuild(HASH, FILES),
      service.ensureBuild(HASH, FILES),
      service.ensureBuild(HASH, FILES),
    ]);

    expect(a.status).toBe("succeeded");
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(calls.filter((call) => call === "eveBuild")).toHaveLength(1);
  });

  test("a failed build can be retried (next ensureBuild runs the steps again)", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const failing = fakeSteps({ failAt: "install" });
    const service = new BuildService({
      steps: failing.steps,
      store,
      artifacts,
      buildRoot: BUILD_ROOT,
    });
    const first = await service.ensureBuild(HASH, FILES);
    expect(first.status).toBe("failed");

    const healthy = fakeSteps();
    const service2 = new BuildService({
      steps: healthy.steps,
      store,
      artifacts,
      buildRoot: BUILD_ROOT,
    });
    const second = await service2.ensureBuild(HASH, FILES);
    expect(second.status).toBe("succeeded");
    expect(store.records.get(HASH)?.status).toBe("succeeded");
  });

  test("waitFor exposes the in-flight promise while building", async () => {
    const store = memoryBuildStore();
    const artifacts = createMemoryArtifactStore();
    const { steps } = fakeSteps({ delayMs: 20 });
    const service = new BuildService({ steps, store, artifacts, buildRoot: BUILD_ROOT });

    const promise = service.ensureBuild(HASH, FILES);
    expect(service.waitFor(HASH)).toBe(promise);
    await promise;
    expect(service.waitFor(HASH)).toBeUndefined();
  });
});
