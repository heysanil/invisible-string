/**
 * Build service: compiled files → npm install → eve build → tar.gz → object
 * store, recorded in `builds`. The agent is the compile unit — one build per
 * agent-version content hash.
 *
 * - CACHE: `builds` is keyed by content hash; an existing `succeeded` row
 *   (with its artifact still present) short-circuits the whole pipeline.
 * - SINGLE-FLIGHT: concurrent ensureBuild calls for one hash coalesce onto
 *   one in-process build (Map<hash, Promise>). Cross-process locking is a
 *   Phase-3 concern (single control plane in Phase 1).
 * - WORLD: the first build of a version provisions + bootstraps its dedicated
 *   world database (build/world.ts — design correction #10).
 * - STATUS: `builds.status` and every `agent_versions` row with the same
 *   content hash move building → succeeded|failed together; the error log is
 *   persisted for the API to surface.
 */
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { BuildStatus } from "@invisible-string/shared";

import type { Db } from "../db";
import { artifactKeyForHash, type ArtifactStore } from "../artifacts";
import { BuildStepError, type BuildSteps } from "./steps";

export interface BuildRecord {
  hash: string;
  status: BuildStatus;
  artifactKey: string | null;
  errorLog: string | null;
}

/** Persistence surface — drizzle-backed in prod, in-memory in unit tests. */
export interface BuildStore {
  get(hash: string): Promise<BuildRecord | null>;
  markBuilding(hash: string): Promise<void>;
  markSucceeded(hash: string, artifactKey: string): Promise<void>;
  markFailed(hash: string, errorLog: string): Promise<void>;
}

export function createDrizzleBuildStore(db: Db): BuildStore {
  async function setVersionsStatus(hash: string, status: BuildStatus) {
    await db
      .update(schema.agentVersions)
      .set({ buildStatus: status })
      .where(eq(schema.agentVersions.contentHash, hash));
  }

  return {
    async get(hash) {
      const rows = await db
        .select()
        .from(schema.builds)
        .where(eq(schema.builds.hash, hash))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        hash: row.hash,
        status: row.status,
        artifactKey: row.artifactKey,
        errorLog: row.errorLog,
      };
    },
    async markBuilding(hash) {
      await db
        .insert(schema.builds)
        .values({ hash, status: "building", artifactKey: null, errorLog: null })
        .onConflictDoUpdate({
          target: schema.builds.hash,
          set: { status: "building", artifactKey: null, errorLog: null },
        });
      await setVersionsStatus(hash, "building");
    },
    async markSucceeded(hash, artifactKey) {
      await db
        .update(schema.builds)
        .set({ status: "succeeded", artifactKey, errorLog: null })
        .where(eq(schema.builds.hash, hash));
      await setVersionsStatus(hash, "succeeded");
    },
    async markFailed(hash, errorLog) {
      await db
        .update(schema.builds)
        .set({ status: "failed", errorLog })
        .where(eq(schema.builds.hash, hash));
      await setVersionsStatus(hash, "failed");
    },
  };
}

export interface BuildOutcome {
  status: Extract<BuildStatus, "succeeded" | "failed">;
  artifactKey: string | null;
  errorLog: string | null;
  /** True when the succeeded build came straight from the cache. */
  cached: boolean;
}

export interface BuildServiceDeps {
  steps: BuildSteps;
  store: BuildStore;
  artifacts: ArtifactStore;
  /** Canonical build root (see steps.ts path note). */
  buildRoot: string;
  /**
   * Does the version's world database still exist? (build/world.ts
   * worldDatabaseExists). A cache hit whose world DB was dropped (retired
   * version cleanup) falls through to a full rebuild — which re-provisions
   * the world — instead of serving an artifact that boots against a
   * nonexistent database. Optional for tests that don't care.
   */
  worldExists?: (contentHash: string) => Promise<boolean>;
}

export class BuildService {
  private readonly inFlight = new Map<string, Promise<BuildOutcome>>();

  constructor(private readonly deps: BuildServiceDeps) {}

  /** The in-flight build for a hash, if any (tests await determinism). */
  waitFor(hash: string): Promise<BuildOutcome> | undefined {
    return this.inFlight.get(hash);
  }

  /**
   * Ensure a ready artifact exists for the compiled files. Coalesces
   * concurrent calls per hash; a cached `succeeded` build (artifact present)
   * skips everything. Never throws for build failures — the outcome (and the
   * DB rows) carry the error log; only infrastructure faults propagate.
   */
  ensureBuild(
    hash: string,
    files: ReadonlyMap<string, string>,
  ): Promise<BuildOutcome> {
    const existing = this.inFlight.get(hash);
    if (existing) return existing;

    const promise = this.runBuild(hash, files).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, promise);
    return promise;
  }

  private async runBuild(
    hash: string,
    files: ReadonlyMap<string, string>,
  ): Promise<BuildOutcome> {
    const { steps, store, artifacts, buildRoot } = this.deps;
    const artifactKey = artifactKeyForHash(hash);

    const cached = await store.get(hash);
    if (
      cached?.status === "succeeded" &&
      cached.artifactKey &&
      (await artifacts.exists(cached.artifactKey)) &&
      // A cached artifact is only servable while its world DB exists — a
      // dropped world (retired-version cleanup) forces a full rebuild, whose
      // provisionWorld step recreates + bootstraps it.
      ((await this.deps.worldExists?.(hash)) ?? true)
    ) {
      // Keep version rows in sync (a republish of an identical config may
      // have inserted a fresh 'pending' version row for this hash).
      await store.markSucceeded(hash, cached.artifactKey);
      return {
        status: "succeeded",
        artifactKey: cached.artifactKey,
        errorLog: null,
        cached: true,
      };
    }

    const projectDir = join(buildRoot, hash);
    await store.markBuilding(hash);
    try {
      await steps.writeFiles(projectDir, files);
      await steps.install(projectDir);
      await steps.eveBuild(projectDir);
      await steps.provisionWorld(hash, projectDir);
      const bytes = await steps.packageArtifact(projectDir, hash);
      await artifacts.put(artifactKey, bytes);
      await store.markSucceeded(hash, artifactKey);
      return { status: "succeeded", artifactKey, errorLog: null, cached: false };
    } catch (error) {
      const errorLog =
        error instanceof BuildStepError
          ? `[${error.step}] ${error.log}`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      await store.markFailed(hash, errorLog);
      return { status: "failed", artifactKey: null, errorLog, cached: false };
    }
  }
}
