# Site Deploy: Cloudflare Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/site` (landing + docs) deployment from GitHub Pages to a Cloudflare Workers assets-only Worker serving `https://invisiblestring.io`, with per-PR preview URLs.

**Architecture:** A new `apps/site/wrangler.jsonc` defines an assets-only Worker (no server code) with SPA fallback and a custom-domain route; `.github/workflows/site.yml` is rewritten to deploy via `cloudflare/wrangler-action` on `main` pushes and to upload preview versions (with branch aliases) on PRs. The GitHub Pages `404.html` hack is deleted.

**Tech Stack:** Cloudflare Workers static assets, wrangler 4.110.0 via `cloudflare/wrangler-action@v4`, Bun 1.3.5, GitHub Actions (`ubuntu-latest`).

**Spec:** `docs/superpowers/specs/2026-07-09-site-cloudflare-workers-deploy-design.md`

## Global Constraints

- **SINGLE COMMIT:** Tasks 1–3 stage changes only; the one and only commit happens at the end of Task 3. Committing Task 1 alone would deploy a build without `404.html` to the still-active GitHub Pages site and break SPA deep links there. The repo rule "docs update in the same commit as the behavior change" (AGENTS.md) also requires this.
- Commit messages never mention AI assistance; conventional style (`ci(site): …`).
- wrangler is pinned to `4.110.0` via the action input — it must NOT be added to any `package.json` (it would bloat `bun install --frozen-lockfile` in every prod Docker image; the root lockfile covers all workspaces).
- Worker name is exactly `invisible-string-site` everywhere (config, URL greps).
- Preview alias rules: lowercase letters/digits/dashes, must start with a letter, ≤ 41 chars (63-char DNS label minus `-invisible-string-site`).
- Do not touch `docs/superpowers/specs/2026-07-08-landing-docs-site-design.md` or `INITIAL-SPEC.md` (historical).
- `apps/site` app code (`src/**`, `vite.config.ts`) is untouched — `SITE_BASE` plumbing stays, defaulting to `/`.

---

### Task 1: Worker config + build script + site README

**Files:**
- Create: `apps/site/wrangler.jsonc`
- Modify: `apps/site/package.json` (build script, line 7)
- Modify: `apps/site/README.md` (header, commands, env table, Pages section, SPA section)

**Interfaces:**
- Produces: Worker named `invisible-string-site` with assets dir `./dist` (Task 2's workflow greps preview URLs matching `*-invisible-string-site*.workers.dev` and runs wrangler with `workingDirectory: apps/site`).

- [ ] **Step 1: Create `apps/site/wrangler.jsonc`**

```jsonc
{
  "name": "invisible-string-site",
  "compatibility_date": "2026-07-09",
  // Assets-only Worker: no `main` script — requests never invoke compute.
  "assets": {
    "directory": "./dist",
    // Unmatched paths get index.html with HTTP 200 (replaces the GitHub
    // Pages 404.html hack and its 404-status tradeoff).
    "not_found_handling": "single-page-application"
  },
  // First deploy creates the apex DNS record + cert on the Cloudflare zone.
  "routes": [{ "pattern": "invisiblestring.io", "custom_domain": true }],
  // Production is only served from the custom domain…
  "workers_dev": false,
  // …but versioned preview URLs (used by PR previews) stay enabled.
  "preview_urls": true
}
```

- [ ] **Step 2: Drop the 404.html copy from the build script**

In `apps/site/package.json` line 7, change:

```json
    "build": "tsc --noEmit && vite build && cp dist/index.html dist/404.html",
```

to:

```json
    "build": "tsc --noEmit && vite build",
```

- [ ] **Step 3: Verify the build no longer emits 404.html**

Run: `bun run --cwd apps/site build && test ! -f apps/site/dist/404.html && echo OK`
Expected: build succeeds, prints `OK`.

- [ ] **Step 4: Update `apps/site/README.md`**

Four edits (exact old text is from the current file):

**(a)** Header paragraph — replace lines 3–7:

```markdown
Standalone static site: the public landing page (`/`) and an E1-styled docs
shell (`/docs/*`), built with Vite + React + TanStack Router and deployed to
**GitHub Pages**. It shares nothing at runtime with `apps/web` — no server, no
auth, no compose service — only the E1 design tokens (`packages/design-tokens`)
are shared, on purpose (AGENTS.md rule 5).
```

with:

```markdown
Standalone static site: the public landing page (`/`) and an E1-styled docs
shell (`/docs/*`), built with Vite + React + TanStack Router and deployed to
**Cloudflare Workers** (an assets-only Worker — static hosting, no compute) at
<https://invisiblestring.io>. It shares nothing at runtime with `apps/web` — no
server, no auth, no compose service — only the E1 design tokens
(`packages/design-tokens`) are shared, on purpose (AGENTS.md rule 5).
```

**(b)** Commands block — replace the build line:

```markdown
bun run --cwd apps/site build      # tsc --noEmit && vite build && cp dist/index.html dist/404.html
```

with:

```markdown
bun run --cwd apps/site build      # tsc --noEmit && vite build
```

**(c)** Replace the whole "Build-time environment" section body (the intro
sentence, table, and the `configure-pages` note that follows it):

```markdown
These are set by CI (`.github/workflows/site.yml`) and never belong in a local
`.env` — see the note in the root `.env.example`.

| Variable | Set by | Purpose |
|---|---|---|
| `SITE_BASE` | `actions/configure-pages` (`base_path`) | Vite `base` + router `basepath`, normalized to `/` (root) or `/<repo>/` (project pages). Defaults to `/` for local dev. |
| `VITE_SITE_URL` | `actions/configure-pages` (`base_url`) | Canonical/OG/Twitter URL substituted into `index.html`. Defaults to `http://localhost:5173` locally so the substitution never breaks a local build. |
| `VITE_APP_URL` | unset by default | If set, the nav renders an "Open the app" CTA linking at it (e.g. the production SPA origin). Leave unset to hide the CTA. |

`configure-pages`'s outputs flip automatically once a custom domain is added
in Settings → Pages — no workflow edit needed either way.
```

with:

```markdown
These are set by CI (`.github/workflows/site.yml`) and never belong in a local
`.env` — see the note in the root `.env.example`.

| Variable | Set by | Purpose |
|---|---|---|
| `SITE_BASE` | nobody (local-only) | Vite `base` + router `basepath`. Defaults to `/`; CI never sets it — the deployed site always serves at the domain root. |
| `VITE_SITE_URL` | `site.yml`, fixed to `https://invisiblestring.io` | Canonical/OG/Twitter URL substituted into `index.html`. Defaults to `http://localhost:5173` locally so the substitution never breaks a local build. |
| `VITE_APP_URL` | unset by default | If set, the nav renders an "Open the app" CTA linking at it (e.g. the production SPA origin). Leave unset to hide the CTA. |
```

**(d)** Replace the "GitHub Pages setup (one-time)" and "SPA-fallback / 404
tradeoff" sections (both, contiguous) with:

```markdown
## Cloudflare Workers deploy

The site deploys as an **assets-only Worker** (`wrangler.jsonc` — name
`invisible-string-site`, assets from `dist/`, no server code) with a
custom-domain route for `invisiblestring.io`. CI (`site.yml`) does it all:

- **Push to `main`** touching `apps/site/**`, `packages/design-tokens/**`, or
  the workflow → build + `wrangler deploy` (production).
- **Pull request** touching the same paths → build + `wrangler versions
  upload --preview-alias <branch>` → the per-commit and per-branch preview
  URLs (`<alias>-invisible-string-site.<subdomain>.workers.dev`) are posted
  as a PR comment. Fork PRs skip this (no secrets).

wrangler itself is deliberately **not** a workspace dependency — the root
lockfile covers all workspaces, so it would inflate every prod Docker image's
`bun install --frozen-lockfile`. CI pins it via `cloudflare/wrangler-action`.

### One-time setup

1. Create a Cloudflare API token from the **"Edit Cloudflare Workers"**
   template on the account that owns the `invisiblestring.io` zone.
2. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Confirm the apex of `invisiblestring.io` has no conflicting DNS record
   (custom-domain creation refuses to overwrite an existing CNAME).
4. After the first successful deploy, disable GitHub Pages in repo settings
   (Settings → Pages) — the old Pages deployment is superseded.

## SPA fallback

`not_found_handling: "single-page-application"` in `wrangler.jsonc` serves
the app shell with an HTTP **200** for any path that doesn't match a static
asset, so deep links like `/docs/concepts/pillars` work for humans *and*
status-code-checking crawlers. This replaces (and improves on) the old
GitHub Pages `404.html` copy hack, which served the shell with a 404 status.
```

- [ ] **Step 5: Stage (do NOT commit — see Global Constraints)**

Run: `git add apps/site/wrangler.jsonc apps/site/package.json apps/site/README.md && git status --short`
Expected: the three files staged, nothing committed.

---

### Task 2: Rewrite `.github/workflows/site.yml`

**Files:**
- Modify: `.github/workflows/site.yml` (full replacement)

**Interfaces:**
- Consumes: Worker `invisible-string-site` with `workingDirectory: apps/site` (Task 1's `wrangler.jsonc`).
- Produces: repo-secret contract `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (documented in Task 3, provisioned in Task 4).

- [ ] **Step 1: Replace the entire file content with:**

```yaml
name: Site

on:
  push:
    branches: [main]
    paths:
      - apps/site/**
      - packages/design-tokens/**
      - .github/workflows/site.yml
  pull_request:
    paths:
      - apps/site/**
      - packages/design-tokens/**
      - .github/workflows/site.yml
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: site-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  VITE_SITE_URL: https://invisiblestring.io

jobs:
  deploy:
    name: Build + deploy to Cloudflare Workers
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build site
        run: bun run --cwd apps/site build

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          wranglerVersion: "4.110.0"
          workingDirectory: apps/site
          command: deploy

  preview:
    name: Build + upload preview version
    # Fork PRs can't read repo secrets — skip rather than fail red.
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build site
        run: bun run --cwd apps/site build

      # Alias rules: lowercase alphanumerics/dashes, starts with a letter,
      # alias + "-invisible-string-site" must fit a 63-char DNS label → 41.
      - name: Compute preview alias
        id: alias
        env:
          BRANCH: ${{ github.head_ref }}
        run: |
          alias=$(printf '%s' "$BRANCH" \
            | tr '[:upper:]' '[:lower:]' \
            | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^[^a-z]*//' \
            | cut -c1-41 \
            | sed -e 's/-*$//')
          if [ -z "$alias" ]; then alias="pr-${{ github.event.number }}"; fi
          echo "alias=$alias" >> "$GITHUB_OUTPUT"

      - name: Upload preview version
        id: upload
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          wranglerVersion: "4.110.0"
          workingDirectory: apps/site
          command: versions upload --preview-alias ${{ steps.alias.outputs.alias }}

      - name: Comment preview URLs on the PR
        env:
          GH_TOKEN: ${{ github.token }}
          CMD_STDOUT: ${{ steps.upload.outputs.command-output }}
          CMD_STDERR: ${{ steps.upload.outputs.command-stderr }}
        run: |
          urls=$(printf '%s\n%s\n' "$CMD_STDOUT" "$CMD_STDERR" \
            | grep -Eo 'https://[a-z0-9-]+-invisible-string-site[a-z0-9.-]*\.workers\.dev' \
            | sort -u)
          if [ -z "$urls" ]; then
            echo "::warning::no preview URLs found in wrangler output"
            exit 0
          fi
          {
            echo "### Site preview"
            echo ""
            printf '%s\n' "$urls" | sed 's/^/- /'
            echo ""
            echo "_Commit ${{ github.event.pull_request.head.sha }} · alias \`${{ steps.alias.outputs.alias }}\`_"
          } > comment.md
          gh pr comment ${{ github.event.number }} --repo ${{ github.repository }} \
            --edit-last --create-if-none --body-file comment.md
```

- [ ] **Step 2: Verify the YAML parses**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/site.yml"); puts "YAML OK"'`
Expected: `YAML OK` (macOS system ruby; any YAML parser works).

- [ ] **Step 3: Verify no GitHub Pages actions remain**

Run: `grep -c 'configure-pages\|deploy-pages\|upload-pages-artifact\|SITE_BASE' .github/workflows/site.yml || echo CLEAN`
Expected: `0` then `CLEAN` (grep -c prints 0 and exits nonzero when nothing matches).

- [ ] **Step 4: Stage (do NOT commit)**

Run: `git add .github/workflows/site.yml && git status --short`

---

### Task 3: Root docs sweep + the single commit

**Files:**
- Modify: `AGENTS.md:31` (doc table row), `AGENTS.md:76` (architecture line), `AGENTS.md:96` (CI section paragraph)
- Modify: `README.md:268-269` (Deploy section), `README.md:284` (repo map), `README.md:309` (doc table row)
- Modify: `.env.example:176-180` (site vars note)

**Interfaces:**
- Consumes: workflow behavior and secret names exactly as defined in Task 2.

- [ ] **Step 1: Update `AGENTS.md`** — three edits:

**(a)** Line 31, the living-documents table row — replace:

```markdown
| `apps/site/README.md` | Marketing/docs site: commands, GitHub Pages deploy, MDX authoring, token-extension rules |
```

with:

```markdown
| `apps/site/README.md` | Marketing/docs site: commands, Cloudflare Workers deploy, MDX authoring, token-extension rules |
```

**(b)** Line 76, in the Architecture paragraph — replace:

```markdown
`apps/site`: standalone Vite + React static landing + docs SPA (MDX docs, E1 tokens via `packages/design-tokens`), deployed to GitHub Pages — no server, no compose service.
```

with:

```markdown
`apps/site`: standalone Vite + React static landing + docs SPA (MDX docs, E1 tokens via `packages/design-tokens`), deployed to Cloudflare Workers (assets-only Worker) at invisiblestring.io — no server, no compose service.
```

**(c)** Line 96, the site.yml paragraph — replace:

```markdown
`.github/workflows/site.yml` is a separate, deliberately non-Namespace workflow (`ubuntu-latest`): on push to `main` touching `apps/site/**` or `packages/design-tokens/**`, it builds the static site (`SITE_BASE`/`VITE_SITE_URL` from `actions/configure-pages`) and deploys it to GitHub Pages via `actions/deploy-pages`. A static marketing/docs build needs no Namespace cache, and this keeps public-site deploys decoupled from the platform's CI runners.
```

with:

```markdown
`.github/workflows/site.yml` is a separate, deliberately non-Namespace workflow (`ubuntu-latest`): pushes to `main` touching `apps/site/**` or `packages/design-tokens/**` build the static site (`VITE_SITE_URL=https://invisiblestring.io`) and deploy it to Cloudflare Workers (assets-only Worker `invisible-string-site`, config in `apps/site/wrangler.jsonc`, SPA fallback with real 200s) via `cloudflare/wrangler-action`; pull requests touching the same paths upload a preview version (`wrangler versions upload --preview-alias <branch>`) and comment the preview URLs on the PR (fork PRs skip — no secrets). Secrets: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. A static marketing/docs build needs no Namespace cache, and this keeps public-site deploys decoupled from the platform's CI runners.
```

- [ ] **Step 2: Update `README.md`** — three edits:

**(a)** Lines 268–269 — replace:

```markdown
The marketing/docs site (`apps/site`) deploys separately, to GitHub Pages, via
`.github/workflows/site.yml` on pushes to `main`.
```

with:

```markdown
The marketing/docs site (`apps/site`) deploys separately, to Cloudflare
Workers at [invisiblestring.io](https://invisiblestring.io), via
`.github/workflows/site.yml` — production on pushes to `main`, preview URLs
on pull requests.
```

**(b)** Line 284, repo map — replace:

```markdown
  site/            Standalone Vite + React landing + docs site (MDX docs,
                   E1 tokens), deployed to GitHub Pages — no server
```

with:

```markdown
  site/            Standalone Vite + React landing + docs site (MDX docs,
                   E1 tokens), deployed to Cloudflare Workers — no server
```

**(c)** Line 309, docs table — replace:

```markdown
| [`apps/site/README.md`](apps/site/README.md) | Marketing/docs site: commands, GitHub Pages deploy, MDX authoring |
```

with:

```markdown
| [`apps/site/README.md`](apps/site/README.md) | Marketing/docs site: commands, Cloudflare Workers deploy, MDX authoring |
```

- [ ] **Step 3: Update `.env.example`** — replace lines 176–180:

```
# ── Marketing/docs site (apps/site) ─────────────────────────────────────────
# SITE_BASE and VITE_SITE_URL are apps/site build-time variables set by
# .github/workflows/site.yml (via actions/configure-pages); VITE_APP_URL is
# optional (unset by default) and surfaces the "Open the app" nav CTA when
# provided at build time. None are ever needed in .env. See apps/site/README.md.
```

with:

```
# ── Marketing/docs site (apps/site) ─────────────────────────────────────────
# VITE_SITE_URL is an apps/site build-time variable set by
# .github/workflows/site.yml (fixed to https://invisiblestring.io). SITE_BASE
# is local-only and defaults to / — the deployed site always serves at the
# domain root. VITE_APP_URL is optional (unset by default) and surfaces the
# "Open the app" nav CTA when provided at build time. None are ever needed in
# .env. See apps/site/README.md.
```

- [ ] **Step 4: Sweep for stale references**

Run: `grep -rn -i 'github pages' README.md AGENTS.md .env.example apps/site/README.md .github/workflows/site.yml`
Expected: only `apps/site/README.md`'s one-time-setup step 4 ("disable GitHub Pages in repo settings") remains. Anything else is a missed edit — fix it.

- [ ] **Step 5: Full verification before the commit**

Run: `bun run typecheck && bun run --cwd apps/site build && bun test apps/site`
Expected: typecheck passes, build succeeds without emitting `dist/404.html`, site unit tests pass.

- [ ] **Step 6: THE single commit (everything from Tasks 1–3)**

```bash
git add apps/site/wrangler.jsonc apps/site/package.json apps/site/README.md \
  .github/workflows/site.yml AGENTS.md README.md .env.example
git commit -m "ci(site): deploy to Cloudflare Workers at invisiblestring.io

Replace the GitHub Pages deploy with an assets-only Worker: SPA fallback
now serves deep links with real 200s (404.html hack removed), pull
requests get preview URLs via versions upload, and the custom domain
binds from wrangler.jsonc. wrangler stays out of the workspace tree
(pinned in cloudflare/wrangler-action) to keep prod-image installs lean."
```

---

### Task 4: One-time provisioning + live verification (owner-gated)

**Files:** none (Cloudflare dashboard, GitHub settings, live checks)

**Interfaces:**
- Consumes: repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (names fixed by Task 2).

- [ ] **Step 1 (owner): Create the API token and add secrets**

Cloudflare dashboard → My Profile → API Tokens → Create Token → template
**"Edit Cloudflare Workers"** (account: the one owning `invisiblestring.io`).
Then: repo Settings → Secrets and variables → Actions → add
`CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (dashboard →
Workers & Pages overview, right rail).

- [ ] **Step 2 (owner): Confirm the apex DNS is unoccupied**

Cloudflare dashboard → `invisiblestring.io` zone → DNS Records: remove any
existing record on the bare apex (custom-domain creation refuses to
overwrite an existing CNAME and must own the hostname).

- [ ] **Step 3: Push `main` (or run the workflow manually)**

Run: `git push` (or trigger `Site` via `workflow_dispatch` in the Actions tab).
Expected: the `deploy` job goes green; first run creates the custom domain.

- [ ] **Step 4: Verify production**

Run:
```bash
curl -sI https://invisiblestring.io/ | head -1
curl -sI https://invisiblestring.io/docs/getting-started/overview | head -1
```
Expected: both print `HTTP/2 200` — the second one proves SPA fallback
without the old 404-status tradeoff.

- [ ] **Step 5: Verify the PR preview loop**

Open a trivial PR touching `apps/site/**` (e.g. a README whitespace tweak).
Expected: the `preview` job comments commit + branch-alias
`…-invisible-string-site.<subdomain>.workers.dev` URLs; deep links on the
preview URL also return 200. Close the PR after.

- [ ] **Step 6 (owner): Disable GitHub Pages**

Repo Settings → Pages → disable/remove the GitHub Actions source. The old
`github-pages` environment can be deleted from Settings → Environments.
