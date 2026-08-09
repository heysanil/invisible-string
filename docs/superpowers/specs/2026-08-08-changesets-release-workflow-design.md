# Changesets-based release workflow — design

**Date:** 2026-08-08
**Status:** Approved, ready for implementation
**Revision:** 4 — whole-branch review of the implementation. **`changesets/action@v1`
is gone**: reading its source turned up two defects, either one fatal here (new
finding 8), so §6.4's `version` job is now a shell step and §4 drops the action's
pin. Also in this revision: per-job `permissions` replacing the workflow-level
block, an explicit `cancel-in-progress: false`, and a §9 residual for the manifest
reformatting `changeset version` performs. Revision 3 was two rounds of independent
review, each re-running the empirical findings against this repo (not a replica):
round 1 corrected two findings; round 2 caught a reachable state in §6.3's
algorithm (the transition window) and an overstated coverage claim in §8's guard
test.
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

Verified against `@changesets/cli@2.31.1`. Findings 1–4 and 7 were re-run against a
clone of **this repo** with the exact §6.1 config. These are the facts the design
depends on; re-verify the corresponding finding before changing any decision.

1. **Bun is supported.** `@manypkg/get-packages` resolves this repo as
   `tool: bun` and discovers all ten workspaces. No lockfile shim is needed.
   Note that `npm install` *cannot* run in this repo at all — it rejects the
   `workspace:*` protocol with `EUNSUPPORTEDPROTOCOL` — so every release step must
   use `bun`.

2. **`fixed` accepts picomatch negation.** With
   `fixed: [["@invisible-string/*", "!@invisible-string/e2e", "!@invisible-string/integration-tests"]]`,
   a single `minor` on `@invisible-string/web` moved exactly the eight shipped
   workspaces `0.2.0` → `0.3.0`, left `tests/*` and `e2e` versionless and
   untouched, wrote no per-package or root changelog, and never modified the root
   `package.json`.

3. **A version-less workspace inside the `fixed` glob is a hard crash.** With the
   negations *removed*, `changeset version` dies with
   `TypeError: Invalid version. Must be a string. Got type "undefined"` from
   `matchFixedConstraint → getCurrentHighestVersion`. This is a property of the
   **config glob**, not of what a changeset names — see finding 7, which corrects
   an earlier misreading of this.

4. **Per-package changelogs are near-empty noise.** A single changeset produced
   eight `CHANGELOG.md` files, seven of which contained only a bare `## 0.3.0`
   heading. Confirms the single-root-changelog decision.

5. **Lockfile: no choreography needed.** *(Corrected in revision 2.)* This repo's
   `bun.lock` currently records **zero** `"version"` fields — for any workspace or
   any package. Testing the actual transition (adding `version` to the eight
   manifests where none existed): a **cold** `bun install --frozen-lockfile`
   (`node_modules` removed — the case the three Dockerfiles hit) succeeds on Bun
   1.3.14, and a subsequent plain `bun install` does not rewrite the lock.

   **Consequence:** the release needs no lockfile choreography and the Version PR
   carries no lockfile diff. **Risk:** if Bun ever tightens `--frozen-lockfile` to
   compare workspace versions, image builds break; §9 records this as a watched
   residual.

6. **The control flow keys off tag existence, by choice.** *(Corrected in revision
   2 — an earlier draft claimed `changesets/action@v1` lacks a `hasChangesets`
   output. It does not: `action.yml` at tag `v1` declares `published`,
   `publishedPackages`, `hasChangesets`, and `pullRequestNumber`. The v1 README's
   Outputs section is simply incomplete; `action.yml` is authoritative. Moot as of
   revision 4 — finding 8 removed the action — but the reasoning below is what
   still keeps §6.3 from keying off "were changesets pending".)*

   The decision stands on its merits rather than on a missing output: tag existence
   is what makes re-runs safe and makes the manual-tag fallback (§2 goal 4)
   coherent. `hasChangesets` describes only what was pending at the top of the job,
   which is not the same question.

7. **How an excluded workspace behaves in a changeset.** *(New in revision 2 —
   replaces an incorrect claim that naming one crashes `changeset version`.)*
   Changesets auto-treats a versionless workspace as an **ignored package**:

   - **Changeset naming only excluded workspaces:** exit **0**, prints "All files
     have been updated", the changeset file is **never consumed**, and nothing is
     bumped. A silent zombie that persists in `.changeset/` indefinitely.
   - **Mixed changeset (e.g. `web` + `e2e`):** clean failure —
     `Mixed changesets that contain both ignored and not ignored packages are not
     allowed`, from `assemble-release-plan`'s `getRelevantChangesets`.

   The zombie is the dangerous case: it never resolves on its own, and every
   subsequent push to `main` re-enters the version path with nothing to do. §6.2
   therefore rejects such changesets before Changesets ever sees them.

8. **`changesets/action@v1` cannot be used with `changelog: false`, and leaves
   the checkout on the version branch.** *(New in revision 4 — both read out of
   the action's source at tag `v1`; this is why §6.4 now runs a shell step.)*

   - **ENOENT crash.** `runVersion` reads
     `path.join(dir, "CHANGELOG.md")` for **every** changed package with no
     existence check and no `try` (`src/run.ts:319-334`), to build the PR body.
     With `changelog: false` those files are never written, so the read throws
     `ENOENT` and the job dies **before** the PR is ever opened. The tell that
     this is an oversight rather than a contract: the *identical* read at
     `src/run.ts:31-41` **is** guarded, with the comment "if we can't find a
     changelog, the user has probably disabled changelogs". Filed as
     changesets/action **issue #569**, closed as a duplicate, never fixed.
   - **The branch is never restored.** `Git.prepareBranch` (`src/git.ts:94-101`)
     does `git checkout changeset-release/main` + `reset --hard $GITHUB_SHA` and
     nothing switches back — `grep "checkout\|switch"` across `run.ts` returns
     nothing. Any later step in the same job therefore runs on the version
     branch. For us that is §6.3 running against the **unmerged** bump: it would
     tag that commit, `images` would build pre-bump source, and the real release
     commit would later decide `noop` — "already released" — for a release that
     never happened.

   Either defect alone is fatal here, and the second is silent. §6.4's shell
   step reproduces the action's useful behavior (create/reset the branch, run
   the version command, commit, force-push, open the PR once) in ~20 lines, and
   ends by returning the checkout to `$GITHUB_SHA` on every path.

## 4. Version pinning

| Thing | Pin | Why |
|---|---|---|
| `@changesets/cli` | **`2.31.1`** exact | Current `latest`. v3 is still `3.0.0-next.11`. Exact per the repo's "version pins are exact" rule. |
| `.changeset/config.json` `$schema` | `@changesets/config@3.1.4` | cli 2.31.1 depends on `@changesets/config@^3.1.4`; latest is 3.1.4. |

`changesets/action` is **not** a dependency of this design — see finding 8 for why
it was dropped and §6.4 for what replaced it.

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
with the `fixed` negations, is what keeps them out of versioning entirely.

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

1. Read and parse every `.changeset/*.md` (excluding `config.json` and
   `README.md`) **before** they are consumed: frontmatter gives the bump type and
   the named packages; the body gives the summary.
2. **Validate.** **Exit 1**, naming the offending file and package, if any
   changeset names either:
   - **a workspace with no `version` field** (today: `@invisible-string/e2e`,
     `@invisible-string/integration-tests`) — converting finding 7's two bad
     outcomes, the silent zombie and the mixed-changeset error, into one clear
     failure at the earliest possible point; or
   - **a package that is not a workspace at all** — a typo such as
     `@invisible-string/webb` names no versionless workspace, so it would otherwise
     pass this check and fail later inside `changeset version` with Changesets' own
     less-located error.

   Do not hard-code either set; derive both by enumerating the workspaces and
   reading which ones lack a `version`.
3. If there are no changesets at all, exit 0 having changed nothing.
4. Record the current version, then run `changeset version`, which bumps the eight
   manifests and deletes the changeset files.
5. **Guard:** if the version is unchanged afterwards, exit 0 without touching
   `CHANGELOG.md`. Belt-and-braces against any future Changesets edge that
   consumes nothing.
6. Read the resulting version from `packages/shared/package.json`.
7. Insert one section into the root `CHANGELOG.md`, **immediately above the first
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

Two values drive every decision:

- `V` — the version in `packages/shared/package.json` (the manifests' claim about
  what this commit *is*).
- `Vt` — the version recorded **at the tag's own commit**, read via
  `git show vV:packages/shared/package.json` (the tag's claim about what it
  *marked*). Defined only when tag `vV` exists **and** that commit's manifest
  actually carries a `version` key — see the pre-version-fields branch below.

The algorithm:

```
V := version in packages/shared/package.json

if tag vV does not exist:
    create annotated tag vV at HEAD; push it
    ensure_release(V); emit released=true, version=vV

else:
    Vt := version at `git show vV:packages/shared/package.json`
          (undefined if the command fails OR the JSON has no `version` key)

    if Vt is undefined:
        emit released=false                 # tag predates version fields — see below

    else if Vt != V:
        exit 1   # inconsistent: vV marks a commit that never claimed to be V
                 # (classically, a hand-pushed tag that burned the number — §9)

    else if vV points at HEAD:
        ensure_release(V); emit released=true, version=vV   # re-run of a release

    else:
        emit released=false                                 # ordinary commit
```

**The `Vt is undefined` branch is mandatory, not defensive.** All seven existing
tags predate this design, so none of their commits carries a `version` field.
Verified: `git show v0.2.0:packages/shared/package.json` exits **0** — the path
exists — but the JSON has no `version` key, at every tag from `v0.1.3` to `v0.2.0`.
Without this branch, the **transition window** breaks: §5.1 seeds the manifests at
`0.2.0`, the tag `v0.2.0` already exists, so `V = 0.2.0` with `Vt` undefined would
take the `Vt != V` path and **exit 1 on every push to `main`** between the
implementation PR merging and the first Version PR merging. Long-term the branch is
reachable only by reverting a Version PR, where a quiet no-op is also correct.

Tag object type does not matter: `v0.1.3`–`v0.1.6` are lightweight and `v0.1.7`+
are annotated, and `git show <tag>:<path>` resolves both identically (verified).

`ensure_release(V)`: if `gh release view vV` fails, extract the release body — the
span from the **first** `## ` heading to the next `## ` heading or EOF, per §6.2
step 7 — and run `gh release create vV --title vV --notes-file …`. **Assert the
extracted heading is `vV` before creating the release**, so a hand-edited or
malformed `CHANGELOG.md` cannot attach the wrong notes. If the release already
exists, leave it alone.

Which yields:

| Situation | `V` | Tag `vV` | `Vt` | Result |
|---|---|---|---|---|
| **Transition window** — any push to `main` after this ships, before the first Version PR merges | `0.2.0` (seeded) | exists, at `7967ce2` | **undefined** | `released=false`, clean exit; the version step still opens/updates the version PR |
| Version PR merges | `0.3.0` (new) | absent | — | **tag + release + images** |
| Re-run after a mid-release failure | `0.3.0` | at `HEAD` | `0.3.0` | release and/or images completed; no duplicate tag |
| Ordinary commit, or a changeset-bearing PR merging | `0.3.0` (unchanged) | at an older commit | `0.3.0` | `released=false`, clean exit |
| Hand-pushed tag burned the number | `0.3.1` | at an unrelated commit | `0.3.0` | **exit 1**, naming the version the tag actually marks |

The `Vt` comparison is what separates "this release is already done" (benign, the
common case on every ordinary push to `main`) from "this tag marks something else
entirely" (a genuine inconsistency). Without it, a single tag-points-elsewhere rule
would hard-fail on every ordinary commit.

**Why per-step idempotence rather than "tag exists → stop".** Making the tag both
the first side effect *and* the no-op key would make any failure *after* tagging
unrecoverable: a re-run would see the tag, skip everything, and never create the
release or the images — while the manual fallback could not fire either, because
pushing an existing tag is a no-op. Re-pushing identical image tags is safe, so
`released=true` on the tag-already-at-`HEAD` path costs nothing and restores
recoverability. The tag-points-elsewhere hard-fail is what keeps this from
silently papering over a genuinely inconsistent repo — see §9's manual-tag hazard.


### 6.4 `release.yml`

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]

# Least privilege at the workflow level; each job widens only what it needs, so
# neither job can do the other's damage.
permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false   # spelled out: a later edit flipping this on would
                              # silently preempt a release mid-tag
```

| Job | `permissions` | Why |
|---|---|---|
| `version` | `contents: write`, `pull-requests: write` | push the version branch and the release tag, cut the GitHub Release, open the version PR |
| `images` | `contents: read`, `packages: write` | GHCR push only |

**Job `version`** — runs only for `push` to `refs/heads/main`. `runs-on` a Namespace
label per repo convention (`nscloud-ubuntu-24.04-amd64-4x8` matches the `unit`
lane's weight; this job does an install and two short scripts).

- `actions/checkout@v4` with `fetch-depth: 0` — `checkout@v4` at depth 0 does fetch
  tags, which §6.3 needs.
- `jdx/mise-action@v2` with no `with:` block, exactly as every other job in this
  repo — the pinned toolchain comes from `mise.toml`.
- `bun install --frozen-lockfile`.
- **A shell step that maintains the version PR** — *not* `changesets/action@v1`,
  which finding 8 rules out on two counts. `env: BRANCH: changeset-release/main`,
  `GH_TOKEN: ${{ github.token }}`, `set -euo pipefail`, and in order:

  1. `git config user.name/email` to `github-actions[bot]`. Set **here**, not in
     the tag step: the same repo-local config serves both the version commit and
     §6.3's annotated tag.
  2. `git switch -C "$BRANCH"` — the action's `checkout` + `reset --hard
     $GITHUB_SHA` in one command, since `actions/checkout` already left HEAD
     detached at `$GITHUB_SHA`. Resetting every run is deliberate: the branch is
     a derived artifact, always recomputed from the current `main`.
  3. `bun run release:version`. With nothing pending it exits **0** having
     changed nothing (§6.2), which is why no `hasChangesets`-style precheck is
     needed.
  4. Change detection is `[ -z "$(git status --porcelain)" ]`, **not**
     `git diff --quiet`: `release:version` **deletes** the consumed
     `.changeset/*.md` and may **create** `CHANGELOG.md`, and the commit is
     `git add -A`.
  5. With changes: `git add -A`, commit `chore(release): version packages`,
     `git push -f origin "$BRANCH"`, then open the PR **only if one is not
     already open**. The open-check is
     `gh pr list --head "$BRANCH" --state open --json number --jq '.[].number'`,
     deliberately not `gh pr view "$BRANCH"`: `pr view` also matches **merged**
     PRs, and one stale match would mean no version PR is ever opened again.
     (`--jq '.[].number'` rather than `.[0].number` — the latter prints the
     string `null` for an empty array and would read as "already open".)
  6. The PR body comes from `scripts/release-pr-body.ts`, a thin entrypoint over
     §6.3's `extractLatestSection`: one framing line ("Merging this PR releases
     vX.Y.Z.") plus the newest `CHANGELOG.md` section — byte-for-byte the notes
     the GitHub Release will carry, so the PR previews exactly what it publishes.
     Written to `$RUNNER_TEMP`, never the repo (an untracked, un-ignored file in
     the tree would land in the next `git add -A`).
  7. **`git checkout --force "$GITHUB_SHA"`, on every path** — including the
     nothing-to-version one. This is the finding-8 branch-state fix and the whole
     reason the step is ordered this way: §6.3 must observe `main`'s state, never
     the version branch's.
- `bun run release:tag`. No further `if:` guard is needed — the whole job is
  already `main`-only. This step **requires**:
  - `env: GH_TOKEN: ${{ github.token }}` — `gh` will not authenticate otherwise.
  - The git identity from the step above (for the annotated tag).
  - `gh` present on the runner — confirm on the Namespace image; if absent, use
    `actions/github-script` or the REST API instead.
- Job outputs: `released`, `version`.

**Job `images`** — the existing three-way matrix, unchanged in substance.

- `needs: [version]`
- ```yaml
  if: ${{ !cancelled() && (needs.version.outputs.released == 'true' || startsWith(github.ref, 'refs/tags/v')) }}
  ```
  Some guard is required so the tag-push path still runs when `version` is
  **skipped** — a plain `needs:` would otherwise skip `images` too — but
  `!cancelled()` rather than `always()`, so that manually cancelling a release run
  does not still publish images.

  **The `${{ }}` wrapper is mandatory here.** A bare `if: !cancelled() && …` is not
  valid YAML — a leading `!` is a tag indicator, and the file fails to parse with a
  scanner error before Actions ever evaluates it (verified). This does not apply to
  the other `if:` expressions in the workflow, which start with an identifier.
- Image tags become `${{ needs.version.outputs.version || github.ref_name }}` plus
  `${{ github.sha }}`. **`github.ref_name` alone is now wrong**: on the release
  path the ref is `main`, which would publish `…-web:main`. A skipped job's outputs
  are empty strings and `''` is falsy in GitHub expressions, so the `||` fallback
  resolves correctly on the tag path.

Because the tag and the image build happen inside one workflow run, GitHub's
`GITHUB_TOKEN` recursion guard — which prevents a token-pushed tag from triggering
another workflow — never comes into play. **No PAT or GitHub App token is needed
for the tag → images path.** (It *is* the reason the Version PR gets no CI; see
§9.)

**Repository prerequisite.** The step opens the pull request with the default
`GITHUB_TOKEN`, which requires **Settings → Actions → General → "Allow GitHub
Actions to create and approve pull requests"** to be enabled. Without it
`gh pr create` fails with a permissions error that does not name the setting.
Confirm before the first release.

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
ten workspaces — including the two that must never be selected.

**Never name `@invisible-string/e2e` or `@invisible-string/integration-tests`.**
See finding 7 for what actually happens; §6.2 step 2 turns it into a clear error.

## 8. Documentation and guard changes

Per `AGENTS.md` ("any change that alters workflows MUST update every affected
document in the same commit"):

- **`AGENTS.md`** —
  - New "Releases" section: every behavior-affecting PR adds a changeset; the 0.x
    bump table (§5.2); the `**Breaking:**` marker (§5.3); and the excluded-workspace
    rule with its **real** failure modes (silent zombie / mixed-changeset error —
    finding 7), not the "crash" an earlier draft claimed.
  - Add `.changeset/` to the living-documents table as the owner of release notes,
    and a row for this spec.
  - **Fix the now-false CI sentence.** The CI section currently reads
    "`release.yml` and `docs-sentinel.yml` need no mise step: neither runs a host
    toolchain binary." The new `version` job runs `bun`, so `release.yml` does need
    one. Note that `tests/integration/toolchain-pins.test.ts` *requires*
    mise-action in any job whose `run:` steps invoke bun — the §6.4 yaml includes
    it, so that test passes; only the prose goes stale.
- **`docs/DEPLOY.md` §10** — the upgrade path becomes "merge the
  `chore(release): version packages` PR; the release workflow tags, releases, and
  builds images." Document the manual
  `git tag v*` push as the fallback **and its obligation**: the manifests must
  already claim that version **in the commit being tagged**, or the number is
  burned (§9) — §6.3 reads `Vt` from the tag's own commit, so aligning
  afterwards cannot repair it. The `IMAGE_TAG` description (line ~71) stays
  accurate — image tags are still `vX.Y.Z`.
- **`README.md`** — a line on how releases are cut, if it describes CI at all.
- **No docs-sentinel interaction.** Its denylist already excludes
  `(^|/)CHANGELOG\.md$`, so the new root changelog will not trip the audit. Worth
  one reassuring line so a future reader does not re-derive it.

**Guard test — `tests/integration/changesets-config.test.ts`**, ungated (no DB, no
docker, no network) so the default `bun test` lane catches drift, in the style of
`toolchain-pins.test.ts`:

1. Every workspace under `apps/*` and `packages/*` has a `version`, and all eight
   are equal.
2. **Enumerate every workspace** from the root `package.json` `workspaces` globs,
   and assert that the set of workspaces **lacking** a `version` equals **exactly**
   the set named in the `fixed` negations — comparing each versionless package name
   against the literal `"!" + name`. Plain string set comparison; no glob matching.

   This is the check that matters, and a narrower "`tests/integration` and `e2e`
   have no version" would not do the job. A future versionless workspace whose name
   still matches the positive glob — say `tests/load` → `@invisible-string/load-tests`
   — falls **inside** `@invisible-string/*` with no negation covering it. That is
   finding 3's config-level `TypeError`, and it would detonate at the next release
   attempt, on `main`, in the `version` job, long after the offending workspace
   merged. Checks 1 and 3 both pass in that scenario; only this one catches it.
3. The `fixed` array **deep-equals** the expected literal from §6.1. Assert the
   literal rather than evaluating the globs: correct evaluation needs micromatch
   semantics (`Bun.Glob` does not do `!`-negation across a pattern list), and
   hand-rolling that is exactly the kind of subtle error a guard test should not
   contain. Check 2 supplies the coverage that glob evaluation would have given;
   this check makes any edit to the globs a deliberate, visible act.
4. `privatePackages` is `{ version: true, tag: false }` and `changelog` is `false`.
5. The root `@changesets/cli` dependency is an exact version (no `^` or `~`).

## 9. Residuals

- **The version PR receives no CI runs.** The version step opens it with the
  default `GITHUB_TOKEN`, and events caused by that token do not trigger
  `pull_request` workflows. **Currently benign**: `main` has no branch protection
  and no rulesets (verified), the PR is mergeable, and its diff is only manifests
  plus `CHANGELOG.md` — code being released already passed CI in its own PR.
  **Trigger condition:** the moment required status checks are added to `main`, the
  version PR becomes permanently unmergeable, because its checks never report. The
  fix at that point is a PAT or GitHub App token on the `gh` calls — not a
  redesign. Closing and reopening the PR by hand also forces a CI run.
- **A manual tag burns the version number.** Pushing `v0.3.1` by hand leaves the
  manifests at `0.3.0`, so the next Version PR computes `0.3.1` — whose tag already
  exists, pointing at an unrelated commit. §6.3's tag-points-elsewhere hard-fail
  makes this loud instead of silent, and it is **not** repairable after the fact:
  `Vt` comes from the tag's own commit, so a later alignment commit moves `V`
  and leaves `Vt` untouched — both branches still land on the same exit 1. The
  recoveries are to move the tag onto a commit whose manifests claim the version
  (`git tag -f` + force-push) or to skip the number outright. Documented in
  `docs/DEPLOY.md` §10.
- **Concurrency pending-cancellation race.** `concurrency: release-${{ github.ref }}`
  keeps only the newest *pending* run. Sequence: the Version PR merge (commit A)
  queues behind an in-progress run; ordinary commit B lands; A's run is cancelled;
  B's run checks out B — which already contains A's bumped manifests — finds no
  tag, and tags **B** as `v0.3.0`. The changelog then describes A while the tag and
  images contain B. Narrow, and it requires a push to `main` during a release.
  Mitigation if it ever bites: tag the commit that last modified
  `packages/shared/package.json` rather than `HEAD`, and check the `images` job out
  at that tag. Not built now — it complicates both jobs for a rare race.
- **`bun.lock` workspace versions go stale after a release** (finding 5). Harmless
  today because `--frozen-lockfile` does not compare them, warm or cold. Note the
  lock currently records no versions at all, so this is an *absent* string rather
  than a wrong one.
- **Every release invalidates the Dockerfiles' `bun install` layer.** All eight
  manifests change, so the `COPY` + `bun install --frozen-lockfile` layer (e.g.
  `infra/docker/control-plane.Dockerfile:17-28`) rebuilds on every release image
  build. Cost only, no correctness issue; Namespace's builder-side cache simply
  stops helping that one layer per release.
- **`changeset version` reformats the manifests it touches.** It rewrites each
  `package.json` through its own JSON writer rather than patching the version
  string in place, so compact one-line blocks get expanded onto several lines —
  already visible in `packages/design-tokens/package.json`, whose `exports` and
  `scripts` came back multi-line. Purely cosmetic, it recurs on **every** release,
  and it only ever touches the eight shipped manifests. Recorded here so a
  reviewer of a future version PR reads the extra hunks as expected noise rather
  than an unexplained diff.
- **Changelog entries carry no PR links or author attribution.**
  `@changesets/changelog-github` provides these but writes per-package files, which
  §5 rejects. Adding link enrichment to `release-version.ts` later is
  straightforward — it needs a GitHub API lookup per changeset commit.

## 10. Backfill

The root `CHANGELOG.md` is seeded with reconstructed sections for the existing
tags, derived from the conventional-commit log between them. These entries are
**historical reconstruction, not authored release notes** — the file states this
once at the top, above the first `## ` heading (§6.2 step 7).

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

The unreleased commits in `v0.2.0..HEAD` are **not** backfilled. The four
behavior-bearing ones become real changesets committed as part of this work, so the
first Changesets-driven release covers them. (`v0.2.0..HEAD` also contains this
spec's own `docs:` commits, which the drop-pure-docs rule excludes.)

| Commit | Package(s) | Bump | Note |
|---|---|---|---|
| `7c37aec` eve 0.19.0 → 0.31.3 | control-plane, worker, compiler, shared | `minor` | `**Breaking:**` — session API v2; republish to migrate |
| `316f2ea` Streamdown renderer | web | `minor` | |
| `8f6d550` mise toolchain pin | control-plane | `patch` | |
| `22f1ebb` prod image node alignment | control-plane | `patch` | |

For the two CI/infra commits, name the workspace whose build they affect rather
than inventing a scope.

**Resulting first release: `v0.3.0`** — `minor`, per §5.2.

## 11. Acceptance

1. `bun test` passes, including the new guard test.
2. `bun run typecheck` passes (covers both release scripts via `tsc -p scripts`).
3. `bun install --frozen-lockfile` succeeds on a clean tree after a simulated
   `changeset version`.
4. A changeset naming `@invisible-string/e2e` fails `bun run release:version` with
   exit 1 and a message naming the file — it does not silently persist. A changeset
   naming a non-existent package (`@invisible-string/webb`) fails the same way.
5. **Transition window:** with the manifests seeded at `0.2.0` and tag `v0.2.0`
   already present, `bun run release:tag` exits 0 with `released=false` — it does
   **not** error on the missing `version` key at that tag's commit. Verify before
   merging the implementation PR, since every push to `main` hits this state until
   the first Version PR lands.
6. Adding a changeset and pushing to a branch produces no release activity.
7. On merge to `main` with changesets pending: a `chore(release): version packages`
   PR appears on branch `changeset-release/main`, its body is the new
   `CHANGELOG.md` section; no tag, no release, no images. A second push while it
   is open force-updates the branch and opens **no** duplicate PR.
8. On merging that PR: `CHANGELOG.md` gains a `v0.3.0` section, tag `v0.3.0` is
   pushed, a GitHub Release is created with that section as its body, and all three
   GHCR images publish as `v0.3.0` and `<sha>`.
9. Re-running the release workflow on the release commit re-checks the release and
   images without creating a duplicate tag, and does **not** short-circuit to a
   no-op if the release or images were missing.
10. An ordinary commit to `main` with nothing pending is a clean no-op —
    `released=false`, no error.
11. `git tag v0.3.1 && git push --tags` still builds and publishes images.
