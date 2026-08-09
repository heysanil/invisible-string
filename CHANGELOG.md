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
- **ci** — Move workflows to Namespace runners.
- **infra** — Copy the `apps/site` manifest into image builds, which a frozen install had broken.
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
