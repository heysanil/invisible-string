/**
 * THE UPGRADE-GATE GATE.
 *
 * AGENTS.md: "any eve bump must pass the spike suites first". That only means
 * anything if the spike agent project is built from the SAME matrix the
 * compiler emits. Before this file existed it was not: package.json and
 * package-lock.json hardcoded eve 0.19.0 while packages/compiler/versions.json
 * said 0.31.3, and the suites passed green against a runtime nobody shipped.
 *
 * These tests are DELIBERATELY UNGATED — no TEST_DATABASE_URL, no docker, no
 * network. They run in the default `bun test` lane so the drift is caught in
 * seconds, at the same moment versions.json is edited, instead of hours later
 * in the integration lane (or never).
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  AGENT_PROJECT_PACKAGE_JSON,
  AGENT_PROJECT_PACKAGE_LOCK,
  SPIKE_PIN_MAP,
  expectedSpikePins,
  readVersionsMatrix,
} from "./pins.ts";

interface AgentPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  name?: string;
}

interface PackageLock {
  lockfileVersion?: number;
  name?: string;
  packages?: Record<string, { version?: string } | undefined>;
}

const RESYNC =
  "Run `bun run spike/tests/sync-pins.ts`, then `cd spike/agent-project && mise exec node@24 -- npm install --package-lock-only --ignore-scripts`. Do not hand-edit either file.";

const matrix = readVersionsMatrix();
const expected = expectedSpikePins(matrix);
const manifest = JSON.parse(
  readFileSync(AGENT_PROJECT_PACKAGE_JSON, "utf8"),
) as AgentPackageJson;
const lock = JSON.parse(readFileSync(AGENT_PROJECT_PACKAGE_LOCK, "utf8")) as PackageLock;

describe("spike agent-project pins track packages/compiler/versions.json", () => {
  test(`package.json dependencies match the matrix (eve ${String(matrix.eve)})`, () => {
    expect({ reason: RESYNC, ...manifest.dependencies }).toEqual({
      reason: RESYNC,
      ...expected.dependencies,
    });
  });

  test("package.json devDependencies match the matrix", () => {
    expect({ reason: RESYNC, ...manifest.devDependencies }).toEqual({
      reason: RESYNC,
      ...expected.devDependencies,
    });
  });

  test("engines.node tracks the matrix's node major", () => {
    expect(manifest.engines?.node).toBe(expected.enginesNode);
  });

  test("every pin is an EXACT version, never a range", () => {
    // AGENTS.md: "Version pins are exact ... Never `@latest` in generated
    // projects". A caret here would let npm resolve a runtime the compiler
    // never emits, which is the same class of lie this file exists to stop.
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [pkg, version] of Object.entries(all)) {
      expect(`${pkg}@${version}`).toMatch(/@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
  });

  test("package-lock.json resolves the same versions (lockfile is regenerated, not stale)", () => {
    // `npm ci` installs from the LOCKFILE, so a repinned package.json with a
    // stale lock still installs the old runtime — the exact failure mode that
    // let the spike gate eve 0.19.
    const pinned = { ...expected.dependencies, ...expected.devDependencies };
    const resolved: Record<string, string | undefined> = {};
    for (const pkg of Object.keys(pinned)) {
      resolved[pkg] = lock.packages?.[`node_modules/${pkg}`]?.version;
    }
    expect({ reason: RESYNC, ...resolved }).toEqual({ reason: RESYNC, ...pinned });
  });

  test("package-lock.json's root package block matches package.json", () => {
    const root = lock.packages?.[""] as
      | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      | undefined;
    expect(root?.dependencies).toEqual(expected.dependencies);
    expect(root?.devDependencies).toEqual(expected.devDependencies);
  });

  test("the pin map covers every dependency the spike agent declares", () => {
    // Guards the other direction: a dependency added straight to
    // package.json without a versions.json entry would otherwise be
    // unpinned-by-the-matrix and invisible to every check above.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      Object.keys(SPIKE_PIN_MAP.dependencies).sort(),
    );
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual(
      Object.keys(SPIKE_PIN_MAP.devDependencies).sort(),
    );
  });
});
