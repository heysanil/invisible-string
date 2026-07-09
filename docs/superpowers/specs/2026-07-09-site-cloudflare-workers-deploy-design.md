# Site deploy: GitHub Pages → Cloudflare Workers static assets

**Date:** 2026-07-09
**Status:** Approved
**Scope:** Deployment of `apps/site` (landing + docs) only. No app-code changes beyond the build script; no changes to `apps/web`, the platform, or its CI lanes.

## Motivation

Three drivers, confirmed with the owner:

1. **Custom domain** — the site will live at `https://invisiblestring.io` (apex). The zone already sits on Cloudflare under the owner's account, so hosting there keeps DNS, TLS, and hosting in one place.
2. **Preview deployments** — per-PR preview URLs, which GitHub Pages cannot do.
3. **Deep-link status codes** — GitHub Pages serves SPA fallbacks with an HTTP 404 status (documented tradeoff in `apps/site/README.md`). Cloudflare's SPA mode serves the shell with a 200.

## Product choice: Workers static assets, not Cloudflare Pages

Cloudflare Pages is in maintenance mode; Cloudflare's docs recommend Workers with static assets for new projects and publish an official Pages→Workers migration guide. An **assets-only Worker** (no `main` script) gives the same free static hosting and CDN as Pages on the supported product. Requests for static assets are free; with no Worker script, no compute ever runs.

Deploys run from GitHub Actions with wrangler (not Cloudflare's git-connected Workers Builds), keeping all config reviewable in-repo, consistent with this repo's docs-as-code discipline.

## Worker configuration — `apps/site/wrangler.jsonc` (new)

```jsonc
{
  "name": "invisible-string-site",
  "compatibility_date": "2026-07-09",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "routes": [{ "pattern": "invisiblestring.io", "custom_domain": true }],
  "workers_dev": false,
  "preview_urls": true
}
```

- `not_found_handling: "single-page-application"` returns `index.html` with **200** for unmatched paths — replaces the `404.html` copy hack and resolves the deep-link tradeoff.
- `custom_domain: true` makes the first `wrangler deploy` create the apex DNS record and certificate. Custom-domain creation refuses to overwrite an existing CNAME at the hostname (manual pre-check below).
- `workers_dev: false` keeps production off `*.workers.dev`; `preview_urls: true` keeps versioned preview URLs (`<prefix>-invisible-string-site.<subdomain>.workers.dev`) working.

## Build changes

- `apps/site/package.json` build script drops `cp dist/index.html dist/404.html` (GitHub Pages fallback hack, now dead).
- `SITE_BASE` plumbing in the app is untouched; CI stops setting it — the site always serves at `/` (its local default).
- `VITE_SITE_URL` is set to the fixed `https://invisiblestring.io` in the workflow (previously derived by `actions/configure-pages`). Preview builds intentionally keep the production canonical URL.
- wrangler is **not** added as a workspace dependency: the root lockfile covers all workspaces, so it would inflate `bun install --frozen-lockfile` in every prod Docker image. CI uses `cloudflare/wrangler-action` with a pinned wrangler version instead.

## CI — rewrite `.github/workflows/site.yml`

Stays a deliberately non-Namespace workflow (`ubuntu-latest`). Same path filters as today (`apps/site/**`, `packages/design-tokens/**`, the workflow file). Two jobs:

1. **Deploy** (push to `main`): checkout → Bun install → build (`VITE_SITE_URL=https://invisiblestring.io`) → `wrangler deploy` via `cloudflare/wrangler-action`.
2. **Preview** (new `pull_request` trigger, same paths): build → `wrangler versions upload --preview-alias <sanitized-branch>` → comment the per-commit preview URL and the stable branch-alias URL on the PR (`pull-requests: write`, `gh pr comment`, updated in place on subsequent pushes). Alias sanitization: lowercase, non-alphanumerics → dashes, must start with a letter, alias + worker name ≤ 63 chars.

GitHub Pages permissions (`pages: write`, `id-token: write`), the `github-pages` environment, and the `configure-pages`/`upload-pages-artifact`/`deploy-pages` steps are removed.

**Repo secrets (new):** `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare Workers" token template) and `CLOUDFLARE_ACCOUNT_ID`.

## Documentation updates (same commit as the change)

- `apps/site/README.md` — deploy section (GitHub Pages → Cloudflare Workers), build-time env table (`SITE_BASE` local-only, fixed `VITE_SITE_URL`), one-time setup steps, and the SPA-fallback/404 section rewritten as resolved.
- `AGENTS.md` — the `site.yml` paragraph in the CI section and the "deployed to GitHub Pages" line in Architecture.
- Root `README.md` — any GitHub Pages mentions for the site.
- `.env.example` — the note about site build-time vars.
- `docs/superpowers/specs/2026-07-08-landing-docs-site-design.md` is historical and stays untouched.

## Manual one-time steps (owner)

1. Create the Cloudflare API token ("Edit Cloudflare Workers" template) on the account that owns the `invisiblestring.io` zone.
2. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repo secrets.
3. Check the apex of `invisiblestring.io` has no conflicting CNAME record before the first deploy.
4. After the first successful Cloudflare deploy, disable GitHub Pages in repo settings.

## Verification

- PR touching `apps/site/**` gets a comment with working preview URLs; deep links on the preview return 200.
- After merge: `curl -I https://invisiblestring.io/` and `curl -I https://invisiblestring.io/docs/getting-started/overview` both return `200` (the latter proves SPA fallback without the 404-status tradeoff).
- Root `bun test` and the unit CI lane are unaffected (site build already runs there and keeps doing so).

## Out of scope

- Prerendering/SEO work beyond the status-code fix.
- Moving `apps/web` or any platform surface to Cloudflare.
- Docs search, analytics, or other site features.
