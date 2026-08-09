# Changesets Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-typed `git tag vX.Y.Z` releases with a Changesets flow that computes the version, writes a root `CHANGELOG.md`, cuts the tag and GitHub Release, and builds the GHCR images — all from merging one PR.

**Architecture:** Changesets versions the eight shipped workspaces in lockstep (`fixed` globs) so the repo has exactly one version, which `IMAGE_TAG` consumes. Two thin entrypoints in `scripts/` wrap pure, unit-tested modules in `scripts/release/` — mirroring the existing `scripts/dev.ts` + `scripts/dev/` pattern. `release.yml` gains a `version` job on `main` pushes that opens a "Version Packages" PR and, once merged, tags + releases + triggers the existing image matrix in the same run (so `GITHUB_TOKEN`'s workflow-recursion guard never applies and no PAT is needed).

**Tech Stack:** Bun, TypeScript (strict), `@changesets/cli@2.31.1`, `changesets/action@v1`, GitHub Actions, `gh` CLI.

**Design spec:** `docs/superpowers/specs/2026-08-08-changesets-release-workflow-design.md` — read it before starting. Section references below (§N) point there.

## Global Constraints

- **Pins are exact.** `@changesets/cli` is `"2.31.1"` — no `^`, no `~`. `changesets/action@v1`.
- **Bun only.** `npm install` cannot run in this repo (rejects `workspace:*` with `EUNSUPPORTEDPROTOCOL`). Every script and CI step uses `bun`.
- **The eight shipped workspaces** are `apps/control-plane`, `apps/site`, `apps/web`, `apps/worker`, `packages/compiler`, `packages/db`, `packages/design-tokens`, `packages/shared`. They all carry a `version` and always hold the same value.
- **`tests/integration` and `e2e` must never have a `version` field.** That omission is the exclusion mechanism (§3 finding 3).
- **Semver while on 0.x** (§5.2): breaking → `minor`, feature → `minor`, fix/chore → `patch`. `major` is reserved for a deliberate 1.0.0 and is not used.
- **`**Breaking:**` prefix** in a changeset summary routes it to the "Breaking changes" section regardless of bump type (§5.3).
- **`CHANGELOG.md` structural rule:** the preamble may use `# ` and prose, but the **first `## ` in the file is always the newest release**. Both scripts depend on this.
- **Commit messages never mention AI assistance.** Conventional style (`feat(scope):`, `fix:`, `docs:`, `ci:`).
- **Docs move with code** (AGENTS.md). Task 6 is not optional.
- **TypeScript strict.** `tsc -p scripts` covers everything under `scripts/`, including test files.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `.changeset/config.json` | Changesets configuration (§6.1) |
| `.changeset/README.md` | One-paragraph pointer to AGENTS.md's Releases section |
| `scripts/release/workspaces.ts` | Enumerate workspaces from root `package.json` globs; read name + version |
| `scripts/release/changesets.ts` | Parse `.changeset/*.md`; validate package names |
| `scripts/release/changelog.ts` | Classify entries into sections; render a release section; insert it into `CHANGELOG.md` |
| `scripts/release/decide.ts` | Pure tag-state → decision function (§6.3 algorithm) |
| `scripts/release/*.test.ts` | Colocated unit tests, one per module |
| `scripts/release-version.ts` | Entrypoint: validate → `changeset version` → write `CHANGELOG.md` |
| `scripts/release-tag.ts` | Entrypoint: gather git state → `decide()` → tag / release / no-op |
| `tests/integration/changesets-config.test.ts` | Ungated drift guard (§8) |
| `CHANGELOG.md` | Root changelog, backfilled (§10) |

**Modified:**

| Path | Change |
|---|---|
| `package.json` (root) | `@changesets/cli` devDependency; `changeset` / `release:version` / `release:tag` scripts |
| 8 shipped `package.json` files | Add `"version": "0.2.0"` |
| `.github/workflows/release.yml` | Add `push: main` trigger, `version` job, rework `images` gating and tags |
| `AGENTS.md` | Releases section; living-doc rows; fix the false "release.yml needs no mise step" sentence |
| `docs/DEPLOY.md` | §10 upgrade path |
| `README.md` | One line on how releases are cut |

**Why this split:** each `scripts/release/` module is pure (no `git`, no `gh`, no filesystem writes) so it is unit-testable in the default `bun test` lane; the entrypoints hold all the I/O. This is the same shape as `scripts/dev.ts` over `scripts/dev/env.ts` + `scripts/dev/stream.ts`.

---

### Task 1: Changesets installed, versions seeded, drift guard

Establishes the version carrier and the config, guarded by a test written first.

**Files:**
- Create: `.changeset/config.json`, `.changeset/README.md`
- Create: `tests/integration/changesets-config.test.ts`
- Modify: `package.json` (root) — devDependency + scripts
- Modify: `apps/control-plane/package.json`, `apps/site/package.json`, `apps/web/package.json`, `apps/worker/package.json`, `packages/compiler/package.json`, `packages/db/package.json`, `packages/design-tokens/package.json`, `packages/shared/package.json`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `.changeset/config.json` with the `fixed` globs; all eight manifests at `"version": "0.2.0"`. Tasks 2–5 depend on both.

- [ ] **Step 1: Write the failing guard test**

Create `tests/integration/changesets-config.test.ts`:

```ts
/**
 * Changesets config drift guard.
 *
 * The release flow versions eight workspaces in lockstep and EXCLUDES the two
 * test harnesses. The exclusion is not a config toggle — it is the absence of a
 * `version` field, paired with negation globs in `fixed`. Both halves must stay
 * in sync: a versionless workspace that the positive glob still matches makes
 * `changeset version` die with `TypeError: Invalid version. Must be a string.`
 * — on main, in the release job, hours after the offending workspace merged.
 *
 * DELIBERATELY UNGATED, like tests/integration/toolchain-pins.test.ts: pure
 * filesystem parsing, so drift surfaces in the default `bun test` lane.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: string[];
  devDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;
}

/** Every workspace directory, expanded from the root `workspaces` globs. */
function workspaceDirs(): string[] {
  const patterns = readManifest(".").workspaces ?? [];
  return patterns
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) return [pattern];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(ROOT, parent), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${parent}/${e.name}`);
    })
    .sort();
}

const SHIPPED = [
  "apps/control-plane",
  "apps/site",
  "apps/web",
  "apps/worker",
  "packages/compiler",
  "packages/db",
  "packages/design-tokens",
  "packages/shared",
];

const config = JSON.parse(
  readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"),
) as {
  changelog: unknown;
  fixed: string[][];
  baseBranch: string;
  privatePackages: { version: boolean; tag: boolean };
};

describe("changesets config", () => {
  test("every shipped workspace carries the same version", () => {
    const versions = SHIPPED.map((dir) => {
      const version = readManifest(dir).version;
      expect(version, `${dir} has no version field`).toMatch(EXACT_SEMVER);
      return version;
    });
    expect(new Set(versions).size, `versions diverged: ${versions.join(", ")}`).toBe(1);
  });

  // THE check. A narrower "tests/integration and e2e have no version" would
  // miss a FUTURE versionless workspace whose name still matches the positive
  // glob — e.g. tests/load → @invisible-string/load-tests, which lands inside
  // `@invisible-string/*` with no negation covering it.
  test("versionless workspaces are exactly the ones fixed[] negates", () => {
    const versionless = workspaceDirs()
      .map((dir) => readManifest(dir))
      .filter((m) => m.version === undefined)
      .map((m) => m.name)
      .sort();

    const negated = config.fixed[0]!
      .filter((p) => p.startsWith("!"))
      .map((p) => p.slice(1))
      .sort();

    expect(versionless).toEqual(negated);
  });

  test("fixed globs match the approved literal", () => {
    expect(config.fixed).toEqual([
      [
        "@invisible-string/*",
        "!@invisible-string/e2e",
        "!@invisible-string/integration-tests",
      ],
    ]);
  });

  test("load-bearing config values", () => {
    // privatePackages.version:false versions nothing (all workspaces are
    // private); tag:true mints eight per-package tags per release;
    // changelog:!false writes eight near-empty per-package CHANGELOG.md files.
    expect(config.privatePackages).toEqual({ version: true, tag: false });
    expect(config.changelog).toBe(false);
    expect(config.baseBranch).toBe("main");
  });

  test("@changesets/cli is pinned exactly", () => {
    const pin = readManifest(".").devDependencies?.["@changesets/cli"];
    expect(pin, "@changesets/cli missing from root devDependencies").toBeDefined();
    expect(pin).toMatch(EXACT_SEMVER);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
bun test tests/integration/changesets-config.test.ts
```

Expected: FAIL — `ENOENT` on `.changeset/config.json`.

- [ ] **Step 3: Install Changesets at an exact pin**

```bash
bun add -D -E @changesets/cli@2.31.1
```

Verify the root `package.json` shows `"@changesets/cli": "2.31.1"` with **no** `^`. If a caret appears, edit it to the bare version and re-run `bun install`.

- [ ] **Step 4: Add the release scripts to the root `package.json`**

In the root `"scripts"` block, after `"slack:manifest"`:

```json
"changeset": "changeset",
"release:version": "bun run scripts/release-version.ts",
"release:tag": "bun run scripts/release-tag.ts"
```

- [ ] **Step 5: Seed `"version": "0.2.0"` into the eight shipped manifests**

Place `version` immediately after `name` in each file. `0.2.0` is the current released tag.

```bash
for d in apps/control-plane apps/site apps/web apps/worker \
         packages/compiler packages/db packages/design-tokens packages/shared; do
  node -e '
    const p = process.argv[1] + "/package.json";
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.version) process.exit(0);
    const { name, ...rest } = j;
    fs.writeFileSync(p, JSON.stringify({ name, version: "0.2.0", ...rest }, null, 2) + "\n");
  ' "$d"
done
```

Then confirm `tests/integration` and `e2e` were **not** touched:

```bash
git diff --name-only | grep -E '^(tests|e2e)/' && echo "ERROR: test workspace modified" || echo "OK"
```

- [ ] **Step 6: Create `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.4/schema.json",
  "changelog": false,
  "commit": false,
  "fixed": [
    [
      "@invisible-string/*",
      "!@invisible-string/e2e",
      "!@invisible-string/integration-tests"
    ]
  ],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": [],
  "privatePackages": { "version": true, "tag": false }
}
```

- [ ] **Step 7: Create `.changeset/README.md`**

```markdown
# Changesets

Files in this directory describe changes waiting to be released. Every
behavior-affecting PR should add one — see the **Releases** section of
`AGENTS.md` for the bump rules, the `**Breaking:**` marker, and the two
workspaces that must never be named.

Write the file directly rather than running `bun changeset`; the interactive
prompt walks all ten workspaces, including the two that are excluded.
```

- [ ] **Step 8: Run the guard test — it must now pass**

```bash
bun test tests/integration/changesets-config.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 9: Verify the lockfile still satisfies a cold frozen install**

This is the check that the three Dockerfiles depend on (§3 finding 5).

```bash
bun install --frozen-lockfile
```

Expected: exit 0, no lockfile modification. Confirm with `git diff --stat bun.lock`.

- [ ] **Step 10: Commit**

```bash
git add .changeset package.json bun.lock apps/*/package.json packages/*/package.json tests/integration/changesets-config.test.ts
git commit -m "feat(release): adopt changesets — pinned cli, fixed-version config, drift guard"
```

---

### Task 2: Changeset parsing, validation, and changelog rendering

Pure modules plus the `release:version` entrypoint.

**Files:**
- Create: `scripts/release/workspaces.ts`, `scripts/release/workspaces.test.ts`
- Create: `scripts/release/changesets.ts`, `scripts/release/changesets.test.ts`
- Create: `scripts/release/changelog.ts`, `scripts/release/changelog.test.ts`
- Create: `scripts/release-version.ts`

**Interfaces:**
- Consumes: `.changeset/config.json` and the seeded manifests from Task 1.
- Produces:
  - `interface Workspace { name: string; dir: string; version?: string }`
  - `readWorkspaces(root: string): Workspace[]`
  - `interface ChangesetEntry { file: string; bumps: Record<string, Bump>; summary: string }`
  - `type Bump = "major" | "minor" | "patch"`
  - `parseChangeset(file: string, text: string): ChangesetEntry`
  - `validateChangesets(entries: ChangesetEntry[], workspaces: Workspace[]): string[]`
  - `renderSection(version: string, date: string, entries: ChangesetEntry[]): string`
  - `insertSection(changelog: string, section: string): string`
  - Task 5 relies on `renderSection`'s exact output shape.

- [ ] **Step 1: Write the failing test for workspace enumeration**

Create `scripts/release/workspaces.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readWorkspaces } from "./workspaces";

const ROOT = join(import.meta.dir, "..", "..");

describe("readWorkspaces", () => {
  test("expands the root workspace globs", () => {
    const names = readWorkspaces(ROOT).map((w) => w.name).sort();
    expect(names).toContain("@invisible-string/web");
    expect(names).toContain("@invisible-string/e2e");
    expect(names).toContain("@invisible-string/integration-tests");
    expect(names.length).toBe(10);
  });

  test("reports which workspaces carry a version", () => {
    const byName = new Map(readWorkspaces(ROOT).map((w) => [w.name, w]));
    expect(byName.get("@invisible-string/web")?.version).toBeDefined();
    expect(byName.get("@invisible-string/e2e")?.version).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
bun test scripts/release/workspaces.test.ts
```

Expected: FAIL — cannot resolve `./workspaces`.

- [ ] **Step 3: Implement `scripts/release/workspaces.ts`**

```ts
/**
 * Workspace enumeration for the release scripts. Expands the root
 * package.json `workspaces` globs (only the trailing-`/*` form this repo uses)
 * and reads each manifest's name and version.
 *
 * A workspace WITHOUT a version is deliberately excluded from versioning —
 * see the design spec §5.1. Callers use that absence, not a hard-coded list.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  name: string;
  dir: string;
  version?: string;
}

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: string[];
}

function readManifest(root: string, dir: string): Manifest {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
}

export function readWorkspaces(root: string): Workspace[] {
  const patterns = readManifest(root, ".").workspaces ?? [];
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });

  return dirs
    .map((dir) => {
      const manifest = readManifest(root, dir);
      return { name: manifest.name ?? dir, dir, version: manifest.version };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run the test — it must pass**

```bash
bun test scripts/release/workspaces.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing tests for changeset parsing and validation**

Create `scripts/release/changesets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseChangeset, validateChangesets } from "./changesets";
import type { Workspace } from "./workspaces";

const WORKSPACES: Workspace[] = [
  { name: "@invisible-string/web", dir: "apps/web", version: "0.2.0" },
  { name: "@invisible-string/shared", dir: "packages/shared", version: "0.2.0" },
  { name: "@invisible-string/e2e", dir: "e2e" },
];

describe("parseChangeset", () => {
  test("reads bumps and summary", () => {
    const entry = parseChangeset(
      "brave-pandas-smile.md",
      `---
"@invisible-string/web": minor
"@invisible-string/shared": patch
---

Replace the markdown renderer with Streamdown.
`,
    );
    expect(entry.file).toBe("brave-pandas-smile.md");
    expect(entry.bumps).toEqual({
      "@invisible-string/web": "minor",
      "@invisible-string/shared": "patch",
    });
    expect(entry.summary).toBe("Replace the markdown renderer with Streamdown.");
  });

  test("joins a multi-line summary into one line", () => {
    const entry = parseChangeset(
      "x.md",
      `---
"@invisible-string/web": patch
---

First line
second line.
`,
    );
    expect(entry.summary).toBe("First line second line.");
  });

  test("accepts unquoted package keys", () => {
    const entry = parseChangeset("x.md", `---\n@invisible-string/web: minor\n---\n\nHi.\n`);
    expect(entry.bumps).toEqual({ "@invisible-string/web": "minor" });
  });

  test("rejects a file with no frontmatter", () => {
    expect(() => parseChangeset("bad.md", "just prose\n")).toThrow(/frontmatter/);
  });

  test("rejects an unknown bump type", () => {
    expect(() =>
      parseChangeset("bad.md", `---\n"@invisible-string/web": huge\n---\n\nHi.\n`),
    ).toThrow(/huge/);
  });
});

describe("validateChangesets", () => {
  test("accepts a changeset naming only versioned workspaces", () => {
    const entry = parseChangeset("ok.md", `---\n"@invisible-string/web": minor\n---\n\nHi.\n`);
    expect(validateChangesets([entry], WORKSPACES)).toEqual([]);
  });

  // Naming a versionless workspace produces a SILENT ZOMBIE under changesets:
  // exit 0, file never consumed, nothing bumped, forever. See spec §3 finding 7.
  test("rejects a changeset naming a versionless workspace", () => {
    const entry = parseChangeset("bad.md", `---\n"@invisible-string/e2e": patch\n---\n\nHi.\n`);
    const errors = validateChangesets([entry], WORKSPACES);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad.md");
    expect(errors[0]).toContain("@invisible-string/e2e");
  });

  test("rejects a changeset naming a package that is not a workspace", () => {
    const entry = parseChangeset("typo.md", `---\n"@invisible-string/webb": minor\n---\n\nHi.\n`);
    const errors = validateChangesets([entry], WORKSPACES);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("typo.md");
    expect(errors[0]).toContain("@invisible-string/webb");
  });

  test("reports every offending entry, not just the first", () => {
    const a = parseChangeset("a.md", `---\n"@invisible-string/e2e": patch\n---\n\nHi.\n`);
    const b = parseChangeset("b.md", `---\n"@invisible-string/nope": patch\n---\n\nHi.\n`);
    expect(validateChangesets([a, b], WORKSPACES)).toHaveLength(2);
  });
});
```

- [ ] **Step 6: Run to confirm failure**

```bash
bun test scripts/release/changesets.test.ts
```

Expected: FAIL — cannot resolve `./changesets`.

- [ ] **Step 7: Implement `scripts/release/changesets.ts`**

```ts
/**
 * Parsing and validation for `.changeset/*.md`.
 *
 * Validation exists because changesets handles a versionless (= auto-ignored)
 * package badly in two different ways, neither of them obvious:
 *
 *   - named ALONE: exit 0, "All files have been updated", the changeset is
 *     never consumed and nothing is bumped — a zombie that persists forever.
 *   - named ALONGSIDE a versioned package: "Mixed changesets that contain both
 *     ignored and not ignored packages are not allowed", from deep inside
 *     assemble-release-plan.
 *
 * Both become one clear, file-located error before changesets ever runs.
 */
import type { Workspace } from "./workspaces";

export type Bump = "major" | "minor" | "patch";

export interface ChangesetEntry {
  file: string;
  bumps: Record<string, Bump>;
  summary: string;
}

const BUMPS: readonly string[] = ["major", "minor", "patch"];

export function parseChangeset(file: string, text: string): ChangesetEntry {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trimStart());
  if (!match) throw new Error(`${file}: missing --- frontmatter block`);

  const [, frontmatter = "", body = ""] = match;
  const bumps: Record<string, Bump> = {};

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = /^"?([^":]+)"?\s*:\s*(\S+)$/.exec(trimmed);
    if (!entry) throw new Error(`${file}: cannot parse frontmatter line: ${trimmed}`);
    const [, name = "", bump = ""] = entry;
    if (!BUMPS.includes(bump)) {
      throw new Error(`${file}: unknown bump type "${bump}" for ${name}`);
    }
    bumps[name] = bump as Bump;
  }

  if (Object.keys(bumps).length === 0) {
    throw new Error(`${file}: frontmatter names no packages`);
  }

  const summary = body.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
  if (!summary) throw new Error(`${file}: has no summary`);

  return { file, bumps, summary };
}

export function validateChangesets(
  entries: ChangesetEntry[],
  workspaces: Workspace[],
): string[] {
  const versioned = new Set(workspaces.filter((w) => w.version).map((w) => w.name));
  const known = new Set(workspaces.map((w) => w.name));
  const errors: string[] = [];

  for (const entry of entries) {
    for (const name of Object.keys(entry.bumps)) {
      if (!known.has(name)) {
        errors.push(
          `.changeset/${entry.file} names "${name}", which is not a workspace in this repo.`,
        );
      } else if (!versioned.has(name)) {
        errors.push(
          `.changeset/${entry.file} names "${name}", which is excluded from versioning ` +
            `(it has no "version" field). Name only shipped workspaces — see AGENTS.md → Releases.`,
        );
      }
    }
  }

  return errors;
}
```

- [ ] **Step 8: Run the tests — they must pass**

```bash
bun test scripts/release/changesets.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Write the failing tests for changelog rendering**

Create `scripts/release/changelog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ChangesetEntry } from "./changesets";
import { insertSection, renderSection } from "./changelog";

const entry = (
  bumps: ChangesetEntry["bumps"],
  summary: string,
  file = "x.md",
): ChangesetEntry => ({ file, bumps, summary });

describe("renderSection", () => {
  test("groups by section and labels the scope", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry({ "@invisible-string/web": "minor" }, "Replace the markdown renderer with Streamdown."),
      entry({ "@invisible-string/worker": "patch" }, "Normalize `WORKER_ID` to lowercase."),
    ]);
    expect(out).toBe(
      `## v0.3.0 — 2026-08-08

### Features
- **web** — Replace the markdown renderer with Streamdown.

### Fixes & maintenance
- **worker** — Normalize \`WORKER_ID\` to lowercase.
`,
    );
  });

  // While on 0.x a breaking change ships as a `minor` (semver §4), so the bump
  // type cannot select the section — the marker does.
  test("the **Breaking:** marker wins over the bump type, and is stripped", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry(
        { "@invisible-string/control-plane": "minor" },
        "**Breaking:** eve session API v2; republish to migrate.",
      ),
    ]);
    expect(out).toContain("### Breaking changes");
    expect(out).toContain("- **control-plane** — eve session API v2; republish to migrate.");
    expect(out).not.toContain("**Breaking:** eve");
    expect(out).not.toContain("### Features");
  });

  test("a major bump also lands under Breaking changes", () => {
    const out = renderSection("1.0.0", "2026-08-08", [
      entry({ "@invisible-string/shared": "major" }, "Declare 1.0."),
    ]);
    expect(out).toContain("### Breaking changes");
  });

  test("multiple packages join with a comma", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry(
        { "@invisible-string/control-plane": "minor", "@invisible-string/worker": "minor" },
        "Shared change.",
      ),
    ]);
    expect(out).toContain("- **control-plane, worker** — Shared change.");
  });

  test("empty sections are omitted", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry({ "@invisible-string/web": "patch" }, "A fix."),
    ]);
    expect(out).not.toContain("### Features");
    expect(out).not.toContain("### Breaking changes");
  });
});

describe("insertSection", () => {
  test("inserts above the first ## heading, below the preamble", () => {
    const existing = `# Changelog

Preamble prose.

## v0.2.0 — 2026-07-21

Old stuff.
`;
    const out = insertSection(existing, "## v0.3.0 — 2026-08-08\n\n### Features\n- **web** — New.\n");
    expect(out).toBe(
      `# Changelog

Preamble prose.

## v0.3.0 — 2026-08-08

### Features
- **web** — New.

## v0.2.0 — 2026-07-21

Old stuff.
`,
    );
  });

  test("appends when the file has no ## heading yet", () => {
    const out = insertSection("# Changelog\n\nPreamble.\n", "## v0.3.0 — 2026-08-08\n");
    expect(out).toBe("# Changelog\n\nPreamble.\n\n## v0.3.0 — 2026-08-08\n");
  });
});
```

- [ ] **Step 10: Run to confirm failure**

```bash
bun test scripts/release/changelog.test.ts
```

Expected: FAIL — cannot resolve `./changelog`.

- [ ] **Step 11: Implement `scripts/release/changelog.ts`**

```ts
/**
 * Root-CHANGELOG.md rendering.
 *
 * Changesets writes per-package changelogs; this repo ships as ONE unit, so
 * `changelog: false` disables that and these functions produce a single root
 * file instead.
 *
 * STRUCTURAL RULE, depended on by scripts/release-tag.ts too: the preamble may
 * use `# ` and prose, but the FIRST `## ` in the file is always the newest
 * release. That is how the release-notes body is extracted.
 */
import type { ChangesetEntry } from "./changesets";

const BREAKING_MARKER = "**Breaking:**";

/** Rendered in this order; empty ones are dropped. */
const SECTIONS = ["Breaking changes", "Features", "Fixes & maintenance"] as const;
export type Section = (typeof SECTIONS)[number];

export function classify(entry: ChangesetEntry): Section {
  if (entry.summary.startsWith(BREAKING_MARKER)) return "Breaking changes";
  const bumps = Object.values(entry.bumps);
  if (bumps.includes("major")) return "Breaking changes";
  if (bumps.includes("minor")) return "Features";
  return "Fixes & maintenance";
}

function scope(entry: ChangesetEntry): string {
  return Object.keys(entry.bumps)
    .map((name) => name.replace(/^@invisible-string\//, ""))
    .sort()
    .join(", ");
}

function line(entry: ChangesetEntry): string {
  const summary = entry.summary.startsWith(BREAKING_MARKER)
    ? entry.summary.slice(BREAKING_MARKER.length).trim()
    : entry.summary;
  return `- **${scope(entry)}** — ${summary}`;
}

export function renderSection(
  version: string,
  date: string,
  entries: ChangesetEntry[],
): string {
  const blocks = SECTIONS.flatMap((section) => {
    const lines = entries.filter((e) => classify(e) === section).map(line);
    return lines.length === 0 ? [] : [`### ${section}\n${lines.join("\n")}`];
  });

  return `## v${version} — ${date}\n\n${blocks.join("\n\n")}\n`;
}

export function insertSection(changelog: string, section: string): string {
  const body = section.endsWith("\n") ? section : `${section}\n`;
  const index = changelog.startsWith("## ") ? 0 : changelog.indexOf("\n## ") + 1;

  if (index <= 0) {
    const separator = changelog.endsWith("\n") ? "\n" : "\n\n";
    return `${changelog}${separator}${body}`;
  }
  return `${changelog.slice(0, index)}${body}\n${changelog.slice(index)}`;
}
```

- [ ] **Step 12: Run the tests — they must pass**

```bash
bun test scripts/release/changelog.test.ts
```

Expected: PASS, 7 tests. If the `insertSection` spacing assertions fail, fix the implementation, not the test — the expected output in the test is the contract.

- [ ] **Step 13: Implement the `release-version` entrypoint**

Create `scripts/release-version.ts`:

```ts
/**
 * The `version` command for changesets/action.
 *
 * Validates pending changesets, runs `changeset version`, then writes the
 * single root CHANGELOG.md that `changelog: false` suppresses.
 *
 * Ordering matters: changesets DELETES the .changeset/*.md files, so they are
 * read and parsed before the bump, not after.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseChangeset,
  validateChangesets,
  type ChangesetEntry,
} from "./release/changesets";
import { insertSection, renderSection } from "./release/changelog";
import { readWorkspaces } from "./release/workspaces";

const ROOT = join(import.meta.dir, "..");
const CHANGESET_DIR = join(ROOT, ".changeset");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CARRIER = join(ROOT, "packages", "shared", "package.json");

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

function currentVersion(): string {
  const manifest = JSON.parse(readFileSync(CARRIER, "utf8")) as { version?: string };
  return manifest.version ?? fail("packages/shared/package.json has no version field");
}

function pendingChangesets(): ChangesetEntry[] {
  return readdirSync(CHANGESET_DIR)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => parseChangeset(f, readFileSync(join(CHANGESET_DIR, f), "utf8")));
}

const entries = pendingChangesets();

const errors = validateChangesets(entries, readWorkspaces(ROOT));
if (errors.length > 0) {
  for (const error of errors) console.error(`✖ ${error}`);
  process.exit(1);
}

if (entries.length === 0) {
  console.log("No changesets pending — nothing to version.");
  process.exit(0);
}

const before = currentVersion();

const result = Bun.spawnSync(["bunx", "changeset", "version"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) fail(`changeset version exited ${result.exitCode}`);

const after = currentVersion();
if (after === before) {
  console.log(`Version unchanged at ${before} — leaving CHANGELOG.md alone.`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const section = renderSection(after, date, entries);
const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : "";
writeFileSync(CHANGELOG, insertSection(existing, section));

console.log(`Wrote CHANGELOG.md section for v${after} (${entries.length} changesets).`);
```

- [ ] **Step 14: Typecheck**

```bash
bun run typecheck
```

Expected: PASS. `tsc -p scripts` covers the new modules and their tests.

- [ ] **Step 15: Verify validation rejects an excluded workspace end to end**

```bash
cat > .changeset/zzz-temp-check.md <<'EOF'
---
"@invisible-string/e2e": patch
---

Temporary validation check.
EOF
bun run release:version; echo "exit=$?"
rm .changeset/zzz-temp-check.md
```

Expected: exit **1**, with a message naming `zzz-temp-check.md` and `@invisible-string/e2e`. Confirm the manifests were **not** bumped (`git diff --stat` clean).

- [ ] **Step 16: Commit**

```bash
git add scripts/release scripts/release-version.ts
git commit -m "feat(release): changeset parsing, validation, and root changelog rendering"
```

---

### Task 3: The tag/release decision and its entrypoint

**Files:**
- Create: `scripts/release/decide.ts`, `scripts/release/decide.test.ts`
- Create: `scripts/release-tag.ts`

**Interfaces:**
- Consumes: `renderSection`'s output shape (the `## v<version> — <date>` heading) from Task 2.
- Produces:
  - `type TagState = { kind: "absent" } | { kind: "present"; versionAtTag?: string; pointsAtHead: boolean }`
  - `type Decision = { action: "tag-and-release" } | { action: "ensure-release" } | { action: "noop"; reason: string } | { action: "fail"; message: string }`
  - `decide(version: string, tag: TagState): Decision`
  - `extractLatestSection(changelog: string): { heading: string; body: string } | undefined`
- Task 4 consumes the `released` / `version` GitHub outputs this entrypoint writes.

- [ ] **Step 1: Write the failing tests for the decision function**

Create `scripts/release/decide.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decide, extractLatestSection } from "./decide";

describe("decide", () => {
  test("no tag yet → tag and release", () => {
    expect(decide("0.3.0", { kind: "absent" })).toEqual({ action: "tag-and-release" });
  });

  test("tag at HEAD with a matching version → ensure the release exists", () => {
    expect(
      decide("0.3.0", { kind: "present", versionAtTag: "0.3.0", pointsAtHead: true }),
    ).toEqual({ action: "ensure-release" });
  });

  test("tag on an older commit with a matching version → no-op", () => {
    const decision = decide("0.3.0", {
      kind: "present",
      versionAtTag: "0.3.0",
      pointsAtHead: false,
    });
    expect(decision.action).toBe("noop");
  });

  // The transition window: every existing tag (v0.1.3..v0.2.0) predates the
  // `version` field, so `git show <tag>:packages/shared/package.json` succeeds
  // but has no version key. Seeded at 0.2.0, EVERY push to main hits this
  // until the first Version PR merges. Without this branch it exits 1.
  test("tag predating version fields → no-op, never an error", () => {
    const decision = decide("0.2.0", {
      kind: "present",
      versionAtTag: undefined,
      pointsAtHead: false,
    });
    expect(decision.action).toBe("noop");
    expect(decision).toMatchObject({ reason: expect.stringContaining("predates") });
  });

  test("tag marking a different version → hard fail", () => {
    const decision = decide("0.3.1", {
      kind: "present",
      versionAtTag: "0.3.0",
      pointsAtHead: false,
    });
    expect(decision.action).toBe("fail");
    expect(decision).toMatchObject({ message: expect.stringContaining("0.3.1") });
  });
});

describe("extractLatestSection", () => {
  const changelog = `# Changelog

Preamble.

## v0.3.0 — 2026-08-08

### Features
- **web** — New.

## v0.2.0 — 2026-07-21

Older.
`;

  test("returns the first ## section only", () => {
    const section = extractLatestSection(changelog);
    expect(section?.heading).toBe("v0.3.0 — 2026-08-08");
    expect(section?.body).toBe("### Features\n- **web** — New.");
  });

  test("returns undefined when there is no ## heading", () => {
    expect(extractLatestSection("# Changelog\n\nPreamble.\n")).toBeUndefined();
  });

  test("handles a single section running to EOF", () => {
    const section = extractLatestSection("# C\n\n## v0.3.0 — 2026-08-08\n\nOnly.\n");
    expect(section?.heading).toBe("v0.3.0 — 2026-08-08");
    expect(section?.body).toBe("Only.");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test scripts/release/decide.test.ts
```

Expected: FAIL — cannot resolve `./decide`.

- [ ] **Step 3: Implement `scripts/release/decide.ts`**

```ts
/**
 * The release decision, as a pure function over observed git state.
 *
 * Two values drive everything:
 *   V  — the version in packages/shared/package.json (what this commit CLAIMS
 *        to be)
 *   Vt — the version recorded at the tag's own commit (what the tag MARKED)
 *
 * Comparing them is what separates "this release already finished" — the
 * common case on every ordinary push to main — from "this tag marks something
 * else entirely", which is a genuine inconsistency worth stopping for.
 *
 * The tag is deliberately NOT the sole no-op key: it is the first side effect,
 * so keying solely on its existence would make any failure after tagging
 * unrecoverable (a re-run would skip everything, and re-pushing an existing
 * tag is a no-op). Image pushes are idempotent, so re-running is safe.
 */
export type TagState =
  | { kind: "absent" }
  | { kind: "present"; versionAtTag?: string; pointsAtHead: boolean };

export type Decision =
  | { action: "tag-and-release" }
  | { action: "ensure-release" }
  | { action: "noop"; reason: string }
  | { action: "fail"; message: string };

export function decide(version: string, tag: TagState): Decision {
  if (tag.kind === "absent") return { action: "tag-and-release" };

  // Every tag from v0.1.3 to v0.2.0 predates the `version` field entirely, so
  // `git show <tag>:packages/shared/package.json` succeeds with no version key.
  if (tag.versionAtTag === undefined) {
    return {
      action: "noop",
      reason: `tag v${version} predates versioned manifests — nothing to release`,
    };
  }

  if (tag.versionAtTag !== version) {
    return {
      action: "fail",
      message:
        `tag v${version} already exists but marks a commit whose version is ` +
        `${tag.versionAtTag}, not ${version}. A hand-pushed tag likely burned this ` +
        `number — align the manifests to it (docs/DEPLOY.md §10) before releasing.`,
    };
  }

  if (tag.pointsAtHead) return { action: "ensure-release" };

  return { action: "noop", reason: `v${version} was already released` };
}

/** The newest release section: everything from the first `## ` to the next. */
export function extractLatestSection(
  changelog: string,
): { heading: string; body: string } | undefined {
  const start = changelog.startsWith("## ") ? 0 : changelog.indexOf("\n## ") + 1;
  if (start <= 0) return undefined;

  const rest = changelog.slice(start);
  const newlineIndex = rest.indexOf("\n");
  const heading = rest.slice(3, newlineIndex === -1 ? undefined : newlineIndex).trim();

  const after = rest.slice(newlineIndex + 1);
  const nextIndex = after.indexOf("\n## ");
  const body = (nextIndex === -1 ? after : after.slice(0, nextIndex)).trim();

  return { heading, body };
}
```

- [ ] **Step 4: Run the tests — they must pass**

```bash
bun test scripts/release/decide.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Implement `scripts/release-tag.ts`**

```ts
/**
 * Tag the release, create its GitHub Release, and tell the workflow whether to
 * build images. Runs on main pushes only, after changesets/action.
 *
 * All decision logic lives in scripts/release/decide.ts; this file only gathers
 * git state and performs effects.
 *
 * Requires in CI: GH_TOKEN (gh auth) and a configured git user (annotated tag).
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decide, extractLatestSection, type TagState } from "./release/decide";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CARRIER = join(ROOT, "packages", "shared", "package.json");

function run(...args: string[]): { code: number; stdout: string } {
  const proc = Bun.spawnSync(args, { cwd: ROOT });
  return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout).trim() };
}

function mustRun(...args: string[]): string {
  const proc = Bun.spawnSync(args, { cwd: ROOT, stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`✖ command failed: ${args.join(" ")}`);
    process.exit(1);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

function output(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}

const version = (JSON.parse(readFileSync(CARRIER, "utf8")) as { version: string }).version;
const tag = `v${version}`;

function observeTag(): TagState {
  if (run("git", "rev-parse", "--verify", `refs/tags/${tag}`).code !== 0) {
    return { kind: "absent" };
  }
  const shown = run("git", "show", `${tag}:packages/shared/package.json`);
  const versionAtTag =
    shown.code === 0
      ? (JSON.parse(shown.stdout) as { version?: string }).version
      : undefined;
  const tagCommit = run("git", "rev-list", "-n", "1", tag).stdout;
  const head = run("git", "rev-parse", "HEAD").stdout;
  return { kind: "present", versionAtTag, pointsAtHead: tagCommit === head };
}

function ensureRelease(): void {
  if (run("gh", "release", "view", tag).code === 0) {
    console.log(`Release ${tag} already exists.`);
    return;
  }
  if (!existsSync(CHANGELOG)) {
    console.error(`✖ CHANGELOG.md missing — cannot build release notes for ${tag}`);
    process.exit(1);
  }
  const section = extractLatestSection(readFileSync(CHANGELOG, "utf8"));
  if (!section) {
    console.error(`✖ CHANGELOG.md has no "## " section — cannot build notes for ${tag}`);
    process.exit(1);
  }
  // Guard against a hand-edited changelog attaching the wrong notes.
  if (!section.heading.startsWith(tag)) {
    console.error(
      `✖ newest CHANGELOG.md section is "${section.heading}", expected it to start with ${tag}`,
    );
    process.exit(1);
  }
  const notes = join(ROOT, ".release-notes.md");
  writeFileSync(notes, `${section.body}\n`);
  mustRun("gh", "release", "create", tag, "--title", tag, "--notes-file", notes);
  console.log(`Created release ${tag}.`);
}

const decision = decide(version, observeTag());

switch (decision.action) {
  case "fail":
    console.error(`✖ ${decision.message}`);
    process.exit(1);
  case "noop":
    console.log(`No release: ${decision.reason}.`);
    output("released", "false");
    break;
  case "tag-and-release":
    mustRun("git", "tag", "-a", tag, "-m", tag);
    mustRun("git", "push", "origin", tag);
    ensureRelease();
    output("released", "true");
    output("version", tag);
    break;
  case "ensure-release":
    ensureRelease();
    output("released", "true");
    output("version", tag);
    break;
}
```

- [ ] **Step 6: Typecheck and run the whole suite**

```bash
bun run typecheck && bun test
```

Expected: both PASS.

- [ ] **Step 7: Verify the transition-window case against the real repo**

This is spec acceptance criterion 5 — the state every push to `main` hits until the first Version PR merges.

```bash
bun run release:tag; echo "exit=$?"
```

Expected: exit **0**, printing `No release: tag v0.2.0 predates versioned manifests — nothing to release.` and `released=false`. It must **not** error, and must **not** create a tag (`git tag | grep -c v0.2.0` stays `1`).

- [ ] **Step 8: Commit**

```bash
git add scripts/release/decide.ts scripts/release/decide.test.ts scripts/release-tag.ts
git commit -m "feat(release): idempotent tag and GitHub Release decision"
```

---

### Task 4: Wire the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `release:version` and `release:tag` from Tasks 2–3, and the `released` / `version` outputs the latter writes.
- Produces: a `version` job whose outputs gate the existing `images` matrix.

- [ ] **Step 1: Rewrite `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    branches: [main]
    tags: ["v*"]

# contents: write — push the release tag and create the GitHub Release.
# pull-requests: write — open/update the "Version Packages" PR.
permissions:
  contents: write
  packages: write
  pull-requests: write

concurrency: release-${{ github.ref }}

jobs:
  # Maintains the "Version Packages" PR; when that PR merges, tags the release
  # and cuts its GitHub Release. Tag and image build happen in ONE run on
  # purpose: a tag pushed with GITHUB_TOKEN cannot trigger another workflow, so
  # splitting them would need a PAT.
  version:
    name: Version and tag
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: nscloud-ubuntu-24.04-amd64-4x8
    timeout-minutes: 15
    outputs:
      released: ${{ steps.tag.outputs.released }}
      version: ${{ steps.tag.outputs.version }}
    steps:
      # fetch-depth: 0 also fetches tags, which release:tag needs to decide
      # whether this version was already released.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # Installs the pinned host toolchain from mise.toml (bun, node, …) and
      # puts mise's shims on PATH, so the bare `bun` calls below are those
      # exact versions — no `mise exec` wrapper needed.
      - uses: jdx/mise-action@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # No `publish:` input — nothing here is published to npm, so the action's
      # only job is the Version PR. Requires "Allow GitHub Actions to create and
      # approve pull requests" in repo settings.
      - name: Create or update the Version Packages PR
        uses: changesets/action@v1
        with:
          version: bun run release:version
          commit: "chore(release): version packages"
          title: "chore(release): version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Tag and release
        id: tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          bun run release:tag
        env:
          GH_TOKEN: ${{ github.token }}

  images:
    name: Build and push images
    needs: [version]
    # `!cancelled()` (not `always()`) so the tag-push path still runs when
    # `version` is SKIPPED, while a cancelled run does not publish images, and a
    # FAILED version job leaves both disjuncts false so this correctly skips.
    # The ${{ }} wrapper is mandatory: a bare leading `!` is a YAML tag
    # indicator and the file would not parse.
    if: ${{ !cancelled() && (needs.version.outputs.released == 'true' || startsWith(github.ref, 'refs/tags/v')) }}
    runs-on: nscloud-ubuntu-24.04-amd64-8x16
    timeout-minutes: 30
    strategy:
      matrix:
        include:
          - name: control-plane
            dockerfile: infra/docker/control-plane.Dockerfile
          - name: worker
            dockerfile: infra/docker/worker.Dockerfile
          - name: web
            dockerfile: infra/docker/web.Dockerfile
    steps:
      # No setup-buildx-action: Namespace runners come pre-configured with
      # remote builders, and stock buildx setup would override that. Layer
      # cache persists builder-side, so no cache-from/cache-to either.
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      # On the release path the ref is `main`, so github.ref_name would publish
      # `…-web:main`. A skipped job's outputs are empty strings, and '' is
      # falsy, so the fallback resolves correctly on the tag-push path.
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ghcr.io/heysanil/invisible-string-${{ matrix.name }}:${{ needs.version.outputs.version || github.ref_name }}
            ghcr.io/heysanil/invisible-string-${{ matrix.name }}:${{ github.sha }}
```

- [ ] **Step 2: Verify the workflow parses and the toolchain guard still passes**

The `!cancelled()` YAML-tag hazard means a parse check is not optional.

```bash
bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/release.yml").text()).jobs.images.if))'
```

Expected: prints the `if` expression as a **string** beginning `${{ !cancelled()`. Any parse error means the `${{ }}` wrapper was dropped.

```bash
bun test tests/integration/toolchain-pins.test.ts
```

Expected: PASS — the `version` job runs `bun`, and the guard requires `jdx/mise-action@v2` in exactly that case.

- [ ] **Step 3: Run the full default lane**

```bash
bun run typecheck && bun test
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): version job opens the changesets PR, tags, and gates image builds"
```

---

### Task 5: Backfill the changelog and seed the pending changesets

**Files:**
- Create: `CHANGELOG.md`
- Create: four files under `.changeset/`

**Interfaces:**
- Consumes: `renderSection`'s output shape from Task 2 — the backfilled sections must match it exactly, since `extractLatestSection` parses the same file.
- Produces: a `CHANGELOG.md` whose first `## ` is `v0.2.0`, and four pending changesets that make the first Changesets release `v0.3.0`.

- [ ] **Step 1: Gather the commit history per tag**

```bash
prev=""; for t in $(git tag --sort=v:refname); do
  [ -z "$prev" ] && range="$t" || range="$prev..$t"
  echo "### $t ($(git log -1 --format=%ad --date=short $t))"
  git log --oneline --no-merges $range | sed 's/^/    /'
  prev=$t
done
```

- [ ] **Step 2: Write `CHANGELOG.md`**

Preamble first (it must contain **no** `## ` heading — the first `## ` in the file is load-bearing), then one section per tag, newest first. Group by commit type: `feat!` → Breaking changes, `feat` → Features, `fix`/`ci`/`chore`/`refactor` → Fixes & maintenance. Use the conventional scope as the bold label. Drop pure `docs:` commits that shipped no behavior.

```markdown
# Changelog

All notable changes to this project, newest first.

Entries from `v0.3.0` onward are written at merge time as
[changesets](https://changesets.dev) — see the **Releases** section of
`AGENTS.md`. Entries for `v0.2.0` and earlier are a **historical
reconstruction** from the conventional-commit log between tags, not authored
release notes.

## v0.2.0 — 2026-07-21

### Breaking changes
- **agents** — Agents-first re-architecture: first-class agents, agent chat, and workflows that delegate to a bound agent version rather than compiling their own.

## v0.1.8 — 2026-07-09

### Fixes & maintenance
- **worker** — Normalize `WORKER_ID` to lowercase at config parse.

## v0.1.7 — 2026-07-09

### Features
- **site** — Deploy the marketing and docs site to Cloudflare Workers at invisiblestring.io.

### Fixes & maintenance
- **control-plane** — Disable Bun's default idle timeout on the API server, which was cutting quiet SSE run tails and cold-boot chat dispatches.
- **ci** — Add the docs-sentinel documentation audit; invoke wrangler via a pinned npx rather than wrangler-action.

## v0.1.6 — 2026-07-09

### Features
- **site** — Landing page and docs shell on the E1 design system, with messaging pivoted to user outcomes.
- **slack** — Checked-in Slack app manifest, renderer, and setup guide.
- **web** — Replace the triangle logo with a solid spool mark.

### Fixes & maintenance
- **design-tokens** — Extract the E1 tokens out of `apps/web` into `packages/design-tokens`.
- **build** — Resolve Node 24 directly; build steps no longer spawn the mise binary.
- **ci** — Move workflows to Namespace runners; copy the `apps/site` manifest into image builds, which a frozen install had broken.
- **site** — Eliminate layout shift from looping vignettes.

## v0.1.5 — 2026-07-08

### Features
- **web** — First-run workspace onboarding and invite acceptance.
- **infra** — Standalone external-data compose, with a CI drift guard.

## v0.1.4 — 2026-07-07

### Features
- **db** — The migrator now creates missing databases, healing volumes initialized without init scripts.

### Fixes & maintenance
- **infra** — Inline the prod compose config files so deploys work without a repo checkout.

## v0.1.3 — 2026-07-07

Initial release: the full platform spine across phases 0–4.

### Features
- **compiler, runtime** — Workflow→eve codegen with golden tests; build service, publish, sessions and runs, NDJSON tailer, SSE, capabilities.
- **worker** — Supervisor with artifact cache, per-agent processes, streaming proxy, and heartbeat; scheduler pool with affinity, failover, drain, and a sandbox reaper.
- **triggers** — Webhook, form, Slack, and schedule ingress; Slack app OAuth; cancellation; dispatch-time allowlisting.
- **web** — Glass shell and E1 theme, auth pages, hybrid workflow builder, chat surface, context and settings sections.
- **copilot** — WebSocket tool loop with validated draft mutations, and a copilot panel with diff-preview suggestion cards.
- **auth, db** — Better Auth with organizations and SSO, envelope crypto, schema, migrations, and seeds.
- **obs** — Structured logging with redaction, a metrics endpoint, deep health, and graceful lifecycle.
- **infra** — Production compose topology, container images for control-plane/worker/web, GHCR publishing on release tags, and a one-command dev orchestrator.

### Fixes & maintenance
- **infra** — Replace MinIO with Garage across the dev stack, every test harness, and all CI lanes.
- **worker** — Hand-pump artifact downloads; `Bun.write(Response)` stalls on Linux.
```

- [ ] **Step 3: Verify the backfilled file parses the way the scripts expect**

```bash
bun -e '
  const { extractLatestSection } = await import("./scripts/release/decide.ts");
  const s = extractLatestSection(await Bun.file("CHANGELOG.md").text());
  console.log(JSON.stringify(s?.heading));
'
```

Expected: `"v0.2.0 — 2026-07-21"`. Anything else means a stray `## ` leaked into the preamble.

- [ ] **Step 4: Seed the four pending changesets**

`.changeset/eve-0-31-session-api-v2.md`:

```markdown
---
"@invisible-string/control-plane": minor
"@invisible-string/worker": minor
"@invisible-string/compiler": minor
"@invisible-string/shared": minor
---

**Breaking:** Upgrade eve 0.19.0 → 0.31.3. Sessions are now ID-addressed (session API v2), continuation tokens are gone, and stop plus context controls are available. Every published agent must be republished to migrate.
```

`.changeset/streamdown-markdown-renderer.md`:

```markdown
---
"@invisible-string/web": minor
---

Replace the chat markdown renderer with Streamdown, including a streaming caret and E1-themed code blocks.
```

`.changeset/pin-host-toolchain-with-mise.md`:

```markdown
---
"@invisible-string/control-plane": patch
---

Pin the host toolchain (bun, node, wrangler) in `mise.toml` and install it in every CI job via `mise-action`, so all lanes run the same versions.
```

`.changeset/align-prod-image-node.md`:

```markdown
---
"@invisible-string/control-plane": patch
---

Align the production images' node with `packages/compiler/versions.json` and add a guard so the two cannot drift.
```

- [ ] **Step 5: Dry-run the version script to confirm it produces v0.3.0**

Do this on a scratch branch so the bump is not committed.

```bash
git switch -c scratch/version-dryrun
bun run release:version
node -pe "require('./packages/shared/package.json').version"
head -20 CHANGELOG.md
```

Expected: version `0.3.0`; the new top section is `## v0.3.0 — <today>` with a **Breaking changes** entry for eve, a **Features** entry for web, and a **Fixes & maintenance** entry for control-plane. The four `.changeset/*.md` files are consumed.

- [ ] **Step 6: Discard the dry run**

```bash
git restore . && git clean -fd .changeset && git switch - && git branch -D scratch/version-dryrun
git status --short
```

Expected: the four changesets and the backfilled `CHANGELOG.md` are present and unmodified; no version bump remains.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md .changeset
git commit -m "docs(release): backfill changelog through v0.2.0 and seed pending changesets"
```

---

### Task 6: Documentation

**Files:**
- Modify: `AGENTS.md` — living-doc table, new Releases section, the false CI sentence at line ~110
- Modify: `docs/DEPLOY.md` — §10 (line ~267)
- Modify: `README.md` — one line on releases

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing code-facing.

- [ ] **Step 1: Add two rows to the AGENTS.md living-documents table**

After the `docs/DEPLOY.md` row:

```markdown
| `docs/superpowers/specs/2026-08-08-changesets-release-workflow-design.md` | Release flow: version model, changelog generation, tag/release/image pipeline |
| `.changeset/` + `CHANGELOG.md` | Pending release notes and the shipped changelog |
```

- [ ] **Step 2: Fix the false CI sentence in AGENTS.md**

Line ~110 currently ends:

> `release.yml` and `docs-sentinel.yml` need no mise step: neither runs a host toolchain binary.

Replace with:

```markdown
`release.yml`'s `version` job DOES need mise (it runs `bun`); its `images` job and all of `docs-sentinel.yml` do not, since neither runs a host toolchain binary.
```

- [ ] **Step 3: Add a Releases section to AGENTS.md**

Place it after "Test lanes", before "Architecture":

```markdown
## Releases (changesets)

Every behavior-affecting PR adds a changeset — same commit as the change, the
same way docs move with code. Write the file directly rather than running
`bun changeset`; the prompt walks all ten workspaces:

```md
<!-- .changeset/any-name.md -->
---
"@invisible-string/web": minor
---

Replace the markdown renderer with Streamdown.
```

- **Bump types while on 0.x**: breaking → `minor` (semver §4 — anything may
  change below 1.0), feature → `minor`, fix/chore → `patch`. **`major` is
  reserved for the deliberate 1.0.0 cut** and is not used before then.
- **Mark breaking changes** by starting the summary with `**Breaking:**`. That
  marker, not the bump type, is what routes an entry to the changelog's
  "Breaking changes" section — necessary precisely because a 0.x breaking
  change ships as a `minor`.
- **Name only shipped workspaces.** `@invisible-string/e2e` and
  `@invisible-string/integration-tests` have no `version` and are excluded.
  Naming one alone makes changesets exit 0 and silently never consume the file
  — a zombie that blocks nothing and fixes nothing; naming one alongside a
  shipped package fails with "Mixed changesets...". `bun run release:version`
  rejects both up front, and
  `tests/integration/changesets-config.test.ts` guards the config that makes
  the exclusion work.
- **All eight shipped workspaces share one version** (`fixed` globs), because
  `docs/DEPLOY.md` pins all three images with a single `IMAGE_TAG`.

Releasing is merging: pushes to `main` keep a **"Version Packages"** PR up to
date; merging it bumps the manifests, writes `CHANGELOG.md`, tags `vX.Y.Z`,
cuts the GitHub Release, and builds the GHCR images — in one workflow run, so
no PAT is needed. Pushing a `v*` tag by hand still builds images, but then the
manifests must be aligned to that version or the number is burned
(`docs/DEPLOY.md` §10).
```

- [ ] **Step 4: Rewrite §10 of `docs/DEPLOY.md`**

Replace items 1–3 under "## 10. Upgrades & rollback":

```markdown
1. Merge the **"Version Packages"** PR that the `release` workflow keeps open on
   `main`. That bumps the version, writes `CHANGELOG.md`, pushes the `vX.Y.Z`
   tag, cuts the GitHub Release, and builds and pushes the three GHCR images
   tagged with the version and the commit sha. See AGENTS.md → Releases.
2. Change `IMAGE_TAG` to the new tag and redeploy (`up -d` re-pulls).
3. **Rollback** = set `IMAGE_TAG` back to the previous tag and redeploy.
   Migrations are additive (AGENTS.md golden rule), so rolling an image back to
   a prior tag against an already-migrated database is safe.
4. **Fallback:** pushing a `v*` tag by hand still builds and pushes images. If
   you do, immediately set the eight shipped `package.json` versions to that
   same number and commit — otherwise the next Version PR computes a version
   whose tag already exists, and the release stops with an error naming both
   commits.
```

- [ ] **Step 5: Add the release line to `README.md`**

At the end of the `## Deploy` section (line ~303), before `## Repo map`:

```markdown
Releases are cut by changesets: add a `.changeset/*.md` to any behavior-affecting
PR, then merge the "Version Packages" PR that CI keeps open on `main` — it tags
the release, writes `CHANGELOG.md`, and publishes the GHCR images. Details in
AGENTS.md → Releases.
```

- [ ] **Step 6: Verify the whole default lane one last time**

```bash
bun run typecheck && bun test
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/DEPLOY.md README.md
git commit -m "docs: document the changesets release flow"
```

---

## Post-merge checklist (not automatable)

1. **Enable "Allow GitHub Actions to create and approve pull requests"** —
   Settings → Actions → General. Without it, `changesets/action` fails at PR
   creation with an error that does not name the setting.
2. **Expect no CI checks on the Version PR.** A `GITHUB_TOKEN`-opened PR does not
   trigger `pull_request` workflows. Benign today — `main` has no branch
   protection. If required status checks are ever added to `main`, the Version PR
   becomes unmergeable and the action will need a PAT or GitHub App token.
3. **Confirm `gh` exists on the Namespace runner.** If the `Tag and release` step
   fails with `gh: command not found`, swap `ensureRelease` to the REST API via
   `actions/github-script`.
4. **First release is `v0.3.0`**, carrying the four seeded changesets.
