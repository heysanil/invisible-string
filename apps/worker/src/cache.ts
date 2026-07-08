/**
 * Artifact cache — downloads built-agent tarballs (`.output` + manifest, as
 * produced by the control-plane build service), extracts them to
 * `<cacheDir>/<hash>/`, and LRU-evicts by total extracted size. Running
 * agents are never evicted (the manager injects `isRunning`).
 *
 * ⚠️ eve build outputs are not path-relocatable (spike/REPORT.md finding 13):
 * the cache dir must be the same canonical path the build service used.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export type ArtifactErrorCode = "artifact_download_failed" | "artifact_invalid";

export class ArtifactError extends Error {
  override readonly name = "ArtifactError";
  constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CacheEntry {
  hash: string;
  bytes: number;
  /** Epoch ms of the last ensure/agent-stop touch (LRU ordering key). */
  lastUsedAt: number;
}

export interface ArtifactCache {
  /** Download+extract (or reuse) the artifact; returns the extracted dir. */
  ensure(hash: string, artifactUrl: string): Promise<string>;
  /** Bump LRU recency for a hash (no-op when absent). */
  touch(hash: string): void;
  dirFor(hash: string): string;
  entries(): CacheEntry[];
  totalBytes(): number;
  readonly maxBytes: number;
  readonly dir: string;
}

/** Reserved subdirectory names that are never treated as artifact hashes. */
const RESERVED_DIRS = new Set(["tmp", "logs"]);

const HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function createArtifactCache(options: {
  dir: string;
  maxBytes: number;
  /** Running (or booting) agents are exempt from eviction. */
  isRunning: (hash: string) => boolean;
  log?: (message: string) => void;
}): ArtifactCache {
  const { dir, maxBytes, isRunning } = options;
  const log = options.log ?? (() => {});
  const entries = new Map<string, { bytes: number; lastUsedAt: number }>();
  const inflight = new Map<string, Promise<string>>();

  const tmpDir = join(dir, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  // Boot scan: adopt fully-extracted artifacts, discard partial leftovers.
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (RESERVED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) {
      rmSync(path, { force: true });
      continue;
    }
    if (!HASH_RE.test(name) || !existsSync(agentEntrypoint(path))) {
      log(`cache: discarding invalid/partial entry ${name}`);
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    entries.set(name, {
      bytes: dirBytes(path),
      lastUsedAt: statSync(path).mtimeMs,
    });
  }

  function dirFor(hash: string): string {
    return join(dir, hash);
  }

  function totalBytes(): number {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    return total;
  }

  function touch(hash: string): void {
    const entry = entries.get(hash);
    if (entry !== undefined) entry.lastUsedAt = Date.now();
  }

  /** Evict least-recently-used non-running entries until under the cap. */
  function evictIfNeeded(): void {
    let total = totalBytes();
    if (total <= maxBytes) return;
    const byRecency = [...entries.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    for (const [hash, entry] of byRecency) {
      if (total <= maxBytes) break;
      if (isRunning(hash)) continue;
      rmSync(dirFor(hash), { recursive: true, force: true });
      entries.delete(hash);
      total -= entry.bytes;
      log(`cache: evicted ${hash} (${entry.bytes} bytes)`);
    }
    if (total > maxBytes) {
      log(
        `cache: over budget (${total} > ${maxBytes} bytes) but every remaining artifact belongs to a running agent — not evicting`,
      );
    }
  }

  async function download(hash: string, artifactUrl: string): Promise<string> {
    const finalDir = dirFor(hash);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tarPath = join(tmpDir, `${hash}-${stamp}.tar.gz`);
    const stageDir = join(tmpDir, `${hash}-${stamp}.partial`);
    try {
      let response: Response;
      try {
        response = await fetch(artifactUrl);
      } catch (err) {
        throw new ArtifactError(
          "artifact_download_failed",
          `artifact download failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok) {
        throw new ArtifactError(
          "artifact_download_failed",
          `artifact download failed for ${hash}: HTTP ${response.status}`,
        );
      }
      // Stream to disk — never buffer the tarball in memory. Hand-pumped
      // rather than `Bun.write(tarPath, response)`: Bun's optimized
      // Response→file path stalls indefinitely on Linux against Garage's
      // S3 GET responses (CI ensure-agent hangs; a manual reader drains the
      // same body at full speed).
      if (!response.body) {
        throw new ArtifactError(
          "artifact_download_failed",
          `artifact download failed for ${hash}: empty response body`,
        );
      }
      const sink = Bun.file(tarPath).writer();
      try {
        for await (const chunk of response.body) {
          await sink.write(chunk);
        }
      } finally {
        await sink.end();
      }

      mkdirSync(stageDir, { recursive: true });
      const tar = Bun.spawn(["tar", "-xzf", tarPath, "-C", stageDir], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [tarExit, tarErr] = await Promise.all([
        tar.exited,
        new Response(tar.stderr).text(),
      ]);
      if (tarExit !== 0) {
        throw new ArtifactError(
          "artifact_invalid",
          `artifact extraction failed for ${hash}: ${tarErr.slice(-500)}`,
        );
      }
      if (!existsSync(agentEntrypoint(stageDir))) {
        throw new ArtifactError(
          "artifact_invalid",
          `artifact for ${hash} has no .output/server/index.mjs (not an eve build tarball?)`,
        );
      }

      if (existsSync(finalDir)) {
        // Lost a (cross-process) race — the existing extraction wins.
        rmSync(stageDir, { recursive: true, force: true });
      } else {
        renameSync(stageDir, finalDir);
      }
      entries.set(hash, { bytes: dirBytes(finalDir), lastUsedAt: Date.now() });
      evictIfNeeded();
      return finalDir;
    } finally {
      rmSync(tarPath, { force: true });
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  return {
    dir,
    maxBytes,
    dirFor,
    entries: () =>
      [...entries.entries()].map(([hash, e]) => ({ hash, ...e })),
    totalBytes,
    touch,
    async ensure(hash: string, artifactUrl: string): Promise<string> {
      if (!HASH_RE.test(hash)) {
        throw new ArtifactError(
          "artifact_invalid",
          `invalid version hash "${hash}"`,
        );
      }
      const finalDir = dirFor(hash);
      if (entries.has(hash) && existsSync(agentEntrypoint(finalDir))) {
        touch(hash);
        return finalDir;
      }
      let pending = inflight.get(hash);
      if (pending === undefined) {
        pending = download(hash, artifactUrl).finally(() =>
          inflight.delete(hash),
        );
        inflight.set(hash, pending);
      }
      return pending;
    },
  };
}

/** Launch entrypoint inside an extracted artifact (spike/REPORT.md finding 6). */
export function agentEntrypoint(extractedDir: string): string {
  return join(extractedDir, ".output", "server", "index.mjs");
}

function dirBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += dirBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}
