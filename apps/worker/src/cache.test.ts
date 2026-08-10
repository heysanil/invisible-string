/**
 * Artifact-cache boot scan.
 *
 * The scan runs inside `createArtifactCache`, which the worker calls during
 * startup — BEFORE the HTTP server listens. Anything it throws therefore takes
 * the whole worker down, and what the operator sees is not a cache error but a
 * worker that never becomes healthy: no `worker.ready` line, an empty log, and
 * a readiness probe that times out. That asymmetry is why the scan has to
 * treat a bad entry as unusable rather than fatal.
 */
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { agentEntrypoint, createArtifactCache } from "./cache";

const created: string[] = [];

afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifact-cache-"));
  created.push(dir);
  return dir;
}

/** A fully-extracted artifact — the shape the scan is meant to adopt. */
function seedEntry(dir: string, hash: string, bytes = 64): void {
  const entrypoint = agentEntrypoint(join(dir, hash));
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "x".repeat(bytes));
}

test("the boot scan adopts a fully-extracted artifact", () => {
  const dir = cacheDir();
  seedEntry(dir, "abcdef123456");

  const cache = createArtifactCache({
    dir,
    maxBytes: 1_000_000,
    isRunning: () => false,
  });

  expect(cache.entries().map((entry) => entry.hash)).toEqual(["abcdef123456"]);
});

test("an entry that vanishes between readdir and stat is skipped, not fatal", () => {
  const dir = cacheDir();
  seedEntry(dir, "abcdef123456");
  // A dangling symlink is the deterministic stand-in for the real race: a
  // concurrent teardown, or an eviction interrupted partway, removing an entry
  // after `readdirSync` already listed its name. `statSync` follows the link
  // and raises the same ENOENT either way — which used to abort the scan on
  // its FIRST bad entry, so every healthy artifact after it was lost too.
  symlinkSync(join(dir, "not-there"), join(dir, "fedcba654321"));

  const cache = createArtifactCache({
    dir,
    maxBytes: 1_000_000,
    isRunning: () => false,
  });

  // Scan completed, and the healthy entry was still adopted.
  expect(cache.entries().map((entry) => entry.hash)).toEqual(["abcdef123456"]);
});

test("a partial extraction is still discarded, not adopted", () => {
  const dir = cacheDir();
  // A directory whose name looks like a hash but has no entrypoint: the
  // interrupted-download case the scan has always cleaned up. Skipping
  // unreadable entries must not turn into skipping this one.
  mkdirSync(join(dir, "0123456789ab"), { recursive: true });
  seedEntry(dir, "abcdef123456");

  const cache = createArtifactCache({
    dir,
    maxBytes: 1_000_000,
    isRunning: () => false,
  });

  expect(cache.entries().map((entry) => entry.hash)).toEqual(["abcdef123456"]);
});
