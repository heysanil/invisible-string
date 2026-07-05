# Dev-experience orchestrator — design

**Date:** 2026-07-05
**Status:** approved
**Scope:** local development ergonomics only — no production or CI behavior changes.

## Problem

The documented dev loop (README quickstart) takes five manual steps across four
terminals: `docker compose up`, a hand-typed migrate command, `cp .env.example
.env` plus hand-generating four `openssl rand` secrets, then three separate dev
servers. The pains ranked by the maintainer: too many startup steps, tedious
env/secret bootstrap, and log juggling across processes.

Watch mode already exists everywhere (`bun run --watch` in control-plane and
worker, Vite HMR in web) — the gap is orchestration around the edges, not file
watching.

## Decision

**Native orchestrator script now; optional compose-watch lane later.**

Containerizing the apps (`docker compose watch`) was considered and deferred:
the worker needs a mounted docker.sock, Node 24 via mise inside the image, and
it spawns agent child processes on a dynamic port range that the control plane
proxies to — painful under Docker Desktop port publishing on macOS. Native Bun
watch is also strictly faster than container file-sync. A Procfile + process
manager (overmind/mprocs) was rejected because it solves only log unification
and still needs a wrapper script for env bootstrap and sequencing.

## UX

Root `package.json` `dev` script repoints from the bare
`bun run --filter='./apps/*' dev` fan-out to `scripts/dev.ts`:

```
$ bun run dev
◇ .env not found — created with generated secrets (4 keys)
◇ infra healthy (postgres, minio, dex) · bucket ok        3.1s
◇ migrations current
api    │ control-plane listening on :3000
worker │ registered worker 4f2c… (Node 24 via mise)
web    │ VITE ready on :5173
```

- **Ctrl-C** SIGTERMs the three app children, waits up to 5 s, SIGKILLs
  stragglers. Infra containers are left running so the next boot is instant.
- **`bun run dev:down`** stops infra (`docker compose down`; volumes kept).
- Per-app `bun run --cwd apps/<x> dev` continues to work unchanged.
- No CLI flags in v1. `VITE_FIXTURE_MODE=1 bun run --cwd apps/web dev` remains
  the documented backend-free UI path.

## Env bootstrap

When `.env` is **missing**:

1. Copy `.env.example`.
2. Fill the four blank secrets — `ENCRYPTION_MASTER_KEY`,
   `PLATFORM_JWT_SECRET`, `BETTER_AUTH_SECRET`, `WORKER_SHARED_SECRET` — with
   32 random bytes base64-encoded (`crypto.getRandomValues`).
3. Set `ARTIFACT_CACHE_DIR=.dev/agent-cache` (repo-local, gitignored). The
   worker's compiled-in default is `/var/lib/agents`
   (`apps/worker/src/config.ts`), which is not writable on macOS without sudo.
4. Print which keys were generated, plus one note that copilot/keyed features
   stay off until `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` is added.

When `.env` **exists**: never modify it. Parse it, warn if any of the same
four secret keys is empty, proceed.

The orchestrator loads `.env` itself and passes the resulting env explicitly to
child processes, so behavior does not depend on Bun's cwd-relative dotenv
loading.

Related fix shipped with this work: `.env.example` gains the missing
`ARTIFACT_CACHE_DIR` entry (it is the canonical env-var inventory per
AGENTS.md, and this var is absent today), and `.dev/` is gitignored.

## Orchestration

Sequence in `scripts/dev.ts`:

1. **Preflight** — `docker info` (hard fail with a friendly "start Docker
   Desktop" message); check for mise Node 24 (warning only: the worker boots
   without it but cannot launch compiled agents).
2. **Infra** — `docker compose up -d --wait postgres minio dex`, then the
   idempotent `minio-init` one-shot (`mc mb --ignore-existing`). Host-port
   overrides (`POSTGRES_PORT` etc.) flow from the parsed `.env`.
3. **Migrate** — `bun run --cwd packages/db migrate` with `DATABASE_URL` from
   the parsed env, on every boot. Drizzle no-ops when current; this also cures
   post-`git pull` schema drift.
4. **Apps** — spawn control-plane, worker, and web dev servers via `Bun.spawn`,
   piping stdout/stderr line-buffered with padded, color-coded prefixes
   (`api │`, `worker │`, `web │`).

**Crash policy.** `bun --watch` and Vite self-restart on file changes, so a
child *exiting* indicates a boot or config failure, not a routine edit:

- During startup (before all three report ready): abort — tear down the other
  children, exit 1.
- In steady state: print a loud banner with the exit code and keep the other
  two running; the maintainer decides whether to restart.

## Testing

- Env-bootstrap logic (secret generation, fill-only-blank-keys, never rewrite
  an existing `.env`, required-key warnings) is extracted into a module under
  `scripts/dev/` with bun unit tests that run in the default `bun test` lane.
- Process orchestration is verified manually: one cold boot (no `.env`, no
  containers) and one warm boot, plus Ctrl-C teardown and `dev:down`.

## Documentation impact (same commit)

- `README.md` quickstart leads with `bun run dev`; the manual per-terminal path
  is kept below it as the explicit/debug path.
- `AGENTS.md` "Toolchain & setup" documents the orchestrator and `dev:down`.
- `.env.example` adds `ARTIFACT_CACHE_DIR`.
- `.gitignore` adds `.dev/`.

## Future work (recorded, not built)

Optional `docker compose watch` lane containerizing **web + control-plane
only** (worker stays native for docker.sock / Node 24 / dynamic-port reasons),
for contributors who want hermetic app environments.

## Out of scope

Production deploy topology, CI lanes, test harness compose projects
(`p1acceptance`, `p2e2e`, …), and any change to per-app dev scripts.
