# Production docker-compose topology — design

**Date:** 2026-07-07
**Status:** approved
**Scope:** production deployment (single-host, Dokploy-hosted) + the MinIO → Garage object-store migration across dev, CI, and prod. Resolves the "production deploy documented-not-provisioned" residual.

## Problem

The repo has no production deployment story: `docker-compose.yml` is infra-only
(postgres, object store, dex) with hardcoded throwaway credentials and an
explicit banner forbidding production use. No Dockerfiles exist — control
plane, worker, and web all run directly on the host via Bun. AGENTS.md lists
"production deploy documented-not-provisioned" as a known residual.

Separately, MinIO's community edition has gone stale (feature-stripped OSS,
last community releases mid-2025), so the object store itself needs replacing
before it anchors a production deployment.

## Decisions (locked with the maintainer)

| Decision | Choice | Why |
|---|---|---|
| Purpose | Real single-host deploy | Will run on an actual server (Dokploy), production-grade defaults |
| Ingress/TLS | Host proxy (Dokploy's Traefik); `cloudflared` as opt-in compose profile | Hoster brings ingress; no proxy duplicated in-stack |
| Images | GHCR registry, CI-published, pinned by tag | Reproducible deploys, rollback = retag |
| Domains | One domain; nginx in the web image gateways API paths | Same-origin: no CORS, first-party cookies, deployment-agnostic web image |
| Data services | In-compose postgres + object store; documented external/managed mode via a thin override | Simple default; scale-out path documented |
| Structure | One `docker-compose.prod.yml` + thin overrides | No duplicated service definitions, no drift |
| Object store | **Garage — everywhere (dev, CI, prod)** | MinIO OSS stale; RustFS still alpha in 2026 with 13 security advisories (auth bypasses, admin takeover); Garage is production-ready for single-host, actively maintained |

Rejected alternatives: two full compose files (drift), profiles-only single
file (the common case pays a `--profile` flag), RustFS (alpha + security
record), SeaweedFS (viable but heavier than needed; Garage's `key import`
keeps the `S3_*` env contract unchanged).

## Topology

New file `docker-compose.prod.yml`. All app images pulled from GHCR pinned by
`${IMAGE_TAG}`; **no published host ports anywhere**.

| Service | Role | Notes |
|---|---|---|
| `web` | nginx: serves SPA, gateways API prefixes → `control-plane:3000` | The only service on Dokploy's external network; WS upgrade + SSE unbuffered |
| `control-plane` | Bun API :3000 | Waits on `migrate` completion + postgres/garage health |
| `migrate` | one-shot (control-plane image, migrator entrypoint) | `restart: "no"`, gates control-plane via `service_completed_successfully` |
| `worker` | Bun supervisor; boots agents under Node 24 | Mounts `/var/run/docker.sock` + agent-cache volume; waits on control-plane health |
| `postgres` | postgres:16, named volume | Prod credentials from env; init script creates `product` + `world` DBs and an app role **with CREATEDB** (world provisioner needs it) |
| `garage` | S3 API :3900, named volume | Single-node layout; healthchecked |
| `garage-init` | one-shot | Layout assign/apply, `garage key import` of the configured `S3_*` key pair, bucket create + allow — idempotent |
| `cloudflared` | `profiles: ["cloudflared"]` | Opt-in tunnel → `web:80`; inert without `--profile cloudflared` |

**Networking:** two networks. `dokploy-network` (`external: true`) attached to
`web` only — Dokploy's Traefik routes the domain to it. A private `internal`
bridge carries everything else; postgres, garage, control-plane, and worker are
unreachable from outside the stack.

**Worker transport:** worker ↔ control-plane traffic stays HTTP on the private
bridge (`http://control-plane:3000`, `http://worker:<port>`), so the compose
sets `ALLOW_INSECURE_WORKER_TRANSPORT=1` — compensated with the Phase-3
hardening that already exists: `WORKER_AUTH_MODE=worker-token`, a pinned
`WORKER_ID`, and `WORKER_ALLOWED_IDS` locked to that id. Documentation wording
changes from "never enable in production" to "never across a routable
network" (a single-host private bridge qualifies as non-routable).

**Restart policy** `unless-stopped` on long-running services (both apps
already drain gracefully on SIGTERM); one-shots use `restart: "no"`.

**Dex is excluded** — it is a dev-only IdP with static credentials.
Email/password auth works out of the box; production SSO connects a real IdP
through Better Auth SSO.

**Sandboxes:** because the worker mounts the host docker.sock, eve `docker()`
sandbox containers run as siblings of the stack on the host daemon. Sandboxes
write into their own container filesystems (spike finding: `/workspace` inside
the sandbox), so no host-path bind parity is needed beyond the agent cache.

## Images, Dockerfiles, CI

Three Dockerfiles under `infra/docker/`:

| Image | Base / stages | Notes |
|---|---|---|
| `invisible-string-control-plane` | Bun 1.3 + Node 24 + npm | Runs TS directly via Bun; Node 24 + npm required for `eve build`. `AGENT_BUILD_ROOT=/var/lib/agents`. `migrate` service reuses this image with the migrator entrypoint |
| `invisible-string-worker` | Bun 1.3 + Node 24 + docker CLI | Node 24 boots compiled agents; docker CLI serves the sandbox reaper. `ARTIFACT_CACHE_DIR=/var/lib/agents` |
| `invisible-string-web` | Bun build stage → nginx:alpine | SPA built with `VITE_API_URL=""` (same-origin); nginx serves static + proxies API prefixes. No domain baked in |

The nginx gateway owns the route split (single in-repo conf; **adding a new
top-level control-plane route prefix requires adding a line here** — recorded
in AGENTS.md):

- Proxy to `control-plane:3000`: `/api`, `/t`, `/me`, `/workspaces`,
  `/integrations`, `/mcp-registry`, `/admin`
- WebSocket upgrade on the copilot path; `proxy_buffering off` for SSE;
  `client_max_body_size 8m` (matches the control plane's transport cap)
- Everything else: SPA static with `try_files … /index.html`

**SPA change:** `apps/web/src/lib/api-client.ts` and `auth-client.ts` treat an
empty `VITE_API_URL` as same-origin (relative base). Dev default
(`http://localhost:3000` when unset) is unchanged.

**CI:** a release workflow builds all three images and pushes
`ghcr.io/heysanil/invisible-string-{control-plane,worker,web}` tagged
`:vX.Y.Z` + `:<sha>` on tag push. PR/main CI validates that the Dockerfiles
build (no push). A thin `docker-compose.prod.build.yml` override adds `build:`
contexts so the prod stack can be built and smoke-tested locally/CI without a
registry.

## Environment & secrets contract

Every secret comes from the deploy environment (Dokploy env UI). The compose
interpolates required values with `${VAR:?}` so a missing secret fails the
deploy instead of booting broken. The dev compose's hardcoded credentials never
appear.

| Operator provides | Compose derives |
|---|---|
| `APP_DOMAIN` | `BETTER_AUTH_URL` / `PUBLIC_APP_URL` = `https://$APP_DOMAIN`; HSTS on |
| `POSTGRES_PASSWORD` | `DATABASE_URL` / `WORLD_DATABASE_URL` → `postgres:5432`; init script creates DBs + CREATEDB role |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `GARAGE_RPC_SECRET` | `S3_ENDPOINT=http://garage:3900`, bucket `artifacts`; garage-init imports the key pair |
| `ENCRYPTION_MASTER_KEY`, `PLATFORM_JWT_SECRET`, `BETTER_AUTH_SECRET`, `WORKER_SHARED_SECRET` | passed through (each `openssl rand -base64 32`) |
| `OPENROUTER_API_KEY` (and/or `ANTHROPIC_API_KEY`) | model provider; copilot mounts when a key exists |
| `WORKER_ID` (one UUID) | pins worker identity; `WORKER_ALLOWED_IDS` locked to it |
| `IMAGE_TAG` | pins all three GHCR images per deploy |

Email verification stays off (no mailer — existing residual); enabling later
is an env flip once a mailer exists.

## Volumes, migrations, init

| Volume | Mount | Why |
|---|---|---|
| `postgres-data` | postgres | product + world + per-version `ws_v_*` DBs |
| `garage-data` | garage (data + metadata) | artifact tarballs + trigger payloads |
| `agent-build` | control-plane `/var/lib/agents` | build root (see parity note) |
| `agent-cache` | worker `/var/lib/agents` | extracted artifacts (LRU) |
| `npm-cache` | control-plane | warm `eve build` installs across restarts |

`agent-build` and `agent-cache` are **separate volumes mounted at the identical
path string** — compiled artifacts bake absolute paths, so `AGENT_BUILD_ROOT`
must equal `ARTIFACT_CACHE_DIR` (`/var/lib/agents`, both images' default).

Boot order: postgres healthy → `migrate` completes → control-plane starts;
garage healthy → `garage-init` completes. Worker waits on control-plane
health. New `infra/postgres-init.prod.sh` creates the prod role (CREATEDB) and
databases without dev credentials.

**External-data mode:** `docker-compose.prod.external-data.yml` disables
postgres/garage/one-shots by assigning them a never-enabled profile (compose
override files cannot remove services; the unused-profile idiom is the
standard subtraction mechanism). Operator points `DATABASE_URL` / `S3_*` at
managed services. Documented requirement: the managed Postgres role needs
`CREATEDB` (world provisioner creates per-version databases).

## MinIO → Garage (everywhere)

The store surface is narrow — Bun `S3Client` put/get/exists plus client-side
SigV4 presigned GET URLs (workers plain-`fetch` them), path-style addressing,
no multipart/listing — well within Garage's S3 API. Garage's generated-key
model is bridged with `garage key import`, so `S3_*` env semantics are
unchanged. Garage's `s3_region` must match the `S3_REGION` default
(`us-east-1`) since SigV4 embeds it.

Migrating in the same effort (not prod-only) so CI exercises the store that
production runs: dev `docker-compose.yml` (garage + garage-init replace
minio + minio-init), `.github/workflows/ci.yml`, `scripts/dev.ts`,
`e2e/{config,global-setup,global-teardown}.ts`, and the three acceptance
harnesses (`phase1`, `phase3`, `keyed`). Acceptance lanes re-prove the store
end-to-end, including presigned-GET artifact pulls. No data migration needed
(dev artifact caches are re-buildable).

## Documentation plan (same-commit discipline)

- **New `docs/DEPLOY.md`:** Dokploy walkthrough (external network, domain →
  web, env vars), external-data mode, cloudflared profile, backup guidance
  (pg_dump cron + volume snapshots), upgrade/rollback via `IMAGE_TAG`, smoke
  checklist (sign-up → build workflow → run → webhook trigger).
- **Updated:** AGENTS.md (doc table entry for DEPLOY.md, residual resolved,
  compose service names, nginx-prefix maintenance rule), README, e2e/README,
  `.env.example` (S3 section wording + transport-flag nuance), docs/PLAN.md
  environments row.

## Verification

- `docker compose config` lint for prod compose + overrides in CI.
- Prod images build on every PR; pushed only on tags.
- Full local smoke against the build override before first deploy (checklist
  in DEPLOY.md).
- Existing gated/acceptance/e2e lanes re-run green on Garage.

## Out of scope (unchanged residuals)

Multi-host worker fleet (single-writer-per-version-hash is safe here — one
worker, one host), mailer, worker mTLS/PKI, production observability stack
beyond the structured logs + `/internal/metrics` that already exist.

## Implementation addenda (2026-07-07)

- **No `garage-init` one-shot.** Garage v2.3 auto-initializes the single-node
  layout and idempotently (re)creates the access key + `artifacts` bucket from
  the `GARAGE_DEFAULT_ACCESS_KEY/SECRET_KEY/BUCKET` env on every boot —
  `garage server --single-node --default-access-key --default-bucket`. The two
  `--default-*` flags are load-bearing: without them `GARAGE_DEFAULT_*` is
  ignored and the store 403s "No such key". Verified by the gated live
  round-trip test (`tests/integration/garage-store.test.ts`). This replaces the
  spec's earlier `garage-init` + `garage key import` sketch.
- **No `infra/postgres-init.prod.sh`.** The existing `infra/postgres-init.sh`
  is credential-free and generic over `$POSTGRES_USER`; the prod compose
  mounts it unchanged.
- **External-data wart.** Compose interpolates `${POSTGRES_PASSWORD:?}` /
  `${GARAGE_RPC_SECRET:?}` even for profile-disabled services — external-data
  deploys set both to the literal `unused` (documented in DEPLOY.md).
- **External-data variant became a standalone compose file (2026-07-08).** The
  original override design (`-f base -f override` with `!reset`) demanded
  multi-file invocation that one-file hosts (Dokploy paste mode) can't express,
  plus the `unused`-placeholder wart. `docker-compose.prod.external-data.yml`
  now mirrors the base's app services minus the bundled data services;
  `scripts/check-prod-compose-drift.sh` (run by the CI `prod-compose` job)
  keeps the shared service definitions in lockstep. The `!reset` requirement
  (Compose ≥ 2.24) is gone; both files need ≥ 2.23.1 for inline `configs`.
