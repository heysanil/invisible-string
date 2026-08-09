# Changesets-based release workflow — design

**Date:** 2026-08-08
**Status:** Approved, ready for implementation
**Owns:** How a version number is chosen, how the changelog and GitHub Release are
produced, and how `release.yml` gets from a merged PR to published GHCR images.

---

## 1. Problem

Releases today are entirely manual and leave no record.

`release.yml` fires on `push: tags: ["v*"]` and does exactly one thing: build the
three GHCR images (`control-plane`, `worker`, `web`), tagged with `github.ref_name`
and `github.sha`. Everything upstream of that is a human typing `git tag vX.Y.Z`:

- **The version number is a guess.** Nothing reads the changes to decide whether a
  release is a patch, a minor, or a breaking change.
- **There is no changelog.** Seven tags exist (`v0.1.3` → `v0.2.0`) with no
  `CHANGELOG.md` and no GitHub Releases. The only record of what shipped in a
  version is `git log` between two tags.
- **Release intent is lost at merge time.** By the time a release is cut, the
  context for *why* a change matters — the thing a reader of release notes wants —
  has to be reconstructed from commit subjects.

The repo already has strong conventional-commit discipline, so the semver signal
exists (`7c37aec feat!:`, `7967ce2 feat!:`); nothing captures it.

## 2. Goals and non-goals

**Goals**

1. Every behavior-affecting PR carries a human-written note about what changed.
2. The version number is computed from those notes, not chosen by hand.
3. Merging one PR produces: a version bump, a `CHANGELOG.md` entry, a `v*` git
   tag, a GitHub Release, and the three GHCR images — with no further action.
4. The manual `git tag v* && git push --tags` path keeps working as a fallback.

**Non-goals**

- **Publishing to npm.** Every workspace is `private: true`. Nothing is consumed
  outside this repo, and nothing about this design changes that.
- **Per-app version lines.** `docs/DEPLOY.md` pins all three images with a single
  `IMAGE_TAG`; independent versions would break that contract.
- **A CI gate that fails PRs missing a changeset.** Enforcement is via `AGENTS.md`,
  consistent with how this repo already mandates doc updates.
- **Per-package `CHANGELOG.md` files.** See §5.

## 3. Empirical findings

Verified in a scratch replica of this repo's workspace layout, against
`@changesets/cli@2.31.1`. These are the facts the design depends on; re-verify any
of them before changing the corresponding decision.

1. **Bun is supported.** `@manypkg/get-packages` resolves this repo as
   `tool: bun` and discovers all ten workspaces. No lockfile shim is needed.
   Note that `npm install` *cannot* run in this repo at all — it rejects the
   `workspace:*` protocol with `EUNSUPPORTEDPROTOCOL` — so every release step must
   use `bun`.

2. **`fixed` accepts picomatch negation.** With
   `fixed: [["@invisible-string/*", "!@invisible-string/e2e", "!@invisible-string/integration-tests"]]`,
   a single `minor` on `@invisible-string/web` moved all eight shipped workspaces
   to the same version and left the two test workspaces untouched.

3. **A version-less workspace inside the `fixed` glob is a hard crash.** Without
   the negations, `changeset version` dies with
   `TypeError: Invalid version. Must be a string. Got type "undefined"` from
   `matchFixedConstraint → getCurrentHighestVersion`. This is the mechanism that
   excludes `tests/*` and `e2e`, and it is also why naming one of them in a
   changeset must be treated as an error (§8).

4. **Per-package changelogs are near-empty noise.** A single changeset produced
   eight `CHANGELOG.md` files, seven of which contained only a bare `## 0.3.0`
   heading. Confirms the single-root-changelog decision.

5. **`bun.lock` records workspace versions, but `--frozen-lockfile` ignores them.**
   The lock stores `"version": "0.2.0"` per workspace. After bumping the manifests
   to `0.3.0`, `bun install --frozen-lockfile` succeeded both warm and **cold**
   (`node_modules` removed — the case the three Dockerfiles actually hit). A plain
   `bun install` does *not* rewrite the recorded version, because the resolution
   graph is unchanged.

   **Consequence:** the release needs no lockfile choreography, and the Version PR
   does not need to carry a lockfile diff. The stale version string in `bun.lock`
   is cosmetic. **Risk:** if Bun ever tightens `--frozen-lockfile` to compare
   workspace versions, image builds break; §9 records this as a watched residual.

6. **`changesets/action@v1` has no `hasChangesets` output.** Its outputs are only
   `published` and `publishedPackages`; `hasChangesets` belongs to v2. The design
   therefore keys off tag existence instead (§6), which is idempotent anyway.

## 4. Version pinning

| Thing | Pin | Why |
|---|---|---|
| `@changesets/cli` | **`2.31.1`** exact | Current `latest`. v3 is still `3.0.0-next.11`. Exact per the repo's "version pins are exact" rule. |
| `changesets/action` | **`v1`** | Stable line. `v2.0.0-next.4` targets changesets v3; pairing v2 with cli 2.x is unsupported. |
| `.changeset/config.json` `$schema` | `@changesets/config@3.1.4` | The config version resolved by cli 2.31.1. |

`@changesets/cli` goes in the **root** `devDependencies`.

## 5. Versioning model

### 5.1 Version carrier

The eight **shipped** workspaces each get a `version` field, seeded at the current
released version `0.2.0`:

```
apps/control-plane  apps/site  apps/web  apps/worker
packages/compiler   packages/db  packages/design-tokens  packages/shared
```

`tests/integration` and `e2e` get **no** `version` field. Omitting it, combined
with the `fixed` negations, is what keeps them out of versioning entirely — see
finding 3.

Because all eight are `fixed`, they always hold the same value, and that value
**is** the repo version. `packages/shared/package.json` is the canonical place to
read it from (chosen because it is the most stable workspace in the tree).

### 5.2 Semver policy while on 0.x

Per semver §4 — *"Major version zero (0.y.z) is for initial development. Anything
MAY change at any time."* — breaking changes are legitimately released in a
**minor** bump while the version is below 1.0.0.

| Change | Bump while `0.x` | Bump after `1.0.0` |
|---|---|---|
| Breaking change | `minor` | `major` |
| Feature / user-visible improvement | `minor` | `minor` |
| Fix, chore, internal, docs-only-with-behavior | `patch` | `patch` |

`major` is **reserved for the deliberate 1.0.0 declaration** and is not used
otherwise while on 0.x.

### 5.3 Marking breaking changes

Because breaking changes and features both arrive as `minor` while on 0.x, the
bump type cannot drive the changelog's "Breaking changes" section. Instead:

> A changeset whose summary begins with `**Breaking:**` is rendered under
> `### Breaking changes`, regardless of its bump type.

This marker is explicit, readable in the raw changeset file, and survives the
eventual 1.0.0 transition unchanged.

## 6. Architecture

### 6.1 `.changeset/config.json`

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

Load-bearing values:

- `privatePackages.version: true` — without it, nothing is versioned at all, since
  every workspace is private.
- `privatePackages.tag: false` — without it, Changesets mints eight
  `@invisible-string/web@0.3.0`-style tags per release.
- `changelog: false` — suppresses per-package `CHANGELOG.md`; the root changelog is
  produced by the version script instead (§6.2).
- `fixed` negations — see finding 3.

### 6.2 `scripts/release-version.ts`

Invoked as the action's `version:` command. Lands in `scripts/`, which the root
`typecheck` already covers via `tsc -p scripts`.

1. Read and parse every `.changeset/*.md` (excluding `config.json` and `README.md`)
   **before** they are consumed: frontmatter gives the bump type and the named
   packages; the body gives the summary.
2. If there are none, exit 0 having changed nothing.
3. Run `changeset version`, which bumps the eight manifests and deletes the
   changeset files.
4. Read the resulting version from `packages/shared/package.json`.
5. Insert one section into the root `CHANGELOG.md`, **immediately above the first
   existing `## ` heading** — i.e. after the file's preamble, not at byte zero.

   `CHANGELOG.md` therefore has exactly one structural rule, which both this script
   and §6.3 depend on: **the preamble may use `# ` and prose, but the first `## `
   in the file is always the newest release.**

Section format:

```md
## v0.3.0 — 2026-08-08

### Breaking changes
- **control-plane** — eve session API v2; every agent must be republished to migrate.

### Features
- **web** — Replace the markdown renderer with Streamdown.

### Fixes & maintenance
- **worker** — Normalize `WORKER_ID` to lowercase at config parse.
```

Rules:
- Section is chosen by the `**Breaking:**` marker first (§5.3), then by bump type:
  `minor` → Features, `patch` → Fixes & maintenance, `major` → Breaking changes.
- The bold scope is derived from the changeset's package list, with the
  `@invisible-string/` prefix stripped. Multiple packages join with `, `.
- Empty sections are omitted.
- The `**Breaking:**` marker itself is stripped from the rendered line.

### 6.3 `scripts/release-tag.ts`

Runs after the Changesets action, on `main` pushes only.

1. Read the version from `packages/shared/package.json`.
2. If `v$VERSION` already exists as a tag → write `released=false` to
   `$GITHUB_OUTPUT` and exit 0.
3. Otherwise: create and push the annotated tag `v$VERSION`; extract the release
   body as the span from the **first** `## ` heading to the next `## ` heading (or
   EOF) — see the structural rule in §6.2 step 5; then
   `gh release create v$VERSION --title v$VERSION --notes-file …`.
4. Write `released=true` and `version=v$VERSION` to `$GITHUB_OUTPUT`.

**The tag-existence check is the whole control flow.** It requires no knowledge of
whether changesets are pending, and it is idempotent:

| Situation | `packages/shared` version | `v$V` tagged? | Result |
|---|---|---|---|
| PR with changesets merges | old (`0.2.0`) | yes | no-op; action opens/updates Version PR |
| Version PR merges | new (`0.3.0`) | no | **tag + release + images** |
| Ordinary commit, nothing pending | current | yes | no-op |
| Re-run of a completed release | current | yes | no-op |

### 6.4 `release.yml`

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]

permissions:
  contents: write        # was: read — needed to push tags and create releases
  pull-requests: write   # needed for the Version Packages PR
  packages: write        # unchanged — GHCR

concurrency: release-${{ github.ref }}
```

**Job `version`** — runs only for `push` to `refs/heads/main`.

- `actions/checkout@v4` with `fetch-depth: 0` (tag existence check needs full tags).
- `jdx/mise-action@v2` with no `with:` block, exactly as every other job in this
  repo — the pinned toolchain comes from `mise.toml`.
- `bun install --frozen-lockfile`.
- `changesets/action@v1` with **only** `version: bun run release:version`. No
  `publish:` input — nothing is published, so the action's sole job is to
  create/update the **"Version Packages"** PR. No `NPM_TOKEN`, no `.npmrc`.
- `bun run release:tag`, exporting `released` and `version`. No further `if:` guard
  is needed — the whole job is already `main`-only.
- Job outputs: `released`, `version`.

**Repository prerequisite.** `changesets/action` opens a pull request with the
default `GITHUB_TOKEN`, which requires **Settings → Actions → General → "Allow
GitHub Actions to create and approve pull requests"** to be enabled. Without it the
action fails at PR-creation time with a permissions error that does not name the
setting. This must be confirmed before the first release.

**Job `images`** — the existing three-way matrix, unchanged in substance.

- `needs: [version]`
- `if: always() && (needs.version.outputs.released == 'true' || startsWith(github.ref, 'refs/tags/v'))`
  — `always()` is required so the tag-push path still runs when `version` is skipped.
- Image tags become `${{ needs.version.outputs.version || github.ref_name }}` plus
  `${{ github.sha }}`. **`github.ref_name` alone is now wrong**: on the release
  path the ref is `main`, which would publish `…-web:main`.

Because the tag and the image build happen inside one workflow run, GitHub's
`GITHUB_TOKEN` recursion guard — which prevents a token-pushed tag from triggering
another workflow — never comes into play. **No PAT or GitHub App token is needed.**

### 6.5 Root `package.json` scripts

```json
"changeset": "changeset",
"release:version": "bun run scripts/release-version.ts",
"release:tag": "bun run scripts/release-tag.ts"
```

## 7. Authoring changesets

Authored by hand (or by an agent) as part of the change itself — the same commit,
the same way `AGENTS.md` already requires docs to move with code. There is no CI
gate.

A changeset is a file in `.changeset/` with any name:

```md
---
"@invisible-string/web": minor
---

Replace the markdown renderer with Streamdown.
```

Name only the workspaces genuinely touched — `fixed` guarantees they all land on
the same number regardless, so the package list exists purely to give the
changelog its scope label. Agents should write the file directly rather than
running the interactive `bun changeset`, which would otherwise prompt through all
ten workspaces.

## 8. Documentation and guard changes

Per `AGENTS.md` ("any change that alters workflows MUST update every affected
document in the same commit"):

- **`AGENTS.md`** — new "Releases" section covering: every behavior-affecting PR
  adds a changeset; the 0.x bump table (§5.2); the `**Breaking:**` marker (§5.3);
  and the sharp edge that **naming `@invisible-string/e2e` or
  `@invisible-string/integration-tests` in a changeset crashes `changeset version`**
  (finding 3). Add `.changeset/` to the living-documents table as the owner of
  release notes.
- **`docs/DEPLOY.md` §10** — the upgrade path becomes "merge the Version Packages
  PR; the release workflow tags, releases, and builds images." The manual
  `git tag v*` push is documented as the fallback. The `IMAGE_TAG` description
  (line ~71) stays accurate — image tags are still `vX.Y.Z`.
- **`README.md`** — a line on how releases are cut, if it describes CI at all.

**Guard test — `tests/integration/changesets-config.test.ts`**, ungated (no DB, no
docker, no network) so the default `bun test` lane catches drift, in the style of
`toolchain-pins.test.ts`:

1. Every workspace under `apps/*` and `packages/*` has a `version`, and all eight
   are equal.
2. `tests/integration` and `e2e` have **no** `version` — the exclusion mechanism.
3. The `fixed` globs resolve to exactly the eight versioned packages (evaluate the
   patterns against the real workspace list; do not hard-code names twice).
4. `privatePackages` is `{ version: true, tag: false }` and `changelog` is `false`.
5. The root `@changesets/cli` dependency is an exact version (no `^` or `~`).

## 9. Residuals

- **`bun.lock` workspace versions go stale after a release** (finding 5). Harmless
  today because `--frozen-lockfile` does not compare them, warm or cold. If Bun
  tightens that check, image builds break and the Version PR will need a refreshed
  lockfile committed into it.
- **A release is not gated on CI green.** The `version` job runs on push to `main`
  independent of the `ci` workflow. Accepted: the code being released already
  passed CI in its own PR, and the Version PR (which only touches manifests and
  `CHANGELOG.md`) passes CI before merge. Gating would require a `workflow_run`
  trigger and materially more complexity.
- **Changelog entries carry no PR links or author attribution.**
  `@changesets/changelog-github` provides these but writes per-package files, which
  §5 rejects. Adding link enrichment to `release-version.ts` later is
  straightforward — it needs a GitHub API lookup per changeset commit.
- **`bun changeset` (interactive) prompts through all ten workspaces**, including
  the two that must never be selected. Mitigated by documentation, not code.

## 10. Backfill

The root `CHANGELOG.md` is seeded with reconstructed sections for the existing
tags, derived from the conventional-commit log between them. These entries are
**historical reconstruction, not authored release notes** — the file states this
once at the top.

Reconstruction rules: group by commit type (`feat!` → Breaking changes, `feat` →
Features, `fix`/`ci`/`chore`/`refactor` → Fixes & maintenance), use the conventional
scope as the bold label, drop pure `docs:` commits that shipped no behavior, and
date each section from the tag's commit date.

| Tag | Date | Shape |
|---|---|---|
| `v0.1.3` | 2026-07-07 | Initial release. ~70 commits spanning phases 0–4. Summarize by subsystem (spine, worker pool, triggers, copilot, prod compose, Garage) rather than enumerating commits. |
| `v0.1.4` | 2026-07-07 | 2 commits — migrator self-heals missing databases; inlined prod compose config. |
| `v0.1.5` | 2026-07-08 | 2 commits — first-run onboarding and invites; standalone external-data compose. |
| `v0.1.6` | 2026-07-09 | 10 commits — marketing/docs site, design-tokens extraction, Slack manifest, Namespace runners. |
| `v0.1.7` | 2026-07-09 | 6 commits — Cloudflare Workers site deploy, docs-sentinel, Bun idle-timeout fix. |
| `v0.1.8` | 2026-07-09 | 1 commit — `WORKER_ID` lowercase normalization. |
| `v0.2.0` | 2026-07-21 | 1 commit — agents-first re-architecture (breaking). |

The four commits in `v0.2.0..HEAD` are **not** backfilled. They become real
changesets committed as part of this work, so the first Changesets-driven release
covers them:

| Commit | Package(s) | Bump | Note |
|---|---|---|---|
| `7c37aec` eve 0.19.0 → 0.31.3 | control-plane, worker, compiler, shared | `minor` | `**Breaking:**` — session API v2; republish to migrate |
| `316f2ea` Streamdown renderer | web | `minor` | |
| `8f6d550` mise toolchain pin | *(none shipped)* | `patch` | |
| `22f1ebb` prod image node alignment | *(none shipped)* | `patch` | |

For the two CI/infra commits, name the workspace whose build they affect
(`@invisible-string/control-plane`) rather than inventing a scope.

**Resulting first release: `v0.3.0`** — `minor`, per §5.2.

## 11. Acceptance

1. `bun test` passes, including the new guard test.
2. `bun run typecheck` passes (covers both release scripts via `tsc -p scripts`).
3. `bun install --frozen-lockfile` succeeds on a clean tree after a simulated
   `changeset version`.
4. Adding a changeset and pushing to a branch produces no release activity.
5. On merge to `main` with changesets pending: a "Version Packages" PR appears; no
   tag, no release, no images.
6. On merging that PR: `CHANGELOG.md` gains a `v0.3.0` section, tag `v0.3.0` is
   pushed, a GitHub Release is created with that section as its body, and all three
   GHCR images publish as `v0.3.0` and `<sha>`.
7. Re-running the release workflow on the same commit is a no-op.
8. `git tag v0.3.1 && git push --tags` still builds and publishes images.
