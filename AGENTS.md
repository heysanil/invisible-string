# AGENTS.md — working in this repo

Operational contract for anyone (human or agent) changing this codebase. `CLAUDE.md` is a symlink to this file. Read this first; it tells you what is load-bearing, how to verify changes, and which documents are the source of truth.

**invisible-string** is a multi-tenant cloud agent-workflow platform: users assemble workflows from four pillars (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS) in a chat-centric SPA; each workflow **compiles to a self-hosted [eve](https://eve.dev) agent** (`packages/compiler` → `eve build` → tarball in object storage) that runs on a stateless worker pool with Postgres-backed durability (`@workflow/world-postgres`), fired from chat or triggers (webhook/form/Slack), with an AI copilot in the builder.

---

## ⚠️ IMPORTANT: keep all documentation up to date

Documentation in this repo is treated as part of the code. **Any change that alters behavior, commands, environment variables, API surface, architecture, constraints, or workflows MUST update every affected document in the same commit.** Stale docs are bugs — a doc that lies is worse than no doc.

The living documents and what each owns:

| Document | Owns |
|---|---|
| `AGENTS.md` (this file) | Operational contract: commands, lanes, conventions, constraints |
| `README.md` | Quickstart, product surfaces, copilot, repo map |
| `INITIAL-SPEC.md` | The build brief — historical record, do **not** edit (its §2 locked decisions still bind) |
| `docs/superpowers/specs/2026-07-02-invisible-string-design.md` | Approved design: product decisions, E1 design tokens, eve live-doc corrections |
| `docs/PLAN.md` | Master phase plan — update acceptance/status notes if scope shifts |
| `docs/runtime-worker-contract.md` | Control-plane ↔ worker protocol: identity, ensure/dispatch, proxy, reapers |
| `packages/compiler/README.md` + `WORLD-ISOLATION.md` | Codegen contract, `COMPILER_VERSION` discipline, world-DB isolation mechanism |
| `spike/REPORT.md` | Empirical eve findings (numbered; later docs cite them) — append, don't rewrite |
| `packages/compiler/versions.json` | Pinned runtime version matrix + rationale notes |
| `.env.example` | **Canonical inventory of every environment variable** — add new vars here with comments |
| `e2e/README.md` | Playwright harness operation |

If you add a subsystem, add its doc and list it here. If a doc contradicts the code, fix whichever is wrong — never leave them divergent.

---

## Golden rules

1. **Commit messages never mention AI assistance** — no Claude references, no `Co-Authored-By` trailers. Conventional style: `feat(scope): …`, `fix: …`, `integrate: …`, `test(e2e): …`.
2. **Secrets never touch git, logs, or model context.** `.openrouter-key` (local provider key) and `.env` are gitignored — keep them that way. Secrets at rest use AES-256-GCM envelope encryption with AAD tenant binding (`packages/shared/src/crypto.ts`); API responses expose `hasCredentials` booleans, never values. The structured logger redacts known secret keys — use it, not `console.*`, in control-plane/worker hot paths.
3. **Migrations are additive.** New columns/tables/indexes via `bun run --cwd packages/db generate`; never edit an applied migration. Schema and Better Auth tables live only in `packages/db` (control-plane re-exports).
4. **Compiler changes have a versioning ritual.** Any edit that changes emitted bytes requires bumping `COMPILER_VERSION` (`packages/compiler/src/version.ts`) — the golden-digest guard (`fixtures/.golden-digest.json`) fails CI otherwise, and `UPDATE_GOLDEN=1` refuses to run without the bump. Build-environment changes that alter artifacts bump `BUILD_ENV_EPOCH` (`apps/control-plane/src/build/steps.ts`), which flows **through** `compile()` into the content hash (the platform-JWT audience bakes the hash — never re-key outside `compile()`).
5. **The E1 design system is law in `apps/web`.** Monochrome ink × liquid glass: tokens in `src/styles/tokens.css`, primitives in `src/components/ui` — extend them, never fork one-off styles. Color only as meaning (`#16a34a` success · `#f59e0b` waiting · `#dc2626` error). Capsule controls, 150–200 ms ease-out, `focus-visible` everywhere, designed empty/loading/error states, `prefers-reduced-motion`/`-transparency` respected. Full tokens: design spec §E1.
6. **TypeScript strict everywhere; contracts live in `packages/shared`** (zod schemas mirroring db enums). API DTOs, WS frames, TriggerEvent, eve event types — server and web both import from shared; never let them drift.
7. **Workspace scoping is mandatory on every route**: resolve the Better Auth session + active organization + role (`requireWorkspace`), verify row ownership (sessions/runs map to workspaces — eve does not enforce this), and test the authz matrix (outsider 403, member vs admin/owner ops).
8. **Verify before you claim done**: typecheck + the test lanes relevant to your change (below). If you touched runtime/worker/compiler paths, run the acceptance suites.

## Toolchain & setup

- **Bun 1.3+** runs the platform (control-plane, worker, web tooling, all tests). **Node 24 via mise** runs everything eve (`mise install node@24`; harnesses invoke `mise exec node@24 --` themselves). **Docker** for compose + `docker()` sandboxes.
- `bun install` once at the root (single lockfile). `cp .env.example .env` and fill secrets for running apps (tests provision their own env).
- Local stack: `docker compose up -d postgres minio dex` (ports overridable: `POSTGRES_PORT`/`MINIO_PORT`/`DEX_PORT`). Test harnesses spin their own compose **projects** (`p1acceptance`, `p2e2e`, `p3acceptance`, `pkeyed`…) on non-default ports — don't reuse those names.
- Dev servers: `bun run --cwd apps/control-plane dev` (API :3000) + `bun run --cwd apps/web dev` (SPA :5173); worker: `bun run --cwd apps/worker dev`. Backend-free UI preview: `VITE_FIXTURE_MODE=1`.

## Test lanes (run the ones your change touches)

| Lane | Command | Needs |
|---|---|---|
| Unit (default) | `bun test` | nothing — DB/key-gated suites skip cleanly |
| Typecheck | `bun run typecheck` | nothing |
| DB-gated integration | `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test` | compose up + `DATABASE_URL=… bun run --cwd packages/db migrate` |
| Real `eve build` fixtures | add `SPIKE_EVE_BUILD=1` to the gated lane | Node 24, warm npm cache |
| Phase-1 acceptance (spine) | `TEST_DATABASE_URL=… bun test tests/integration/phase1-acceptance.test.ts` | compose; self-provisions |
| Phase-3 acceptance (2 workers, failover, triggers) | `TEST_DATABASE_URL=… PHASE3_AGENT_ROOT=/tmp/invisible-string-p3-agents bun test tests/integration/phase3-acceptance.test.ts` | compose; self-provisions |
| Keyed (real model, costs cents) | `KEYED=1 OPENROUTER_API_KEY=… TEST_DATABASE_URL=… bun test tests/integration/keyed-acceptance.test.ts` | key from `.openrouter-key` |
| Copilot real-model smoke | `COPILOT_KEYED=1 OPENROUTER_API_KEY=… bun test apps/control-plane/src/copilot/keyed.test.ts` | key |
| Browser E2E | `cd e2e && bunx playwright test` | chromium installed; harness self-manages its whole stack |

E2E specs are `*.e2e.ts` under `e2e/specs/` precisely so root `bun test` never collects them. The eve spike (`spike/`) is standalone (not a workspace) — its suites run in the gated lane and are the upgrade gate for eve version bumps.

## Architecture (one screen)

`apps/control-plane` (Bun+Elysia): Better Auth (email/pw + OIDC SSO + orgs) · pillar CRUD · compiler invocation + `eve build` + tarball → MinIO (cache keyed by content hash = pillar config + compiler version + eve version + build-env epoch) · scheduler (session affinity → artifact-warm → any live worker; dead-worker sweep + fencing) · trigger ingress (`/t/:token`, Slack events with signature + replay window) → dispatcher (`TriggerEvent` → compiled channel, version-bound JWT) · NDJSON tailer → `run_events` → resumable SSE · copilot WS tool loop.
`apps/worker` (stateless, Node 24, docker.sock): supervisor (register/heartbeat/drain, ensure-agent → pull/extract → per-agent `eve start`), streaming reverse proxy, reapers (process idle 15 m, sandbox idle 30 m, artifact LRU 20 GB).
`apps/web`: the glass SPA. `packages/{compiler,db,shared}` as labeled. Contract details: `docs/runtime-worker-contract.md`.

## Constraints that will bite you (learned empirically — full list in the design spec's "Live-doc corrections" + `spike/REPORT.md`)

- eve bakes **model routing at `eve build` time** — the build step injects a placeholder OpenRouter key so artifacts get external routing; never "clean up" that placeholder, and never let real keys into build env (allowlisted + `--ignore-scripts`).
- Proxies must forward **both** `/eve/` and `/.well-known/workflow/` or runs stall silently; world callbacks ride `/cb/<boot-token>/…` on the worker.
- **One world Postgres database per workflow version** (`ws_v_<hash12>`); the graphile job prefix does NOT isolate. **Single writer per version hash** across workers — enforced by fencing + scheduler reservations; don't weaken either.
- eve session create is **202 async**; one run per session at a time (`409 session_busy`, and `waiting` counts as busy).
- Compiled trigger channels live at `/eve/v1/platform/<trigger>`; platform JWTs are per-version derived secrets (`HMAC(master, hash)`, audience `workflow-agent:<hash>`).
- Tests never need a real provider key except the keyed lanes — the mock model rides `EVE_MOCK_AUTHORED_MODELS`; the copilot's scripted fake (`COPILOT_FAKE_SCRIPT`) is dropped in production builds.
- Version pins are exact (`packages/compiler/versions.json`): eve ↔ `@workflow/world-postgres` beta ↔ `ai@7` ↔ provider majors. Never `@latest` in generated projects; any eve bump must pass the spike suites first.

## CI (`.github/workflows/ci.yml`)

`unit` (typecheck + `bun test` + web build) · `integration` (compose + gated lane incl. spike) · `acceptance` (phase-1, real eve build) · `phase3-acceptance` (multi-worker) · `e2e` (Playwright). Keyed lanes are deliberately **not** in CI.

## Known residuals (documented, deliberate)

Single-writer-per-hash world constraint (proper world-factory patch tracked) · worker PKI/mTLS attestation (allowlist + single-use dispatch tokens today) · `@openrouter/ai-sdk-provider` pinned to the only `ai@7`-compatible line (alpha) · no mailer (invites surface copyable links; email verification off by default locally) · production deploy documented-not-provisioned. If you resolve one, update this list and the docs that mention it.
